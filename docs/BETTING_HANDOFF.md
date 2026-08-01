# Proxy War Betting — Agent Handoff Brief

Written 2026-08-01. This is the orientation doc for an agent picking up work on
the betting surface. Facts in §5 are dated and decay — re-verify anything
load-bearing against live state before acting on it. Deep-dive material is in
§7; do not start from the superseded spec.

## 1. What this is

A **play-money live prediction market** on replayed AI-agent matches, at
**https://bet.proxywar.xyz**. One continuous LMSR market per match ("premiere"):
visitors buy/sell shares in which agent wins while the match plays out under
server-side staged release (sealed — the outcome is not on the client before it
is revealed). A **synthetic house crowd** of automated bettors trades alongside
visitors and is disclosed in the UI. Bankrolls are 1,000 play credits tied to a
guest cookie; there are no accounts, no payments, no crypto.

Betting is a **separate product surface**. It is not the league, and the league
must not grow wagering features.

## 2. Hard rules (operator-set; do not relax)

- **Play money only.** No real currency, no payment path, no tokens, no crypto.
- **Never the league.** The league origin serves no wagering routes (`/bet`
  is 503 there). `origin/main` must carry **zero wagering code** — a
  main-promotion decision is pending with the operator (see §5); do not push
  this line to main.
- **No raw intents.** Nothing here bypasses the canonical agent path or
  touches `src/core/**`.
- **Cycling destroys state.** Replacing a premiere wipes every position and
  bankroll on it. `autocycle-premiere.sh`'s two safety rules (only cycle on an
  explicitly terminal status; never treat a failed request as "nothing
  running") are load-bearing — keep them.
- **Honest UI.** Exhibition matches are labeled ("House exhibition — not a
  league round"), the synthetic crowd and play-money nature are stated in the
  market facts. If you disable the crowd, remove its disclosure copy in the
  same change.

## 3. Architecture map

| Path | What it is |
| --- | --- |
| `src/server/replay-premiere/wagering/` | Server-authoritative market: LMSR (`ReplayPremiereLmsr.ts`), integer-chip double-entry ledger, market rules (1,000 start, min stake, 50%-of-bankroll cap, no house edge), order handling. Orders are priced against `liveVisibleSequence` so a trader can never trade on content the staged release has not shown them. |
| `src/server/replay-premiere/wagering/simulation/` | Synthetic crowd: personas with evidence-weighted fair values from territory projection, seeded PRNG, live driver (~1s ticks). Crowd participants are `sim_*` and are **excluded from the points ledger** (tested). |
| `src/client/prediction/wagering/` | Lit UI: `page/BettingPremierePage.ts` (controller; server numbers verbatim, no client-side money math), `page/BettingOverlay.ts` (the visible sheet), components (price board, trade ticket, positions, settlement, points leaderboard, league scouting panel, GitHub sign-in). **Hardcoded English by design** — the `/bet` SPA shell has no `<lang-selector>`, so `translateText` would render raw keys. |
| `src/scripts/premiere-wagering/` | Fixture pipeline: generate hosted xp-request episode → pull roster → source bundle → seal → checkpoints → provenance. `demo-synthetic-crowd.ts` for local crowd runs. |
| `src/scripts/ai-agent-demo-server.ts` | The serving process (run from source via `tsx`). |
| `src/prediction/` + `src/client/prediction/` (non-wagering parts) | **Legacy trap:** the superseded 2026-07-25 client-only odds-table engine. In-tree, tests pass, unused by the live surface. Do not build on it. |
| Tests | `tests/server/replay-premiere/wagering/`, `tests/client/prediction/wagering/`, `tests/scripts/premiere-wagering/`, points ledger under `tests/server/replay-premiere/points/`. |

Match provenance: seat identity `policyIdentity.namespace === "softmax_policy_version"`
is a real league agent; `local_manifest` is a house exhibition persona. The
overlay model's `sourceKind` is `controlled_exhibition | rated_coworld`.

## 4. Deploy topology and ops

- Serving clone: `~/.proxywar-deploy/bet-origin` (its git `origin` is the local
  canonical repo, not GitHub), port **8792**, fronted by Cloudflare as
  bet.proxywar.xyz. launchd job `com.proxywar.betautocycle` runs
  `autocycle-premiere.sh` → `cycle-premiere.sh`, which **restarts the server
  from source and serves the current `static/` build every cycle** (~25–30 min).
  Deploy = fetch + detach the clone to a SHA + `npm run build-prod`; the next
  natural cycle picks it up. Do not kill the server mid-market.
- Logs: `/tmp/pw-bet-autocycle.log` (UTC timestamps; watch the "match kind:"
  line — `exhibition` = fallback, and a consecutive-fallback warning fires when
  the real queue is stuck). Queue generator log: `/tmp/pw-bet-queue-generator.log`.
  Cost ledger for real hosted episodes:
  `~/.proxywar-deploy/premiere-queue/cost-ledger.jsonl` — **each real episode
  is billed; generating them is operator-gated.**
- Identity: GitHub OAuth lives on the platform origin (apex `proxywar.xyz`);
  a one-time-code handoff to the bet origin is **built but switched off**
  (operator, 2026-07-30 — `PROXYWAR_PLATFORM_ORIGIN` is deliberately unset in
  the betting launcher). Do not describe the handoff as live; do not enable it
  without an operator decision.

## 5. State as of 2026-08-01 (dated — verify before relying)

- Branch topology: the betting line lives on **`claude/product-overhaul`**
  (continuation of `claude/betting`), with disclosure corrections on
  **`claude/betting-corrections`** (`359ba1130`) — deployed to bet-origin,
  pending merge back at the next consolidation. Local branches only; nothing
  pushed to GitHub main.
- The surface has served **only exhibition fallbacks since 2026-07-28
  ~15:57Z** (queue generator stopped; billed generation is operator-gated).
  The GTM "speculation test" has therefore not yet run on real league
  fixtures.
- Pending operator decisions: fund real fixtures (candidate slot: the 8/3
  Season Zero Featured Event); the withheld `origin/main` promotion choice;
  whether betting identity stays off.
- Project-state docs (`docs/project-state/decision-log.md`,
  `known-problems.md`) are **gitignored** — they exist only in the canonical
  checkout `/Users/claude/Documents/proxywar_main`, not in worktrees or
  clones. If you cannot read them, say so rather than assuming.

## 6. Verify before claiming

```bash
npx vitest tests/client/prediction/wagering tests/server/replay-premiere/wagering --run
```

```bash
curl -s -D- -o /dev/null https://bet.proxywar.xyz/bet | grep -i location
```

```bash
curl -s "https://bet.proxywar.xyz/api/premieres/<id>/market"
```

```bash
tail -20 /tmp/pw-bet-autocycle.log
```

## 7. Reading list, in order

1. This file.
2. `RUNBOOK.md` (repo root) — the operational deep-dive, 1,300+ lines,
   diary-accreted: §5–§8 run/admit/verify, §13 single bankroll authority,
   §13.5 enabling the crowd, §15–§16 OAuth + platform handoff (handoff NOT
   live). Trust its dated corrections over older sections.
3. `docs/BETTING_TESTER_WALKTHROUGH.md` — the human tester walkthrough (what
   the product feels like; honest about the crowd and play money).
4. `docs/SEASON_ZERO_BASELINE.md` — deploy/validation state of the wider line.
5. `docs/project-state/2026-07-25-BETTING-SPEC.md` — **superseded**; read only
   for the statistical design record, never as current architecture.
