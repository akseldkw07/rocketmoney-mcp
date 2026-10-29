import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY } from "./tools/common.js";
import { registerAccountsTools } from "./tools/accounts.js";
import { registerCategoriesTools } from "./tools/categories.js";
import { registerRulesTools } from "./tools/rules.js";
import { registerSubscriptionsTools } from "./tools/subscriptions.js";
import { registerTransactionsTools } from "./tools/transactions.js";

export { READ_ONLY };

// Tools live in src/tools/, one file per domain. Each register function adds its
// reads, then its writes unless the server is read-only.
/** Build a fresh McpServer with the Rocket Money tools registered (writes omitted under READ_ONLY). */
export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "rocketmoney", version: "1.0.0" },
    {
      instructions:
        "Access to the user's Rocket Money finances (USD). Read tools: accounts and balances, transactions, spending by category, budgets, net worth, recurring charges (subscriptions, get_subscription), the category catalog (list_categories), and transaction rules (list_rules, get_rule, preview_rule). " +
        (READ_ONLY
          ? "This server runs in read-only mode: the write tools are not registered, so nothing here can change the account."
          : "Write tools MUTATE the account: set_transaction_note sets/clears a transaction's note; set_transaction_category recategorizes a transaction (optionally every related transaction from the same merchant); update_subscription corrects a recurring charge's name, amount, cadence or dates; delete_subscription removes one from the list; set_transaction_ignore and set_transaction_date change ignore state and dates in batches; create_category/update_category/delete_category manage custom categories; create_rule/update_rule/delete_rule manage transaction rules (run preview_rule first; by default a rule is applied to every existing match too; apply_to_existing=false limits it to future transactions). To recategorize, first call list_categories to see valid labels/ids, then pass a label like \"Groceries\" (or a category id) to set_transaction_category. Marking a subscription cancelled is not possible: Rocket Money's API has no such field for a subscription it detected from transactions.") +
        " If a tool reports the session is inactive, the user must re-authenticate at the auth page.",
    },
  );

  const writes = !READ_ONLY;
  registerAccountsTools(server, writes);
  registerSubscriptionsTools(server, writes);
  registerTransactionsTools(server, writes);
  registerCategoriesTools(server, writes);
  registerRulesTools(server, writes);
  return server;
}
