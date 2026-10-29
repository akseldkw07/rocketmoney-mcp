import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSession } from "../src/rm/session.js";
import { batchAliased, getBudgets, setTransactionCategory, toRMTransaction } from "../src/rm/client.js";

const realFetch = globalThis.fetch;
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
  process.env.ROCKETMONEY_STATE_DIR = mkdtempSync(join(tmpdir(), "rm-batch-"));
  seedSession("tb.auth0.sid=test");
  const requests: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    requests.push(b);
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
    return new Response(JSON.stringify({ data, ...(errors.length ? { errors } : {}) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

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
  process.env.ROCKETMONEY_STATE_DIR = mkdtempSync(join(tmpdir(), "rm-sweep-"));
  seedSession("tb.auth0.sid=test");
  const ops: { op: string; vars: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    ops.push({ op: b.operationName, vars: b.variables });
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
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  assert.equal(await setTransactionCategory("old", "cat", true), 4);
  assert.deepEqual(ops.map((o) => o.op), ["TransactionName", "TransactionSearch", "TransactionSearch", "SetTransactionsCategory"]);
  assert.equal(ops[1].vars.query, "ACME CO");
  assert.deepEqual(
    (ops[3].vars.input as { transactionNodeIds: string[] }).transactionNodeIds.sort(),
    ["old", "t1", "t2", "t3"],
  );
});

test("a rotated persisted hash falls back to the bundled query text", async () => {
  process.env.ROCKETMONEY_STATE_DIR = mkdtempSync(join(tmpdir(), "rm-pq-"));
  seedSession("tb.auth0.sid=test");
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    const json = b.query
      ? { data: { viewer: { id: "v1" } } }
      : { errors: [{ message: "PersistedQueryNotFound" }] };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  assert.deepEqual(await getBudgets(), { viewer: { id: "v1" } });
  assert.equal(bodies.length, 2);
  assert.ok((bodies[0].extensions as { persistedQuery?: unknown }).persistedQuery);
  assert.match(String(bodies[1].query), /^query Budgets/);
  assert.deepEqual(bodies[1].variables, bodies[0].variables);
});

test("RM calls run in parallel, at most 4 in flight", async () => {
  process.env.ROCKETMONEY_STATE_DIR = mkdtempSync(join(tmpdir(), "rm-conc-"));
  seedSession("tb.auth0.sid=test");
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = (async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return new Response(JSON.stringify({ data: { viewer: { id: "v" } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  await Promise.all(Array.from({ length: 10 }, () => getBudgets()));
  assert.equal(peak, 4);
  assert.equal(inFlight, 0);
});
