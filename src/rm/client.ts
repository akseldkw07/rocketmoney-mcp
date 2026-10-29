import {
  applySetCookies,
  type CookieJar,
  loadSession,
  markSessionDead,
  parseCookieHeader,
  saveSession,
  serializeJar,
} from "./session.js";
import { monthWindows, ymd, addDays } from "./windows.js";
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
          `\`npm run refresh-hashes -- <file.har>\` (it rewrites PERSISTED in src/rm/client.ts).`,
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
async function rmGraphQL<T = unknown>(body: GraphQLBody): Promise<T> {
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

/**
 * Why `id` can't be a transaction id, or null if it is one. Checked before
 * sending: RM answers a bad id with a bare "An error occurred.", which says
 * nothing about what was wrong.
 */
export function notATransactionId(id: string): string | null {
  return fromNodeId(id)?.type === "Transaction"
    ? null
    : `"${id}" is not a transaction id (use the \`id\` from search_transactions)`;
}

/** Split ids into transaction ids and the rest (with the reason each was refused). */
export function partitionTransactionIds(ids: string[]): { valid: string[]; invalid: { id: string; error: string }[] } {
  const valid: string[] = [];
  const invalid: { id: string; error: string }[] = [];
  for (const id of ids) {
    const why = notATransactionId(id);
    if (why) invalid.push({ id, error: why });
    else valid.push(id);
  }
  return { valid, invalid };
}

/** RM's masked per-item error, reworded for a well-formed transaction id it still refused. */
function explainItemError(message: string | undefined): string {
  if (!message || /^An error occurred\.?$/.test(message.trim())) {
    return "Rocket Money refused it: no such transaction, or not one of yours (it only says \"An error occurred.\")";
  }
  return message;
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

// ── Operations ─────────────────────────────────────────────────────

/** Cheap liveness probe (also rotates the cookie). Returns viewer id if authed. */
export async function authenticationCheck(): Promise<string> {
  const data = await rmGraphQL<{ viewer?: { id?: string } }>({ operationName: "AuthenticationCheck" });
  return data.viewer?.id ?? "";
}

/** Keepalive - re-rolls the session cookie. */
export async function refreshAuthToken(): Promise<void> {
  await rmGraphQL({ operationName: "RefreshAuthToken" });
}

/** Every institution + account with current balance. */
export async function getAccounts(): Promise<Record<string, unknown>> {
  return rmGraphQL({ operationName: "AccountDetailAccountListPage" });
}

/** One account's detail: balances, liabilities/APRs, 6-month balance history. */
export async function getAccountDetail(accountNodeId: string): Promise<Record<string, unknown>> {
  const w = monthWindows();
  return rmGraphQL({
    operationName: "AccountDetailPage",
    variables: {
      id: accountNodeId,
      sixMonthsAgo: w.sixMonthsAgo,
      currentMonthStart: w.currentMonthStart,
      nextMonthStart: w.nextMonthStart,
    },
  });
}

/** Net worth decomposed into cash/savings/investments/debts + history. */
export async function getNetWorth(useEquity = false): Promise<Record<string, unknown>> {
  const w = monthWindows();
  return rmGraphQL({
    operationName: "NetWorthQuery",
    variables: { sixMonthsAgo: w.sixMonthsAgo, useEquity, lastMonth: w.lastMonthEnd },
  });
}

export interface RMAsset {
  assetId: string; // base64 Asset node id (base64("Asset:<numeric>"))
  name: string;
  valueCents: number;
  assetType: string; // e.g. "vehicle", "home", "other"
  includeInNetWorth: boolean;
}

/**
 * READ: the user's manually-tracked assets (vehicles, valuables, hand-entered
 * savings), which RM returns inside the net-worth view. These are the assets you
 * add by hand, distinct from linked institution accounts.
 *
 * They are NOT confined to the `other` bucket: RM files each one by its
 * assetType, so a savings-type asset arrives as a `NetWorthCash` node sitting
 * alongside the linked checking accounts. Filtering on `__typename` therefore
 * silently hides them. The reliable marker is `assetNodeId` - only manual assets
 * carry one, and linked accounts get `accountNodeId` instead.
 */
export async function getAssets(): Promise<RMAsset[]> {
  const data = await getNetWorth(false);
  const nodes: Record<string, unknown>[] = [];
  collectWhere(data, (o) => o.assetNodeId != null, nodes);
  return nodes.map((o) => ({
    assetId: String(o.assetNodeId ?? ""),
    name: String(o.name ?? ""),
    valueCents: typeof o.valueCents === "number" ? o.valueCents : 0,
    // `assetType` only exists on NetWorthOther nodes; a manual asset filed into
    // another bucket carries its kind in `type` ("manual") instead.
    assetType: String(o.assetType ?? o.type ?? ""),
    includeInNetWorth: Boolean(o.includeInNetWorth),
  }));
}

/**
 * WRITE: set a manual asset's value (in cents). RM stores asset values as a
 * dated time series, so setting the value means recording a value point for
 * today via `createAssetValue` (same-date calls update in place - no duplicate).
 * `UpdateAsset` only edits name/type/includeInNetWorth; it rejects valueCents.
 * Returns the updated asset (from the mutation payload).
 */
export async function updateAssetValue(assetNodeId: string, valueCents: number): Promise<RMAsset> {
  const today = ymd(new Date());
  const data = await rmFullText<{ createAssetValue?: { asset?: Record<string, unknown> } }>(
    "CreateAssetValue",
    "mutation CreateAssetValue($input: CreateAssetValueInput!) {\n  createAssetValue(input: $input) {\n    asset {\n      id\n      name\n      type\n      includeInNetWorth\n      valueCents\n      __typename\n    }\n    __typename\n  }\n}",
    { input: { assetNodeId, valueCents, date: today } },
  );
  const a = data.createAssetValue?.asset;
  if (!a) throw new Error(`createAssetValue returned no asset for "${assetNodeId}".`);
  return {
    assetId: String(a.id ?? assetNodeId),
    name: String(a.name ?? ""),
    valueCents: typeof a.valueCents === "number" ? a.valueCents : valueCents,
    assetType: String(a.type ?? ""),
    includeInNetWorth: Boolean(a.includeInNetWorth),
  };
}

/** This-month vs last-month spending, earnings, and per-category breakdown. */
export async function getSpending(): Promise<Record<string, unknown>> {
  const w = monthWindows();
  return rmGraphQL({
    operationName: "SpendingPage",
    variables: {
      startOfCurrentTimePeriod: w.currentMonthStart,
      endOfCurrentTimePeriod: w.nextMonthStart,
      startOfPreviousTimePeriod: w.previousMonthStart,
      endOfPreviousTimePeriod: w.currentMonthStart,
      budgetPlanMonth: w.currentMonthStart,
      now: w.now,
      isCurrentMonth: true,
      isWeekly: false,
      isMonthly: true,
      transactionHistoryInterval: "month",
      transactionHistoryGteDate: ymd(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 5, 1))),
    },
  });
}

/** Budgets: earnings + spend for this and the prior three months. */
export async function getBudgets(): Promise<Record<string, unknown>> {
  const w = monthWindows();
  const now = new Date();
  const startNMonths = (n: number) =>
    ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)));
  return rmGraphQL({
    operationName: "Budgets",
    variables: {
      startOfThisMonth: w.currentMonthStart,
      endOfThisMonth: w.nextMonthStart,
      startOfLastMonth: startNMonths(1),
      startOfTwoMonthsAgo: startNMonths(2),
      startOfThreeMonthsAgo: startNMonths(3),
    },
  });
}

/** Recurring charges / subscriptions with next-charge estimates. */
export async function getRecurring(): Promise<Record<string, unknown>> {
  const w = monthWindows();
  return rmGraphQL({
    operationName: "RecurringPage",
    variables: { transactionHistoryGteDate: w.sixMonthsAgo },
  });
}

/**
 * One recurring charge in full: everything the list carries plus its yearly
 * cost, transaction count, a 12-month bar chart and its own transaction list.
 * `startDate`/`endDate` bound the transaction list; RM's own client sends null
 * for both and gets the default window, so null is the normal call.
 */
export async function getSubscriptionDetail(
  subscriptionNodeId: string,
  startDate: string | null = null,
  endDate: string | null = null,
): Promise<Record<string, unknown>> {
  return rmGraphQL({
    operationName: "SubscriptionDetailPage",
    variables: { id: subscriptionNodeId, startDate, endDate },
  });
}

/**
 * The subset of a subscription a caller may change, in our own vocabulary
 * (dollars and plain names). `amountCents` is cents because that is the unit
 * that crosses the wire; the MCP layer takes dollars and converts.
 */
export interface RMSubscriptionEdit {
  name?: string;
  amountCents?: number;
  frequency?: number;
  nextExpectedDate?: string;
  startDate?: string;
  endDate?: string;
  serviceType?: string;
}

/** The five ServiceType enum members RM accepts on UpdateSubscriptionInput. */
export const SERVICE_TYPES = ["subscription", "bill", "utility", "bundled", "unknown"] as const;

/**
 * Merge a caller's edits over a subscription node into an UpdateSubscriptionInput.
 *
 * The mutation is a whole-object write, and `service_name` is `String!`, so a
 * caller changing only the amount still has to resend the name. Everything the
 * caller did not touch therefore comes from `node`, which must be a freshly read
 * subscription rather than a remembered one.
 *
 * Fields still null on the node are omitted rather than sent as null. That
 * matters most for `amount`: RM leaves it null while it is inferring the charge
 * from transaction history, and writing a value pins it (observed 2026-09-13,
 * where one edit turned a null `amount` into 4788 with no other change). Sending
 * a null we invented would be a silent edit of its own.
 */
export function buildSubscriptionUpdateInput(
  node: Record<string, unknown>,
  edit: RMSubscriptionEdit = {},
): Record<string, unknown> {
  const service = (node.service ?? {}) as Record<string, unknown>;
  const name = edit.name ?? node.custom_name ?? service.name;
  if (typeof name !== "string" || !name) {
    throw new Error("Subscription has no name and none was supplied; service_name is required.");
  }
  const input: Record<string, unknown> = { id: node.id, service_name: name };
  const put = (key: string, value: unknown) => {
    if (value !== null && value !== undefined) input[key] = value;
  };
  put("service_id", service._id);
  put("amount", edit.amountCents ?? node.amount);
  put("frequency", edit.frequency ?? node.frequency);
  put("start_date", edit.startDate ?? node.start_date);
  put("end_date", edit.endDate ?? node.end_date);
  put("next_expected_date", edit.nextExpectedDate ?? node.expected_next_bill_date);
  put("service_type", edit.serviceType ?? node.service_type);
  return input;
}

const UPDATE_SUBSCRIPTION = `mutation UpdateSubscription($input: UpdateSubscriptionInput!) {
  updateSubscription(input: $input) {
    subscription {
      __typename
      id
      amount
      frequency
      custom_name
      start_date
      end_date
      expected_next_bill_date
      service_type
      custom_service_type
      service {
        __typename
        id
      }
    }
    __typename
  }
}`;

/**
 * WRITE: correct a recurring charge's name, amount, cadence or dates.
 *
 * Reads the subscription first and merges, because the mutation replaces the
 * whole object. Returns the mutation's own payload so the caller can compare
 * what RM saved against what it asked for.
 *
 * `active` is NOT reachable here: UpdateSubscriptionInput accepts only id,
 * service_name, service_id, amount, frequency, start_date, end_date,
 * next_expected_date and service_type (established 2026-09-13 by probing the
 * schema's validation errors, introspection being disabled).
 */
export async function updateSubscription(
  subscriptionNodeId: string,
  edit: RMSubscriptionEdit,
): Promise<Record<string, unknown>> {
  const detail = await getSubscriptionDetail(subscriptionNodeId);
  const node = (detail.node ?? null) as Record<string, unknown> | null;
  if (!node?.id) throw new Error(`No subscription found for id "${subscriptionNodeId}".`);
  const input = buildSubscriptionUpdateInput(node, edit);
  const data = await rmFullText<{ updateSubscription?: { subscription?: Record<string, unknown> } }>(
    "UpdateSubscription",
    UPDATE_SUBSCRIPTION,
    { input },
  );
  const saved = data.updateSubscription?.subscription;
  if (!saved) throw new Error(`updateSubscription returned no subscription for "${subscriptionNodeId}".`);
  return saved;
}

/**
 * WRITE: tell Rocket Money a subscription it had written off is still live.
 * This is the one direction `active` moves through the API: there is a
 * `deactivateManualSubscription` for hand-added ones, but nothing that
 * deactivates a subscription RM detected from transactions.
 */
export async function markSubscriptionActive(subscriptionNodeId: string): Promise<boolean> {
  const data = await rmFullText<{ markSubscriptionActive?: { subscription?: { active?: boolean } } }>(
    "MarkSubscriptionActive",
    "mutation MarkSubscriptionActive($input: MarkSubscriptionActiveInput!) {\n  markSubscriptionActive(input: $input) {\n    subscription {\n      __typename\n      id\n      active\n    }\n    __typename\n  }\n}",
    { input: { subscriptionId: subscriptionNodeId } },
  );
  return data.markSubscriptionActive?.subscription?.active ?? false;
}

/**
 * WRITE: drop a recurring charge from Rocket Money's list entirely. For rows RM
 * detected wrongly, or duplicates of a subscription already tracked. This is not
 * a cancellation: the merchant keeps charging, RM just stops listing it.
 */
export async function deleteSubscription(subscriptionNodeId: string): Promise<boolean> {
  const data = await rmFullText<{ deleteSubscription?: Record<string, unknown> }>(
    "DeleteSubscription",
    "mutation DeleteSubscription($input: DeleteSubscriptionInput!) {\n  deleteSubscription(input: $input) {\n    __typename\n  }\n}",
    { input: { subscriptionId: subscriptionNodeId } },
  );
  return Boolean(data.deleteSubscription);
}

/** Upcoming bill/subscription charges in the next `days` days (default 28). */
export async function getUpcoming(days = 28): Promise<Record<string, unknown>> {
  const now = new Date();
  return rmGraphQL({
    operationName: "RecurringUpcomingPage",
    variables: { upcomingStartDate: ymd(now), upcomingEndDate: ymd(addDays(now, days)) },
  });
}

export interface RMTransaction {
  nodeId: string;
  amountCents: number;
  date: string;
  /** The date the bank posted it; differs from `date` once the date is changed by hand. */
  originalDate: string;
  note: string | null;
  name: string;
  /** A rename (by hand or by a rule), or null. */
  customName: string | null;
  categoryLabel: string | null;
  accountId: string | null;
  /** null (counted), "budget" (left out of budgets) or "everything" (left out of all spending/charts). */
  ignoredFrom: string | null;
  /** Rule ids that have applied to this transaction, in RM's order. */
  ruleIds: string[];
}

/** One Transaction node (LightTransaction fragment) -> RMTransaction, or null if it lacks the basics. */
export function toRMTransaction(o: Record<string, unknown>): RMTransaction | null {
  if (typeof o.id !== "string" || typeof o.amount !== "number") return null;
  const category = o.category as { label?: string } | null | undefined;
  const account = o.account as { id?: string } | null | undefined;
  return {
    nodeId: o.id,
    amountCents: o.amount,
    date: String(o.date ?? ""),
    originalDate: String(o.posted_date ?? o.date ?? ""),
    note: (o.note as string | null) ?? null,
    name: String(o.longName ?? o.shortName ?? ""),
    customName: (o.custom_name as string | null) ?? null,
    categoryLabel: category?.label ?? null,
    accountId: account?.id ?? null,
    ignoredFrom: (o.ignoredFrom as string | null) ?? null,
    ruleIds: Array.isArray(o.transactionRuleNodeIds) ? (o.transactionRuleNodeIds as string[]) : [],
  };
}

/** Every Transaction field toRMTransaction reads. Shared by search and rule previews. */
export const TRANSACTION_FIELDS = `__typename
  id
  date
  posted_date
  amount
  shortName
  longName(prependCustomName: false)
  custom_name
  note
  ignoredFrom
  transactionRuleNodeIds
  category { id label __typename }
  account { id __typename }`;

// The transactions-page query cut down to what RMTransaction reads, plus
// posted_date (the bank date, which survives a date change) and custom_name.
// Sent as full text, so it doesn't depend on a persisted hash. `gteDate` and
// `ltDate` filter on `date`, the possibly-changed one (checked 2026-10-29).
const TRANSACTION_SEARCH = `query TransactionSearch($query: String, $order: String, $accountIds: [ID!], $transactionCategoryIds: [ID!], $gteDate: Date, $ltDate: Date, $cursor: String, $pageSize: Int!) {
  viewer {
    id
    transactions(first: $pageSize, accountIds: $accountIds, transactionCategoryIds: $transactionCategoryIds, query: $query, order: $order, gteDate: $gteDate, ltDate: $ltDate, excludeIgnoredFrom: null, after: $cursor) {
      edges {
        node { ${TRANSACTION_FIELDS} }
        __typename
      }
      pageInfo { endCursor hasNextPage __typename }
      __typename
    }
    __typename
  }
}`;

/**
 * Rows per search request. RM accepts up to 2,500 (2,500 rows in 230ms,
 * 2026-10-29); 1,000 keeps each response well under a few MB with full fields
 * while cutting a 10,000-row backfill from 50 requests to 10.
 */
export const PAGE_SIZE = 1000;
/** Rows a search returns when the caller doesn't say. */
export const DEFAULT_SEARCH_LIMIT = 1200;
/** Rows per searchTransactionsPage call when walking a whole result set by cursor. */
const SCAN_PAGE_LIMIT = 10_000;

export interface SearchOptions {
  query?: string | null;
  /** On/after this date (YYYY-MM-DD). */
  gteDate?: string | null;
  /** Strictly before this date (YYYY-MM-DD). */
  ltDate?: string | null;
  /** Account node ids; empty means every account. */
  accountIds?: string[];
  /** TransactionCategory node ids; empty means every category. */
  categoryIds?: string[];
  /** Resume from a previous page's nextCursor. */
  cursor?: string | null;
  /** Stop after this many rows (default DEFAULT_SEARCH_LIMIT). */
  limit?: number;
}

/**
 * Search transactions, newest first, paging 200 at a time until `limit` rows or
 * the end. Returns nextCursor when more remain, so a caller can walk any window
 * past the limit. Dedupes by node id.
 */
export async function searchTransactionsPage(
  opts: SearchOptions,
): Promise<{ transactions: RMTransaction[]; nextCursor: string | null }> {
  const all: RMTransaction[] = [];
  const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
  let cursor = opts.cursor ?? null;
  let nextCursor: string | null = null;

  while (all.length < limit) {
    const data = await rmFullText<Record<string, unknown>>("TransactionSearch", TRANSACTION_SEARCH, {
      query: opts.query ?? null,
      order: "reverse:date",
      accountIds: opts.accountIds ?? [],
      transactionCategoryIds: opts.categoryIds ?? [],
      gteDate: opts.gteDate ?? null,
      ltDate: opts.ltDate ?? null,
      cursor,
      // Never ask for more than the caller still needs.
      pageSize: Math.min(PAGE_SIZE, limit - all.length),
    });

    const nodes: Record<string, unknown>[] = [];
    collectByType(data, "Transaction", nodes);
    const before = all.length;
    for (const o of nodes) {
      const t = toRMTransaction(o);
      if (t) all.push(t);
    }

    const pageInfo = findPageInfo(data);
    nextCursor = pageInfo?.hasNextPage && pageInfo.endCursor && all.length > before ? pageInfo.endCursor : null;
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  const seen = new Set<string>();
  return {
    transactions: all.filter((t) => (seen.has(t.nodeId) ? false : (seen.add(t.nodeId), true))),
    nextCursor,
  };
}

/** Every transaction matching `opts`, walking the cursor to the end (no row limit). */
export async function searchAllTransactions(opts: Omit<SearchOptions, "cursor" | "limit">): Promise<RMTransaction[]> {
  const all: RMTransaction[] = [];
  let cursor: string | null = null;
  do {
    const page = await searchTransactionsPage({ ...opts, cursor, limit: SCAN_PAGE_LIMIT });
    all.push(...page.transactions);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/**
 * WRITE: change transactions' dates. RM's mutation takes one transaction, so
 * the ids go out as aliased mutations, BATCH_SIZE per request. `date`
 * "original" resets each to its posted_date, which RM keeps untouched through
 * any number of date changes (verified 2026-10-29); those are looked up in
 * batches first. Returns each transaction's dates as RM saved them.
 */
export async function setTransactionsDate(
  nodeIds: string[],
  date: string,
): Promise<{ id: string; date: string; originalDate: string; error?: string }[]> {
  const lookupErrors: (string | undefined)[] = nodeIds.map((id) => notATransactionId(id) ?? undefined);
  let targets: (string | null)[] = nodeIds.map((_, i) => (lookupErrors[i] ? null : date));
  if (date === "original") {
    const look = nodeIds.map((id, i) => ({ id, i })).filter((x) => !lookupErrors[x.i]);
    const posted = await batchAliased<{ posted_date?: string }>(
      "TransactionPostedDates",
      "query",
      "node",
      { name: "id", type: "ID!" },
      "id\n    ... on Transaction { posted_date }\n    __typename",
      look.map((x) => x.id),
    );
    targets = nodeIds.map(() => null);
    look.forEach((x, k) => {
      const r = posted[k];
      if (r.data?.posted_date) targets[x.i] = r.data.posted_date;
      else lookupErrors[x.i] = r.ok ? "no such transaction, or it has no posted date" : explainItemError(r.error);
    });
  }
  const todo = nodeIds.map((id, i) => ({ id, i, target: targets[i] })).filter((t) => t.target !== null);
  const saved = await batchAliased<{ transaction?: { date?: string; posted_date?: string } }>(
    "ChangeTransactionDates",
    "mutation",
    "changeTransactionDate",
    { name: "input", type: "ChangeTransactionDateInput!" },
    "transaction { id date posted_date __typename }\n    __typename",
    todo.map((t) => ({ transactionNodeId: t.id, date: t.target })),
  );
  const out = nodeIds.map((id, i) => ({ id, date: "", originalDate: "", error: lookupErrors[i] }));
  todo.forEach((t, k) => {
    const r = saved[k];
    const tx = r.data?.transaction;
    out[t.i] = tx?.date
      ? { id: t.id, date: tx.date, originalDate: tx.posted_date ?? "", error: undefined }
      : { id: t.id, date: "", originalDate: "", error: explainItemError(r.error) };
  });
  return out;
}

/** WRITE: set ignore on many transactions in one round trip. Returns RM's countUpdated. */
export async function setTransactionsIgnored(
  nodeIds: string[],
  ignoredFrom: "budget" | "everything" | null,
): Promise<number> {
  if (nodeIds.length === 0) return 0;
  const data = await rmFullText<{ setTransactionsIgnored?: { countUpdated?: number } }>(
    "SetTransactionsIgnored",
    "mutation SetTransactionsIgnored($input: SetTransactionsIgnoredInput!) {\n  setTransactionsIgnored(input: $input) {\n    transactions {\n      id\n      ignoredFrom\n      __typename\n    }\n    countUpdated\n    transactionOverrideIds\n    __typename\n  }\n}",
    { input: { transactionNodeIds: nodeIds, setIgnored: ignoredFrom } },
  );
  return data.setTransactionsIgnored?.countUpdated ?? 0;
}

// ── Categories ─────────────────────────────────────────────────────

export interface RMCategory {
  nodeId: string; // base64 Relay id, pass straight to setTransactionCategory
  id: string; // numeric id decoded from the node id
  label: string;
  type: string; // "default" | "custom"
  categoryType: string; // "expense" | "earning" | "ignored"
  includeInSpending: boolean;
  includeInEarnings: boolean;
  taxDeductible: boolean;
  iconKey: string;
  color: string; // colors.base, e.g. "rgb(117, 117, 117)"
}

/** base64(`TransactionCategory:<id>`) for a numeric category id. */
export function categoryNodeId(numericId: string | number): string {
  return toNodeId("TransactionCategory", numericId);
}

/** READ: the user's full category catalog (default + custom), with node ids. */
export async function getTransactionCategories(): Promise<RMCategory[]> {
  const data = await rmGraphQL<Record<string, unknown>>({ operationName: "TransactionCategories" });
  const nodes: Record<string, unknown>[] = [];
  collectByType(data, "TransactionCategory", nodes);
  const seen = new Set<string>();
  const cats: RMCategory[] = [];
  for (const o of nodes) {
    const nodeId = typeof o.id === "string" ? o.id : "";
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    cats.push(toCategory(o));
  }
  return cats.sort((a, b) => a.label.localeCompare(b.label));
}

// Per-process memo of the category catalog. Categories change rarely and the Fly
// machine stays warm, so caching spares a round-trip on every label resolution.
let _catCache: { at: number; cats: RMCategory[] } | null = null;
const CAT_TTL_MS = 10 * 60 * 1000;

async function categoriesCached(): Promise<RMCategory[]> {
  if (_catCache && Date.now() - _catCache.at < CAT_TTL_MS) return _catCache.cats;
  const cats = await getTransactionCategories();
  _catCache = { at: Date.now(), cats };
  return cats;
}

/**
 * Resolve a caller-supplied category (a label like "Groceries", a numeric id, or
 * a base64 TransactionCategory node id) to a node id. Throws a clear, actionable
 * error listing valid labels when a label doesn't match.
 */
export async function resolveCategoryNodeId(input: string | number): Promise<string> {
  const raw = String(input).trim();
  // Already a TransactionCategory node id?
  if (fromNodeId(raw)?.type === "TransactionCategory") return raw;
  // Bare numeric id -> build the node id (no lookup needed).
  if (/^\d+$/.test(raw)) return categoryNodeId(raw);
  // Otherwise treat it as a label and look it up (case-insensitive).
  const cats = await categoriesCached();
  const match = cats.find((c) => c.label.toLowerCase() === raw.toLowerCase());
  if (match) return match.nodeId;
  throw new Error(
    `Unknown category "${raw}". Use list_categories to see valid options. Available: ${cats
      .map((c) => c.label)
      .join(", ")}`,
  );
}

// Custom categories. Create and edit both require every field (label,
// categoryType, taxDeductible, color, iconKey; established 2026-10-29 by the
// validation-error count when one is left out), so edit merges over the stored
// category. Only custom categories can be edited or deleted. RM's delete has no
// reassign: the category's transactions become Uncategorized.

export type CategoryType = "expense" | "earning" | "ignored";

const CATEGORY_FIELDS = "id\n      label\n      type\n      categoryType\n      iconKey\n      includeInSpending\n      includeInEarnings\n      taxDeductible\n      colors {\n        base\n        __typename\n      }\n      __typename";

// The web app's own defaults for a new category's icon, and a neutral gray.
const DEFAULT_ICON = "coffee";
const DEFAULT_COLOR = "rgb(117, 117, 117)";

function toCategory(o: Record<string, unknown>): RMCategory {
  const nodeId = String(o.id ?? "");
  return {
    nodeId,
    id: fromNodeId(nodeId)?.numericId ?? "",
    label: String(o.label ?? ""),
    type: String(o.type ?? ""),
    categoryType: String(o.categoryType ?? ""),
    includeInSpending: Boolean(o.includeInSpending),
    includeInEarnings: Boolean(o.includeInEarnings),
    taxDeductible: Boolean(o.taxDeductible),
    iconKey: String(o.iconKey ?? ""),
    color: String((o.colors as { base?: string } | null)?.base ?? ""),
  };
}

/** WRITE: create a custom category. Returns it as RM saved it. */
export async function createCategory(
  label: string,
  categoryType: CategoryType,
  opts: { taxDeductible?: boolean; iconKey?: string; color?: string } = {},
): Promise<RMCategory> {
  const data = await rmFullText<{
    createCustomTransactionCategoryWithCategoryType?: { transactionCategory?: Record<string, unknown> };
  }>(
    "CreateCustomTransactionCategoryWithCategoryTypes",
    `mutation CreateCustomTransactionCategoryWithCategoryTypes($input: createCustomTransactionCategoryWithCategoryTypeInput!) {\n  createCustomTransactionCategoryWithCategoryType(input: $input) {\n    transactionCategory {\n      ${CATEGORY_FIELDS}\n    }\n    __typename\n  }\n}`,
    {
      input: {
        label: label.trim(),
        categoryType,
        taxDeductible: opts.taxDeductible ?? false,
        color: opts.color ?? DEFAULT_COLOR,
        iconKey: opts.iconKey ?? DEFAULT_ICON,
      },
    },
  );
  const cat = data.createCustomTransactionCategoryWithCategoryType?.transactionCategory;
  if (!cat) throw new Error(`createCustomTransactionCategory returned no category for "${label}".`);
  _catCache = null;
  return toCategory(cat);
}

/** A category from the catalog by node id, numeric id or label; throws unless it is custom. */
async function customCategory(input: string): Promise<RMCategory> {
  const nodeId = await resolveCategoryNodeId(input);
  let cat = (await categoriesCached()).find((c) => c.nodeId === nodeId);
  if (!cat) {
    // A numeric or node id skips the catalog, so it may name a category newer than the cache.
    _catCache = null;
    cat = (await categoriesCached()).find((c) => c.nodeId === nodeId);
  }
  if (!cat) throw new Error(`No category "${input}". Use list_categories to see valid options.`);
  if (cat.type !== "custom") {
    throw new Error(`"${cat.label}" is a default Rocket Money category; only custom categories can be changed or deleted.`);
  }
  return cat;
}

/** WRITE: rename or regroup a custom category. Fields left undefined keep their current values. */
export async function updateCategory(
  input: string,
  edit: { label?: string; categoryType?: CategoryType; taxDeductible?: boolean; iconKey?: string; color?: string },
): Promise<RMCategory> {
  const cat = await customCategory(input);
  const data = await rmFullText<{
    editCustomTransactionCategoryWithCategoryType?: { transactionCategory?: Record<string, unknown> };
  }>(
    "EditCustomTransactionCategoryWithCategoryType",
    `mutation EditCustomTransactionCategoryWithCategoryType($input: EditCustomTransactionCategoryWithCategoryTypeInput!) {\n  editCustomTransactionCategoryWithCategoryType(input: $input) {\n    transactionCategory {\n      ${CATEGORY_FIELDS}\n    }\n    __typename\n  }\n}`,
    {
      input: {
        transactionCategoryNodeId: cat.nodeId,
        label: edit.label?.trim() || cat.label,
        categoryType: edit.categoryType ?? cat.categoryType,
        taxDeductible: edit.taxDeductible ?? cat.taxDeductible,
        color: edit.color ?? (cat.color || DEFAULT_COLOR),
        iconKey: edit.iconKey ?? (cat.iconKey || DEFAULT_ICON),
      },
    },
  );
  const saved = data.editCustomTransactionCategoryWithCategoryType?.transactionCategory;
  if (!saved) throw new Error(`editCustomTransactionCategory returned no category for "${input}".`);
  _catCache = null;
  return toCategory(saved);
}

/**
 * WRITE: delete a custom category. With reassignTo, every transaction in it is
 * moved there first (RM's delete would leave them Uncategorized). Returns how
 * many were moved.
 */
export async function deleteCategory(
  input: string,
  reassignTo?: string,
): Promise<{ deleted: RMCategory; reassigned: number; reassignedTo: string | null }> {
  const cat = await customCategory(input);
  let reassigned = 0;
  let target: string | null = null;
  if (reassignTo) {
    target = await resolveCategoryNodeId(reassignTo);
    if (target === cat.nodeId) throw new Error("reassign_to is the category being deleted.");
    const ids = (await searchAllTransactions({ categoryIds: [cat.nodeId] })).map((t) => t.nodeId);
    reassigned = await setTransactionsCategoryChunked(ids, target);
    if (reassigned < ids.length) {
      throw new Error(
        `Not deleted: moved only ${reassigned} of ${ids.length} transactions out of "${cat.label}". Nothing was deleted; retry or move the rest by hand.`,
      );
    }
  }
  await rmFullText(
    "DeleteCustomTransactionCategory",
    "mutation DeleteCustomTransactionCategory($input: DeleteCustomTransactionCategoryInput!) {\n  deleteCustomTransactionCategory(input: $input) {\n    viewer {\n      id\n      __typename\n    }\n    __typename\n  }\n}",
    { input: { transactionCategoryNodeId: cat.nodeId } },
  );
  _catCache = null;
  return { deleted: cat, reassigned, reassignedTo: target };
}

/**
 * WRITE: set (or clear, with "") notes on many transactions, as aliased
 * mutations BATCH_SIZE per request. Returns each saved note, or an error per id.
 */
export async function setTransactionsNote(
  items: { nodeId: string; note: string }[],
): Promise<{ id: string; note: string | null; error?: string }[]> {
  const out: { id: string; note: string | null; error?: string }[] = items.map((it) => {
    const why = notATransactionId(it.nodeId);
    return why ? { id: it.nodeId, note: null, error: why } : { id: it.nodeId, note: null };
  });
  const todo = items.map((it, i) => ({ it, i })).filter((x) => !out[x.i].error);
  const results = await batchAliased<{ transaction?: { note?: string | null } }>(
    "SetTransactionNotes",
    "mutation",
    "setTransactionNote",
    { name: "input", type: "SetTransactionNoteInput!" },
    "transaction { id note __typename }\n    __typename",
    todo.map(({ it }) => ({ transactionNodeId: it.nodeId, note: it.note })),
  );
  todo.forEach(({ it, i }, k) => {
    const r = results[k];
    out[i] = r.ok
      ? { id: it.nodeId, note: r.data?.transaction?.note ?? null }
      : { id: it.nodeId, note: null, error: explainItemError(r.error) };
  });
  return out;
}

/** WRITE: set (or clear, with "") a transaction's free-text note. Returns the saved note. */
export async function setTransactionNote(nodeId: string, note: string): Promise<string> {
  const data = await rmFullText<{ setTransactionNote?: { transaction?: { note?: string } } }>(
    "SetTransactionNote",
    "mutation SetTransactionNote($input: SetTransactionNoteInput!) {\n  setTransactionNote(input: $input) {\n    __typename\n    transaction {\n      __typename\n      id\n      note\n    }\n  }\n}",
    { input: { transactionNodeId: nodeId, note } },
  );
  return data.setTransactionNote?.transaction?.note ?? note;
}

/**
 * WRITE: set the spending category on many transactions in one round trip.
 * This is the mutation the web app fires when you multi-select rows, and it is
 * the only reliable way to recategorize in bulk. Returns RM's own countUpdated.
 */
export async function setTransactionsCategory(
  nodeIds: string[],
  catNodeId: string,
): Promise<number> {
  if (nodeIds.length === 0) return 0;
  const data = await rmFullText<{ setTransactionsCategory?: { countUpdated?: number } }>(
    "SetTransactionsCategory",
    "mutation SetTransactionsCategory($input: SetTransactionsCategoryInput!) {\n  setTransactionsCategory(input: $input) {\n    transactions {\n      id\n      category {\n        id\n        __typename\n      }\n      ignoredFrom\n      __typename\n    }\n    countUpdated\n    transactionOverrideIds\n    __typename\n  }\n}",
    {
      input: {
        transactionNodeIds: nodeIds,
        transactionCategoryNodeId: catNodeId,
      },
    },
  );
  return data.setTransactionsCategory?.countUpdated ?? 0;
}

/**
 * WRITE: set one transaction's spending category. `catNodeId` must be a
 * TransactionCategory node id (use resolveCategoryNodeId to accept labels/ids).
 *
 * `applyToAll` sweeps the merchant's other rows by looking the merchant name up
 * and bulk-setting the matches. It deliberately does NOT use the singular
 * mutation's `categorizeAllRelatedTransactions` input: RM accepts that field and
 * returns success, but only ever updates the one transaction you named, so a
 * caller trusting it silently leaves the rest of the merchant behind.
 */
export async function setTransactionCategory(
  nodeId: string,
  catNodeId: string,
  applyToAll = false,
): Promise<number> {
  if (!applyToAll) return setTransactionsCategory([nodeId], catNodeId);

  // Read the merchant name off the transaction itself: scanning recent rows for
  // it missed anything older than the newest 200 and silently updated only one.
  const self = await rmFullText<{ node?: { longName?: string | null } }>(
    "TransactionName",
    "query TransactionName($id: ID!) {\n  node(id: $id) {\n    id\n    ... on Transaction {\n      longName(prependCustomName: false)\n    }\n    __typename\n  }\n}",
    { id: nodeId },
  );
  const name = self.node?.longName;
  if (!name) throw new Error(`No transaction "${nodeId}" (or it has no name to match the rest of the merchant on).`);

  const related = await searchAllTransactions({ query: name });
  const ids = new Set<string>([nodeId, ...related.map((t) => t.nodeId)]);
  return setTransactionsCategoryChunked([...ids], catNodeId);
}

/** setTransactionsCategory in 500-id chunks, for sweeps that can match thousands. */
async function setTransactionsCategoryChunked(nodeIds: string[], catNodeId: string): Promise<number> {
  let updated = 0;
  for (let i = 0; i < nodeIds.length; i += 500) updated += await setTransactionsCategory(nodeIds.slice(i, i + 500), catNodeId);
  return updated;
}

export { findByType, collectByType };
