// Rule precedence consistency check (TODO F7). Read-only.
//
//   npm run check-rules
//
// Lists the live rules and every transaction, then for each transaction where two or
// more live rules set different categories, checks whether its category is the last
// rule's in applied_rule_ids, the first rule's, or neither (likely a hand edit).

import { fileURLToPath } from "node:url";
import type { RMRule } from "../src/rm/rules.js";
import type { RMTransaction } from "../src/rm/transactions.js";

type RuleIn = Pick<RMRule, "id"> & { updates: Pick<RMRule["updates"], "category_label"> };
type TxnIn = Pick<RMTransaction, "nodeId" | "date" | "name" | "categoryLabel" | "ruleIds">;

export interface Conflict {
  id: string;
  date: string;
  name: string;
  category: string | null;
  /** The live category-setting rules that applied, in applied_rule_ids order. */
  rules: { id: string; category: string }[];
}

export interface RuleCheck {
  transactions: number;
  rules: number;
  conflicts: number;
  last: Conflict[];
  first: Conflict[];
  neither: Conflict[];
}

export function checkRulePrecedence(rules: RuleIn[], txns: TxnIn[]): RuleCheck {
  const categoryOf = new Map<string, string>();
  for (const r of rules) if (r.updates.category_label) categoryOf.set(r.id, r.updates.category_label);

  const out: RuleCheck = { transactions: txns.length, rules: rules.length, conflicts: 0, last: [], first: [], neither: [] };
  for (const t of txns) {
    const applied = [...new Set(t.ruleIds)]
      .filter((id) => categoryOf.has(id))
      .map((id) => ({ id, category: categoryOf.get(id)! }));
    if (new Set(applied.map((a) => a.category)).size < 2) continue;
    out.conflicts++;
    const c: Conflict = { id: t.nodeId, date: t.date, name: t.name, category: t.categoryLabel, rules: applied };
    if (t.categoryLabel === applied[applied.length - 1].category) out.last.push(c);
    else if (t.categoryLabel === applied[0].category) out.first.push(c);
    else out.neither.push(c);
  }
  return out;
}

function examples(label: string, list: Conflict[], max: number): string[] {
  const lines = [`${label}: ${list.length}`];
  for (const c of list.slice(0, max)) {
    const rules = c.rules.map((r) => `${r.id}=${r.category}`).join(", ");
    lines.push(`  ${c.id} ${c.date} ${c.name}: ${c.category ?? "(none)"} [${rules}]`);
  }
  if (list.length > max) lines.push(`  … and ${list.length - max} more`);
  return lines;
}

export function formatReport(r: RuleCheck, max = 5): string {
  const head = `${r.transactions} transactions, ${r.rules} rules`;
  if (!r.conflicts) return `${head}\nNo transaction has two live rules setting different categories: nothing to judge.`;
  return [
    `${head}, ${r.conflicts} conflicts (two or more live rules setting different categories)`,
    ...examples("last rule wins", r.last, max),
    ...examples("first rule wins", r.first, max),
    ...examples("neither (likely hand edits)", r.neither, max),
  ].join("\n");
}

async function main(): Promise<void> {
  const { listRules } = await import("../src/rm/rules.js");
  const { searchAllTransactions } = await import("../src/rm/transactions.js");
  const rules = await listRules();
  const txns = await searchAllTransactions({});
  console.log(formatReport(checkRulePrecedence(rules, txns)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
