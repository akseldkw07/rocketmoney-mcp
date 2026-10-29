// Shared test scaffolding: a throwaway live session and a fake Rocket Money API.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSession } from "../src/rm/session.js";

export const realFetch = globalThis.fetch;

/** Put the session file in a fresh temp dir and seed a live session into it. */
export function freshSession(): string {
  const dir = mkdtempSync(join(tmpdir(), "rm-test-"));
  process.env.ROCKETMONEY_STATE_DIR = dir;
  seedSession("tb.auth0.sid=test");
  return dir;
}

/** A JSON HTTP response, optionally with Set-Cookie headers. */
export function jsonResponse(body: unknown, status = 200, setCookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const sc of setCookies) headers.append("set-cookie", sc);
  return new Response(JSON.stringify(body), { status, headers });
}

// Tests reach into arbitrary variable shapes, so the body is loosely typed on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GraphQLBody = { operationName?: string; query?: string; variables: Record<string, any>; extensions?: unknown };

/**
 * Replace fetch with a fake GraphQL endpoint. `handler` gets each parsed request
 * body and returns the JSON response body ({data, errors}). Returns the list of
 * bodies sent, in order. Restore with `globalThis.fetch = realFetch`.
 */
export function mockGraphQL(handler: (body: GraphQLBody) => unknown | Promise<unknown>): GraphQLBody[] {
  const sent: GraphQLBody[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as GraphQLBody;
    sent.push(body);
    return jsonResponse(await handler(body));
  }) as typeof fetch;
  return sent;
}
