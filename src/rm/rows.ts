// Transaction rows as callers see them, shared by the MCP tools and the /api
// feed so both describe a transaction the same way.

import { RMAuthError, rmFullText } from "./graphql.js";
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

const accountOf = (t: RMTransaction, labels: Map<string, string>) =>
  t.accountId ? (labels.get(t.accountId) ?? t.accountId) : null;

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
  const { labels, warning } = txns.length ? await accountLabelsOrIds() : { labels: new Map<string, string>() };
  if (compact) return { ...(warning ? { warning } : {}), ...compactTable(txns, labels) };
  const liveRules = txns.some((t) => t.ruleIds.length) ? await liveRuleIds() : null;
  return {
    ...(warning ? { warning } : {}),
    transactions: txns.map((t) => shapeTxn(t, { labels, liveRules })),
  };
}
