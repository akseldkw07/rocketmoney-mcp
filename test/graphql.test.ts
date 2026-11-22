import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { batchAliased, probeSession, RMGraphQLError } from "../src/rm/graphql.js";
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

test("reads send the bundled query text, never a persisted hash (F9)", async () => {
  freshSession();
  const bodies = mockGraphQL(() => ({ data: { viewer: { id: "v1" } } }));

  assert.deepEqual(await getBudgets(), { viewer: { id: "v1" } });
  assert.equal(bodies.length, 1, "one request: nothing to fall back from");
  assert.equal(bodies[0].operationName, "Budgets");
  assert.match(String(bodies[0].query), /^query Budgets/);
  assert.equal(bodies[0].extensions, undefined);
});

test("the session probe sends query text too", async () => {
  const bodies = mockGraphQL(() => ({ data: { viewer: { id: "v1" } } }));
  assert.ok(await probeSession("tb.auth0.sid=abc"));
  assert.match(String(bodies[0].query), /^query AuthenticationCheck/);
  assert.equal(bodies[0].extensions, undefined);
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

test("a read RM rejects as invalid says to regenerate the text, and keeps RM's errors", async () => {
  freshSession();
  const errors = [{ message: 'Cannot query field "foo" on type "User".', extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }];
  mockGraphQL(() => ({ errors }));
  await assert.rejects(getBudgets(), (err: unknown) => {
    assert.ok(err instanceof RMGraphQLError);
    assert.match(err.message, /Cannot query field "foo".*npm run refresh-query-text/);
    assert.deepEqual(err.errors, errors);
    return true;
  });
});

test("any other RM error on a read passes through unchanged", async () => {
  freshSession();
  mockGraphQL(() => ({ errors: [{ message: "An error occurred.", extensions: { code: "INTERNAL" } }] }));
  await assert.rejects(getBudgets(), (err: unknown) => err instanceof RMGraphQLError && !/refresh-query-text/.test(err.message));
});
