import { test } from "node:test";
import assert from "node:assert/strict";
import { tool } from "../src/tools/common.js";
import { RMGraphQLError } from "../src/rm/graphql.js";

const failWith = async (err: unknown) => {
  const r = await tool(async () => {
    throw err;
  })({});
  assert.equal(r.isError, true);
  return r.content[0].text;
};

test("a tool error keeps RM's GraphQL errors, with path and extensions", async () => {
  const text = await failWith(
    new RMGraphQLError("RM X: nope", null, [{ message: "nope", path: ["a0"], extensions: { code: "BAD" } } as never]),
  );
  assert.match(text, /RM X: nope/);
  assert.match(text, /"code":"BAD"/);
  assert.match(text, /"path":\["a0"\]/);
});

test("a tool error that isn't from RM keeps its stack and cause", async () => {
  const text = await failWith(new TypeError("fetch failed", { cause: new Error("ECONNRESET") }));
  assert.match(text, /TypeError: fetch failed/);
  assert.match(text, /\n\s+at /);
  assert.match(text, /Caused by: Error: ECONNRESET/);
});
