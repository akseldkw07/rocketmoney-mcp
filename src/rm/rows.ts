// Transaction rows as callers see them, shared by the MCP tools and the /api
// feed so both describe a transaction the same way.

import { RMAuthError, batchAliased, rmFullText } from "./graphql.js";
import type { RMTransaction } from "./transactions.js";
import { accountLabel, usd } from "./format.js";
import { liveRuleIds } from "./rules.js";

// ── Account labels ─────────────────────────────────────────────────

const ACCOUNT_LABELS = `query AccountLabels {
  viewer {
    id
    accounts(enabled: true) {
      edges { node { id name number institution { id name short_name __typename } __typename } __typename }
      __typename
    }
    __typename
  }
}`;

// Accounts change only when one is linked or renamed, so a short cache spares a
// round trip on every transaction list while still picking up a new account.
let labelCache: { at: number; labels: Map<string, string> } | null = null;
const LABEL_TTL_MS = 10 * 60 * 1000;

/**
 * Account node id -> "Institution Account 1234", so rows name the card they hit
 * instead of an opaque base64 id. Uses a lean query (about 4 KB for 23 accounts)
 * rather than the account page, which carries balances for six overlapping
 * account buckets.
 */
export async function accountLabels(): Promise<Map<string, string>> {
  if (labelCache && Date.now() - labelCache.at < LABEL_TTL_MS) return labelCache.labels;
  const data = await rmFullText<{ viewer?: { accounts?: { edges?: { node: Record<string, unknown> }[] } } }>(
    "AccountLabels",
    ACCOUNT_LABELS,
    {},
  );
  const labels = new Map<string, string>();
  for (const { node } of data.viewer?.accounts?.edges ?? []) {
    if (typeof node.id === "string") labels.set(node.id, accountLabel(node) ?? node.id);
  }
  labelCache = { at: Date.now(), labels };
  return labels;
}

// Accounts that aren't in the enabled list, looked up one by one (F14), with
// the same lifetime as the enabled list's cache.
let unknownCache: { at: number; labels: Map<string, string> } = { at: Date.now(), labels: new Map() };

/**
 * Label the accounts rows name that `labels` (the enabled list) doesn't know:
 * Rocket Money's own manual "Cash" account (where create_transaction files rows
 * by default) and switched-off accounts. Each is read with node(id:), which
 * answers for both: "Cash (manual) <id>", "(switched off) Chase Southwest 0112
 * <id>". The id stays in the label so it can still go into account_ids. An id
 * RM returns null for is left out (rows fall back to "(switched off) <id>"); a
 * lookup that fails is reported in `warning` with RM's error.
 */
export async function labelUnknownAccounts(
  txns: RMTransaction[],
  labels: Map<string, string>,
): Promise<{ labels: Map<string, string>; warning?: string }> {
  if (Date.now() - unknownCache.at > LABEL_TTL_MS) unknownCache = { at: Date.now(), labels: new Map() };
  const merged = new Map(labels);
  for (const [id, label] of unknownCache.labels) if (!merged.has(id)) merged.set(id, label);
  const missing = [...new Set(txns.map((t) => t.accountId).filter((id): id is string => !!id && !merged.has(id)))];
  if (!missing.length) return { labels: merged };
  const found = await batchAliased<Record<string, unknown>>(
    "UnknownAccountLabels",
    "query",
    "node",
    { name: "id", type: "ID!" },
    "id\n    ... on Account { name number source institution { id short_name __typename } }\n    __typename",
    missing,
  );
  const failures: string[] = [];
  missing.forEach((id, i) => {
    const r = found[i];
    if (!r.ok) {
      // A null node with no error just means RM has nothing for that id.
      if (r.error !== "no result returned") failures.push(`${id}: ${r.error}`);
      return;
    }
    // RM's manual "Cash" account has institution "Cash", name "Cash" and number "0000", so
    // the usual "institution name number" label would read "Cash Cash 0000": use its name.
    const label =
      r.data?.source === "manual"
        ? `${String(r.data.name ?? "account")} (manual) ${id}`
        : `(switched off) ${accountLabel(r.data ?? {}) ?? "account"} ${id}`;
    unknownCache.labels.set(id, label);
    merged.set(id, label);
  });
  return failures.length
    ? { labels: merged, warning: `Couldn't look up ${failures.length} account name(s), so those rows show "(switched off) <id>": ${failures.join("; ")}` }
    : { labels: merged };
}

/**
 * accountLabels for decorating rows, degrading to raw account ids when the
 * account list can't be read instead of failing a call whose real data loaded.
 */
export async function accountLabelsOrIds(): Promise<{ labels: Map<string, string>; warning?: string }> {
  try {
    return { labels: await accountLabels() };
  } catch (err) {
    if (err instanceof RMAuthError) throw err;
    return {
      labels: new Map(),
      warning: `Account names unavailable, so rows show account ids (${err instanceof Error ? err.message : err}).`,
    };
  }
}

// ── Row shapes ─────────────────────────────────────────────────────

interface RowContext {
  labels: Map<string, string>;
  /** null when no row has rule ids, so the rule list wasn't fetched. */
  liveRules: Set<string> | null;
}

/**
 * The account a row names. AccountLabels lists enabled accounts only, but a
 * switched-off account keeps its history, so its transactions still turn up
 * (F11). Such an id is labeled "(switched off) <id>": readable, and the id is
 * still there to pass to account_ids. An empty map means the names couldn't be
 * read at all (accountLabelsOrIds already warns), so rows keep plain ids.
 */
const accountOf = (t: RMTransaction, labels: Map<string, string>) => {
  if (!t.accountId) return null;
  const label = labels.get(t.accountId);
  if (label) return label;
  return labels.size ? `(switched off) ${t.accountId}` : t.accountId;
};

/**
 * One transaction row, the same shape everywhere transactions are listed.
 * Empty fields are left out rather than sent as null/[]; on a large pull they
 * are most of the payload. (compactTable is the bulk form.)
 */
export function shapeTxn(t: RMTransaction, ctx: RowContext): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: t.nodeId,
    date: t.date,
    amount: usd(t.amountCents),
    name: t.name,
    category: t.categoryLabel,
    account: accountOf(t, ctx.labels),
  };
  if (t.originalDate && t.originalDate !== t.date) row.original_date = t.originalDate;
  if (t.ignoredFrom) row.ignore = t.ignoredFrom;
  if (t.customName) row.custom_name = t.customName;
  if (t.note) row.note = t.note;
  if (t.splitParentId) row.split_of = t.splitParentId;
  if (t.ruleIds.length) {
    const live = t.ruleIds.filter((id) => ctx.liveRules?.has(id));
    const deleted = t.ruleIds.filter((id) => !ctx.liveRules?.has(id));
    if (live.length) row.applied_rule_ids = live;
    if (deleted.length) row.deleted_rule_ids = deleted;
  }
  return row;
}

export const COMPACT_COLUMNS = ["id", "date", "amount", "name", "category", "account", "original_date", "ignore"] as const;

/** Index-assigning dictionary: each distinct value gets the next index, in first-seen order. */
function dictionary() {
  const values: string[] = [];
  const index = new Map<string, number>();
  return {
    values,
    of(v: string | null): number | null {
      if (v === null) return null;
      let i = index.get(v);
      if (i === undefined) index.set(v, (i = values.push(v) - 1));
      return i;
    },
  };
}

/**
 * Compact form for bulk reads: a table instead of an object per row. Column
 * names appear once, and category and account - the longest repeated strings -
 * are indexes into `categories` / `accounts`. Trailing empty cells are dropped.
 * About half the size of compact objects on a 1,200-row pull.
 */
export function compactTable(txns: RMTransaction[], labels: Map<string, string>) {
  const categories = dictionary();
  const accounts = dictionary();
  const rows = txns.map((t) => {
    const row: unknown[] = [
      t.nodeId,
      t.date,
      usd(t.amountCents),
      t.name,
      categories.of(t.categoryLabel),
      accounts.of(accountOf(t, labels)),
      t.originalDate && t.originalDate !== t.date ? t.originalDate : null,
      t.ignoredFrom ?? null,
    ];
    while (row.length && row[row.length - 1] === null) row.pop();
    return row;
  });
  return { columns: COMPACT_COLUMNS, categories: categories.values, accounts: accounts.values, rows };
}

/** Rows for a list of transactions: full objects, or the compact table. */
export async function shapeTxns(txns: RMTransaction[], compact = false) {
  const base = txns.length ? await accountLabelsOrIds() : { labels: new Map<string, string>() };
  // With no names at all (base.labels empty) rows keep plain ids; otherwise name the unknown accounts too.
  const extra = base.labels.size
    ? await labelUnknownAccounts(txns, base.labels).catch((err: unknown) => {
        if (err instanceof RMAuthError) throw err;
        return {
          labels: base.labels,
          warning: `Couldn't look up switched-off or manual account names, so those rows show "(switched off) <id>": ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        };
      })
    : { labels: base.labels };
  const labels = extra.labels;
  const warnings = [base.warning, extra.warning].filter(Boolean);
  const warning = warnings.length ? warnings.join(" ") : undefined;
  if (compact) return { ...(warning ? { warning } : {}), ...compactTable(txns, labels) };
  const liveRules = txns.some((t) => t.ruleIds.length) ? await liveRuleIds() : null;
  return {
    ...(warning ? { warning } : {}),
    transactions: txns.map((t) => shapeTxn(t, { labels, liveRules })),
  };
}
