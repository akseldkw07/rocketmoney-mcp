// The category catalog and custom-category writes.
import { z } from "zod";
import { DESTRUCTIVE, READ, WRITE, tool } from "./common.js";
import * as rm from "../rm/client.js";
/**
 * One category, the same shape from list_categories and the category write
 * tools: `kind` is default|custom, `type` is expense|income|ignored (RM calls
 * income "earning").
 */
function shapeCategory(c) {
    return {
        id: c.id,
        nodeId: c.nodeId,
        label: c.label,
        kind: c.type,
        type: c.categoryType === "earning" ? "income" : c.categoryType,
        includeInSpending: c.includeInSpending,
        taxDeductible: c.taxDeductible,
        icon: c.iconKey,
        color: c.color,
    };
}
export function registerCategoriesTools(server, writes) {
    server.registerTool("list_categories", {
        title: "List spending categories",
        description: "The user's full Rocket Money category catalog, each with its label, ids, kind (default = Rocket Money's own, custom = yours; only custom ones can be edited) and type (expense/income/ignored). Call this to discover valid categories before recategorizing a transaction with set_transaction_category.",
        inputSchema: {},
        annotations: READ,
    }, tool(async () => {
        const cats = await rm.getTransactionCategories();
        return { count: cats.length, categories: cats.map(shapeCategory) };
    }));
    if (!writes)
        return;
    const CATEGORY_TYPE = z
        .enum(["expense", "income", "ignored"])
        .describe("expense = counted as spending; income = counted as earnings (only positive amounts); ignored = left out of everything");
    const toCategoryType = (t) => (t === "income" ? "earning" : t);
    server.registerTool("create_category", {
        title: "Create a category",
        description: "WRITES to Rocket Money: create a custom category. Returns its id and node id for set_transaction_category, set_transactions_category and rules. icon and color are optional (defaults: the web app's 'coffee' icon, gray).",
        inputSchema: {
            label: z.string().min(1).describe("Category name, e.g. 'Rent'"),
            type: CATEGORY_TYPE,
            tax_deductible: z.boolean().optional().describe("Mark its transactions tax deductible by default (default false)"),
            icon: z.string().optional().describe("Rocket Money icon key (see list_categories' icon values), e.g. 'home'"),
            color: z.string().optional().describe("CSS color, e.g. 'rgb(117, 117, 117)'"),
        },
        annotations: WRITE,
    }, tool(async (a) => {
        const cat = await rm.createCategory(a.label, toCategoryType(a.type), {
            taxDeductible: a.tax_deductible,
            iconKey: a.icon,
            color: a.color,
        });
        return { category: shapeCategory(cat), ok: true };
    }));
    server.registerTool("update_category", {
        title: "Update a category",
        description: "WRITES to Rocket Money: rename a custom category or change its type, tax-deductible default, icon or color. Only custom categories can be changed; Rocket Money's default categories are fixed. Fields you omit keep their current values.",
        inputSchema: {
            category: z.string().describe("The category: label, numeric id or node id (see list_categories)"),
            label: z.string().min(1).optional().describe("New name"),
            type: CATEGORY_TYPE.optional(),
            tax_deductible: z.boolean().optional(),
            icon: z.string().optional(),
            color: z.string().optional(),
        },
        annotations: WRITE,
    }, tool(async (a) => {
        const cat = await rm.updateCategory(a.category, {
            label: a.label,
            categoryType: a.type ? toCategoryType(a.type) : undefined,
            taxDeductible: a.tax_deductible,
            iconKey: a.icon,
            color: a.color,
        });
        return { category: shapeCategory(cat), ok: true };
    }));
    server.registerTool("delete_category", {
        title: "Delete a category",
        description: "WRITES to Rocket Money: delete a custom category. Rocket Money itself would leave its transactions Uncategorized; pass reassign_to to move them all to another category first (the delete is skipped if any fail to move). Rules that set this category are not changed. Not reversible. Requires confirm=true.",
        inputSchema: {
            category: z.string().describe("The category to delete: label, numeric id or node id"),
            reassign_to: z.string().optional().describe("Move its transactions to this category first: label, numeric id or node id"),
            confirm: z.literal(true).describe("Must be true"),
        },
        annotations: DESTRUCTIVE,
    }, tool(async ({ category, reassign_to }) => {
        const r = await rm.deleteCategory(category, reassign_to);
        return { deleted: shapeCategory(r.deleted), reassignedCount: r.reassigned, reassignedTo: r.reassignedTo, ok: true };
    }));
}
