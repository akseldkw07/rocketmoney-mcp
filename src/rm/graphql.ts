// The Rocket Money GraphQL transport: request headers, the executor (concurrency
// limit, re-login), errors, Relay ids, batching and paging. Every other rm/ module talks to Rocket Money through this one.

import {
  applySetCookies,
  type CookieJar,
  loadSession,
  markSessionDead,
  parseCookieHeader,
  saveSession,
  serializeJar,
} from "./session.js";
import { attemptLogin, autoLoginConfigured, type LoginResult } from "./login.js"; // circular; runtime-only use
import { QUERY_TEXT } from "./query-text.js";

const GRAPHQL_URL = "https://client-api.rocketmoney.com/graphql";
// Captured from the web app. Rocket Money rejects a sufficiently stale value outright: every
// call fails with `HTTP 401 on AuthenticationCheck`, including a brand-new
// cookie. The giveaway is that several different fresh cookies all fail the
// same way: that is this header, not the session.
//
// Re-capture: open a logged-in app.rocketmoney.com tab -> DevTools -> Network
// -> filter "graphql" -> click a request -> Request Headers ->
// x-truebill-web-client-version. Override without editing this file by setting
// ROCKETMONEY_WEB_CLIENT_VERSION. (Upstream 312-dev#6 saw 3a3590f35c live on
// 2026-10-08; 2fc82a9db6 still worked here on 2026-11-02, so it stays.)
const WEB_CLIENT_VERSION = process.env.ROCKETMONEY_WEB_CLIENT_VERSION ?? "2fc82a9db6";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

// Every read sends its query text (src/rm/query-text.ts, generated from the
// public web bundle by `npm run refresh-query-text`), not a persisted-query hash.
// Hashes are tied to one build of the web bundle and Rocket Money rotated some
// every few weeks, which cost a failed request per read until a HAR was captured
// (TODO F9). Text survives those rotations; the web app itself sends the text
// whenever its hash misses, so RM accepts it routinely. What text can't survive is
// a schema change: then RM answers with a validation error, and rmGraphQL adds a
// hint to regenerate the text. Writes and the transaction-rule reads build their
// own text (rmFullText).
export type ReadOp =
  | "AuthenticationCheck"
  | "RefreshAuthToken"
  | "AccountDetailAccountListPage"
  | "AccountDetailPage"
  | "NetWorthQuery"
  | "SpendingPage"
  | "Budgets"
  | "RecurringPage"
  | "SubscriptionDetailPage"
  | "RecurringUpcomingPage"
  | "TransactionCategories";

/** The headers every RM GraphQL request carries, as the web app sends them. */
function rmHeaders(jar: CookieJar): Record<string, string> {
  return {
    accept: "application/graphql+json, application/json",
    "content-type": "application/json",
    origin: "https://app.rocketmoney.com",
    referer: "https://app.rocketmoney.com/",
    "user-agent": USER_AGENT,
    "x-truebill-web-client-version": WEB_CLIENT_VERSION,
    cookie: serializeJar(jar),
  };
}

/** Thrown when the session is no longer authenticated (cookie expired/revoked). */
export class RMAuthError extends Error {}

/** A GraphQL-level failure. Carries whatever data came back, so a batch can keep its partial results. */
export class RMGraphQLError extends Error {
  constructor(
    message: string,
    readonly data: unknown,
    readonly errors: Array<{ message: string; path?: (string | number)[] }>,
  ) {
    super(message);
  }
}

// Relay global IDs are base64 of `Type:numericId`. RM already returns opaque
// base64 `id` fields on nodes, so we only need to BUILD ids when the caller
// passes a numeric id (e.g. a category number from another screen).
export function toNodeId(type: string, numericId: string | number): string {
  return Buffer.from(`${type}:${numericId}`).toString("base64");
}

/** Inverse of toNodeId: decode a Relay node id into `{ type, numericId }`, or null. */
export function fromNodeId(nodeId: string): { type: string; numericId: string } | null {
  try {
    const decoded = Buffer.from(nodeId, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx <= 0) return null;
    const type = decoded.slice(0, idx);
    const numericId = decoded.slice(idx + 1);
    // Round-trip guard: reject inputs that aren't really base64 node ids.
    if (!/^[A-Za-z]+$/.test(type) || toNodeId(type, numericId) !== nodeId) return null;
    return { type, numericId };
  } catch {
    return null;
  }
}

interface GraphQLBody {
  operationName: ReadOp;
  variables?: Record<string, unknown>;
}

// How many RM calls may be in flight at once. Every call used to be queued
// behind the previous one, on the premise that each response rotates the session
// cookie and two calls sharing one value would knock the session offline. On
// 2026-10-29 the cookie did not rotate on AuthenticationCheck or RefreshAuthToken,
// a replayed old value still worked, and 5 parallel requests on one cookie all
// succeeded (144ms vs ~622ms queued). ROCKETMONEY_MAX_CONCURRENCY=1 restores the
// old one-at-a-time behavior if rotation comes back.
const MAX_CONCURRENCY = Math.max(1, Number(process.env.ROCKETMONEY_MAX_CONCURRENCY ?? 4) || 1);
let active = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}

// Hands the slot straight to the next waiter (active stays the same), so a new
// caller can't slip in between and exceed the limit.
function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

/**
 * Core executor: POST a full GraphQL body with the live cookie jar, apply any
 * rotated cookies from the response, and persist them. Throws RMAuthError if
 * the session is dead so callers can report "re-auth needed". At most
 * MAX_CONCURRENCY calls run at once; the rest queue.
 */
async function rmExecute<T = unknown>(opName: string, payload: Record<string, unknown>): Promise<T> {
  await acquireSlot();
  try {
    return await withRelogin<T>(opName, payload);
  } finally {
    releaseSlot();
  }
}

// Mark the session dead and start a re-login right away (no-op unless auto-login
// is configured; rate-limited inside attemptLogin) instead of waiting for the
// next keepalive tick.
function sessionDied(reason: string): void {
  markSessionDead(reason);
  void attemptLogin(`session died: ${reason}`);
}

// How long a tool call waits for an auto-login before giving up: enough for a
// warm renewal or a form login, not for an SMS round-trip (that one finishes in
// the background and the next call succeeds).
const RELOGIN_WAIT_MS = 90_000;

/**
 * Run a request; if it fails because the session died, wait (up to waitMs) for
 * relogin() and, if that succeeds, run it once more - so the caller gets data
 * instead of an auth error.
 */
export async function retryAfterRelogin<T>(
  run: () => Promise<T>,
  relogin: () => Promise<LoginResult>,
  waitMs: number,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof RMAuthError)) throw err;
    const timeout = new Promise<LoginResult>((r) => setTimeout(() => r({ ok: false }), waitMs).unref());
    const login = await Promise.race([relogin(), timeout]);
    if (!login.ok) throw err;
    return run();
  }
}

// The executor with retryAfterRelogin when auto-login is configured. The
// re-login is shared with the one sessionDied already started.
function withRelogin<T>(opName: string, payload: Record<string, unknown>): Promise<T> {
  const run = () => rmExecuteUnlocked<T>(opName, payload);
  if (!autoLoginConfigured()) return run();
  return retryAfterRelogin(run, () => attemptLogin(`session died during ${opName}`), RELOGIN_WAIT_MS);
}

async function rmExecuteUnlocked<T = unknown>(opName: string, payload: Record<string, unknown>): Promise<T> {
  const jar = loadSession();
  if (!jar) throw new RMAuthError("No Rocket Money session. Paste a fresh cookie at /auth.");

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: rmHeaders(jar),
    body: JSON.stringify(payload),
    redirect: "manual",
  });

  if (res.status === 401 || res.status === 403 || res.status === 302) {
    sessionDied(`HTTP ${res.status} on ${opName}`);
    throw new RMAuthError(`Rocket Money auth failed (HTTP ${res.status}). Re-auth at /auth.`);
  }

  const text = await res.text();
  let json: {
    data?: T;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`RM ${opName}: non-JSON response (HTTP ${res.status})`);
  }

  if (json.errors?.length) {
    const authErr = json.errors.find(
      (e) =>
        e.extensions?.code === "UNAUTHENTICATED" ||
        /not? authenticated|unauthorized|session/i.test(e.message),
    );
    if (authErr) {
      sessionDied(`GraphQL: ${authErr.message}`);
      throw new RMAuthError(`Rocket Money auth failed: ${authErr.message}. Re-auth at /auth.`);
    }
    throw new RMGraphQLError(`RM ${opName}: ${json.errors.map((e) => e.message).join("; ")}`, json.data, json.errors);
  }

  // Healthy authenticated response - commit any rotated cookies onto the LATEST
  // jar, not this call's copy: a parallel call may have saved a newer one.
  const setCookies = (res as unknown as { headers: { getSetCookie?: () => string[] } }).headers
    .getSetCookie?.();
  const latest = loadSession() ?? jar;
  if (setCookies?.length) applySetCookies(latest, setCookies);
  saveSession(latest);

  return json.data as T;
}

/**
 * Check a cookie header the login browser produced, outside the session file and
 * concurrency limit (nothing is marked dead, no re-login is triggered). The response rotates
 * the cookie and the old value goes stale, so this returns the ROTATED header to
 * seed with, or null if the cookie isn't authenticated.
 */
export async function probeSession(cookieHeader: string): Promise<string | null> {
  try {
    const jar = parseCookieHeader(cookieHeader);
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: rmHeaders(jar),
      body: JSON.stringify({
        operationName: "AuthenticationCheck",
        variables: {},
        query: readText("AuthenticationCheck"),
      }),
      redirect: "manual",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { viewer?: { id?: string } }; errors?: unknown[] };
    if (json.errors?.length || !json.data?.viewer?.id) return null;
    const setCookies = (res as unknown as { headers: { getSetCookie?: () => string[] } }).headers
      .getSetCookie?.();
    if (setCookies?.length) applySetCookies(jar, setCookies);
    return serializeJar(jar);
  } catch {
    return null;
  }
}

/** The bundled query text for a read; a missing one is a build problem, so say how to fix it. */
function readText(op: ReadOp): string {
  const text = QUERY_TEXT[op];
  if (!text) throw new Error(`No query text for ${op} in src/rm/query-text.ts: run \`npm run refresh-query-text\`.`);
  return text;
}

/** True for RM rejecting the query itself (a field, argument or type it no longer has). */
export function isSchemaMismatch(errors: { message: string; extensions?: { code?: string } }[]): boolean {
  return errors.some(
    (e) =>
      e.extensions?.code === "GRAPHQL_VALIDATION_FAILED" ||
      /Cannot query field|Unknown argument|Unknown type|Unknown fragment|is not defined by type/.test(e.message),
  );
}

/**
 * READ: send one of the web app's read queries with its bundled text. If RM
 * rejects the query itself (its schema changed under the bundled text), the
 * error keeps RM's messages and says how to regenerate the text.
 */
export async function rmGraphQL<T = unknown>(body: GraphQLBody): Promise<T> {
  const op = body.operationName;
  try {
    return await rmExecute<T>(op, { operationName: op, variables: body.variables ?? {}, query: readText(op) });
  } catch (err) {
    if (err instanceof RMGraphQLError && isSchemaMismatch(err.errors)) {
      throw new RMGraphQLError(
        `${err.message} (Rocket Money's schema no longer matches the bundled query: run \`npm run refresh-query-text\`, rebuild and deploy.)`,
        err.data,
        err.errors,
      );
    }
    throw err;
  }
}

/**
 * Full-text operation with a query built here rather than taken from the bundle.
 * Every write uses this, as do the transaction-rule reads.
 */
export async function rmFullText<T = unknown>(
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  return rmExecute<T>(operationName, { operationName, query, variables });
}

/** How many aliased operations go in one request. 50 node reads took 91ms (2026-10-29). */
export const BATCH_SIZE = 50;

export interface BatchResult<R> {
  ok: boolean;
  data?: R;
  error?: string;
}

/**
 * Run `field` once per input as aliased fields of one document, BATCH_SIZE per
 * request - RM's per-transaction operations (changeTransactionDate,
 * setTransactionNote, node reads) accept many aliases in one request (verified
 * 2026-10-29), so N items cost N/50 round trips instead of N. Results come back
 * in input order; one item failing doesn't sink the rest of its batch.
 */
export async function batchAliased<R>(
  opName: string,
  kind: "query" | "mutation",
  field: string,
  arg: { name: string; type: string },
  selection: string,
  inputs: unknown[],
): Promise<BatchResult<R>[]> {
  const out: BatchResult<R>[] = [];
  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const chunk = inputs.slice(start, start + BATCH_SIZE);
    const vars = chunk.map((_, i) => `$v${i}: ${arg.type}`).join(", ");
    const fields = chunk.map((_, i) => `a${i}: ${field}(${arg.name}: $v${i}) {\n    ${selection}\n  }`).join("\n  ");
    const query = `${kind} ${opName}(${vars}) {\n  ${fields}\n}`;
    const variables = Object.fromEntries(chunk.map((v, i) => [`v${i}`, v]));
    let data: Record<string, unknown> = {};
    let errors: RMGraphQLError["errors"] = [];
    try {
      data = (await rmFullText<Record<string, unknown>>(opName, query, variables)) ?? {};
    } catch (err) {
      if (!(err instanceof RMGraphQLError)) throw err;
      data = (err.data as Record<string, unknown> | null) ?? {};
      errors = err.errors;
    }
    chunk.forEach((_, i) => {
      const alias = `a${i}`;
      const own = errors.filter((e) => e.path?.[0] === alias).map((e) => e.message);
      if (data[alias] != null && !own.length) out.push({ ok: true, data: data[alias] as R });
      else {
        // An error with no path can't be pinned to one alias, so it is reported on every item.
        const unpinned = errors.filter((e) => !e.path?.length).map((e) => e.message);
        out.push({ ok: false, error: [...own, ...unpinned].join("; ") || "no result returned" });
      }
    });
  }
  return out;
}

// ── Generic helpers ────────────────────────────────────────────────

/** Recursively find the first object with the given __typename. */
function findByType(obj: unknown, typename: string): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.__typename === typename) return o;
  for (const v of Object.values(o)) {
    const found = findByType(v, typename);
    if (found) return found;
  }
  return null;
}

/** Collect every object with the given __typename. */
function collectByType(obj: unknown, typename: string, out: Record<string, unknown>[]): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const el of obj) collectByType(el, typename, out);
    return;
  }
  const o = obj as Record<string, unknown>;
  if (o.__typename === typename) out.push(o);
  for (const v of Object.values(o)) collectByType(v, typename, out);
}

function collectWhere(
  obj: unknown,
  match: (o: Record<string, unknown>) => boolean,
  out: Record<string, unknown>[],
): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const el of obj) collectWhere(el, match, out);
    return;
  }
  const o = obj as Record<string, unknown>;
  if (match(o)) out.push(o);
  for (const v of Object.values(o)) collectWhere(v, match, out);
}

function findPageInfo(obj: unknown): { hasNextPage: boolean; endCursor: string | null } | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.hasNextPage === "boolean") {
    return { hasNextPage: o.hasNextPage, endCursor: (o.endCursor as string) ?? null };
  }
  for (const v of Object.values(o)) {
    const found = findPageInfo(v);
    if (found) return found;
  }
  return null;
}

/**
 * Walk a cursor-paged connection to the end. `fetchPage` gets the cursor (null
 * first) and returns that page's items and the next cursor, or null when done.
 */
export async function collectPages<T>(
  fetchPage: (cursor: string | null) => Promise<{ items: T[]; next: string | null }>,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await fetchPage(cursor);
    all.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return all;
}

export { findByType, collectByType, collectWhere, findPageInfo };
