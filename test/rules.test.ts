import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { freshSession, mockGraphQL, realFetch, type GraphQLBody } from "./helpers.js";
import {
  conditionsToInput,
  createRule,
  mergePatch,
  parseRule,
  patchConditions,
  tomorrowYmd,
  updateRule,
  updatesToInput,
  withFutureFloor,
} from "../src/rm/rules.js";

// Two rule nodes as TransactionRulesPage returned them (2026-10-29), trimmed to
// the fields the parser reads.
const BILT_RENT = {
  id: "VHJhbnNhY3Rpb25SdWxlOjI3NzgyNjEz",
  numberMatchingTransactions: 16,
  matchRules: {
    v1: {
      transactionNameIs: null,
      transactionNameContains: "BPS*BILT RENT",
      absAmountBetween: { max: { value: "Infinity", inclusive: false }, min: { value: 100000, inclusive: false } },
      amountCreditBetween: null,
      amountDebitBetween: null,
      postedDateBetween: null,
      service: null,
      accountIdIsIn: null,
      accountsIn: null,
    },
  },
  operation: {
    ignoredFrom: null,
    customName: null,
    taxDeductible: null,
    subscription: null,
    transactionCategory: {
      title: "Change Category to Bills & Utilities",
      transactionCategory: { id: "VHJhbnNhY3Rpb25DYXRlZ29yeToy", label: "Bills & Utilities" },
    },
  },
};

const PERSONAL_PROFILE = {
  id: "VHJhbnNhY3Rpb25SdWxlOjIzOTk5Njk5",
  numberMatchingTransactions: 1731,
  matchRules: {
    v1: {
      transactionNameContains: null,
      accountIdIsIn: ["QWNjb3VudDozODY2NzEwNDQ="],
      accountsIn: [{ id: "QWNjb3VudDozODY2NzEwNDQ=", name: "Personal Profile" }],
    },
  },
  operation: {
    transactionCategory: {
      title: "Change Category to Venmo",
      transactionCategory: { id: "VHJhbnNhY3Rpb25DYXRlZ29yeTo0NzI5NzUw", label: "Venmo" },
    },
  },
};

test("conditionsToInput encodes names, accounts and dates the way the web client does", () => {
  assert.deepEqual(
    conditionsToInput({
      name_contains: " Venmo ",
      account_ids: ["QWNjb3VudDozODY2NzEwNDQ="],
      date_from: "2026-10-01",
      date_to: "2026-10-21",
    }),
    {
      transactionNameContains: "Venmo",
      accountIdIsIn: ["QWNjb3VudDozODY2NzEwNDQ="],
      postedDateBetween: {
        min: { value: "2026-10-01T00:00:00.000Z", inclusive: true },
        max: { value: "2026-10-21T00:00:00.000Z", inclusive: true },
      },
    },
  );
  assert.deepEqual(conditionsToInput({ name_equals: "Yoco *Stones SafarCAPE TOWN ZA" }), {
    transactionNameIs: "Yoco *Stones SafarCAPE TOWN ZA",
  });
});

test("a date_to alone gets a concrete early floor, since RM rejects -Infinity for dates", () => {
  assert.deepEqual(conditionsToInput({ account_ids: ["a"], date_to: "2022-07-31" }).postedDateBetween, {
    min: { value: "2000-01-01T00:00:00.000Z", inclusive: true },
    max: { value: "2022-07-31T00:00:00.000Z", inclusive: true },
  });
  // ...and reading such a rule back doesn't report the synthetic floor.
  const r = parseRule({
    id: "x",
    matchRules: { v1: { postedDateBetween: conditionsToInput({ name_contains: "x", date_to: "2022-07-31" }).postedDateBetween } },
    operation: {},
  });
  assert.equal(r.conditions.date_from, undefined);
  assert.equal(r.conditions.date_to, "2022-07-31");
});

test("conditionsToInput encodes amounts in cents with the client's bounds", () => {
  assert.deepEqual(conditionsToInput({ amount: 1139.79 }).absAmountBetween, {
    min: { value: 113979, inclusive: true },
    max: { value: 113979, inclusive: true },
  });
  assert.deepEqual(conditionsToInput({ amount_min: 10, amount_max: 20, amount_type: "debit" }).amountDebitBetween, {
    min: { value: 1000, inclusive: true },
    max: { value: 2000, inclusive: true },
  });
  // One-sided ranges are the web app's "greater than" / "less than": exclusive.
  assert.deepEqual(conditionsToInput({ amount_min: 1000 }).absAmountBetween, {
    min: { value: 100000, inclusive: false },
    max: { value: "Infinity", inclusive: false },
  });
  assert.deepEqual(conditionsToInput({ amount_max: 5, amount_type: "credit" }).amountCreditBetween, {
    min: { value: "-Infinity", inclusive: false },
    max: { value: 500, inclusive: false },
  });
});

test("conditionsToInput rejects contradictory or empty conditions", () => {
  assert.throws(() => conditionsToInput({}), /at least one match condition/);
  assert.throws(() => conditionsToInput({ name_contains: "a", name_equals: "b" }), /not both/);
  assert.throws(() => conditionsToInput({ amount: 1, amount_min: 0 }), /not both/);
  assert.throws(() => conditionsToInput({ amount_type: "debit", name_contains: "x" }), /needs an amount/);
  assert.throws(() => conditionsToInput({ date_from: "10/01/2026" }), /YYYY-MM-DD/);
  assert.throws(() => conditionsToInput({ date_from: "2026-10-05", date_to: "2026-10-01" }), /after date_to/);
});

test("parseRule reads real rules and re-encodes their conditions unchanged", () => {
  const bilt = parseRule(BILT_RENT);
  assert.deepEqual(bilt.conditions, { name_contains: "BPS*BILT RENT", amount_min: 1000, amount_type: "any" });
  assert.deepEqual(conditionsToInput(bilt.conditions), bilt.matchRulesInput);
  assert.equal(bilt.updates.category_label, "Bills & Utilities");
  assert.deepEqual(bilt.updateTitles, ["Change Category to Bills & Utilities"]);

  const pp = parseRule(PERSONAL_PROFILE);
  assert.equal(pp.matchedCount, 1731);
  assert.deepEqual(pp.conditions, { account_ids: ["QWNjb3VudDozODY2NzEwNDQ="] });
  assert.deepEqual(pp.accounts, [{ id: "QWNjb3VudDozODY2NzEwNDQ=", name: "Personal Profile" }]);
  assert.equal(pp.updates.category_label, "Venmo");
  assert.equal(pp.updates.ignore, undefined);
  assert.deepEqual(pp.matchRulesInput, { accountIdIsIn: ["QWNjb3VudDozODY2NzEwNDQ="] });
});

test("updatesToInput maps updates and needs at least one", () => {
  assert.deepEqual(updatesToInput({ category_id: "c1", rename: " Rent ", ignore: "budget", tax_deductible: true }), {
    transactionCategoryId: "c1",
    customName: "Rent",
    ignoredFrom: "budget",
    taxDeductible: true,
  });
  assert.throws(() => updatesToInput({ ignore: "none" }), /at least one update/);
});

test("mergePatch keeps omitted keys and clears nulls; patchConditions clears the exclusive partner", () => {
  assert.deepEqual(mergePatch({ a: 1, b: 2 } as Record<string, number | null>, { b: null, c: 3 }), { a: 1, c: 3 });
  assert.deepEqual(patchConditions({ name_contains: "x", amount: 5 }, { name_equals: "y", amount_min: 1 }), {
    name_equals: "y",
    amount_min: 1,
  });
});

test("withFutureFloor raises date_from to tomorrow and refuses a past date_to", () => {
  const now = new Date("2026-10-29T15:00:00Z");
  assert.equal(tomorrowYmd(now), "2026-10-30");
  assert.equal(withFutureFloor({ name_contains: "x" }, now).date_from, "2026-10-30");
  assert.equal(withFutureFloor({ name_contains: "x", date_from: "2026-01-01" }, now).date_from, "2026-10-30");
  assert.equal(withFutureFloor({ name_contains: "x", date_from: "2027-01-01" }, now).date_from, "2027-01-01");
  assert.throws(() => withFutureFloor({ name_contains: "x", date_to: "2026-10-01" }, now), /could never match/);
});

// ── Write paths against a fake API ──────────────────────────────────

let sent: GraphQLBody[] = [];

function fakeApi(previewCount: number, rules: unknown[] = []) {
  sent = mockGraphQL((body) => {
    const data: Record<string, unknown> = {
      TransactionRulesPage: {
        viewer: { transactionRules: { edges: rules.map((node) => ({ node })), pageInfo: { hasNextPage: false } } },
      },
      TransactionRulesSearch: {
        viewer: { ruleTransactions: { numMatchingTransactions: previewCount, transactions: { edges: [] } } },
      },
      SaveTransactionRuleMutation: {
        saveTransactionRule: {
          clientMutationId: null,
          viewer: { transactionRules: { edges: rules.map((node) => ({ node })), pageInfo: { hasNextPage: false } } },
        },
      },
    };
    return { data: data[body.operationName!] };
  });
}

beforeEach(() => {
  freshSession();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("createRule with apply_to_existing=false saves with a future date floor", async () => {
  fakeApi(0);
  const r = await createRule({ name_contains: "zz-test" }, { category_id: "c1" }, false);
  const save = sent.find((b) => b.operationName === "SaveTransactionRuleMutation")!;
  const v1 = (save.variables.input as { matchRules: { v1: Record<string, { min: { value: string } }> } }).matchRules.v1;
  assert.equal(v1.postedDateBetween.min.value, `${tomorrowYmd()}T00:00:00.000Z`);
  assert.equal(r.dateFloorAdded, tomorrowYmd());
  assert.equal(r.existingTransactionsUpdated, 0);
});

test("createRule refuses to save when the floored preview still matches something", async () => {
  fakeApi(2);
  await assert.rejects(createRule({ name_contains: "zz-test" }, { category_id: "c1" }, false), /match 2 existing/);
  assert.ok(!sent.some((b) => b.operationName === "SaveTransactionRuleMutation"));
});

test("createRule with apply_to_existing=true reports the preview count and adds no floor", async () => {
  fakeApi(7);
  const r = await createRule({ name_contains: "zz-test" }, { category_id: "c1" }, true);
  const save = sent.find((b) => b.operationName === "SaveTransactionRuleMutation")!;
  const v1 = (save.variables.input as { matchRules: { v1: Record<string, unknown> } }).matchRules.v1;
  assert.equal(v1.postedDateBetween, undefined);
  assert.equal(r.existingTransactionsUpdated, 7);
  assert.equal(r.dateFloorAdded, null);
  // One list before the save; the save itself returns the list after.
  assert.equal(sent.filter((b) => b.operationName === "TransactionRulesPage").length, 1);
});

test("updateRule refuses a rule that already matches transactions unless apply_to_existing", async () => {
  fakeApi(1731, [PERSONAL_PROFILE]);
  await assert.rejects(updateRule(PERSONAL_PROFILE.id, undefined, { rename: "x" }, false), /already matches 1731/);
  assert.ok(!sent.some((b) => b.operationName === "SaveTransactionRuleMutation"));
});

test("updateRule merges updates over the stored rule and resends stored conditions verbatim", async () => {
  fakeApi(16, [BILT_RENT]);
  const r = await updateRule(BILT_RENT.id, undefined, { rename: "Rent" }, true);
  const input = sent.find((b) => b.operationName === "SaveTransactionRuleMutation")!.variables.input as Record<
    string,
    unknown
  >;
  assert.equal(input.id, BILT_RENT.id);
  assert.equal(input.customName, "Rent");
  assert.equal(input.transactionCategoryId, "VHJhbnNhY3Rpb25DYXRlZ29yeToy"); // kept
  assert.deepEqual((input.matchRules as { v1: unknown }).v1, parseRule(BILT_RENT).matchRulesInput);
  assert.equal(r.existingTransactionsUpdated, 16);
});
