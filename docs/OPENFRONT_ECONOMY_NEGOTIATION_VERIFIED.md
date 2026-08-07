# OpenFront Economy + Negotiation — Verified Mechanics (Stage 0)

Verification date: 2026-08-07. Verified by source inspection at commit `f6d7907a3`
(local main) with spot drift-checks against `origin/main` (`3b9a178d4`). Line numbers
cite the audited commit and may drift; the Phase 0 regression tests re-prove every
load-bearing fact on the current base. Deployed-package note: hosted league runs
`proxywar:0.1.20` (decision log) while the in-repo manifest says `0.1.17` — repo
manifests must not be used for live-version claims. No hosted APIs were called for
this document.

Legend: **[test]** = an existing test already pins this; **[gap]** = no test existed at
audit time; Phase 0 adds it.

---

## 1. Rail network formation

| Fact | Evidence |
| --- | --- |
| No buildable train-station unit exists; stations are automatic | `UnitType`/`Structures` lists (`src/core/game/Game.ts:323-379`); `TrainStationExecution` never appears as a build order |
| **Factory is the seed.** On completion it creates its own train-spawning station and back-fills stations onto every City/Port/Factory already within range | `FactoryExecution.ts:34-47` (only call site passing `spawnTrains=true`) |
| A City gets a station only if a factory is in range at its completion (one-shot latch); a Port retries every tick; a factory built later back-fills both | `CityExecution.ts:16-43`, `PortExecution.ts:38-95`, `FactoryExecution.ts:42-46` |
| Station connection: snap to an existing rail within radius 3, else path to stations within euclidean range (min 15, max 100), path length < 120 tiles, skipping stations already reachable within 4 graph hops. Connections are **not owner-filtered** — enemy/ally stations join the same physical cluster | `RailNetworkImpl.ts:84-86, 103-108, 162-338, 357`; `DefaultConfig.ts:304-312` **[test]** ghost-rail matrix `tests/core/game/RailNetwork.test.ts:171-332` |
| **No stable cluster ID.** `Cluster` is a bare object; merges allocate new objects; splits move the first component into a fresh object. Station ids ARE stable monotonic ints (0 = sentinel) | `TrainStation.ts:161-246`, `RailNetworkImpl.ts:24-33, 110-132, 420-425` **[gap → derived key `min(station.id)`]** |
| Cluster recompute is lazy (dirty-flag on station removal), driven by a per-tick `RecomputeRailClusterExecution` registered when Factory isn't disabled | `RailNetworkImpl.ts:110-132`, `GameRunner.ts:120-124` |

**Product implication:** "build a factory near a City/Port" IS the rail action. There is
no station or route micro-management to expose to agents, and physical connectivity is
a separate fact from trade eligibility (§3).

## 2. Train spawning and income

| Fact | Evidence |
| --- | --- |
| Only factories spawn trains: per-station cooldown 10 ticks, then one Bernoulli roll per factory **level**, p = 1/((L+10)·15), where L = the player's `unitCount(Factory)` = **sum of factory levels** | `TrainStationExecution.ts:13, 53-98`, `DefaultConfig.ts:274-278`, `PlayerImpl.ts:287-294` **[gap]** |
| Spawn requires the cluster to contain ≥1 *eligible* City/Port destination; destination is uniform random (reservoir) among eligible trade stations; factories are never destinations and factory stops pay nothing | `TrainStationExecution.ts:65-98`, `TrainStation.ts:40-46, 165-180, 208-226` **[gap]** |
| Trains cost 0 gold; composition 1 engine + tail + 5 carriages; speed 2 tiles/tick | `DefaultConfig.ts:468-471`, `TrainStationExecution.ts:11`, `TrainExecution.ts:21-26, 144-165` |
| **Payout is per City/Port stop along the whole route**, and when train owner ≠ station owner **both are paid the full amount** (minting, not splitting) | `TrainStation.ts:15-38`, `TrainExecution.ts:251-274` **[test]** `tests/core/game/TrainStation.test.ts:99-129` **[gap: multi-hop accumulation]** |
| **Relationship changes the payout (the formerly disputed mechanic — settled):** base ally 35,000 / team 25,000 / other 25,000 / self 10,000; −5,000 per trade stop past the 10th; floor 5,000; × goldMultiplier. Team is classified before ally, so teammates earn the *lower* tier | `DefaultConfig.ts:279-302`, `TrainStation.ts:248-262` **[test]** exact numbers `TrainStation.test.ts:209-270` |
| Stats: six gold sources already exist — work / war / trade / steal(captured-trade) / train-self / train-external | `StatsSchemas.ts:81-87`, write sites `TrainStation.ts:33,36`, `TradeShipExecution.ts:188-217` |

**Product implication:** cross-border train trade is strictly more lucrative than a
closed economy, and **allied** trade is the best income in the game. Economy language
may state this as verified fact. "Operational" (can produce valid trips) must stay
distinct from realized income.

## 3. Trade eligibility, embargo, and in-flight behavior

| Fact | Evidence |
| --- | --- |
| **Eligibility is embargo-only.** `canTrade` = no embargo in either direction and not self. Alliance/team/war status is NOT consulted | `PlayerImpl.ts:877-881`, `TrainStation.ts:74-77` |
| Embargo state: per-player map with `isTemporary`; either side's embargo blocks both directions; default = trade allowed. Manual embargoes never expire; a manual embargo is never downgraded by a later temporary one; a temporary one can be refreshed/upgraded | `PlayerImpl.ts:80, 887-903`, `Game.ts:675-679`, expiry sweep `PlayerExecution.ts:90-98` **[gap]** |
| **Attack auto-creates a temporary embargo on the DEFENDER's side against the attacker** (3000 ticks = 5 min), even if the attack is later ruled invalid; skipped if either party is a Bot. Attack also auto-rejects the defender's pending alliance request to the attacker and applies a difficulty-scaled relation hit (−60…−100) | `AttackExecution.ts:83-93, 149-169, 309-316`, `DefaultConfig.ts:590-592` **[gap]** |
| Embargo blocks trade ships and trains **only**; donations are NOT embargo-gated | consumer sweep: `TradeShipExecution.ts:84`, `PortExecution.ts:108`, `TrainStation.ts:74-77`, `TrainExecution.ts:239-248`; donation gates `PlayerImpl.ts:738-790` |
| In-flight trains never reroute: embargo vs next station's owner ⇒ train dies on next leg; next-station destroyed ⇒ dies; later-station destroyed ⇒ dies at that leg; station captured ⇒ continues, tier recomputed live; alliance break ⇒ continues, tier drops; cluster recompute ⇒ no effect | `TrainExecution.ts:104-121, 179-185, 227-248` **[gap]** |
| Trade ships: auto-spawn (roll per port level every 10 ticks, pity timer, global-count damping); destination weighted random among eligible foreign ports — weight = port level, ×2 mid-distance, ×2 ally/teammate (**probability bonus, not eligibility**); arrival pays **both** port owners in full (distance formula on actual path); mid-voyage embargo or dest-port destruction kills; warship capture transfers ownership and the captor collects 100% (source-side payout goes to the source port's owner at arrival time). **Note: Warships retired from new gameplay 2026-08-07 (kept as replay-compat) — captured-trade income is legacy-only in new matches** | `PortExecution.ts:42-84, 99-143`, `TradeShipExecution.ts:76-118, 149-193`, `DefaultConfig.ts:314-336`, `WarshipExecution.ts:114-118, 266-295, 634-673`; decision-log 2026-08-07 **[gap: embargo kill]** |
| `embargo_all`: bulk **permanent** embargo/un-embargo of every non-bot non-teammate; 10s cooldown; already an agent action kind | `EmbargoAllExecution.ts:9-27`, `DefaultConfig.ts:559-561`, `AgentPersonalityDiplomacyPolicy.ts:31` |

## 4. Alliances, betrayal, teams, donations

| Fact | Evidence |
| --- | --- |
| Alliance: request expires 20s, 30s per-target cooldown; mutual-request fast path auto-accepts, sets +100 relations both ways, clears **temporary** embargoes, cancels in-flight nukes between the pair. Normal request→accept path does NOT clear temporary embargoes | `PlayerImpl.ts:520-565`, `AllianceRequestExecution.ts:36-141` |
| Duration 5 min; extension needs both sides and resets the clock from *now*; expiry is silent (no traitor, no embargo) | `AllianceImpl.ts:17, 82-86`, `PlayerExecution.ts:84-88`, `DefaultConfig.ts:587-589` |
| **Attacking an ally is impossible** (hard block; alliance formed mid-attack auto-retreats it). Betrayal requires explicit `break_alliance` → traitor for 30s (defense debuff 0.5 = attackers lose half as many troops vs a traitor; conquest-speed debuff 0.8; permanent `betrayals` stat) — **unless the victim is already a traitor or disconnected (breaking is then free)** | `AttackExecution.ts:71-81, 245-249`, `GameImpl.ts:769-793`, `PlayerImpl.ts:575-597`, `DefaultConfig.ts:158-166` **[gap]** |
| Alliance break creates **no embargo** and does not interrupt trains/ships | `BreakAllianceExecution.ts:25-51` **[gap]** |
| **Nukes are the betrayal exception:** blast over threshold auto-breaks the alliance and marks the launcher traitor; MIRV breaks at launch. Transport invasions apply full attack side effects only on arrival | `NukeExecution.ts:127-176`, `MIRVExecution.ts:58-68`, `TransportShipExecution.ts:84-97, 257-268` |
| Teams: immutable at game construction; teammates are `isFriendly` (attack-blocked, donation-eligible, no nukes, 95% win threshold) but get **no trade privileges** and the *lower* train tier; teammates can manually embargo each other (only `embargo_all` skips them). **League never runs teams (§6)** | `PlayerImpl.ts:113, 932-950`, `GameImpl.ts:139-190`, `EmbargoExecution` vs `EmbargoAllExecution.ts:17` |
| Donations: require `isFriendly` (ally or team), both alive, recipient not disconnected; per-recipient 10s cooldown; troops default 1/3 of sender capped by recipient headroom; **gold null-amount is a live bug — becomes 0 and silently fails** (`toInt(goldNum ?? 0)` at line 33 makes the `??=` fallback at line 49 dead). Donations to Nations bypass the human-only config toggles. No donation-request mechanic exists anywhere (quick-chat "help" keys are cosmetic) | `PlayerImpl.ts:738-790`, `DonateGoldExecution.ts:33, 49`, `DonateTroopExecution.ts:44-51`, `DefaultConfig.ts:553-558`, `Schemas.ts:384-394` **[gap]** |
| **Emojis and target markers are not inert:** they mutate Nation relations (🖕 −100, 🤡 −10, doves +15 on Easy; target −40 and steers AI attack/nuke targeting; targets propagate to allies). Quick chat is purely cosmetic. Relation ≤ Hostile drives Nations to permanent embargo — so a 🖕 can cost trade income vs Nations. Between agents (no Nations in league) they are informational only | `NationEmojiBehavior.ts:279-326`, `TargetPlayerExecution.ts:23-28`, `NationExecution.ts:274-343`, `QuickChatExecution.ts:29-48` |
| Conquest gold: capturing a player takes 100% of a Bot/Nation's gold, 50% of a human's/agent's | `DefaultConfig.ts:512-521` |
| Stats are keyed by `clientID`: Nations and Bots record nothing. Irrelevant in league (all seats are clients), relevant for any local match vs Nations | `StatsImpl.ts:62-81`, `NationCreation.ts:34, 102` |

## 5. Agent layer (server) — current state

| Fact | Evidence |
| --- | --- |
| Observation already has own gold + structure counts, **per-rival gold**, full per-rival diplomacy block (alliance state + can-act flags, embargo both directions, pending requests, coalition edges). Missing: income/rate anywhere, anything rail/train/trade, rival structure counts, rival `isTraitor` | `AgentObservationBuilder.ts:103-401, 1429-1439`, `AgentTypes.ts:47, 67-120` |
| ~17 emitted action kinds, deterministic IDs, caps 64 spawn / 96 post-spawn; `PROXYWAR_TUNE_DIPLOMACY_SLOTS` reserves up to 8 diplomacy slots (quick_chat/emoji unprotected). Factory/City/Port builds + `upgrade_structure` already offered, affordability-gated | `LegalActionBuilder.ts` (id templates at :56-663, caps :40/:101, reservation :1224-1261), `AgentTypes.ts:733-784` |
| `hold` is a first-class `intent: null` meta-action; validator falls back to it on unknown IDs; anti-hold quality gates key on `kind === "hold"` (not `intent === null`); auditor marks `intent === null` as `not_applicable`; `AgentRunner.submitLegalAction` hard-codes a "hold action selected" reason for ALL `intent: null` actions (generalize when adding kinds) | `LegalActionBuilder.ts:55-64`, `AgentDecisionValidator.ts:15-77`, `AgentStepLockedLeague.ts:205-242`, `AgentActionAuditor.ts:54`, `AgentRunner.ts:196-211` |
| Multi-step planning exists: `StrategicPlan` (deterministic planID, objective, maxDecisionCycles 1-8, success/failure criteria, preferred/forbidden kinds), 12 named refresh/abort reasons, gold banking (3 mechanisms), binding commitment/alliance/build directives with per-decision adherence audits stamped into decision metadata | `AgentPlannerExecutor.ts:146-212, 561, 791-901, 2424-2671` |
| Cadence vocabulary: **decision step / decision cycle** (no "epoch"). All agents polled in the same step against the same snapshot (parallel), then submissions apply in participant order with same-turn reservation filters (one diplomacy action per pair per turn; deliberate reciprocal-alliance exemption) | `AgentStepLockedLeague.ts:69-185`, `AgentLeagueMatch.ts:337-412, 1152-1197` |
| Feature gating: `AgentTunables.ts` `PROXYWAR_TUNE_<NAME>` named predicates with doc comments; new levers ship OFF and are A/B-measured (19 boolean levers exist incl. `ECONOMY_BOOTSTRAP`, `GOLD_PRESSURE`, `DIPLOMACY_SLOTS`) | `AgentTunables.ts:19-26, 35-414` |
| Telemetry pipeline: `AgentSpectatorTelemetry` (`SpectatorEventKind` 15 kinds incl. trade/embargo/alliance_*, tones incl. pact/betrayal, per-pair relationship ledger) → match story → drama report (betrayalsPaidOff) → Director Cut (`treaty_break`) → decisive moments (`alliance_betrayal`). Narrative text is server-authored artifact text, NOT client `translateText()` | `AgentSpectatorTelemetry.ts:20-91, 390-391`, `AgentDramaReport.ts:34-81`, `DirectorCutPlan.ts:78-114`, `AiLeagueReplayOverlay.ts:5321` |
| **No negotiation machinery exists** in core or server. Only inter-agent channel: league-runner `recentCommunications` (last 8, addressed-to-me or public, classified intents incl. `propose_alliance`); a proto-deal quick-chat pair already ships (`attack.focus`/`attack.finish` "quiet pact"). Core `Intent` union has no message/deal member — deals must be runner-scoped meta-actions | grep sweep; `AgentLeagueMatch.ts:1015-1072`, `AgentTypes.ts:633-651`, `AgentObservationBuilder.ts:1702-1729`, `Schemas.ts:325-463` |
| Rail-aware placement scoring already exists in core Nation AI (private): `buildReachableStations` (embargo-filtered, relationship-weighted by `trainGold`) + `computeConnectivityScore` — the reference implementation for any server-side analyzer | `NationStructureBehavior.ts:1055-1226` **[test]** `tests/NationStructureBehavior.test.ts:82-316` |

## 6. League + starter ground truth

| Fact | Evidence |
| --- | --- |
| Hosted league match = **12-seat FFA, every seat an uploaded policy, nations disabled, bots 0, no disabled units, Easy, startingGold 200k**; rungs 2/4/8/12 with strict seat fill; 12p = 500 steps × 100 turns, Normal maps (8-map rotation), 15s decision cap, 100-min wall clock; spawns runner-assigned before any decision | `no-docker-coworld-episode.ts:819-836, 1052-1058`, `commissioner/.../proxywar_app.py:19-119`, `configs/proxywar.yaml`, `AgentLeagueMatch.ts:211-241` |
| **2026-08-07 (current base):** Warships retired from all new gameplay and agent strategy (core enum/schema/execution kept as replay-compat tombstone; Transport boats kept); a deterministic 60-simulated-minute territorial adjudication backstop added to 12-seat league games so hold/social-heavy policies cannot burn the full 50,000-turn budget without a result. Deal durations and economy projections should assume matches resolve by adjudication time | decision-log 2026-08-07 row (`3e759a19c`, merged as PR #35 = `3b9a178d4`) |
| Starter (`coworld-adapter/tester-starter-llm/`, source of truth for public `proxywar-coworld-starter`; sync manual + operator-gated): LLM writes a plan (`focus/preferKinds/target/avoidTargets/reason`) every ~3 decisions; deterministic executor maps plans to exact legal-action IDs with anti-repeat memory and honest fallback flags; decision never awaits the LLM | `llm-player.mjs:196-314, 223-259, 352-377`, `coworld-adapter/docs/player-protocol.md:12-53` |
| **Live starter bugs:** `PLAN_KINDS`/`DEFAULT_ORDER` use `"upgrade"`/`"donate"` but real kinds are `upgrade_structure`/`donate_gold`/`donate_troops` — the starter can never upgrade or donate; the STRATEGY nuke-authorization sentence is unreachable (`"nuke"` kind absent). Same on origin/main | `llm-player.mjs:71-83, 262-272` vs `AgentTypes.ts:733-757` |
| Prompt-slim state: slim prompt (−67%) shipped on origin/main (`legalKinds` + `highRisk` replacing full action list); hosted A/B showed slim-v1 reply-format regression; hardening fix unmerged on `claude/llm-prompt-slim-harden` (`28db28ee0`). Starter prompt work must build on the hardened variant and re-use the paired eval-policy A/B | `docs/project-state/2026-08-07-llm-prompt-slim-verification.md` |
| `results.json` schema is closed (`additionalProperties: false`) — new telemetry rides per-run artifacts (`decisions.jsonl` incl. `selectedActionMetadata`, `spectator-telemetry.json`, story/drama/Director-Cut files) | `coworld_manifest.json` `game.results_schema`, `no-docker-coworld-episode.ts:60-128` |
| Nations: full alliance request/extension/proposal behavior + emoji reactions + hostile embargoes exist (`NationAllianceBehavior`, tests) — but league play has none; Nation deal policy is out of V1 scope | `NationAllianceBehavior.ts:29-147`, `tests/NationAllianceBehavior.test.ts:100-193` |
| `examples/external-agent/` is retired as onboarding but **live as a build dependency** (AgentDemoHub serves it, tests assert it, adapter imports `starter-framework.mjs` from it). Do not touch, never link publicly | `AgentDemoHub.ts:363-501`, `tests/server/AgentDemoHub.test.ts:570-573`, `coworld-adapter/src/llm-player.mjs:148` |

## 7. Phase 0 test gaps (added by this project)

No test coverage existed at audit time for `TrainExecution`, `TrainStationExecution`,
`FactoryExecution`, `RecomputeRailClusterExecution`, attack-created embargoes, or
donation legality edges. The Phase 0 suite (see the V1 plan document, §6) adds:
spawn-precondition tests, factory-only-cluster, in-flight-train death on embargo and
station destruction, capture tier-recompute, multi-hop payout accumulation, temporary
embargo creation/expiry/non-downgrade, alliance-break effects, betrayal traitor rules,
donation legality + explicit-amount rule, trade-ship embargo kill + capture payout.
