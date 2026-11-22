import { test } from "node:test";
import assert from "node:assert/strict";
import { renewDue, waitForSessionOrForm } from "../src/rm/login.js";

const MIN = 60_000;
const seeded = "2026-11-22T11:28:39.000Z";
const at = (minutes: number) => Date.parse(seeded) + minutes * MIN;

test("a live session is due for renewal once it is older than the threshold", () => {
  assert.equal(renewDue({ status: "live", seededAt: seeded }, at(39), 40 * MIN), false);
  assert.equal(renewDue({ status: "live", seededAt: seeded }, at(40), 40 * MIN), true);
});

test("renewal never runs for a dead or missing session, without a seed time, or when switched off", () => {
  assert.equal(renewDue({ status: "dead", seededAt: seeded }, at(90), 40 * MIN), false);
  assert.equal(renewDue({ status: "missing" }, at(90), 40 * MIN), false);
  assert.equal(renewDue({ status: "live" }, at(90), 40 * MIN), false);
  assert.equal(renewDue({ status: "live", seededAt: seeded }, at(90), 0), false);
});

/** A clock that advances by each sleep, so the wait runs instantly. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

test("a session that turns up after the first check is still accepted (late warm renewal)", async () => {
  const clock = fakeClock();
  let checks = 0;
  const r = await waitForSessionOrForm({
    accept: async () => ++checks >= 4, // the app finishes its silent sign-in a few seconds in
    findForm: async () => null,
    timeoutMs: 45_000,
    tickMs: 1500,
    ...clock,
  });
  assert.deepEqual(r, { kind: "session" });
  assert.equal(checks, 4);
});

test("a login form is returned as soon as it shows", async () => {
  const clock = fakeClock();
  let ticks = 0;
  const r = await waitForSessionOrForm({
    accept: async () => false,
    findForm: async () => (++ticks >= 3 ? "FORM" : null),
    timeoutMs: 45_000,
    tickMs: 1500,
    ...clock,
  });
  assert.deepEqual(r, { kind: "form", form: "FORM" });
});

test("the session wins when both are there on the same tick", async () => {
  const clock = fakeClock();
  const r = await waitForSessionOrForm({ accept: async () => true, findForm: async () => "FORM", timeoutMs: 1000, tickMs: 500, ...clock });
  assert.deepEqual(r, { kind: "session" });
});

test("neither within the timeout says so", async () => {
  const clock = fakeClock();
  const r = await waitForSessionOrForm({ accept: async () => false, findForm: async () => null, timeoutMs: 6000, tickMs: 1500, ...clock });
  assert.deepEqual(r, { kind: "neither" });
  assert.ok(clock.now() >= 6000);
});

test("a check that throws mid-navigation skips the tick instead of failing the wait", async () => {
  const clock = fakeClock();
  let n = 0;
  const r = await waitForSessionOrForm({
    accept: async () => {
      if (++n === 1) throw new Error("Execution context was destroyed");
      return n >= 2;
    },
    findForm: async () => null,
    timeoutMs: 10_000,
    tickMs: 1000,
    ...clock,
  });
  assert.deepEqual(r, { kind: "session" });
});
