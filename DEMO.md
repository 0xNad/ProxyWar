# Proxy War prediction competition — demo & verification harness

**Status: mid-pivot.** The feature substrate changed mid-build (operator decision) from
single-player synthetic built-in-nation fixtures + a fitted fixed-odds table to a
server-side **Observatory league replay premiere with pari-mutuel wagering**
(`src/server/replay-premiere/wagering/**`). This document reflects the state as of
this handoff: what is built and verified, and what is still landing from sibling
slices (`PariServer`, `PariClient`, `PariPipeline`).

## What's verified right now

Run the prediction test suite:

```
$ npx vitest run tests/prediction
 Test Files  11 passed (11)
      Tests  178 passed | 3 todo (181)
```

(The project's test runner is **vitest**, not jest — `package.json`'s `"test"` script
and `vite.config.ts`'s `test` block confirm this; there is no jest config anywhere in
the repo. `npx vitest run tests/prediction` is the equivalent of the requested
`npx jest tests/prediction`.)

### Contract tests — `tests/prediction/contract.test.ts`

Exercises the substrate-independent money primitives directly against
`src/prediction/types.ts`: `payout()` (integer-exact, floors correctly, rejects
negative/non-integer stakes and multipliers), `ledgerHolds()` (holds for consistent
ledgers, catches a deliberately corrupted season, and documents the one case it
*cannot* catch — a phantom resolution whose bankroll bump happens to balance — which
is why per-market bookkeeping is a separate engine-layer responsibility), and
`maxStake()` (never below `MIN_STAKE`, including for zero/negative bankroll). The
`multiplierFor()`/`quintileOf()`/`OddsTable` sections from the fixed-odds design were
removed per the pivot — those concepts don't exist in a pari-mutuel pool.

### Money-drift property test — `tests/prediction/money-drift.test.ts`

**The highest-value test in this harness.** Rewritten TWICE mid-session as the
substrate changed again: single-player fixed-odds -> server-side pari-mutuel pool ->
**server-side LMSR (logarithmic market scoring rule) market maker**, the operator's
final pivot. Now exercises the real LMSR engine
(`src/server/replay-premiere/wagering/{ReplayPremiereLedger,ReplayPremiereMarket}.ts`:
`ReplayPremiereLedger`, `applyBuy`, `applySell`, `settleMarket`,
`maxSharesForBudget`). Drives **2,000 randomised sequences** (1–6 participants,
2–5 outcome seats, 0–20 buy/sell actions per sequence, ~15% void settlements) and
asserts, after every single grant/buy/sell/settlement:

- `ReplayPremiereLedger.total() === 0`, always — the ledger is a double-entry
  system (BANK, AMM, one account per participant) and every posting's deltas must
  sum to exactly zero, so the sum of every balance is a standing invariant.
- Every credit that touches an account balance is an exact integer (LMSR pricing
  uses floats internally for the cost curve, but the boundary into the ledger is
  always rounded before posting).
- A participant is never charged more credits than they had.
- `ledger.post()` rejects an unbalanced set of postings outright rather than
  partially applying it.

Run just this test:

```
$ npx vitest run tests/prediction/money-drift.test.ts
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

*(Superseded content, kept for the historical record of what each pivot broke: the
pari-mutuel version of this test drove 10,000 wager-pool scenarios against
`settleWagerPool`/`computeWagerPoolSnapshot`, asserting `sum(payoutAmount) ===
pool.totalStaked` with dust always attributed to exactly one participant. That
module was deleted by `PariServer` in favor of the LMSR engine; nothing of it
remains in the tree.)*

### Edge-case matrix — `tests/prediction/edge-cases.test.ts`

Covers the brief's §5 matrix for the parts that are substrate-independent (ledger
mechanics that hold regardless of fixed-odds vs. pari-mutuel pricing): insufficient
funds, stake below-min/above-max/zero/negative/non-numeric, duplicate stake on the
same market (with idempotent replay vs. genuine double-submit distinguished),
refresh mid-prediction and after (store + ledger idempotency), bankroll bust and
reset, multiple concurrent open markets, and rapid-repeated-click races (double-
apply prevention for both stakes and resolutions).

**Dropped** from the original version (fixed-odds/fixture-shaped, no longer
applicable): the `CheckpointGate`/`readFixtureOutcome` reveal-integrity tests, the
"match with no result or a tie" market-resolution tests, and the malformed/short/long
*fixture* data tests. **Not yet added**: LMSR-specific edge cases (order rejection
reasons in `ReplayPremiereMarketOrderRejectReason` — `market_not_open`,
`below_min_stake`, `above_max_stake`, `insufficient_funds`, `slippage_exceeded`,
`unknown_seat`; the trading-window gate; settlement void-on-null-winner) — the
substrate changed twice more after this section was written (pari-mutuel, then
LMSR) and there wasn't remaining budget in this session to write a third full
edge-case pass. The money-drift test above already exercises void settlement and
the core ledger-never-drifts property against the real LMSR engine; a follow-up
should add named regression tests per rejection reason and the checkpoint-window
gate once `ReplayPremiereInteractions.submitMarketOrder` lands.

## What's dropped entirely

- `tests/prediction/determinism.test.ts` (fixture-generation determinism) — deleted.
- `tests/prediction/fixture-lifecycle.test.ts` (seen-fixture-never-reappears against
  a 250-match local pool, seed-range disjointness) — deleted. The whole local
  fixture-pool/odds-calibration pipeline (`src/prediction/generate/**`,
  `src/prediction/data/**`, `src/prediction/engine/odds.ts`, and the odds types in
  `types.ts`: `OddsTable`, `OddsBucket`, `QuintileEdges`, `quintileOf`,
  `multiplierFor`) is being removed by `PariPipeline` per the operator's final
  decision to fully retire the old single-player prediction app — do not
  resurrect these tests against it.
- The **entire old single-player prediction app** — `src/client/prediction/{PredictionApp.ts,
  route.ts, PredictionFacade.ts, views/**, history/**, stub-data/**}` and its route
  registration in `src/client/Main.ts` — is being removed by `PariClient` (owns all
  `src/client/**` edits). Reasoning per the operator: it predicted on synthetic
  bots on test maps, exactly the substrate rejected; it duplicated the new
  product's surface; and its substrate was being deleted out from under it
  regardless. **Kept** as the substrate the new product runs on:
  `src/prediction/types.ts` money primitives (`Credits`, `BasisPoints`, `payout()`,
  `maxStake()`, `ledgerHolds()`, `STARTING_BANKROLL`, `MIN_STAKE`, `Stake`,
  `Resolution`, `Season`, `SeasonSummary`), `src/prediction/engine/{ledger,season,
  summary}.ts`, and `src/prediction/store/**`. This harness's kept test files were
  audited against that keep/drop list and needed exactly one fix (a stray
  `multiplierFor()` call in `edge-cases.test.ts`'s stake builder, replaced with a
  literal basis-point constant — the `Stake` type shape itself is unaffected).
- `src/prediction/dev/playthrough.ts` (headless playthrough script) — deleted. It
  drove "load fixture → checkpoint 1 → stake → lock → checkpoint 2 → stake → reveal →
  resolve → print ledger" against the synthetic-fixture model. **A replacement
  headless playthrough still needs to be built**, now against the LMSR engine
  (`ReplayPremiereLedger` + `ReplayPremiereMarket`'s `applyBuy`/`applySell`/
  `settleMarket`) once `ReplayPremiereInteractions.submitMarketOrder`/
  `readMarketState` land — script would: open a premiere, open a checkpoint, submit
  several buy/sell orders from different participants on different seats, close
  the checkpoint, settle the market, print the ledger balances and confirm
  `ReplayPremiereLedger.total() === 0`.

### Scope expansion (landed after this session's budget was exhausted, twice)

First: a fully polished dedicated betting page (not the premiere overlay), live
odds that visibly move with a synthetic market-activity simulator, and
pre-generation across the full active league agent roster. Second: the market
pricing model itself changed from pari-mutuel to LMSR mid-session (see above). Per
the first instruction, this harness's remaining scope is to cover the synthetic
market-activity path and live odds movement. **Not built in this session** —
requires `PariServer`'s live market-state stream/poll endpoint and the synthetic
bettor simulator to land first. Follow-up should add: a property test that a
synthetic-bettor stream keeps `ReplayPremiereLedger.total() === 0` at every step and
never mutates a settled market, plus an integration-style test that LMSR prices
(`computeMarketPrices`) visibly move across a sequence of synthetic buy orders
before window close.

## Generating fixtures / fitting odds — no longer applicable

The synthetic fixture pack and fixed-odds table (`npm run predict:gen` /
`predict:fit` / `predict:check`, never actually wired into `package.json` before the
pivot landed) are dropped. The new substrate uses **pre-simulated Observatory league
matches** (generated with the full active league agent roster via xp-requests),
sealed and premiered via the existing server-side `ReplayPremiere` path. There is no
calibration/odds-fitting step — the LMSR market maker prices itself continuously
from trading activity.

## Starting the app

```
$ npm run dev
> cross-env GAME_ENV=dev concurrently "npm run start:client" "npm run start:server-dev"
[0]   VITE v8.0.10  ready in 201 ms
[0]   ➜  Local:   http://localhost:9000/
[1] {"comp":"m",...,"message":"Master HTTP server listening on port 3000",...}
[1] {"comp":"w_1",...,"message":"running on http://localhost:3002",...}
[1] {"comp":"w_0",...,"message":"running on http://localhost:3001",...}
```

(Captured from a real run during this session, before the old single-player app's
removal; the backend starts cleanly. At the time of that capture there was a
transient Vite pre-transform error in a sibling's in-progress client file — since
resolved by that file's removal.) The LMSR betting page is not yet mounted — see
`PariClient`'s slice for the dedicated route once it lands.

## Coordination notes for whoever continues this

- Shared money primitives (`payout`, `maxStake`, `ledgerHolds`, `Credits`,
  `BasisPoints`, `Stake`, `Resolution`, `Season`, `SeasonSummary`) in
  `src/prediction/types.ts`, plus `engine/{ledger,season,summary}.ts` and
  `store/**`, are confirmed by the operator to survive every pivot and are the
  substrate the new product runs on. This harness's contract tests exercise them
  directly and needed no changes across any of the three substrate pivots.
- The market/pricing domain is now LMSR, entirely under
  `src/server/replay-premiere/wagering/**` (`ReplayPremiereLedger`,
  `ReplayPremiereMarket`, `ReplayPremiereLmsr`, `ReplayPremiereMarketRules`, types in
  `ReplayPremiereWageringTypes.ts`), wired into `ReplayPremiereInteractions.ts` by
  `PariServer`. Two prior substrates (fixed-odds `OddsTable`, then pari-mutuel
  `settleWagerPool`) were built and fully deleted in this same session — nothing of
  either remains in the tree; do not resurrect references to `multiplierFor`,
  `quintileOf`, `OddsTable`, `ReplayPremiereWagerSettlement`, or `settleWagerPool`.
- `PariServer` is writing their own unit tests under
  `tests/server/replay-premiere/wagering/**` for the LMSR acceptance list. This
  harness's `tests/prediction/money-drift.test.ts` is intentionally redundant
  coverage from an independent angle (a large randomised property test rather than
  named unit cases) — both should be kept.
