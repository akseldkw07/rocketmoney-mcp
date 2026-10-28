import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { probeSession } from "../src/rm/client.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(status: number, body: unknown, setCookies: string[] = []) {
  globalThis.fetch = (async () => {
    const headers = new Headers({ "content-type": "application/json" });
    for (const sc of setCookies) headers.append("set-cookie", sc);
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof fetch;
}

test("probeSession returns the rotated cookie header when the cookie is authenticated", async () => {
  respond(200, { data: { viewer: { id: "v1" } } }, ["tb.auth0.sid=new; Path=/; HttpOnly"]);
  assert.equal(await probeSession("tb.auth0.sid=old; AWSALB=x"), "tb.auth0.sid=new; AWSALB=x");
});

test("probeSession returns null for a stale cookie (401)", async () => {
  respond(401, {});
  assert.equal(await probeSession("tb.auth0.sid=stale"), null);
});

test("probeSession returns null when GraphQL says unauthenticated", async () => {
  respond(200, { errors: [{ message: "Not authenticated", extensions: { code: "UNAUTHENTICATED" } }] });
  assert.equal(await probeSession("tb.auth0.sid=stale"), null);
});

test("probeSession returns null on a network error", async () => {
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  assert.equal(await probeSession("tb.auth0.sid=x"), null);
});
