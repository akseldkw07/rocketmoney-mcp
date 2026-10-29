// Transaction rules: list, preview and write.
import { z } from "zod";
import { COMPACT, DESTRUCTIVE, READ, WRITE, YMD, tool } from "./common.js";
import * as rm from "../rm/client.js";
import * as rules from "../rm/rules.js";
import { shapeTxns } from "../rm/rows.js";
// ── Transaction rules: shared input schemas and output shapes ───────
const ruleConditionsSchema = z
    .object({
    name_contains: z.string().nullable().optional().describe("Transaction name contains this text (case-insensitive)"),
    name_equals: z.string().nullable().optional().describe("Transaction name is exactly this. Use instead of name_contains, not with it"),
    amount: z.number().nonnegative().nullable().optional().describe("Amount equals this, in USD (compared as an absolute value unless amount_type is set)"),
    amount_min: z.number().nonnegative().nullable().optional().describe("Amount at least this, in USD. Alone (no amount_max) it means strictly greater than"),
    amount_max: z.number().nonnegative().nullable().optional().describe("Amount at most this, in USD. Alone (no amount_min) it means strictly less than"),
    amount_type: z
        .enum(["any", "debit", "credit"])
        .nullable()
        .optional()
        .describe("debit = money out (charges), credit = money in. Default any. Needs an amount condition"),
    account_ids: z.array(z.string()).nullable().optional().describe("Only transactions on any of these accounts (account node ids from list_accounts)"),
    date_from: z.string().regex(YMD).nullable().optional().describe("Posted on/after this date, YYYY-MM-DD"),
    date_to: z.string().regex(YMD).nullable().optional().describe("Posted on/before this date, YYYY-MM-DD"),
    merchant_id: z.string().nullable().optional().describe("Rocket Money merchant (service) id, as list_rules shows for merchant-based rules"),
})
    .describe("Match conditions; every condition given must hold (AND)");
const ruleUpdatesSchema = z
    .object({
    category: z.string().nullable().optional().describe("Set the category: a label like 'Groceries', a numeric id, or a category node id (see list_categories)"),
    rename: z.string().nullable().optional().describe("Rename matching transactions to this display name"),
    ignore: z
        .enum(["none", "budget", "everything"])
        .nullable()
        .optional()
        .describe("Ignore matches from the budget only, or from everything (all spending/charts); none = don't ignore"),
    tax_deductible: z.boolean().nullable().optional().describe("Mark matches tax deductible (true only; false/null means no change)"),
})
    .describe("What the rule does to matching transactions");
/** Tool-level updates -> rules.ts updates, resolving the category the way set_transaction_category does. */
async function resolveRuleUpdates(u) {
    if (!u)
        return undefined;
    const { category, ...rest } = u;
    const out = { ...rest };
    if (category === null)
        out.category_id = null;
    else if (category !== undefined)
        out.category_id = await rm.resolveCategoryNodeId(category);
    return out;
}
function shapeRule(r) {
    return {
        id: r.id,
        matchedCount: r.matchedCount,
        conditions: r.conditions,
        accounts: r.accounts,
        merchant: r.merchant,
        updates: {
            category: r.updates.category_label ?? null,
            categoryId: r.updates.category_id ?? null,
            rename: r.updates.rename ?? null,
            ignore: r.updates.ignore ?? null,
            taxDeductible: r.updates.tax_deductible ?? false,
            subscription: r.updates.subscription_name ?? null,
        },
        summary: r.updateTitles,
    };
}
const RULE_PRECEDENCE = "Rule precedence (measured 2026-10-29 over 8 observations; Rocket Money has no priority or order field): when several rules set the same field on one transaction, which one wins is NOT predictable from the rules - not by save order, creation order, id, or specificity. Saving any rule can re-apply every overlapping rule to the shared transactions, in an order the API doesn't expose: a newly created rule lost to older ones, two rules created back to back finished in reverse order, and updating a rule (which Rocket Money does as delete + create) handed the win to an older overlapping rule. What held in every observation: the effective rule is the LAST id in the transaction's applied_rule_ids, so read that after saving instead of assuming. To get a deterministic result, don't let two rules set the same field on the same transaction: make the conditions mutually exclusive (e.g. split by account, amount range or exact name), or have the broad rule set a different field than the specific one. Hand edits do NOT stick against rules (verified 2026-10-29): a category set by hand on a transaction was overwritten the next time a matching rule that sets category was saved, even re-saved unchanged - and saving any overlapping rule can re-apply the others. A rule that sets a different field (e.g. only rename) leaves a hand-set category alone. So fix an exception by hand only when no rule that sets that field matches it, or narrow the rule so it doesn't. delete_rule with undo_changes resets the fields that rule set to their original bank values even when another matching rule also sets them; re-save the other rule afterwards (update_rule with no changes).";
const RULE_LIMITS = "Not supported by Rocket Money's rule API: tags, OR between conditions, more than one name condition, name regex/starts-with, and matching on category.";
export function registerRulesTools(server, writes) {
    server.registerTool("list_rules", {
        title: "List transaction rules",
        description: "Every transaction rule (Rocket Money's 'Edit Rule'): its id, match conditions, the updates it applies (category, rename, ignore, tax deductible), and how many transactions it currently matches. Amounts in USD; dates YYYY-MM-DD. " +
            RULE_PRECEDENCE,
        inputSchema: {},
        annotations: READ,
    }, tool(async () => {
        const all = await rules.listRules();
        return { count: all.length, rules: all.map(shapeRule) };
    }));
    server.registerTool("get_rule", {
        title: "Get transaction rule",
        description: "One transaction rule in full plus a sample of the transactions it matches (newest first, with transaction ids). Pass the rule id from list_rules.",
        inputSchema: {
            rule_id: z.string().describe("The rule id (the `id` from list_rules)"),
            sample_size: z.number().int().min(1).max(2000).optional().describe("Matched transactions to return, newest first (default 20, max 2000)"),
            compact: COMPACT,
        },
        annotations: READ,
    }, tool(async ({ rule_id, sample_size, compact }) => {
        const rule = await rules.getRule(rule_id);
        const { count, sample } = await rules.previewMatches(rule.matchRulesInput, sample_size ?? 20);
        return { ...shapeRule(rule), matchedNow: count, sample: await shapeTxns(sample, compact) };
    }));
    server.registerTool("preview_rule", {
        title: "Preview a transaction rule",
        description: "Dry run: how many existing transactions a set of match conditions would match, plus a sample (newest first, with ids). Saves nothing. Use it before create_rule/update_rule. " +
            RULE_LIMITS,
        inputSchema: {
            conditions: ruleConditionsSchema,
            sample_size: z.number().int().min(1).max(2000).optional().describe("Matched transactions to return, newest first (default 20, max 2000)"),
            compact: COMPACT,
        },
        annotations: READ,
    }, tool(async ({ conditions, sample_size, compact }) => {
        const { count, sample } = await rules.previewMatches(rules.conditionsToInput(conditions), sample_size ?? 20);
        return { matchedCount: count, sample: await shapeTxns(sample, compact) };
    }));
    if (!writes)
        return;
    const APPLY_TO_EXISTING = "Rocket Money has no 'future transactions only' switch: saving a rule always applies it to every transaction it matches at that moment. " +
        "So with apply_to_existing=false the rule gets a date_from of tomorrow, so it matches nothing that has already posted, and the save is refused if a preview still finds a match. " +
        "With apply_to_existing=true (the default) there is no floor, and the response's existingTransactionsUpdated is how many transactions Rocket Money applied the updates to - including ones whose matching fields were edited by hand, which it overwrites.";
    server.registerTool("create_rule", {
        title: "Create a transaction rule",
        description: "WRITES to Rocket Money: create a transaction rule that applies `updates` to transactions matching `conditions`. Run preview_rule first. " +
            APPLY_TO_EXISTING +
            " `updates.category` is validated against list_categories. " +
            RULE_PRECEDENCE +
            " " +
            RULE_LIMITS,
        inputSchema: {
            conditions: ruleConditionsSchema,
            updates: ruleUpdatesSchema,
            apply_to_existing: z
                .boolean()
                .optional()
                .describe("Also update transactions that already match (default true; false = only transactions that post from tomorrow on)"),
        },
        annotations: WRITE,
    }, tool(async ({ conditions, updates, apply_to_existing, }) => {
        const r = await rules.createRule(conditions, (await resolveRuleUpdates(updates)), apply_to_existing ?? true);
        return {
            rule: r.rule ? shapeRule(r.rule) : null,
            existingTransactionsUpdated: r.existingTransactionsUpdated,
            dateFloorAdded: r.dateFloorAdded,
            ok: true,
        };
    }));
    server.registerTool("update_rule", {
        title: "Update a transaction rule",
        description: "WRITES to Rocket Money: change a rule's conditions and/or updates. Rocket Money saves the change as a replacement rule with a NEW id; the response's rule.id is the one to use afterwards. Only the fields you pass change; pass null to clear one (setting name_contains clears name_equals and vice versa; likewise amount vs amount_min/amount_max). " +
            "Saving re-applies the rule to everything it matches, so with apply_to_existing=false a rule that already matches any transaction is refused rather than saved. To change such a rule without touching past transactions, delete_rule (keeping its changes) and create_rule a replacement. " +
            APPLY_TO_EXISTING +
            " " +
            RULE_PRECEDENCE +
            " " +
            RULE_LIMITS,
        inputSchema: {
            rule_id: z.string().describe("The rule id (the `id` from list_rules)"),
            conditions: ruleConditionsSchema.optional(),
            updates: ruleUpdatesSchema.optional(),
            apply_to_existing: z
                .boolean()
                .optional()
                .describe("Also update transactions that already match (default true)"),
        },
        annotations: WRITE,
    }, tool(async ({ rule_id, conditions, updates, apply_to_existing, }) => {
        const r = await rules.updateRule(rule_id, conditions, await resolveRuleUpdates(updates), apply_to_existing ?? true);
        return {
            rule: r.rule ? shapeRule(r.rule) : null,
            existingTransactionsUpdated: r.existingTransactionsUpdated,
            dateFloorAdded: r.dateFloorAdded,
            ok: true,
        };
    }));
    server.registerTool("delete_rule", {
        title: "Delete a transaction rule",
        description: "WRITES to Rocket Money: delete a transaction rule so it stops applying to future transactions. By default the changes it already made stay in place; undo_changes=true also reverts them on every transaction it matched (the web app's 'Undo Changes') - back to the bank's original values, which also discards hand edits made to those fields (verified 2026-10-29: a hand-set category went back to the bank's), and ignores other matching rules that set the same field, so re-save those afterwards (update_rule with no changes).",
        inputSchema: {
            rule_id: z.string().describe("The rule id (the `id` from list_rules)"),
            undo_changes: z
                .boolean()
                .optional()
                .describe("Also revert what the rule changed on past transactions (default false)"),
        },
        annotations: DESTRUCTIVE,
    }, tool(async ({ rule_id, undo_changes }) => {
        const r = await rules.deleteRule(rule_id, undo_changes ?? false);
        return { deleted: shapeRule(r.deleted), transactionsReverted: r.transactionsReverted, ok: true };
    }));
}
