// Helpers every tool file shares: the result wrapper, annotations, batch results.
import { z } from "zod";
import { RMAuthError } from "../rm/client.js";
export const AUTH_HINT = "Rocket Money session is not active. Open this server's /auth page and paste a fresh `tb.auth0.sid` cookie from a logged-in app.rocketmoney.com browser tab.";
/** With ROCKETMONEY_READ_ONLY=1 the write tools are never registered, so a client cannot reach them. */
export const READ_ONLY = /^(1|true|yes)$/i.test(process.env.ROCKETMONEY_READ_ONLY ?? "");
/**
 * Wrap a tool body so RMAuthError becomes a clean, actionable MCP error.
 * Results are compact JSON: indenting added ~30-40% to every response, which on
 * a 1,200-row search is hundreds of KB the client has to carry.
 */
export function tool(fn) {
    return async (args) => {
        try {
            const result = await fn(args);
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        catch (err) {
            const msg = err instanceof RMAuthError ? `${AUTH_HINT}\n\n(${err.message})` : String(err);
            return { content: [{ type: "text", text: msg }], isError: true };
        }
    };
}
export const READ = { readOnlyHint: true, openWorldHint: true };
export const WRITE = { readOnlyHint: false, openWorldHint: true };
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
/**
 * The result every batch write returns: how many of the requested items
 * Rocket Money reports updated, plus per-item results when it gives them.
 * `ok` means all of them - compare counts rather than trusting a bare success.
 */
export function batchOutcome(requested, updated, extra = {}) {
    return { requested, updatedCount: updated, ...extra, ok: updated === requested };
}
/** batchOutcome for per-item results, where an item with an `error` failed. */
export function perItemOutcome(results, extra = {}) {
    return batchOutcome(results.length, results.filter((r) => !r.error).length, { ...extra, results });
}
export const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const COMPACT = z
    .boolean()
    .optional()
    .describe("Bulk-read form (default false): instead of `transactions`, returns a table {columns, categories, accounts, rows}. Each row is an array in `columns` order [id, date, amount, name, category, account, original_date, ignore]; category and account are indexes into `categories` / `accounts`; trailing empty cells are dropped, so rows vary in length (usually 6; 7 when re-dated; 8 when ignored) - read any missing cell as empty. Empty cells before the last filled one are null (e.g. [.., null, \"everything\"] = ignored, not re-dated). Empty means: no original_date = same as date; no ignore = counted; no category/account = none. Leaves out notes, renames and rule ids.");
