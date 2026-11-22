import { test } from "node:test";
import assert from "node:assert/strict";
import { isNetworkError, rocketMoneyReachable } from "../src/rm/network.js";
import { runLoginSteps, startsCooldown, type LoginResult } from "../src/rm/login.js";
import { RMGraphQLError } from "../src/rm/graphql.js";

const withCode = (code: string) => Object.assign(new Error(code), { code });

test("Node/undici network failures are network errors, through the cause chain", () => {
  assert.equal(isNetworkError(new TypeError("fetch failed", { cause: withCode("ECONNRESET") })), true);
  assert.equal(isNetworkError(new TypeError("fetch failed", { cause: withCode("EAI_AGAIN") })), true);
  assert.equal(isNetworkError(new TypeError("fetch failed", { cause: withCode("UND_ERR_CONNECT_TIMEOUT") })), true);
  assert.equal(isNetworkError(withCode("ENOTFOUND")), true);
});

test("Chrome's net::ERR_ blips and timeouts are network errors", () => {
  for (const m of [
    "net::ERR_INTERNET_DISCONNECTED at https://app.rocketmoney.com/",
    "net::ERR_CONNECTION_RESET at https://app.rocketmoney.com/",
    "net::ERR_CONNECTION_CLOSED at https://app.rocketmoney.com/",
    "net::ERR_TIMED_OUT at https://app.rocketmoney.com/",
    "net::ERR_NETWORK_CHANGED at https://auth.rocketaccount.com/",
    "Navigation timeout of 90000 ms exceeded",
  ]) {
    assert.equal(isNetworkError(new Error(m)), true, m);
  }
  const t = new Error("Waiting failed: 30000ms exceeded");
  t.name = "TimeoutError";
  assert.equal(isNetworkError(t), true);
});

test("Rocket Money refusing, and everything else, is not a network error", () => {
  assert.equal(isNetworkError(new RMGraphQLError("RM X: An error occurred.", null, [{ message: "An error occurred." }])), false);
  assert.equal(isNetworkError(new Error("Rocket Money auth failed (HTTP 401). Re-auth at /auth.")), false);
  assert.equal(isNetworkError(new Error("net::ERR_CERT_AUTHORITY_INVALID at https://x/")), false);
  assert.equal(isNetworkError("boom"), false);
  assert.equal(isNetworkError(undefined), false);
});

test("any HTTP response means Rocket Money is reachable, even an error page", async () => {
  for (const status of [200, 302, 403, 503]) {
    const r = await rocketMoneyReachable(async () => new Response(null, { status }));
    assert.deepEqual(r, { ok: true, status });
  }
});

test("no response means unreachable, with the underlying error kept", async () => {
  const r = await rocketMoneyReachable(async () => {
    throw new TypeError("fetch failed", { cause: withCode("ENOTFOUND") });
  });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /TypeError: fetch failed.*ENOTFOUND/);
});

test("a failure that isn't the network propagates instead of passing for offline", async () => {
  await assert.rejects(
    rocketMoneyReachable(async () => {
      throw new RangeError("bad option");
    }),
    /bad option/,
  );
});

/** A scripted login: each doLogin call returns the next result; reachability likewise. */
function script(results: LoginResult[], reach: boolean[]) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      doLogin: async (_reason: string, headless: boolean) => {
        calls.push(headless ? "headless" : "headful");
        return results.shift() ?? { ok: false, error: "no more scripted results" };
      },
      reachable: async () => {
        calls.push("reach");
        const ok = reach.shift() ?? true;
        return ok ? ({ ok: true, status: 200 } as const) : ({ ok: false, error: "TypeError: fetch failed (ENOTFOUND)" } as const);
      },
    },
  };
}

test("unreachable at the start: no browser at all, reported offline", async () => {
  const s = script([], [false]);
  const r = await runLoginSteps("t", { mode: "auto", ...s.deps });
  assert.deepEqual(s.calls, ["reach"]);
  assert.equal(r.offline, true);
  assert.match(r.error!, /can't reach Rocket Money.*ENOTFOUND/);
});

test("the network drops during headless runs: no visible window", async () => {
  const s = script([{ ok: false, error: "timed out without a session cookie" }, { ok: false, error: "timed out" }], [true, true, false]);
  const r = await runLoginSteps("t", { mode: "auto", ...s.deps });
  assert.deepEqual(s.calls, ["reach", "headless", "reach", "headless", "reach"]);
  assert.equal(r.offline, true);
});

test("reachable throughout and headless keeps failing: the window is still the fallback", async () => {
  const s = script([{ ok: false, error: "a" }, { ok: false, error: "b" }, { ok: true }], []);
  const r = await runLoginSteps("t", { mode: "auto", ...s.deps });
  assert.deepEqual(s.calls, ["reach", "headless", "reach", "headless", "reach", "headful"]);
  assert.equal(r.ok, true);
});

test("headful-only mode checks reachability once, then logs in", async () => {
  const s = script([{ ok: true }], [true]);
  await runLoginSteps("t", { mode: "0", ...s.deps });
  assert.deepEqual(s.calls, ["reach", "headful"]);
});

test("an offline result doesn't start the login cooldown; anything else does", () => {
  assert.equal(startsCooldown({ ok: false, offline: true, error: "offline" }), false);
  assert.equal(startsCooldown({ ok: false, error: "timed out" }), true);
  assert.equal(startsCooldown({ ok: true }), true);
});
