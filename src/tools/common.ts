// Helpers every tool file shares: the result wrapper, annotations, batch results
// (the last two from mcp-utils).

import { z } from "zod";
import { RMAuthError, RMGraphQLError, PersistedQueryNotFoundError } from "../rm/client.js";

export const AUTH_HINT =
  "Rocket Money session is not active. Open this server's /auth page and paste a fresh `tb.auth0.sid` cookie from a logged-in app.rocketmoney.com browser tab. " +
  "If a freshly pasted cookie still fails with `HTTP 401 on AuthenticationCheck`, suspect a stale x-truebill-web-client-version instead: re-capture it from a graphql request in DevTools and set ROCKETMONEY_WEB_CLIENT_VERSION.";

/** With ROCKETMONEY_READ_ONLY=1 the write tools are never registered, so a client cannot reach them. */
export const READ_ONLY = /^(1|true|yes)$/i.test(process.env.ROCKETMONEY_READ_ONLY ?? "");

/**
 * The full text of a tool failure, so it can be debugged from the client: RM's
 * GraphQL errors as returned (path, extensions), the stack for anything that
 * isn't an RM error, and the chain of causes. Nothing is reworded or dropped.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const fromRM = err instanceof RMGraphQLError || err instanceof PersistedQueryNotFoundError;
  const parts = [fromRM ? String(err) : (err.stack ?? String(err))];
  if (err instanceof RMGraphQLError && err.errors.length) parts.push(`GraphQL errors: ${JSON.stringify(err.errors)}`);
  if (err.cause !== undefined) {
    parts.push(`Caused by: ${err.cause instanceof Error ? describeError(err.cause) : JSON.stringify(err.cause)}`);
  }
  return parts.join("\n");
}

/**
 * Wrap a tool body so RMAuthError becomes a clean, actionable MCP error and any
 * other failure comes back whole (describeError).
 * Results are compact JSON: indenting added ~30-40% to every response, which on
 * a 1,200-row search is hundreds of KB the client has to carry.
 */
export function tool<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      const result = await fn(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (err) {
      const msg = err instanceof RMAuthError ? `${AUTH_HINT}\n\n(${err.message})` : describeError(err);
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }
  };
}

// Annotation presets and batch results are shared with the other MCP servers.
export { DESTRUCTIVE, READ, WRITE, batchOutcome, perItemOutcome } from "mcp-utils";

export const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const COMPACT = z
  .boolean()
  .optional()
  .describe(
    "Bulk-read form (default false): instead of `transactions`, returns a table {columns, categories, accounts, rows}. Each row is an array in `columns` order [id, date, amount, name, category, account, original_date, ignore]; category and account are indexes into `categories` / `accounts`; trailing empty cells are dropped, so rows vary in length (usually 6; 7 when re-dated; 8 when ignored) - read any missing cell as empty. Empty cells before the last filled one are null (e.g. [.., null, \"everything\"] = ignored, not re-dated). Empty means: no original_date = same as date; no ignore = counted; no category/account = none. Leaves out notes, renames and rule ids.",
  );
