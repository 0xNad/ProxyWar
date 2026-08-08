# Proxy War Economy + Negotiation V1 — Verified Rewrite (V2)

**Supersedes** `PROXYWAR_ECONOMY_NEGOTIATION_AUDIT_FIRST.md` (2026-08-07).
Every mechanical claim in this version has been verified against the repository at
commit `f6d7907a3` plus `origin/main` drift checks, with file:line evidence recorded in
`docs/OPENFRONT_ECONOMY_NEGOTIATION_VERIFIED.md` (produced together with this rewrite).
The original document's "audit-first" instinct was correct; the audit has now been done.
This version bakes in the results, deletes work the audit made unnecessary, and re-scopes
the product goal to the current phase.

---

# 0. Why this exists (product frame — read first)

Phase is SHOWCASE (`docs/project-state/STANDING-POSITION.md`): presentation quality and
reach are the goal; agent-strength work, coverage engineering, and speculative platform
features stay frozen.

This project is justified in that frame as a **drama and legibility engine**, not an
agent-IQ upgrade:

- Structured deals with a public referee manufacture discrete story beats a stranger can
  follow — _proposal → pact → betrayal → verdict_ — which premieres, clips, and the
  Director Cut can surface and the league evidence layer can measure as explicit
  commitments ("did the pact hold?").
- Economy legibility ("a third of Auri's income depends on Sefirot's ports") gives those
  deals stakes and gives replay captions concrete facts instead of vibes.
- Starter-agent competence improvements are a side effect, kept cheap and A/B-guarded —
  never the goal.

Success criteria for the phase: deal/betrayal/economy events visible in spectator
artifacts and premiere surfaces, at bounded token cost, with zero regression for
existing uploaded agents. Rating strength is explicitly not a success criterion.

---

# 1. Operating rules (repo-specific, non-negotiable)

- Canonical checkout `/Users/claude/Documents/proxywar_main` stays read-only. All
  implementation happens in the lifecycle-managed worktree
  `/Volumes/ProxyWar Workspace/ProxyWar/worktrees/economy-negotiation-v1`
  (branch `claude/economy-negotiation-v1`), created via `.codex/worktree-lifecycle.mjs`.
  Heartbeat around long work; never remove worktrees directly.
- **Base the branch on `origin/main`**, not local main. Local main is ~131 commits
  behind; the deployed Coworld package is `proxywar:0.1.20` while the in-repo manifest
  still says `0.1.17`. Do not trust the repo manifest for live-version claims; the
  decision log records the shipped package ids.
- Plan + independent review are mandatory before changes under `src/core/**` and to
  `AgentRunner.ts`, `AgentDecisionValidator.ts`, `LegalActionBuilder.ts`,
  `AgentObservationBuilder.ts`, `AgentPlannerExecutor.ts`, `AgentDemoHub.ts`. Review is
  mandatory for the last two. Use the `reviewer` subagent.
- `src/core` stays deterministic. No LLM/provider/network logic in core. V1 requires
  **no core changes**. The pre-existing `DonateGoldExecution` default bug landed
  separately on `main` (2026-08-07), outside the V1 branch.
- Preserve the canonical path
  `AgentObservation → LegalAction[] → exact LegalAction.id → AgentDecisionValidator →
AgentRunner → GameServer`. No raw-intent bypass. Deal actions are meta-actions with
  `intent: null` — precedent: the existing `hold` action.
- Feature gating uses the existing **`AgentTunables.ts`** pattern
  (`PROXYWAR_TUNE_<NAME>`, named exported predicate, doc comment naming the env var,
  default, and the measured failure it fixes). New behavioral levers ship **OFF** and are
  measured on an A/B arm before becoming default. Do not invent a parallel
  `PROXYWAR_*_V1` flag convention (the original document's flag names are dropped).
- Outward actions stay operator-gated: any push, PR, Coworld build/certify against
  hosted, upload/submit, public-starter sync (which is manual — no sync script exists),
  deploys, external messages. Local commits on the `claude/` branch are fine.
- Never link or re-sync `ProxyWar-starter-agent` or `examples/external-agent/`. Note:
  `examples/external-agent/` is retired as an onboarding path but **live as a build
  dependency** (AgentDemoHub serves it; tests assert it; the adapter's `llm-player.mjs`
  imports `starter-framework.mjs` from it). Leave it untouched.
- The bundled Coworld player env must not gain the post-final linger variable
  (0.1.18 incident: linger in the bundled player breaks both certify paths).
- `results.json` is schema-closed (`additionalProperties: false`). New telemetry goes to
  the permissive per-run artifacts (`decisions.jsonl` metadata,
  `spectator-telemetry.json`, match story/drama/Director Cut), never to `results.json`.
- Replay narrative text is **server-authored artifact text** (e.g.
  `AgentSpectatorTelemetry` `publicText`), not client `translateText()`. Only new client
  UI chrome (if any) needs `translateText()` + `resources/lang/en.json`.
- Deal events may be consumed by the league's evidence pipeline; this project only
  emits the underlying events.

---

# 2. Verified mechanics — the audit results (design against these)

Full matrix with file:line citations: `docs/OPENFRONT_ECONOMY_NEGOTIATION_VERIFIED.md`.
Summary of what matters for design, including every place the original document was
wrong or unproven:

## 2.1 Rail / trains (all verified in source + existing tests)

- There is **no buildable train station**. Stations are automatic: a **Factory is the
  seed** — on completion it creates its own train-spawning station and back-fills
  stations onto every City/Port/Factory within `trainStationMaxRange()` = 100
  (min 15). Cities/Ports built later get stations because a factory is in range. No
  factory in range ⇒ no station ⇒ the structure is not part of any rail network.
- Only factories spawn trains (per-station cooldown 10 ticks; per tick one Bernoulli
  roll per factory _level_, p = 1/((L+10)·15) where L = **sum of the player's factory
  levels**). Spawning requires the factory's cluster to contain at least one _eligible_
  City/Port destination. Trains cost 0 gold. Everything about trains is automatic —
  agents influence them only via builds, upgrades, embargoes, attacks, capture.
- Destination choice is **uniform random among eligible trade stations in the cluster**
  (City/Port only — factories are never destinations and factory stops pay nothing).
- **Eligibility is embargo-only** (`Player.canTrade`): self ✅, ally ✅, teammate ✅,
  neutral ✅, at-war-but-not-embargoed ✅, embargoed (either direction) ❌. Alliance is
  NOT required for trade. There is no fog-of-war/vision system in core; all of this is
  fully observable.
- **The disputed alliance-payout question is settled: alliance pays more.** Per City/Port
  stop: base ally 35,000 / neutral 25,000 / team 25,000 / self 10,000, minus 5,000 per
  trade stop past the 10th, floor 5,000. Trains pay at **every** City/Port stop, and
  when train owner ≠ station owner **both are paid the full amount** (minting, not
  splitting). Cooperative cross-border trade is therefore strictly more lucrative than a
  closed domestic economy, and allied trade is the best in the game. Expose this in the
  economy model; the existing test `tests/core/game/TrainStation.test.ts:209-270` pins
  the exact numbers.
- In-flight trains **never reroute**: embargo against the next station's owner kills the
  train on the next leg; station destruction kills it; capture of a station does NOT
  kill it (payout tier recomputed live at each stop); alliance break does NOT kill it
  (tier drops from ally to other at later stops); cluster recompute has no effect.
- **There is no stable cluster ID** (a cluster is a bare object; merges allocate new
  objects). Station ids ARE stable (monotonic ints). Derive the analyzer's cluster key
  as `min(station.id)` over the cluster's stations, computed fresh each decision step.
  The original document's "stable deterministic cluster ID" requirement is otherwise
  unimplementable.

## 2.2 Trade ships (verified)

- Ports auto-spawn trade ships (roll per port level every 10 ticks, pity timer, global
  ship-count damping). Destination is weighted random among eligible foreign ports:
  weight = port level, doubled for mid-distance ports, doubled again for ally/teammate
  ports. **Alliance boosts destination probability; it is not an eligibility gate.**
- On arrival **both port owners are paid the full amount** (distance-based formula, on
  the actual path walked). Warships capture trade ships (instant ownership transfer);
  the captor collects 100% on delivery, the original owner nothing.
- Mid-voyage embargo kills the ship; destination-port destruction kills it; alliance
  break does not.

## 2.3 Embargo / attack / alliance / donations (verified)

- Trade is allowed by default. Embargo state is per-player with an `isTemporary` flag;
  either side's embargo blocks both directions. Manual embargoes never expire.
  `embargo_all` bulk-embargoes every non-bot non-teammate (permanent), 10s cooldown.
- **Attacking auto-creates a temporary embargo on the defender's side against the
  attacker** (5 minutes = 3000 ticks), even if the attack is later ruled invalid, unless
  either party is a Bot. It also auto-rejects the defender's pending alliance request to
  the attacker and applies a difficulty-scaled relation penalty. This settles the
  original document's "which player receives it" question: the _victim_ embargoes the
  _attacker_; the victim's own trade with third parties is untouched.
- Embargo blocks trade ships and trains **only** — donations are not blocked.
- **Attacking an ally is impossible** (hard-blocked in `AttackExecution`; forming an
  alliance mid-attack auto-retreats it). Betrayal therefore always requires an explicit
  `break_alliance` first — which marks the breaker **traitor for 30 seconds** (defense
  debuff ×0.5, conquest-speed debuff ×0.8, permanent `betrayals` stat increment) —
  _unless_ the victim is already a traitor or disconnected (then breaking is free).
  **Exception: nukes.** A nuke whose blast crosses the threshold auto-breaks the
  alliance and marks the launcher traitor; MIRVs break at launch.
- Alliance: request (20s expiry, 30s per-target cooldown), accept/reject, duration 5
  minutes, extension requires both sides and resets the clock from _now_, expiry is
  silent (no traitor, no embargo). Alliance break creates **no embargo**. The
  mutual-request fast path clears _temporary_ embargoes; the normal request→accept path
  does not.
- Donations: require `isFriendly` (ally or teammate), both alive, recipient not
  disconnected; per-recipient 10s cooldown; troops default to 1/3 of the sender's;
  **gold now defaults to 1/3 of the sender's gold too — fixed 2026-08-07**. It used to
  be a dead default (`DonateGoldExecution.ts:33/49` coerced a null amount to 0, so the
  donation silently failed); null is now preserved through construction and the fallback
  fires. V1 support-deal flows still send explicit amounts — a deal has to name a
  checkable quantity — but implicit amounts no longer fail silently. There is **no
  donation-request mechanic** in core (quick-chat "help" keys are cosmetic).
- **Emojis and target markers are not inert** (they mutate Nation relations; 🖕 is −100
  and can drive a Nation to a permanent embargo; target markers are −40 and steer AI
  targeting). In league play there are no Nations (see 2.5), so between agents they are
  informational only. Compliance still treats them as non-violations.

## 2.4 Existing agent layer (verified — extend it, don't duplicate it)

- Observation already has: own gold + structure counts, **per-rival gold**, and a rich
  per-rival diplomacy block (alliance state and all can-act flags, embargo both
  directions, incoming/outgoing requests, coalition edges `alliedWithVisibleIds`).
  Missing (real gaps to fill): any income/rate field, anything rail/trade, rival
  structure counts, rival `isTraitor`.
- `LegalActionBuilder` emits ~17 action kinds with fully deterministic IDs
  (`donate_gold:<player>`, `embargo:<player>:start`, …). Caps: 64 spawn / 96 post-spawn;
  `PROXYWAR_TUNE_DIPLOMACY_SLOTS` reserves up to 8 diplomacy slots under pressure
  (quick_chat/emoji are deliberately unprotected). `hold` is a first-class
  `intent: null` action — the meta-action precedent. Factory/City/Port builds and
  `upgrade_structure` are already offered, affordability-gated, one candidate per unit
  type from ~10 scored tiles.
- Anti-hold quality gates key on `kind === "hold"`, not on `intent === null` — a new
  deal kind will not trip them. The action auditor marks `intent === null` records
  `not_applicable` (acceptable for deal actions; their audit lives in the compliance
  ledger instead). `AgentRunner.submitLegalAction` hard-codes the reason string
  "hold action selected; no game intent submitted" for ALL `intent: null` actions —
  generalize that string when adding deal kinds.
- **Multi-step planning already exists** (`StrategicPlan`: deterministic planID,
  objective, `maxDecisionCycles`, success/failure criteria, preferred/forbidden kinds;
  12 named abort/refresh reasons; gold banking in three flavors; binding
  commitment/alliance/build directives with per-decision adherence audits stamped into
  decision metadata). The original document's separate "economic plan builder" module
  would duplicate this — extend `StrategicPlan` and the directive/audit pattern instead.
- Established vocabulary is **decision step / decision cycle** (never "epoch"). All
  agents are polled **in the same step against the same snapshot**, then submissions
  apply in participant order with same-turn reservation filters (one diplomacy action
  per player-pair per turn, with a deliberate reciprocal-alliance exemption).
- The extension point for a new domain summary is a **new affordance block in
  `AgentTacticalAffordances`** (10 exist; each is `{…facts, recommended, reasons[]}`),
  not a new top-level analyzer module.
- Spectator/narrative pipeline exists end-to-end: `AgentSpectatorTelemetry`
  (`SpectatorEventKind` incl. `trade`/`embargo`/`alliance_*`, tones incl.
  `pact`/`betrayal`, per-pair relationship ledger with trust/betrayals) → match story,
  drama report (betrayalsPaidOff), Director Cut (`treaty_break` reason exists),
  decisive moments (`alliance_betrayal`). Deal/economy events extend these vocabularies.
- **No negotiation machinery exists anywhere** — no deal, proposal, or message-passing
  concept in core or server. The only inter-agent channel is the league runner's
  filtered `recentCommunications` (last 8, addressed-to-me or public, classified
  intents incl. `propose_alliance`) — notably a **proto-deal already ships** as a
  quick-chat pair ("quiet pact: you contain X…" via `attack.focus`/`attack.finish`).
  Deals generalize this runner-scoped pattern; they do not touch core.

## 2.5 League shape and starter (verified — this reshapes the design)

- A hosted league match is a **12-seat FFA where every seat is an externally uploaded
  policy. Nations disabled, bots 0, no disabled units, Easy, `startingGold` 200k,
  500 decision steps × 100 turns at the 12p rung, 15s decision cap, strict seat fill,
  8-map rotation.** Consequences:
  - Deal counterparties are **other agents**, mostly copies of the template starter —
    so the **starter's deterministic executor must handle deals** (respond, honor,
    exploit) even when its LLM plan ignores them. No Nation deal policy is needed for
    V1 (Nations appear only in local/demo modes — out of scope).
  - **Teams never occur in league play.** Cut all team-specific product scope; keep
    team behavior only as core facts in the verified doc.
  - Spawns are runner-assigned before any decision request — placement is not part of
    the league decision loop.
  - Per-seat post-match stats work (stats are clientID-keyed; every league seat is a
    client; the nations/bots-record-nothing caveat is irrelevant in league).
- The starter (`coworld-adapter/tester-starter-llm/`, source of truth for the public
  `proxywar-coworld-starter`; sync is manual and operator-gated): the LLM does **not**
  pick actions — every N decisions it writes a small plan
  (`focus/preferKinds/target/avoidTargets/reason`) and a deterministic executor maps the
  current legal-action menu through it, with anti-repeat memory and honest
  fallback/degraded flags.
- **Prompt-size work CLOSED 2026-08-07 (supersedes the earlier "hardened slim"
  direction in this doc):** the hosted A/B proved the full action menu is
  load-bearing — the slim prompt was reverted upstream (PR #36
  `claude/restore-full-menu-prompt`) and the full move-list prompt is current.
  Standing rule from that workstream: **any starter prompt change requires a hosted
  paired eval-policy A/B before it defaults** (twin eval policies seated 6v6
  alternating slots on identical maps). The econ line in this project follows that
  rule; it is inert until the server-side observation flag is on.
- **Two live starter bugs to fix in Phase A** (they block economy behavior today):
  `PLAN_KINDS`/`DEFAULT_ORDER` contain `"upgrade"` and `"donate"`, but the real kinds
  are `"upgrade_structure"`, `"donate_gold"`, `"donate_troops"` — the starter can
  currently **never upgrade or donate**. The STRATEGY text also describes a nuke
  authorization path that is unreachable (`"nuke"` kind absent from both lists).

---

# 3. What was cut from the original, and why

| Original item                                                        | Disposition                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage 0 "verify disputed mechanics" research                         | **Done** (this audit). Remaining Stage 0 work is writing the verified doc + the missing regression tests (§6 Phase 0).                                                                                                                                                                               |
| `PROXYWAR_ECONOMIC_*_V1` feature flags                               | Replaced by `AgentTunables` `PROXYWAR_TUNE_*` levers (§1).                                                                                                                                                                                                                                           |
| Four new top-level modules                                           | Become: an affordance block, `StrategicPlan`/directive extensions, one new runner-scoped deal manager, and extensions to the existing audit/telemetry pipeline (§2.4).                                                                                                                               |
| "Stable deterministic cluster ID"                                    | Doesn't exist in core; derived key `min(station.id)` (§2.1).                                                                                                                                                                                                                                         |
| "Decision epochs"                                                    | Existing "decision steps" (§2.4).                                                                                                                                                                                                                                                                    |
| Team-destination branches, team payout product surface               | Cut — league is FFA-only (§2.5).                                                                                                                                                                                                                                                                     |
| Seven-plan economic plan taxonomy + plan builder                     | **Deferred to Phase C.** Phase A ships observation + classification + events; the starter gets a compact econ doctrine, not a plan-ID protocol. Rationale: showcase phase; the drama payoff does not require it; `StrategicPlan`+`AgentBuildDirective` already cover much of it for the house stack. |
| Five-configuration matched evaluation matrix                         | Cut as coverage engineering (frozen). Replaced by the existing paired eval-policy A/B + a bounded local episode check (§7).                                                                                                                                                                          |
| Counteroffers, free-text deal prose                                  | Out (V1 had them out too; V1 keeps **zero free text** — enumerated templates only, so there is nothing to sanitize).                                                                                                                                                                                 |
| "Trade-security pact: lift existing manual embargo by deadline" term | Cut from V1 templates — adds a third obligation type for marginal drama; revisit in Phase C.                                                                                                                                                                                                         |
| Alliance-payout conditionality ("only if Stage 0 proves it")         | Proven. The economy model and replay language may state that allied trade pays more.                                                                                                                                                                                                                 |

---

# 4. Phase A — Economy legibility (build first)

Goal: agents and viewers can both see the trade network; replays can say true, concrete
economic sentences. All server-side work behind `PROXYWAR_TUNE_ECONOMY_OBSERVATION` /
`PROXYWAR_TUNE_ECONOMY_EVENTS` (AgentTunables booleans, default OFF).

## A1. Economy affordance + observation block

New affordance in `AgentTacticalAffordances` + optional `economy` block on the
observation (schema additions optional-only). Contents, all computed from live game
state via existing APIs (`RailNetwork`, `StationManager`, `Cluster`,
`Player.canTrade`, stats gold indices; mirror the scoring approach of
`NationStructureBehavior.buildReachableStations`/`computeConnectivityScore`, which is
the in-core reference implementation):

- Own income by verified source since last decision step and cumulative: worker / war /
  trade-ship / captured-trade / train-self / train-external (the six `GOLD_INDEX_*`
  buckets that already exist in stats — never merged into one number).
- Rail clusters touching the agent: derived cluster key, own/foreign station counts by
  type, eligible destinations, destinations blocked by embargo (and whose embargo),
  operational vs idle factories.
- Factory classification: `operational` (cluster has ≥1 eligible City/Port destination)
  / `idle_no_destination` / `blocked_by_embargo` (destinations exist but all embargoed).
  Operational ≠ profitable; realized income is reported separately.
- Per-counterparty **structural dependency**: shared clusters, count of my eligible
  destinations they own, count of their eligible destinations I own, port-trade
  reachability, embargo state both directions, ally status (with the verified payout
  implication: allied stops pay 35k vs 25k). V1 dependency is structural (what fraction
  of my eligible destinations does this player own); realized per-partner income
  attribution is Phase C.
- One primary bottleneck with evidence, from:
  `none | missing_trade_destination | insufficient_factory_capacity |
population_capacity | foreign_dependency | embargo_disruption | insufficient_gold |
unsafe_investment_window | unknown`.
- Rival additions: `unitCounts` (City/Factory/Port only) and `isTraitor` on
  `AgentVisiblePlayer` (both currently missing; optional fields).

Bounds: hard caps on clusters (≤6) and counterparties (≤8) reported, stable sort
orders, integer math, no per-tile payloads. Determinism: same snapshot ⇒ same block.
Perf: computed once per decision step, reusing the network objects — no pathfinding in
the analyzer; budget ≤ a few ms on a 12p Normal map (the shore-map CPU incident is the
cautionary precedent).

## A2. Starter fixes + compact econ doctrine

In `tester-starter-llm` (on the restored full-menu prompt; any prompt change needs a
hosted A/B before defaulting):

- Fix the dead `"upgrade"`/`"donate"` kind strings (→ `upgrade_structure`,
  `donate_gold`, `donate_troops`); correct the unreachable-nuke STRATEGY sentence.
- Add ≤3 lines of econ doctrine to STRATEGY reflecting verified mechanics — factories
  need a City/Port in rail range to earn; cross-border and especially allied train/port
  trade out-earns a closed economy; embargo is the trade weapon.
- If the observation's economy block is present, surface ≤2 compact lines in the GAME
  payload (e.g. `econ: 2 idle factories (no destination); 40% of destinations owned by
Auri (allied)`) — token budget for everything economy: ≤300 chars. Measured through
  the paired eval-policy A/B before any default flip.

## A3. Economy events for spectator surfaces

Extend `SpectatorEventKind` + downstream artifacts (story, drama, Director Cut) with
bounded events: `factory_operational`, `factory_idle`, `trade_link_established`
(first eligible foreign destination with a counterparty), `trade_severed`
(embargo/attack/destruction cut it — say which), `economy_dependency` (crossed a
threshold share of eligible destinations). Each carries actor/target, a server-authored
one-sentence `publicText` using verified vocabulary only (physical connection ≠
eligibility ≠ relationship ≠ projected value ≠ realized income), and importance scoring
so Director Cut can pick them up. Never claim an agent routed/stopped a train.

---

# 5. Phase B — Structured deals + compliance (the drama engine)

All behind `PROXYWAR_TUNE_STRUCTURED_DEALS` (default OFF). Runner-scoped: the deal
manager lives with the league match runner beside the existing communication-signal
machinery; **core, Schemas.ts, and replay determinism are untouched**. Deals do not
alter any game permission — agents remain free to defect; the system measures
follow-through.

## B1. Deal model + manager

New module (e.g. `src/server/agents/AgentDealManager.ts`), deterministic, per-match:

- Templates (V1, enumerated, zero free text):
  - `non_aggression_pact` — mutual: no confirmed hostile action against each other for
    N decision steps.
  - `trade_security_pact` — mutual: non-aggression **plus** no new _voluntary_ embargo
    against each other. (It does not enable trade, create an alliance, control
    trains/ships, or guarantee income.)
  - `joint_attack` — obligor commits confirmed military pressure on a named third
    player within N steps. Offered only when the obligor currently has a plausible
    attack path (borders the target or has boat options).
  - `support_request` — obligor sends ≥X gold or ≥Y troops within N steps. Offered only
    when donation is currently legal (`isFriendly` — so in practice between allies) and
    always with **explicit amounts** — the referee needs a checkable quantity to score
    fulfillment. (Implicit amounts no longer silently fail; the null-gold dead default
    was fixed 2026-08-07. Explicit amounts are now a compliance requirement, not a
    core-bug workaround.)
- Lifecycle: `open → accepted | rejected | withdrawn | expired`; obligations:
  `pending → fulfilled | violated | expired_unfulfilled | moot`. No counteroffers.
- Deterministic IDs: `deal:<proposerSeat>:<recipientSeat>:<template>:<decisionStep>`.
- Timing in decision steps (§2.4 semantics): proposed at step N ⇒ visible in
  observations at N+1; accepted at N+1 ⇒ active from N+2; same-step actions can never
  retroactively fulfill or violate. Ticks retained in the ledger for audit.
- Caps: ≤2 open proposals per pair, ≤6 active deals per agent, durations bounded
  (e.g. 3–20 steps). Expired proposals auto-reject silently.

## B2. Legal-action kinds

Four new kinds in `LegalActionKind` **and** `legalActionKinds`:
`deal_propose`, `deal_accept`, `deal_reject`, `deal_withdraw` — all `intent: null`,
IDs like `deal_propose:<recipient>:<template>` / `deal_accept:<dealID>`. Offered only
when the flag is on and the manager has capacity; added to `DIPLOMACY_KINDS` so the
reserved-slot mechanism protects them; exact-ID validation unchanged. Generalize the
`AgentRunner.submitLegalAction` reason string for non-hold meta-actions. Auditor: deal
records stay `not_applicable` (their truth lives in the compliance ledger).

## B3. Observation + starter handling

- Observation additions (optional, capped): incoming open proposals (with terms),
  own outgoing proposals, active deals with per-obligation status and steps remaining,
  per-rival one-line reliability (`fulfilled / terminal non-moot`, null if no sample).
  Privacy: a bilateral proposal is visible only to sender and recipient (runner-side
  filtering, same pattern as directed communication signals); operator/replay artifacts
  see everything under existing artifact policy.
- Starter: plan JSON gains one optional field `"deal": "accept" | "decline" | null`
  interpreted as a standing posture; the deterministic executor
  (a) auto-**rejects** proposals from the plan's current `target`,
  (b) auto-**accepts** non-aggression/trade-security from anyone in `avoidTargets` or
  when posture is `accept`, (c) proposes nothing in V1 unless `focus === "ally"` (then
  a non-aggression offer to the strongest non-target neighbor), (d) never violates an
  active pact it accepted while the pact partner stays out of `preferKinds` targeting —
  betrayal happens only when the LLM plan explicitly sets `target` to the partner.
  Old starters and third-party agents that ignore deal actions are unaffected:
  proposals to them simply expire (this must be a tested no-op).

## B4. Compliance referee + drama events

Deterministic per-match ledger (e.g. `AgentDealCompliance.ts`), judging **confirmed
game effects only** (from execution outcomes/audit snapshots, not selected actions):

- Non-aggression / trade-security violations: confirmed land attack (an
  `AttackExecution` actually launched), transport invasion arrival, nuke/MIRV against
  the partner, or explicit `break_alliance` followed by attack; plus (trade-security)
  a **manual** embargo created against the partner. The automatic temporary embargo a
  victim gains by being attacked is never a violation by the victim. Emojis, quick
  chat, and target markers are never violations.
- `joint_attack`: fulfilled only by confirmed attack execution against the named third
  party ≥ configured pressure threshold within the window.
- `support_request`: fulfilled when cumulative confirmed donations to the correct
  recipient reach the explicit amount in the window.
- `moot`: counterparty/target eliminated, or obligation impossible through events
  outside the obligor's control.
- Every accepted obligation reaches a terminal state by match end (force-resolve at
  final step). Per-agent reliability = fulfilled / terminal non-moot obligations
  (null without sample). **No hidden morality score; no rating input.** Betrayal is a
  legitimate, sometimes winning move — the referee narrates, it does not punish.
- Events into `SpectatorEventKind` + tones: `deal_proposed`, `deal_accepted` (tone
  `pact`), `deal_rejected`, `deal_expired`, `deal_fulfilled`, `deal_violated` (tone
  `betrayal`, high importance — Director Cut `treaty_break` and decisive-moment
  `alliance_betrayal` both hook it), with server-authored publicText like:
  `"Auri accepted Sefirot's non-aggression pact (12 decisions)."` /
  `"VERDICT: Auri violated the pact — land attack on Sefirot at step 214."`
- Decision metadata: stamp `dealAction`, `dealID`, `dealComplianceEvent` keys on the
  decision records (`decisions.jsonl` is the permissive surface).

---

# 6. Phase 0 + tests (definition of done per phase)

**Phase 0 (immediately):** commit `docs/OPENFRONT_ECONOMY_NEGOTIATION_VERIFIED.md`
(the audit matrix with file:line + existing-test citations) and add the missing
regression tests the audit exposed — there is currently **no test coverage at all** for
`TrainExecution`, `TrainStationExecution`, `FactoryExecution`,
`RecomputeRailClusterExecution`:

1. Factory spawns no train when its cluster has no eligible City/Port; spawns after a
   connecting City is built (spawn preconditions incl. the eligible-destination gate).
2. Factory-only cluster: factories are never destinations.
3. Embargo (either direction) makes a destination ineligible; in-flight train dies on
   the next leg toward the embargoed owner.
4. Attack auto-creates the temporary embargo on the defender's side; it expires after
   3000 ticks; manual embargo is not downgraded by a later temporary one.
5. Alliance break: no embargo, trains continue, payout tier drops ally→other next stop;
   breaker traitor unless victim already traitor/disconnected.
6. Multi-hop payout: N City/Port stops pay N times; both parties full amount; team
   classified before ally (documents the teammates-earn-less quirk).
7. Station capture: train continues; tier recomputed against new owner.
8. Donations: friendly-only, disconnected-recipient refusal, 10s cooldown, troop 1/3
   default; gold explicit amounts, plus the gold 1/3 default and the sender-balance
   clamp (the null-gold dead default was fixed 2026-08-07 —
   `tests/DonateGoldDefaultAmount.test.ts`).
9. Trade ship: mid-voyage embargo kills; capture pays captor 100%.

(Existing tests already pin: exact `trainGold` tiers, ghost-rail matrix, cluster
merge/split, nation alliance behavior — cite, don't duplicate.)

**Phase A tests:** analyzer classification (operational/idle/blocked) on constructed
game states; bottleneck selection evidence; determinism (same snapshot ⇒ identical
block, stable ordering); flag OFF ⇒ byte-identical observations and menus (template:
`tests/server/DiplomacyReservedSlots.test.ts`); caps respected; no game-state mutation;
starter kind-string fix (executor can now select `upgrade_structure`/`donate_gold`);
spectator economy events emitted with correct vocabulary.

**Phase B tests:** deterministic deal IDs; step-boundary visibility/effectivity;
accept/reject/withdraw/expire; per-pair and per-agent caps; privacy (third seats never
see a bilateral proposal in observations); every accepted obligation terminal by match
end; each violation/fulfillment rule above (incl. victim's auto-embargo attributed
correctly, emoji/chat/target never violations); ignore-deals agent is unaffected
end-to-end; deal actions don't trip hold-quality gates and audit as `not_applicable`;
`results.json` byte-schema-unchanged; decisions.jsonl metadata keys present; flags OFF
⇒ legacy behavior byte-identical.

Gates for every phase: `npm test`, `npm exec -- tsc --noEmit`, `npm run lint`, and for
starter/adapter changes `cd coworld-adapter && npm run certify` (local; hosted
build/upload stays operator-gated) plus one local `run:episode` smoke with flags ON.

---

# 7. Evaluation (bounded — replaces the 5-config matrix)

- **Mechanism check (local, cheap):** 2–3 local episodes flags-ON vs flags-OFF on the
  ffa4p manifest; assert no fallback-rate regression, no decision-latency regression
  (15s cap headroom), deal events present and terminal, artifacts render.
- **Hosted A/B (operator-gated):** reuse the paired eval-policy methodology
  (twin policies, 6v6 alternating seats, identical maps). Metrics: reply-format/fallback
  rate (the slim-v1 lesson), survival/rank (regression guard, not a target),
  idle-factory time share, deal volume/acceptance/violation counts, drama-report grade
  distribution, prompt tokens per decision, $ per seat-episode.
- Success = drama events flow into premiere/Director-Cut surfaces at no competence or
  cost regression. Explicit non-goals: rating gains, "social skill" claims from volume.
- Watch item (product): if pacts suppress conflict into dull matches, tune template
  durations/caps (drama first — universal peace is a failure mode, not a win).

---

# 8. Completion criteria

- Verified-mechanics doc committed; Phase 0 regression tests green.
- Economy block + affordance behind default-OFF tunables; factories classified;
  bottleneck with evidence; rival unitCounts/isTraitor added optionally.
- Starter upgrade/donate kind bug fixed; econ line ≤300 chars on the restored
  full-menu prompt; A/B arms prepared (activation operator-gated).
- Deal manager + four meta-action kinds + compliance ledger + spectator/Director-Cut
  events behind default-OFF tunable; privacy enforced; every obligation terminal;
  agents that ignore deals provably unaffected.
- No core changes (except the separately-tracked donate-gold fix); no `results.json`
  schema change; no bundled-player env change; replays deterministic; certify green.
- All work on `claude/economy-negotiation-v1`; push/PR/upload/sync left for the
  operator gate.

# 9. Final report contents

What changed and where; corrections vs this document discovered during implementation
(there will be some — report them, don't paper over them); test/typecheck/lint/certify
results; local episode evidence with artifact paths; token/latency measurements; flag
inventory and defaults; exact remaining operator gates (merge to origin/main, hosted
A/B, starter sync, package rebuild). Uncertainty stated plainly — no plausible prose
over unverified claims.
