import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDocuments, extractHashes, persistedOps, rewritePersisted } from "../scripts/refresh-hashes.js";

const H = (c: string) => c.repeat(64);

const CLIENT = `const X = 1;
const PERSISTED = {
  Budgets: "${H("a")}",
  SpendingPage: "${H("b")}",
  TransactionsPageTransactionTable:
    "${H("c")}",
  // a comment that must survive
  TransactionCategories: "${H("d")}",
} as const;
const Y = 2;`;

const entry = (method: string, url: string, text?: string) => ({
  request: { method, url, ...(text ? { postData: { text } } : {}) },
});
const body = (op: string, hash: string) =>
  JSON.stringify({ operationName: op, variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: hash } } });

test("extractHashes reads POST bodies, batched arrays and APQ GETs, newest wins", () => {
  const har = {
    log: {
      entries: [
        entry("POST", "https://client-api.rocketmoney.com/graphql", body("Budgets", H("1"))),
        entry("POST", "https://client-api.rocketmoney.com/graphql", body("Budgets", H("2"))),
        entry(
          "POST",
          "https://client-api.rocketmoney.com/graphql",
          `[${body("SpendingPage", H("3"))},${body("NewOp", H("4"))}]`,
        ),
        entry(
          "GET",
          `https://client-api.rocketmoney.com/graphql?operationName=TransactionsPageTransactionTable&extensions=${encodeURIComponent(
            JSON.stringify({ persistedQuery: { version: 1, sha256Hash: H("5") } }),
          )}`,
        ),
        entry("POST", "https://client-api.rocketmoney.com/graphql", JSON.stringify({ operationName: "Write", query: "mutation" })),
        entry("POST", "https://example.com/other", body("Budgets", H("9"))),
      ],
    },
  };
  assert.deepEqual(
    Object.fromEntries(extractHashes(har)),
    { Budgets: H("2"), SpendingPage: H("3"), NewOp: H("4"), TransactionsPageTransactionTable: H("5") },
  );
});

test("rewritePersisted updates only captured ops and reports the rest", () => {
  const r = rewritePersisted(
    CLIENT,
    new Map([
      ["Budgets", H("a")],
      ["SpendingPage", H("e")],
      ["TransactionsPageTransactionTable", H("f")],
      ["NewOp", H("0")],
    ]),
  );
  assert.deepEqual(r.updated.map((u) => u.op), ["SpendingPage", "TransactionsPageTransactionTable"]);
  assert.deepEqual(r.unchanged, ["Budgets"]);
  assert.deepEqual(r.notCaptured, ["TransactionCategories"]);
  assert.deepEqual(r.notInPersisted, ["NewOp"]);
  assert.ok(r.source.includes(`SpendingPage: "${H("e")}"`));
  assert.ok(r.source.includes(`TransactionsPageTransactionTable:\n    "${H("f")}"`));
  assert.ok(r.source.includes("// a comment that must survive"));
  assert.ok(r.source.startsWith("const X = 1;") && r.source.endsWith("const Y = 2;"));
  assert.deepEqual(persistedOps(r.source), ["Budgets", "SpendingPage", "TransactionsPageTransactionTable", "TransactionCategories"]);
});

test("extractDocuments prints minified document literals with __typename added", async () => {
  // How the bundle ships a compiled query: a plain object literal, booleans minified.
  const js = `var d={kind:"Document",definitions:[{kind:"OperationDefinition",operation:"query",name:{kind:"Name",value:"Budgets"},variableDefinitions:[],directives:[],selectionSet:{kind:"SelectionSet",selections:[{kind:"Field",name:{kind:"Name",value:"viewer"},arguments:[],directives:[],selectionSet:{kind:"SelectionSet",selections:[{kind:"Field",name:{kind:"Name",value:"id"},arguments:[],directives:[]}]}}]}}],loc:{start:0,end:30,x:!0}};`;
  const docs = await extractDocuments(js);
  assert.equal(docs.get("Budgets"), "query Budgets {\n  viewer {\n    id\n    __typename\n  }\n}");
});
