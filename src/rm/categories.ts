// The category catalog (cached) and custom-category writes.

import { collectByType, fromNodeId, rmFullText, rmGraphQL, toNodeId } from "./graphql.js";
import { searchAllTransactions, setTransactionsCategoryChunked } from "./transactions.js";

export interface RMCategory {
  nodeId: string; // base64 Relay id, pass straight to setTransactionCategory
  id: string; // numeric id decoded from the node id
  label: string;
  type: string; // "default" | "custom"
  categoryType: string; // "expense" | "earning" | "ignored"
  includeInSpending: boolean;
  includeInEarnings: boolean;
  taxDeductible: boolean;
  iconKey: string;
  color: string; // colors.base, e.g. "rgb(117, 117, 117)"
}

/** base64(`TransactionCategory:<id>`) for a numeric category id. */
export function categoryNodeId(numericId: string | number): string {
  return toNodeId("TransactionCategory", numericId);
}

/** READ: the user's full category catalog (default + custom), with node ids. */
export async function getTransactionCategories(): Promise<RMCategory[]> {
  const data = await rmGraphQL<Record<string, unknown>>({ operationName: "TransactionCategories" });
  const nodes: Record<string, unknown>[] = [];
  collectByType(data, "TransactionCategory", nodes);
  const seen = new Set<string>();
  const cats: RMCategory[] = [];
  for (const o of nodes) {
    const nodeId = typeof o.id === "string" ? o.id : "";
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    cats.push(toCategory(o));
  }
  return cats.sort((a, b) => a.label.localeCompare(b.label));
}

// Per-process memo of the category catalog. Categories change rarely and the Fly
// machine stays warm, so caching spares a round-trip on every label resolution.
let _catCache: { at: number; cats: RMCategory[] } | null = null;
const CAT_TTL_MS = 10 * 60 * 1000;

async function categoriesCached(): Promise<RMCategory[]> {
  if (_catCache && Date.now() - _catCache.at < CAT_TTL_MS) return _catCache.cats;
  const cats = await getTransactionCategories();
  _catCache = { at: Date.now(), cats };
  return cats;
}

/**
 * Resolve a caller-supplied category (a label like "Groceries", a numeric id, or
 * a base64 TransactionCategory node id) to a node id. Throws a clear, actionable
 * error listing valid labels when a label doesn't match.
 */
export async function resolveCategoryNodeId(input: string | number): Promise<string> {
  const raw = String(input).trim();
  // Already a TransactionCategory node id?
  if (fromNodeId(raw)?.type === "TransactionCategory") return raw;
  // Bare numeric id -> build the node id (no lookup needed).
  if (/^\d+$/.test(raw)) return categoryNodeId(raw);
  // Otherwise treat it as a label and look it up (case-insensitive).
  const cats = await categoriesCached();
  const match = cats.find((c) => c.label.toLowerCase() === raw.toLowerCase());
  if (match) return match.nodeId;
  throw new Error(
    `Unknown category "${raw}". Use list_categories to see valid options. Available: ${cats
      .map((c) => c.label)
      .join(", ")}`,
  );
}

// Custom categories. Create and edit both require every field (label,
// categoryType, taxDeductible, color, iconKey; established 2026-10-29 by the
// validation-error count when one is left out), so edit merges over the stored
// category. Only custom categories can be edited or deleted. RM's delete has no
// reassign: the category's transactions become Uncategorized.

export type CategoryType = "expense" | "earning" | "ignored";

const CATEGORY_FIELDS = "id\n      label\n      type\n      categoryType\n      iconKey\n      includeInSpending\n      includeInEarnings\n      taxDeductible\n      colors {\n        base\n        __typename\n      }\n      __typename";

// The web app's own defaults for a new category's icon, and a neutral gray.
const DEFAULT_ICON = "coffee";
const DEFAULT_COLOR = "rgb(117, 117, 117)";

function toCategory(o: Record<string, unknown>): RMCategory {
  const nodeId = String(o.id ?? "");
  return {
    nodeId,
    id: fromNodeId(nodeId)?.numericId ?? "",
    label: String(o.label ?? ""),
    type: String(o.type ?? ""),
    categoryType: String(o.categoryType ?? ""),
    includeInSpending: Boolean(o.includeInSpending),
    includeInEarnings: Boolean(o.includeInEarnings),
    taxDeductible: Boolean(o.taxDeductible),
    iconKey: String(o.iconKey ?? ""),
    color: String((o.colors as { base?: string } | null)?.base ?? ""),
  };
}

/** WRITE: create a custom category. Returns it as RM saved it. */
export async function createCategory(
  label: string,
  categoryType: CategoryType,
  opts: { taxDeductible?: boolean; iconKey?: string; color?: string } = {},
): Promise<RMCategory> {
  const data = await rmFullText<{
    createCustomTransactionCategoryWithCategoryType?: { transactionCategory?: Record<string, unknown> };
  }>(
    "CreateCustomTransactionCategoryWithCategoryTypes",
    `mutation CreateCustomTransactionCategoryWithCategoryTypes($input: createCustomTransactionCategoryWithCategoryTypeInput!) {\n  createCustomTransactionCategoryWithCategoryType(input: $input) {\n    transactionCategory {\n      ${CATEGORY_FIELDS}\n    }\n    __typename\n  }\n}`,
    {
      input: {
        label: label.trim(),
        categoryType,
        taxDeductible: opts.taxDeductible ?? false,
        color: opts.color ?? DEFAULT_COLOR,
        iconKey: opts.iconKey ?? DEFAULT_ICON,
      },
    },
  );
  const cat = data.createCustomTransactionCategoryWithCategoryType?.transactionCategory;
  if (!cat) throw new Error(`createCustomTransactionCategory returned no category for "${label}".`);
  _catCache = null;
  return toCategory(cat);
}

/** A category from the catalog by node id, numeric id or label; throws unless it is custom. */
async function customCategory(input: string): Promise<RMCategory> {
  const nodeId = await resolveCategoryNodeId(input);
  let cat = (await categoriesCached()).find((c) => c.nodeId === nodeId);
  if (!cat) {
    // A numeric or node id skips the catalog, so it may name a category newer than the cache.
    _catCache = null;
    cat = (await categoriesCached()).find((c) => c.nodeId === nodeId);
  }
  if (!cat) throw new Error(`No category "${input}". Use list_categories to see valid options.`);
  if (cat.type !== "custom") {
    throw new Error(`"${cat.label}" is a default Rocket Money category; only custom categories can be changed or deleted.`);
  }
  return cat;
}

/** WRITE: rename or regroup a custom category. Fields left undefined keep their current values. */
export async function updateCategory(
  input: string,
  edit: { label?: string; categoryType?: CategoryType; taxDeductible?: boolean; iconKey?: string; color?: string },
): Promise<RMCategory> {
  const cat = await customCategory(input);
  const data = await rmFullText<{
    editCustomTransactionCategoryWithCategoryType?: { transactionCategory?: Record<string, unknown> };
  }>(
    "EditCustomTransactionCategoryWithCategoryType",
    `mutation EditCustomTransactionCategoryWithCategoryType($input: EditCustomTransactionCategoryWithCategoryTypeInput!) {\n  editCustomTransactionCategoryWithCategoryType(input: $input) {\n    transactionCategory {\n      ${CATEGORY_FIELDS}\n    }\n    __typename\n  }\n}`,
    {
      input: {
        transactionCategoryNodeId: cat.nodeId,
        label: edit.label?.trim() || cat.label,
        categoryType: edit.categoryType ?? cat.categoryType,
        taxDeductible: edit.taxDeductible ?? cat.taxDeductible,
        color: edit.color ?? (cat.color || DEFAULT_COLOR),
        iconKey: edit.iconKey ?? (cat.iconKey || DEFAULT_ICON),
      },
    },
  );
  const saved = data.editCustomTransactionCategoryWithCategoryType?.transactionCategory;
  if (!saved) throw new Error(`editCustomTransactionCategory returned no category for "${input}".`);
  _catCache = null;
  return toCategory(saved);
}

/**
 * WRITE: delete a custom category. With reassignTo, every transaction in it is
 * moved there first (RM's delete would leave them Uncategorized). Returns how
 * many were moved.
 */
export async function deleteCategory(
  input: string,
  reassignTo?: string,
): Promise<{ deleted: RMCategory; reassigned: number; reassignedTo: string | null }> {
  const cat = await customCategory(input);
  let reassigned = 0;
  let target: string | null = null;
  if (reassignTo) {
    target = await resolveCategoryNodeId(reassignTo);
    if (target === cat.nodeId) throw new Error("reassign_to is the category being deleted.");
    const ids = (await searchAllTransactions({ categoryIds: [cat.nodeId] })).map((t) => t.nodeId);
    reassigned = await setTransactionsCategoryChunked(ids, target);
    if (reassigned < ids.length) {
      throw new Error(
        `Not deleted: moved only ${reassigned} of ${ids.length} transactions out of "${cat.label}". Nothing was deleted; retry or move the rest by hand.`,
      );
    }
  }
  await rmFullText(
    "DeleteCustomTransactionCategory",
    "mutation DeleteCustomTransactionCategory($input: DeleteCustomTransactionCategoryInput!) {\n  deleteCustomTransactionCategory(input: $input) {\n    viewer {\n      id\n      __typename\n    }\n    __typename\n  }\n}",
    { input: { transactionCategoryNodeId: cat.nodeId } },
  );
  _catCache = null;
  return { deleted: cat, reassigned, reassignedTo: target };
}
