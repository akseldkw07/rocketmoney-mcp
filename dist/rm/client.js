// Rocket Money reads and the account-level writes (subscriptions, assets).
// Transport lives in graphql.ts, transactions in transactions.ts, categories in
// categories.ts; all re-exported here so `import * as rm from "./rm/client.js"`
// reaches everything.
import { collectWhere, rmFullText, rmGraphQL } from "./graphql.js";
import { monthWindows, ymd, addDays } from "./windows.js";
export * from "./graphql.js";
export * from "./transactions.js";
export * from "./categories.js";
/** Cheap liveness probe (also rotates the cookie). Returns viewer id if authed. */
export async function authenticationCheck() {
    const data = await rmGraphQL({ operationName: "AuthenticationCheck" });
    return data.viewer?.id ?? "";
}
/** Keepalive - re-rolls the session cookie. */
export async function refreshAuthToken() {
    await rmGraphQL({ operationName: "RefreshAuthToken" });
}
/** Every institution + account with current balance. */
export async function getAccounts() {
    return rmGraphQL({ operationName: "AccountDetailAccountListPage" });
}
/** One account's detail: balances, liabilities/APRs, 6-month balance history. */
export async function getAccountDetail(accountNodeId) {
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
export async function getNetWorth(useEquity = false) {
    const w = monthWindows();
    return rmGraphQL({
        operationName: "NetWorthQuery",
        variables: { sixMonthsAgo: w.sixMonthsAgo, useEquity, lastMonth: w.lastMonthEnd },
    });
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
export async function getAssets() {
    const data = await getNetWorth(false);
    const nodes = [];
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
export async function updateAssetValue(assetNodeId, valueCents) {
    const today = ymd(new Date());
    const data = await rmFullText("CreateAssetValue", "mutation CreateAssetValue($input: CreateAssetValueInput!) {\n  createAssetValue(input: $input) {\n    asset {\n      id\n      name\n      type\n      includeInNetWorth\n      valueCents\n      __typename\n    }\n    __typename\n  }\n}", { input: { assetNodeId, valueCents, date: today } });
    const a = data.createAssetValue?.asset;
    if (!a)
        throw new Error(`createAssetValue returned no asset for "${assetNodeId}".`);
    return {
        assetId: String(a.id ?? assetNodeId),
        name: String(a.name ?? ""),
        valueCents: typeof a.valueCents === "number" ? a.valueCents : valueCents,
        assetType: String(a.type ?? ""),
        includeInNetWorth: Boolean(a.includeInNetWorth),
    };
}
/** This-month vs last-month spending, earnings, and per-category breakdown. */
export async function getSpending() {
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
export async function getBudgets() {
    const w = monthWindows();
    const now = new Date();
    const startNMonths = (n) => ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1)));
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
export async function getRecurring() {
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
export async function getSubscriptionDetail(subscriptionNodeId, startDate = null, endDate = null) {
    return rmGraphQL({
        operationName: "SubscriptionDetailPage",
        variables: { id: subscriptionNodeId, startDate, endDate },
    });
}
/** The five ServiceType enum members RM accepts on UpdateSubscriptionInput. */
export const SERVICE_TYPES = ["subscription", "bill", "utility", "bundled", "unknown"];
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
export function buildSubscriptionUpdateInput(node, edit = {}) {
    const service = (node.service ?? {});
    const name = edit.name ?? node.custom_name ?? service.name;
    if (typeof name !== "string" || !name) {
        throw new Error("Subscription has no name and none was supplied; service_name is required.");
    }
    const input = { id: node.id, service_name: name };
    const put = (key, value) => {
        if (value !== null && value !== undefined)
            input[key] = value;
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
export async function updateSubscription(subscriptionNodeId, edit) {
    const detail = await getSubscriptionDetail(subscriptionNodeId);
    const node = (detail.node ?? null);
    if (!node?.id)
        throw new Error(`No subscription found for id "${subscriptionNodeId}".`);
    const input = buildSubscriptionUpdateInput(node, edit);
    const data = await rmFullText("UpdateSubscription", UPDATE_SUBSCRIPTION, { input });
    const saved = data.updateSubscription?.subscription;
    if (!saved)
        throw new Error(`updateSubscription returned no subscription for "${subscriptionNodeId}".`);
    return saved;
}
/**
 * WRITE: tell Rocket Money a subscription it had written off is still live.
 * This is the one direction `active` moves through the API: there is a
 * `deactivateManualSubscription` for hand-added ones, but nothing that
 * deactivates a subscription RM detected from transactions.
 */
export async function markSubscriptionActive(subscriptionNodeId) {
    const data = await rmFullText("MarkSubscriptionActive", "mutation MarkSubscriptionActive($input: MarkSubscriptionActiveInput!) {\n  markSubscriptionActive(input: $input) {\n    subscription {\n      __typename\n      id\n      active\n    }\n    __typename\n  }\n}", { input: { subscriptionId: subscriptionNodeId } });
    return data.markSubscriptionActive?.subscription?.active ?? false;
}
/**
 * WRITE: drop a recurring charge from Rocket Money's list entirely. For rows RM
 * detected wrongly, or duplicates of a subscription already tracked. This is not
 * a cancellation: the merchant keeps charging, RM just stops listing it.
 */
export async function deleteSubscription(subscriptionNodeId) {
    const data = await rmFullText("DeleteSubscription", "mutation DeleteSubscription($input: DeleteSubscriptionInput!) {\n  deleteSubscription(input: $input) {\n    __typename\n  }\n}", { input: { subscriptionId: subscriptionNodeId } });
    return Boolean(data.deleteSubscription);
}
/** Upcoming bill/subscription charges in the next `days` days (default 28). */
export async function getUpcoming(days = 28) {
    const now = new Date();
    return rmGraphQL({
        operationName: "RecurringUpcomingPage",
        variables: { upcomingStartDate: ymd(now), upcomingEndDate: ymd(addDays(now, days)) },
    });
}
