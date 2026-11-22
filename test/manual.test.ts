import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createManualTransactions, deleteManualTransactions, toManualInput } from "../src/rm/manual.js";
import { freshSession, mockGraphQL, realFetch, type GraphQLBody } from "./helpers.js";

afterEach(() => {
  globalThis.fetch = realFetch;
});

const T1 = "VHJhbnNhY3Rpb246MTE1MDAyMzE1OTcw"; // Transaction:115002315970
const T2 = "VHJhbnNhY3Rpb246NTY3MjUwMjM1NDg="; // Transaction:56725023548
/** The id fakeRM gives its nth new row (n from 900). */
const NEW = (n: number) => Buffer.from(`Transaction:${n}`).toString("base64");

test("toManualInput turns a signed USD amount into cents and a direction", () => {
  assert.deepEqual(toManualInput({ name: " Patrizia ", date: "2022-11-05", amount: 997.29, categoryNodeId: "c5" }), {
    name: "Patrizia",
    date: "2022-11-05",
    amountCents: 99729,
    direction: "spend",
    categoryId: "c5",
  });
  assert.deepEqual(toManualInput({ name: "Refund", date: "2021-04-01", amount: -0.1 }), {
    name: "Refund",
    date: "2021-04-01",
    amountCents: 10,
    direction: "income",
  });
});

test("toManualInput refuses a zero amount, an empty name and a bad date", () => {
  assert.throws(() => toManualInput({ name: "x", date: "2021-01-01", amount: 0 }), /amount/);
  assert.throws(() => toManualInput({ name: "  ", date: "2021-01-01", amount: 1 }), /name/);
  assert.throws(() => toManualInput({ name: "x", date: "2021-13-01", amount: 1 }), /date/);
  assert.throws(() => toManualInput({ name: "x", date: "2021-1-1", amount: 1 }), /date/);
});

/** A fake RM: TransactionSearch answers from `existing`, AddManualTransaction mints ids. */
function fakeRM(existing: { id: string; name: string; amount: number; date: string }[], addFails = false) {
  let next = 900;
  return mockGraphQL((b: GraphQLBody) => {
    if (b.operationName === "TransactionSearch") {
      const edges = existing
        .filter((t) => t.date >= b.variables.gteDate && t.date < b.variables.ltDate)
        .map((t) => ({ node: { __typename: "Transaction", id: t.id, amount: t.amount, date: t.date, longName: t.name } }));
      return { data: { viewer: { transactions: { edges, pageInfo: { hasNextPage: false, endCursor: null } } } } };
    }
    if (b.operationName === "AddManualTransaction") {
      if (addFails) return { data: { addManualTransaction: null }, errors: [{ message: "An error occurred.", path: ["addManualTransaction"] }] };
      const i = b.variables.input;
      return { data: { addManualTransaction: { transaction: { id: NEW(next++), manual: true, date: i.date, amount: i.amountCents } } } };
    }
    if (b.operationName === "SetTransactionNotes") {
      return { data: { a0: { transaction: { id: b.variables.v0.transactionNodeId, note: b.variables.v0.note } } } };
    }
    throw new Error(`unexpected ${b.operationName}`);
  });
}

test("create returns an existing same-date, same-amount, same-name row instead of adding a second one", async () => {
  freshSession();
  const sent = fakeRM([{ id: T1, name: "patrizia", amount: 99729, date: "2022-11-05" }]);
  const out = await createManualTransactions([{ name: "Patrizia", date: "2022-11-05", amount: 997.29 }]);
  assert.deepEqual(out, [{ index: 0, id: T1, duplicate: true }]);
  assert.deepEqual(sent.map((s) => s.operationName), ["TransactionSearch"]);
  assert.equal(sent[0].variables.gteDate, "2022-11-05");
  assert.equal(sent[0].variables.ltDate, "2022-11-06");
});

test("a different amount or name on the same day is not a duplicate", async () => {
  freshSession();
  const sent = fakeRM([
    { id: T1, name: "Patrizia", amount: 5000, date: "2022-11-05" },
    { id: T2, name: "Patrizia Bar", amount: 99729, date: "2022-11-05" },
  ]);
  const out = await createManualTransactions([{ name: "Patrizia", date: "2022-11-05", amount: 997.29 }]);
  assert.deepEqual(out, [{ index: 0, id: NEW(900) }]);
  assert.deepEqual(sent.map((s) => s.operationName), ["TransactionSearch", "AddManualTransaction"]);
  assert.deepEqual(sent[1].variables.input, { name: "Patrizia", date: "2022-11-05", amountCents: 99729, direction: "spend" });
});

test("income matches an existing row by its negative amount", async () => {
  freshSession();
  fakeRM([{ id: T1, name: "Cash gift", amount: -2000, date: "2021-05-01" }]);
  const out = await createManualTransactions([{ name: "Cash gift", date: "2021-05-01", amount: -20 }]);
  assert.deepEqual(out, [{ index: 0, id: T1, duplicate: true }]);
});

test("allow_duplicate skips the lookup and creates anyway", async () => {
  freshSession();
  const sent = fakeRM([{ id: T1, name: "Patrizia", amount: 99729, date: "2022-11-05" }]);
  const out = await createManualTransactions([{ name: "Patrizia", date: "2022-11-05", amount: 997.29 }], { allowDuplicate: true });
  assert.deepEqual(out, [{ index: 0, id: NEW(900) }]);
  assert.deepEqual(sent.map((s) => s.operationName), ["AddManualTransaction"]);
});

test("a note is saved on the new row after it is created", async () => {
  freshSession();
  const sent = fakeRM([]);
  const out = await createManualTransactions([{ name: "Cash", date: "2021-05-01", amount: 3, note: "tip" }]);
  assert.deepEqual(out, [{ index: 0, id: NEW(900), note: "tip" }]);
  assert.deepEqual(sent.map((s) => s.operationName), ["TransactionSearch", "AddManualTransaction", "SetTransactionNotes"]);
  assert.deepEqual(sent[2].variables.v0, { transactionNodeId: NEW(900), note: "tip" });
});

test("a batch goes one at a time; a refused create is reported once and never retried", async () => {
  freshSession();
  const sent = fakeRM([], true);
  const out = await createManualTransactions([
    { name: "A", date: "2021-05-01", amount: 1 },
    { name: "B", date: "2021-05-02", amount: 0 },
    { name: "C", date: "2021-05-03", amount: 2 },
  ]);
  assert.equal(out.length, 3);
  assert.match(out[0].error!, /refused/);
  assert.match(out[1].error!, /amount/);
  assert.match(out[2].error!, /refused/);
  assert.equal(sent.filter((s) => s.operationName === "AddManualTransaction").length, 2);
});

test("a create that fails in transit says it may have gone through", async () => {
  freshSession();
  globalThis.fetch = (async (_u: string, init: { body: string }) => {
    const b = JSON.parse(init.body) as GraphQLBody;
    if (b.operationName === "AddManualTransaction") throw new TypeError("fetch failed");
    return new Response(
      JSON.stringify({ data: { viewer: { transactions: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const [r] = await createManualTransactions([{ name: "A", date: "2021-05-01", amount: 1 }]);
  assert.match(r.error!, /may have been created/);
});

test("delete removes manual rows and refuses bank rows, missing rows and non-transaction ids", async () => {
  freshSession();
  const manual = new Map([
    [T1, true],
    [T2, false],
  ]);
  const sent = mockGraphQL((b) => {
    if (b.operationName === "ManualFlags") {
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b.variables)) data[`a${k.slice(1)}`] = manual.has(v as string) ? { id: v, manual: manual.get(v as string) } : null;
      return { data };
    }
    if (b.operationName === "DeleteManualTransactions") {
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b.variables)) data[`a${k.slice(1)}`] = { deletedId: (v as { transactionNodeId: string }).transactionNodeId };
      return { data };
    }
    throw new Error(`unexpected ${b.operationName}`);
  });
  const gone = "VHJhbnNhY3Rpb246MQ=="; // Transaction:1, not found
  const out = await deleteManualTransactions([T1, T2, gone, "nope"]);
  assert.deepEqual(out[0], { id: T1, deleted: true });
  assert.match(out[1].error!, /not a manual transaction/);
  assert.match(out[2].error!, /no such transaction/);
  assert.match(out[3].error!, /not a transaction id/);
  const del = sent.find((s) => s.operationName === "DeleteManualTransactions")!;
  assert.deepEqual(Object.values(del.variables), [{ transactionNodeId: T1 }]);
});
