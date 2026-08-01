import fs from "fs/promises";
import path from "path";
import {
  FINAL_CONFLICT_TURN_CAP,
  FINAL_CONFLICT_TURN_FRACTION,
} from "./DirectorCutPlan";
import {
  computeLeadChanges,
  computeMajorReversals,
  ordinalLabel,
} from "./AgentMatchStateDerivations";
import type { MatchStateSeries } from "./AgentMatchStateSeries";
import type { SpectatorEvent, SpectatorTelemetry } from "./AgentSpectatorTelemetry";

/**
 * Event-derived match recap: the public match page's "what actually
 * happened" section. Deliberately NOT `AgentMatchStory`'s diagnostic prose
 * (entertainment score, boringness warnings, profile-differentiation
 * gate) — that generator's `summary`/`spectatorHighlights` are QA
 * telemetry for match-design tuning, not a battle story (a 2026-08-01
 * review confirmed shipping it as "the recap" gave production pages
 * generic diagnostics: "N story-worthy decisions... grade X/100" and
 * aggregate action counts, never a fact about who did what to whom).
 *
 * Instead this reuses the EXACT curated-event vocabulary the client's
 * "War Room" feed already surfaces (`curatedWarRoomEvents` in
 * `AiLeagueReplayOverlay.ts`, `pushWarRoomEvent` in
 * `ReplayPremiereRuntime.ts`) — alliance formation, first strike (first
 * attack per ordered actor/target pair only, never every attack),
 * betrayal (an active alliance break), and elimination — plus one
 * addition only meaningful post-hoc (a live/streaming overlay can't see
 * ahead): a "final confrontation" beat when the endgame window contains a
 * genuine attack/nuke event, using the SAME endgame window
 * `DirectorCutPlan.ts`'s own `final_conflict` segment uses
 * (`FINAL_CONFLICT_TURN_FRACTION`/`FINAL_CONFLICT_TURN_CAP`, imported, not
 * duplicated). Season Zero Phase 2 gap closure: `lead_change`/`reversal`
 * beats ARE now produced, but ONLY when the caller passes a real
 * `MatchStateSeries` (`AgentMatchStateSeries.ts`) — the sampled
 * territory/rank series that used to be genuinely unavailable from
 * decision-record telemetry alone (see that module's own "source
 * decision" doc). A recap built without a series (`series: null`) simply
 * omits both beat kinds, exactly as before this fix — never a fabricated
 * moment. Every beat message is either the `SpectatorEvent.message` the
 * telemetry builder already generated (a factual, already-vetted sentence
 * — see `AgentSpectatorTelemetry.ts`'s `eventForRecord`), a small factual
 * template built only from `actorName`/`targetName`/real counts/turn
 * numbers, or (for `lead_change`/`reversal`) a template built only from
 * `AgentMatchStateDerivations.ts`'s own computed usernames/shares/ranks —
 * never an inferred or embellished claim.
 *
 * 2026-08-01 live-verification fix: a real production match repeatedly
 * re-requested an alliance between the SAME pair (no intervening break)
 * roughly a dozen times, and separately first-struck 61 distinct ordered
 * pairs — both individually factual, but 113 raw beats is an event log,
 * not a digest, and every dramatic match will do this. Two changes:
 * (1) same-UNORDERED-pair alliance formations aggregate into ONE beat
 * anchored at the FIRST formation, carrying a "renewed N times" count;
 * an active alliance's betrayal (`alliance_break`, tone `betrayal`) both
 * closes that aggregation run AND is kept as its own individual beat
 * (betrayals are the drama, never merged away) and RESETS the run, so a
 * later re-formation starts a fresh aggregated beat. First strikes are
 * already deduped one-per-ordered-pair (unchanged — that was already
 * correct, matching the client's own dedupe rule) so no further
 * aggregation applies there. (2) `MAX_PUBLIC_RECAP_BEATS` caps the final
 * public beat list, trimming lowest-priority categories first (see
 * `applyImportanceCap`'s doc) while the `summary` line keeps reporting
 * the FULL raw counts (every alliance formation, not just aggregated
 * beats) so nothing is hidden — a reader can always see "this match had
 * 37 alliance formations" even though only a handful of alliance beats
 * made the cut.
 *
 * 2026-08-01 "best battles" ranking fix: this module also now computes
 * `curatedDramaScore` (see `computeCuratedDramaScore`'s doc) from the SAME
 * deduped beats above, and that — not `AgentDramaReport.dramaScore` — is
 * what the public lobby/`/watch`/`feature:candidates` ranking surfaces
 * rank and badge on. `AgentDramaReport.ts`'s generator and its own
 * `dramaScore` are untouched; this is a parallel, curated score for
 * public consumption only.
 *
 * `buildAgentMatchRecap` returns `null` when the curated pass finds zero
 * beats — a genuinely quiet match, never padded with a placeholder
 * sentence (same "never a fabricated placeholder" rule
 * `LeagueEpisodeMatchPage.ts`'s `LeagueEpisodeRecap` doc already states).
 */

export interface AgentMatchRecapBeat {
  turnNumber: number;
  kind:
    | "alliance"
    | "first_strike"
    | "betrayal"
    | "elimination"
    | "final_confrontation"
    | "lead_change"
    | "reversal";
  message: string;
}

/**
 * Bumped 1 -> 2 for the alliance-aggregation + importance cap fix, then
 * 2 -> 3 for the addition of `curatedDramaScore`/`curatedDramaScoreMethodology`
 * (see `computeCuratedDramaScore`'s doc) — the PUBLIC "best battles" ranking
 * input, replacing `AgentDramaReport.dramaScore` for that purpose on public
 * surfaces, then 3 -> 4 for Season Zero Phase 2's `lead_change`/`reversal`
 * beats (see the module doc) — a pre-fix `match-recap.json` never carries
 * either kind even when a series is now available, so it must be
 * re-curated, not merely left as "old but still fine". Then 4 -> 5 for a
 * real-production-data quality pass: (1) simultaneous match-end
 * eliminations (every telemetry `elimination` event is stamped at the
 * match's actual final turn — see `AgentSpectatorTelemetry.ts`'s
 * `addEliminationEvents`) now compress into ONE "N agents eliminated as
 * the match ends" beat instead of one beat per eliminated agent (a real
 * production match showed 8 individual "X is eliminated" beats all at
 * the same final turn — a match ending, not eight separate narrative
 * beats); a genuinely earlier elimination — `turnNumber < totalTurns` —
 * always stays individual, never swept into the terminal group. (2)
 * repeat betrayals of the SAME pair (a real production match showed the
 * same two agents break their alliance three times) now aggregate after
 * the first — see `curateWarRoomBeats`'s doc. Every bump means exactly
 * that: `CoworldLeagueMatchNarrativeBackfill.ts`'s `recapNeedsRegeneration`
 * compares against this constant to force re-curation, and
 * `LeagueEpisodeMatchPage.ts`'s `parseMatchRecapArtifact` refuses to parse
 * anything but the current version (a stale artifact reads as "no recap
 * yet", never as spammy/scoreless content, until the backfill upgrades it).
 */
export const AGENT_MATCH_RECAP_SCHEMA_VERSION = 5;

export interface AgentMatchRecap {
  schemaVersion: typeof AGENT_MATCH_RECAP_SCHEMA_VERSION;
  runID: string;
  generatedAt: string;
  summary: string;
  beats: AgentMatchRecapBeat[];
  /** 0..100 — see `computeCuratedDramaScore`'s doc. The PUBLIC drama ranking/badge input; `AgentDramaReport.dramaScore` stays the untouched legacy metric, unaffected by this field. */
  curatedDramaScore: number;
  /** Human-readable formula string carried alongside the score — same "ship the formula as free text" convention `AgentStatsPipeline.ts`'s `AgentMetric.methodology` uses for its own metrics. */
  curatedDramaScoreMethodology: string;
}

export interface AgentMatchRecapPaths {
  jsonPath: string;
}

export interface AgentMatchRecapInput {
  runID: string;
  telemetry: SpectatorTelemetry;
  /** Authoritative turn count when known (`match-summary.json`'s `finalState.turnCount`), else `null` to fall back to the telemetry's own max event turn — same fallback `DirectorCutPlan.ts`'s `resolveTotalTurns` uses. */
  finalTurnCount: number | null;
  /** `null` when no `match-state-series.json` was available for this run yet (e.g. before the mirror's series backfill reached it, or the source replay had zero snapshots) — `lead_change`/`reversal` beats are simply omitted, never fabricated. See `AgentMatchStateSeries.ts`. */
  series: MatchStateSeries | null;
}

/** Public beat cap — see the module doc's live-verification fix. Priority order when trimming is `applyImportanceCap`'s job; this is just the ceiling. */
export const MAX_PUBLIC_RECAP_BEATS = 16;

const BEAT_KIND_LABEL: Record<AgentMatchRecapBeat["kind"], string> = {
  alliance: "alliance",
  first_strike: "first strike",
  betrayal: "betrayal",
  elimination: "elimination",
  final_confrontation: "final clash",
  lead_change: "lead change",
  reversal: "reversal",
};

/** Lower sorts first when trimming — betrayals/eliminations/final-clash are never trimmed by the cap (see `applyImportanceCap`); this only orders the categories that DO get trimmed. `lead_change`/`reversal` sort ahead of `alliance`/`first_strike`: they are derived from the sampled match-state series (typically far rarer per match than alliance/first-strike events — a confirmed, margin-cleared overtake is uncommon), so when the cap DOES bite, this new decisive-derivation content is kept before the higher-volume War Room categories. */
const TRIMMABLE_KIND_PRIORITY: Record<
  "alliance" | "first_strike" | "lead_change" | "reversal",
  number
> = {
  lead_change: 0,
  reversal: 1,
  alliance: 2,
  first_strike: 3,
};

interface AllianceRun {
  anchorTurn: number;
  lastTurn: number;
  count: number;
  actorName: string;
  targetName: string;
}

function unorderedPairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

function allianceBeatFromRun(run: AllianceRun): AgentMatchRecapBeat {
  const renewals = run.count - 1;
  const message =
    renewals === 0
      ? `${run.actorName} and ${run.targetName} form an alliance.`
      : `${run.actorName} and ${run.targetName} form an alliance (renewed ${renewals} time${
          renewals === 1 ? "" : "s"
        } through turn ${run.lastTurn}).`;
  return { turnNumber: run.anchorTurn, kind: "alliance", message };
}

/**
 * Repeat betrayals of the SAME unordered pair, tracked ACROSS the whole
 * match (independent of intervening re-formations) — a real production
 * match showed the same two agents break their alliance three times,
 * each getting its own never-trimmed beat and eating three of the
 * 16-beat public cap's slots for what is really one relationship's
 * pattern. The FIRST betrayal for a pair always stays its own individual
 * beat, unchanged (`betrayalBeats.push` directly in the loop below) —
 * "betrayals are the drama, never merged away" still holds for the beat
 * that actually broke a real alliance for the first time. The SECOND and
 * every later betrayal of that same pair aggregate into ONE run, flushed
 * as a single beat after the loop — see `betrayalRunBeat`.
 */
interface BetrayalRun {
  anchorTurn: number;
  lastTurn: number;
  /** Repeat betrayals folded into this run — the pair's TOTAL betrayal count is this plus the always-individual first one. */
  repeatCount: number;
  /** 1-based ordinal (across the whole match) of the LAST betrayal folded into this run — e.g. `3` for "the 3rd time". */
  lastOrdinal: number;
  actorName: string;
  targetName: string;
}

function betrayalRunBeat(run: BetrayalRun): AgentMatchRecapBeat {
  const message =
    run.repeatCount === 1
      ? `${run.actorName} and ${run.targetName} break their alliance again — the ${ordinalLabel(run.lastOrdinal)} time.`
      : `${run.actorName} and ${run.targetName} break their alliance again (${run.repeatCount} more times through turn ${run.lastTurn}, most recently the ${ordinalLabel(run.lastOrdinal)} time).`;
  return { turnNumber: run.anchorTurn, kind: "betrayal", message };
}

export interface CuratedWarRoomBeats {
  /** Aggregated per-pair alliance beats — see the module doc. */
  allianceBeats: AgentMatchRecapBeat[];
  /** One per ordered actor/target pair's first attack — already deduped, unchanged by the 2026-08-01 fix. */
  firstStrikeBeats: AgentMatchRecapBeat[];
  /** The FIRST betrayal per pair individually, plus at most one aggregated "breaks their alliance again" beat per pair covering every later betrayal of that same pair — see `BetrayalRun`'s doc. Every entry here is still never dropped by the cap. */
  betrayalBeats: AgentMatchRecapBeat[];
  /** Every elimination individually — never dropped by the cap. Simultaneous match-end eliminations are compressed separately, in `buildAgentMatchRecap` (needs `totalTurns`, not available at this layer) — see `compressTerminalEliminations`. */
  eliminationBeats: AgentMatchRecapBeat[];
  /** Raw per-category counts for the summary line — BEFORE aggregation/capping, so the summary always reports the full picture even when the beat list is trimmed. */
  rawCounts: { alliance: number; betrayal: number; firstStrike: number; elimination: number };
  /** Every source `SpectatorEvent.id` this pass consumed, so `finalConfrontationBeat` never double-reports an attack already covered as a first strike. */
  includedEventIds: Set<string>;
}

/**
 * Curates the War Room vocabulary (alliance/first-strike/betrayal/
 * elimination) from an ordered event stream — same kind-mapping
 * `curatedWarRoomEvents` (client) applies, ported server-side, PLUS the
 * 2026-08-01 same-pair alliance aggregation (see module doc): repeated
 * formations between the same unordered pair collapse into one beat
 * anchored at the first formation; a betrayal both stays a beat AND
 * resets the pair's alliance-formation aggregation run. PLUS the repeat-
 * betrayal aggregation (see `BetrayalRun`'s doc): the first betrayal of
 * a pair is always its own beat; every later betrayal of that SAME pair
 * folds into one aggregated beat instead of one beat each.
 */
function curateWarRoomBeats(events: readonly SpectatorEvent[]): CuratedWarRoomBeats {
  const firstStrikeBeats: AgentMatchRecapBeat[] = [];
  const betrayalBeats: AgentMatchRecapBeat[] = [];
  const eliminationBeats: AgentMatchRecapBeat[] = [];
  const finalizedAllianceBeats: AgentMatchRecapBeat[] = [];
  const openAllianceRuns = new Map<string, AllianceRun>();
  const betrayalOrdinalByPair = new Map<string, number>();
  const openBetrayalRuns = new Map<string, BetrayalRun>();
  const includedEventIds = new Set<string>();
  const firstStrikeSeen = new Set<string>();
  const rawCounts = { alliance: 0, betrayal: 0, firstStrike: 0, elimination: 0 };

  for (const event of events) {
    if (event.kind === "attack" && event.targetAgentID !== null) {
      const key = `${event.actorAgentID}|${event.targetAgentID}`;
      if (!firstStrikeSeen.has(key)) {
        firstStrikeSeen.add(key);
        includedEventIds.add(event.id);
        rawCounts.firstStrike += 1;
        firstStrikeBeats.push({
          turnNumber: event.turnNumber,
          kind: "first_strike",
          message: `${event.actorName} strikes first against ${event.targetName}.`,
        });
      }
      continue;
    }
    if (event.kind === "alliance_formed" && event.targetAgentID !== null) {
      includedEventIds.add(event.id);
      rawCounts.alliance += 1;
      const key = unorderedPairKey(event.actorAgentID, event.targetAgentID);
      const existingRun = openAllianceRuns.get(key);
      if (existingRun === undefined) {
        openAllianceRuns.set(key, {
          anchorTurn: event.turnNumber,
          lastTurn: event.turnNumber,
          count: 1,
          actorName: event.actorName,
          targetName: event.targetName ?? event.targetAgentID,
        });
      } else {
        existingRun.count += 1;
        existingRun.lastTurn = event.turnNumber;
      }
      continue;
    }
    if (
      event.kind === "alliance_break" &&
      event.tone === "betrayal" &&
      event.targetAgentID !== null
    ) {
      includedEventIds.add(event.id);
      rawCounts.betrayal += 1;
      const key = unorderedPairKey(event.actorAgentID, event.targetAgentID);
      const ordinal = (betrayalOrdinalByPair.get(key) ?? 0) + 1;
      betrayalOrdinalByPair.set(key, ordinal);
      if (ordinal === 1) {
        betrayalBeats.push({
          turnNumber: event.turnNumber,
          kind: "betrayal",
          message: event.message,
        });
      } else {
        const targetName = event.targetName ?? event.targetAgentID;
        const openBetrayalRun = openBetrayalRuns.get(key);
        if (openBetrayalRun === undefined) {
          openBetrayalRuns.set(key, {
            anchorTurn: event.turnNumber,
            lastTurn: event.turnNumber,
            repeatCount: 1,
            lastOrdinal: ordinal,
            actorName: event.actorName,
            targetName,
          });
        } else {
          openBetrayalRun.repeatCount += 1;
          openBetrayalRun.lastTurn = event.turnNumber;
          openBetrayalRun.lastOrdinal = ordinal;
        }
      }
      const openAllianceRun = openAllianceRuns.get(key);
      if (openAllianceRun !== undefined) {
        finalizedAllianceBeats.push(allianceBeatFromRun(openAllianceRun));
        openAllianceRuns.delete(key);
      }
      continue;
    }
    if (event.kind === "elimination") {
      includedEventIds.add(event.id);
      rawCounts.elimination += 1;
      eliminationBeats.push({
        turnNumber: event.turnNumber,
        kind: "elimination",
        message: event.message,
      });
    }
  }
  // Flush every alliance run still open at match end (formed, never broken).
  for (const run of openAllianceRuns.values()) {
    finalizedAllianceBeats.push(allianceBeatFromRun(run));
  }
  // Flush every pair's repeat-betrayal run — the first betrayal of each
  // pair was already pushed inline above; this is only the aggregated
  // "again" beat for pairs that betrayed more than once.
  for (const run of openBetrayalRuns.values()) {
    betrayalBeats.push(betrayalRunBeat(run));
  }
  return {
    allianceBeats: finalizedAllianceBeats,
    firstStrikeBeats,
    betrayalBeats,
    eliminationBeats,
    rawCounts,
    includedEventIds,
  };
}

/**
 * Curated (dedupe-based) drama score for the PUBLIC ranking surface (lobby
 * "best recent"/"high drama" badge, `/watch` "Most dramatic" sort,
 * `feature:candidates`) — this is what those surfaces rank/badge on
 * instead of `AgentDramaReport.dramaScore`, because that generator's
 * `allianceFormedCount` is a RAW, un-deduped event count that saturates
 * the 100 ceiling on same-pair alliance re-request churn alone (see
 * `AgentDramaReport.ts`'s own 2026-08-01 doc — a real production match
 * hit 37 reformations between one pair and capped out on
 * `allianceFormedCount * 8` almost by itself). `AgentDramaReport.ts` and
 * its `dramaScore` stay exactly as-is — that generator's own artifact,
 * and any consumer that still legitimately wants the raw count, keeps
 * reading it there unchanged. This is a SEPARATE score computed from the
 * SAME dedupe pass `curateWarRoomBeats` already runs to build the public
 * recap beats, so it is only ever as inflated as what a reader actually
 * SEES in the recap.
 *
 * Weights mirror `AgentDramaReport.dramaScore`'s recognizable per-unit
 * order (betrayals heaviest, then eliminations, then alliances, first
 * strikes lightest) but every input here is a DISTINCT, already-deduped
 * count, AND every category is capped BEFORE weighting — calibrated
 *2026-08-01 against a live sample of real 12-player league matches after
 * the uncapped version was caught saturating ~100% of them at the 100
 * ceiling (not just the churn-affected ones): in this game's standard
 * free-for-all format, first-strike-pair counts (30-60+, one nearly every
 * player fights someone by match end) and elimination counts (5-10 of 11
 * possible losers) are close to a STRUCTURAL CONSTANT of any match played
 * to completion, not a drama signal — an uncapped weight on either
 * mechanically saturates almost every real match regardless of how
 * politically eventful it was, which is the exact universal-100 failure
 * this fix exists to avoid. Capping each category turns "eliminations"
 * and "first strikes" into a small, near-constant baseline (as legacy's
 * own `min(communicationCount, 20) * 0.5` treats communication events)
 * while `betrayals`/`alliances` — genuinely rare and variable in the
 * sampled data (0-6 per match) — stay the real discriminators:
 *
 *   - betrayals: every individual betrayal beat, never aggregated away
 *     (`curated.betrayalBeats.length`, capped at 4) x 20 — the single
 *     most decisive "this actually happened" political signal. Repeat
 *     betrayals of the SAME pair still count only once here beyond the
 *     first (`curateWarRoomBeats`'s aggregation collapses them into one
 *     beat before this even runs), same anti-churn logic as alliances.
 *   - eliminations: `nonTerminalEliminationCount` — ONLY eliminations
 *     that happened before the match's actual final turn, capped at 4,
 *     x 10. Eliminations AT the final turn are compressed into one
 *     summary beat by `compressTerminalEliminations` and deliberately
 *     excluded from this score entirely (weight 0): a match ending —
 *     even a mass one, e.g. 8 agents simultaneously falling on the last
 *     turn — is the ordinary, structural way EVERY free-for-all ends,
 *     not a drama signal; only a death that happened mid-match, while
 *     the outcome was still undecided, is evidence of real conflict.
 *   - alliances: DISTINCT unordered pairs, one beat per pair no matter how
 *     many times they re-request (`curated.allianceBeats.length` — the
 *     exact aggregation `curateWarRoomBeats` already performs for the
 *     recap itself), capped at 4, x 8 — the direct fix for the
 *     churn-saturation bug: 37 re-formations between one pair score the
 *     SAME as 1.
 *   - first strikes: DISTINCT ordered actor/target pairs, already deduped
 *     one-per-pair at capture time (`curated.firstStrikeBeats.length`),
 *     capped at 10, x 1 — a minor garnish signal only.
 *   - final confrontation: +8 flat when the endgame window produced a
 *     genuine attack/nuke beat (0/1, never a count).
 *
 * Summed, then capped to [0, 100]. Pure and deterministic — same curated
 * beats in, same score out, every time (see the "determinism" test).
 * `curatedDramaScoreMethodology` ships this same formula as free text
 * (same convention `AgentStatsPipeline.ts`'s `AgentMetric.methodology`
 * uses) so the field stays self-documenting wherever the recap JSON
 * travels, independent of this source comment.
 */
const CURATED_DRAMA_WEIGHTS = {
  betrayal: 20,
  betrayalCap: 4,
  elimination: 10,
  eliminationCap: 4,
  alliancePair: 8,
  alliancePairCap: 4,
  firstStrikePair: 1,
  firstStrikePairCap: 10,
  finalConfrontation: 8,
} as const;

export const CURATED_DRAMA_SCORE_METHODOLOGY =
  `min(betrayal beats, ${CURATED_DRAMA_WEIGHTS.betrayalCap}) x${CURATED_DRAMA_WEIGHTS.betrayal} + ` +
  `min(non-terminal elimination beats, ${CURATED_DRAMA_WEIGHTS.eliminationCap}) x${CURATED_DRAMA_WEIGHTS.elimination} (eliminations at the match's own final turn are compressed into one summary beat and never scored — a normal match end is not a drama signal) + ` +
  `min(distinct alliance pairs, ${CURATED_DRAMA_WEIGHTS.alliancePairCap}) x${CURATED_DRAMA_WEIGHTS.alliancePair} (same-pair re-formations aggregate into one pair, never scored per re-request) + ` +
  `min(distinct first-strike pairs, ${CURATED_DRAMA_WEIGHTS.firstStrikePairCap}) x${CURATED_DRAMA_WEIGHTS.firstStrikePair} + ${CURATED_DRAMA_WEIGHTS.finalConfrontation} if the match ended on a genuine final clash beat; ` +
  `summed and capped to [0, 100] — computed from the same deduped War Room beats this recap shows, never from raw un-deduped event counts, with each category capped before weighting so a structurally-large-but-ordinary count (e.g. first strikes/eliminations in a completed free-for-all) cannot alone saturate the score`;

function computeCuratedDramaScore(
  curated: CuratedWarRoomBeats,
  hasFinalConfrontation: boolean,
  nonTerminalEliminationCount: number,
): number {
  const raw =
    Math.min(curated.betrayalBeats.length, CURATED_DRAMA_WEIGHTS.betrayalCap) *
      CURATED_DRAMA_WEIGHTS.betrayal +
    Math.min(nonTerminalEliminationCount, CURATED_DRAMA_WEIGHTS.eliminationCap) *
      CURATED_DRAMA_WEIGHTS.elimination +
    Math.min(curated.allianceBeats.length, CURATED_DRAMA_WEIGHTS.alliancePairCap) *
      CURATED_DRAMA_WEIGHTS.alliancePair +
    Math.min(curated.firstStrikeBeats.length, CURATED_DRAMA_WEIGHTS.firstStrikePairCap) *
      CURATED_DRAMA_WEIGHTS.firstStrikePair +
    (hasFinalConfrontation ? CURATED_DRAMA_WEIGHTS.finalConfrontation : 0);
  return Math.min(100, Math.round(raw));
}

/** One beat for the highest-importance attack/nuke event inside the SAME endgame window `DirectorCutPlan.ts`'s `final_conflict` segment covers — omitted (never fabricated) when no such event exists in that window, e.g. a match that ends on a turn cap with no late fighting. */
function finalConfrontationBeat(
  events: readonly SpectatorEvent[],
  totalTurns: number,
  alreadyIncluded: ReadonlySet<string>,
): AgentMatchRecapBeat | null {
  if (totalTurns <= 0) return null;
  const windowStart = Math.max(
    0,
    totalTurns -
      Math.min(
        totalTurns,
        Math.max(1, Math.round(totalTurns * FINAL_CONFLICT_TURN_FRACTION)),
        FINAL_CONFLICT_TURN_CAP,
      ),
  );
  const candidates = events.filter(
    (event) =>
      event.turnNumber >= windowStart &&
      event.targetAgentID !== null &&
      (event.kind === "attack" || event.kind === "nuke") &&
      !alreadyIncluded.has(event.id),
  );
  if (candidates.length === 0) return null;
  const top = candidates.reduce((best, event) =>
    event.importance > best.importance ? event : best,
  );
  return {
    turnNumber: top.turnNumber,
    kind: "final_confrontation",
    message: `Final clash: ${top.message}`,
  };
}

export interface CompressedEliminations {
  beats: AgentMatchRecapBeat[];
  /** Eliminations that happened strictly before the match's resolved final turn — the ONLY count `computeCuratedDramaScore` weighs (see its own doc for why terminal eliminations are excluded entirely). */
  nonTerminalCount: number;
}

/**
 * Compresses simultaneous MATCH-END eliminations into one summary beat.
 * `AgentSpectatorTelemetry.ts`'s `addEliminationEvents` stamps EVERY
 * eliminated agent's synthetic elimination event at the match's actual
 * final turn, regardless of when that agent really died (the ONLY
 * genuinely turn-accurate elimination-timing signal this pipeline has is
 * the sampled match-state series — see `AgentMatchStateDerivations.ts`'s
 * `computeEliminationTimings` doc) — so today, every elimination beat
 * this recap sees already carries `turnNumber === totalTurns`. A real
 * production match showed 8 individual "X is eliminated." beats, all at
 * the same final turn: that is the match ENDING, not eight separate
 * narrative beats, and was eating 8 of the 16-beat public cap's
 * never-trimmed slots for one fact.
 *
 * Groups elimination beats by whether `turnNumber >= totalTurns` (never
 * `>` — a beat is never generated past the resolved total turn count, so
 * `>=` is exactly "at the final turn"). Two or more in that terminal
 * group compress into one factual "N agents eliminated as the match
 * ends" beat, anchored at `totalTurns`. A SINGLE terminal elimination
 * (a lone survivor's final kill) is left as its own individual beat —
 * compression only buys anything when there is real redundancy to
 * reduce. Any elimination beat with `turnNumber < totalTurns` — honestly
 * supported the moment this pipeline's timing signal improves — always
 * stays individual: it is a genuinely mid-match death, real narrative
 * evidence the outcome was still contested, never swept into the
 * end-of-match summary.
 */
export function compressTerminalEliminations(
  eliminationBeats: readonly AgentMatchRecapBeat[],
  totalTurns: number,
): CompressedEliminations {
  const terminal = eliminationBeats.filter((beat) => beat.turnNumber >= totalTurns);
  const midMatch = eliminationBeats.filter((beat) => beat.turnNumber < totalTurns);
  if (terminal.length < 2) {
    return { beats: eliminationBeats.slice(), nonTerminalCount: midMatch.length };
  }
  const compressed: AgentMatchRecapBeat = {
    turnNumber: totalTurns,
    kind: "elimination",
    message: `Final turn: ${terminal.length} agents eliminated as the match ends.`,
  };
  return { beats: [...midMatch, compressed], nonTerminalCount: midMatch.length };
}

/**
 * `lead_change`/`reversal` beats — the Season Zero Phase 2 gap closure.
 * `null` series (no `match-state-series.json` yet, or its source replay had
 * zero snapshots) yields an empty array for both, never a fabricated one.
 * Thresholds/methodology live in `AgentMatchStateDerivations.ts`, reused
 * here verbatim rather than re-implemented.
 */
function leadChangeBeats(series: MatchStateSeries | null): AgentMatchRecapBeat[] {
  if (series === null) return [];
  return computeLeadChanges(series).map((change) => ({
    turnNumber: change.turn,
    kind: "lead_change",
    message: `${change.toUsername} overtakes ${change.fromUsername} for the territory lead.`,
  }));
}

function reversalBeats(series: MatchStateSeries | null): AgentMatchRecapBeat[] {
  if (series === null) return [];
  return computeMajorReversals(series).map((reversal) => ({
    turnNumber: reversal.toTurn,
    kind: "reversal",
    message:
      reversal.placesChanged > 0
        ? `${reversal.username} claws back to ${ordinalLabel(reversal.toRank)} place from ${ordinalLabel(reversal.fromRank)}.`
        : `${reversal.username} collapses to ${ordinalLabel(reversal.toRank)} place from ${ordinalLabel(reversal.fromRank)}.`,
  }));
}

/**
 * Trims to `MAX_PUBLIC_RECAP_BEATS`, chronologically ordered on output.
 * Betrayal/elimination/final-confrontation beats are ALWAYS kept in full
 * — they never count against the cap's trimming, only against its total
 * (in the practically-impossible case where those three categories alone
 * exceed the cap, every one of them still survives; the cap is then
 * exceeded honestly rather than dropping a betrayal). Alliance beats trim
 * before first-strike beats when the two combined don't fit the remaining
 * budget, each category itself kept in chronological order.
 */
function applyImportanceCap(
  neverTrimmed: readonly AgentMatchRecapBeat[],
  trimmable: readonly AgentMatchRecapBeat[],
): AgentMatchRecapBeat[] {
  const remainingBudget = Math.max(0, MAX_PUBLIC_RECAP_BEATS - neverTrimmed.length);
  const orderedTrimmable = [...trimmable].sort(
    (a, b) =>
      TRIMMABLE_KIND_PRIORITY[
        a.kind as "alliance" | "first_strike" | "lead_change" | "reversal"
      ] -
        TRIMMABLE_KIND_PRIORITY[
          b.kind as "alliance" | "first_strike" | "lead_change" | "reversal"
        ] ||
      a.turnNumber - b.turnNumber,
  );
  const kept = [...neverTrimmed, ...orderedTrimmable.slice(0, remainingBudget)];
  return kept.sort((a, b) => a.turnNumber - b.turnNumber);
}

function buildSummary(
  counts: CuratedWarRoomBeats["rawCounts"],
  hasFinalConfrontation: boolean,
  leadChangeCount: number,
  reversalCount: number,
): string {
  const parts: string[] = [];
  const entries: [AgentMatchRecapBeat["kind"], number][] = [
    ["alliance", counts.alliance],
    ["betrayal", counts.betrayal],
    ["first_strike", counts.firstStrike],
    ["elimination", counts.elimination],
    ["final_confrontation", hasFinalConfrontation ? 1 : 0],
    ["lead_change", leadChangeCount],
    ["reversal", reversalCount],
  ];
  for (const [kind, count] of entries) {
    if (count === 0) continue;
    const label = BEAT_KIND_LABEL[kind];
    parts.push(count === 1 ? `1 ${label}` : `${count} ${label}s`);
  }
  if (parts.length === 0) return "";
  if (parts.length === 1) return `This match featured ${parts[0]}.`;
  const last = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  return `This match featured ${rest.join(", ")} and ${last}.`;
}

/** `null` when the curated pass finds zero beats — see the module doc's "never padded" rule. */
export function buildAgentMatchRecap(
  input: AgentMatchRecapInput,
): AgentMatchRecap | null {
  const orderedEvents = [...input.telemetry.events].sort(
    (a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence,
  );
  const curated = curateWarRoomBeats(orderedEvents);
  const totalTurns =
    input.finalTurnCount !== null && input.finalTurnCount > 0
      ? input.finalTurnCount
      : orderedEvents.reduce((max, event) => Math.max(max, event.turnNumber), 0);
  const finalBeat = finalConfrontationBeat(
    orderedEvents,
    totalTurns,
    curated.includedEventIds,
  );
  const compressedEliminations = compressTerminalEliminations(
    curated.eliminationBeats,
    totalTurns,
  );
  const neverTrimmed = [
    ...curated.betrayalBeats,
    ...compressedEliminations.beats,
    ...(finalBeat !== null ? [finalBeat] : []),
  ];
  const leadChanges = leadChangeBeats(input.series);
  const reversals = reversalBeats(input.series);
  const trimmable = [
    ...curated.allianceBeats,
    ...curated.firstStrikeBeats,
    ...leadChanges,
    ...reversals,
  ];
  const beats = applyImportanceCap(neverTrimmed, trimmable);
  if (beats.length === 0) {
    return null;
  }
  return {
    schemaVersion: AGENT_MATCH_RECAP_SCHEMA_VERSION,
    runID: input.runID,
    generatedAt: new Date().toISOString(),
    summary: buildSummary(
      curated.rawCounts,
      finalBeat !== null,
      leadChanges.length,
      reversals.length,
    ),
    beats,
    curatedDramaScore: computeCuratedDramaScore(
      curated,
      finalBeat !== null,
      compressedEliminations.nonTerminalCount,
    ),
    curatedDramaScoreMethodology: CURATED_DRAMA_SCORE_METHODOLOGY,
  };
}

export async function writeAgentMatchRecapArtifacts(input: {
  recap: AgentMatchRecap;
  directory: string;
}): Promise<AgentMatchRecapPaths> {
  const jsonPath = path.join(input.directory, "match-recap.json");
  await fs.writeFile(jsonPath, `${JSON.stringify(input.recap, null, 2)}\n`);
  return { jsonPath };
}
