/**
 * ============================================================================
 * DECISION INTEGRITY — how much of this match was actually the agents.
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * This is an AGENT tournament. The premise a viewer is being asked to accept
 * is that sixteen policies are thinking, and the single number that tells them
 * whether that premise held is how many decisions came back from the agents
 * versus how many fell back to a default. On the reference fixture that is
 * 1,262 decisions with 583 fallbacks (46%) and 525 degraded (42%) — nearly
 * half the match, and until now invisible on every surface of the broadcast.
 *
 * A metrics audit called this the most consequential fact about a match's
 * credibility, and it is right: a viewer who does not know it may be watching
 * a fallback policy paint a map and believing they are watching agents duel.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * The replay envelope's own `results` block, which the run itself wrote. Note
 * that `inlineRunArtifacts["match-summary.json"]` carries a SECOND, slightly
 * different set (camelCase, fallbackCount 560 against results' 583 on the same
 * fixture). They disagree, so this reads exactly one of them — the envelope's
 * `results`, the authoritative run result — rather than silently preferring
 * whichever is present and reporting two different numbers on two surfaces.
 * If that discrepancy matters upstream it is worth their attention; a
 * broadcast's job is to pick one source and say which.
 *
 * Everything is optional. An older or trimmed envelope simply has no integrity
 * figures, and the surfaces that read this render nothing at all rather than
 * a row of zeroes — a fabricated 0% fallback would be a far worse lie than
 * saying nothing.
 */

export interface ReplayIntegrity {
  /** Total decisions the run asked the agents for. */
  decisions: number;
  /** Decisions the runner accepted. */
  accepted: number;
  /** Decisions that fell back to a default policy. */
  fallback: number;
  /** Decisions accepted but degraded in some way. */
  degraded: number;
}

let integrity: ReplayIntegrity | null = null;
let version = 0;

/** Bumped whenever the figures change, so consumers can diff cheaply. */
export function replayIntegrityVersion(): number {
  return version;
}

export function replayIntegrity(): ReplayIntegrity | null {
  return integrity;
}

/**
 * Reads the envelope's `results` block defensively — it arrives as `unknown`
 * from a `.passthrough()` schema, so every field is shape-checked here rather
 * than trusted. A block that carries no decision count at all is treated as
 * "no integrity data", not as zero.
 */
export function publishReplayIntegrity(rawResults: unknown): void {
  const next = parseIntegrity(rawResults);
  const changed =
    (next === null) !== (integrity === null) ||
    (next !== null &&
      integrity !== null &&
      (next.decisions !== integrity.decisions ||
        next.accepted !== integrity.accepted ||
        next.fallback !== integrity.fallback ||
        next.degraded !== integrity.degraded));
  integrity = next;
  if (changed) version += 1;
}

export function clearReplayIntegrity(): void {
  if (integrity === null) return;
  integrity = null;
  version += 1;
}

function parseIntegrity(raw: unknown): ReplayIntegrity | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const num = (key: string): number | null => {
    const v = r[key];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  };
  const decisions = num("decision_count");
  // No decision count means no story to tell. Everything else is optional and
  // degrades to zero ONLY once we know the denominator is real.
  if (decisions === null || decisions <= 0) return null;
  return {
    decisions,
    accepted: num("accepted_decision_count") ?? decisions,
    fallback: num("fallback_count") ?? 0,
    degraded: num("degraded_count") ?? 0,
  };
}

/**
 * The one-line broadcast form. Percentages are of the total, rounded to whole
 * points because a tenth of a percent on 1,262 decisions is noise a viewer
 * cannot act on — and every figure carries its denominator, per the house rule
 * against bare numbers.
 */
export function formatReplayIntegrity(v: ReplayIntegrity): string {
  const pct = (n: number) => Math.round((n / v.decisions) * 100);
  const parts = [`${v.decisions.toLocaleString()} DECISIONS`];
  if (v.fallback > 0) {
    parts.push(`${v.fallback.toLocaleString()} FALLBACK (${pct(v.fallback)}%)`);
  }
  if (v.degraded > 0) {
    parts.push(`${v.degraded.toLocaleString()} DEGRADED (${pct(v.degraded)}%)`);
  }
  return parts.join("  ·  ");
}
