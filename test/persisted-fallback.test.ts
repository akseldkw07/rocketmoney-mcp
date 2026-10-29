import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSession } from "../src/rm/session.js";
import { getBudgets } from "../src/rm/client.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
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
