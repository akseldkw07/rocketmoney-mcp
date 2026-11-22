// Manual transactions: rows typed in by hand rather than synced from a bank,
// e.g. cash or a card that was never linked.
//
// The web app has no screen for these (only the phone app does), but its API
// takes them: the bundle's own schema lists addManualTransaction and
// deleteManualTransaction, and on 2026-11-22 both worked with the web session.
// Their inputs, read from validation errors since introspection is off:
//   AddManualTransactionInput { name: String!, amountCents: BigInt!,
//     direction: ManualTransactionDirection! (spend | income), date: Date!,
//     categoryId: ID, accountId: ID }
//   DeleteManualTransactionInput { transactionNodeId: ID! }
// With no accountId RM files the row under a manual "Cash" account it creates
// itself. The row takes back-dating (2021 tested), counts in spending, carries
// `manual: true`, and the existing note/category/date/ignore writes all work on it.
import { RMAuthError, RMGraphQLError, batchAliased, rmFullText } from "./graphql.js";
import { notATransactionId, searchTransactionsPage, setTransactionsNote } from "./transactions.js";
import { toCents } from "./format.js";
import { addDaysYmd } from "./windows.js";
function isRealDate(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd))
        return false;
    const d = new Date(`${ymd}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}
/** Validate one item and build RM's input. Throws with the reason when the item is unusable. */
export function toManualInput(t) {
    const name = t.name.trim();
    if (!name)
        throw new Error("name is empty");
    if (!isRealDate(t.date))
        throw new Error(`date "${t.date}" is not a real YYYY-MM-DD date`);
    const cents = toCents(Math.abs(t.amount));
    if (!Number.isFinite(t.amount) || cents === 0)
        throw new Error(`amount ${t.amount} must be a nonzero number of dollars`);
    return {
        name,
        date: t.date,
        amountCents: cents,
        direction: t.amount < 0 ? "income" : "spend",
        ...(t.categoryNodeId ? { categoryId: t.categoryNodeId } : {}),
    };
}
const ADD = `mutation AddManualTransaction($input: AddManualTransactionInput!) {
  addManualTransaction(input: $input) {
    transaction { id manual date amount __typename }
    __typename
  }
}`;
/** An existing row on the same date with the same signed amount and name (ignoring case), if any. */
async function findDuplicate(input) {
    const signed = input.direction === "income" ? -input.amountCents : input.amountCents;
    const { transactions } = await searchTransactionsPage({
        query: input.name,
        gteDate: input.date,
        ltDate: addDaysYmd(input.date, 1),
        limit: 200,
    });
    const want = input.name.toLowerCase();
    const hit = transactions.find((t) => t.date === input.date &&
        t.amountCents === signed &&
        [t.name, t.customName].some((n) => n?.trim().toLowerCase() === want));
    return hit?.nodeId ?? null;
}
/**
 * WRITE: create manual transactions, one request at a time, in order. Each is
 * checked against existing rows first (same date, amount and name) and the
 * existing id is returned instead, unless allowDuplicate. A create is never
 * retried: a request that fails in transit may still have created the row.
 * A dead session stops the batch; the rest are reported as not attempted.
 */
export async function createManualTransactions(items, opts = {}) {
    const out = [];
    const stop = (index, err) => {
        out.push({ index, error: `not created: ${err.message}` });
        for (let rest = index + 1; rest < items.length; rest++)
            out.push({ index: rest, error: "not attempted: the session died earlier in this batch" });
        return out;
    };
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        let input;
        try {
            input = toManualInput(item);
        }
        catch (err) {
            out.push({ index, error: err.message });
            continue;
        }
        try {
            if (!opts.allowDuplicate) {
                const existing = await findDuplicate(input);
                if (existing) {
                    out.push({ index, id: existing, duplicate: true });
                    continue;
                }
            }
        }
        catch (err) {
            if (err instanceof RMAuthError)
                return stop(index, err);
            out.push({ index, error: `duplicate check failed, so nothing was created: ${err.message}` });
            continue;
        }
        let id;
        try {
            const data = await rmFullText("AddManualTransaction", ADD, { input });
            id = data.addManualTransaction?.transaction?.id;
            if (!id)
                throw new RMGraphQLError("Rocket Money returned no transaction", data, []);
        }
        catch (err) {
            if (err instanceof RMAuthError)
                return stop(index, err);
            out.push({
                index,
                error: err instanceof RMGraphQLError
                    ? `Rocket Money refused it: ${err.message}`
                    : `the request failed in transit, so it may have been created anyway; check search_transactions before sending it again (${err.message})`,
            });
            continue;
        }
        const result = { index, id };
        if (item.note) {
            const [n] = await setTransactionsNote([{ nodeId: id, note: item.note }]).catch((e) => [{ id, note: null, error: e.message }]);
            if (n.error)
                result.note_error = n.error;
            else
                result.note = n.note;
        }
        out.push(result);
    }
    return out;
}
/**
 * WRITE: delete manual transactions. Each id is read first and only rows RM
 * marks `manual` are deleted; a bank-synced row is refused, never sent.
 */
export async function deleteManualTransactions(ids) {
    const out = ids.map((id) => {
        const why = notATransactionId(id);
        return why ? { id, error: why } : { id };
    });
    const look = ids.map((id, i) => ({ id, i })).filter((x) => !out[x.i].error);
    const flags = await batchAliased("ManualFlags", "query", "node", { name: "id", type: "ID!" }, "id\n    ... on Transaction { manual }\n    __typename", look.map((x) => x.id));
    const todo = [];
    look.forEach((x, k) => {
        const f = flags[k];
        if (!f.ok || !f.data)
            out[x.i].error = "no such transaction, or not one of yours";
        else if (f.data.manual !== true)
            out[x.i].error = "not a manual transaction (bank-synced rows can't be deleted)";
        else
            todo.push(x);
    });
    const deleted = await batchAliased("DeleteManualTransactions", "mutation", "deleteManualTransaction", { name: "input", type: "DeleteManualTransactionInput!" }, "deletedId\n    __typename", todo.map((x) => ({ transactionNodeId: x.id })));
    todo.forEach((x, k) => {
        const r = deleted[k];
        out[x.i] = r.ok && r.data?.deletedId ? { id: x.id, deleted: true } : { id: x.id, error: r.error ?? "not deleted" };
    });
    return out;
}
