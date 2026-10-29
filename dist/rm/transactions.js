// Transactions: the row type, search (paged, full-text so no persisted hash),
// and every per-transaction write (date, ignore, notes, category).
import { batchAliased, collectByType, collectPages, findPageInfo, fromNodeId, rmFullText, } from "./graphql.js";
/**
 * Why `id` can't be a transaction id, or null if it is one. Checked before
 * sending: RM answers a bad id with a bare "An error occurred.", which says
 * nothing about what was wrong.
 */
export function notATransactionId(id) {
    return fromNodeId(id)?.type === "Transaction"
        ? null
        : `"${id}" is not a transaction id (use the \`id\` from search_transactions)`;
}
/** Split ids into transaction ids and the rest (with the reason each was refused). */
export function partitionTransactionIds(ids) {
    const valid = [];
    const invalid = [];
    for (const id of ids) {
        const why = notATransactionId(id);
        if (why)
            invalid.push({ id, error: why });
        else
            valid.push(id);
    }
    return { valid, invalid };
}
/** RM's masked per-item error, reworded for a well-formed transaction id it still refused. */
function explainItemError(message) {
    if (!message || /^An error occurred\.?$/.test(message.trim())) {
        return "Rocket Money refused it: no such transaction, or not one of yours (it only says \"An error occurred.\")";
    }
    return message;
}
/** One Transaction node (LightTransaction fragment) -> RMTransaction, or null if it lacks the basics. */
export function toRMTransaction(o) {
    if (typeof o.id !== "string" || typeof o.amount !== "number")
        return null;
    const category = o.category;
    const account = o.account;
    return {
        nodeId: o.id,
        amountCents: o.amount,
        date: String(o.date ?? ""),
        originalDate: String(o.posted_date ?? o.date ?? ""),
        note: o.note ?? null,
        name: String(o.longName ?? o.shortName ?? ""),
        customName: o.custom_name ?? null,
        categoryLabel: category?.label ?? null,
        accountId: account?.id ?? null,
        ignoredFrom: o.ignoredFrom ?? null,
        ruleIds: Array.isArray(o.transactionRuleNodeIds) ? o.transactionRuleNodeIds : [],
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
/**
 * Search transactions, newest first, paging 200 at a time until `limit` rows or
 * the end. Returns nextCursor when more remain, so a caller can walk any window
 * past the limit. Dedupes by node id.
 */
export async function searchTransactionsPage(opts) {
    const all = [];
    const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
    let cursor = opts.cursor ?? null;
    let nextCursor = null;
    while (all.length < limit) {
        const data = await rmFullText("TransactionSearch", TRANSACTION_SEARCH, {
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
        const nodes = [];
        collectByType(data, "Transaction", nodes);
        const before = all.length;
        for (const o of nodes) {
            const t = toRMTransaction(o);
            if (t)
                all.push(t);
        }
        const pageInfo = findPageInfo(data);
        nextCursor = pageInfo?.hasNextPage && pageInfo.endCursor && all.length > before ? pageInfo.endCursor : null;
        if (!nextCursor)
            break;
        cursor = nextCursor;
    }
    const seen = new Set();
    return {
        transactions: all.filter((t) => (seen.has(t.nodeId) ? false : (seen.add(t.nodeId), true))),
        nextCursor,
    };
}
/** Every transaction matching `opts`, walking the cursor to the end (no row limit). */
export async function searchAllTransactions(opts) {
    return collectPages(async (cursor) => {
        const page = await searchTransactionsPage({ ...opts, cursor, limit: SCAN_PAGE_LIMIT });
        return { items: page.transactions, next: page.nextCursor };
    });
}
/**
 * WRITE: change transactions' dates. RM's mutation takes one transaction, so
 * the ids go out as aliased mutations, BATCH_SIZE per request. `date`
 * "original" resets each to its posted_date, which RM keeps untouched through
 * any number of date changes (verified 2026-10-29); those are looked up in
 * batches first. Returns each transaction's dates as RM saved them.
 */
export async function setTransactionsDate(nodeIds, date) {
    const lookupErrors = nodeIds.map((id) => notATransactionId(id) ?? undefined);
    let targets = nodeIds.map((_, i) => (lookupErrors[i] ? null : date));
    if (date === "original") {
        const look = nodeIds.map((id, i) => ({ id, i })).filter((x) => !lookupErrors[x.i]);
        const posted = await batchAliased("TransactionPostedDates", "query", "node", { name: "id", type: "ID!" }, "id\n    ... on Transaction { posted_date }\n    __typename", look.map((x) => x.id));
        targets = nodeIds.map(() => null);
        look.forEach((x, k) => {
            const r = posted[k];
            if (r.data?.posted_date)
                targets[x.i] = r.data.posted_date;
            else
                lookupErrors[x.i] = r.ok ? "no such transaction, or it has no posted date" : explainItemError(r.error);
        });
    }
    const todo = nodeIds.map((id, i) => ({ id, i, target: targets[i] })).filter((t) => t.target !== null);
    const saved = await batchAliased("ChangeTransactionDates", "mutation", "changeTransactionDate", { name: "input", type: "ChangeTransactionDateInput!" }, "transaction { id date posted_date __typename }\n    __typename", todo.map((t) => ({ transactionNodeId: t.id, date: t.target })));
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
export async function setTransactionsIgnored(nodeIds, ignoredFrom) {
    if (nodeIds.length === 0)
        return 0;
    const data = await rmFullText("SetTransactionsIgnored", "mutation SetTransactionsIgnored($input: SetTransactionsIgnoredInput!) {\n  setTransactionsIgnored(input: $input) {\n    transactions {\n      id\n      ignoredFrom\n      __typename\n    }\n    countUpdated\n    transactionOverrideIds\n    __typename\n  }\n}", { input: { transactionNodeIds: nodeIds, setIgnored: ignoredFrom } });
    return data.setTransactionsIgnored?.countUpdated ?? 0;
}
/**
 * WRITE: set (or clear, with "") notes on many transactions, as aliased
 * mutations BATCH_SIZE per request. Returns each saved note, or an error per id.
 */
export async function setTransactionsNote(items) {
    const out = items.map((it) => {
        const why = notATransactionId(it.nodeId);
        return why ? { id: it.nodeId, note: null, error: why } : { id: it.nodeId, note: null };
    });
    const todo = items.map((it, i) => ({ it, i })).filter((x) => !out[x.i].error);
    const results = await batchAliased("SetTransactionNotes", "mutation", "setTransactionNote", { name: "input", type: "SetTransactionNoteInput!" }, "transaction { id note __typename }\n    __typename", todo.map(({ it }) => ({ transactionNodeId: it.nodeId, note: it.note })));
    todo.forEach(({ it, i }, k) => {
        const r = results[k];
        out[i] = r.ok
            ? { id: it.nodeId, note: r.data?.transaction?.note ?? null }
            : { id: it.nodeId, note: null, error: explainItemError(r.error) };
    });
    return out;
}
/**
 * WRITE: set the spending category on many transactions in one round trip.
 * This is the mutation the web app fires when you multi-select rows, and it is
 * the only reliable way to recategorize in bulk. Returns RM's own countUpdated.
 */
export async function setTransactionsCategory(nodeIds, catNodeId) {
    if (nodeIds.length === 0)
        return 0;
    const data = await rmFullText("SetTransactionsCategory", "mutation SetTransactionsCategory($input: SetTransactionsCategoryInput!) {\n  setTransactionsCategory(input: $input) {\n    transactions {\n      id\n      category {\n        id\n        __typename\n      }\n      ignoredFrom\n      __typename\n    }\n    countUpdated\n    transactionOverrideIds\n    __typename\n  }\n}", {
        input: {
            transactionNodeIds: nodeIds,
            transactionCategoryNodeId: catNodeId,
        },
    });
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
export async function setTransactionCategory(nodeId, catNodeId, applyToAll = false) {
    if (!applyToAll)
        return setTransactionsCategory([nodeId], catNodeId);
    // Read the merchant name off the transaction itself: scanning recent rows for
    // it missed anything older than the newest 200 and silently updated only one.
    const self = await rmFullText("TransactionName", "query TransactionName($id: ID!) {\n  node(id: $id) {\n    id\n    ... on Transaction {\n      longName(prependCustomName: false)\n    }\n    __typename\n  }\n}", { id: nodeId });
    const name = self.node?.longName;
    if (!name)
        throw new Error(`No transaction "${nodeId}" (or it has no name to match the rest of the merchant on).`);
    const related = await searchAllTransactions({ query: name });
    const ids = new Set([nodeId, ...related.map((t) => t.nodeId)]);
    return setTransactionsCategoryChunked([...ids], catNodeId);
}
/** setTransactionsCategory in 500-id chunks, for sweeps that can match thousands. */
export async function setTransactionsCategoryChunked(nodeIds, catNodeId) {
    let updated = 0;
    for (let i = 0; i < nodeIds.length; i += 500)
        updated += await setTransactionsCategory(nodeIds.slice(i, i + 500), catNodeId);
    return updated;
}
