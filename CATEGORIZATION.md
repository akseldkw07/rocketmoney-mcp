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

The rules that keep it this way:

- `Standard transfer` on the Venmo account → `Venmo`, ignore everything
- Name contains `venmo` on each bank and card account → `Venmo`, ignore everything

There is deliberately no rule that files a whole payment-app account into one category.

### Other money-transfer apps

The question for each app is whether it's linked to Rocket Money as its own account. Only a
linked app produces two rows for the same money (one on the app, one on the bank), so only a
linked app needs transfer rules.

| App | Linked? | Rows you'll see | Treatment |
| --- | --- | --- | --- |
| Venmo | Yes | Payments on the Venmo account; `Standard transfer` there; `VENMO CASHOUT` / `VENMO PAYMENT` on the bank | Payments by purpose; the transfer rows → `Venmo`, ignored |
| Zelle | n/a (bank to bank) | `Zelle payment to …` / `Zelle payment from …` on the bank | Every row is a real payment: file by purpose. Rocket Money files incoming Zelle as `Internal Transfers`, which is ignored, so always recategorize. |
| Cash App | No | `CASH APP*…` on a bank or card | Real payment: file by purpose |
| PayPal | No | `PAYPAL INST XFER …` (sent to a person), `PAYPAL TRANSFER` (money in from people), `PAYPAL *MERCHANT` (a purchase) | Person-to-person rows by purpose; `PAYPAL *MERCHANT` is an ordinary purchase |
| Apple Cash | No | `APPLE CASH SENT MONEY` (sent), `APPLE CASH` (topping up the balance), `APPLE CASH BANK XFER` (balance cashed out = money received from people) | All real money to or from people: file by purpose |

If an app that isn't linked today gets linked later, add the same pair of rules Venmo has:
its balance-to-bank transfer row on the app account → `Venmo` (ignored), and its name on the
bank and card accounts → `Venmo` (ignored). Then its person-to-person rows get filed by
purpose on the app side, and the bank-side rows for that app stop being payments. Without
the link, the bank-side row is the only record, so it must stay counted.

`Internal Transfers` and `Ignore` are ignored categories: Rocket Money ignores whatever is in
them, and moving a row out of them makes it count again (no separate ignore switch needed).

## 3. Rocket Money defaults to override

- Incoming `Zelle payment from …` is automatically filed as **Internal Transfers**, which
  is ignored. That silently drops repayments, such as a roommate's rent share. Always
  recategorize these by purpose.
- **Merchants paid through Venmo** (Uber, Uber Eats, an Uber One membership, etc.) get the
  merchant's category.
- **Duplicate imports.** When an account is reconnected, Rocket Money can re-import history
  under new transaction ids, so the same payment appears twice (same name and amount, dated
  within a day or two). Keep the older copy filed by purpose and move the newer copy to
  `Ignore`. Don't delete it: the MCP has no delete, and `Ignore` is reversible. Before
  marking a row as a duplicate, check that the copies sit on the same account and that the
  doubling covers a whole stretch of dates, not one coincidental pair.

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
| cash (swapping Venmo for paper cash) | Cash & Checks |
| a roommate Splitwise settle-up with no detail | Rent, marked `uncertain` (it mixes rent, utilities and supplies) |
| money from family that's paid back later | Put both directions in one category (Loan Payment) so it nets to about $0; mark `uncertain` |
| a legal or class-action settlement payout | Income |

If a note is missing entirely (Zelle, Apple Cash and PayPal rows have none), look for a
matching charge or Venmo note on the same day or with the same amount before guessing.

For `uncertain` items, write the transaction note on anything of $250 or more, and list every
uncertain item in a review file (`Finance/Rocket-Money/p2p-uncertain-review-<date>.csv`), since
notes go one call at a time.

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

### 7.1 The rule

| What was bought | Date it to |
| --- | --- |
| A one-way flight | Its departure date (local date at the departure airport) |
| A round trip or multi-city ticket on one charge | The first departure. Don't split one charge across legs. |
| Flights bought on separate charges | Each charge to its own flight's departure |
| Seat, bag, upgrade or change fees | The date of the flight they apply to |
| Lodging (hotel, Airbnb, cabin, liveaboard) | The check-in date, even for a stay that crosses a month boundary. Don't prorate by night. |
| A deposit and a later balance for the same stay or trip | Both to the check-in or trip start, so the whole booking sits in one month |
| A tour, safari, activity or class | The day it happens, or the first day if it runs several days |
| A multi-session series or season pass (lessons, a ski pass) | The first day of use |
| Event tickets | The event date |
| A rental car, or transport booked ahead (train, ferry, transfer) | The pickup or travel date |
| Travel insurance, visas, trip gear bought for one specific trip | The trip start date |
| A rent or housing deposit | The lease start date |
| Prepaid rent | The first day of the month it covers. Prepaying several months: date it to the first month, without splitting. |
| A deposit refunded at the end of a lease | Leave it on the day it's refunded (it closes the lease, it doesn't belong to a stay) |
| A refund or cancellation, full or partial | The same date as the charge it reverses |
| A repayment from someone else (section 1) | The same date as the charge it repays, so the netting lands in the same month |
| A repayment that settles several charges at once (a Splitwise settle-up) | The date of the largest charge it covers; if it's unclear, leave it alone |
| A pass-through (paid entirely for someone else) | Both sides to the date of the thing bought |
| Everyday spending (food, rides, shopping, bills, subscriptions, annual fees) | Leave as charged |

### 7.2 When to change it

- **Only change the date when it moves the transaction into a different month.** Shifting
  it a few days within the same month changes nothing that matters.
- **Only change it once the date it happens is known.** For a booking not yet made, or an
  open date (a flexible ticket, a voucher), leave it alone.
- **If the trip moves,** move the dates of all its transactions to the new date. If it's
  cancelled, the refund goes to the original charge's date (so both net in the same month),
  and any non-refundable part stays on the date the trip would have started.
- **Future dates are fine.** A flight for next March is dated next March, even though that
  month hasn't happened yet, so this month's spending shows only what was consumed.

### 7.3 Finding the date

Use these sources in order:

1. The confirmation or receipt email (Gmail): itinerary, check-in, event date.
2. The payment note, for person-to-person payments.
3. The booking itself, or the user's calendar.

If none of these settles it, leave the date alone and add the transaction note
`uncertain: date`.

### 7.4 Recording the change

- Rocket Money keeps `Original Date`, so the purchase date isn't lost.
- Add the transaction note `dated to <event> <YYYY-MM-DD>` (for example
  `dated to check-in 2027-05-14`) so the reason is visible in the app.
- List every re-dated transaction in the run's report: id, original date, new date and
  reason.

### 7.5 Using the dates

- **Analyze by `Date`, not `Original Date`.** Month-by-month spending analyses and
  12-month windows should use `Date`.
- **Cash-flow questions use `Original Date`** ("when did money leave my account?",
  card-statement reconciliation).
- **Example:** the Montauk Yacht Club deposit was charged 2026-07-23 and is dated
  2027-05-14, the check-in day.

### Tooling needed before this can run

- A `set_transaction_date(transaction_ids[], date)` write tool. Capture the edit-date
  operation from the web app's transaction detail view.
- `search_transactions`, `category_transactions` and `preview_rule` returning both `date`
  and `original_date`.
- A way to filter or search by either date (`since` / `until` on `date` or `original_date`).
