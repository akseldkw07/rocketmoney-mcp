import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { freshSession, mockGraphQL, realFetch } from "./helpers.js";
import {
  batchAliased,
  getBudgets,
  partitionTransactionIds,
  setTransactionCategory,
  setTransactionsNote,
  toRMTransaction,
} from "../src/rm/client.js";

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

test("batchAliased sends 50 aliases per request and keeps per-item failures to that item", async () => {
  freshSession();
  const requests = mockGraphQL((b) => {
    const vars = b.variables as Record<string, { id: string }>;
    const data: Record<string, unknown> = {};
    const errors: unknown[] = [];
    for (const [k, v] of Object.entries(vars)) {
      const alias = `a${k.slice(1)}`;
      if (v.id === "bad") {
        data[alias] = null;
        errors.push({ message: "An error occurred.", path: [alias] });
      } else data[alias] = { id: v.id };
    }
    return { data, ...(errors.length ? { errors } : {}) };
  });

  const inputs = Array.from({ length: 60 }, (_, i) => ({ id: i === 7 ? "bad" : `t${i}` }));
  const out = await batchAliased<{ id: string }>("Op", "mutation", "doThing", { name: "input", type: "In!" }, "id", inputs);
  assert.equal(requests.length, 2); // 50 + 10
  assert.match(String(requests[0].query), /^mutation Op\(\$v0: In!, .*\$v49: In!\)/s);
  assert.equal(out.length, 60);
  assert.deepEqual(out[7], { ok: false, error: "An error occurred." });
  assert.deepEqual(out[8], { ok: true, data: { id: "t8" } });
  assert.deepEqual(out[59], { ok: true, data: { id: "t59" } });
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

test("a rotated persisted hash falls back to the bundled query text", async () => {
  freshSession();
  const bodies = mockGraphQL((b) =>
    b.query ? { data: { viewer: { id: "v1" } } } : { errors: [{ message: "PersistedQueryNotFound" }] },
  );

  assert.deepEqual(await getBudgets(), { viewer: { id: "v1" } });
  assert.equal(bodies.length, 2);
  assert.ok((bodies[0].extensions as { persistedQuery?: unknown }).persistedQuery);
  assert.match(String(bodies[1].query), /^query Budgets/);
  assert.deepEqual(bodies[1].variables, bodies[0].variables);
});

test("RM calls run in parallel, at most 4 in flight", async () => {
  freshSession();
  let inFlight = 0;
  let peak = 0;
  mockGraphQL(async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return { data: { viewer: { id: "v" } } };
  });
  await Promise.all(Array.from({ length: 10 }, () => getBudgets()));
  assert.equal(peak, 4);
  assert.equal(inFlight, 0);
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
