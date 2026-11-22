# Rocket Money backfill: open questions

> Working copy, updated 2026-11-22 (second pass) from Rocket Money (rows through 11-21), Gmail, iMessage and WhatsApp. Tracked on the `backfill` branch only, not for main: names people and amounts. Answer inline; Claude's replies are marked **Claude:**.
>
> Venmo can't be read from South Africa right now, so whether anyone has paid their Venmo group shares since 11-09 is unverified.

## Open questions

**Needs you:** items 2 and 3 under "Follow-ups from the accounts audit" (item 1 is in progress). Everything else is marked **OPEN** with what it is waiting on.

### Follow-ups from the accounts audit

**Status: OPEN, waiting on you.**

1. **Macy's: the receipts are in Gmail.** Each "Thanks for your order" email has the items, the total and the card used. Online orders found (dates approximate, from the emails): 2532967694 (2022-10), 2652703568 and 371778567 (2023-02-20), 2670053775 (2023-02-25), 2670681882 (2023-02-25, canceled), 2680225506 (2023-03-19), 2848891865 (2023-12), 2999768666 (2024-09), 4717839741 (2026-02). I have read one in full so far: 2652703568, a London Fog overcoat, $98.75, paid with "American Express ending 1003" (https://mail.google.com/mail/u/0/#all/18671a27762b3a56). The linked Macy's card ends 3454, so 1003 is either the same account before a reissue or a different Amex; **which is it?** Next step: read the other seven, add the in-store purchases and returns from your PDF, and check the net against the $727.01 of payments before creating rows. Statements would still be the cleanest check if you get them.
   - Answer:
2. **Self-custody crypto: mostly answered, you did cash it out.** In June 2022 you sent coins back to Crypto.com, sold them and withdrew dollars to Chase. Those are the three "FORISUS_METRCOBK CardtoBank" credits already in Rocket Money (ignored as transfers): $100.00 (06-08), $346.87 (06-14), $859.55 (06-21), **$1,306.42 in all**.
   - The $859.55 is exact: "You have sold 140.4662 ATOM for 859.55 USD" (2022-06-17, https://mail.google.com/mail/u/0/#all/1816f1a62b247bbb), after a crypto deposit back into Crypto.com the same evening.
   - The $100 and $346.87 follow a BNB deposit and "BNB sell request confirmed" on 2022-05-31 / 06-01. I haven't opened that email, so the BNB amount sold is not confirmed.
   - What went out on 2022-04-17 was 255 ATOM (to the Cosmos wallet, now empty on Cosmos Hub) and 7.82 BNB (to MetaMask on BNB Smart Chain). So about 115 ATOM and some BNB never came back through Crypto.com: lost in the pools or the price drop, sold elsewhere, or still sitting in Keplr (Osmosis) or MetaMask. No other crypto-looking deposit reached Chase checking since June 2022; I went through every credit that isn't payroll, Zelle, Venmo, a brokerage or a tax refund.
   - **Still worth one look:** open Keplr and MetaMask. If what's there is under $100, tell me and I'll note it and close this.
   - Answer:
3. **Bilt fee refund ($212.88).** Bilt has no support email; card support is the in-app concierge chat or the phone number on the card. I drafted the message (in chat). Say if you want me to send it through the Bilt app on your phone, or send it yourself.
   - Answer:

### Waiting on Venmo

**Status: OPEN, waiting on you being back in the US.** I'll update the notes when they're in.

- [ ] **OPEN:** **Shooting, $306.45:** add to Waka Waka as 9 shares of $34.05. You and James $68.10 each, the other five $34.05 each; $238.35 comes back to you.
- [ ] **OPEN:** **Tip for Michael, R5,693.73:** paid, not yet posted to Rocket Money, not yet requested. Request Margaret R1,226.76, James R671.16, and Adam, Faythe, Rachel and Sarah R613.38 each (about R4,351, roughly $265; use the rate on the posted charge).
- [ ] **OPEN:** **Spectrum November, $64.47:** add to Survivors the same way as October.
- [ ] **OPEN:** **TreeHouse group activity (back in the US):** download the TreeHouse Venmo group's activity. The old apartment's Spectrum bill ran on the Southwest card, Aug 2022 to Jul 2023 ($116.75, then 11 x $94.99 = $1,161.64), and was shared through that group, not Survivors. With the group's activity I can match each month's repayments to the Spectrum charges in the CSV and work out your net. I'll check the Venmo connector first when you're back; if groups still aren't readable, export or screenshot the group and I'll take it from there.

### Outstanding splits (waiting on other people)

**Status: OPEN, waiting on repayments.**

About $3,057 owed to you, none paid as of your 11-22 answer.

| Charge | Date | Who owes | Amount | Status |
| --- | --- | --- | --- | --- |
| Montauk Yacht Club deposit | 2026-07-23 (dated 2027-05-14) | Margaret Hood | $285.06 | Requested 10-29 |
| Gooder | 2026-11-02 | James | $77.00 | Requested 11-02 |
| Stones Safaris payment 1 | 2026-10-20 (dated 11-16) | Waka Waka, 6 people | $976.97 | Added 11-09 |
| Stones Safaris payment 2 | 2026-11-09 (dated 11-10) | Waka Waka, 6 people | $1,054.91 | Added 11-09 at the estimate |
| Avis car rental | 2026-09-22 (dated 11-14) | Waka Waka, 6 people | $386.75 | Added 11-09 |
| Con Ed October | 2026-10-27 | James + Evan (Survivors) | $224.01 | Added 11-09 |
| Spectrum October | 2026-10-20 | James + Evan (Survivors) | $52.83 | Added 11-09 |
| Manhattan Propane | 2026-11-10 | Survivors | share of $52.26 | You added it to the group |

### Watching

**Status: OPEN, nothing to do unless something changes.**

- **Avis damage claim.** No extra charge on any card through 11-21 and nothing from Avis in Gmail, WhatsApp or iMessage beyond the rental agreement (https://mail.google.com/mail/u/0/#all/1a1d9f0c7f7cefe3). Avis South Africa is run by Zeda, so a charge or email may say ZEDA. I'll flag any new AVIS or ZEDA row in the daily run.
- **Amazon Store Card 7199.** Still disconnected. Per you: nothing to do now; if access comes back, revisit all its transactions and the proxy payments.

## Completed

### Closed 2026-11-22 (audit follow-ups)

- **Betting and prediction markets: all Entertainment & Rec. and counted, per you.** Changed: FanDuel's $380 withdrawal (was Internal Transfers, ignored), and Kalshi's four rows (were Investment, Income, Uncategorized). DraftKings and FanDuel's deposit were already there. Nets: DraftKings +$679.25, FanDuel +$280, Kalshi -$206 ($304 in, $98 out, $0.29 left).
- **PayPal $5,000 to "KOK4" (2022-07-06): confirmed as repaying your mom.** Your texts that day: "You lent me 5k", her "Ok I requested $5k from you by PayPal", your "Done"; PayPal because Venmo was frozen. The loan came in by Venmo on 2022-06-21 ($2,000 + $3,000). All three rows were already Loan Payment and net to $0; notes updated, "uncertain" removed.
- **Acorns, X1:** linked and empty; remove whenever. **Binance.US:** retry from the US.

### Untracked accounts audit: first pass and linking (2026-11-22)

**Status: DONE; what is left is under "Open questions" at the top.** Task from Aksel: find every financial institution he has had an account with that Rocket Money doesn't track (banks, brokerages, crypto, betting, credit and store cards, payment apps), using Gmail and Rocket Money transactions, especially transfers.

How I looked: all 1,380 Chase checking rows grouped by counterparty (every payment or transfer to something that isn't a linked account), merchant searches across all Rocket Money accounts, and Gmail searches by sender for about 120 banks, card issuers, brokerages, crypto exchanges, sportsbooks and payment apps, plus statement, welcome and tax-form emails. "Rocket Money" amounts cover 2022-06-02 onward only. Gmail shows that an account existed, not its balance.

**A. Cards and bank accounts whose spending Rocket Money can't see (these change spending totals)**

| Account | Evidence | Active | Seen in Rocket Money | Status | Aksel Progress |
| --- | --- | --- | --- | --- | --- |
| **Bilt Blue Card (Cardless)** | Statements from "Cardless - Bilt Card" 2026-09 to 2026-11-21, autopay notice for 11-10; "BILT CARD PMT" from checking | 2026-05 to now, **open** | 5 payments, $4,077.70 ($3,982.20 on 2026-05-18, then $64.73, $9.99, $9.99, $10.79), all ignored as card payments | **Not linked. Biggest live gap.** The purchases behind these payments aren't anywhere in Rocket Money | synced |
| Macy's American Express (Citi) | Statements from Citi through about 2025-07; "MACYS AUTO PYMT" from checking | 2023-04 to at least 2025-07 | 11 payments, $727.01, 2023-04-17 to 2024-10-16 | Not linked; purchases not visible |synced |
| Citi Access Checking 0628 | "Welcome to your Citibank account" 2022-03-05; monthly-fee emails 2024-07 and 2024-12 | 2022-03 to at least 2024-12 | 4 transfers into Chase, $1,750.51 (2022-06-15 to 2024-12-03) | Not linked. Anything paid from it, and its fees, are missing | this account might be closed? or the account number changed? look for clues of continuity in gmail or citi |
| Amazon Prime Store Card 7199 (Synchrony) | Monthly statements and autopay reminders through 2026-11 | open | Disconnected since 2026-01-23 | Known; still producing statements, so purchases since January are missing | sync attempt failed |
| Chase Southwest Plus 0112 | Known (closed) | 2022-08 to 2023-09 | 13 payments, $6,190.97 | Backfilled 11-22 (see Completed) | n/a |
| CareCredit 6162 (Synchrony) | Known (LASIK) | 2021-02 to 2023-03 | 10 payments, $1,989 | Backfilled 11-22 (see Completed) | n/a |
| Apple Cash | "APPLE CASH" rows in checking | 2023-04 to 2026-03 | $700 out (3 rows), $716 back (2024-08-08) | Not linkable; small | ignored |
| PayPal balance | Monthly PayPal account statements 2026-03 to 2026-10 | ongoing | In: 3 transfers, $265.50. Out: $5,169.06 on 2022-07-06 (incl. $5,000 to "KOK4"), $196.88 on 2026-03-17 | Not linked. Card-funded PayPal purchases already show on the cards | syncd |
| Affirm / Shop Pay Installments | GeoJango Maps plan approved 2022-08-23, payment 2022-09; an application 2024-11-28 | 2022 | Nothing under "Affirm" | Small; payments may sit on a card under another name | not available |
| Capital One card (Venture) | Approved 2019-07; statements 2021-01 and 2021-08 ($0.00 balance) | 2019 to 2021+ | No payments since 2022-06 | Before Rocket Money history; may still be open and unused | no applicable account |
| Apple Card | "Welcome to your new Apple Card" 2019-11-30 | 2019 to ? | No Goldman payments since 2022-06 | Before history. Apple is now emailing you to *apply*, so it looks closed | synced, looks like apple cash is only account|
| Citi Rewards+ | Welcome 2020-07-15 | 2020 to ? | n/a | Probably became today's linked Citi card (unconfirmed) | ignore |
| X1 Card 1746 | Activated 2023-03, "Your account has been closed" 2024-09-12 | 2023-03 to 2024-09 | Linked, zero transactions | Closed; can be removed from Rocket Money | synced |

> **Claude (checked 11-22 against Rocket Money's account list and the new rows):**
> - **Bilt Blue Card 2132: linked, history from 2026-02-07.** It is the same card number as the old Wells Fargo Bilt card (2132), which moved to Cardless in February, so there is no overlap: Wells Fargo's last purchase is 02-05 and this starts 02-07. Three things to fix or know:
>   - **"Balance Transfer" $3,188.13 (2026-02-19) is counted as spending (Uncategorized).** It is the old Wells Fargo balance moving over (Wells Fargo shows the matching -$3,188.13 payment, ignored), so it double counts purchases already in Rocket Money. Should be ignored.
>   - **The $3,982.20 payment (05-16) was not rent.** It is that $3,188.13 plus about $580 of subway and lunches (Feb to Apr) plus **$141.88 of interest and $71 of late fees** (04-16 to 05-21), because the transferred balance sat unpaid for three months. Those are now counted under Fees, which is right. Worth asking Bilt to refund them, since the balance came from their migration.
>   - **Kalshi $102 on 2026-02-09 now appears twice:** once on this card and once on Chase checking ("KALSHI KALSHI.COM NY 02/09"). Were there two $102 deposits that day, or one? Both are in Investment, so spending totals aren't affected either way.
>   - The "BillPay Account 4505" that came with it has no transactions.

AKSEL: i downloaded kalshi history. separate deposits. Re the payment with fees + balance transfer - there should only be one rent payment per month. remove the duplicated one. follow up if this is unclear, and provide me with more context

> - **Macy's Amex 3454: linked, but no history came with it.** Only two $0.00 interest lines from 2025-07. The purchases behind the $727.01 of payments (2023-04 to 2024-10) are still missing; statements would be needed to backfill them. Balance is $0.

AKSEL: I downloaded the macy's activity to local/ as well

> - **PayPal: linked, and three of its rows double count charges already on a card or checking.** All three are counted now:
>   - "Payment to McCune Ranch LLC" $3,062.50 (2025-05-19, Shopping) = Amex "PAYPAL *MCCUNERANCH" $3,062.50 (05-20), the Hog Hunt balance.
>   - "Payment to MW/TD Inspired LLC" $52.28 (2025-01-02) = Amex "PAYPAL *PINUTRITION" $52.28 (01-03).
>   - "Payment to Petar Pavlovic" $197.99 (2026-03-16) = checking "PETAR PAVLOVIC IAT PAYPAL" $196.88 (03-17); the $1.11 difference was paid from the Flixbus settlement credit sitting in PayPal.
>   - The two Flixbus settlement credits ($1.11, $0.62) are new and fine.

AKSEL: lets avoid duplicates. i'm fine with keeping either paypal or amex, but just keep it consistent (write a rule about this for other similar cases)

> - **Apple: linked as Apple Cash only (no Apple Card), as you noted.** Its two "Transfer" rows ($90 on 2025-11-29, $10 on 2026-03-29) double count the "APPLE CASH SENT MONE" rows on checking. One side should be ignored.
> - **Amazon store card 7199:** it is switched back on but still shows "disconnected"; balance $1,555.53.
> - **X1:** still linked with zero transactions; closed 2024-09, so safe to remove whenever.
> - **Citi checking 0628: it looks closed in early 2025, not renumbered.** Monthly statement emails for "primary account ending in 0628" (debit card ending 1192) run through the statement ending 2025-02-19 and then stop. The last activity I can see is the transfer request on 2024-12-03 (the $651 that landed in Chase). There is no closure email and no email mentioning a new account number. Every Citi email since is about the credit cards. If Citi's site shows no checking account, that matches.
> - **Done 11-22 on your go:** set to "ignore everything" the Bilt balance transfer, the three PayPal rows and the two Apple Cash rows. That removes $6,600.90 of double counting.

AKSEL: your proposed fix is fine by me

**B. Investment and savings accounts (net worth only, not spending)**

| Account | Evidence | Active | Seen in Rocket Money | Status | Aksel Progress |
| --- | --- | --- | --- | --- | --- |
| **Webull** (account ending WNM3) | Opened 2024-06-28; monthly statements through 2026-10; trade confirmation 2026-07-09; tax-document email 2026-01 | 2024-06 to now, **open** | No transfers to or from Chase under any Webull name | **Not linked.** Funding source unknown | synced - need to delete manual roth - done|
| **Inspira Financial HSA** (via Aetna) | Identity-verification request from Inspira's HSA team 2026-01-05; "A message from Aetna/Inspira Financial" through 2026-11-06 | 2026-01 to now | None (the 14 INSPIRAFINANCIAL rows, $9,643.12, are COBRA premiums, already counted) | **Not linked.** A second HSA alongside the Fidelity one | couldn't connect - no account exists afaik -- please dounle check that no account exists |
| Acorns | 1099 for tax year 2020 | 2020 to ? | None | Before history | synced - will delete soon |
| Forge Global | "Welcome to Forge" 2026-04-29 | 2026 | None | Signup only, no sign of funding | ignore |

> **Claude (checked 11-22):**
> - **Webull: linked as a Roth IRA, $65,127.69.** Robinhood's Roth IRA 8811 shows $0, which fits it having been moved to Webull; that would also explain why nothing came from Chase.
> - **Inspira HSA: I agree, I find no sign one exists, and my entry above was wrong.** All eleven Inspira emails outside the COBRA mailbox are either "COBRA documents are ready" notices (2025-06 to 2026-11) or a PayFlex password reset (2025-06-04). The one email from an "HSA CIP Member Requests" address (2026-01-05) asks you to resend proof of address as a PDF; it is an identity check and mentions no account, balance or contribution. There are no HSA statements, contribution notices or HSA tax forms (1099-SA, 5498-SA) from Inspira. The only open question is what you uploaded documents for in January.
> - **Acorns:** linked, $0, no transactions.

**C. Crypto**

| Account | Evidence | Active | Seen in Rocket Money | Status | Aksel Progress |
| --- | --- | --- | --- | --- | --- |
| Crypto.com | Welcome 2022-03-16; deposits and USD withdrawals through 2022-06; login 2023-04 | 2022-03 to 2023 | $20.23 in; $1,306.42 back to Chase in June 2022 (ignored as transfers) | Deposits were before history | can't link, only has $2.5 |
| Coinbase | Welcome 2020-12-31; BTC sent out 2021-01; ATOM sent out 2022-04-05; still emailing | 2020-12 to 2022+ | None | Crypto was moved off-exchange at least twice | not supported, i just withdrew all my money to my chase account |
| Binance.US | Tax statements for 2022 and Q1 2023 | 2022 to 2023 | None | Taxable activity in 2022 | couldn't sign in, will try later from inside the US. balance is $0 |
| Kraken | Activated 2021-04-19; new-device logins 2022-04 | 2021 to 2022 | None | couldn't link, $0 balance |
| FTX.US | Identity verified 2021-07-19; bankruptcy notices 2023-07 to 2025-01 | 2021 | None | You were noticed as a possible creditor; I found no claim or payout email |
| Self-custody wallets | Coinbase sends to an external BTC address and a Cosmos address | 2021 to 2022 | None | Can't be tracked from here |

Aksel: what about keplr / walletmask / metamask / cosmos? I dabbled in some crypto coins in 2022/2023

> **Claude (11-22), on Keplr / MetaMask / Cosmos:** wallets like these never email, so Gmail only shows the transfers into them.
> - **Cosmos wallet `cosmos1eclwcdxftccglh93kzlg4cuvy3jzy4hcycr7nn`** (Keplr-style): Coinbase sent it 0.1 ATOM (2022-03-29) and 5.08 ATOM (2022-04-05). I looked the address up on the Cosmos Hub chain today: **balance 0, nothing staked.** The same wallet has separate addresses on Osmosis and other Cosmos chains that I can't derive from this one, so anything swapped into OSMO or pooled there wouldn't show. Opening Keplr would settle it.
> - **Context:** family emails from 2021-08 to 2022-03 about converting HNT to Osmosis and yield farming ("Crypto introduction", "HNT to Osmosis flow chart"), which matches the timing.
> - **Crypto.com** sent crypto out twice (2022-03-30 and 2022-04-17, "Crypto Withdrawal Succeeded"); I haven't opened those to see the coin or destination.
AKSEL : please take a look at this to see where it went
> - **Coinbase** sent 0.0287 BTC to an outside address on 2021-01-28.
> - **MetaMask, Phantom, Ledger, Uniswap, OpenSea:** nothing in Gmail at all.
> - Coinbase withdrawal to Chase that you just made: not in Rocket Money yet; I'll note it when it posts.

Robinhood crypto is inside the linked Robinhood account. The "Celsius Class Ac Payouts" credit of $23.66 (2023-06-05) is a class-action payout; nothing in Gmail from Celsius Network, so I don't think you had an account there.

**D. Betting and prediction markets**

| Account | Evidence | Active | Seen in Rocket Money | Net to you | Aksel Progress |
| --- | --- | --- | --- | --- |--- |
| DraftKings | Welcome 2021-01-25; withdrawals 2023-03 and 2025-08-27 | 2021 to 2025 | In $7,000 (2023-03-07, 03-09); out $7,329.25 (2023-03-13) and $350 (2025-08-27) | +$679.25 | can't connect |
| FanDuel | Verified 2021-12-31; withdrawal 2023-10-28 | 2021 to 2023 | In $100; out $380 (both 2023-10-30) | +$280 | can't connect |
| Kalshi | Deposit notice 2024-07-08 | 2024 to now | In $100 (2024-07-08) and $102 (2026-02-09); out $98 (2024-07-19) | −$104 (the $102 may still be on the platform) |can't connect |
| BetMGM (Pennsylvania) | "Important update regarding your deposit" 2023-03-09; dormant-account notices 2026-01 and 2026-03 | 2023-03 | None | Deposit seems to have failed; nothing reached the bank | can't connect |
| Polymarket | Terms and promo emails 2026-09 to 2026-10 | 2026 | None | Account exists; crypto-funded, so invisible here | new account, no trades |

Nothing found for Caesars, ESPN Bet, Fanatics, PrizePicks, Underdog or PredictIt.

**Checked and not separate accounts:** J.P. Morgan "investments statement" emails are the linked Chase Roth IRA 8215. Wells Fargo "BILTCRDCRD" payments ($18,966.92, 2025-10 to 2026-01) are the old Wells Fargo Bilt card, which is linked (listed as Autograph 1880; last transaction 2026-02-19). Wise only has a feedback and privacy email (2026-06), no transfer. Splitwise Pay $722.23 (2023-07-13) is a payment to a person, not an account. Capital One "credit limit" emails are CreditWise monitoring. Nelnet is Columbia's tuition plan. WageWorks was a 2019 commuter benefit.

**Not covered in this pass:** transfers to other institutions from inside Venmo, and accounts that only ever emailed another address (for example a work or school address).

> **Outcome (11-22):**
> - Linked by you: Bilt Blue Card 2132, Macy's Amex 3454, PayPal, Apple Cash, Webull Roth IRA, Acorns. Not linkable or failed: Amazon store card (still disconnected), Crypto.com, Coinbase, Binance.US, Kraken, the sportsbooks, Kalshi.
> - Six double-counted rows ignored and noted ($6,600.90): Bilt balance transfer $3,188.13, three PayPal rows ($3,062.50, $52.28, $197.99), two Apple Cash rows ($90, $10). Rule written in `CATEGORIZATION.md` ("Pass-through wallets"): the card or bank row is counted, the wallet copy is ignored.
> - Rent checked for 2025-12 to 2026-06: one counted rent charge per month (Bilt rent on the Wells Fargo card through February, then 114 East 28th St from checking). The only duplicate was February's rent inside the Bilt balance transfer, now ignored.
> - Kalshi: your activity export confirms two separate $102 deposits on 2026-02-09 (both noted). All-time: $304 in, $98 out, $0.29 left.
> - No Inspira HSA exists; Citi checking 0628 looks closed since early 2025; no Apple Card.


### Backfilled with the create-transaction tool (2026-11-22)

- [x] **Southwest card 0112: done.** 123 rows created from `local/chase-southwest/chase-southwest-0112.csv`: 121 purchases and fees ($6,789.95) and the two merchant credits (Patrizia's -$400, Southwest -$198.98), net $6,190.97, which equals the 13 payments from checking (still ignored). Each has its statement date and a category, is counted, and is named with an "SW0112 " prefix, so searching "SW0112" lists them all. Manual rows can't attach to a closed card, so they sit in Rocket Money's manual Cash account. Patrizia's ($1,397.29, 2022-11-06) is noted with the split; your net is $185.69.
  - Categories I chose, say if any are wrong: 7-Eleven, Wawa, OXXO and minimarkets as Groceries; CVS and Duane Reade as Health & Wellness; FedEx, Macy's, Hudson News as Shopping; Fauquier County General District Court ($110.24) as Legal; the Mexico trip (July 2023) hotel, Scuba Luis ($1,120.13) and "ZTL*ANDRESFERNANDEZALV" ($78.34) as Travel & Vacation, its taxis as Auto & Transport, meals as Dining, and the 20 foreign transaction fees ($54.34) as Fees; Southwest tickets and points as Travel.
  - **Southwest receipts found (11-22) and rows updated:** $5.60 is the fee on award ticket 4X4OUC, Chicago Midway to Philadelphia, now dated 2023-03-12. $106.87 is taxes on award ticket 4FR8C4, LaGuardia to Cancun, 06-30 to 07-09, and the $108 points purchase was made minutes before that booking; both now dated 2023-06-30. $198.98 was 2FQNE9, LaGuardia to Dallas on 05-26, canceled and refunded the next day; left on its purchase dates. Receipt links are in each note.
  - **Still open:** the 12 Spectrum charges ($1,161.64) are Bills & Utilities and noted as shared; your net waits on the TreeHouse activity (under "Waiting on Venmo").
- [x] **LASIK: done.** 14 rows of $199, 2021-04 to 2022-05 ($2,786), named "CareCredit 6162 payment (LASIK)", Medical, set to ignore everything as you suggested, since all predate the history. Dated the 13th of each month, which is approximate (the later real payments posted around then). The 10 synced payments stay counted.
- Settled: manual transactions can be back-dated (2021 worked).

### Closed 2026-11-22

Replies to your second round of comments are marked **Claude:**.

**Closed in the fifth pass**
- **Southwest statements, "April gap":** **Claude:** you're right, and nothing is missing. Chase lists no April 2023 statement because there was nothing to bill: March closed at $315.46, your checking paid exactly that on 04-03, there were no purchases in the cycle, and May opens at $0.00. The list also ends at Aug 22, 2023 because that was the last statement: its $94.99 (one Spectrum charge) was paid by autopay on 2023-09-20, which is in Rocket Money and now noted. So the CSV has every purchase the card ever had. It ties out end to end: purchases and fees of $6,789.95, less two merchant credits ($400 Patrizia's, $198.98 Southwest), is $6,190.97, exactly what your checking paid the card over 13 payments (11 on the statements, plus 04-03 and the final 09-20).
- **Spectrum on the Southwest card:** shared with roommates through the TreeHouse Venmo group. Pending task added under "Waiting on Venmo".
- **Create-transaction tool:** task brief written for your other agent (also saved as `local/TASK-create-transaction.md`).

**Closed in the fourth pass**
- **Old Citi card double counting:** you said go. **Claude:** done. 394 rows on the old card are now "ignore everything": all of import B and import A from 2025-01-22 on, $15,069.29. Checked afterwards: the old account has 207 counted rows left, $5,338.80, the last dated 2025-01-20, and nothing counted after that. The record is now the old card to 2025-01-21 and card 2766 from 2025-01-22. Nothing was recategorized or deleted, and the old rows keep their notes.
- **Southwest statements to CSV:** **Claude:** done: `local/chase-southwest/chase-southwest-0112.csv` (gitignored), 134 rows with date, description, amount, type and statement date. Every statement's purchases, fees and payments reconcile to its own summary box. Totals: purchases $6,666.61, fees $123.34 ($69 annual fee, $54.34 foreign transaction fees). The 2023-07 statement is a Mexico trip (Cozumel dive shop $1,120.13, hotel $199.22). Two gaps are in New question 2.
- **Patrizia's, Nov 2022: solved.** **Claude:** the statement shows the bill: **$1,397.29 on 11-06**, which is 15 seats at $93.20 ($1,398), so 15 people came, not 20. Patrizia's also credited $400 to the Southwest card on 11-08 while keeping the $400 deposit on your Amex, so the total paid is $1,397.29. Thirteen seats were repaid (12 on Venmo, plus Katie Burke's $60 + $30 + $3.20) = $1,211.60, and the other two seats were yours: net $185.69. Nobody is outstanding. Noted on the $400 Amex row and on the 11-10 card payment. Rocket Money still lacks $997.29 of the bill; see New question 1.
- **Copa:** **Claude:** moved to Gifts. One caution: your "COPA MIA WEB -> Travel" rule could move it back if it re-runs; tell me if that happens and I'll narrow the rule.

**Closed in the third pass**
- **Copa, Panama, Dec 2025 ($538.48 on 12-08):** Margaret's ticket, a gift. **Claude:** noted on the row; no repayment expected. I left it in Travel & Vacation; say if gifts like this should go to Gifts.
- **LASIK total:** **Claude:** found it. Wang Vision Institute, Nashville; the first CareCredit statement (Mar 2021) shows **$4,775.00** (https://mail.google.com/mail/u/0/#all/178522fbf5d43941), on their 0% for 24 months plan: 23 x $199 + $198, Apr 2021 to Mar 2023. Rocket Money has the last 10 ($1,989); the first 14 ($2,786) predate it. Creating them isn't easy: my Rocket Money connector can edit transactions but can't create one, so it would mean adding 14 manual transactions in the app. Per your rule I skipped the pre-Rocket Money part and put the full cost and the split on each of the 10 rows.

**South Africa**
- Stones Safaris payment 2: group entry left at the $1,230.73 estimate (card posted $1,231.22).
- Parking was free. **Claude:** checked off "Parking" in your TODO note, in the Notes app with its checkbox. I left "Extra charges Michael stone" and "Tip Michael stone" unchecked because the Venmo requests are still to do.
- Ten small trip charges (Table Mountain x2, Uber x2, Spar, Gardenfresh, Cattle Baron, YOCO ABSA, Piece a Pizza, Reef Surf Shop): all yours, noted "split: none (mine)".
- Five 11-21 charges (Cape Town Fishmarket, By Nature, Zasia, Mark Everts, Mogamat's vending): all yours. Fishmarket and By Nature moved to Dining & Drinks.

**Categories that changed your totals**
- **KBM Hawaii $9,601.61:** Vrbo house in Hawaii from KBM Resorts, Feb 22 to Mar 2 2025, 10 adults, $20,501.22 total (booking https://mail.google.com/mail/u/0/#all/1917216abdc2f4d9; host canceled 2024-11-01 https://mail.google.com/mail/u/0/#all/192e8cb79e19a6cf; Amex credit https://mail.google.com/mail/u/0/#all/1939c5dba7984ec1). Charge and refund are both Travel & Vacation and counted. **Claude:** dates are now the same: the charge, its refund, the $1,298 Vrbo fee and the fee's refund are all dated 2024-08-22, so they net to $0 on one day. The original posting dates are kept in Rocket Money and in the notes.
- **Amazon store card payments** ($751.64 on 2025-10-24, $300 on 2025-11-06): Credit Card Payment, ignored.
- **Synchrony $199/month, Jun 2022 to Mar 2023 ($1,989):** **Claude:** got it, the 0% CareCredit card for your March 2021 LASIK, not Amazon and not your mom's. All 10 payments are now Medical with that in the note. They stay counted, since the card was never linked and they're the only record. Its last statement before payoff showed $596 (https://mail.google.com/mail/u/0/#all/1853250dd056f978).
- **Barclays "Insufficient Funds" $2,417.78 (Nov 2023):** ignored; the payment was resubmitted and cleared the same day. The $29 fee and $69.52 interest stay in Fees.
- **MCBHAPPIER $2,400 (2025-03-14):** Michael Bryan, life coach. MCB & Therapy, counted.

**Follow-ups**
- **LiveAboard (Indonesia), $8,161.72 across three charges:** Eva's 2 x $550 was her share; Katrina isn't being asked. **Claude:** confirmed as Travel & Vacation, all three rows.
- **Florida hunting trip, May 2024:** $1,036 deposit (2024-04-11, Barclays) + $1,372.70 balance = $2,408.70; Hudson and James repaid $1,862.37; your net $546.33 (https://mail.google.com/mail/u/0/#all/18ebde067591100d). **Claude:** moved to Travel & Vacation. I moved the balance too, not only the deposit, so both charges sit with the repayments and the trip nets in one category. Say if you wanted the balance left in Entertainment & Rec.
- **Margaret, "corrected flight!" $590.52:** United NSR8N5, Honolulu to Chicago for both of you (https://mail.google.com/mail/u/0/#all/19c7d44b62232dc8): her ticket $546.10 + her $44.42 change fee. **Claude:** done per the policy: the four United charges and her repayment are all dated to the flight, 2026-06-11 (they were 06-03 and 02-27).
- **Patrizia's, Nov 2022:** group chat is iMessage "Patrizia's" (from 2022-11-02); table for 20 on Sat 2022-11-05; the Amex only has the $400 deposit (2022-10-06). **Claude:** the Southwest card explains it. I added a global note to `CATEGORIZATION.local.md` (Open items) and to each of its 10 payment rows, and the $400 deposit row now points to it. What that card lets me answer, and the new questions it raises, are New questions 2 and 3 above. It doesn't explain anything else I had open: the only other "charge not found" case was the April brunch, which turned out to be Roses Diner.
- **Brunch, Apr 2026:** Roses Diner, Netcong NJ, $175.18. **Claude:** done. It was already Dining & Drinks; the charge and all seven $22 repayments are now dated Sunday 2026-04-12 and tagged "Caroline Hegemon + Kurt Bertone weekend brunch", so they net to your $21.18 on that day.

**Linked accounts (as of 2026-11-22)**

"Last transaction" is the newest row Rocket Money holds for the account.

| Firm | Account | Number | Last transaction | Syncing |
| --- | --- | --- | --- | --- |
| Chase | Checking (CHASE COLLEGE) | 9979 | 2026-11-16 | true |
| Chase | United | 5844 | 2026-11-21 | true |
| Chase | Freedom | 2734 | 2026-08-02 | true |
| Chase | Roth IRA | 8215 | balance only | true |
| American Express | Delta SkyMiles Gold | 2001 | 2026-11-21 | true |
| American Express | Additional Delta Reserve | 5025 | 2025-02-18 | true |
| Citibank | AAdvantage MileUp | 2766 | 2026-11-20 | true |
| Barclays | JetBlue | 2059 | 2026-11-06 | true |
| Bank of America | Visa Rewards | 4566 | 2026-09-19 | true |
| Wells Fargo | Autograph Visa | 1880 | 2026-02-19 | true |
| X1 | X1 Credit Card | 1746 | none | true |
| Venmo | Personal profile | n/a | 2026-11-12 | true |
| Vanguard | Brokerage (margin) | 4263 | balance only | true |
| Vanguard | Traditional IRA | 7987 | balance only | true |
| Robinhood | Individual | 9171 | balance only | true |
| Robinhood | Roth IRA | 8811 | balance only | true |
| Fidelity | Checking (for ATM) | 1323 | none | true |
| Fidelity | Health Savings Account | 4875 | none | true |
| Fidelity | Investment | 3082 | none | true |
| Fidelity | Rollover IRA | 1943 | none | true |
| Fidelity | Roth IRA | 9014 | none | true |
| Fidelity | SIG 401(k) Profit Sharing Plan | 8719 | none | true |
| Synchrony | Amazon Store Card (switched off) | 7199 | 2026-01-18 | **false** |
| Citibank (switched off) | AAdvantage card before it was replaced | old number | 2026-07-19 | **false** |

- **Fidelity:** **Claude:** your refresh worked; Rocket Money now reports no stale connections.
- **Amazon Store Card 7199:** see Watching.
- **Citi 2766:** **Claude:** thanks. The history is continuous, but it overlaps instead of joining: see New question 1.
- **CareCredit 6162:** the LASIK card, never linked; noted above.
- **Chase Southwest 0112:** closed, never linked; New question 2.
- Freedom, Delta Reserve, Bank of America, Wells Fargo and X1 are connected and just unused.

### Answered and applied to the notes (11-09)

**Splits**
- Uber Trip 2026-09-28, $46.27: Margaret's ride on your family profile. Don't charge her.
- Nashville Airbnb HMHRXABYWQ, $384: Coby Goldstein paid (cashed out 11-10).
- Margaret's $20 "Bfast!" request: you paid it 11-09.
- Mom / Xavier phone: Jul $106.42, Aug $92.29, Sep $92.29, Oct $92.53 requested from Katrina; she repaid all $383.53 (cashed out 11-10).
- Gooder date: already 11-02, the day you sent the request; no change needed.

**Possible double charges (none were duplicates)**
- CamelBak $130.65 × 2 (2025-01-14, 01-21): the first was stolen, so you bought it again.
- Whitehorse $26.43 × 2 (Mar 2025): not a duplicate.
- Trew Gear $162.75 × 2 (2024-04-07): one was a gift for Xavier.
- Ocean HQ $46 × 2 (2023-06-18): not a duplicate.
- Geojango $144.75, four charges (Sep–Oct 2022): not duplicates.
- Airbnb HMNX8ESE8F $73.07 × 2 (Oct 2022): not a duplicate.
- Grit BXNG $40.76 × 2 (Aug 2022, same day): you paid for your date.

**Group costs and repayments**
- Qanoon $215.22 (Aug 2026): you lost credit card roulette and paid it all.
- World Cup tickets 3 × $287.50 (Jul 2026): requested from Margaret, Sarah Commaroto and Robert Freitag on Venmo.
- Huracan Diving, Belize $2,816.25 (2024-06-22): family dive trip ("next Huracan adventure", Fam (mom) chat 2024-06-24); Stein Kretsinger and Max Hempfling paid you back on Venmo.
- Niseko lodging + car $6,160.73 (Jan 2026): chat "Japow 26"; Venmo group "Niseko Kretsinger 2026": Stein $1,852.25 plus $1,852.25 "Bodhi share" (01-25), Katrina $692.61 (01-24). On the Hilton row's note.

**Unexplained transactions**
- Bilt rent $3,981.50 (May 2023) and $3,855.50 (Apr 2023): you paid James' rent too and he paid you back.
- QuantBlueprint $3,599 (2025-07-02): not reimbursable.
- Columbia tuition $34,257 (Sep 2025): not reimbursable.
- Suitsupply $1,808.46 (Sep 2025): not reimbursable; for Emma Kelly and Paul Sullivan's wedding.
- Naval Nonprofit Foundation $500 + $304.28 (Sep 2025): Huracan dive trip.
- Katrina $5,000 in / PayPal $5,000 out (Jun–Jul 2022): short-term loan.
- Zelle SH410LLC $500 (Mar 2026): short-term loan to Margaret, repaid by Zelle / Venmo.
- Nassau Titan Hospitality + Delta $366.97 (Dec 2025): your Bahamas trip to visit Hudson.

**Seamless / Grubhub**
- Everything from 2022 to May 2025 was ordered on the SIG corporate card, with your card paying the overage. All 688 of those rows (switched-off copies included) are noted that way.

### Passes done
- 2026-11-09: backfill of all 9,147 rows (Jun 2022 to 11-09) in the `receipt: … | split: … | changes: …` format.
- 2026-11-09: Gmail receipt fill (754 rows linked; receipts 3,600 → 4,371) and iMessage group tags (146 rows).
- 2026-11-09: your doc answers applied (36 rows).
- 2026-11-10 to 11-21: daily notes on new rows, including the Palermo citsec dinner split and South Africa flights (Margaret's half of Airlink + CemAir, paid 10-20).
