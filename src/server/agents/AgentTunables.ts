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
