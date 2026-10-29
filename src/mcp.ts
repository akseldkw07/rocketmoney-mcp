import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RMAuthError } from "./rm/client.js";
import * as rm from "./rm/client.js";
import * as fmt from "./rm/format.js";
import * as rules from "./rm/rules.js";
import { shapeTxns } from "./rm/rows.js";
import { addDaysYmd, monthWindows } from "./rm/windows.js";
import { sessionStatus } from "./rm/session.js";

const AUTH_HINT =
  "Rocket Money session is not active. Open this server's /auth page and paste a fresh `tb.auth0.sid` cookie from a logged-in app.rocketmoney.com browser tab.";

/** With ROCKETMONEY_READ_ONLY=1 the write tools are never registered, so a client cannot reach them. */
export const READ_ONLY = /^(1|true|yes)$/i.test(process.env.ROCKETMONEY_READ_ONLY ?? "");

/**
 * Wrap a tool body so RMAuthError becomes a clean, actionable MCP error.
 * Results are compact JSON: indenting added ~30-40% to every response, which on
 * a 1,200-row search is hundreds of KB the client has to carry.
 */
function tool<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      const result = await fn(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      const msg = err instanceof RMAuthError ? `${AUTH_HINT}\n\n(${err.message})` : String(err);
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  };
}

const READ = { readOnlyHint: true, openWorldHint: true } as const;

/**
 * The result every batch write returns: how many of the requested items
 * Rocket Money reports updated, plus per-item results when it gives them.
 * `ok` means all of them - compare counts rather than trusting a bare success.
 */
function batchOutcome(requested: number, updated: number, extra: Record<string, unknown> = {}) {
  return { requested, updatedCount: updated, ...extra, ok: updated === requested };
}

/** batchOutcome for per-item results, where an item with an `error` failed. */
function perItemOutcome<R extends { error?: string }>(results: R[], extra: Record<string, unknown> = {}) {
  return batchOutcome(results.length, results.filter((r) => !r.error).length, { ...extra, results });
}

/**
 * One category, the same shape from list_categories and the category write
 * tools: `kind` is default|custom, `type` is expense|income|ignored (RM calls
 * income "earning").
 */
function shapeCategory(c: rm.RMCategory) {
  return {
    id: c.id,
    nodeId: c.nodeId,
    label: c.label,
    kind: c.type,
    type: c.categoryType === "earning" ? "income" : c.categoryType,
    includeInSpending: c.includeInSpending,
    taxDeductible: c.taxDeductible,
    icon: c.iconKey,
    color: c.color,
  };
}

// ── Transaction rules: shared input schemas and output shapes ───────

const YMD = /^\d{4}-\d{2}-\d{2}$/;

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

type ConditionsArg = z.infer<typeof ruleConditionsSchema>;
type UpdatesArg = z.infer<typeof ruleUpdatesSchema>;

/** Tool-level updates -> rules.ts updates, resolving the category the way set_transaction_category does. */
async function resolveRuleUpdates(u: UpdatesArg | undefined): Promise<rules.RuleUpdates | undefined> {
  if (!u) return undefined;
  const { category, ...rest } = u;
  const out: rules.RuleUpdates = { ...rest };
  if (category === null) out.category_id = null;
  else if (category !== undefined) out.category_id = await rm.resolveCategoryNodeId(category);
  return out;
}

function shapeRule(r: rules.RMRule) {
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

const COMPACT = z
  .boolean()
  .optional()
  .describe(
    "Bulk-read form (default false): instead of `transactions`, returns a table {columns, categories, accounts, rows}. Each row is an array in `columns` order [id, date, amount, name, category, account, original_date, ignore]; category and account are indexes into `categories` / `accounts`; trailing empty cells are dropped, so rows vary in length (usually 6; 7 when re-dated; 8 when ignored) - read any missing cell as empty. Empty cells before the last filled one are null (e.g. [.., null, \"everything\"] = ignored, not re-dated). Empty means: no original_date = same as date; no ignore = counted; no category/account = none. Leaves out notes, renames and rule ids.",
  );

const ROW_FIELDS =
  "Each row has id, date (the current, possibly hand-changed date), amount, name, category and account. Fields are left out when empty: original_date (the date the bank posted it) appears only when it differs from date; ignore (budget = left out of budgets, everything = left out of all spending) only when the row is ignored; custom_name (a rename, by hand or by rule), note, applied_rule_ids (live rules that have applied to it; when several set the same field, the last id has been the effective one) and deleted_rule_ids (rules that applied before being deleted - Rocket Money keeps them in the row's history). Pass compact=true for bulk reads: a table about a third the size.";

const RULE_PRECEDENCE =
  "Rule precedence (measured 2026-10-29 over 8 observations; Rocket Money has no priority or order field): when several rules set the same field on one transaction, which one wins is NOT predictable from the rules - not by save order, creation order, id, or specificity. Saving any rule can re-apply every overlapping rule to the shared transactions, in an order the API doesn't expose: a newly created rule lost to older ones, two rules created back to back finished in reverse order, and updating a rule (which Rocket Money does as delete + create) handed the win to an older overlapping rule. What held in every observation: the effective rule is the LAST id in the transaction's applied_rule_ids, so read that after saving instead of assuming. To get a deterministic result, don't let two rules set the same field on the same transaction: make the conditions mutually exclusive (e.g. split by account, amount range or exact name), or have the broad rule set a different field than the specific one. Hand edits do NOT stick against rules (verified 2026-10-29): a category set by hand on a transaction was overwritten the next time a matching rule that sets category was saved, even re-saved unchanged - and saving any overlapping rule can re-apply the others. A rule that sets a different field (e.g. only rename) leaves a hand-set category alone. So fix an exception by hand only when no rule that sets that field matches it, or narrow the rule so it doesn't. delete_rule with undo_changes resets the fields that rule set to their original bank values even when another matching rule also sets them; re-save the other rule afterwards (update_rule with no changes).";

const RULE_LIMITS =
  "Not supported by Rocket Money's rule API: tags, OR between conditions, more than one name condition, name regex/starts-with, and matching on category.";

/** Build a fresh McpServer with the Rocket Money tools registered (writes omitted under READ_ONLY). */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "rocketmoney", version: "1.0.0" },
    {
      instructions:
        "Access to the user's Rocket Money finances (USD). Read tools: accounts and balances, transactions, spending by category, budgets, net worth, recurring charges (subscriptions, get_subscription), the category catalog (list_categories), and transaction rules (list_rules, get_rule, preview_rule). " +
        (READ_ONLY
          ? "This server runs in read-only mode: the write tools are not registered, so nothing here can change the account."
          : "Write tools MUTATE the account: set_transaction_note sets/clears a transaction's note; set_transaction_category recategorizes a transaction (optionally every related transaction from the same merchant); update_subscription corrects a recurring charge's name, amount, cadence or dates; delete_subscription removes one from the list; set_transaction_ignore and set_transaction_date change ignore state and dates in batches; create_category/update_category/delete_category manage custom categories; create_rule/update_rule/delete_rule manage transaction rules (run preview_rule first; by default a rule is applied to every existing match too; apply_to_existing=false limits it to future transactions). To recategorize, first call list_categories to see valid labels/ids, then pass a label like \"Groceries\" (or a category id) to set_transaction_category. Marking a subscription cancelled is not possible: Rocket Money's API has no such field for a subscription it detected from transactions.") +
        " If a tool reports the session is inactive, the user must re-authenticate at the auth page.",
    },
  );

  server.registerTool(
    "session_status",
    {
      title: "Session status",
      description:
        "Check whether the Rocket Money session is currently authenticated. Use this first if other tools report auth errors.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => {
      const local = sessionStatus();
      if (local.status !== "live") return { ...local, authenticated: false, readOnly: READ_ONLY, hint: AUTH_HINT };
      // Confirm liveness against RM (also rotates the cookie).
      const viewerId = await rm.authenticationCheck();
      return { ...local, authenticated: Boolean(viewerId), readOnly: READ_ONLY };
    }),
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description:
        "List every linked institution and account with its current balance, type, and masked number.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => fmt.shapeAccounts(await rm.getAccounts())),
  );

  server.registerTool(
    "get_account",
    {
      title: "Get account detail",
      description:
        "Detailed view of one account: current/available balance, credit limit, liability details (statement balance, minimum payment, due date, APRs), holdings (for investment accounts), and recent daily balance history. Pass the account node id from list_accounts.",
      inputSchema: {
        account_id: z.string().describe("The account node id (the `id` field from list_accounts)"),
      },
      annotations: READ,
    },
    tool(async ({ account_id }: { account_id: string }) =>
      fmt.shapeAccountDetail(await rm.getAccountDetail(account_id)),
    ),
  );

  server.registerTool(
    "list_holdings",
    {
      title: "List investment holdings",
      description:
        "List the securities held in one investment account (401k, IRA, brokerage): ticker, name, quantity, market value, and type. Pass the account node id from list_accounts. Returns an empty list for non-investment accounts.",
      inputSchema: {
        account_id: z.string().describe("The account node id (the `id` field from list_accounts)"),
      },
      annotations: READ,
    },
    tool(async ({ account_id }: { account_id: string }) => {
      const nodes: Record<string, unknown>[] = [];
      rm.collectByType(await rm.getAccountDetail(account_id), "Holdings", nodes);
      const holdings = nodes.map((h) => ({
        ticker: h.tickerSymbol,
        name: h.name,
        quantity: h.quantity,
        value: fmt.usd(h.valueCents as number),
        type: h.type,
      }));
      const total = holdings.reduce((t, h) => t + (h.value ?? 0), 0);
      return { count: holdings.length, totalValue: fmt.roundUsd(total), holdings };
    }),
  );

  server.registerTool(
    "net_worth",
    {
      title: "Net worth",
      description:
        "Net worth broken down into cash, savings, investments, and debts (credit cards, loans), with per-account values and a recent net-worth trend.",
      inputSchema: {
        use_equity: z
          .boolean()
          .optional()
          .describe("Value real estate at equity instead of market value (default false)"),
      },
      annotations: READ,
    },
    tool(async ({ use_equity }: { use_equity?: boolean }) =>
      fmt.shapeNetWorth(await rm.getNetWorth(use_equity ?? false)),
    ),
  );

  server.registerTool(
    "list_assets",
    {
      title: "List manual assets",
      description:
        "List the user's manually-tracked assets (vehicles, valuables, etc. under 'Other Assets') with their current value and asset id. These are assets added by hand, separate from linked institution accounts. Use the returned `id` with set_asset_value to update a balance.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => {
      const assets = await rm.getAssets();
      return {
        count: assets.length,
        assets: assets.map((a) => ({
          id: a.assetId,
          name: a.name,
          value: fmt.usd(a.valueCents),
          type: a.assetType,
          includeInNetWorth: a.includeInNetWorth,
        })),
      };
    }),
  );

  server.registerTool(
    "spending_summary",
    {
      title: "Spending summary",
      description:
        "This month's spending and earnings vs last month, plus a per-category spending breakdown (largest first). Amounts in USD.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => fmt.shapeSpending(await rm.getSpending())),
  );

  server.registerTool(
    "budgets",
    {
      title: "Budgets",
      description:
        "Budget view: earnings for this and the prior three months, and per-category spend with a 3-month trend.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => fmt.shapeBudgets(await rm.getBudgets())),
  );

  server.registerTool(
    "subscriptions",
    {
      title: "Subscriptions / recurring",
      description:
        "Every recurring charge Rocket Money tracks, active and inactive, with amount in USD, cadence (monthly/annual/semi-annual/irregular), the account or card it hits, last and next charge, category, and whether Rocket Money offers to cancel it for you. Inactive rows are included and flagged `active: false` - those are subscriptions still listed that have stopped charging, which is what a list audit is looking for. `amountSource` says whether the amount was pinned by hand, estimated by Rocket Money, or taken from the last charge.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => fmt.shapeRecurring(await rm.getRecurring())),
  );

  server.registerTool(
    "get_subscription",
    {
      title: "Get subscription detail",
      description:
        "One recurring charge in full: everything the subscriptions list shows plus its charge history - a per-month total for the last 12 months, the individual transactions, and Rocket Money's own annualized cost. Use it to check what a subscription is really being billed before correcting it with update_subscription. Pass the subscription id from subscriptions.",
      inputSchema: {
        subscription_id: z
          .string()
          .describe("The subscription node id (the `id` field from subscriptions)"),
      },
      annotations: READ,
    },
    tool(async ({ subscription_id }: { subscription_id: string }) =>
      fmt.shapeSubscriptionDetail(await rm.getSubscriptionDetail(subscription_id)),
    ),
  );

  server.registerTool(
    "upcoming_bills",
    {
      title: "Upcoming bills",
      description:
        "Upcoming subscription/bill charges in the next N days (default 28), with dates, amounts, and a total.",
      inputSchema: {
        days: z.number().int().min(1).max(90).optional().describe("Look-ahead window in days (default 28)"),
      },
      annotations: READ,
    },
    tool(async ({ days }: { days?: number }) => fmt.shapeUpcoming(await rm.getUpcoming(days ?? 28))),
  );

  server.registerTool(
    "search_transactions",
    {
      title: "Search transactions",
      description:
        "Search transactions by merchant/description text, date window, account and/or category. All filters optional; omit everything to list recent transactions. Newest first, amounts in USD. Returns up to `limit` rows (default 1200); when more match, next_cursor is set - pass it back as `cursor` to continue. " +
        ROW_FIELDS +
        " Filtering server-side (account_ids, category_ids, since/until) is far cheaper than pulling everything and discarding.",
      inputSchema: {
        query: z.string().optional().describe("Merchant or description text, e.g. 'Amazon'"),
        since: z.string().regex(YMD).optional().describe("Only transactions on/after this date (YYYY-MM-DD)"),
        until: z.string().regex(YMD).optional().describe("Only transactions on/before this date (YYYY-MM-DD)"),
        date_field: z
          .enum(["date", "original_date"])
          .optional()
          .describe(
            "Which date since/until apply to (default date). original_date is filtered here rather than by Rocket Money, which only filters on date: it finds transactions moved LATER than their posted date, but misses any moved to before `since`",
          ),
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
    },
    tool(
      async (args: {
        query?: string;
        since?: string;
        until?: string;
        date_field?: "date" | "original_date";
        account_ids?: string[];
        category_ids?: string[];
        limit?: number;
        cursor?: string;
        compact?: boolean;
      }) => {
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
          ? page.transactions.filter(
              (t) => (!args.since || t.originalDate >= args.since) && (!args.until || t.originalDate <= args.until),
            )
          : page.transactions;
        return { count: txns.length, next_cursor: page.nextCursor, ...(await shapeTxns(txns, args.compact)) };
      },
    ),
  );

  server.registerTool(
    "category_transactions",
    {
      title: "Transactions in a category",
      description:
        "List the transactions in one category, this month by default. Pass the category as a label, numeric id or node id (see list_categories). " +
        ROW_FIELDS,
      inputSchema: {
        category_id: z.string().describe("The category: a label like 'Groceries', a numeric id, or a TransactionCategory node id"),
        since: z.string().regex(YMD).optional().describe("On/after this date (YYYY-MM-DD); default the 1st of this month"),
        until: z.string().regex(YMD).optional().describe("On/before this date (YYYY-MM-DD); default today and later"),
        compact: COMPACT,
      },
      annotations: READ,
    },
    tool(async ({ category_id, since, until, compact }: { category_id: string; since?: string; until?: string; compact?: boolean }) => {
      const page = await rm.searchTransactionsPage({
        categoryIds: [await rm.resolveCategoryNodeId(category_id)],
        gteDate: since ?? monthWindows().currentMonthStart,
        ltDate: until ? addDaysYmd(until, 1) : null,
        limit: 2000,
      });
      return { count: page.transactions.length, ...(await shapeTxns(page.transactions, compact)) };
    }),
  );

  server.registerTool(
    "list_categories",
    {
      title: "List spending categories",
      description:
        "The user's full Rocket Money category catalog, each with its label, ids, kind (default = Rocket Money's own, custom = yours; only custom ones can be edited) and type (expense/income/ignored). Call this to discover valid categories before recategorizing a transaction with set_transaction_category.",
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => {
      const cats = await rm.getTransactionCategories();
      return { count: cats.length, categories: cats.map(shapeCategory) };
    }),
  );

  server.registerTool(
    "list_rules",
    {
      title: "List transaction rules",
      description:
        "Every transaction rule (Rocket Money's 'Edit Rule'): its id, match conditions, the updates it applies (category, rename, ignore, tax deductible), and how many transactions it currently matches. Amounts in USD; dates YYYY-MM-DD. " +
        RULE_PRECEDENCE,
      inputSchema: {},
      annotations: READ,
    },
    tool(async () => {
      const all = await rules.listRules();
      return { count: all.length, rules: all.map(shapeRule) };
    }),
  );

  server.registerTool(
    "get_rule",
    {
      title: "Get transaction rule",
      description:
        "One transaction rule in full plus a sample of the transactions it matches (newest first, with transaction ids). Pass the rule id from list_rules.",
      inputSchema: {
        rule_id: z.string().describe("The rule id (the `id` from list_rules)"),
        sample_size: z.number().int().min(1).max(2000).optional().describe("Matched transactions to return, newest first (default 20, max 2000)"),
        compact: COMPACT,
      },
      annotations: READ,
    },
    tool(async ({ rule_id, sample_size, compact }: { rule_id: string; sample_size?: number; compact?: boolean }) => {
      const rule = await rules.getRule(rule_id);
      const { count, sample } = await rules.previewMatches(rule.matchRulesInput, sample_size ?? 20);
      return { ...shapeRule(rule), matchedNow: count, sample: await shapeTxns(sample, compact) };
    }),
  );

  server.registerTool(
    "preview_rule",
    {
      title: "Preview a transaction rule",
      description:
        "Dry run: how many existing transactions a set of match conditions would match, plus a sample (newest first, with ids). Saves nothing. Use it before create_rule/update_rule. " +
        RULE_LIMITS,
      inputSchema: {
        conditions: ruleConditionsSchema,
        sample_size: z.number().int().min(1).max(2000).optional().describe("Matched transactions to return, newest first (default 20, max 2000)"),
        compact: COMPACT,
      },
      annotations: READ,
    },
    tool(async ({ conditions, sample_size, compact }: { conditions: ConditionsArg; sample_size?: number; compact?: boolean }) => {
      const { count, sample } = await rules.previewMatches(rules.conditionsToInput(conditions), sample_size ?? 20);
      return { matchedCount: count, sample: await shapeTxns(sample, compact) };
    }),
  );

  // ── Write tools (these MUTATE Rocket Money) ──────────────────────
  // ROCKETMONEY_READ_ONLY=1 stops here: the write tools are never registered,
  // so a client cannot reach them at all.
  if (READ_ONLY) return server;

  const WRITE = { readOnlyHint: false, openWorldHint: true } as const;

  server.registerTool(
    "set_transaction_note",
    {
      title: "Set transaction note",
      description:
        "WRITES to Rocket Money: set (or clear) the free-text note on one transaction. Pass the transaction id from search_transactions/category_transactions. Use an empty string to clear the note. Returns the saved note.",
      inputSchema: {
        transaction_id: z.string().describe("The transaction node id (the `id` from search_transactions)"),
        note: z.string().describe("The note text to save. Pass an empty string to clear it."),
      },
      annotations: WRITE,
    },
    tool(async ({ transaction_id, note }: { transaction_id: string; note: string }) => {
      const saved = await rm.setTransactionNote(transaction_id, note);
      return { transaction_id, note: saved, ok: true };
    }),
  );

  server.registerTool(
    "set_transaction_notes",
    {
      title: "Set notes on many transactions",
      description:
        "WRITES to Rocket Money: set (or clear, with an empty string) notes on a batch of transactions in one call - either one `note` for every id in `transaction_ids`, or a different note per transaction in `notes`. Sent 50 per request. Returns each saved note, or an error for that id.",
      inputSchema: {
        transaction_ids: z.array(z.string()).optional().describe("Transaction node ids that all get `note`"),
        note: z.string().optional().describe("The note for every id in transaction_ids (empty string clears)"),
        notes: z
          .array(z.object({ transaction_id: z.string(), note: z.string() }))
          .optional()
          .describe("Per-transaction notes, instead of transaction_ids + note"),
      },
      annotations: WRITE,
    },
    tool(
      async (a: { transaction_ids?: string[]; note?: string; notes?: { transaction_id: string; note: string }[] }) => {
        const items = [
          ...(a.notes ?? []).map((n) => ({ nodeId: n.transaction_id, note: n.note })),
          ...(a.transaction_ids ?? []).map((id) => ({ nodeId: id, note: a.note ?? "" })),
        ];
        if (a.transaction_ids?.length && a.note === undefined) throw new Error("transaction_ids needs a `note`.");
        if (!items.length) throw new Error("Pass transaction_ids + note, or notes.");
        return perItemOutcome(await rm.setTransactionsNote(items));
      },
    ),
  );

  server.registerTool(
    "set_transaction_category",
    {
      title: "Set transaction category",
      description:
        "WRITES to Rocket Money: recategorize one transaction. `category` accepts a category label (e.g. \"Groceries\"), a numeric category id, or a category node id - call list_categories first to see valid options. Set apply_to_all=true to also sweep the merchant's other transactions (matched by descriptor). To recategorize a specific known set of transactions, prefer set_transactions_category - it is one round trip instead of N.",
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
    },
    tool(
      async ({
        transaction_id,
        category,
        apply_to_all,
      }: {
        transaction_id: string;
        category: string;
        apply_to_all?: boolean;
      }) => {
        const catNodeId = await rm.resolveCategoryNodeId(category);
        const updated = await rm.setTransactionCategory(transaction_id, catNodeId, apply_to_all ?? false);
        return { transaction_id, category, categoryNodeId: catNodeId, updatedCount: updated, ok: true };
      },
    ),
  );

  server.registerTool(
    "set_transactions_category",
    {
      title: "Set category on many transactions",
      description:
        "WRITES to Rocket Money: recategorize a batch of transactions in one call. Pass the transaction node ids (the `id` from search_transactions) and a category label, numeric id, or category node id. Returns updatedCount as reported by Rocket Money - compare it against the number of ids you sent rather than trusting ok:true.",
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
    },
    tool(async ({ transaction_ids, category }: { transaction_ids: string[]; category: string }) => {
      const catNodeId = await rm.resolveCategoryNodeId(category);
      const { valid, invalid } = rm.partitionTransactionIds(transaction_ids);
      const updated = await rm.setTransactionsCategory(valid, catNodeId);
      return batchOutcome(transaction_ids.length, updated, {
        category,
        categoryNodeId: catNodeId,
        ...(invalid.length ? { invalid } : {}),
      });
    }),
  );

  server.registerTool(
    "update_subscription",
    {
      title: "Update a subscription",
      description:
        "WRITES to Rocket Money: correct a recurring charge's name, amount, cadence or dates. Pass only what changes - the rest is preserved from a fresh read, because Rocket Money's mutation replaces the whole record. `amount` is in USD dollars. `frequency` is charges per YEAR: 12 monthly, 4 quarterly, 2 semi-annual, 1 annual. CANNOT mark a subscription cancelled or inactive: `active` is not a field Rocket Money's update mutation accepts, and the only deactivate mutation applies to hand-added subscriptions, not ones Rocket Money detected from transactions. To get a wrongly-listed charge off the list, use delete_subscription; to tell Rocket Money a dead-looking one is still live, use mark_subscription_active.",
      inputSchema: {
        subscription_id: z
          .string()
          .describe("The subscription node id (the `id` field from subscriptions)"),
        name: z.string().optional().describe("New display name for the subscription"),
        amount: z
          .number()
          .nonnegative()
          .optional()
          .describe("New charge amount in USD dollars (e.g. 47.88). Pins the amount Rocket Money shows."),
        frequency: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Charges per year: 12 monthly, 6 every 2 months, 4 quarterly, 2 semi-annual, 1 annual"),
        next_expected_date: z
          .string()
          .optional()
          .describe("Next expected charge date, YYYY-MM-DD"),
        start_date: z.string().optional().describe("Date of the first charge, YYYY-MM-DD"),
        end_date: z
          .string()
          .optional()
          .describe("Date of the last charge, YYYY-MM-DD. This records when it last billed; it does not cancel or deactivate anything."),
        service_type: z
          .enum(rm.SERVICE_TYPES)
          .optional()
          .describe("How Rocket Money files it: subscription, bill, utility, bundled, or unknown"),
      },
      annotations: WRITE,
    },
    tool(
      async (args: {
        subscription_id: string;
        name?: string;
        amount?: number;
        frequency?: number;
        next_expected_date?: string;
        start_date?: string;
        end_date?: string;
        service_type?: (typeof rm.SERVICE_TYPES)[number];
      }) => {
        const saved = await rm.updateSubscription(args.subscription_id, {
          name: args.name,
          // Dollars in, cents on the wire. Every Rocket Money money field is
          // integer cents, including this one, whose name does not say so.
          amountCents: args.amount === undefined ? undefined : Math.round(args.amount * 100),
          frequency: args.frequency,
          nextExpectedDate: args.next_expected_date,
          startDate: args.start_date,
          endDate: args.end_date,
          serviceType: args.service_type,
        });
        return {
          id: saved.id,
          name: saved.custom_name,
          amount: fmt.usd(saved.amount),
          frequency: saved.frequency,
          cadence: fmt.cadence(saved.frequency),
          startDate: saved.start_date,
          endDate: saved.end_date,
          nextBillDate: saved.expected_next_bill_date,
          serviceType: saved.service_type,
          ok: true,
        };
      },
    ),
  );

  server.registerTool(
    "mark_subscription_active",
    {
      title: "Mark a subscription active",
      description:
        "WRITES to Rocket Money: tell it a subscription it had marked inactive is still being charged. This is the only direction `active` moves through the API - there is no matching call to mark a detected subscription inactive. Returns the resulting active flag.",
      inputSchema: {
        subscription_id: z
          .string()
          .describe("The subscription node id (the `id` field from subscriptions)"),
      },
      annotations: WRITE,
    },
    tool(async ({ subscription_id }: { subscription_id: string }) => ({
      subscription_id,
      active: await rm.markSubscriptionActive(subscription_id),
      ok: true,
    })),
  );

  server.registerTool(
    "delete_subscription",
    {
      title: "Delete a subscription",
      description:
        "WRITES to Rocket Money: remove a recurring charge from the list entirely. For rows Rocket Money detected wrongly, duplicates, and charges that will never come back. This does NOT cancel anything with the merchant and it is not reversible from here - the row and its history are gone from the recurring list. Requires confirm=true. To correct a subscription rather than remove it, use update_subscription.",
      inputSchema: {
        subscription_id: z
          .string()
          .describe("The subscription node id (the `id` field from subscriptions)"),
        confirm: z
          .literal(true)
          .describe("Must be true. Deleting is not reversible from this server, so it is never the default."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const,
    },
    tool(async ({ subscription_id }: { subscription_id: string; confirm: true }) => ({
      subscription_id,
      deleted: await rm.deleteSubscription(subscription_id),
      ok: true,
    })),
  );

  server.registerTool(
    "set_asset_value",
    {
      title: "Set manual asset value",
      description:
        "WRITES to Rocket Money: update the value/balance of a manually-tracked asset (e.g. a vehicle under 'Other Assets'). Pass the asset id from list_assets and the new value in USD dollars. Preserves the asset's name/type/net-worth setting. Returns the updated asset.",
      inputSchema: {
        asset_id: z.string().describe("The asset node id (the `id` from list_assets)"),
        value: z.number().nonnegative().describe("The new asset value in USD dollars (e.g. 60000 for $60k)"),
      },
      annotations: WRITE,
    },
    tool(async ({ asset_id, value }: { asset_id: string; value: number }) => {
      const updated = await rm.updateAssetValue(asset_id, Math.round(value * 100));
      return {
        id: updated.assetId,
        name: updated.name,
        value: fmt.usd(updated.valueCents),
        type: updated.assetType,
        includeInNetWorth: updated.includeInNetWorth,
        ok: true,
      };
    }),
  );

  server.registerTool(
    "set_transaction_ignore",
    {
      title: "Ignore transactions",
      description:
        "WRITES to Rocket Money: set the ignore state on a batch of transactions in one call, without a rule. none = counted normally; budget = left out of budgets; everything = left out of all spending and charts (e.g. transfers between your own accounts). Pass the transaction ids from search_transactions. Returns updatedCount as reported by Rocket Money.",
      inputSchema: {
        transaction_ids: z.array(z.string()).min(1).describe("Transaction node ids (the `id` from search_transactions)"),
        ignore: z.enum(["none", "budget", "everything"]).describe("The ignore state to set"),
      },
      annotations: WRITE,
    },
    tool(async ({ transaction_ids, ignore }: { transaction_ids: string[]; ignore: "none" | "budget" | "everything" }) => {
      const { valid, invalid } = rm.partitionTransactionIds(transaction_ids);
      const updated = await rm.setTransactionsIgnored(valid, ignore === "none" ? null : ignore);
      return batchOutcome(transaction_ids.length, updated, { ignore, ...(invalid.length ? { invalid } : {}) });
    }),
  );

  server.registerTool(
    "set_transaction_date",
    {
      title: "Change transaction dates",
      description:
        "WRITES to Rocket Money: change the date of one or more transactions, e.g. to date a trip purchase to when the trip happens. Pass date as YYYY-MM-DD, or \"original\" to reset each transaction to the date its bank posted it. Rocket Money keeps the posted date as original_date through any number of changes. Its API changes one transaction per call, so a batch is sent one at a time; each result reports the saved date and original_date, or an error for that id.",
      inputSchema: {
        transaction_ids: z.array(z.string()).min(1).max(200).describe("Transaction node ids (the `id` from search_transactions)"),
        date: z
          .string()
          .regex(/^(\d{4}-\d{2}-\d{2}|original)$/)
          .describe("New date YYYY-MM-DD, or 'original' to reset to the posted date"),
      },
      annotations: WRITE,
    },
    tool(async ({ transaction_ids, date }: { transaction_ids: string[]; date: string }) => {
      const results = await rm.setTransactionsDate(transaction_ids, date);
      return perItemOutcome(
        results.map((r) => ({ id: r.id, date: r.date || null, original_date: r.originalDate || null, ...(r.error ? { error: r.error } : {}) })),
      );
    }),
  );

  const CATEGORY_TYPE = z
    .enum(["expense", "income", "ignored"])
    .describe("expense = counted as spending; income = counted as earnings (only positive amounts); ignored = left out of everything");
  const toCategoryType = (t: "expense" | "income" | "ignored"): rm.CategoryType => (t === "income" ? "earning" : t);

  server.registerTool(
    "create_category",
    {
      title: "Create a category",
      description:
        "WRITES to Rocket Money: create a custom category. Returns its id and node id for set_transaction_category, set_transactions_category and rules. icon and color are optional (defaults: the web app's 'coffee' icon, gray).",
      inputSchema: {
        label: z.string().min(1).describe("Category name, e.g. 'Rent'"),
        type: CATEGORY_TYPE,
        tax_deductible: z.boolean().optional().describe("Mark its transactions tax deductible by default (default false)"),
        icon: z.string().optional().describe("Rocket Money icon key (see list_categories' icon values), e.g. 'home'"),
        color: z.string().optional().describe("CSS color, e.g. 'rgb(117, 117, 117)'"),
      },
      annotations: WRITE,
    },
    tool(
      async (a: { label: string; type: "expense" | "income" | "ignored"; tax_deductible?: boolean; icon?: string; color?: string }) => {
        const cat = await rm.createCategory(a.label, toCategoryType(a.type), {
          taxDeductible: a.tax_deductible,
          iconKey: a.icon,
          color: a.color,
        });
        return { category: shapeCategory(cat), ok: true };
      },
    ),
  );

  server.registerTool(
    "update_category",
    {
      title: "Update a category",
      description:
        "WRITES to Rocket Money: rename a custom category or change its type, tax-deductible default, icon or color. Only custom categories can be changed; Rocket Money's default categories are fixed. Fields you omit keep their current values.",
      inputSchema: {
        category: z.string().describe("The category: label, numeric id or node id (see list_categories)"),
        label: z.string().min(1).optional().describe("New name"),
        type: CATEGORY_TYPE.optional(),
        tax_deductible: z.boolean().optional(),
        icon: z.string().optional(),
        color: z.string().optional(),
      },
      annotations: WRITE,
    },
    tool(
      async (a: {
        category: string;
        label?: string;
        type?: "expense" | "income" | "ignored";
        tax_deductible?: boolean;
        icon?: string;
        color?: string;
      }) => {
        const cat = await rm.updateCategory(a.category, {
          label: a.label,
          categoryType: a.type ? toCategoryType(a.type) : undefined,
          taxDeductible: a.tax_deductible,
          iconKey: a.icon,
          color: a.color,
        });
        return { category: shapeCategory(cat), ok: true };
      },
    ),
  );

  server.registerTool(
    "delete_category",
    {
      title: "Delete a category",
      description:
        "WRITES to Rocket Money: delete a custom category. Rocket Money itself would leave its transactions Uncategorized; pass reassign_to to move them all to another category first (the delete is skipped if any fail to move). Rules that set this category are not changed. Not reversible. Requires confirm=true.",
      inputSchema: {
        category: z.string().describe("The category to delete: label, numeric id or node id"),
        reassign_to: z.string().optional().describe("Move its transactions to this category first: label, numeric id or node id"),
        confirm: z.literal(true).describe("Must be true"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const,
    },
    tool(async ({ category, reassign_to }: { category: string; reassign_to?: string }) => {
      const r = await rm.deleteCategory(category, reassign_to);
      return { deleted: shapeCategory(r.deleted), reassignedCount: r.reassigned, reassignedTo: r.reassignedTo, ok: true };
    }),
  );

  const APPLY_TO_EXISTING =
    "Rocket Money has no 'future transactions only' switch: saving a rule always applies it to every transaction it matches at that moment. " +
    "So with apply_to_existing=false the rule gets a date_from of tomorrow, so it matches nothing that has already posted, and the save is refused if a preview still finds a match. " +
    "With apply_to_existing=true (the default) there is no floor, and the response's existingTransactionsUpdated is how many transactions Rocket Money applied the updates to - including ones whose matching fields were edited by hand, which it overwrites.";

  server.registerTool(
    "create_rule",
    {
      title: "Create a transaction rule",
      description:
        "WRITES to Rocket Money: create a transaction rule that applies `updates` to transactions matching `conditions`. Run preview_rule first. " +
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
    },
    tool(
      async ({
        conditions,
        updates,
        apply_to_existing,
      }: {
        conditions: ConditionsArg;
        updates: UpdatesArg;
        apply_to_existing?: boolean;
      }) => {
        const r = await rules.createRule(conditions, (await resolveRuleUpdates(updates))!, apply_to_existing ?? true);
        return {
          rule: r.rule ? shapeRule(r.rule) : null,
          existingTransactionsUpdated: r.existingTransactionsUpdated,
          dateFloorAdded: r.dateFloorAdded,
          ok: true,
        };
      },
    ),
  );

  server.registerTool(
    "update_rule",
    {
      title: "Update a transaction rule",
      description:
        "WRITES to Rocket Money: change a rule's conditions and/or updates. Rocket Money saves the change as a replacement rule with a NEW id; the response's rule.id is the one to use afterwards. Only the fields you pass change; pass null to clear one (setting name_contains clears name_equals and vice versa; likewise amount vs amount_min/amount_max). " +
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
    },
    tool(
      async ({
        rule_id,
        conditions,
        updates,
        apply_to_existing,
      }: {
        rule_id: string;
        conditions?: ConditionsArg;
        updates?: UpdatesArg;
        apply_to_existing?: boolean;
      }) => {
        const r = await rules.updateRule(
          rule_id,
          conditions,
          await resolveRuleUpdates(updates),
          apply_to_existing ?? true,
        );
        return {
          rule: r.rule ? shapeRule(r.rule) : null,
          existingTransactionsUpdated: r.existingTransactionsUpdated,
          dateFloorAdded: r.dateFloorAdded,
          ok: true,
        };
      },
    ),
  );

  server.registerTool(
    "delete_rule",
    {
      title: "Delete a transaction rule",
      description:
        "WRITES to Rocket Money: delete a transaction rule so it stops applying to future transactions. By default the changes it already made stay in place; undo_changes=true also reverts them on every transaction it matched (the web app's 'Undo Changes') - back to the bank's original values, which also discards hand edits made to those fields (verified 2026-10-29: a hand-set category went back to the bank's), and ignores other matching rules that set the same field, so re-save those afterwards (update_rule with no changes).",
      inputSchema: {
        rule_id: z.string().describe("The rule id (the `id` from list_rules)"),
        undo_changes: z
          .boolean()
          .optional()
          .describe("Also revert what the rule changed on past transactions (default false)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const,
    },
    tool(async ({ rule_id, undo_changes }: { rule_id: string; undo_changes?: boolean }) => {
      const r = await rules.deleteRule(rule_id, undo_changes ?? false);
      return { deleted: shapeRule(r.deleted), transactionsReverted: r.transactionsReverted, ok: true };
    }),
  );

  return server;
}
