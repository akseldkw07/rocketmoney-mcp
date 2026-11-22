// Transaction search, per-transaction writes (note, category, ignore, date) and
// manual transactions (create, delete).
import { z } from "zod";
import { COMPACT, DESTRUCTIVE, READ, WRITE, YMD, batchOutcome, perItemOutcome, tool } from "./common.js";
import * as rm from "../rm/client.js";
import { shapeTxns } from "../rm/rows.js";
import { addDaysYmd, monthWindows } from "../rm/windows.js";
const ROW_FIELDS = "Each row has id, date (the current, possibly hand-changed date), amount, name, category and account. Fields are left out when empty: original_date (the date the bank posted it) appears only when it differs from date; ignore (budget = left out of budgets, everything = left out of all spending) only when the row is ignored; custom_name (a rename, by hand or by rule), note, applied_rule_ids (live rules that have applied to it; when several set the same field, the last id has been the effective one) and deleted_rule_ids (rules that applied before being deleted - Rocket Money keeps them in the row's history). Pass compact=true for bulk reads: a table about a third the size.";
export function registerTransactionsTools(server, writes) {
    server.registerTool("search_transactions", {
        title: "Search transactions",
        description: "Search transactions by merchant/description text, date window, account and/or category. All filters optional; omit everything to list recent transactions. Newest first, amounts in USD. Returns up to `limit` rows (default 1200); when more match, next_cursor is set - pass it back as `cursor` to continue. " +
            ROW_FIELDS +
            " Filtering server-side (account_ids, category_ids, since/until) is far cheaper than pulling everything and discarding.",
        inputSchema: {
            query: z.string().optional().describe("Merchant or description text, e.g. 'Amazon'"),
            since: z.string().regex(YMD).optional().describe("Only transactions on/after this date (YYYY-MM-DD)"),
            until: z.string().regex(YMD).optional().describe("Only transactions on/before this date (YYYY-MM-DD)"),
            date_field: z
                .enum(["date", "original_date"])
                .optional()
                .describe("Which date since/until apply to (default date). original_date is filtered here rather than by Rocket Money, which only filters on date: it finds transactions moved LATER than their posted date, but misses any moved to before `since`"),
            account_ids: z
                .array(z.string())
                .optional()
                .describe("Only these accounts. Account node ids from list_accounts; omit for all accounts"),
            category_ids: z
                .array(z.string())
                .optional()
                .describe("Only these categories: labels, numeric ids or category node ids (see list_categories)"),
            limit: z.number().int().min(1).max(10000).optional().describe("Max rows to return (default 1200)"),
            cursor: z.string().optional().describe("next_cursor from a previous call, to fetch the next rows"),
            compact: COMPACT,
        },
        annotations: READ,
    }, tool(async (args) => {
        const byOriginal = args.date_field === "original_date";
        const categoryIds = await Promise.all((args.category_ids ?? []).map((c) => rm.resolveCategoryNodeId(c)));
        const page = await rm.searchTransactionsPage({
            query: args.query ?? null,
            gteDate: args.since ?? null,
            // ltDate is exclusive. By original_date there is no server upper bound:
            // a transaction posted in the window may have been moved later.
            ltDate: !byOriginal && args.until ? addDaysYmd(args.until, 1) : null,
            accountIds: args.account_ids ?? [],
            categoryIds,
            cursor: args.cursor ?? null,
            limit: args.limit ?? 1200,
        });
        const txns = byOriginal
            ? page.transactions.filter((t) => (!args.since || t.originalDate >= args.since) && (!args.until || t.originalDate <= args.until))
            : page.transactions;
        return { count: txns.length, next_cursor: page.nextCursor, ...(await shapeTxns(txns, args.compact)) };
    }));
    server.registerTool("category_transactions", {
        title: "Transactions in a category",
        description: "List the transactions in one category, this month by default. Pass the category as a label, numeric id or node id (see list_categories). " +
            ROW_FIELDS,
        inputSchema: {
            category_id: z.string().describe("The category: a label like 'Groceries', a numeric id, or a TransactionCategory node id"),
            since: z.string().regex(YMD).optional().describe("On/after this date (YYYY-MM-DD); default the 1st of this month"),
            until: z.string().regex(YMD).optional().describe("On/before this date (YYYY-MM-DD); default today and later"),
            compact: COMPACT,
        },
        annotations: READ,
    }, tool(async ({ category_id, since, until, compact }) => {
        const page = await rm.searchTransactionsPage({
            categoryIds: [await rm.resolveCategoryNodeId(category_id)],
            gteDate: since ?? monthWindows().currentMonthStart,
            ltDate: until ? addDaysYmd(until, 1) : null,
            limit: 2000,
        });
        return { count: page.transactions.length, ...(await shapeTxns(page.transactions, compact)) };
    }));
    if (!writes)
        return;
    server.registerTool("set_transaction_note", {
        title: "Set transaction note",
        description: "WRITES to Rocket Money: set (or clear) the free-text note on one transaction. Pass the transaction id from search_transactions/category_transactions. Use an empty string to clear the note. Returns the saved note.",
        inputSchema: {
            transaction_id: z.string().describe("The transaction node id (the `id` from search_transactions)"),
            note: z.string().describe("The note text to save. Pass an empty string to clear it."),
        },
        annotations: WRITE,
    }, tool(async ({ transaction_id, note }) => {
        const [r] = await rm.setTransactionsNote([{ nodeId: transaction_id, note }]);
        if (r.error)
            throw new Error(r.error);
        return { transaction_id, note: r.note, ok: true };
    }));
    server.registerTool("set_transaction_notes", {
        title: "Set notes on many transactions",
        description: "WRITES to Rocket Money: set (or clear, with an empty string) notes on a batch of transactions in one call - either one `note` for every id in `transaction_ids`, or a different note per transaction in `notes`. Sent 50 per request. Returns each saved note, or an error for that id.",
        inputSchema: {
            transaction_ids: z.array(z.string()).optional().describe("Transaction node ids that all get `note`"),
            note: z.string().optional().describe("The note for every id in transaction_ids (empty string clears)"),
            notes: z
                .array(z.object({ transaction_id: z.string(), note: z.string() }))
                .optional()
                .describe("Per-transaction notes, instead of transaction_ids + note"),
        },
        annotations: WRITE,
    }, tool(async (a) => {
        const items = [
            ...(a.notes ?? []).map((n) => ({ nodeId: n.transaction_id, note: n.note })),
            ...(a.transaction_ids ?? []).map((id) => ({ nodeId: id, note: a.note ?? "" })),
        ];
        if (a.transaction_ids?.length && a.note === undefined)
            throw new Error("transaction_ids needs a `note`.");
        if (!items.length)
            throw new Error("Pass transaction_ids + note, or notes.");
        return perItemOutcome(await rm.setTransactionsNote(items));
    }));
    server.registerTool("set_transaction_category", {
        title: "Set transaction category",
        description: "WRITES to Rocket Money: recategorize one transaction. `category` accepts a category label (e.g. \"Groceries\"), a numeric category id, or a category node id - call list_categories first to see valid options. Set apply_to_all=true to also sweep the merchant's other transactions (matched by descriptor). To recategorize a specific known set of transactions, prefer set_transactions_category - it is one round trip instead of N.",
        inputSchema: {
            transaction_id: z.string().describe("The transaction node id (the `id` from search_transactions)"),
            category: z
                .string()
                .describe("Target category: a label like 'Groceries', a numeric id, or a category node id"),
            apply_to_all: z
                .boolean()
                .optional()
                .describe("Also recategorize all related transactions from the same merchant (default false)"),
        },
        annotations: WRITE,
    }, tool(async ({ transaction_id, category, apply_to_all, }) => {
        const catNodeId = await rm.resolveCategoryNodeId(category);
        const updated = await rm.setTransactionCategory(transaction_id, catNodeId, apply_to_all ?? false);
        return { transaction_id, category, categoryNodeId: catNodeId, updatedCount: updated, ok: true };
    }));
    server.registerTool("set_transactions_category", {
        title: "Set category on many transactions",
        description: "WRITES to Rocket Money: recategorize a batch of transactions in one call. Pass the transaction node ids (the `id` from search_transactions) and a category label, numeric id, or category node id. Returns updatedCount as reported by Rocket Money - compare it against the number of ids you sent rather than trusting ok:true.",
        inputSchema: {
            transaction_ids: z
                .array(z.string())
                .min(1)
                .describe("Transaction node ids to recategorize (the `id` values from search_transactions)"),
            category: z
                .string()
                .describe("Target category: a label like 'Groceries', a numeric id, or a category node id"),
        },
        annotations: WRITE,
    }, tool(async ({ transaction_ids, category }) => {
        const catNodeId = await rm.resolveCategoryNodeId(category);
        const { valid, invalid } = rm.partitionTransactionIds(transaction_ids);
        const updated = await rm.setTransactionsCategory(valid, catNodeId);
        return batchOutcome(transaction_ids.length, updated, {
            category,
            categoryNodeId: catNodeId,
            ...(invalid.length ? { invalid } : {}),
        });
    }));
    server.registerTool("set_transaction_ignore", {
        title: "Ignore transactions",
        description: "WRITES to Rocket Money: set the ignore state on a batch of transactions in one call, without a rule. none = counted normally; budget = left out of budgets; everything = left out of all spending and charts (e.g. transfers between your own accounts). Pass the transaction ids from search_transactions. Returns updatedCount as reported by Rocket Money.",
        inputSchema: {
            transaction_ids: z.array(z.string()).min(1).describe("Transaction node ids (the `id` from search_transactions)"),
            ignore: z.enum(["none", "budget", "everything"]).describe("The ignore state to set"),
        },
        annotations: WRITE,
    }, tool(async ({ transaction_ids, ignore }) => {
        const { valid, invalid } = rm.partitionTransactionIds(transaction_ids);
        const updated = await rm.setTransactionsIgnored(valid, ignore === "none" ? null : ignore);
        return batchOutcome(transaction_ids.length, updated, { ignore, ...(invalid.length ? { invalid } : {}) });
    }));
    server.registerTool("set_transaction_date", {
        title: "Change transaction dates",
        description: "WRITES to Rocket Money: change the date of one or more transactions, e.g. to date a trip purchase to when the trip happens. Pass date as YYYY-MM-DD, or \"original\" to reset each transaction to the date its bank posted it. Rocket Money keeps the posted date as original_date through any number of changes. Its API changes one transaction per call, so a batch is sent one at a time; each result reports the saved date and original_date, or an error for that id.",
        inputSchema: {
            transaction_ids: z.array(z.string()).min(1).max(200).describe("Transaction node ids (the `id` from search_transactions)"),
            date: z
                .string()
                .regex(/^(\d{4}-\d{2}-\d{2}|original)$/)
                .describe("New date YYYY-MM-DD, or 'original' to reset to the posted date"),
        },
        annotations: WRITE,
    }, tool(async ({ transaction_ids, date }) => {
        const results = await rm.setTransactionsDate(transaction_ids, date);
        return perItemOutcome(results.map((r) => ({ id: r.id, date: r.date || null, original_date: r.originalDate || null, ...(r.error ? { error: r.error } : {}) })));
    }));
    const manualItem = {
        name: z.string().min(1).describe("Merchant or description, e.g. 'Patrizia'"),
        date: z.string().regex(YMD).describe("YYYY-MM-DD; any past date works (tested back to 2021)"),
        amount: z
            .number()
            .describe("USD, signed as search_transactions reports amounts: positive = spend, negative = income (refund, cash received)"),
        category: z.string().optional().describe("A category label, numeric id or category node id (see list_categories); omit for none"),
        account_id: z
            .string()
            .optional()
            .describe("Account node id (list_accounts, or a transaction's account). Omit to use Rocket Money's manual 'Cash' account. Can't be changed later"),
        note: z.string().optional().describe("A note saved on the new row"),
        ignore: z.enum(["budget", "everything"]).optional().describe("Leave it out of budgets (budget) or out of all spending (everything); omit to count it"),
        tax_deductible: z.boolean().optional().describe("Mark it tax deductible"),
    };
    server.registerTool("create_transaction", {
        title: "Create manual transactions",
        description: "WRITES to Rocket Money: add transactions by hand, for spending that never synced (cash, an unlinked or closed card). Pass one transaction's fields, or a batch in `transactions`. They count in spending and budgets like any other row. " +
            "Settable: name, date, amount (its sign sets spend vs income), category and account in the create itself; note, ignore and tax_deductible right after it, as separate requests (if one of those fails the row still exists, and `not_applied` names the field with Rocket Money's error). " +
            "Not settable, and why: splits (a separate multi-row operation, not built yet; split it in the phone app); the amount, direction or account after creation (Rocket Money has no mutation that edits them: delete_transaction and create again); merchant logo, subscription link and pending status (derived from bank data, no input for them). Date, category, note, ignore and tax deductible can still be changed later with the usual tools. " +
            "Each item is first checked against existing rows with the same date, amount and name, and that row's id is returned (duplicate: true) instead of creating a second one, unless allow_duplicate. Sent one at a time and never retried: an error saying the request failed in transit means it may have been created, so search before resending. " +
            "A single transaction that fails returns an error with Rocket Money's full response; a batch returns the new id, or an error plus `detail` (error type, GraphQL errors, stack), per item. delete_transaction undoes one.",
        inputSchema: {
            ...Object.fromEntries(Object.entries(manualItem).map(([k, v]) => [k, v.optional()])),
            transactions: z.array(z.object(manualItem)).min(1).max(200).optional().describe("A batch, instead of the single-transaction fields"),
            allow_duplicate: z.boolean().optional().describe("Create even when a row with the same date, amount and name exists (default false)"),
        },
        annotations: WRITE,
    }, tool(async (a) => {
        const single = a.name !== undefined || a.date !== undefined || a.amount !== undefined;
        if (single && a.transactions)
            throw new Error("Pass either one transaction's fields or `transactions`, not both.");
        if (single && (a.name === undefined || a.date === undefined || a.amount === undefined)) {
            throw new Error("A single transaction needs name, date and amount.");
        }
        const items = a.transactions ?? (single ? [a] : []);
        if (!items.length)
            throw new Error("Pass name, date and amount, or `transactions`.");
        const resolved = new Map();
        const categoryOf = (c) => {
            if (!resolved.has(c))
                resolved.set(c, rm.resolveCategoryNodeId(c));
            return resolved.get(c);
        };
        const ready = [];
        const badCategory = new Map();
        for (const [i, t] of items.entries()) {
            let categoryNodeId;
            if (t.category) {
                try {
                    categoryNodeId = await categoryOf(t.category);
                }
                catch (err) {
                    // One transaction: let the error surface as is.
                    if (single)
                        throw err;
                    badCategory.set(i, err);
                }
            }
            ready.push({
                name: t.name,
                date: t.date,
                amount: t.amount,
                categoryNodeId,
                accountNodeId: t.account_id,
                note: t.note,
                ignore: t.ignore,
                taxDeductible: t.tax_deductible,
            });
        }
        // Items with an unknown category are reported, not created.
        const sendable = ready.map((t, i) => ({ t, i })).filter((x) => !badCategory.has(x.i));
        const created = await rm.createManualTransactions(sendable.map((x) => x.t), { allowDuplicate: a.allow_duplicate });
        const results = items.map((_, i) => {
            const err = badCategory.get(i);
            return { index: i, error: `not created: ${err?.message}`, detail: rm.errorDetail(err) };
        });
        created.forEach((r, k) => (results[sendable[k].i] = { ...r, index: sendable[k].i }));
        if (single && results[0].error) {
            throw new Error(results[0].error, { cause: results[0].detail });
        }
        return perItemOutcome(results);
    }));
    server.registerTool("delete_transaction", {
        title: "Delete manual transactions",
        description: "WRITES to Rocket Money, irreversibly: delete transactions that were added by hand (create_transaction or the phone app's Add Transaction). Each id is checked first; a bank-synced transaction is refused and never sent. Returns deleted: true or an error per id.",
        inputSchema: {
            transaction_ids: z.array(z.string()).min(1).max(200).describe("Transaction node ids (the `id` from create_transaction or search_transactions)"),
        },
        annotations: DESTRUCTIVE,
    }, tool(async ({ transaction_ids }) => perItemOutcome(await rm.deleteManualTransactions(transaction_ids))));
}
