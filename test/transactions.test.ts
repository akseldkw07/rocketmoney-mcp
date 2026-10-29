import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  partitionTransactionIds,
  setTransactionCategory,
  setTransactionsNote,
  toRMTransaction,
} from "../src/rm/transactions.js";
import { freshSession, mockGraphQL, realFetch } from "./helpers.js";

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("toRMTransaction reads ignore state, applied rules and both dates", () => {
  assert.deepEqual(
    toRMTransaction({
      __typename: "Transaction",
      id: "t1",
      amount: 113979,
      date: "2027-03-19",
      posted_date: "2026-10-20",
      longName: "Yoco *Stones SafarCAPE TOWN ZA",
      custom_name: null,
      note: null,
      ignoredFrom: "budget",
      transactionRuleNodeIds: ["r1", "r2"],
      category: { id: "c", label: "Travel & Vacation" },
      account: { id: "a" },
    }),
    {
      nodeId: "t1",
      amountCents: 113979,
      date: "2027-03-19",
      originalDate: "2026-10-20",
      note: null,
      name: "Yoco *Stones SafarCAPE TOWN ZA",
      customName: null,
      categoryLabel: "Travel & Vacation",
      accountId: "a",
      ignoredFrom: "budget",
      ruleIds: ["r1", "r2"],
    },
  );
  assert.equal(toRMTransaction({ id: "x" }), null);
});

test("apply_to_all reads the merchant name off the transaction, sweeps every page, and recategorizes all of them", async () => {
  freshSession();
  const ops = mockGraphQL((b) => {
    const node = (id: string) => ({ __typename: "Transaction", id, amount: 100, date: "2020-01-01" });
    const data =
      b.operationName === "TransactionName"
        ? { node: { id: "old", longName: "ACME CO" } }
        : b.operationName === "TransactionSearch"
          ? {
              viewer: {
                transactions: b.variables.cursor
                  ? { edges: [{ node: node("t3") }], pageInfo: { hasNextPage: false, endCursor: null } }
                  : { edges: [{ node: node("t1") }, { node: node("t2") }], pageInfo: { hasNextPage: true, endCursor: "c1" } },
              },
            }
          : { setTransactionsCategory: { countUpdated: (b.variables.input.transactionNodeIds as string[]).length } };
    return { data };
  });

  assert.equal(await setTransactionCategory("old", "cat", true), 4);
  assert.deepEqual(ops.map((o) => o.operationName), ["TransactionName", "TransactionSearch", "TransactionSearch", "SetTransactionsCategory"]);
  assert.equal(ops[1].variables.query, "ACME CO");
  assert.deepEqual(
    (ops[3].variables.input as { transactionNodeIds: string[] }).transactionNodeIds.sort(),
    ["old", "t1", "t2", "t3"],
  );
});

test("a non-transaction id is refused with a clear reason and never sent to Rocket Money", async () => {
  freshSession();
  const sent = mockGraphQL(() => ({ data: { a0: null }, errors: [{ message: "An error occurred.", path: ["a0"] }] }));
  const real = "VHJhbnNhY3Rpb246MTEyODExODAzNzkz"; // Transaction:112811803793
  const out = await setTransactionsNote([
    { nodeId: "bogus", note: "x" },
    { nodeId: real, note: "y" },
  ]);
  assert.match(out[0].error ?? "", /not a transaction id/);
  assert.match(out[1].error ?? "", /no such transaction, or not one of yours/);
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.values(sent[0].variables as object), [{ transactionNodeId: real, note: "y" }]);
  assert.deepEqual(partitionTransactionIds(["bogus", real]).valid, [real]);
});
