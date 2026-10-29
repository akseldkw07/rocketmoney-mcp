# Categorizing person-to-person payments (Venmo and Zelle)

How Rocket Money transactions get categorized when money moves between people: splitting
a group charge, getting paid back, paying someone on another person's behalf, or paying a
roommate rent.

Rocket Money's rules can't express this. They have no OR or NOT, the order in which
overlapping rules apply is undocumented, and the right category depends on reading a
payment note. So an assistant applies these conventions by hand with this server's tools,
instead of through automatic rules.

Personal details (account and category ids, who usually pays for what, rent arrangements,
and which existing rules need migrating) live in `CATEGORIZATION.local.md`, which is
gitignored and never committed.

## 1. File by purpose, and net repayments in place

- **Every person-to-person payment, in or out, gets the category of what it paid for.**
  Never use a category that names the payment app.
- **A repayment goes in the same category as the charge it repays.** Rocket Money
  subtracts negative amounts inside an expense category, so the category nets to your own
  share.
  - Example: a $3,454.94 Airbnb in Travel & Vacation, plus seven $384 repayments also in
    Travel & Vacation, makes Travel & Vacation show $766.94.
- **Don't file repayments as `Reimbursement` or `Income`.** `Reimbursement` is an ignored
  category, so the offset disappears and spending looks too high. `Income` inflates earnings
  and leaves every category showing the full amount you paid.
- **A pass-through gets the same treatment.** That's a payment made entirely for someone
  else, which they then pay back. Both sides go in the category of what was bought, so they
  net to about $0. Don't ignore them.
- **A payment out to a friend for something you consumed** (a burrito, your half of a ride)
  goes in that thing's category.

This is "option A" from the design discussion. The rejected alternatives were B, ignoring
pass-throughs entirely, and C, keeping categories at full amounts and counting repayments
as Income.

## 2. The `Venmo` category holds only transfers between your own accounts

`Venmo` only ever holds money moving between your own accounts, and every row in it is
**ignored from everything**:

| Where it appears | Name looks like | What it is |
| --- | --- | --- |
| Venmo account | `Standard transfer` | Venmo balance cashed out to the bank |
| Bank account | `VENMO CASHOUT …` | The same money arriving at the bank |
| Bank account | `VENMO PAYMENT …` | The bank funding a Venmo payment. The matching row on the Venmo side is the one that counts. |

Anything else in `Venmo` hasn't been sorted yet and needs a real category.

Zelle has no transfer rows like these, because it moves money bank to bank, so every Zelle
row is a real payment.

## 3. Rocket Money defaults to override

- Incoming `Zelle payment from …` is automatically filed as **Internal Transfers**, which
  is ignored. That silently drops repayments, such as a roommate's rent share. Always
  recategorize these by purpose.
- **Merchants paid through Venmo** (Uber, Uber Eats, an Uber One membership, etc.) get the
  merchant's category.

## 4. Working out the purpose

Use these sources of evidence, in this order:

1. **The payment note.** For Venmo it's part of the transaction name (`Name "note"`). The
   Venmo MCP (`get_transactions`, `get_outgoing_requests`, `get_pending_requests`) also has
   the notes, including on requests.
2. **A matching charge.** Look for a charge where the repayment amount is the charge
   divided by N or a round share of it, usually posted days to weeks earlier. Repayments
   for one charge tend to arrive together.
3. **The person's usual pattern.** See the local file.
4. **Still unclear?** Make a best guess, add the transaction note `uncertain: <why>`, and
   list it for the user to confirm.

| Note contains | Category |
| --- | --- |
| airbnb, hotel, flight(s), trip, a named trip's `… group split` | Travel & Vacation |
| rent, apartment, a housing deposit | Rent |
| dinner, lunch, breakfast, brunch, burrito, beers, drinks, coffee, a restaurant name, Uber Eats | Dining & Drinks |
| uber, lyft, empower, cab, taxi, ride, citibike, gas | Auto & Transport |
| a long-distance train or bus that's part of a trip | Travel & Vacation |
| groceries, a grocery store name | Groceries |
| tix, ticket(s), game, concert, show, party entry, movie | Entertainment & Rec. |
| cleaning, furniture, tables, home goods, keys | Home & Garden |
| an actual gift (not "my share of …") | Gifts |
| emoji only, or a joke note | Best guess from timing and matching charges; mark it `uncertain` |

A `… group split` note (from Splitwise) settles one shared charge. Find that charge and use
its category.

## 5. Procedure (run on request, or as a periodic task)

1. **Collect the unsorted person-to-person payments since the last run:**
   - `search_transactions(account_ids=[<Venmo account id>], since=…)`
   - `search_transactions(query="Zelle", since=…)`
   - `category_transactions(<Venmo category id>)` for anything still sitting in `Venmo`
2. **Note `spending_summary` before making changes.**
3. **Decide each transaction's category** using sections 1 to 4. Apply the changes in
   batches with `set_transactions_category`, one call per target category.
4. **Leave transfers between your own accounts in `Venmo`** (ignored).
5. **Verify.**
   - `Venmo` now holds only transfers between your own accounts.
   - `spending_summary` changed only in the categories touched, by the expected amounts.
   - `updatedCount` matches the number of ids sent.
6. **Report back:**
   - What changed: counts and dollar amounts per category.
   - Every `uncertain` item.
   - Any tool that failed or fell short, as *action attempted, failure mode, goal*, so the
     MCP can be fixed.

## 6. What still belongs in Rocket Money rules

Keep only rules that are always right without any judgment:

- Transfers between your own accounts → `Venmo`, ignored from everything
- Merchants that only ever mean one thing (e.g. a software subscription, a therapy platform)
- A fixed counterparty with a single purpose (e.g. rent to one roommate)

Don't create catch-all rules that put a whole account, or every payment to a person, into
one category. They undo this procedure every time they re-run, and Rocket Money doesn't say
which rule wins when two overlap.

## 7. Transaction dates: date each expense to when it happens

> **Status: agreed, not implemented yet.** The MCP has no tool for changing a transaction's
> date (see "Tooling needed" below).

A transaction's date in Rocket Money (`Date`) should be **the day the thing happens**, not
the day it was bought. A flight bought in October for a trip in March is March spending.
Rocket Money keeps the card's posted date separately as `Original Date` (the CSV export
shows both), so changing `Date` doesn't lose the purchase date.

| What was bought | Date it to |
| --- | --- |
| A flight | That flight's departure date. For a round-trip ticket, the outbound departure. |
| Lodging (hotel, Airbnb, cabin, liveaboard) | The check-in date |
| A tour, safari, activity or class | The day it happens (or the first day, if it runs several days) |
| Event tickets | The event date |
| A rental car, or transport booked ahead | The pickup or travel date |
| A deposit or prepayment for a booking or trip | The date of the trip or booking it's for |
| A rent or housing deposit; prepaid rent | The lease start date; the first day of the month it covers |
| A refund or cancellation | The same date as the charge it reverses |
| A repayment from someone else (section 1) | The same date as the charge it repays, so the netting lands in the same month |
| Everyday spending (food, rides, shopping, bills, subscriptions, annual fees) | Leave as charged |

Rules of thumb:

- **Only change the date when it moves the transaction into a different month.** Shifting
  it a few days within the same month changes nothing that matters.
- **Where to find the date it happens:** confirmation and receipt emails (Gmail), the payment
  note, and the booking itself. If you can't find it, leave the date alone and mark the
  transaction `uncertain: date`.
- **Analyze by `Date`, not `Original Date`.** Month-by-month spending analyses and
  12-month windows should use `Date`. Cash-flow questions ("when did money leave my
  account?") use `Original Date`.
- **There's already an example of this:** the Montauk Yacht Club deposit was charged
  2026-07-23 and is dated 2027-05-14, the check-in day.

### Tooling needed before this can run

- A `set_transaction_date(transaction_ids[], date)` write tool. Capture the edit-date
  operation from the web app's transaction detail view.
- `search_transactions`, `category_transactions` and `preview_rule` returning both `date`
  and `original_date`.
- A way to filter or search by either date (`since` / `until` on `date` or `original_date`).
