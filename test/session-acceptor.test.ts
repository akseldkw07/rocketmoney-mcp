import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSessionAcceptor } from "../src/rm/login.js";

test("a sid that fails its probe is re-probed after the cooldown and accepted once it turns valid", async () => {
  let t = 0;
  let valid = false;
  const probes: string[] = [];
  const seeded: string[] = [];
  const accept = makeSessionAcceptor(
    async (h) => (probes.push(h), valid ? `${h}-live` : null),
    (h) => seeded.push(h),
    () => t,
  );
  const s = { sid: "abc", header: "tb.auth0.sid=abc" };

  assert.equal(await accept(s), false); // before login completes
  valid = true; // the same sid is now authenticated
  t = 5_000;
  assert.equal(await accept(s), false); // still cooling down: no probe
  assert.equal(probes.length, 1);
  t = 10_000;
  assert.equal(await accept(s), true);
  assert.deepEqual(seeded, ["tb.auth0.sid=abc-live"]);
});

test("a new sid is probed immediately and a missing sid never is", async () => {
  const probes: string[] = [];
  const accept = makeSessionAcceptor(async (h) => (probes.push(h), null), () => {}, () => 0);
  await accept({ sid: "a", header: "a" });
  await accept({ sid: "b", header: "b" });
  await accept({ sid: null, header: "" });
  assert.deepEqual(probes, ["a", "b"]);
});
