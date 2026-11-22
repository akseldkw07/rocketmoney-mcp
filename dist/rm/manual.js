/**
 * Manual transactions: rows typed in by hand rather than synced from a bank,
 * e.g. cash, or a card that was never linked or is closed.
 *
 * ## Where the API comes from
 *
 * The web app has no screen for these (only the phone app does), but its API
 * takes them: the bundle's own schema lists addManualTransaction and
 * deleteManualTransaction, and on 2026-11-22 both worked with the web session.
 * Inputs, read from validation errors since introspection is off:
 *
 *   AddManualTransactionInput { name: String!, amountCents: BigInt!,
 *     direction: ManualTransactionDirection! (spend | income), date: Date!,
 *     categoryId: ID, accountId: ID }
 *   DeleteManualTransactionInput { transactionNodeId: ID! }
 *   SetTransactionTaxDeductibleInput { transactionNodeId: ID!, taxDeductible: Boolean! }
 *
 * ## What a create can set, and what it can't
 *
 * Set by the create itself: name, date, amount and direction, category, account.
 * Set right after it, by the same calls the other write tools use: note, ignore
 * state, tax deductible, and last a split into parts (splits.ts). Each of those
 * is a separate request, so it can fail on its own; the row then exists without
 * it, and the result says which one failed (`not_applied`) with Rocket Money's
 * error.
 *
 * Not settable through this module, and why:
 * - **Amount or direction after creation.** RM has no mutation that edits a
 *   transaction's amount. Delete the row and create it again.
 * - **Account after creation.** The account is fixed when the row is made;
 *   there is no move-to-account mutation. Delete and recreate to move it.
 * - **A rename (custom_name) separate from the name.** A manual row's name is
 *   whatever you create it with, so a rename adds nothing here.
 * - **Merchant/logo (service), subscription link, rewards, pending/status.**
 *   RM derives these from bank data; the input has no field for them.
 *
 * ## Behavior (tested 2026-11-22 with $0.01 rows, all deleted)
 *
 * With no accountId RM files the row under a manual "Cash" account it creates.
 * accountId also takes a bank-linked account. The row takes back-dating (2021
 * and 2022 tested), counts in spending, carries `manual: true` (bank rows read
 * `false`), stores income as a negative amount, and the existing
 * note/category/date/ignore/tax-deductible writes all work on it.
 *
 * ## Errors
 *
 * Nothing is reworded away: every failure keeps Rocket Money's own error text
 * and, in `detail`, the error's type, its GraphQL errors (with path and
 * extensions) and, for anything that isn't an RM error, the stack.
 */
import { RMAuthError, RMGraphQLError, batchAliased, rmFullText } from "./graphql.js";
import { notATransactionId, searchTransactionsPage, setTransactionsIgnored, setTransactionsNote } from "./transactions.js";
import { toCents } from "./format.js";
import { addDaysYmd } from "./windows.js";
import { splitTransaction } from "./splits.js";
export function errorDetail(err) {
    if (!(err instanceof Error))
        return { type: typeof err, message: String(err) };
    const d = { type: err.constructor.name, message: err.message };
    if (err instanceof RMGraphQLError && err.errors.length)
        d.graphql_errors = err.errors;
    if (!(err instanceof RMGraphQLError) && !(err instanceof RMAuthError) && err.stack)
        d.stack = err.stack;
    if (err.cause !== undefined)
        d.cause = err.cause instanceof Error ? `${err.cause.name}: ${err.cause.message}` : String(err.cause);
    return d;
}
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
        ...(t.accountNodeId ? { accountId: t.accountNodeId } : {}),
    };
}
const ADD = `mutation AddManualTransaction($input: AddManualTransactionInput!) {
  addManualTransaction(input: $input) {
    transaction { id manual date amount __typename }
    __typename
  }
}`;
const TAX = `mutation SetTransactionTaxDeductible($input: SetTransactionTaxDeductibleInput!) {
  setTransactionTaxDeductible(input: $input) {
    transactions { id taxDeductible __typename }
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
/** Run one follow-up write; on failure record RM's error under `field` instead of losing it. */
async function followUp(result, field, run) {
    try {
        await run();
    }
    catch (err) {
        (result.not_applied ??= {})[field] = errorDetail(err);
    }
}
/**
 * WRITE: create manual transactions, one request at a time, in order. Each is
 * checked against existing rows first (same date, amount and name) and the
 * existing id is returned instead, unless allowDuplicate. A create is never
 * retried: a request that fails in transit may still have created the row.
 * A dead session stops the batch; the rest are reported as not attempted.
 * Every failure carries `detail` (see errorDetail) next to its summary.
 */
export async function createManualTransactions(items, opts = {}) {
    const out = [];
    const stop = (index, err) => {
        out.push({ index, error: `not created: the session is not active`, detail: errorDetail(err) });
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
            out.push({ index, error: err.message, detail: errorDetail(err) });
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
            out.push({ index, error: "not created: the duplicate check failed", detail: errorDetail(err) });
            continue;
        }
        let id;
        try {
            const data = await rmFullText("AddManualTransaction", ADD, { input });
            id = data.addManualTransaction?.transaction?.id;
            if (!id)
                throw new RMGraphQLError(`RM AddManualTransaction returned no transaction: ${JSON.stringify(data)}`, data, []);
        }
        catch (err) {
            if (err instanceof RMAuthError)
                return stop(index, err);
            out.push({
                index,
                error: err instanceof RMGraphQLError
                    ? `Rocket Money refused it: ${err.message}`
                    : `the request failed in transit, so it may have been created anyway; check search_transactions before sending it again: ${err.message}`,
                detail: errorDetail(err),
            });
            continue;
        }
        const result = { index, id };
        const newId = id;
        if (item.note) {
            await followUp(result, "note", async () => {
                const [n] = await setTransactionsNote([{ nodeId: newId, note: item.note }]);
                if (n.error)
                    throw new Error(n.error);
                result.note = n.note;
            });
        }
        if (item.ignore) {
            await followUp(result, "ignore", async () => {
                const updated = await setTransactionsIgnored([newId], item.ignore);
                if (updated !== 1)
                    throw new Error(`RM SetTransactionsIgnored reported countUpdated ${updated}, expected 1`);
            });
        }
        if (item.taxDeductible !== undefined) {
            await followUp(result, "tax_deductible", async () => {
                const data = await rmFullText("SetTransactionTaxDeductible", TAX, { input: { transactionNodeId: newId, taxDeductible: item.taxDeductible } });
                const saved = data.setTransactionTaxDeductible?.transactions?.[0]?.taxDeductible;
                if (saved !== item.taxDeductible)
                    throw new Error(`RM SetTransactionTaxDeductible returned ${JSON.stringify(data)}`);
            });
        }
        if (item.splits?.length) {
            await followUp(result, "split", async () => {
                const split = await splitTransaction(newId, item.splits);
                result.split_parts = split.parts.map((p) => p.id);
            });
        }
        out.push(result);
    }
    return out;
}
/**
 * WRITE: delete manual transactions. Each id is read first and only rows RM
 * marks `manual` are deleted; a bank-synced row is refused, never sent. A part
 * of a split is refused too: parts read `manual: true` even under a bank row,
 * and deleting one leaves the split no longer adding up (unsplit instead).
 * Deleting a split parent deletes its parts with it (split_parts_deleted). RM's
 * own error text is kept wherever it gave one.
 */
export async function deleteManualTransactions(ids) {
    const out = ids.map((id) => {
        const why = notATransactionId(id);
        return why ? { id, error: why } : { id };
    });
    const look = ids.map((id, i) => ({ id, i })).filter((x) => !out[x.i].error);
    const flags = await batchAliased("ManualFlags", "query", "node", { name: "id", type: "ID!" }, "id\n    ... on Transaction { manual splitStatus splitParentTransaction { id } splitTransactions { id } }\n    __typename", look.map((x) => x.id));
    const todo = [];
    look.forEach((x, k) => {
        const f = flags[k];
        // batchAliased reports a null node with no error as "no result returned": the row doesn't exist.
        if (!f.ok && f.error !== "no result returned")
            out[x.i].error = `could not read it, so not deleted: ${f.error}`;
        else if (!f.data)
            out[x.i].error = "Rocket Money returned null for it, with no error: no such transaction, or not one of yours";
        else if (f.data.splitParentTransaction) {
            out[x.i].error = `part of a split, so not deleted: unsplit_transaction its parent ${f.data.splitParentTransaction.id} (or delete the parent, if that is manual)`;
        }
        else if (f.data.manual !== true)
            out[x.i].error = "not a manual transaction (bank-synced rows can't be deleted)";
        else
            todo.push({ ...x, parts: f.data.splitTransactions?.length ?? 0 });
    });
    const deleted = await batchAliased("DeleteManualTransactions", "mutation", "deleteManualTransaction", { name: "input", type: "DeleteManualTransactionInput!" }, "deletedId\n    __typename", todo.map((x) => ({ transactionNodeId: x.id })));
    todo.forEach((x, k) => {
        const r = deleted[k];
        out[x.i] = r.ok && r.data?.deletedId
            ? { id: x.id, deleted: true, ...(x.parts ? { split_parts_deleted: x.parts } : {}) }
            : { id: x.id, error: `Rocket Money did not delete it: ${r.error ?? `returned ${JSON.stringify(r.data)}`}` };
    });
    return out;
}
