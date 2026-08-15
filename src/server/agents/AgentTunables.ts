/**
 * Agent-strength tunables.
 *
 * Each high-leverage executor / strategic-state magic constant can be overridden at
 * process start via `PROXYWAR_TUNE_<NAME>` (e.g. `PROXYWAR_TUNE_RESERVE_RATIO=0.45`).
 * When the env var is unset or not a finite number the shipped default constant is
 * used unchanged, so the shipped behavior — and every existing test — is byte-for-byte
 * preserved when no tunable is set.
 *
 * Scope: this lever is consumed only by the deterministic house-agent policy stack
 * (the planner executor + strategic-state builder), which run in `src/server`, not
 * `src/core`. It is a controlled-experiment knob for the same-seed A/B benchmark
 * sweep. It does NOT alter the LegalAction contract, add a runner/validator/schema,
 * change the external-agent protocol, or touch the deterministic simulation.
 *
 * Both house agents and external-agent authors can read these names to understand
 * which scoring/threshold gates drive expansion, defense flips, and build timing.
 */
export function tunedNumber(name: string, fallback: number): number {
  const raw = process.env[`PROXYWAR_TUNE_${name}`];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Binding-directives feature flag (the P1 keystone). Reads the EXACT env var
 * `PROXYWAR_TUNE_DIRECTIVE_COMMITMENT` (A/B arms set "0"/"1" on the same build).
 * Default ON. Gates the planner-prompt commitment schema and commitment parsing;
 * downstream enforcement keys off `plan.commitment` presence, which can only be
 * set when this flag was on at parse time.
 */
export function directiveCommitmentEnabled(): boolean {
  return tunedNumber("DIRECTIVE_COMMITMENT", 1) >= 1;
}

/**
 * Binding diplomacy directive flag (Keystone Phase 2). Reads the EXACT env var
 * `PROXYWAR_TUNE_DIRECTIVE_DIPLOMACY` (A/B arms set "0"/"1"). Default ON. Gates the
 * planner-prompt alliance schema and alliance-directive parsing; downstream
 * enforcement keys off `plan.allianceDirective` presence, which can only be set
 * when this flag was on at parse time (or when seeded by a player strategy spec).
 */
export function directiveDiplomacyEnabled(): boolean {
  return tunedNumber("DIRECTIVE_DIPLOMACY", 1) >= 1;
}

/**
 * Binding economy directive flag (Keystone Phase 2.2). Reads the EXACT env var
 * `PROXYWAR_TUNE_DIRECTIVE_BUILD` (A/B arms set "0"/"1"). DEFAULT OFF — this is a new
 * behavioral lever (a build directive is the lowest-bar directive and pre-empts
 * expansion/attack), so it ships inert and is measured on an A/B arm before becoming
 * default. Gates the planner-prompt build schema and build-directive parsing;
 * downstream enforcement keys off `plan.buildDirective` presence, which can only be
 * set when this flag was on at parse time.
 */
export function directiveBuildEnabled(): boolean {
  return tunedNumber("DIRECTIVE_BUILD", 0) >= 1;
}

/**
 * Economy-bootstrap behavior (`PROXYWAR_TUNE_ECONOMY_BOOTSTRAP`, A/B arms set
 * "0"/"1"). DEFAULT OFF. Fixes the verified `ab-ffa4p-arsenal-r1` failure: the agent
 * expands well (~46k tiles) but never banks its first City's 125k gold cost — it
 * spends gold on precautionary Defense Posts (boats are gold-free, so Defense Posts
 * are the only discretionary gold sink), so City/Factory/Port and the whole
 * infra/advanced-warfare tree stay permanently unaffordable (offered 0/211). When ON
 * and the agent has NO City and is NOT under attack, the frontier scorer penalizes
 * precautionary Defense Posts (so gold banks toward the City) and strongly prefers
 * the first City once it becomes affordable+offered. Tightly gated (pre-first-City +
 * not-under-attack) so normal defensive play is untouched; ships inert and is measured
 * on a watched-game arm before becoming default.
 */
export function economyBootstrapEnabled(): boolean {
  return tunedNumber("ECONOMY_BOOTSTRAP", 0) >= 1;
}

/**
 * Gold-pressure spend-down flag (Keystone K2, plan keen-sparking-hollerith). Reads the
 * EXACT env var `PROXYWAR_TUNE_GOLD_PRESSURE` (A/B arms set "0"/"1"). DEFAULT OFF —
 * ships inert and is measured on a forge A/B arm before becoming default. When ON, the
 * executor's precedence cascade forces the highest-ranked offered build/upgrade action
 * (never a nuke) once parsed `ownState.gold` has exceeded the effective pressure floor
 * for >=2 consecutive decisions — the "96M hoard" insurance: gold sitting idle above
 * the floor is converted into structures/upgrades instead of compounding unspent.
 */
export function goldPressureEnabled(): boolean {
  return tunedNumber("GOLD_PRESSURE", 0) >= 1;
}

/**
 * Base gold-pressure floor (`PROXYWAR_TUNE_GOLD_PRESSURE_FLOOR`, default 3,000,000).
 * Applies while the player has no MissileSilo or before turn 1600: structure costs cap
 * at 1-3M, so gold above ~3M pre-deterrence is buying nothing.
 */
export function goldPressureFloor(): number {
  return tunedNumber("GOLD_PRESSURE_FLOOR", 3_000_000);
}

/**
 * MIRV-bank gold-pressure floor (`PROXYWAR_TUNE_GOLD_PRESSURE_MIRV_FLOOR`, default
 * 30,000,000). Once a MissileSilo exists AND turn >= 1600 (the nuke era), the pressure
 * floor rises to this value so forced spend-down can never drain the war chest below
 * the ~25M a MIRV costs — a flat 3M floor would make the MIRV permanently unreachable
 * by force-spending the bank forever.
 */
export function goldPressureMirvBankFloor(): number {
  return tunedNumber("GOLD_PRESSURE_MIRV_FLOOR", 30_000_000);
}

/**
 * Upgrade-visibility flag (Keystone K2, plan keen-sparking-hollerith). Reads the EXACT
 * env var `PROXYWAR_TUNE_UPGRADE_VISIBILITY` (A/B arms set "0"/"1"). DEFAULT OFF —
 * when OFF the political-showcase upgrade scoring arm is byte-identical to shipped
 * behavior (flat 360 from turn >= 1600). When ON, upgrades score from turn >= 800
 * when the position is land-tight (no neutral expansion available) or gold-rich
 * (above the base gold-pressure floor), capped below the SAM tier, so "upgrade in
 * place" becomes visible exactly when sprawling has stopped working.
 */
export function upgradeVisibilityEnabled(): boolean {
  return tunedNumber("UPGRADE_VISIBILITY", 0) >= 1;
}

/**
 * FM-1 fix flag — "cash the midgame kill window." Reads the EXACT env var
 * `PROXYWAR_TUNE_ENFORCE_CONVERSION` (A/B arms set "0"/"1" on the same build).
 * Default ON (it is a competitiveness fix). When ON, the action ranking clamps
 * every neutral-land/neutral-boat expansion candidate strictly BELOW the
 * highest-scoring executor-ready frontier-conversion attack that is offered, so
 * a `expand:terra-nullius` (or neutral boat) can never be SELECTED over a
 * decisive favorable attack on a bordered rival. This turns the EXISTING soft
 * scorer penalty ("frontier conversion ready target should outrank neutral
 * growth") into a binding final-ranking guarantee. When OFF, the clamp is
 * skipped entirely and the ranked array — and therefore the selection — is
 * byte-for-byte identical to the shipped pre-fix behavior (the A/B champion
 * arm). It selects only among offered `LegalAction.id`s and adds no new
 * heuristic: it re-orders solely by the conversion-readiness signal the scorer
 * already computes.
 */
export function enforceConversionOverNeutralEnabled(): boolean {
  return tunedNumber("ENFORCE_CONVERSION", 1) >= 1;
}

/**
 * FM-2a fix flag — "behind-and-falling: trade or die." Reads the EXACT env var
 * `PROXYWAR_TUNE_BEHIND_AND_FALLING` (A/B arms set "0"/"1" on the same build).
 * Default ON (it is a competitiveness fix). It addresses the measured death
 * spiral where, once the agent is the weakest power, the "attacking a stronger
 * rival feeds them troops" safety gate blocks EVERY attack, so the agent holds
 * and banks troops offshore until it is overrun (in the lost-cell game it died
 * holding ~85k troops it never spent). When ON, and ONLY when the agent is
 * behind-and-falling (own tile share below a fair par share, a bordered rival's
 * share above ~1.5x the agent's, AND the agent's own tile count trending down
 * off its recent peak), the executor adds one pre-emption step that forces the
 * single highest-value executor-ready controlled strike that is offered — a
 * non-expansion attack / player boat / nuke on a bordered rival that still
 * carries a non-suicidal troop edge (the action's own risk level is not "high")
 * and is not a reserve-stripping over-commit — instead of holding. It also caps
 * offshore troop-banking in that same regime so banked troops are committed to an
 * attack rather than accumulated to death. When OFF (or when the agent is not
 * behind-and-falling, or no credible controlled strike is offered) BOTH the
 * strike pre-emption and the banking cap are skipped entirely, so the selected
 * action — and the ranked array — is byte-for-byte identical to the shipped
 * pre-fix behavior (the A/B champion arm). It selects only among offered
 * `LegalAction.id`s and emits no raw intent.
 */
export function behindAndFallingEscapeEnabled(): boolean {
  return tunedNumber("BEHIND_AND_FALLING", 1) >= 1;
}

/**
 * Diplomacy reserved menu slots (`PROXYWAR_TUNE_DIPLOMACY_SLOTS`, A/B arms set
 * "0"/"1"). DEFAULT OFF. The legal-action menu caps at 96 entries assembled
 * attacks-first; on crowded maps (10-12 players, many borders) the cap fills
 * before ANY diplomacy action is emitted, so exactly when politics decide games
 * the agent literally cannot choose "ally" — the option is never offered
 * (2026-07-11 audit, agent-code lane). When ON, LegalActionBuilder assembles
 * with headroom and applies a reserved-quota truncation: diplomacy kinds
 * (alliance_request/reject/extend, break_alliance, target_player, embargo_all,
 * donations) keep up to DIPLOMACY_RESERVED_SLOTS entries and the remaining
 * budget goes to the other kinds in their original order. Cap total unchanged.
 */
export function diplomacySlotsEnabled(): boolean {
  return tunedNumber("DIPLOMACY_SLOTS", 0) >= 1;
}

/** Reserved diplomacy entries under the cap (PROXYWAR_TUNE_DIPLOMACY_RESERVE, default 8). */
export function diplomacyReservedSlots(): number {
  return Math.max(1, Math.min(24, tunedNumber("DIPLOMACY_RESERVE", 8)));
}

/**
 * Dominance-conversion flag (keystone v6, league-loss analysis 2026-07-12). Reads the
 * EXACT env var `PROXYWAR_TUNE_DOMINANCE_CONVERSION` (A/B arms set "0"/"1"). DEFAULT
 * OFF — ships inert and is armed via the pod env after hosted A/B. Fixes the measured
 * Commander inertia (league R.189: 223 expand_territory orders vs 11 pressure_rival
 * while holding a winning share; hostile options offered every endgame decision): the
 * growth control gate fires whenever ANY neutral land remains, with no share cap, so a
 * dominant agent is told to keep expanding into neutral instead of eliminating rivals.
 * When ON, the planner brief derives a STRATEGIC_PICTURE line for every plan and, when
 * the agent's tile share exceeds DOMINANCE_RATIO x the strongest bordered rival's (and
 * the share floor, with home danger not high and an attackable bordered rival), emits a
 * strong-hint pressure_rival control + a DOMINANCE WINDOW prompt block asking for a
 * binding commitment. Prompt/controls only: no executor scoring, ranking, or safety
 * change, and no new action source — the Commander still owns the strategy call.
 */
export function dominanceConversionEnabled(): boolean {
  return tunedNumber("DOMINANCE_CONVERSION", 0) >= 1;
}

/**
 * Dominance ratio (`PROXYWAR_TUNE_DOMINANCE_RATIO`, default 1.3): own tile share must
 * be at least this multiple of the strongest bordered non-allied rival's share for the
 * dominance window to open. Clamped to >= 1 so the window can never open from behind.
 */
export function dominanceConversionRatio(): number {
  return Math.max(1, tunedNumber("DOMINANCE_RATIO", 1.3));
}

/**
 * Dominance share floor (`PROXYWAR_TUNE_DOMINANCE_SHARE_FLOOR`, default 0.12): minimum
 * own tile share before the dominance window can open, so early spawn-phase noise (a
 * 2% share "dominating" a 1% neighbor) never triggers conversion before a base exists.
 * Sits deliberately above the BASE_TILESHARE_FLOOR must-follow expansion gate (0.1).
 */
export function dominanceConversionShareFloor(): number {
  return Math.max(0, tunedNumber("DOMINANCE_SHARE_FLOOR", 0.12));
}

/**
 * Wire-primary argmax flag (keystone v7, 4-game forensics 2026-07-12). Reads the EXACT
 * env var `PROXYWAR_TUNE_PRIMARY_ARGMAX` (A/B arms set "0"/"1"). DEFAULT OFF. The
 * Frontier scheduler assembles multi-action batches whose PRIMARY is chosen by module
 * rotation, not score — correct for the local runtime (the whole batch executes) but
 * catastrophic on single-action wires (Coworld carries ONE selectedLegalActionId per
 * decision): measured 28/40 decisions in one hosted game shipped a score-9-16 neutral
 * expand while a score-100 defensive build / combat attack / mainland expand rode the
 * batch and was dropped. When ON, the batch is reordered so the highest-scored
 * promotable candidate (attack/boat/build/upgrade — never diplomacy, social, or nuke,
 * whose cross-module scores are not calibrated against these) becomes the primary,
 * and a deliberate combat primary is never displaced by a different combat action
 * (target choice is intentional). Batch CONTENT is unchanged — only the order.
 */
export function primaryArgmaxEnabled(): boolean {
  return tunedNumber("PRIMARY_ARGMAX", 0) >= 1;
}

/**
 * War-mode flag (keystone v7, 4-game forensics 2026-07-12). Reads the EXACT env var
 * `PROXYWAR_TUNE_WAR_MODE` (A/B arms set "0"/"1"). DEFAULT OFF. Fixes the measured
 * terminal passivity: invaded at near-parity (threat=1, urgency=high, tiles shrinking
 * for 1200 turns) the agent answered an 11-attack sustained invasion with one 10%
 * probe, because every attack gate demands a clear troop edge that a defender-
 * advantage endgame never shows. When ON, two regimes authorize a forced
 * counterstrike selected from OFFERED actions only: (a) under invasion — incoming
 * attacks present AND own tiles falling; (b) endgame duel — exactly one bordered
 * non-allied rival, at least our share, combined share >= WAR_DUEL_COMBINED_SHARE.
 * In these regimes the strike ratio floor drops to WAR_MIN_RATIO (default 0.8) and
 * the risk-level gate is replaced by that ratio floor plus the reserve-suicide
 * penalty check. Targets only the actual invader(s) or the duel leader.
 */
export function warModeEnabled(): boolean {
  return tunedNumber("WAR_MODE", 0) >= 1;
}

/** War-mode strike ratio floor (`PROXYWAR_TUNE_WAR_MIN_RATIO`, default 0.8, clamped 0.5-1.5). */
export function warModeMinStrikeRatio(): number {
  return Math.max(0.5, Math.min(1.5, tunedNumber("WAR_MIN_RATIO", 0.8)));
}

/** War-mode duel combined-share threshold (`PROXYWAR_TUNE_WAR_DUEL_COMBINED_SHARE`, default 0.6). */
export function warModeDuelCombinedShare(): number {
  return Math.max(0.3, Math.min(0.95, tunedNumber("WAR_DUEL_COMBINED_SHARE", 0.6)));
}

/**
 * Coalition flag (keystone v8, operator directive 2026-07-12: "gang up on the
 * leader"). Reads the EXACT env var `PROXYWAR_TUNE_COALITION` (A/B arms set
 * "0"/"1"). DEFAULT OFF. Anti-runaway-leader balance-of-power play: when one
 * rival's map share exceeds COALITION_LEADER_FLOOR and COALITION_LEADER_RATIO x
 * our own, the Commander prompt gains a COALITION MODE block (do not attack
 * non-leaders, accept their alliances, aim all pressure at the leader) and the
 * executor gains one leaf: force-accept an incoming alliance request from a
 * non-leader (acceptance = the counter alliance_request; core forms the
 * alliance on mutual request, PlayerImpl.canSendAllianceRequest returns true
 * exactly for this case). Arm together with WAR_MODE so the invaded case stays
 * covered above this leaf. (A besieged-ally donation leaf was designed and
 * removed pre-ship: no rival-under-siege signal exists in the observation yet.)
 * Measured basis: in every analyzed loss the agent co-farmed the minors —
 * feeding the leader both corpses — and ignored explicit coordinate-attack
 * proposals from the third seat.
 */
export function coalitionEnabled(): boolean {
  return tunedNumber("COALITION", 0) >= 1;
}

/** Coalition leader share floor (`PROXYWAR_TUNE_COALITION_LEADER_FLOOR`, default 0.18). */
export function coalitionLeaderShareFloor(): number {
  return Math.max(0.05, Math.min(0.6, tunedNumber("COALITION_LEADER_FLOOR", 0.18)));
}

/** Coalition leader ratio vs own share (`PROXYWAR_TUNE_COALITION_LEADER_RATIO`, default 1.15, clamped >= 1). */
export function coalitionLeaderRatio(): number {
  return Math.max(1, tunedNumber("COALITION_LEADER_RATIO", 1.15));
}

/**
 * Opening-tempo flag (keystone v8, tempo forensics 2026-07-12). Reads the EXACT
 * env var `PROXYWAR_TUNE_OPENING_TEMPO` (A/B arms set "0"/"1"). DEFAULT OFF.
 * Measured: the agent's per-decision expand yield EQUALS the league leader's,
 * but it spends only 7-9 of its first 17 decisions expanding (leader: 13-15) —
 * boats and builds eat the slots and the tile deficit at t2000 decides games.
 * When ON, during the opening window (turn <= 3000): the early neutral-island
 * boat rush is skipped while a mainland neutral expand is offered, and — only
 * with no incoming attacks — a multi-action batch whose primary is not an
 * attack gets its best neutral land expand promoted to the wire primary.
 * Survival/binding-directive singletons are structurally untouched (length-1
 * batches are never reordered).
 */
export function openingTempoEnabled(): boolean {
  return tunedNumber("OPENING_TEMPO", 0) >= 1;
}

/**
 * Opening-commitment flag (keystone v13, qd1n forensics 2026-07-13). Reads the
 * EXACT env var `PROXYWAR_TUNE_OPENING_COMMIT` (A/B arms "0"/"1"). DEFAULT OFF.
 * Measured: the league's new leader ramps neutral-expansion troop commitment
 * 10->20->35% by t700 and holds 35%; keystone pins 10% while sitting on a
 * near-cap idle stack (900k troops, troopRatio 0.67 at t600) and loses the
 * land race 5:1 by t2000 — every later failure is downstream of being the
 * smallest seat. When ON, the neutral-expansion commitment is FLOORED at
 * OPENING_COMMIT_RATIO (default 0.35) throughout the opening window; after
 * turn 3000 the floor applies only when own troopRatio >=
 * OPENING_COMMIT_TROOP_FLOOR (default 0.55). The separate default-off
 * OPENING_PHASE_LOCK flag owns the v17 hostile-opening experiment.
 */
export function openingCommitEnabled(): boolean {
  return tunedNumber("OPENING_COMMIT", 0) >= 1;
}

/**
 * Behind-tempo hostile-opening phase lock (keystone v17 candidate). Reads the
 * EXACT env var `PROXYWAR_TUNE_OPENING_PHASE_LOCK` (A/B arms "0"/"1").
 * DEFAULT OFF so the proven v16 opening-commit arm remains an isolated control.
 */
export function openingPhaseLockEnabled(): boolean {
  return tunedNumber("OPENING_PHASE_LOCK", 0) >= 1;
}

/** Floored expansion commitment when troops idle high (default 0.35, clamped 0.1-0.5). */
export function openingCommitRatio(): number {
  return Math.max(0.1, Math.min(0.5, tunedNumber("OPENING_COMMIT_RATIO", 0.35)));
}

/** Own troopRatio above which the commitment floor applies (default 0.55). */
export function openingCommitTroopFloor(): number {
  return Math.max(0.2, Math.min(0.95, tunedNumber("OPENING_COMMIT_TROOP_FLOOR", 0.55)));
}

/**
 * Naval-war flag (keystone v13, qd1n forensics 2026-07-13). Reads the EXACT env
 * var `PROXYWAR_TUNE_NAVAL_WAR` (A/B arms "0"/"1"). DEFAULT OFF. Measured (the
 * 15,600-turn freeze): with NO bordered rivals the planner brief said "no
 * executor-ready pressure target" forever, the seat banked 10.3M troops (100%
 * cap) + 67M gold, spent 105 consecutive primaries on no-op neutral expansions
 * (own tiles never changed), launched 3 boats all game, and watched the leader
 * walk to an 84.9% domination win. When ON: if no bordered non-allied rival
 * exists, at least one rival is alive, and own troopRatio >=
 * NAVAL_WAR_TROOP_FLOOR (default 0.7), the best offered PLAYER-targeting boat
 * becomes the forced primary (war goes to sea); and a neutral-expansion primary
 * whose recent picks changed nothing (own tiles flat) is suppressed in favor of
 * the best non-expansion candidate.
 */
export function navalWarEnabled(): boolean {
  return tunedNumber("NAVAL_WAR", 0) >= 1;
}

/** Own troopRatio above which the naval war trips (default 0.7). */
export function navalWarTroopFloor(): number {
  return Math.max(0.3, Math.min(0.95, tunedNumber("NAVAL_WAR_TROOP_FLOOR", 0.7)));
}

/**
 * Thin-executor flag (keystone v11, architectural experiment 2026-07-12). Reads
 * the EXACT env var `PROXYWAR_TUNE_THIN_EXECUTOR` (A/B arms set "0"/"1").
 * DEFAULT OFF. Five A/B cycles established mechanical parity with the league
 * leader while still losing every mid-game: his architecture executes the LLM
 * plan's named action+target with near-zero reinterpretation, ours re-derives
 * the decision through a deep heuristic cascade that plays the conversion
 * phase worse than the model does. When ON, a high-priority leaf executes the
 * CURRENT plan's named intent directly: a pressure plan with a targetPlayerId
 * selects the best offered qualifying attack on that target every cycle; a
 * growth plan selects the best offered mainland neutral expand. Survival
 * recoveries still pre-empt; binding directives (commitment / alliance /
 * build) behave as before; all other intents fall through to the cascade.
 * Selects only offered `LegalAction.id`s — this removes reinterpretation, it
 * adds no new action source.
 */
export function thinExecutorEnabled(): boolean {
  return tunedNumber("THIN_EXECUTOR", 0) >= 1;
}

/**
 * Attack-ladder flag (keystone v8). Reads the EXACT env var
 * `PROXYWAR_TUNE_ATTACK_LADDER` (A/B arms set "0"/"1"). DEFAULT OFF. The league
 * leader escalates per target — 10% probe, 25%, then 40% kill commits — while
 * keystone grinds a flat 25% that never cracks a defended core. When ON, the
 * war-mode counterstrike prefers the offered attack whose troop commitment is
 * closest to the ladder step for that target (0 prior consecutive attacks ->
 * ~10%, 1 -> ~25%, 2+ -> ~40%) instead of always the largest commitment.
 */
export function attackLadderEnabled(): boolean {
  return tunedNumber("ATTACK_LADDER", 0) >= 1;
}

/**
 * Economy-bootstrap minimum own tiles (`PROXYWAR_TUNE_ECONOMY_BOOTSTRAP_MIN_TILES`,
 * default 0 = shipped behavior). Opening-tempo forensics (2026-07-12): with the
 * bootstrap armed, the agent builds its first City at t400 with 52 tiles in every
 * game, donating a ~100-turn land-grab head start; the winning rival builds its first
 * City at ~20k tiles / t1100. When set, the whole bootstrap (banking + forced
 * structure) stays dormant until the agent owns at least this many tiles, so the
 * opening decision budget goes to territory first.
 */
export function economyBootstrapMinTiles(): number {
  return Math.max(0, tunedNumber("ECONOMY_BOOTSTRAP_MIN_TILES", 0));
}

/**
 * Economy observation flag (economy+negotiation V1 Phase A). Reads the EXACT
 * env var `PROXYWAR_TUNE_ECONOMY_OBSERVATION` (A/B arms set "0"/"1"). DEFAULT
 * OFF — ships inert and is measured on a paired eval-policy A/B arm before any
 * default flip. Fixes the verified observation gap (2026-08-07 economy audit):
 * the observation carries NO income-by-source, rail/trade-network, rival
 * structure-count, or rival-traitor facts at all, so agents cannot see idle
 * factories, embargo-blocked trade, or structural dependency on a counterparty,
 * and replay captions have no true economic sentences to say. When ON, the
 * observation gains the optional `economy` block (income by the six
 * GOLD_INDEX_* sources, rail clusters, factory classification, per-counterparty
 * structural dependency, one evidenced bottleneck), visible players gain
 * City/Factory/Port `unitCounts` + `isTraitor`, and the tactical affordances
 * gain the `economyNetwork` block. When OFF, observations and affordances are
 * byte-identical to shipped behavior.
 */
export function economyObservationEnabled(): boolean {
  return tunedNumber("ECONOMY_OBSERVATION", 0) >= 1;
}

/**
 * Structured-deals flag (economy+negotiation V1 Phase B). Reads the EXACT env
 * var `PROXYWAR_TUNE_STRUCTURED_DEALS` (A/B arms set "0"/"1"). DEFAULT OFF —
 * ships inert and is measured on a paired eval-policy A/B arm before any
 * default flip. Fixes the verified negotiation gap (2026-08-07 economy audit):
 * no deal, proposal, or commitment machinery exists anywhere, so agents cannot
 * make or break an explicit promise and spectator surfaces have no
 * proposal → pact → betrayal → verdict story beats to narrate. When ON, the
 * league runner owns a deterministic per-match deal ledger
 * (`AgentDealManager`): observations gain the bilateral `deals` block
 * (privacy-filtered to the two parties), the legal-action menu gains the four
 * `intent: null` meta-action kinds (deal_propose / deal_accept / deal_reject /
 * deal_withdraw), decision records gain dealAction/dealID/dealComplianceEvent
 * metadata stamps, and spectator telemetry derives bounded deal events with a
 * compliance referee's verdicts (`AgentDealCompliance`). Deals never alter any
 * game permission and emit no core intent — the referee narrates
 * follow-through, it never punishes. When OFF, observations, menus, decision
 * records, and telemetry are byte-identical to shipped behavior.
 *
 * `LegalActionBuilder`'s `postSpawnActions` treats this flag as an implicit
 * `PROXYWAR_TUNE_DIPLOMACY_SLOTS` ON: the deal kinds are in the reserved
 * diplomacy set, and a crowded 96-action menu on a 10-12 player map would
 * otherwise truncate in plain assembly order and silently drop the
 * late-emitted deal actions before an agent ever saw them — exactly where
 * deals matter most. No separate flag needs to be armed; DIPLOMACY_SLOTS
 * remains independently toggleable for menus that want reserved diplomacy
 * slots without structured deals.
 */
export function structuredDealsEnabled(): boolean {
  return tunedNumber("STRUCTURED_DEALS", 0) >= 1;
}

/**
 * Economy spectator-events flag (economy+negotiation V1 Phase A). Reads the
 * EXACT env var `PROXYWAR_TUNE_ECONOMY_EVENTS` (A/B arms set "0"/"1"). DEFAULT
 * OFF — ships inert. Fixes the verified spectator gap (2026-08-07 economy
 * audit): spectator telemetry has zero economy vocabulary, so premieres and the
 * Director Cut cannot narrate factories going idle, trade links forming or
 * being severed by embargo, or one seat's income depending on another seat's
 * ports. When ON, decision records stamp compact `economyFacts` derived from
 * the economy snapshot at decision boundaries, and spectator telemetry emits
 * bounded transition-only events (factory_operational, factory_idle,
 * trade_link_established, trade_severed, economy_dependency) with
 * server-authored publicText. When OFF, decision records and telemetry are
 * byte-identical to shipped behavior. Needs `PROXYWAR_TUNE_ECONOMY_OBSERVATION`
 * ON in the same process to have snapshot inputs to derive from.
 */
export function economyEventsEnabled(): boolean {
  return tunedNumber("ECONOMY_EVENTS", 0) >= 1;
}

/**
 * Free-text negotiation flag. Reads the EXACT env var
 * `PROXYWAR_TUNE_FREETEXT_MESSAGES`. DEFAULT OFF — ships inert.
 *
 * When ON, agents may write a short private message to one rival per decision
 * through the decision's comms slot, alongside (never instead of) their game
 * action. The text is simulation-inert cargo: it is delivered, rendered, and
 * logged, but nothing in `src/core` ever branches on its content, so the
 * simulation stays deterministic and replay hashes are unaffected by wording.
 *
 * Talk is free; only actions bind. A message never creates an obligation —
 * the structured-deal meta-actions remain the sole commitment path, and the
 * compliance referee still derives every verdict from selected
 * `LegalAction.id` values, never from prose.
 *
 * Menu cost is bounded on purpose. Hosted 16-seat evidence
 * (`docs/project-state/2026-08-15-freetext-negotiation-gates.md`) shows
 * assembly already reaches the last-emitted kinds, but `alliance_extend` is
 * genuinely starved at 2.45% of menus, so this flag must not add one action
 * per rival. `LegalActionBuilder` emits at most
 * `FREETEXT_MESSAGE_RECIPIENT_CAP` relevance-ranked recipients.
 *
 * When OFF, menus, observations, decision records, intents, and telemetry are
 * byte-identical to shipped behavior.
 */
export function freeTextMessagesEnabled(): boolean {
  return tunedNumber("FREETEXT_MESSAGES", 0) >= 1;
}

/**
 * Hard cap on message length, in characters, enforced by
 * `AgentDecisionValidator` before any text reaches an intent. Over-cap text is
 * REJECTED, never silently truncated: a trimmed promise is a different promise,
 * and evidence built on rewritten words would be false.
 */
export const FREETEXT_MESSAGE_MAX_CHARS = 280;

/**
 * Maximum message recipients offered per decision. Keeps the added menu cost
 * flat instead of scaling with lobby size (16 seats would otherwise add 15
 * actions and push the already-starved `alliance_extend` further out).
 */
export const FREETEXT_MESSAGE_RECIPIENT_CAP = 6;

/**
 * Maximum inbound messages surfaced in one observation, and the per-rival cap
 * within it. Bounds both prompt cost and the blast radius of an adversarial
 * counterparty spamming the channel.
 */
export const FREETEXT_INBOX_MAX_MESSAGES = 8;
export const FREETEXT_INBOX_MAX_PER_RIVAL = 3;
