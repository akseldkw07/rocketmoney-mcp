/**
 * Split transactions: one charge divided into parts, each with its own amount,
 * category, name, note and ignore state (e.g. a dinner that was half mine).
 *
 * ## The API (read from the web bundle and validation errors, 2026-11-22)
 *
 *   splitTransaction(input: { transactionNodeId: ID!, splitStatus: TransactionSplitStatus,
 *     splits: [{ amount: BigInt!, transactionCategoryNodeId: ID, customName: String,
 *                note: String, ignoredFrom: TransactionIgnoredValueEnum }!]! })
 *   unsplitTransaction(input: { transactionNodeId: ID! })
 *
 * TransactionSplitStatus is parent | child | child_equal | child_percent; the last
 * three only record which mode the web app's split dialog was in (by amounts,
 * equally, by percentages): the amounts are always sent. This sends `child`.
 *
 * ## Behavior (tested live on a $0.02 manual row, 2026-11-22)
 *
 * - Amounts are cents carrying the parent's sign. They must add up to the
 *   parent's amount, or RM refuses with code USER_ERROR (HTTP 400). A part with
 *   no category is refused with REQUIRED_VALUE_ERROR. Both are checked here
 *   first so the message says what is wrong; RM's own error still comes through
 *   if it refuses anyway.
 * - The parent keeps its id and amount and gets splitStatus `parent`; it stops
 *   counting in spending and drops out of search, and each part counts instead
 *   (spending moved by the parts, not twice). Parts are new transactions with
 *   their own ids, the parent's name and date, `custom_name` = the part's name,
 *   and splitParentTransaction pointing back.
 * - Splitting a split parent again replaces all its parts (new ids).
 * - Unsplit must name the parent: it deletes the parts and the parent counts
 *   again with its old category. Given a part, RM half-detaches that part and
 *   leaves the parent split, so unsplitTransaction always resolves to the parent.
 * - Parts read `manual: true` even though RM made them, and deleting one leaves
 *   the parent split with parts that no longer add up. delete_transaction
 *   therefore refuses parts (see manual.ts).
 *
 * Not tested live: splitting a bank-synced transaction (the web app offers it,
 * but testing it would touch real data).
 */

import { rmFullText } from "./graphql.js";
import { toCents } from "./format.js";

export interface SplitPartIn {
  /** USD, positive. The parts must add up to the parent's amount (ignoring its sign). */
  amount: number;
  /** A TransactionCategory node id (resolve labels first). Required by RM. */
  categoryNodeId: string;
  /** Shown as the part's name (RM's custom_name); the parent's name if omitted. */
  name?: string;
  note?: string;
  ignore?: "budget" | "everything";
}

export interface TransactionSplitInput {
  amount: number;
  transactionCategoryNodeId: string;
  customName: string | null;
  note: string | null;
  ignoredFrom: "budget" | "everything" | null;
}

/** Validate parts against the parent's amount (cents, signed) and build RM's input. Throws with the reason. */
export function toSplitInputs(parentCents: number, parts: SplitPartIn[]): TransactionSplitInput[] {
  if (parts.length < 2) throw new Error(`a split needs at least 2 parts (got ${parts.length})`);
  const sign = parentCents < 0 ? -1 : 1;
  const out = parts.map((p, i) => {
    const cents = toCents(p.amount);
    if (!Number.isFinite(p.amount) || cents <= 0) throw new Error(`part ${i + 1}: amount ${p.amount} must be a positive number of dollars`);
    if (!p.categoryNodeId) throw new Error(`part ${i + 1}: a category is required (Rocket Money refuses a part without one)`);
    return {
      amount: sign * cents,
      transactionCategoryNodeId: p.categoryNodeId,
      customName: p.name?.trim() || null,
      note: p.note ?? null,
      ignoredFrom: p.ignore ?? null,
    };
  });
  const total = out.reduce((s, p) => s + Math.abs(p.amount), 0);
  if (total !== Math.abs(parentCents)) {
    throw new Error(
      `the parts add up to $${(total / 100).toFixed(2)} but the transaction is $${(Math.abs(parentCents) / 100).toFixed(2)}; they must match exactly`,
    );
  }
  return out;
}

interface SplitTarget {
  id: string;
  amount: number;
  splitStatus: string | null;
  splitParentTransaction: { id: string } | null;
}

const TARGET = `query SplitTarget($id: ID!) {
  node(id: $id) {
    id
    ... on Transaction { amount splitStatus splitParentTransaction { id __typename } }
    __typename
  }
}`;

async function readTarget(nodeId: string): Promise<SplitTarget> {
  const data = await rmFullText<{ node?: SplitTarget & { __typename?: string } | null }>("SplitTarget", TARGET, { id: nodeId });
  const n = data.node;
  if (!n) throw new Error(`Rocket Money returned null for ${nodeId}, with no error: no such transaction, or not one of yours`);
  if (n.__typename && n.__typename !== "Transaction") throw new Error(`${nodeId} is a ${n.__typename}, not a transaction`);
  return n;
}

export interface SplitPart {
  id: string;
  /** USD, signed as search_transactions reports amounts. */
  amount: number;
  name: string | null;
  category: string | null;
  note: string | null;
  ignore: string | null;
}

const SPLIT = `mutation SplitTransactionMutation($input: SplitTransactionInput!) {
  splitTransaction(input: $input) {
    transaction {
      id
      amount
      splitStatus
      splitTransactions { id amount custom_name note ignoredFrom category { id label __typename } __typename }
      __typename
    }
    __typename
  }
}`;

/**
 * WRITE: split a transaction into parts. A part of an existing split is refused
 * (split its parent, which replaces all the parts). Errors propagate as thrown:
 * a validation Error, or RM's RMGraphQLError with its codes.
 */
export async function splitTransaction(
  nodeId: string,
  parts: SplitPartIn[],
): Promise<{ parent_id: string; amount: number; parts: SplitPart[] }> {
  const target = await readTarget(nodeId);
  if (target.splitParentTransaction) {
    throw new Error(
      `${nodeId} is part of a split; split its parent ${target.splitParentTransaction.id} instead (that replaces all of its parts)`,
    );
  }
  const splits = toSplitInputs(target.amount, parts);
  const data = await rmFullText<{
    splitTransaction?: {
      transaction?: {
        id: string;
        amount: number;
        splitTransactions?: { id: string; amount: number; custom_name: string | null; note: string | null; ignoredFrom: string | null; category?: { label?: string } | null }[];
      };
    };
  }>("SplitTransactionMutation", SPLIT, { input: { transactionNodeId: target.id, splitStatus: "child", splits } });
  const t = data.splitTransaction?.transaction;
  if (!t) throw new Error(`RM SplitTransactionMutation returned no transaction: ${JSON.stringify(data)}`);
  return {
    parent_id: t.id,
    amount: t.amount / 100,
    parts: (t.splitTransactions ?? []).map((p) => ({
      id: p.id,
      amount: p.amount / 100,
      name: p.custom_name ?? null,
      category: p.category?.label ?? null,
      note: p.note ?? null,
      ignore: p.ignoredFrom ?? null,
    })),
  };
}

const UNSPLIT = `mutation UnsplitTransactionMutation($input: UnsplitTransactionInput!) {
  unsplitTransaction(input: $input) {
    transaction { id amount splitStatus category { id label __typename } __typename }
    __typename
  }
}`;

/**
 * WRITE: undo a split, deleting its parts so the parent counts again. Takes the
 * parent or any of its parts; always sends the parent (see the header).
 */
export async function unsplitTransaction(nodeId: string): Promise<{ parent_id: string; amount: number; category: string | null }> {
  const target = await readTarget(nodeId);
  const parentId = target.splitParentTransaction?.id ?? target.id;
  if (!target.splitParentTransaction && target.splitStatus !== "parent") {
    throw new Error(`${nodeId} is not split (splitStatus ${JSON.stringify(target.splitStatus)})`);
  }
  const data = await rmFullText<{ unsplitTransaction?: { transaction?: { id: string; amount: number; category?: { label?: string } | null } } }>(
    "UnsplitTransactionMutation",
    UNSPLIT,
    { input: { transactionNodeId: parentId } },
  );
  const t = data.unsplitTransaction?.transaction;
  if (!t) throw new Error(`RM UnsplitTransactionMutation returned no transaction: ${JSON.stringify(data)}`);
  return { parent_id: t.id, amount: t.amount / 100, category: t.category?.label ?? null };
}
