// Recurring charges: reads and corrections.
import { z } from "zod";
import { DESTRUCTIVE, READ, WRITE, tool } from "./common.js";
import * as rm from "../rm/client.js";
import * as fmt from "../rm/format.js";
export function registerSubscriptionsTools(server, writes) {
    server.registerTool("subscriptions", {
        title: "Subscriptions / recurring",
        description: "Every recurring charge Rocket Money tracks, active and inactive, with amount in USD, cadence (monthly/annual/semi-annual/irregular), the account or card it hits, last and next charge, category, and whether Rocket Money offers to cancel it for you. Inactive rows are included and flagged `active: false` - those are subscriptions still listed that have stopped charging, which is what a list audit is looking for. `amountSource` says whether the amount was pinned by hand, estimated by Rocket Money, or taken from the last charge.",
        inputSchema: {},
        annotations: READ,
    }, tool(async () => fmt.shapeRecurring(await rm.getRecurring())));
    server.registerTool("get_subscription", {
        title: "Get subscription detail",
        description: "One recurring charge in full: everything the subscriptions list shows plus its charge history - a per-month total for the last 12 months, the individual transactions, and Rocket Money's own annualized cost. Use it to check what a subscription is really being billed before correcting it with update_subscription. Pass the subscription id from subscriptions.",
        inputSchema: {
            subscription_id: z
                .string()
                .describe("The subscription node id (the `id` field from subscriptions)"),
        },
        annotations: READ,
    }, tool(async ({ subscription_id }) => fmt.shapeSubscriptionDetail(await rm.getSubscriptionDetail(subscription_id))));
    if (!writes)
        return;
    server.registerTool("update_subscription", {
        title: "Update a subscription",
        description: "WRITES to Rocket Money: correct a recurring charge's name, amount, cadence or dates. Pass only what changes - the rest is preserved from a fresh read, because Rocket Money's mutation replaces the whole record. `amount` is in USD dollars. `frequency` is charges per YEAR: 12 monthly, 4 quarterly, 2 semi-annual, 1 annual. CANNOT mark a subscription cancelled or inactive: `active` is not a field Rocket Money's update mutation accepts, and the only deactivate mutation applies to hand-added subscriptions, not ones Rocket Money detected from transactions. To get a wrongly-listed charge off the list, use delete_subscription; to tell Rocket Money a dead-looking one is still live, use mark_subscription_active.",
        inputSchema: {
            subscription_id: z
                .string()
                .describe("The subscription node id (the `id` field from subscriptions)"),
            name: z.string().optional().describe("New display name for the subscription"),
            amount: z
                .number()
                .nonnegative()
                .optional()
                .describe("New charge amount in USD dollars (e.g. 47.88). Pins the amount Rocket Money shows."),
            frequency: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("Charges per year: 12 monthly, 6 every 2 months, 4 quarterly, 2 semi-annual, 1 annual"),
            next_expected_date: z
                .string()
                .optional()
                .describe("Next expected charge date, YYYY-MM-DD"),
            start_date: z.string().optional().describe("Date of the first charge, YYYY-MM-DD"),
            end_date: z
                .string()
                .optional()
                .describe("Date of the last charge, YYYY-MM-DD. This records when it last billed; it does not cancel or deactivate anything."),
            service_type: z
                .enum(rm.SERVICE_TYPES)
                .optional()
                .describe("How Rocket Money files it: subscription, bill, utility, bundled, or unknown"),
        },
        annotations: WRITE,
    }, tool(async (args) => {
        const saved = await rm.updateSubscription(args.subscription_id, {
            name: args.name,
            // Dollars in, cents on the wire. Every Rocket Money money field is
            // integer cents, including this one, whose name does not say so.
            amountCents: args.amount === undefined ? undefined : fmt.toCents(args.amount),
            frequency: args.frequency,
            nextExpectedDate: args.next_expected_date,
            startDate: args.start_date,
            endDate: args.end_date,
            serviceType: args.service_type,
        });
        return {
            id: saved.id,
            name: saved.custom_name,
            amount: fmt.usd(saved.amount),
            frequency: saved.frequency,
            cadence: fmt.cadence(saved.frequency),
            startDate: saved.start_date,
            endDate: saved.end_date,
            nextBillDate: saved.expected_next_bill_date,
            serviceType: saved.service_type,
            ok: true,
        };
    }));
    server.registerTool("mark_subscription_active", {
        title: "Mark a subscription active",
        description: "WRITES to Rocket Money: tell it a subscription it had marked inactive is still being charged. This is the only direction `active` moves through the API - there is no matching call to mark a detected subscription inactive. Returns the resulting active flag.",
        inputSchema: {
            subscription_id: z
                .string()
                .describe("The subscription node id (the `id` field from subscriptions)"),
        },
        annotations: WRITE,
    }, tool(async ({ subscription_id }) => ({
        subscription_id,
        active: await rm.markSubscriptionActive(subscription_id),
        ok: true,
    })));
    server.registerTool("delete_subscription", {
        title: "Delete a subscription",
        description: "WRITES to Rocket Money: remove a recurring charge from the list entirely. For rows Rocket Money detected wrongly, duplicates, and charges that will never come back. This does NOT cancel anything with the merchant and it is not reversible from here - the row and its history are gone from the recurring list. Requires confirm=true. To correct a subscription rather than remove it, use update_subscription.",
        inputSchema: {
            subscription_id: z
                .string()
                .describe("The subscription node id (the `id` field from subscriptions)"),
            confirm: z
                .literal(true)
                .describe("Must be true. Deleting is not reversible from this server, so it is never the default."),
        },
        annotations: DESTRUCTIVE,
    }, tool(async ({ subscription_id }) => ({
        subscription_id,
        deleted: await rm.deleteSubscription(subscription_id),
        ok: true,
    })));
}
