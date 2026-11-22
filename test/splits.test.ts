import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { splitTransaction, toSplitInputs, unsplitTransaction } from "../src/rm/splits.js";
import { RMGraphQLError } from "../src/rm/graphql.js";
import { freshSession, mockGraphQL, realFetch, type GraphQLBody } from "./helpers.js";

afterEach(() => {
  globalThis.fetch = realFetch;
});

const P = "VHJhbnNhY3Rpb246MTE1MDAyOTU5NTY5"; // Transaction:115002959569
const C1 = "VHJhbnNhY3Rpb246MTE1MDAyOTU5NjY0";
const C2 = "VHJhbnNhY3Rpb246MTE1MDAyOTU5NjY5";

test("split parts go out in cents with the parent's sign, and null for what isn't given", () => {
  assert.deepEqual(
    toSplitInputs(2000, [
      { amount: 12.5, categoryNodeId: "med", name: "Dinner (mine)", note: "n" },
      { amount: 7.5, categoryNodeId: "gro", ignore: "budget" },
    ]),
    [
      { amount: 1250, transactionCategoryNodeId: "med", customName: "Dinner (mine)", note: "n", ignoredFrom: null },
      { amount: 750, transactionCategoryNodeId: "gro", customName: null, note: null, ignoredFrom: "budget" },
    ],
  );
  assert.deepEqual(
    toSplitInputs(-300, [
      { amount: 1, categoryNodeId: "a" },
      { amount: 2, categoryNodeId: "b" },
    ]).map((s) => s.amount),
    [-100, -200],
  );
});

test("split parts are checked before anything is sent", () => {
  assert.throws(() => toSplitInputs(200, [{ amount: 2, categoryNodeId: "a" }]), /at least 2/);
  assert.throws(() => toSplitInputs(200, [{ amount: 2, categoryNodeId: "a" }, { amount: 0, categoryNodeId: "b" }]), /part 2.*amount/);
  assert.throws(() => toSplitInputs(200, [{ amount: 1, categoryNodeId: "a" }, { amount: 1, categoryNodeId: "" }]), /part 2.*category/);
  assert.throws(
    () => toSplitInputs(200, [{ amount: 1, categoryNodeId: "a" }, { amount: 2, categoryNodeId: "b" }]),
    /add up to \$3\.00.*\$2\.00/,
  );
});

/** A fake RM holding one transaction tree. */
function fakeRM(nodes: Record<string, { amount: number; splitStatus: string | null; parent?: string }>, splitFails = false) {
  return mockGraphQL((b: GraphQLBody) => {
    if (b.operationName === "SplitTarget") {
      const n = nodes[b.variables.id];
      return {
        data: {
          node: n
            ? { __typename: "Transaction", id: b.variables.id, amount: n.amount, splitStatus: n.splitStatus, splitParentTransaction: n.parent ? { id: n.parent } : null }
            : null,
        },
      };
    }
    if (b.operationName === "SplitTransactionMutation") {
      if (splitFails) {
        return { data: { splitTransaction: null }, errors: [{ message: "An error occurred.", path: ["splitTransaction"], extensions: { code: "USER_ERROR" } }] };
      }
      const parts = b.variables.input.splits as { amount: number; customName: string | null }[];
      return {
        data: {
          splitTransaction: {
            transaction: {
              id: b.variables.input.transactionNodeId,
              amount: parts.reduce((s, p) => s + p.amount, 0),
              splitStatus: "parent",
              splitTransactions: parts.map((p, i) => ({
                id: [C1, C2][i],
                amount: p.amount,
                custom_name: p.customName,
                note: null,
                ignoredFrom: null,
                category: { label: "Groceries" },
              })),
            },
          },
        },
      };
    }
    if (b.operationName === "UnsplitTransactionMutation") {
      return { data: { unsplitTransaction: { transaction: { id: b.variables.input.transactionNodeId, amount: 200, splitStatus: null, category: { label: "Medical" } } } } };
    }
    throw new Error(`unexpected ${b.operationName}`);
  });
}

test("split reads the parent, sends the parts and returns them in dollars", async () => {
  freshSession();
  const sent = fakeRM({ [P]: { amount: 200, splitStatus: null } });
  const out = await splitTransaction(P, [
    { amount: 1, categoryNodeId: "gro", name: "A" },
    { amount: 1, categoryNodeId: "gro" },
  ]);
  assert.deepEqual(sent.map((s) => s.operationName), ["SplitTarget", "SplitTransactionMutation"]);
  assert.equal(sent[1].variables.input.splitStatus, "child");
  assert.equal(sent[1].variables.input.transactionNodeId, P);
  assert.deepEqual(out, {
    parent_id: P,
    amount: 2,
    parts: [
      { id: C1, amount: 1, name: "A", category: "Groceries", note: null, ignore: null },
      { id: C2, amount: 1, name: null, category: "Groceries", note: null, ignore: null },
    ],
  });
});

test("splitting a split part is refused and names the parent", async () => {
  freshSession();
  const sent = fakeRM({ [C1]: { amount: 100, splitStatus: "child", parent: P } });
  await assert.rejects(
    splitTransaction(C1, [
      { amount: 0.5, categoryNodeId: "a" },
      { amount: 0.5, categoryNodeId: "b" },
    ]),
    new RegExp(`part of a split.*${P}`),
  );
  assert.deepEqual(sent.map((s) => s.operationName), ["SplitTarget"]);
});

test("a missing transaction says Rocket Money returned null for it", async () => {
  freshSession();
  fakeRM({});
  await assert.rejects(unsplitTransaction(P), /returned null/);
});

test("RM refusing a split propagates as its own error, codes included", async () => {
  freshSession();
  fakeRM({ [P]: { amount: 200, splitStatus: null } }, true);
  await assert.rejects(
    splitTransaction(P, [
      { amount: 1, categoryNodeId: "a" },
      { amount: 1, categoryNodeId: "b" },
    ]),
    (err: unknown) => err instanceof RMGraphQLError && JSON.stringify(err.errors).includes("USER_ERROR"),
  );
});

test("unsplit given a part unsplits its parent", async () => {
  freshSession();
  const sent = fakeRM({ [C1]: { amount: 100, splitStatus: "child", parent: P } });
  const out = await unsplitTransaction(C1);
  assert.equal(sent[1].variables.input.transactionNodeId, P);
  assert.deepEqual(out, { parent_id: P, amount: 2, category: "Medical" });
});

test("unsplit refuses a transaction that isn't split", async () => {
  freshSession();
  const sent = fakeRM({ [P]: { amount: 200, splitStatus: null } });
  await assert.rejects(unsplitTransaction(P), /not split/);
  assert.equal(sent.length, 1);
});
