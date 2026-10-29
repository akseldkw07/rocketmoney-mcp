# TODO

Outstanding work as of 2026-10-29. Owners in brackets where another agent has it.

## Finish the current PR

- [x] Merge PR #5 (`fix/hash-rotation-and-rules`).
- [ ] Merge PR #7 (`fix/reported-bugs-and-sweep`): R1-R5 and the sweep. The post-merge hook
      redeploys `main`.
- [ ] Reconnect the `rocketmoney` MCP server in other Claude sessions (`/mcp` → reconnect)
      so they see the new tools: rules, categories, `set_transaction_date`,
      `set_transaction_ignore`.

## Verify in real use

- [ ] **Login re-probe fix.** A finished form login went unaccepted for 5 minutes, twice on
      2026-10-29, because a session cookie that failed one probe was never re-probed. It
      now re-probes every 10s. Confirm on the next full form login: the log should show
      `sid … not authenticated yet; re-checking every 10s` followed by `success`, not a
      timeout.
- [ ] **Do rule saves overwrite manual edits?** Saving a rule re-applies overlapping rules
      to their matches. Untested: whether that also overwrites a category or rename set by
      hand on a matched transaction. This matters for the "fix exceptions by hand" advice.
- [ ] **`delete_category` with `reassign_to` on a non-empty category.** Only tested on an
      empty category.
- [ ] **Rule precedence.** No stable order found over 8 observations (not save order, id
      or specificity). The effective rule was always the last id in `applied_rule_ids`.
      Keep watching for a pattern; the tool descriptions say to avoid overlapping rules
      that set the same field.

## Investigate

- [ ] **The rolling-cookie premise is out of date.** `client.ts` serializes every call
      (`rmChain`) because each response was said to rotate `tb.auth0.sid`. On 2026-10-29,
      neither `AuthenticationCheck` nor `RefreshAuthToken` rotated it, and replaying an
      old value still worked. Find out when it does rotate, and whether the serialization
      and the 30-minute keepalive are still needed. Sessions still die every ~30-60 min
      (`HTTP 401 on RefreshAuthToken`), so something else ends them.
      *Partly answered 2026-10-29: calls now run 4 at a time (`ROCKETMONEY_MAX_CONCURRENCY`,
      set it to 1 to go back to one at a time) and a parallel burst of 8 tools kept the
      session live. Still open: what ends sessions every 30-60 min.*

## Backlog [other agent]

From README's TODO section:

- [ ] Apply upstream Dependabot bumps (notably MCP SDK 1.32.0); consider enabling
      Dependabot on the fork.
- [ ] Remove `extension/`, or bring back `/auth/ingest` behind authentication.
- [ ] Timestamp the server log.
- [ ] Add CI for `npm test` and `npm run typecheck`.
- [ ] Treat local-network timeouts/resets as offline without hiding real Rocket Money
      failures.
- [ ] Capture the HAR for `npm run refresh-hashes` automatically.
- [ ] README's `feat/generic-transaction-writes` item is done: the hash fix is merged and
      the branch was deleted 2026-10-29 (upstream keeps the gate-note commit). Remove it
      from README.

## Venmo MCP [Venmo agent]

- [ ] `request_money` swallows the Venmo API error ("Error executing tool request_money")
      and doesn't return the new request's id.

## Bugs reported by the categorization agent (verified locally 2026-10-29)

Not a bug: `search_transactions` already has `cursor`, `until` and `limit`. The agent's
client had a stale tool list, so restart Claude Desktop. Verified: the Personal Profile
account pages 1,200 + 531 rows (all 1,731, no overlap), and `until` works.

- [x] **R1. Search responses are too big.** 1,200 rows came to 536 KB, more than the
      client will display. *Fix:* a `fields` parameter (or `compact: true`) returning
      only id, date, original_date, amount, name, category, account and ignore. Also
      emit compact JSON and drop null/empty fields (sweep item A5).
- [x] **R2. A rule condition with `date_to` and no `date_from` fails** with
      `RM TransactionRulesSearch: An error occurred.` `conditionsToInput` sends the open
      lower bound as `{value: "-Infinity", inclusive: false}`, which Rocket Money rejects
      for dates (the open upper bound `"Infinity"` is accepted). This breaks
      `preview_rule`, `create_rule` and `update_rule`. *Fix:* send an early concrete date
      (e.g. `2000-01-01T00:00:00.000Z`, inclusive) when only `date_to` is given, and add
      a test.
- [x] **R3. `preview_rule` / `get_rule` samples are capped at 100.** The cap is ours
      (zod `max(100)`). Rocket Money's `ruleTransactions(first:)` returned all 1,731 rows
      in one 171ms request. *Fix:* raise the cap to 2,000, and have the sample use the
      same compact row option as R1.
- [x] **R4. `applied_rule_ids` lists deleted rules.** Rocket Money keeps a rule's id in a
      transaction's history after the rule is deleted. On the Personal Profile account,
      `…MjQzMz` (32892433) is on all 1,200 recent rows and `…MjQ0MA==` (32892440) on 47;
      neither is in `list_rules`, and `get_rule` errors. *Fix:* compare against
      `listRules()` (cached briefly) and return `applied_rules: [{id, deleted: true}]`,
      or a separate `deleted_rule_ids`, so live rules can be told apart.
- [x] **R5. Notes can only be set one transaction per call.** *Fix:*
      `set_transaction_notes` taking `transaction_ids[]` + `note`, or a list of
      `{transaction_id, note}` pairs. Send them as aliased `setTransactionNote` mutations,
      50 per request (aliasing verified with `changeTransactionDate`), with a result per
      id.

## Codebase sweep (2026-10-29): proposed fixes

Ranked by impact as the transaction history grows. The capacity numbers come from live
probes on 2026-10-29.

### A. Throughput: how many requests a large read or write needs

- [x] **A1. Bigger search pages.** `searchTransactionsPage` fetches 200 rows per request.
      Rocket Money accepts `first: 2500` (2,500 rows in 230ms, measured), so a
      10,000-transaction backfill takes 50 sequential requests where 4 would do.
      *Fix:* page size 1000 by default, tunable up to 2500; also apply it to
      `deleteCategory`'s reassign scan and `/api/transactions`.
- [x] **A2. Every request waits for the previous one.** `rmChain` queues every call
      behind the one before, because each response was assumed to rotate the cookie.
      That no longer holds (see Investigate). Five parallel requests on one cookie all
      succeeded, in 144ms versus about 622ms in sequence. `/api/budget`'s `Promise.all`
      of 5 reads is queued one at a time today.
      *Fix:* replace the global chain with a small concurrency limit (e.g. 4). Keep
      rotation handling: apply any `Set-Cookie` to the shared jar whenever it arrives.
      Only after the Investigate item confirms rotation is rare.
- [x] **A3. One request per transaction for date changes.** `setTransactionsDate`
      changes each id in its own call, and `"original"` adds a read per id: 200 ids can
      mean 400 requests. One request with aliased mutations
      (`a0: changeTransactionDate(...) a1: ...`) works (verified), and so do 50 aliased
      `node(id:)` reads in one request (91ms).
      *Fix:* a shared `batchAliased(op, items, chunk = 50)` helper. Use it for date
      changes, the `"original"` lookups, and any future per-id operation; keep per-item
      errors.
- [x] **A4. Two disk reads and one write per API call.** `rmExecuteUnlocked` calls
      `loadSession()` (reads and parses `session.json`), and `saveSession()` reads it
      again and rewrites it, synchronously, even when no cookie changed. A 50-page
      backfill does 150 blocking file operations.
      *Fix:* keep the jar in memory and write the file only when a cookie value changes
      (plus `refreshedAt` at most once a minute). Load once at start-up and whenever
      `/auth` seeds a session.
- [x] **A5. Pretty-printed tool output.** `tool()` returns
      `JSON.stringify(result, null, 2)`, which adds about 30-40% whitespace to every
      response, roughly tens of KB on a 1,200-row search. Rows also repeat empty fields
      (`custom_name: null`, `note: null`, `applied_rule_ids: []`).
      *Fix:* compact JSON, and drop null/empty fields from transaction rows. Document
      that a missing field means none.
- [x] **A6. Account labels come from the heaviest query.** `accountLabels()` pulls
      `AccountDetailAccountListPage` (six overlapping account buckets with balances)
      just to map id to name. The cache never expires, so a newly linked account shows a
      raw id until restart.
      *Fix:* a lean full-text query (`accounts(enabled: true) { id name number
      institution { name } }`, as `TransactionRulesAccounts` does), cached for about
      10 minutes like categories.

### B. Correctness bugs found during the sweep

- [x] **B1. `set_transaction_category(apply_to_all=true)` can silently do nothing for
      older transactions.** It looks the transaction up in the newest 200 rows only
      (`searchTransactions(null, null, 1)`). For anything older it falls back to updating
      just that one id and still returns success.
      *Fix:* read the name with one `node(id:)` lookup, then sweep by name with the
      bigger pages from A1.
- [x] **B2. Two missing spaces in the server instructions** ("...preview_rule).This
      server..." and "...future transactions).To recategorize"). These go into every
      client's context.
- [x] **B3. "type" means two things.** `list_categories` uses `type` for
      default/custom and `categoryType` for expense/earning/ignored. The new category
      tools use `type` for expense/income/ignored.
      *Fix:* one shape everywhere: `kind: default|custom` and
      `type: expense|income|ignored`.

### C. Duplicated code to consolidate

- [x] **C1. One transaction field list.** The node selection is written out in both
      `TRANSACTION_SEARCH` (client.ts) and `RULES_SEARCH` (rules.ts). Export a single
      `TRANSACTION_FIELDS` string and use it in both, so a new field like `posted_date`
      can't reach one and miss the other.
- [x] **C2. One request builder.** `rmExecuteUnlocked`, `probeSession` and
      `scripts/refresh-hashes.ts` each build the same headers. Extract
      `rmHeaders(cookieHeader)` and `postGraphQL(body, jar)`.
- [x] **C3. Date helpers.** `shiftYmd` (mcp.ts), `tomorrowYmd` (rules.ts) and the
      inline month start in `category_transactions` re-implement `windows.ts`
      (`addDays`, `ymd`, `monthStart`). Use `windows.ts`, with one `addDaysYmd` added.
- [x] **C4. Account label formatting** exists twice: `accountLabels()` in mcp.ts
      ("institution name mask") and `accountLabel()` in format.ts ("short_name name
      number"). One formatter, so rows read the same in every tool.
- [x] **C5. Batch write results.** `set_transactions_category`,
      `set_transaction_ignore` and `set_transaction_date` each assemble
      `{requested, updatedCount, ok}` by hand. Add one `batchResult()` helper.
- [x] **C6. `/api` handlers repeat the token check and the 401/503 handling.** Use
      `requireToken` middleware and one `sendRmError(res, err)`. `/api/transactions`
      also maps rows by hand; reuse the MCP `shapeTxn` (adds `original_date`, `ignore`,
      `account`). *Done for the token check and session errors; the feed keeps its row fields, since the card gate reads them.*
- [x] **C7. Money rounding.** `Math.round(x * 100) / 100` appears in format.ts
      (net worth, upcoming) and mcp.ts (holdings). Use one `roundUsd()` beside `usd()`.
- [x] **C8. Category lookups.** `customCategory()` resolves through the cached catalog,
      then fetches the whole catalog again uncached. Read from the cache once, and
      invalidate it after writes as now.

### D. Dead code to delete

- [x] `getCategoryTransactions` and the `TransactionCategoryPage` and
      `TransactionsPageTransactionTable` entries in `PERSISTED`, `CAPTURE_PAGE` and
      `query-text.ts`: nothing calls them since search and `category_transactions` moved
      to the full-text query. That's about 40% of `query-text.ts`.
- [x] `authStatus` and `ingestAuth` in `auth-page.ts`: their routes were removed in this
      build (goes with the backlog item on `extension/`).
- [x] Duplicate `sleep` helpers in `login.ts` and `auth-page.ts`.

### E. Lower priority

- [x] `buildServer()` registers all 32 tools and their zod schemas on every
      `/mcp` request (a stateless transport). Building the tool definitions once at
      module load and only creating the `McpServer` per request would save CPU on each
      call. *Measured 2026-10-29: 1.2ms per request against 100-300ms per Rocket Money
      round trip, so not worth restructuring mcp.ts. Not doing it.*
- [x] `createRule`/`updateRule` list every rule before and after saving, to find the new
      id. Probe whether `SaveTransactionRulePayload` exposes the rule (e.g.
      `transactionRule { id }`) to save those two round trips. *Done: the payload has no rule field, but it
      exposes `viewer`, so the save returns the post-save rule list. One list call saved per
      create or update.*

Suggested order: B1-B3 (bugs), D (dead code), A1 + A5 (cheap, large wins), C1-C8,
then A2-A4 (need the rotation investigation and more care), then E.
