import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { batchAliased } from "../src/rm/graphql.js";
import { getBudgets } from "../src/rm/client.js";
import { freshSession, mockGraphQL, realFetch } from "./helpers.js";

afterEach(() => {
  globalThis.fetch = realFetch;
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
