import { test } from "node:test";
import assert from "node:assert/strict";
import { installTimestamps } from "../src/log.js";

/** A stand-in console that records what each method was called with. */
function fakeConsole() {
  const calls: { method: string; args: unknown[] }[] = [];
  const c: Record<string, (...args: unknown[]) => void> = {};
  for (const method of ["log", "info", "warn", "error"]) c[method] = (...args) => void calls.push({ method, args });
  return { c, calls };
}

const at = () => new Date("2026-11-22T10:15:30.123Z");

test("every console method gets an ISO timestamp in front of its line", () => {
  const { c, calls } = fakeConsole();
  installTimestamps(c, at);
  c.log("[keepalive] ok");
  c.error("[login] failed:", new Error("x"));
  c.warn("[rm] %s retry", "op");
  c.info({ a: 1 });
  assert.deepEqual(calls[0], { method: "log", args: ["2026-11-22T10:15:30.123Z [keepalive] ok"] });
  assert.equal(calls[1].args[0], "2026-11-22T10:15:30.123Z [login] failed:");
  assert.ok(calls[1].args[1] instanceof Error, "later arguments pass through untouched");
  // A format string keeps working: the stamp goes into the format, not before it.
  assert.deepEqual(calls[2].args, ["2026-11-22T10:15:30.123Z [rm] %s retry", "op"]);
  // A non-string first argument gets the stamp as its own argument.
  assert.deepEqual(calls[3].args, ["2026-11-22T10:15:30.123Z", { a: 1 }]);
});

test("installing twice doesn't stamp twice", () => {
  const { c, calls } = fakeConsole();
  installTimestamps(c, at);
  installTimestamps(c, at);
  c.log("x");
  assert.deepEqual(calls[0].args, ["2026-11-22T10:15:30.123Z x"]);
});

test("a % in the timestamp position can't be read as a format directive", () => {
  const { c, calls } = fakeConsole();
  installTimestamps(c, at);
  c.log("100% done");
  assert.deepEqual(calls[0].args, ["2026-11-22T10:15:30.123Z 100% done"]);
});
