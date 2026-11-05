import { test } from "node:test";
import assert from "node:assert/strict";
import { compactTable, shapeTxn } from "../src/rm/rows.js";
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
