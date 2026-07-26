# TASK — Build the Proxy War prediction-competition ("betting") feature (autonomous, for Claude Cowork)

You are an autonomous engineer. Your mission: deliver a **fully working, hardened,
play-money prediction-competition feature** for Proxy War — designed, built, and tested to
perfection — starting from a thorough interview with the operator. This document is your
complete brief; you do not have the conversation that produced it.

## Product essence (DECIDED — the interview only fine-tunes the details below it)

This is **not a sportsbook and not gambling.** It is a **play-money prediction
competition**: players watch an agent match paused part-way through — a **blind reveal**,
where the remainder of the match is hidden — then **predict the geopolitical outcome**
(who wins, final territory leader, alliances formed/broken, eliminations, who survives to
turn T, etc.), stake **play money**, and the match plays forward and resolves and scores
them. Players compete over time on prediction **skill** / bankroll / accuracy. The play
money is the **scoring and competition mechanic**, never real wagering.

Fixed for v1 (do not reopen these in the interview):
- **Substrate:** blind-reveal **replays of matches between built-in OpenFront nations.** No
  LLM agents, no Bedrock, no Softmax, nothing external — generate deterministic built-in-
  nation matches locally as the fixtures to predict on.
- **Money:** play money only, always.
- The interview decides the *details*: market/prediction types, scoring & ranking, bankroll
  rules, reveal mechanics (which turn to pause at, how the rest is revealed), UX, and visuals.

---

## 0. Operating contract (read first, obey throughout)

- **You build in an ISOLATED COPY on a feature branch. Never touch the live main line,
  never push to any remote, never deploy.**
- **One blocking interview, then full autonomy.** Phase 2 (interview) needs the human.
  After the operator approves the spec, work **continuously through build → self-test →
  harden with no further approval stops.** When you hit a decision mid-build, make a
  reasonable choice, record it in `OPEN-DECISIONS.md`, and keep going — do **not** halt to
  ask. Use all available compute.
- **Definition of done = the Acceptance Checklist (§7).** You may not declare done, and
  must not stop, until **every** item passes, verified by you driving the actual running
  app as a simulated player. If something fails: fix it, re-test, add a regression test,
  continue.
- **Hard guardrails (violating any is failure):**
  - **Play money only.** Never integrate real payments, crypto, wallets, or KYC. Real money
    is permanently out of scope.
  - **Do not touch the simulation or agent core.** No changes under `src/core/**` (it is
    deterministic, seeded, no-floats), and no changes to the canonical agent path
    (`AgentObservation → LegalAction[] → AgentDecision → AgentDecisionValidator →
    AgentRunner → GameServer`). No raw OpenFront intents. No LLM/provider code in
    `src/core`. The prediction feature is a **layer on top of** match/replay outcomes.
  - **No external/live dependency.** No LLM games, no Bedrock, no Softmax/league. Predict on
    **built-in-nation match replays** generated locally (and/or bundled fixtures).
  - Keep `npm exec -- tsc --noEmit`, `npm run lint`, and `npm test` green at every commit.

---

## 1. Setup — the isolated copy

You have been given a clean copy of the repo (tracked files only — the ~43GB of gitignored
artifacts/outputs/node_modules were intentionally excluded). You are on branch
`claude/betting`. Establish a GREEN baseline before changing anything:

```sh
npm run inst            # npm ci --ignore-scripts (do NOT use npm install)
npm exec -- tsc --noEmit && npm test
```

Confirm the app builds and a replay renders before you modify anything.

**Orientation — read these before designing:**
- Client (Lit + Pixi/WebGL): `src/client/`. Replay/spectator surfaces:
  `src/client/AiLeagueReplayMode.ts`, `src/client/AiLeagueReplayOverlay.ts`; route/mode
  guards and `window.__PROXYWAR_AI_REPLAY__` live there. This is where the prediction UI
  most likely mounts.
- Generating a built-in-nation match to predict on: `tests/util/Setup.ts` creates full game
  instances with built-in nations and map data from `tests/testdata/maps/`. Use that path
  (or an existing replay record) to produce deterministic match fixtures — a replay record
  exposes the player list, per-turn state, final winner, and final territory share, which
  are your prediction targets and your resolution source. Do **not** rely on `artifacts/`.
- Server (Express/ws): `src/server/` — only if the interview requires a real backend.

---

## 2. Interview the operator (BLOCKING — before any design or code)

The product essence above is decided. Interview to pin the **details**, conversationally —
ask in rounds, follow up, and state a recommended default for each so the (non-technical)
operator can confirm or override:

**A. Prediction/market types** — winner; final territory leader; props (holds >X% at turn N;
first elimination; survives to turn T; alliance forms/breaks). Which for v1?
**B. Reveal mechanics** — at which point is the match paused for prediction (fixed turn? a
chosen %? multiple prediction rounds across one match)? How is the rest revealed (autoplay,
step, skip-to-result)?
**C. Scoring & ranking** — how stake → payout (even-money, multiplier, confidence-weighted,
Brier-style accuracy score?); how players are ranked over time (bankroll, ROI, accuracy %).
**D. Bankroll** — starting balance; reset/top-up on bust; per-round stake limits.
**E. Single vs multi-player** — recommended v1: single-player, local; leaderboards/shared
pools = v2. Confirm.
**F. Persistence** — recommended v1: client-side (localStorage/IndexedDB) behind a storage
abstraction so a backend can slot in later. Confirm.
**G. UX surfaces** — where it lives (panel on the replay view? dedicated page?), bet-slip
UX, history/results view. Propose a layout, confirm.
**H. Visuals** — match the existing client (Lit + Tailwind 4). References?
**I. Integrity** — no predicting after reveal; no double-stake; no negative balance; refresh
can't be exploited. Confirm (these are required).
**J. Success criteria & non-goals** — what "done and great" looks like; what's explicitly
NOT in v1.

**Output:** write **`SPEC.md`** (scope, prediction types, reveal & scoring math, UX,
persistence, acceptance criteria) and get the operator's **explicit approval.** Iterate
until approved. **Do not write feature code before SPEC.md is approved.**

---

## 3. Architecture & design (`DESIGN.md`)

Before coding: data model (matches/markets, predictions, bankroll, ledger, scoring), state
management, where/how it mounts in the client, the storage abstraction interface, how
outcomes are read from a replay record, and the test strategy. Consistent with the existing
client architecture.

---

## 4. Implement in vertical slices

Build the **thinnest end-to-end slice first** (watch a built-in-nation replay paused at turn
N → predict the winner → stake → reveal & resolve → bankroll + accuracy update), then widen
to the full SPEC. Keep `tsc`/lint/tests green at every step. Commit per slice on
`claude/betting`. New code in its own modules; integrate via one clean mount point.

---

## 5. Self-test loop — simulate the player meticulously

Per slice and end-to-end, **run the actual app and drive it as a real player** (Preview/
browser/computer-use tooling): start the app, navigate, screenshot, predict, stake, reveal,
verify the bankroll/accuracy/history. Screenshot every important state.

**Edge-case matrix — each must be handled with a clear UI state and a regression test:**
- insufficient funds; stake below min / above max / zero / negative / non-numeric
- duplicate prediction on the same market; predicting after the reveal/resolution
- match with no result / a tie / a draw outcome
- refresh mid-prediction and after (persistence holds; no corruption)
- bankroll bust + reset/top-up path
- multiple open markets at once; rapid repeated clicks (races)
- malformed / unusually short / unusually long replay data
- navigating away mid-reveal and returning
- narrow/mobile viewport and desktop
- no uncaught console errors in any flow

Every bug: fix → re-test → add a test that catches it. Unit/property tests for the scoring &
ledger math (exact, no float drift; ledger always balances); integration/e2e for flows.

---

## 6. Hardening

Scoring/money math exact and property-tested; ledger invariant always holds; no action
sequence corrupts state; clear empty/error/loading states; basic accessibility; graceful
handling of every malformed input.

---

## 7. Acceptance checklist — DONE means ALL pass (do not stop until then)

- [ ] `npm exec -- tsc --noEmit` clean; `npm run lint` clean; `npm test` green incl. new tests.
- [ ] Scoring & bankroll math verified by property tests over randomized action sequences; ledger balances every time; zero float money drift.
- [ ] E2E, screenshot-verified by you in the running app: predict → reveal → bankroll & accuracy update correctly; persists across refresh; bust + reset works.
- [ ] Every §5 edge case handled with a clear UI state and covered by a regression test.
- [ ] No uncaught console errors in any flow; works at desktop and narrow viewport.
- [ ] The feature is reachable from the real app UI (mounted, discoverable — not orphaned).
- [ ] `git diff` shows **zero** changes under `src/core/**` and the agent-protocol files; no real-money code anywhere.
- [ ] `SPEC.md`, `DESIGN.md`, `OPEN-DECISIONS.md`, and `DEMO.md` (screenshot walkthrough of every major state) exist and are current.

## 8. Final deliverable

Everything on branch `claude/betting` (committed, not pushed). A final report: what was
built, full test results, every assumption from `OPEN-DECISIONS.md`, the screenshot demo,
known limitations, and exactly what a multi-player / real-backend v2 would require. Then —
and only then — stop.
