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
