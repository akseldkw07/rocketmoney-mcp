import { rmFullText, toRMTransaction, TRANSACTION_FIELDS, type RMTransaction } from "./client.js";
import { addDaysYmd, ymd } from "./windows.js";

// Transaction rules (Settings -> Transaction Rules, or "Edit Rule" on a
// transaction). Every operation here sends its own query text rather than a
// persisted hash, so a hash rotation can't break them. Operation names, input
// shapes and semantics were read from the web bundle's documents and the code
// that calls them, then confirmed against the live API (2026-10-29):
//
// - A rule is { matchRules: { v1: MatchRulesV1 }, operation }. Saving one with
//   SaveTransactionRuleMutation (no `id` = create, `id` = update) makes Rocket
//   Money apply its updates to EVERY transaction it matches at save time, then
//   to future matches. The input has no "apply to existing" switch: unknown
//   fields fail validation (probed 2026-10-29). The web client's own toast says
//   "a rule that affects N existing transactions, and future, matching
//   transactions". So "don't touch existing transactions" is done here with a
//   date floor: postedDateBetween.min = tomorrow, which matches nothing yet.
// - DestroyTransactionRule takes { ruleId, keepRuleChanges }; false reverts the
//   rule's past changes ("Undo past changes?" in the web app).
// - Amounts are cents, compared as absolute values unless the range is
//   amountDebitBetween (money out, positive amounts) or amountCreditBetween.
//   Open bounds are the strings "Infinity" / "-Infinity".
// - postedDateBetween bounds are ISO timestamps. The web app only offers
//   "date is after", but a bounded max works (preview-tested).

const RULE_FIELDS = `
  id
  numberMatchingTransactions
  matchRules {
    v1 {
      transactionNameIs
      transactionNameContains
      absAmountBetween
      amountCreditBetween
      amountDebitBetween
      postedDateBetween
      service { id name __typename }
      accountIdIsIn
      accountsIn { id name __typename }
      __typename
    }
    __typename
  }
  operation {
    ignoredFrom { title value __typename }
    customName { title value __typename }
    taxDeductible { title value __typename }
    subscription { title subscription { id custom_name service { id name __typename } __typename } __typename }
    transactionCategory { title transactionCategory { id label __typename } __typename }
    __typename
  }
  __typename`;

const RULES_PAGE = `query TransactionRulesPage($first: Int, $cursor: String) {
  viewer {
    id
    transactionRules(first: $first, after: $cursor) {
      edges { node { ${RULE_FIELDS} } cursor __typename }
      pageInfo { endCursor hasNextPage __typename }
      __typename
    }
    __typename
  }
}`;

const RULES_SEARCH = `query TransactionRulesSearch($matchRules: MatchRulesInput!, $first: Int!) {
  viewer {
    id
    ruleTransactions(matchRules: $matchRules, first: $first) {
      numMatchingTransactions
      transactions {
        edges {
          node { ${TRANSACTION_FIELDS} }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

// The payload has no rule field, but it does expose `viewer` (probed
// 2026-10-29), so the save returns the rule list as of after the save - sparing
// a separate listRules() round trip to find the new or replaced rule's id.
const SAVE_RULE = `mutation SaveTransactionRuleMutation($input: SaveTransactionRuleInput!) {
  saveTransactionRule(input: $input) {
    clientMutationId
    viewer {
      id
      transactionRules(first: 100) {
        edges { node { ${RULE_FIELDS} } __typename }
        pageInfo { hasNextPage __typename }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

const DESTROY_RULE = `mutation DestroyTransactionRule($input: DestroyTransactionRuleInput!) {
  destroyTransactionRule(input: $input) {
    clientMutationId
    __typename
  }
}`;

// ── Wire types ─────────────────────────────────────────────────────

interface Bound {
  value: number | string;
  inclusive: boolean;
}
interface Range {
  min: Bound;
  max: Bound;
}

/** MatchRulesV1 as SaveTransactionRule / ruleTransactions accept it. */
export interface MatchRulesV1Input {
  transactionNameIs?: string;
  transactionNameContains?: string;
  serviceIdIs?: string;
  accountIdIsIn?: string[];
  postedDateBetween?: Range;
  absAmountBetween?: Range;
  amountDebitBetween?: Range;
  amountCreditBetween?: Range;
}

/** The operation half of SaveTransactionRuleInput. */
export interface RuleOperationInput {
  transactionCategoryId?: string;
  customName?: string;
  ignoredFrom?: "budget" | "everything";
  taxDeductible?: boolean;
  subscriptionId?: string;
}

// ── Caller-facing vocabulary (dollars, dates, plain names) ─────────

export type AmountType = "any" | "debit" | "credit";

export interface RuleConditions {
  name_contains?: string | null;
  name_equals?: string | null;
  amount?: number | null;
  amount_min?: number | null;
  amount_max?: number | null;
  amount_type?: AmountType | null;
  account_ids?: string[] | null;
  date_from?: string | null;
  date_to?: string | null;
  /** Merchant (Service node id). Only rules made from a merchant page carry one. */
  merchant_id?: string | null;
}

export interface RuleUpdates {
  /** Category node id, already resolved by the caller. */
  category_id?: string | null;
  rename?: string | null;
  ignore?: "none" | "budget" | "everything" | null;
  tax_deductible?: boolean | null;
  /** Subscription node id. Not exposed as a tool input; kept so updates preserve it. */
  subscription_id?: string | null;
}

export interface RMRule {
  id: string;
  matchedCount: number;
  conditions: RuleConditions;
  /** Human-readable account names for conditions.account_ids. */
  accounts: { id: string; name: string }[];
  merchant: { id: string; name: string } | null;
  updates: RuleUpdates & { category_label?: string | null; subscription_name?: string | null };
  /** RM's own one-line labels for each update, e.g. "Change Category to Venmo". */
  updateTitles: string[];
  /** The match rules exactly as stored, for resending unchanged on an update. */
  matchRulesInput: MatchRulesV1Input;
}

const toCents = (usd: number) => Math.round(usd * 100);
const fromCents = (v: number | string) => (typeof v === "number" ? v / 100 : null);
const dateToIso = (ymd: string) => `${ymd}T00:00:00.000Z`;
const isoToDate = (v: number | string) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const present = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined && v !== "";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Stands in for an open start date; earlier than any Rocket Money transaction. */
export const EARLIEST_DATE = "2000-01-01";

/**
 * Caller conditions -> MatchRulesV1Input, following the web client's encoding:
 * exact amount = inclusive [x, x]; min+max = inclusive range; min only =
 * "greater than" (exclusive, max "Infinity"); max only = "less than"
 * (exclusive, min "-Infinity").
 */
export function conditionsToInput(c: RuleConditions): MatchRulesV1Input {
  const out: MatchRulesV1Input = {};
  if (present(c.name_contains) && present(c.name_equals)) {
    throw new Error("Use name_contains or name_equals, not both.");
  }
  if (present(c.name_contains)) out.transactionNameContains = c.name_contains.trim();
  if (present(c.name_equals)) out.transactionNameIs = c.name_equals.trim();
  if (present(c.merchant_id)) out.serviceIdIs = c.merchant_id;
  if (c.account_ids?.length) out.accountIdIsIn = c.account_ids;

  if (present(c.amount) && (present(c.amount_min) || present(c.amount_max))) {
    throw new Error("Use amount (exact) or amount_min/amount_max (range), not both.");
  }
  let range: Range | null = null;
  if (present(c.amount)) {
    const v = toCents(Math.abs(c.amount));
    range = { min: { value: v, inclusive: true }, max: { value: v, inclusive: true } };
  } else if (present(c.amount_min) && present(c.amount_max)) {
    if (c.amount_min > c.amount_max) throw new Error("amount_min is greater than amount_max.");
    range = {
      min: { value: toCents(c.amount_min), inclusive: true },
      max: { value: toCents(c.amount_max), inclusive: true },
    };
  } else if (present(c.amount_min)) {
    range = { min: { value: toCents(c.amount_min), inclusive: false }, max: { value: "Infinity", inclusive: false } };
  } else if (present(c.amount_max)) {
    range = { min: { value: "-Infinity", inclusive: false }, max: { value: toCents(c.amount_max), inclusive: false } };
  }
  if (range) {
    const type = c.amount_type ?? "any";
    if (type === "debit") out.amountDebitBetween = range;
    else if (type === "credit") out.amountCreditBetween = range;
    else out.absAmountBetween = range;
  } else if (present(c.amount_type) && c.amount_type !== "any") {
    throw new Error("amount_type needs an amount, amount_min or amount_max to apply to.");
  }

  for (const d of [c.date_from, c.date_to]) {
    if (present(d) && !YMD.test(d)) throw new Error(`Dates must be YYYY-MM-DD, got "${d}".`);
  }
  if (present(c.date_from) && present(c.date_to) && c.date_from > c.date_to) {
    throw new Error("date_from is after date_to.");
  }
  // An open lower date bound can't be "-Infinity": RM rejects it for dates
  // ("An error occurred.", 2026-10-29) though it takes "Infinity" as an open
  // upper bound. A date_to alone gets a concrete floor before any transaction.
  if (present(c.date_from) || present(c.date_to)) {
    out.postedDateBetween = {
      min: { value: dateToIso(present(c.date_from) ? c.date_from : EARLIEST_DATE), inclusive: true },
      max: present(c.date_to) ? { value: dateToIso(c.date_to), inclusive: true } : { value: "Infinity", inclusive: false },
    };
  }

  if (Object.keys(out).length === 0) throw new Error("A rule needs at least one match condition.");
  return out;
}

function rangeToConditions(r: Range | null | undefined, type: AmountType, c: RuleConditions): void {
  if (!r) return;
  const min = fromCents(r.min.value);
  const max = fromCents(r.max.value);
  if (min !== null && max !== null && min === max) c.amount = min;
  else {
    if (min !== null) c.amount_min = min;
    if (max !== null) c.amount_max = max;
  }
  c.amount_type = type;
}

/** The read-side v1 object -> the input shape, dropping nulls and display-only fields. */
function storedMatchRules(v1: Record<string, unknown>): MatchRulesV1Input {
  const out: Record<string, unknown> = {
    transactionNameIs: v1.transactionNameIs,
    transactionNameContains: v1.transactionNameContains,
    serviceIdIs: (v1.service as { id?: string } | null)?.id,
    accountIdIsIn: Array.isArray(v1.accountIdIsIn) && v1.accountIdIsIn.length ? v1.accountIdIsIn : undefined,
    postedDateBetween: v1.postedDateBetween,
    absAmountBetween: v1.absAmountBetween,
    amountDebitBetween: v1.amountDebitBetween,
    amountCreditBetween: v1.amountCreditBetween,
  };
  for (const k of Object.keys(out)) if (out[k] === null || out[k] === undefined) delete out[k];
  return out as MatchRulesV1Input;
}

/** A rule node from TransactionRulesPage -> RMRule. */
export function parseRule(node: Record<string, unknown>): RMRule {
  const v1 = ((node.matchRules as Record<string, unknown> | null)?.v1 ?? {}) as Record<string, unknown>;
  const op = (node.operation ?? {}) as Record<string, Record<string, unknown> | null>;
  const c: RuleConditions = {};
  if (present(v1.transactionNameContains as string)) c.name_contains = v1.transactionNameContains as string;
  if (present(v1.transactionNameIs as string)) c.name_equals = v1.transactionNameIs as string;
  const service = v1.service as { id?: string; name?: string } | null;
  if (service?.id) c.merchant_id = service.id;
  if (Array.isArray(v1.accountIdIsIn) && v1.accountIdIsIn.length) c.account_ids = v1.accountIdIsIn as string[];
  rangeToConditions(v1.absAmountBetween as Range, "any", c);
  rangeToConditions(v1.amountDebitBetween as Range, "debit", c);
  rangeToConditions(v1.amountCreditBetween as Range, "credit", c);
  const dates = v1.postedDateBetween as Range | null;
  if (dates) {
    const from = isoToDate(dates.min.value);
    const to = isoToDate(dates.max.value);
    if (from && from !== EARLIEST_DATE) c.date_from = from;
    if (to) c.date_to = to;
  }

  const cat = op.transactionCategory?.transactionCategory as { id?: string; label?: string } | undefined;
  const sub = op.subscription?.subscription as
    | { id?: string; custom_name?: string | null; service?: { name?: string } | null }
    | undefined;
  const updates: RMRule["updates"] = {};
  if (cat?.id) {
    updates.category_id = cat.id;
    updates.category_label = cat.label ?? null;
  }
  if (present(op.customName?.value as string)) updates.rename = op.customName!.value as string;
  if (present(op.ignoredFrom?.value as string)) updates.ignore = op.ignoredFrom!.value as "budget" | "everything";
  if (op.taxDeductible?.value === true) updates.tax_deductible = true;
  if (sub?.id) {
    updates.subscription_id = sub.id;
    updates.subscription_name = sub.custom_name ?? sub.service?.name ?? null;
  }

  return {
    id: String(node.id ?? ""),
    matchedCount: typeof node.numberMatchingTransactions === "number" ? node.numberMatchingTransactions : 0,
    conditions: c,
    accounts: ((v1.accountsIn as { id: string; name: string }[] | null) ?? []).map((a) => ({ id: a.id, name: a.name })),
    merchant: service?.id ? { id: service.id, name: service.name ?? "" } : null,
    updates,
    matchRulesInput: storedMatchRules(v1),
    updateTitles: Object.values(op)
      .map((o) => (o && typeof o === "object" ? (o.title as string | undefined) : undefined))
      .filter((t): t is string => Boolean(t)),
  };
}

/** Caller updates -> the operation half of SaveTransactionRuleInput. */
export function updatesToInput(u: RuleUpdates): RuleOperationInput {
  const out: RuleOperationInput = {};
  if (present(u.category_id)) out.transactionCategoryId = u.category_id;
  if (present(u.rename)) out.customName = u.rename.trim();
  if (u.ignore === "budget" || u.ignore === "everything") out.ignoredFrom = u.ignore;
  if (u.tax_deductible === true) out.taxDeductible = true;
  if (present(u.subscription_id)) out.subscriptionId = u.subscription_id;
  if (Object.keys(out).length === 0) {
    throw new Error("A rule needs at least one update (category, rename, ignore or tax_deductible).");
  }
  return out;
}

/**
 * Overlay a patch on a base: keys the patch leaves undefined keep the base
 * value, keys it sets to null are cleared.
 */
export function mergePatch<T extends object>(base: T, patch: Partial<T> | undefined): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

/** Start of tomorrow (UTC), YYYY-MM-DD: a date floor no existing transaction can meet. */
export function tomorrowYmd(now = new Date()): string {
  return addDaysYmd(ymd(now), 1);
}

/**
 * Raise date_from to at least tomorrow so the rule matches only transactions
 * that haven't posted yet. Throws when date_to would leave the rule matching
 * nothing ever.
 */
export function withFutureFloor(c: RuleConditions, now = new Date()): RuleConditions {
  const floor = tomorrowYmd(now);
  if (present(c.date_to) && c.date_to < floor) {
    throw new Error(
      `date_to ${c.date_to} is in the past, so with apply_to_existing=false the rule could never match anything. ` +
        "Drop date_to or pass apply_to_existing=true.",
    );
  }
  if (present(c.date_from) && c.date_from >= floor) return c;
  return { ...c, date_from: floor };
}

// ── API calls ──────────────────────────────────────────────────────

export async function listRules(): Promise<RMRule[]> {
  const rules: RMRule[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data: { viewer?: { transactionRules?: Record<string, unknown> } } = await rmFullText(
      "TransactionRulesPage",
      RULES_PAGE,
      { first: 100, cursor },
    );
    const conn = data.viewer?.transactionRules as
      | { edges?: { node: Record<string, unknown> }[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } }
      | undefined;
    for (const e of conn?.edges ?? []) rules.push(parseRule(e.node));
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    cursor = conn.pageInfo.endCursor;
  }
  liveIdCache = { at: Date.now(), ids: new Set(rules.map((r) => r.id)) };
  return rules;
}

// Live rule ids, so transaction rows can tell a rule that still exists from one
// RM keeps in a transaction's history after it was deleted. Short-lived: rules
// change only through the tools here (which clear it) or the web app.
let liveIdCache: { at: number; ids: Set<string> } | null = null;
const LIVE_ID_TTL_MS = 60_000;

export async function liveRuleIds(): Promise<Set<string>> {
  if (liveIdCache && Date.now() - liveIdCache.at < LIVE_ID_TTL_MS) return liveIdCache.ids;
  await listRules();
  return liveIdCache!.ids;
}

export async function getRule(ruleId: string): Promise<RMRule> {
  const rule = (await listRules()).find((r) => r.id === ruleId);
  if (!rule) throw new Error(`No transaction rule with id "${ruleId}". Use list_rules to see rule ids.`);
  return rule;
}

/** Dry run: how many transactions a set of conditions matches, plus the newest `first`. */
export async function previewMatches(
  matchRules: MatchRulesV1Input,
  first = 20,
): Promise<{ count: number; sample: RMTransaction[] }> {
  const data = await rmFullText<{ viewer?: { ruleTransactions?: Record<string, unknown> } }>(
    "TransactionRulesSearch",
    RULES_SEARCH,
    { matchRules: { v1: matchRules }, first },
  );
  const rt = data.viewer?.ruleTransactions as
    | { numMatchingTransactions?: number; transactions?: { edges?: { node: Record<string, unknown> }[] } }
    | undefined;
  return {
    count: rt?.numMatchingTransactions ?? 0,
    sample: (rt?.transactions?.edges ?? [])
      .map(({ node }) => toRMTransaction(node))
      .filter((t): t is RMTransaction => t !== null),
  };
}

/**
 * WRITE: create (no ruleId) or replace (ruleId) a rule. RM applies it to every
 * current match. Returns every rule as of after the save.
 */
export async function saveRule(
  matchRules: MatchRulesV1Input,
  operation: RuleOperationInput,
  ruleId?: string,
): Promise<RMRule[]> {
  liveIdCache = null;
  const data = await rmFullText<{
    saveTransactionRule?: {
      viewer?: { transactionRules?: { edges?: { node: Record<string, unknown> }[]; pageInfo?: { hasNextPage?: boolean } } };
    };
  }>("SaveTransactionRuleMutation", SAVE_RULE, {
    input: { matchRules: { v1: matchRules }, ...operation, ...(ruleId ? { id: ruleId } : {}) },
  });
  const conn = data.saveTransactionRule?.viewer?.transactionRules;
  // Past one page (100 rules) the payload is incomplete; page through instead.
  if (!conn?.edges || conn.pageInfo?.hasNextPage) return listRules();
  const rules = conn.edges.map((e) => parseRule(e.node));
  liveIdCache = { at: Date.now(), ids: new Set(rules.map((r) => r.id)) };
  return rules;
}

/** WRITE: delete a rule. keepChanges=false also reverts what it changed on past transactions. */
export async function destroyRule(ruleId: string, keepChanges: boolean): Promise<void> {
  liveIdCache = null;
  await rmFullText("DestroyTransactionRule", DESTROY_RULE, {
    input: { ruleId, keepRuleChanges: keepChanges },
  });
}

/** A rule's updates in input vocabulary (display-only labels dropped). */
export function ruleUpdates(rule: RMRule): RuleUpdates {
  const { category_label: _l, subscription_name: _s, ...updates } = rule.updates;
  return updates;
}

// ── Write orchestration (the tool layer's entry points) ─────────────

export interface RuleWriteResult {
  rule: RMRule | null;
  /** Existing transactions Rocket Money applied the rule's updates to on save. */
  existingTransactionsUpdated: number;
  /** Set when apply_to_existing=false moved date_from up to keep the rule off past transactions. */
  dateFloorAdded: string | null;
}

/** Name and amount conditions come in exclusive pairs; setting one side clears the other. */
export function patchConditions(base: RuleConditions, patch: RuleConditions): RuleConditions {
  const p = { ...patch };
  if (present(p.name_contains)) p.name_equals ??= null;
  if (present(p.name_equals)) p.name_contains ??= null;
  if (present(p.amount)) {
    p.amount_min ??= null;
    p.amount_max ??= null;
  }
  if (present(p.amount_min) || present(p.amount_max)) p.amount ??= null;
  return mergePatch(base, p);
}

/**
 * Preview then save. With applyToExisting=false the conditions get a future
 * date floor and the save is refused unless the preview matches 0 existing
 * transactions, so nothing already posted can be touched.
 */
async function previewAndSave(
  conditions: RuleConditions | null,
  storedInput: MatchRulesV1Input,
  operation: RuleOperationInput,
  applyToExisting: boolean,
  ruleId?: string,
): Promise<{ count: number; floor: string | null; after: RMRule[] }> {
  let input = storedInput;
  let floor: string | null = null;
  if (conditions) {
    const c = applyToExisting ? conditions : withFutureFloor(conditions);
    if (c.date_from !== conditions.date_from) floor = c.date_from ?? null;
    input = conditionsToInput(c);
  }
  const { count } = await previewMatches(input, 1);
  if (!applyToExisting && count > 0) {
    throw new Error(
      `Not saved: these conditions match ${count} existing transaction(s), and Rocket Money applies a rule to ` +
        "every transaction it matches when it is saved. Pass apply_to_existing=true to update them.",
    );
  }
  const after = await saveRule(input, operation, ruleId);
  return { count, floor, after };
}

/** WRITE: create a rule. `updates.category_id` must already be a resolved category node id. */
export async function createRule(
  conditions: RuleConditions,
  updates: RuleUpdates,
  applyToExisting = true,
): Promise<RuleWriteResult> {
  const operation = updatesToInput(updates);
  const before = new Set((await listRules()).map((r) => r.id));
  const { count, floor, after } = await previewAndSave(conditions, {}, operation, applyToExisting);
  const created = after.filter((r) => !before.has(r.id));
  return {
    rule: created.length === 1 ? created[0] : null,
    existingTransactionsUpdated: applyToExisting ? count : 0,
    dateFloorAdded: floor,
  };
}

/**
 * WRITE: change a rule. Omitted fields keep their stored values; null clears
 * one. Saving re-applies the rule to every transaction it matches, so with
 * applyToExisting=false a rule that already matches anything is refused
 * outright rather than narrowed: what RM does to transactions a rule changed
 * before its match set shrank is not something we have verified.
 */
export async function updateRule(
  ruleId: string,
  conditions: RuleConditions | undefined,
  updates: RuleUpdates | undefined,
  applyToExisting = true,
): Promise<RuleWriteResult> {
  const before = await listRules();
  const rule = before.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`No transaction rule with id "${ruleId}". Use list_rules to see rule ids.`);
  if (!applyToExisting && rule.matchedCount > 0) {
    throw new Error(
      `Not saved: rule ${ruleId} already matches ${rule.matchedCount} transaction(s), and Rocket Money re-applies a ` +
        "rule to all of its matches whenever it is saved. Pass apply_to_existing=true to accept that, or " +
        "delete_rule and create_rule a replacement with apply_to_existing=false.",
    );
  }
  const operation = updatesToInput(mergePatch(ruleUpdates(rule), updates));
  // Unchanged conditions are resent exactly as stored, unless the floor has to go on.
  const merged = conditions ? patchConditions(rule.conditions, conditions) : applyToExisting ? null : rule.conditions;
  const { count, floor, after } = await previewAndSave(merged, rule.matchRulesInput, operation, applyToExisting, ruleId);
  // RM saves an update as a replacement rule with a NEW id (observed
  // 2026-10-29: the old id disappears, the count stays the same).
  const known = new Set(before.map((r) => r.id));
  const replaced = after.filter((r) => !known.has(r.id));
  return {
    rule: replaced.length === 1 ? replaced[0] : (after.find((r) => r.id === ruleId) ?? null),
    existingTransactionsUpdated: applyToExisting ? count : 0,
    dateFloorAdded: floor,
  };
}

/** WRITE: delete a rule; undoChanges also reverts what it did to past transactions. */
export async function deleteRule(
  ruleId: string,
  undoChanges = false,
): Promise<{ deleted: RMRule; transactionsReverted: number }> {
  const rule = await getRule(ruleId);
  await destroyRule(ruleId, !undoChanges);
  return { deleted: rule, transactionsReverted: undoChanges ? rule.matchedCount : 0 };
}
