import { rmFullText, toRMTransaction } from "./client.js";
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
          node {
            id
            date
            posted_date
            amount
            shortName
            longName(prependCustomName: false)
            custom_name
            note
            category { id label __typename }
            account { id __typename }
            ignoredFrom
            transactionRuleNodeIds
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;
const SAVE_RULE = `mutation SaveTransactionRuleMutation($input: SaveTransactionRuleInput!) {
  saveTransactionRule(input: $input) {
    clientMutationId
    __typename
  }
}`;
const DESTROY_RULE = `mutation DestroyTransactionRule($input: DestroyTransactionRuleInput!) {
  destroyTransactionRule(input: $input) {
    clientMutationId
    __typename
  }
}`;
const toCents = (usd) => Math.round(usd * 100);
const fromCents = (v) => (typeof v === "number" ? v / 100 : null);
const dateToIso = (ymd) => `${ymd}T00:00:00.000Z`;
const isoToDate = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const present = (v) => v !== null && v !== undefined && v !== "";
const YMD = /^\d{4}-\d{2}-\d{2}$/;
/** Stands in for an open start date; earlier than any Rocket Money transaction. */
export const EARLIEST_DATE = "2000-01-01";
/**
 * Caller conditions -> MatchRulesV1Input, following the web client's encoding:
 * exact amount = inclusive [x, x]; min+max = inclusive range; min only =
 * "greater than" (exclusive, max "Infinity"); max only = "less than"
 * (exclusive, min "-Infinity").
 */
export function conditionsToInput(c) {
    const out = {};
    if (present(c.name_contains) && present(c.name_equals)) {
        throw new Error("Use name_contains or name_equals, not both.");
    }
    if (present(c.name_contains))
        out.transactionNameContains = c.name_contains.trim();
    if (present(c.name_equals))
        out.transactionNameIs = c.name_equals.trim();
    if (present(c.merchant_id))
        out.serviceIdIs = c.merchant_id;
    if (c.account_ids?.length)
        out.accountIdIsIn = c.account_ids;
    if (present(c.amount) && (present(c.amount_min) || present(c.amount_max))) {
        throw new Error("Use amount (exact) or amount_min/amount_max (range), not both.");
    }
    let range = null;
    if (present(c.amount)) {
        const v = toCents(Math.abs(c.amount));
        range = { min: { value: v, inclusive: true }, max: { value: v, inclusive: true } };
    }
    else if (present(c.amount_min) && present(c.amount_max)) {
        if (c.amount_min > c.amount_max)
            throw new Error("amount_min is greater than amount_max.");
        range = {
            min: { value: toCents(c.amount_min), inclusive: true },
            max: { value: toCents(c.amount_max), inclusive: true },
        };
    }
    else if (present(c.amount_min)) {
        range = { min: { value: toCents(c.amount_min), inclusive: false }, max: { value: "Infinity", inclusive: false } };
    }
    else if (present(c.amount_max)) {
        range = { min: { value: "-Infinity", inclusive: false }, max: { value: toCents(c.amount_max), inclusive: false } };
    }
    if (range) {
        const type = c.amount_type ?? "any";
        if (type === "debit")
            out.amountDebitBetween = range;
        else if (type === "credit")
            out.amountCreditBetween = range;
        else
            out.absAmountBetween = range;
    }
    else if (present(c.amount_type) && c.amount_type !== "any") {
        throw new Error("amount_type needs an amount, amount_min or amount_max to apply to.");
    }
    for (const d of [c.date_from, c.date_to]) {
        if (present(d) && !YMD.test(d))
            throw new Error(`Dates must be YYYY-MM-DD, got "${d}".`);
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
    if (Object.keys(out).length === 0)
        throw new Error("A rule needs at least one match condition.");
    return out;
}
function rangeToConditions(r, type, c) {
    if (!r)
        return;
    const min = fromCents(r.min.value);
    const max = fromCents(r.max.value);
    if (min !== null && max !== null && min === max)
        c.amount = min;
    else {
        if (min !== null)
            c.amount_min = min;
        if (max !== null)
            c.amount_max = max;
    }
    c.amount_type = type;
}
/** The read-side v1 object -> the input shape, dropping nulls and display-only fields. */
function storedMatchRules(v1) {
    const out = {
        transactionNameIs: v1.transactionNameIs,
        transactionNameContains: v1.transactionNameContains,
        serviceIdIs: v1.service?.id,
        accountIdIsIn: Array.isArray(v1.accountIdIsIn) && v1.accountIdIsIn.length ? v1.accountIdIsIn : undefined,
        postedDateBetween: v1.postedDateBetween,
        absAmountBetween: v1.absAmountBetween,
        amountDebitBetween: v1.amountDebitBetween,
        amountCreditBetween: v1.amountCreditBetween,
    };
    for (const k of Object.keys(out))
        if (out[k] === null || out[k] === undefined)
            delete out[k];
    return out;
}
/** A rule node from TransactionRulesPage -> RMRule. */
export function parseRule(node) {
    const v1 = (node.matchRules?.v1 ?? {});
    const op = (node.operation ?? {});
    const c = {};
    if (present(v1.transactionNameContains))
        c.name_contains = v1.transactionNameContains;
    if (present(v1.transactionNameIs))
        c.name_equals = v1.transactionNameIs;
    const service = v1.service;
    if (service?.id)
        c.merchant_id = service.id;
    if (Array.isArray(v1.accountIdIsIn) && v1.accountIdIsIn.length)
        c.account_ids = v1.accountIdIsIn;
    rangeToConditions(v1.absAmountBetween, "any", c);
    rangeToConditions(v1.amountDebitBetween, "debit", c);
    rangeToConditions(v1.amountCreditBetween, "credit", c);
    const dates = v1.postedDateBetween;
    if (dates) {
        const from = isoToDate(dates.min.value);
        const to = isoToDate(dates.max.value);
        if (from && from !== EARLIEST_DATE)
            c.date_from = from;
        if (to)
            c.date_to = to;
    }
    const cat = op.transactionCategory?.transactionCategory;
    const sub = op.subscription?.subscription;
    const updates = {};
    if (cat?.id) {
        updates.category_id = cat.id;
        updates.category_label = cat.label ?? null;
    }
    if (present(op.customName?.value))
        updates.rename = op.customName.value;
    if (present(op.ignoredFrom?.value))
        updates.ignore = op.ignoredFrom.value;
    if (op.taxDeductible?.value === true)
        updates.tax_deductible = true;
    if (sub?.id) {
        updates.subscription_id = sub.id;
        updates.subscription_name = sub.custom_name ?? sub.service?.name ?? null;
    }
    return {
        id: String(node.id ?? ""),
        matchedCount: typeof node.numberMatchingTransactions === "number" ? node.numberMatchingTransactions : 0,
        conditions: c,
        accounts: (v1.accountsIn ?? []).map((a) => ({ id: a.id, name: a.name })),
        merchant: service?.id ? { id: service.id, name: service.name ?? "" } : null,
        updates,
        matchRulesInput: storedMatchRules(v1),
        updateTitles: Object.values(op)
            .map((o) => (o && typeof o === "object" ? o.title : undefined))
            .filter((t) => Boolean(t)),
    };
}
/** Caller updates -> the operation half of SaveTransactionRuleInput. */
export function updatesToInput(u) {
    const out = {};
    if (present(u.category_id))
        out.transactionCategoryId = u.category_id;
    if (present(u.rename))
        out.customName = u.rename.trim();
    if (u.ignore === "budget" || u.ignore === "everything")
        out.ignoredFrom = u.ignore;
    if (u.tax_deductible === true)
        out.taxDeductible = true;
    if (present(u.subscription_id))
        out.subscriptionId = u.subscription_id;
    if (Object.keys(out).length === 0) {
        throw new Error("A rule needs at least one update (category, rename, ignore or tax_deductible).");
    }
    return out;
}
/**
 * Overlay a patch on a base: keys the patch leaves undefined keep the base
 * value, keys it sets to null are cleared.
 */
export function mergePatch(base, patch) {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch ?? {})) {
        if (v === undefined)
            continue;
        if (v === null)
            delete out[k];
        else
            out[k] = v;
    }
    return out;
}
/** Start of tomorrow (UTC), YYYY-MM-DD: a date floor no existing transaction can meet. */
export function tomorrowYmd(now = new Date()) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString().slice(0, 10);
}
/**
 * Raise date_from to at least tomorrow so the rule matches only transactions
 * that haven't posted yet. Throws when date_to would leave the rule matching
 * nothing ever.
 */
export function withFutureFloor(c, now = new Date()) {
    const floor = tomorrowYmd(now);
    if (present(c.date_to) && c.date_to < floor) {
        throw new Error(`date_to ${c.date_to} is in the past, so with apply_to_existing=false the rule could never match anything. ` +
            "Drop date_to or pass apply_to_existing=true.");
    }
    if (present(c.date_from) && c.date_from >= floor)
        return c;
    return { ...c, date_from: floor };
}
// ── API calls ──────────────────────────────────────────────────────
export async function listRules() {
    const rules = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
        const data = await rmFullText("TransactionRulesPage", RULES_PAGE, { first: 100, cursor });
        const conn = data.viewer?.transactionRules;
        for (const e of conn?.edges ?? [])
            rules.push(parseRule(e.node));
        if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor)
            break;
        cursor = conn.pageInfo.endCursor;
    }
    liveIdCache = { at: Date.now(), ids: new Set(rules.map((r) => r.id)) };
    return rules;
}
// Live rule ids, so transaction rows can tell a rule that still exists from one
// RM keeps in a transaction's history after it was deleted. Short-lived: rules
// change only through the tools here (which clear it) or the web app.
let liveIdCache = null;
const LIVE_ID_TTL_MS = 60_000;
export async function liveRuleIds() {
    if (liveIdCache && Date.now() - liveIdCache.at < LIVE_ID_TTL_MS)
        return liveIdCache.ids;
    await listRules();
    return liveIdCache.ids;
}
export async function getRule(ruleId) {
    const rule = (await listRules()).find((r) => r.id === ruleId);
    if (!rule)
        throw new Error(`No transaction rule with id "${ruleId}". Use list_rules to see rule ids.`);
    return rule;
}
/** Dry run: how many transactions a set of conditions matches, plus the newest `first`. */
export async function previewMatches(matchRules, first = 20) {
    const data = await rmFullText("TransactionRulesSearch", RULES_SEARCH, { matchRules: { v1: matchRules }, first });
    const rt = data.viewer?.ruleTransactions;
    return {
        count: rt?.numMatchingTransactions ?? 0,
        sample: (rt?.transactions?.edges ?? [])
            .map(({ node }) => toRMTransaction(node))
            .filter((t) => t !== null),
    };
}
/** WRITE: create (no ruleId) or replace (ruleId) a rule. RM applies it to every current match. */
export async function saveRule(matchRules, operation, ruleId) {
    liveIdCache = null;
    await rmFullText("SaveTransactionRuleMutation", SAVE_RULE, {
        input: { matchRules: { v1: matchRules }, ...operation, ...(ruleId ? { id: ruleId } : {}) },
    });
}
/** WRITE: delete a rule. keepChanges=false also reverts what it changed on past transactions. */
export async function destroyRule(ruleId, keepChanges) {
    liveIdCache = null;
    await rmFullText("DestroyTransactionRule", DESTROY_RULE, {
        input: { ruleId, keepRuleChanges: keepChanges },
    });
}
/** A rule's updates in input vocabulary (display-only labels dropped). */
export function ruleUpdates(rule) {
    const { category_label: _l, subscription_name: _s, ...updates } = rule.updates;
    return updates;
}
/** Name and amount conditions come in exclusive pairs; setting one side clears the other. */
export function patchConditions(base, patch) {
    const p = { ...patch };
    if (present(p.name_contains))
        p.name_equals ??= null;
    if (present(p.name_equals))
        p.name_contains ??= null;
    if (present(p.amount)) {
        p.amount_min ??= null;
        p.amount_max ??= null;
    }
    if (present(p.amount_min) || present(p.amount_max))
        p.amount ??= null;
    return mergePatch(base, p);
}
/**
 * Preview then save. With applyToExisting=false the conditions get a future
 * date floor and the save is refused unless the preview matches 0 existing
 * transactions, so nothing already posted can be touched.
 */
async function previewAndSave(conditions, storedInput, operation, applyToExisting, ruleId) {
    let input = storedInput;
    let floor = null;
    if (conditions) {
        const c = applyToExisting ? conditions : withFutureFloor(conditions);
        if (c.date_from !== conditions.date_from)
            floor = c.date_from ?? null;
        input = conditionsToInput(c);
    }
    const { count } = await previewMatches(input, 1);
    if (!applyToExisting && count > 0) {
        throw new Error(`Not saved: these conditions match ${count} existing transaction(s), and Rocket Money applies a rule to ` +
            "every transaction it matches when it is saved. Pass apply_to_existing=true to update them.");
    }
    await saveRule(input, operation, ruleId);
    return { count, floor };
}
/** WRITE: create a rule. `updates.category_id` must already be a resolved category node id. */
export async function createRule(conditions, updates, applyToExisting = true) {
    const operation = updatesToInput(updates);
    const before = new Set((await listRules()).map((r) => r.id));
    const { count, floor } = await previewAndSave(conditions, {}, operation, applyToExisting);
    const created = (await listRules()).filter((r) => !before.has(r.id));
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
export async function updateRule(ruleId, conditions, updates, applyToExisting = true) {
    const before = await listRules();
    const rule = before.find((r) => r.id === ruleId);
    if (!rule)
        throw new Error(`No transaction rule with id "${ruleId}". Use list_rules to see rule ids.`);
    if (!applyToExisting && rule.matchedCount > 0) {
        throw new Error(`Not saved: rule ${ruleId} already matches ${rule.matchedCount} transaction(s), and Rocket Money re-applies a ` +
            "rule to all of its matches whenever it is saved. Pass apply_to_existing=true to accept that, or " +
            "delete_rule and create_rule a replacement with apply_to_existing=false.");
    }
    const operation = updatesToInput(mergePatch(ruleUpdates(rule), updates));
    // Unchanged conditions are resent exactly as stored, unless the floor has to go on.
    const merged = conditions ? patchConditions(rule.conditions, conditions) : applyToExisting ? null : rule.conditions;
    const { count, floor } = await previewAndSave(merged, rule.matchRulesInput, operation, applyToExisting, ruleId);
    // RM saves an update as a replacement rule with a NEW id (observed
    // 2026-10-29: the old id disappears, the count stays the same).
    const known = new Set(before.map((r) => r.id));
    const after = await listRules();
    const replaced = after.filter((r) => !known.has(r.id));
    return {
        rule: replaced.length === 1 ? replaced[0] : (after.find((r) => r.id === ruleId) ?? null),
        existingTransactionsUpdated: applyToExisting ? count : 0,
        dateFloorAdded: floor,
    };
}
/** WRITE: delete a rule; undoChanges also reverts what it did to past transactions. */
export async function deleteRule(ruleId, undoChanges = false) {
    const rule = await getRule(ruleId);
    await destroyRule(ruleId, !undoChanges);
    return { deleted: rule, transactionsReverted: undoChanges ? rule.matchedCount : 0 };
}
