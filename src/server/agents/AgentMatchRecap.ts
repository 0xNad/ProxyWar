import fs from "fs/promises";
import path from "path";
import {
  FINAL_CONFLICT_TURN_CAP,
  FINAL_CONFLICT_TURN_FRACTION,
} from "./DirectorCutPlan";
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
 * duplicated). `lead_change` is deliberately never produced here either —
 * see `curatedWarRoomEvents`'s own doc: no turn-by-turn territory series
 * is available from decision-record telemetry, so a lead-change beat
 * would have to fabricate a moment. Every beat message is either the
 * `SpectatorEvent.message` the telemetry builder already generated (a
 * factual, already-vetted sentence — see `AgentSpectatorTelemetry.ts`'s
 * `eventForRecord`) or a small factual template built only from
 * `actorName`/`targetName`/real counts/turn numbers, never an inferred or
 * embellished claim.
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
  kind: "alliance" | "first_strike" | "betrayal" | "elimination" | "final_confrontation";
  message: string;
}

/**
 * Bumped 1 -> 2 for the alliance-aggregation + importance cap fix, then
 * 2 -> 3 for the addition of `curatedDramaScore`/`curatedDramaScoreMethodology`
 * (see `computeCuratedDramaScore`'s doc) — the PUBLIC "best battles" ranking
 * input, replacing `AgentDramaReport.dramaScore` for that purpose on public
 * surfaces. Either bump means a pre-fix `match-recap.json` is stale, never
 * merely "old but still fine": `CoworldLeagueMatchNarrativeBackfill.ts`'s
 * `recapNeedsRegeneration` compares against this constant to force
 * re-curation, and `LeagueEpisodeMatchPage.ts`'s `parseMatchRecapArtifact`
 * refuses to parse anything but the current version (a stale artifact
 * reads as "no recap yet", never as spammy/scoreless content, until the
 * backfill upgrades it).
 */
export const AGENT_MATCH_RECAP_SCHEMA_VERSION = 3;

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
}

/** Public beat cap — see the module doc's live-verification fix. Priority order when trimming is `applyImportanceCap`'s job; this is just the ceiling. */
export const MAX_PUBLIC_RECAP_BEATS = 16;

const BEAT_KIND_LABEL: Record<AgentMatchRecapBeat["kind"], string> = {
  alliance: "alliance",
  first_strike: "first strike",
  betrayal: "betrayal",
  elimination: "elimination",
  final_confrontation: "final clash",
};

/** Lower sorts first when trimming — betrayals/eliminations/final-clash are never trimmed by the cap (see `applyImportanceCap`); this only orders the two categories that DO get trimmed. */
const TRIMMABLE_KIND_PRIORITY: Record<"alliance" | "first_strike", number> = {
  alliance: 0,
  first_strike: 1,
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

export interface CuratedWarRoomBeats {
  /** Aggregated per-pair alliance beats — see the module doc. */
  allianceBeats: AgentMatchRecapBeat[];
  /** One per ordered actor/target pair's first attack — already deduped, unchanged by the 2026-08-01 fix. */
  firstStrikeBeats: AgentMatchRecapBeat[];
  /** Every betrayal individually — never aggregated, never dropped by the cap. */
  betrayalBeats: AgentMatchRecapBeat[];
  /** Every elimination individually — never dropped by the cap. */
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
 * anchored at the first formation; an intervening betrayal both stays its
 * own individual beat AND resets the pair's aggregation run.
 */
function curateWarRoomBeats(events: readonly SpectatorEvent[]): CuratedWarRoomBeats {
  const firstStrikeBeats: AgentMatchRecapBeat[] = [];
  const betrayalBeats: AgentMatchRecapBeat[] = [];
  const eliminationBeats: AgentMatchRecapBeat[] = [];
  const finalizedAllianceBeats: AgentMatchRecapBeat[] = [];
  const openAllianceRuns = new Map<string, AllianceRun>();
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
      betrayalBeats.push({
        turnNumber: event.turnNumber,
        kind: "betrayal",
        message: event.message,
      });
      const key = unorderedPairKey(event.actorAgentID, event.targetAgentID);
      const openRun = openAllianceRuns.get(key);
      if (openRun !== undefined) {
        finalizedAllianceBeats.push(allianceBeatFromRun(openRun));
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
 * Weights mirror `AgentDramaReport.dramaScore`'s recognizable shape
 * (betrayals heaviest, then eliminations, then alliances, lightest-weight
 * signal last) but every input here is a DISTINCT, already-deduped count:
 *
 *   - betrayals: every individual betrayal beat, never aggregated away
 *     (`curated.betrayalBeats.length`) x 20 — the single most decisive
 *     "this actually happened" political signal.
 *   - eliminations: `curated.eliminationBeats.length` x 14 — a match's
 *     hardest outcome-anchored beat.
 *   - alliances: DISTINCT unordered pairs, one beat per pair no matter how
 *     many times they re-request (`curated.allianceBeats.length` — the
 *     exact aggregation `curateWarRoomBeats` already performs for the
 *     recap itself) x 9 — this is the direct fix for the churn-saturation
 *     bug: 37 re-formations between one pair score the SAME as 1.
 *   - first strikes: DISTINCT ordered actor/target pairs, already deduped
 *     one-per-pair at capture time (`curated.firstStrikeBeats.length`) x 3.
 *   - final confrontation: +12 flat when the endgame window produced a
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
  elimination: 14,
  alliancePair: 9,
  firstStrikePair: 3,
  finalConfrontation: 12,
} as const;

export const CURATED_DRAMA_SCORE_METHODOLOGY =
  `betrayal beats x${CURATED_DRAMA_WEIGHTS.betrayal} + elimination beats x${CURATED_DRAMA_WEIGHTS.elimination} + ` +
  `distinct alliance pairs x${CURATED_DRAMA_WEIGHTS.alliancePair} (same-pair re-formations aggregate into one pair, never scored per re-request) + ` +
  `distinct first-strike pairs x${CURATED_DRAMA_WEIGHTS.firstStrikePair} + ${CURATED_DRAMA_WEIGHTS.finalConfrontation} if the match ended on a genuine final clash beat; ` +
  `summed and capped to [0, 100] — computed from the same deduped War Room beats this recap shows, never from raw un-deduped event counts`;

function computeCuratedDramaScore(
  curated: CuratedWarRoomBeats,
  hasFinalConfrontation: boolean,
): number {
  const raw =
    curated.betrayalBeats.length * CURATED_DRAMA_WEIGHTS.betrayal +
    curated.eliminationBeats.length * CURATED_DRAMA_WEIGHTS.elimination +
    curated.allianceBeats.length * CURATED_DRAMA_WEIGHTS.alliancePair +
    curated.firstStrikeBeats.length * CURATED_DRAMA_WEIGHTS.firstStrikePair +
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
      TRIMMABLE_KIND_PRIORITY[a.kind as "alliance" | "first_strike"] -
        TRIMMABLE_KIND_PRIORITY[b.kind as "alliance" | "first_strike"] ||
      a.turnNumber - b.turnNumber,
  );
  const kept = [...neverTrimmed, ...orderedTrimmable.slice(0, remainingBudget)];
  return kept.sort((a, b) => a.turnNumber - b.turnNumber);
}

function buildSummary(counts: CuratedWarRoomBeats["rawCounts"], hasFinalConfrontation: boolean): string {
  const parts: string[] = [];
  const entries: [AgentMatchRecapBeat["kind"], number][] = [
    ["alliance", counts.alliance],
    ["betrayal", counts.betrayal],
    ["first_strike", counts.firstStrike],
    ["elimination", counts.elimination],
    ["final_confrontation", hasFinalConfrontation ? 1 : 0],
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
  const neverTrimmed = [
    ...curated.betrayalBeats,
    ...curated.eliminationBeats,
    ...(finalBeat !== null ? [finalBeat] : []),
  ];
  const trimmable = [...curated.allianceBeats, ...curated.firstStrikeBeats];
  const beats = applyImportanceCap(neverTrimmed, trimmable);
  if (beats.length === 0) {
    return null;
  }
  return {
    schemaVersion: AGENT_MATCH_RECAP_SCHEMA_VERSION,
    runID: input.runID,
    generatedAt: new Date().toISOString(),
    summary: buildSummary(curated.rawCounts, finalBeat !== null),
    beats,
    curatedDramaScore: computeCuratedDramaScore(curated, finalBeat !== null),
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
