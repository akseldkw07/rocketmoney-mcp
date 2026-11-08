import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRulePrecedence, formatReport } from "../scripts/check-rules.js";

type Rule = Parameters<typeof checkRulePrecedence>[0][number];
type Txn = Parameters<typeof checkRulePrecedence>[1][number];

const rule = (id: string, category_label: string | null): Rule => ({ id, updates: { category_label } });
const txn = (nodeId: string, categoryLabel: string | null, ruleIds: string[]): Txn => ({
  nodeId,
  date: "2026-10-01",
  name: `txn ${nodeId}`,
  categoryLabel,
  ruleIds,
});

const RULES = [rule("r1", "Dining"), rule("r2", "Groceries"), rule("r3", "Travel"), rule("rename", null)];

test("transactions without two live rules setting different categories are not conflicts", () => {
  const r = checkRulePrecedence(RULES, [
    txn("a", "Dining", []),
    txn("b", "Dining", ["r1"]),
    txn("c", "Dining", ["r1", "rename"]), // a rename-only rule sets no category
    txn("d", "Groceries", ["r2", "deleted-rule"]), // deleted rules don't count
    txn("e", "Dining", ["r1", "r1"]),
  ]);
  assert.equal(r.transactions, 5);
  assert.equal(r.conflicts, 0);
  assert.deepEqual([r.last.length, r.first.length, r.neither.length], [0, 0, 0]);
});

test("each conflict is classed by which rule's category it carries: last, first or neither", () => {
  const r = checkRulePrecedence(RULES, [
    txn("last", "Groceries", ["r1", "r2"]),
    txn("first", "Dining", ["r1", "rename", "r2"]),
    txn("hand", "Shopping", ["r1", "r2"]),
    txn("mid", "Groceries", ["r1", "r2", "r3"]), // the middle rule won: neither first nor last
  ]);
  assert.equal(r.conflicts, 4);
  assert.deepEqual(
    r.last.map((c) => c.id),
    ["last"],
  );
  assert.deepEqual(
    r.first.map((c) => c.id),
    ["first"],
  );
  assert.deepEqual(
    r.neither.map((c) => c.id),
    ["hand", "mid"],
  );
  assert.deepEqual(r.first[0], {
    id: "first",
    date: "2026-10-01",
    name: "txn first",
    category: "Dining",
    rules: [
      { id: "r1", category: "Dining" },
      { id: "r2", category: "Groceries" },
    ],
  });
});

test("formatReport gives counts, the verdict and a few examples per class", () => {
  const none = formatReport(checkRulePrecedence(RULES, [txn("a", "Dining", ["r1"])]));
  assert.match(none, /1 transactions, 4 rules/);
  assert.match(none, /No transaction has two live rules setting different categories/);

  const txns = Array.from({ length: 7 }, (_, i) => txn(`t${i}`, "Groceries", ["r1", "r2"]));
  const out = formatReport(checkRulePrecedence(RULES, [...txns, txn("h", "Shopping", ["r1", "r2"])]), 5);
  assert.match(out, /8 conflicts/);
  assert.match(out, /last rule wins: 7/);
  assert.match(out, /first rule wins: 0/);
  assert.match(out, /neither \(likely hand edits\): 1/);
  assert.match(out, /t4 /);
  assert.doesNotMatch(out, /t5 /); // examples capped at 5
  assert.match(out, /… and 2 more/);
  assert.match(out, /r1=Dining, r2=Groceries/);
});
