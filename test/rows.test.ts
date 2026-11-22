import { test } from "node:test";
import assert from "node:assert/strict";
import { afterEach } from "node:test";
import { compactTable, labelUnknownAccounts, shapeTxn } from "../src/rm/rows.js";
import { freshSession, mockGraphQL, realFetch } from "./helpers.js";
import type { RMTransaction } from "../src/rm/transactions.js";

const txn = (accountId: string | null, nodeId = "T1"): RMTransaction => ({
  nodeId,
  amountCents: -1234,
  date: "2026-11-01",
  originalDate: "2026-11-01",
  note: null,
  name: "Coffee",
  customName: null,
  categoryLabel: "Dining",
  accountId,
  ignoredFrom: null,
  ruleIds: [],
});

const labels = new Map([["QWNjb3VudDox", "Chase Sapphire 1234"]]);

test("an account missing from the enabled list is labeled switched off, keeping its id (F11)", () => {
  const row = shapeTxn(txn("QWNjb3VudDoy"), { labels, liveRules: null });
  assert.equal(row.account, "(switched off) QWNjb3VudDoy");
});

test("compact table labels known and switched-off accounts alike", () => {
  const table = compactTable([txn("QWNjb3VudDox", "T1"), txn("QWNjb3VudDoy", "T2")], labels);
  assert.deepEqual(table.accounts, ["Chase Sapphire 1234", "(switched off) QWNjb3VudDoy"]);
});

test("rows keep raw ids when account names couldn't load at all", () => {
  const row = shapeTxn(txn("QWNjb3VudDoy"), { labels: new Map(), liveRules: null });
  assert.equal(row.account, "QWNjb3VudDoy");
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a split part's row names its parent in split_of", () => {
  const row = shapeTxn({ ...txn("QWNjb3VudDox"), splitParentId: "P1" }, { labels, liveRules: null });
  assert.equal(row.split_of, "P1");
  assert.equal("split_of" in shapeTxn(txn("QWNjb3VudDox"), { labels, liveRules: null }), false);
});

test("accounts missing from the enabled list are looked up by id and labeled with their names (F14)", async () => {
  freshSession();
  const cash = "QWNjb3VudDo0NDAzMzYwNjY=";
  const closed = "QWNjb3VudDo3";
  const gone = "QWNjb3VudDo4";
  const sent = mockGraphQL((b) => {
    const nodes: Record<string, unknown> = {
      [cash]: { id: cash, name: "Cash", number: "0000", source: "manual", institution: { short_name: "Cash" } },
      [closed]: { id: closed, name: "Southwest", number: "0112", source: "plaid", institution: { short_name: "Chase" } },
    };
    return { data: Object.fromEntries(Object.entries(b.variables).map(([k, v]) => [`a${k.slice(1)}`, nodes[v as string] ?? null])) };
  });
  const { labels: all, warning } = await labelUnknownAccounts([txn(cash), txn(closed, "T2"), txn(gone, "T3"), txn("QWNjb3VudDox", "T4")], labels);
  assert.equal(warning, undefined);
  assert.equal(all.get(cash), `Cash (manual) ${cash}`);
  assert.equal(all.get(closed), `(switched off) Chase Southwest 0112 ${closed}`);
  assert.equal(all.has(gone), false);
  assert.equal(all.get("QWNjb3VudDox"), "Chase Sapphire 1234");
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.values(sent[0].variables).sort(), [cash, closed, gone].sort());
  // Cached: a second call for the same ids sends nothing.
  await labelUnknownAccounts([txn(cash)], labels);
  assert.equal(sent.length, 1);
});

test("a failed account lookup keeps the fallback labels and says why", async () => {
  freshSession();
  mockGraphQL(() => ({ data: { a0: null }, errors: [{ message: "boom", path: ["a0"], extensions: { code: "X" } }] }));
  const { labels: all, warning } = await labelUnknownAccounts([txn("QWNjb3VudDo5")], labels);
  assert.equal(all.has("QWNjb3VudDo5"), false);
  assert.match(warning!, /boom/);
});
