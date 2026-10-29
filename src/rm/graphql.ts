// The Rocket Money GraphQL transport: request headers, the executor (concurrency
// limit, re-login, persisted-query fallback), errors, Relay ids, batching and
// paging. Every other rm/ module talks to Rocket Money through this one.

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
// Captured from the web app. The exact value doesn't gate persisted-query
// resolution (hashes survive client-version bumps) but RM expects the header.
const WEB_CLIENT_VERSION = process.env.ROCKETMONEY_WEB_CLIENT_VERSION ?? "2fc82a9db6";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

// Persisted-query hashes for the READ operations, lifted from the web app's own
// traffic. The baseline came from app.rocketmoney.com-2.har (2026-07-05).
//
// A hash belongs to one build of the Rocket Money web bundle, so RM invalidates
// some of them every few weeks and the fix is always the same: load the page in
// CAPTURE_PAGE with devtools recording, find the POST whose operationName
// matches, and copy extensions.persistedQuery.sha256Hash. Re-captured 2026-09-13:
// AccountDetailAccountListPage, which replaces the retired SettingsAccountsPage
// (RM no longer answers that operation at all), and AccountDetailPage.
// SubscriptionDetailPage added 2026-09-13 from recurring.har; RecurringPage's
// hash was unchanged in that same capture.
//
// A hash can also be recomputed without a login, because every query document
// ships in the public bundle (pages/_app-*.js): the web client sends
// sha256(print(formatDocument(doc))), formatDocument being urql's pass that adds
// __typename. Re-derived that way 2026-10-27 for AccountDetailAccountListPage,
// AccountDetailPage, SpendingPage, Budgets, RecurringPage and
// TransactionCategoryPage; the same computation reproduced every hash left
// unchanged, which is what showed it matches the client. (Rerun against the
// 2026-10-29 bundle, it reproduced only two of six changed hashes, so treat a
// computed hash as a guess until a request with it succeeds.)
//
// To update from a capture: `npm run refresh-hashes -- <file.har>` rewrites the
// entries below from every operationName -> sha256Hash pair in the HAR. A stale
// hash no longer breaks a tool in the meantime: rmGraphQL falls back to the
// query text in QUERY_TEXT (`npm run refresh-hashes -- --bundle` regenerates it).
const PERSISTED = {
  AuthenticationCheck: "5fe578b1917c4601cb63948f580ad3bdadded0fefa985fdd2fe2d1b913cce2d0",
  RefreshAuthToken: "a86bd0f5e3fbc3673d1215b894362c5cd28ce060a7bb326cc9fd37b06bdd9fbb",
  AccountDetailAccountListPage: "a9a8e1b8f1514189f262e2952d57430bd56882ce1d903817e7b4e863b3bd7b9f",
  AccountDetailPage: "353069c04c1778a074ae9aee8398d4286a0f26d75cb1c933d17fb1ce18d2dfdf",
  NetWorthQuery: "5d319beb9e4b601c8381198731cbdaeeba106e442c44c049e4333142db07ed11",
  SpendingPage: "a03fc1d90df2029a330da832e2b389478e23f7318f6cfb15ef1403878a607eb7",
  Budgets: "1f4b783aa7075191469478205ec55825ca2a37f1b8de21d11080d08dc8a0096b",
  RecurringPage: "0026a77fc626a68877701731ac1269584c9b57881283dcaa0923372163668e1c",
  SubscriptionDetailPage: "9556941e4ff9bdc23d43801774a45e8dc01b67b547aab774abcd9815bb5b0f3c",
  RecurringUpcomingPage: "f1dd34f01b69dd0367a8b20a07b8b45977ab6d1ce0d31919b1b4143e5ba205bc",
  // The user's full category catalog (default + custom), with node ids. Captured
  // from app.rocketmoney.com.har (2026-07-05). Read-only; rotating is handled the
  // same as any other persisted read (PersistedQueryNotFound -> re-capture).
  TransactionCategories: "b8734a0ec18579870ec0e707beca2a05450193c99e55df6f165be9d18a53e6b4",
} as const;

// Where in the web app each operation fires, so the PersistedQueryNotFound error
// can send you straight to the page that will hand you the new hash. Only routes
// actually observed in a capture are listed; add one the next time you watch an
// operation go past rather than guessing it from the operation name.
const CAPTURE_PAGE: Partial<Record<keyof typeof PERSISTED, string>> = {
  AuthenticationCheck: "https://app.rocketmoney.com/ (fires on every page)",
  RefreshAuthToken: "https://app.rocketmoney.com/ (fires on every page)",
  AccountDetailAccountListPage: "https://app.rocketmoney.com/account",
  AccountDetailPage: "https://app.rocketmoney.com/account (then click an account)",
  NetWorthQuery: "https://app.rocketmoney.com/net-worth",
  RecurringPage: "https://app.rocketmoney.com/recurring",
  SubscriptionDetailPage: "https://app.rocketmoney.com/recurring (then click a subscription)",
};

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

/** Thrown when RM no longer recognizes a persisted-query hash. */
export class PersistedQueryNotFoundError extends Error {}

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
  operationName: keyof typeof PERSISTED;
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
    if (json.errors.some((e) => /PersistedQueryNotFound/i.test(e.message))) {
      const page =
        CAPTURE_PAGE[opName as keyof typeof PERSISTED] ??
        "the Rocket Money web app page that shows this data";
      throw new PersistedQueryNotFoundError(
        `RM ${opName}: PersistedQueryNotFound - Rocket Money rotated this query hash. ` +
          `To fix: load ${page} with devtools recording, export a HAR, and run ` +
          `\`npm run refresh-hashes -- <file.har>\` (it rewrites PERSISTED in src/rm/graphql.ts).`,
      );
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
        extensions: { persistedQuery: { version: 1, sha256Hash: PERSISTED.AuthenticationCheck } },
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

// Ops already warned about, so a rotated hash logs once per process, not per call.
const fellBack = new Set<string>();

/**
 * Persisted-query READ (hash captured from a HAR; may rotate server-side). When
 * RM no longer knows the hash, resend with the query text from the web bundle -
 * what the web client itself does on PersistedQueryNotFound - so a rotation
 * degrades to a log line instead of a broken tool.
 */
export async function rmGraphQL<T = unknown>(body: GraphQLBody): Promise<T> {
  const op = body.operationName;
  const variables = body.variables ?? {};
  try {
    return await rmExecute<T>(op, {
      operationName: op,
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: PERSISTED[op] } },
    });
  } catch (err) {
    const text = QUERY_TEXT[op];
    if (!(err instanceof PersistedQueryNotFoundError) || !text) throw err;
    if (!fellBack.has(op)) {
      fellBack.add(op);
      console.warn(`[rm] ${err.message} Falling back to the bundled query text.`);
    }
    return rmExecute<T>(op, { operationName: op, variables, query: text });
  }
}

/**
 * Full-text operation: sends the whole query string rather than a persisted
 * hash, so RM rotating a read hash can never break it. Every write uses this,
 * as do the transaction-rule reads.
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
