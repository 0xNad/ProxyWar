import { PREMIERE_ID_PATTERN } from "../replay-premiere/ReplayPremiereContracts";
import { derivePremiereId } from "../replay-premiere/ReplayPremiereLoopCore";
import type {
  AgentRunFinalState,
  AgentRunRosterEntry,
} from "./AgentDecisionLogWriter";
import { AGENT_MATCH_RECAP_SCHEMA_VERSION } from "./AgentMatchRecap";
import {
  buildAgentMatchStateSeries,
  MATCH_STATE_SERIES_SCHEMA_VERSION,
  type MatchStateSeries,
} from "./AgentMatchStateSeries";
import type { AgentSpectatorReplay } from "./AgentSpectatorReplay";
import {
  buildAgentSpectatorTelemetry,
  type SpectatorTelemetry,
} from "./AgentSpectatorTelemetry";
import type {
  AgentActionAuditStatus,
  AgentDecisionRecord,
  LegalActionKind,
} from "./AgentTypes";
import { normalizeAgentRuntimeMode } from "./AgentTypes";
import { asAgentDegradationCause } from "./AgentWireProtocol";
import {
  filterSuppressedEpisodeRows,
  type LatestPremierePointer,
  type PremiereSuppressionState,
} from "./CoworldLeaguePremiereSuppression";
import type {
  CoworldLeagueEpisodePlayerRow,
  CoworldLeagueEpisodeRow,
  CoworldLeagueLatestPremiereCard,
  CoworldLeagueRoundRow,
  CoworldLeagueStandingRow,
} from "./CoworldLeagueSiteWriter";

/**
 * Pure transforms from Coworld Observatory read-API JSON (as emitted by the
 * `coworld` CLI `--json` verbs) and hosted replay payloads into the league
 * mirror's site data. No IO here — the mirror script owns fetching.
 */

const housePolicyName = "proxywar-keystone";
const replayUiRecentDecisionLimit = 60;
const replayUiTextLimit = 1_000;

const fallbackPlayerColors = [
  "#ef4444",
  "#2563eb",
  "#16a34a",
  "#d97706",
  "#9333ea",
  "#0891b2",
  "#db2777",
  "#65a30d",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const record = asRecord(value);
  if (record && Array.isArray(record.entries)) {
    return record.entries;
  }
  return [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function boundedString(
  value: unknown,
  limit = replayUiTextLimit,
): string | null {
  const text = asString(value);
  return text === null ? null : text.slice(0, limit);
}

export interface CoworldLeagueSummary {
  id: string;
  name: string;
  description: string | null;
  roundIntervalMinutes: number | null;
  episodesPerRound: number | null;
}

export function parseLeagueSummary(
  value: unknown,
): CoworldLeagueSummary | null {
  const league = asRecord(value);
  if (!league) {
    return null;
  }
  const id = asString(league.id);
  if (id === null) {
    return null;
  }
  const commissionerConfig = asRecord(league.commissioner_config);
  const stages = asArray(commissionerConfig?.stages);
  const firstStage = asRecord(stages[0]);
  return {
    id,
    name: asString(league.name) ?? "Coworld league",
    description: asString(league.description),
    roundIntervalMinutes: asNumber(
      commissionerConfig?.schedule_interval_minutes,
    ),
    episodesPerRound: asNumber(firstStage?.num_episodes),
  };
}

export function pickCompetitionDivision(
  value: unknown,
): { id: string; name: string } | null {
  const divisions = asArray(value)
    .map((entry) => {
      const division = asRecord(entry);
      if (!division) {
        return null;
      }
      const id = asString(division.id);
      if (id === null) {
        return null;
      }
      return {
        id,
        name: asString(division.name) ?? "Division",
        level: asNumber(division.level) ?? 0,
        memberCount: asNumber(division.member_count) ?? 0,
      };
    })
    .filter((division) => division !== null);
  if (divisions.length === 0) {
    return null;
  }
  const populated = divisions.filter((division) => division.memberCount > 0);
  const candidates = populated.length > 0 ? populated : divisions;
  candidates.sort((a, b) => b.level - a.level || b.memberCount - a.memberCount);
  const best = candidates[0];
  return { id: best.id, name: best.name };
}

/**
 * Maps player ids to the policy label currently marked as their champion.
 * Memberships are read separately from results because a leaderboard rating
 * row can intentionally retain an older policy label after champion promotion.
 */
export function activeChampionPolicyLabelsByPlayerId(
  value: unknown,
): Map<string, string> {
  const champions = new Map<
    string,
    { policyLabel: string; startedAt: number }
  >();
  for (const entry of asArray(value)) {
    const membership = asRecord(entry);
    const substatus = asString(membership?.substatus);
    if (
      !membership ||
      membership.status !== "competing" ||
      (substatus !== null &&
        substatus !== "active" &&
        substatus !== "champion") ||
      membership.is_champion !== true ||
      asString(membership.end_time) !== null
    ) {
      continue;
    }
    const policyVersion = asRecord(membership.policy_version);
    const player = asRecord(membership.player);
    const policyPlayerId = asString(policyVersion?.player_id);
    const membershipPlayerId = asString(player?.id);
    if (
      policyPlayerId !== null &&
      membershipPlayerId !== null &&
      policyPlayerId !== membershipPlayerId
    ) {
      continue;
    }
    const playerId = policyPlayerId ?? membershipPlayerId;
    const policyLabel = asString(policyVersion?.label);
    if (playerId !== null && policyLabel !== null) {
      const parsedStartedAt = Date.parse(asString(membership.start_time) ?? "");
      const startedAt = Number.isFinite(parsedStartedAt)
        ? parsedStartedAt
        : Number.NEGATIVE_INFINITY;
      const existing = champions.get(playerId);
      if (existing === undefined || startedAt > existing.startedAt) {
        champions.set(playerId, { policyLabel, startedAt });
      }
    }
  }
  return new Map(
    [...champions].map(([playerId, champion]) => [
      playerId,
      champion.policyLabel,
    ]),
  );
}

function isHousePolicyLabel(value: string): boolean {
  const match = /^(.*):v\d+$/.exec(value);
  return match?.[1] === housePolicyName;
}

export function buildStandingRows(
  value: unknown,
  activeChampionMemberships: unknown = [],
): CoworldLeagueStandingRow[] {
  const activeChampionLabels = activeChampionPolicyLabelsByPlayerId(
    activeChampionMemberships,
  );
  const rows: CoworldLeagueStandingRow[] = [];
  for (const entry of asArray(value)) {
    const row = asRecord(entry);
    if (!row) {
      continue;
    }
    // Null, not a jargon placeholder. The site writer decides how an unknown
    // rating policy is presented ("Not yet rated"); stamping "unknown policy"
    // here leaked an internal string straight onto the public standings and
    // made the writer's own fallback unreachable.
    const ratingPolicyLabel = asString(row.policy_label);
    const playerId = asString(row.player_id);
    const activeChampionPolicyLabel =
      playerId === null ? null : (activeChampionLabels.get(playerId) ?? null);
    rows.push({
      rank: asNumber(row.rank) ?? rows.length + 1,
      playerName: asString(row.player_name) ?? "unknown player",
      ratingPolicyLabel,
      activeChampionPolicyLabel,
      // Preserve the original public data.json contract while exposing the
      // rating/champion distinction through the two explicit fields above.
      policyLabel: ratingPolicyLabel,
      score: asNumber(row.score),
      roundsPlayed: asNumber(row.rounds_played),
      // Ownership comes from the current champion membership, never from a
      // historical rating label or a lookalike prefix.
      isHouse:
        activeChampionPolicyLabel !== null &&
        isHousePolicyLabel(activeChampionPolicyLabel),
    });
  }
  rows.sort((a, b) => a.rank - b.rank);
  return rows;
}

export function scoreLabelFromStandings(value: unknown): string {
  const first = asRecord(asArray(value)[0]);
  return asString(first?.score_label) ?? "Score";
}

export function mergeEpisodeRows(
  freshEpisodes: CoworldLeagueEpisodeRow[],
  previousEpisodes: CoworldLeagueEpisodeRow[],
  limit: number,
): CoworldLeagueEpisodeRow[] {
  const byId = new Map<string, CoworldLeagueEpisodeRow>();
  for (const episode of previousEpisodes) {
    byId.set(episode.episodeRequestId, episode);
  }
  for (const episode of freshEpisodes) {
    byId.set(episode.episodeRequestId, episode);
  }
  return [...byId.values()]
    .sort((a, b) => episodeCompletedAt(b) - episodeCompletedAt(a))
    .slice(0, limit);
}

function episodeCompletedAt(episode: CoworldLeagueEpisodeRow): number {
  const completedAt = Date.parse(episode.completedAt ?? "");
  return Number.isFinite(completedAt) ? completedAt : Number.NEGATIVE_INFINITY;
}

/**
 * Decides which episode rows this cycle publishes to `data.json`.
 *
 * 2026-08-16 archive wipe: a cycle where premiere suppression deferred EVERY
 * fetched candidate looked like a healthy feed with zero fresh episodes — the
 * previous-cards merge only engaged on stale feeds — so an empty list
 * overwrote a populated 12-card archive (and `pruneMirrorArtifacts` then
 * swept the orphaned caches). Retention now engages whenever the feed is
 * stale, OR suppression deferred any candidate, OR the fresh list is empty,
 * with a last-resort refusal to replace a non-empty archive with an empty
 * list. The spoiler shield is unchanged: the final suppression filter runs
 * over whichever list is chosen, so a held or quarantined card can never
 * resurface through retention.
 */
export function selectPublishedEpisodeRows(args: {
  freshEpisodes: CoworldLeagueEpisodeRow[];
  previousEpisodes: CoworldLeagueEpisodeRow[];
  maxRenderedEpisodes: number;
  replayFeedStale: boolean;
  suppressionDeferredCount: number;
  finalSuppression: PremiereSuppressionState;
  now: Date;
}): {
  published: CoworldLeagueEpisodeRow[];
  suppressedFromMerged: number;
  retainedPreviousOverEmpty: boolean;
} {
  const retain =
    args.replayFeedStale ||
    args.suppressionDeferredCount > 0 ||
    args.freshEpisodes.length === 0;
  const base = retain
    ? mergeEpisodeRows(
        args.freshEpisodes,
        args.previousEpisodes,
        args.maxRenderedEpisodes,
      )
    : args.freshEpisodes;
  let published = filterSuppressedEpisodeRows(
    args.finalSuppression,
    base,
    args.now,
  );
  const suppressedFromMerged = base.length - published.length;
  let retainedPreviousOverEmpty = false;
  if (published.length === 0 && args.previousEpisodes.length > 0) {
    // Last resort: never overwrite a populated archive with an empty list.
    // Previously published rows still have to pass the spoiler filter.
    published = filterSuppressedEpisodeRows(
      args.finalSuppression,
      mergeEpisodeRows([], args.previousEpisodes, args.maxRenderedEpisodes),
      args.now,
    );
    retainedPreviousOverEmpty = published.length > 0;
  }
  return { published, suppressedFromMerged, retainedPreviousOverEmpty };
}

export function buildRoundRows(
  value: unknown,
  limit: number,
): CoworldLeagueRoundRow[] {
  const rounds: CoworldLeagueRoundRow[] = [];
  for (const entry of asArray(value)) {
    const round = asRecord(entry);
    if (!round) {
      continue;
    }
    const roundNumber = asNumber(round.round_number);
    if (roundNumber === null) {
      continue;
    }
    rounds.push({
      roundNumber,
      status: asString(round.status) ?? "unknown",
      startedAt: asString(round.started_at),
      completedAt: asString(round.completed_at),
    });
  }
  rounds.sort((a, b) => b.roundNumber - a.roundNumber);
  return rounds.slice(0, limit);
}

export function roundNumberByRoundId(value: unknown): Map<string, number> {
  const byId = new Map<string, number>();
  for (const entry of asArray(value)) {
    const round = asRecord(entry);
    if (!round) {
      continue;
    }
    const id = asString(round.id);
    const roundNumber = asNumber(round.round_number);
    if (id !== null && roundNumber !== null) {
      byId.set(id, roundNumber);
    }
  }
  return byId;
}

export interface HostedEpisodeMeta {
  episodeRequestId: string;
  roundId: string | null;
  completedAt: string | null;
  replayUrl: string | null;
  /** Raw variant label from the replays list, e.g. "Tournament 12P - Pangaea". */
  variantName: string | null;
  /**
   * Best-effort map from the replays list alone: the variant label's map
   * segment first, then the legacy `game_config.map`. Shown verbatim for rows
   * that never get a downloaded replay; otherwise the replay config refines it.
   */
  map: string;
  mapSize: string;
  /** Legacy `game_config.map` when the list still carries it; null under the current API. */
  legacyConfigMap: string | null;
}

export function isSafeCoworldEpisodeRequestId(value: string): boolean {
  return /^ereq_[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Extracts the map name from a Coworld variant label. Ladder variants are named
 * "<tournament label> - <Map>" (e.g. "Tournament 12P - Pangaea",
 * "Tournament 12P - World"), so the map is the segment after the LAST " - ".
 * Returns null when there is no such segment so callers can fall back to the
 * legacy `game_config.map` or the authoritative in-replay config.
 */
export function mapNameFromVariant(variantName: unknown): string | null {
  const label = asString(variantName);
  if (label === null) {
    return null;
  }
  const separator = " - ";
  const index = label.lastIndexOf(separator);
  if (index === -1) {
    return null;
  }
  const candidate = label.slice(index + separator.length).trim();
  return candidate.length > 0 ? candidate : null;
}

export function parseCompletedEpisodeMetaList(
  value: unknown,
): HostedEpisodeMeta[] {
  const episodes: HostedEpisodeMeta[] = [];
  for (const entry of asArray(value)) {
    const episode = asRecord(entry);
    if (!episode || episode.status !== "completed") {
      continue;
    }
    const episodeRequestId = asString(episode.id);
    if (
      episodeRequestId === null ||
      !isSafeCoworldEpisodeRequestId(episodeRequestId)
    ) {
      continue;
    }
    const gameConfig = asRecord(episode.game_config);
    const variantName = asString(episode.variant_name);
    const legacyConfigMap = asString(gameConfig?.map);
    episodes.push({
      episodeRequestId,
      roundId: asString(episode.round_id),
      completedAt: asString(episode.completed_at),
      replayUrl: asString(episode.replay_url),
      variantName,
      // The replays-list `game_config` went empty in the 2026-07 API change, so
      // the variant label ("Tournament 12P - Pangaea") is the reliable map
      // source now; the legacy field stays as a fallback for older rows or if
      // the platform restores it.
      map: mapNameFromVariant(variantName) ?? legacyConfigMap ?? "Unknown map",
      mapSize: asString(gameConfig?.map_size) ?? "",
      legacyConfigMap,
    });
  }
  episodes.sort((a, b) =>
    (b.completedAt ?? "").localeCompare(a.completedAt ?? ""),
  );
  return episodes;
}

export interface ParsedHostedReplay {
  runID: string;
  /** Authoritative map from the downloaded replay config, if present. */
  map: string | null;
  /** Authoritative map size from the downloaded replay config, if present. */
  mapSize: string | null;
  spectatorReplay: AgentSpectatorReplay | null;
  inlineRunArtifacts: Record<string, string>;
  turnCount: number | null;
  decisionCount: number | null;
  degradedCount: number | null;
  winnerSlot: number | null;
  players: Array<{
    slot: number;
    name: string;
    tilesOwned: number;
    isAlive: boolean;
  }>;
}

export interface CoworldReplayUiDecision {
  sequence: number;
  turnNumber: number;
  username: string;
  profile: string;
  brainType: string;
  selectedActionKind: string;
  selectedLegalActionId: string;
  selectedActionMetadata?: Record<string, unknown>;
  socialText?: string;
  socialTargetName?: string;
  reason: string;
  planObjective?: string;
  decisionLatencyMs: number;
  fallbackUsed: boolean;
  parseSuccess?: boolean;
  result: {
    accepted: boolean;
    reason: string;
  };
  auditStatus?: string;
}

export interface CoworldReplayUiArtifact {
  version: 1;
  aggregateSource: "decisions" | "match-summary" | "unavailable";
  decisionCount: number;
  rejectedCount: number;
  fallbackCount: number;
  actionCounts: Record<string, number>;
  recentDecisions: CoworldReplayUiDecision[];
  artifacts: {
    visualReport: boolean;
    spectatorTelemetry: boolean;
    decisions: boolean;
    summary: boolean;
  };
}

/**
 * Builds the bounded payload consumed by the rendered replay overlay.
 * Privacy-safe hosted replays omit raw decisions entirely, so aggregate truth
 * falls back to the public match summary and the recent-decision window stays
 * empty. Historical payloads that still contain private server-side decisions
 * may be projected by trusted mirror tooling without exposing raw fields.
 */
/**
 * Choose which decisions the replay UI receives, within a fixed budget.
 *
 * This used to be `decisions.slice(-limit)` — the LAST N of the match. Two
 * consequences: agents eliminated early never appeared at all (their decisions
 * are never in the tail), and the panel's playhead window had nothing to show
 * until playback reached the final minutes of a 50,000-turn match.
 *
 * Keep the same payload budget but spread it across the whole match: every
 * notable decision (engine fallback or rejected action) is kept first, then the
 * remainder is filled by an even stride so early, middle and late play are all
 * represented. Chronological order is preserved.
 */
export function sampleDecisionsAcrossMatch<T extends CoworldReplayUiDecision>(
  decisions: readonly T[],
  limit: number,
): T[] {
  if (limit <= 0) return [];
  if (decisions.length <= limit) return [...decisions];
  const chosen = new Set<number>();
  // 1. Every notable decision first (engine fallback or rejected action).
  for (
    let index = 0;
    index < decisions.length && chosen.size < limit;
    index++
  ) {
    const decision = decisions[index];
    if (decision.fallbackUsed === true || decision.result?.accepted === false) {
      chosen.add(index);
    }
  }
  // 2. Even stride across the whole match for temporal coverage.
  const strideSlots = limit - chosen.size;
  if (strideSlots > 0) {
    const stride = decisions.length / strideSlots;
    for (let step = 0; step < strideSlots && chosen.size < limit; step += 1) {
      chosen.add(
        Math.min(decisions.length - 1, Math.floor(step * stride + stride / 2)),
      );
    }
  }
  // 3. Stride picks can collide with step 1, leaving the budget under-filled.
  // Top up so the payload size stays exactly as before.
  for (
    let index = 0;
    index < decisions.length && chosen.size < limit;
    index++
  ) {
    chosen.add(index);
  }
  return [...chosen]
    .sort((left, right) => left - right)
    .map((index) => decisions[index]);
}

export function buildCoworldReplayUiArtifact(
  inlineRunArtifacts: Record<string, string>,
): CoworldReplayUiArtifact {
  const decisions: CoworldReplayUiDecision[] = [];
  const actionCounts: Record<string, number> = {};
  let rejectedCount = 0;
  let fallbackCount = 0;
  const rawDecisions = inlineRunArtifacts["decisions.jsonl"];
  if (typeof rawDecisions === "string") {
    for (const rawLine of rawDecisions.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const decision = projectCoworldReplayUiDecision(parsed);
      if (decision === null) continue;
      decisions.push(decision);
      actionCounts[decision.selectedActionKind] =
        (actionCounts[decision.selectedActionKind] ?? 0) + 1;
      if (!decision.result.accepted) rejectedCount += 1;
      if (decision.fallbackUsed) fallbackCount += 1;
    }
  }
  const summaryAggregates = replayUiAggregatesFromMatchSummary(
    inlineRunArtifacts["match-summary.json"],
  );
  const aggregateSource =
    decisions.length > 0
      ? "decisions"
      : summaryAggregates === null
        ? "unavailable"
        : "match-summary";
  const aggregates =
    aggregateSource === "decisions"
      ? {
          decisionCount: decisions.length,
          rejectedCount,
          fallbackCount,
          actionCounts,
        }
      : (summaryAggregates ?? {
          decisionCount: 0,
          rejectedCount: 0,
          fallbackCount: 0,
          actionCounts: {},
        });
  return {
    version: 1,
    aggregateSource,
    ...aggregates,
    recentDecisions: sampleDecisionsAcrossMatch(
      decisions,
      replayUiRecentDecisionLimit,
    ),
    artifacts: {
      // `visual-report.html`/`decisions.jsonl` were removed from the public
      // artifact allowlist (`proxyWarPublicRunArtifacts`,
      // `ProxyWarPublicArtifacts.ts`) — both carry raw LLM prompts/output
      // and are never publicly servable regardless of whether the raw
      // hosted payload happens to include the file. `Object.hasOwn` here
      // would answer "does the file exist", which is a different, now-
      // irrelevant question from "is it available to a client" — reporting
      // `true` from file presence would be a stale/misleading signal (a
      // client acting on it would build a link that always 404s). No
      // consumer reads either field today (the UI row that once used them
      // was removed on operator request — see `AiLeagueReplayOverlay.ts`'s
      // history), so this is the honest value rather than dead plumbing
      // pretending otherwise.
      visualReport: false,
      spectatorTelemetry: Object.hasOwn(
        inlineRunArtifacts,
        "spectator-telemetry.json",
      ),
      decisions: false,
      summary: Object.hasOwn(inlineRunArtifacts, "match-summary.json"),
    },
  };
}

function replayUiAggregatesFromMatchSummary(raw: unknown): {
  decisionCount: number;
  rejectedCount: number;
  fallbackCount: number;
  actionCounts: Record<string, number>;
} | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const summary = asRecord(value);
  const decisionCount = asNumber(summary?.decisionCount);
  const rejectedCount = asNumber(summary?.rejectedCount);
  const fallbackCount = asNumber(summary?.fallbackCount);
  const rawActionCounts = asRecord(summary?.actionCounts);
  if (
    decisionCount === null ||
    decisionCount < 0 ||
    rejectedCount === null ||
    rejectedCount < 0 ||
    fallbackCount === null ||
    fallbackCount < 0 ||
    rawActionCounts === null
  ) {
    return null;
  }
  const actionCounts: Record<string, number> = {};
  for (const [kind, rawCount] of Object.entries(rawActionCounts)) {
    const count = asNumber(rawCount);
    if (count !== null && count >= 0) actionCounts[kind] = count;
  }
  return { decisionCount, rejectedCount, fallbackCount, actionCounts };
}

function projectCoworldReplayUiDecision(
  value: unknown,
): CoworldReplayUiDecision | null {
  const decision = asRecord(value);
  const result = asRecord(decision?.result);
  const sequence = asNumber(decision?.sequence);
  const turnNumber = asNumber(decision?.turnNumber);
  const username = boundedString(decision?.username, 160);
  const selectedActionKind = boundedString(decision?.selectedActionKind, 120);
  const selectedLegalActionId = boundedString(
    decision?.selectedLegalActionId,
    500,
  );
  if (
    decision === null ||
    result === null ||
    sequence === null ||
    turnNumber === null ||
    username === null ||
    selectedActionKind === null ||
    selectedLegalActionId === null
  ) {
    return null;
  }
  const projected: CoworldReplayUiDecision = {
    sequence,
    turnNumber,
    username,
    profile: boundedString(decision.profile, 120) ?? "unknown",
    brainType: boundedString(decision.brainType, 120) ?? "unknown",
    selectedActionKind,
    selectedLegalActionId,
    reason: boundedString(decision.reason) ?? "",
    decisionLatencyMs: asNumber(decision.decisionLatencyMs) ?? 0,
    fallbackUsed: decision.fallbackUsed === true,
    result: {
      accepted: result.accepted === true,
      reason: boundedString(result.reason) ?? "",
    },
  };
  const metadata = projectCoworldReplayUiMetadata(
    asRecord(decision.selectedActionMetadata),
  );
  if (metadata !== undefined) projected.selectedActionMetadata = metadata;
  const socialText = boundedString(decision.socialText);
  if (socialText !== null) projected.socialText = socialText;
  const socialTargetName = boundedString(decision.socialTargetName, 160);
  if (socialTargetName !== null) {
    projected.socialTargetName = socialTargetName;
  }
  const planObjective = boundedString(decision.planObjective, 500);
  if (planObjective !== null) projected.planObjective = planObjective;
  const parseSuccess = asBoolean(decision.parseSuccess);
  if (parseSuccess !== null) projected.parseSuccess = parseSuccess;
  const auditStatus = boundedString(decision.auditStatus, 120);
  if (auditStatus !== null) projected.auditStatus = auditStatus;
  return projected;
}

function projectCoworldReplayUiMetadata(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  if (metadata === null) return undefined;
  const projected: Record<string, unknown> = {};
  for (const key of [
    "message",
    "quickChatKey",
    "emojiText",
    "recipientName",
    "targetName",
    "emojiContext",
  ]) {
    const value = boundedString(metadata[key], 500);
    if (value !== null) projected[key] = value;
  }
  if (typeof metadata.emoji === "number" && Number.isFinite(metadata.emoji)) {
    projected.emoji = metadata.emoji;
  }
  if (typeof metadata.expansion === "boolean") {
    projected.expansion = metadata.expansion;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

export function parseHostedReplayPayload(
  value: unknown,
): ParsedHostedReplay | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }
  const runID = asString(payload.runID);
  if (runID === null || !/^coworld-[A-Za-z0-9-]+$/.test(runID)) {
    return null;
  }
  const results = asRecord(payload.results);
  // Map/size live in the hosted replay's own config. Our adapter writes
  // snake_case `config.map`/`config.map_size`; a raw game-record payload
  // instead nests camelCase `gameRecord.info.config.gameMap`/`gameMapSize`.
  // Support both so the map survives either replay shape.
  const replayConfig = asRecord(payload.config);
  const gameRecordConfig = asRecord(
    asRecord(asRecord(payload.gameRecord)?.info)?.config,
  );
  const map =
    asString(replayConfig?.map) ?? asString(gameRecordConfig?.gameMap);
  const mapSize =
    asString(replayConfig?.map_size) ?? asString(gameRecordConfig?.gameMapSize);
  const players: ParsedHostedReplay["players"] = [];
  for (const entry of asArray(results?.players)) {
    const player = asRecord(entry);
    if (!player) {
      continue;
    }
    players.push({
      slot: asNumber(player.slot) ?? players.length,
      name: asString(player.name) ?? `Seat ${players.length}`,
      tilesOwned: asNumber(player.tiles_owned) ?? 0,
      isAlive: player.is_alive !== false,
    });
  }
  const inlineRunArtifacts: Record<string, string> = {};
  const inline = asRecord(payload.inlineRunArtifacts);
  if (inline) {
    for (const [name, contents] of Object.entries(inline)) {
      if (typeof contents === "string" && /^[\w.-]+$/.test(name)) {
        inlineRunArtifacts[name] = contents;
      }
    }
  }
  const spectator = asRecord(payload.spectatorReplay);
  return {
    runID,
    map,
    mapSize,
    spectatorReplay:
      spectator && Array.isArray(spectator.snapshots)
        ? (spectator as unknown as AgentSpectatorReplay)
        : null,
    inlineRunArtifacts,
    turnCount: asNumber(results?.turn_count),
    decisionCount: asNumber(results?.decision_count),
    degradedCount: asNumber(results?.degraded_count),
    winnerSlot: asNumber(results?.winner_slot),
    players,
  };
}

function playerColorsFromSpectatorReplay(
  replay: AgentSpectatorReplay | null,
): Map<string, string> {
  const colors = new Map<string, string>();
  const lastSnapshot = replay?.snapshots[replay.snapshots.length - 1];
  for (const player of lastSnapshot?.players ?? []) {
    const record = asRecord(player);
    const name = asString(record?.username);
    const color = asString(record?.color);
    if (name !== null && color !== null && /^#[0-9a-fA-F]{3,8}$/.test(color)) {
      colors.set(name, color);
    }
  }
  return colors;
}

export function buildEpisodeRow(input: {
  meta: HostedEpisodeMeta;
  replay: ParsedHostedReplay;
  roundNumber: number | null;
  watchHref: string | null;
  fullRenderHref: string | null;
  /**
   * `/premiere/<premiereId>` when this episode's premiere has REVEALED (see
   * {@link premiereHrefForEpisode}); null/omitted otherwise. Optional so the
   * field stays entirely absent from data.json rows without one — additive
   * for every existing consumer.
   */
  premiereHref?: string | null;
  /**
   * Product overhaul spec Stage "drama recaps" gap closure — additive,
   * disk-resolved-by-the-caller shape: a compact evidence summary of
   * `drama-report.json`/
   * `match-story.json`/`match-recap.json` when at least one exists on disk
   * for this run (`CoworldLeagueMatchNarrativeBackfill.ts`), null/omitted
   * otherwise. Ranking/evidence signal only — never recap prose (the recap
   * itself is the separate, event-derived `match-recap.json` /
   * `LeagueEpisodeRecap`, unrelated to these scalars).
   *
   * `dramaScore`/`entertainmentGrade` are the legacy `AgentDramaReport`/
   * `AgentMatchStory` pair, requiring BOTH those reports (unchanged).
   * `curatedDramaScore` is the PUBLIC ranking input (see
   * `AgentMatchRecap.ts`'s doc) resolved independently from
   * `match-recap.json` — `null` when that artifact is missing, stale, or
   * (a genuinely quiet match) never written, distinct from `dramaScore`
   * being present without it during the upgrade transition window.
   */
  dramaEvidence?: {
    dramaScore: number;
    entertainmentGrade: string;
    curatedDramaScore: number | null;
  } | null;
}): CoworldLeagueEpisodeRow {
  const { meta, replay } = input;
  const colors = playerColorsFromSpectatorReplay(replay.spectatorReplay);
  const players: CoworldLeagueEpisodePlayerRow[] = replay.players
    .map((player) => ({
      slot: player.slot,
      name: player.name,
      tilesOwned: player.tilesOwned,
      isAlive: player.isAlive,
      isWinner: replay.winnerSlot !== null && player.slot === replay.winnerSlot,
      color:
        colors.get(player.name) ??
        fallbackPlayerColors[
          ((player.slot % fallbackPlayerColors.length) +
            fallbackPlayerColors.length) %
            fallbackPlayerColors.length
        ],
    }))
    .sort((a, b) => b.tilesOwned - a.tilesOwned);
  const winner = players.find((player) => player.isWinner);
  return {
    episodeRequestId: meta.episodeRequestId,
    shortId: shortEpisodeId(meta.episodeRequestId),
    roundNumber: input.roundNumber,
    completedAt: meta.completedAt,
    // Precedence: variant-label map (reliable, list-derived) -> authoritative
    // in-replay config map -> legacy game_config.map -> "Unknown map".
    map:
      mapNameFromVariant(meta.variantName) ??
      replay.map ??
      meta.legacyConfigMap ??
      "Unknown map",
    // Map size is absent from the variant label; prefer the downloaded replay
    // config, else the legacy list value, else blank.
    mapSize: replay.mapSize ?? meta.mapSize,
    turnCount: replay.turnCount,
    decisionCount: replay.decisionCount,
    degradedCount: replay.degradedCount,
    winnerName: winner?.name ?? null,
    players,
    watchHref: input.watchHref,
    fullRenderHref: input.fullRenderHref,
    ...(typeof input.premiereHref === "string" && input.premiereHref.length > 0
      ? { premiereHref: input.premiereHref }
      : {}),
    ...(input.dramaEvidence !== null && input.dramaEvidence !== undefined
      ? { dramaEvidence: input.dramaEvidence }
      : {}),
  };
}

export function shortEpisodeId(episodeRequestId: string): string {
  const cleaned = episodeRequestId.replace(/^ereq_/, "").toLowerCase();
  const safe = cleaned.replace(/[^a-z0-9-]/g, "");
  return safe.slice(0, 8) === "" ? "episode" : safe.slice(0, 8);
}

/**
 * Parse the replay-premiere archive index (JSONL of terminal premiere
 * pointers, `archive-v1/archive-index.jsonl` under the premiere private state
 * root) into the set of premiere ids whose OUTCOME IS PUBLIC: terminal state
 * exactly "revealed" with a reveal timestamp.
 *
 * Spoiler-safe by construction: a pre-reveal premiere never appears in the
 * archive index at all (pointers are written only at post-terminal
 * reclamation, ~30 minutes after reveal), and failed/cancelled/pre-reveal
 * terminal pointers are filtered here — so no id this returns can name a
 * premiere whose outcome is still sealed. Tolerant + fail-open: torn or
 * invalid lines are skipped, a repeated premiere id keeps the LAST record
 * (append-only index semantics), and any unreadable input simply yields fewer
 * links — never a wrong one and never a publication stall.
 */
export function revealedPremiereIdsFromArchiveIndex(raw: string): Set<string> {
  return summarizePremiereArchiveIndex(raw).revealedIds;
}

/**
 * Tolerant projection of the replay-premiere archive index for the mirror's
 * two premiere consumers: battle-card links ({@link revealedIds}) and the
 * latest-premiere card's cross-check + fallback ({@link knownIds},
 * {@link newestRevealed}). Same parse semantics as
 * {@link revealedPremiereIdsFromArchiveIndex} (which is now built on top of
 * this): torn/invalid lines are skipped and a repeated premiere id keeps the
 * LAST record (append-only index semantics).
 */
export interface PremiereArchiveIndexSummary {
  /** Ids whose OUTCOME IS PUBLIC: terminal "revealed" with a reveal time. */
  revealedIds: Set<string>;
  /** Every premiere id present in the index, whatever its terminal state. */
  knownIds: Set<string>;
  /** The revealed entry with the newest parseable revealedAt, if any. */
  newestRevealed: { premiereId: string; revealedAt: string } | null;
}

export function summarizePremiereArchiveIndex(
  raw: string,
): PremiereArchiveIndexSummary {
  const lastById = new Map<
    string,
    { revealed: boolean; revealedAt: string | null }
  >();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(value);
    if (record === null) {
      continue;
    }
    const premiereId = asString(record.premiereId);
    if (premiereId === null || !PREMIERE_ID_PATTERN.test(premiereId)) {
      continue;
    }
    const revealedAt = asString(record.revealedAt);
    lastById.set(premiereId, {
      revealed: record.terminalState === "revealed" && revealedAt !== null,
      revealedAt,
    });
  }
  const revealedIds = new Set<string>();
  let newestRevealed: PremiereArchiveIndexSummary["newestRevealed"] = null;
  let newestRevealedMs = Number.NEGATIVE_INFINITY;
  for (const [premiereId, record] of lastById) {
    if (!record.revealed) {
      continue;
    }
    revealedIds.add(premiereId);
    const revealedAtMs = Date.parse(record.revealedAt ?? "");
    if (!Number.isFinite(revealedAtMs) || record.revealedAt === null) {
      continue;
    }
    if (
      revealedAtMs > newestRevealedMs ||
      (revealedAtMs === newestRevealedMs &&
        (newestRevealed === null ||
          premiereId.localeCompare(newestRevealed.premiereId) > 0))
    ) {
      newestRevealedMs = revealedAtMs;
      newestRevealed = { premiereId, revealedAt: record.revealedAt };
    }
  }
  return { revealedIds, knownIds: new Set(lastById.keys()), newestRevealed };
}

/**
 * Resolve the "Latest premiere" card shown between live premieres.
 *
 * The loop-written pointer is the primary source (it carries round + map and
 * appears at reveal time, before the ~30-minute terminal reclamation adds the
 * premiere to the archive index). It is cross-checked against the archive
 * index when one is available: a pointer whose premiere the index knows as
 * anything OTHER than revealed is dropped — never render a card for a
 * premiere whose outcome is not public. A pointer the index does not know yet
 * is fine (the index lags reveal by design). When the pointer is absent,
 * invalid, or dropped, fall back to the index's newest revealed entry (round
 * and map are unknown there, so the card renders without those pills). Pure
 * and fail-open: null in, null out — the card is simply absent.
 */
export function resolveLatestRevealedPremiere(
  pointer: LatestPremierePointer | null,
  archiveIndex: PremiereArchiveIndexSummary | null,
): CoworldLeagueLatestPremiereCard | null {
  if (pointer !== null) {
    const contradictedByIndex =
      archiveIndex !== null &&
      archiveIndex.knownIds.has(pointer.premiereId) &&
      !archiveIndex.revealedIds.has(pointer.premiereId);
    if (!contradictedByIndex) {
      return {
        premiereId: pointer.premiereId,
        roundNumber: pointer.roundNumber,
        mapLabel: pointer.mapLabel,
        revealedAt: pointer.revealedAt,
        href: `/premiere/${encodeURIComponent(pointer.premiereId)}`,
      };
    }
  }
  const fallback = archiveIndex?.newestRevealed ?? null;
  if (fallback === null) {
    return null;
  }
  return {
    premiereId: fallback.premiereId,
    roundNumber: null,
    mapLabel: "",
    revealedAt: fallback.revealedAt,
    href: `/premiere/${encodeURIComponent(fallback.premiereId)}`,
  };
}

/**
 * Probe-checked variant of {@link resolveLatestRevealedPremiere}: never hand
 * the site writer a card whose target page does not actually serve.
 *
 * 2026-07-22 orphan incident: a premiere that reveals but whose ~30-minute
 * reclamation grace spans a beta restart can end up neither live-registered
 * nor archived — its /premiere page 404s — while the loop-written pointer
 * still names it, so the "Watch now" card linked a dead page. The pointer's
 * freshness-over-index design is correct (the index lags reveal by design),
 * so the only honest check is asking the serving origin. `probe` returns
 * true when the candidate's page serves; candidates that fail are dropped:
 * pointer candidate first, then the archive-index fallback, then no card.
 * Fail-open on the probe itself is the CALLER's choice: pass an
 * always-true probe to keep the unprobed behavior (flag off / origin down
 * should not blank the card for a page that may well be fine).
 */
export async function selectServingLatestPremiere(
  pointer: LatestPremierePointer | null,
  archiveIndex: PremiereArchiveIndexSummary | null,
  probe: (premiereId: string) => Promise<boolean>,
): Promise<CoworldLeagueLatestPremiereCard | null> {
  const primary = resolveLatestRevealedPremiere(pointer, archiveIndex);
  if (primary === null) {
    return null;
  }
  if (await probe(primary.premiereId)) {
    return primary;
  }
  const pointerSourced =
    pointer !== null && primary.premiereId === pointer.premiereId;
  if (!pointerSourced) {
    return null;
  }
  const fallback = resolveLatestRevealedPremiere(null, archiveIndex);
  if (fallback === null || fallback.premiereId === primary.premiereId) {
    return null;
  }
  return (await probe(fallback.premiereId)) ? fallback : null;
}

/**
 * The battle-card premiere link for an episode, or null when the episode has
 * no REVEALED premiere. The join is the premiere loop's own deterministic id
 * derivation (premiereId = derivePremiereId(episodeRequestId)), so no mapping
 * state is needed and — because {@link revealedPremiereIdsFromArchiveIndex}
 * only ever returns post-reveal ids — a link can never point at a sealed
 * premiere.
 */
export function premiereHrefForEpisode(
  episodeRequestId: string,
  revealedPremiereIds: ReadonlySet<string>,
): string | null {
  const premiereId = derivePremiereId(episodeRequestId);
  return revealedPremiereIds.has(premiereId)
    ? `/premiere/${encodeURIComponent(premiereId)}`
    : null;
}

/**
 * Parses `drama-report.json` + `match-story.json` raw file contents into the
 * small `{dramaScore, entertainmentGrade}` summary `buildEpisodeRow`'s
 * `dramaEvidence` field carries — a small, additive, provenance-marked
 * projection, never the full reports
 * (neither `drama-report.json`/`.md` nor `match-story.json` is on
 * `ProxyWarPublicArtifacts.ts`'s public allowlist; only the derived scalar
 * pair here and the separate `match-recap.json` artifact are ever public).
 * Pure: callers own the actual file reads and ENOENT handling; this only
 * handles "the files exist but aren't well-formed" — malformed JSON, wrong
 * `reportKind`, or a non-finite score resolves to `null`. Requires BOTH
 * reports (they're written atomically together by
 * `CoworldLeagueMatchNarrativeBackfill.ts` — one existing without the other
 * means a torn write, never a valid partial evidence pair).
 */
export function parseMatchNarrativeSummary(
  dramaReportRaw: string,
  matchStoryRaw: string,
): { dramaScore: number; entertainmentGrade: string } | null {
  let dramaValue: unknown;
  let storyValue: unknown;
  try {
    dramaValue = JSON.parse(dramaReportRaw);
    storyValue = JSON.parse(matchStoryRaw);
  } catch {
    return null;
  }
  const dramaRecord = asRecord(dramaValue);
  const storyRecord = asRecord(storyValue);
  if (
    dramaRecord === null ||
    dramaRecord.reportKind !== "drama-and-tom-scorer" ||
    storyRecord === null
  ) {
    return null;
  }
  const dramaScore = asNumber(dramaRecord.dramaScore);
  const entertainmentGrade = asString(storyRecord.grade);
  if (dramaScore === null || dramaScore < 0 || entertainmentGrade === null) {
    return null;
  }
  return { dramaScore, entertainmentGrade };
}

/**
 * Parses `match-recap.json` raw content into just `curatedDramaScore` —
 * the PUBLIC "best battles" ranking input (see `AgentMatchRecap.ts`'s own
 * doc for the formula) — independent of `parseMatchNarrativeSummary`
 * above, so a run can carry a curated score even in the
 * `generated-recap-only` case (no `drama-report.json`/`match-story.json`
 * at all — see `CoworldLeagueMatchNarrativeBackfill.ts`'s doc for when
 * that happens). `null` whenever the recap is missing, unparseable, or
 * stamped with a `schemaVersion` older than
 * `AGENT_MATCH_RECAP_SCHEMA_VERSION` (a pre-curated-score artifact
 * awaiting `upgradeStaleRecap` — the SAME staleness rule
 * `recapNeedsRegeneration` already applies elsewhere) — never a
 * fabricated 0. A genuinely quiet match (curated pass found zero beats)
 * has no `match-recap.json` at all and also resolves to `null` here —
 * the caller cannot distinguish "quiet" from "not generated yet" from
 * this function alone, which is correct: only
 * `MatchNarrativeGenerationOutcome` (in-memory, same generation cycle)
 * knows which one actually happened.
 */
export function parseCuratedDramaScore(matchRecapRaw: string): number | null {
  let value: unknown;
  try {
    value = JSON.parse(matchRecapRaw);
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (
    record === null ||
    record.schemaVersion !== AGENT_MATCH_RECAP_SCHEMA_VERSION
  ) {
    return null;
  }
  const curatedDramaScore = asNumber(record.curatedDramaScore);
  if (curatedDramaScore === null || curatedDramaScore < 0) {
    return null;
  }
  return curatedDramaScore;
}

// ---------------------------------------------------------------------------
// Two-tier spectator-telemetry resolution for mirrored (hosted-league) runs,
// shared by every mirror-side match-narrative generator
// (`CoworldLeagueMatchNarrativeBackfill.ts`).
//
// The hosted replay payload carries `spectator-telemetry.json` — the FULL
// `SpectatorTelemetry` the origin's own `writeAgentLeagueRunArtifacts` built,
// verbatim. Privacy-safe packages omit `decisions.jsonl`; historical retained
// payloads may still contain it. `unpackEpisodeRunDir` writes every inline
// entry into the run dir unmodified, so the public telemetry is normally
// available as the strictly more faithful first-tier signal.
//
// For historical private mirror bundles only, `decisions.jsonl` remains a
// second-tier fallback when telemetry is missing or invalid. New public
// replays intentionally have no such fallback: missing telemetry is reported
// as an evidence gap, never repaired by re-exposing raw decision records.
// ---------------------------------------------------------------------------

/**
 * Tolerant parse + minimal shape validation of a mirrored run's
 * `spectator-telemetry.json` contents into the exact `SpectatorTelemetry`
 * shape a match-narrative generator expects. Deliberately light-touch — this
 * is the SAME producer's own trusted output, not third-party input — but
 * still guards against a torn/partial download or a future schema break:
 * requires `version === 1`, at least one agent, and every event carrying the
 * handful of fields the narrative generators and roster derivation actually
 * read.
 * Malformed or unparseable input resolves to `null`, never a throw.
 */
export function parseMirroredSpectatorTelemetry(
  raw: string,
): SpectatorTelemetry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (record === null || record.version !== 1) {
    return null;
  }
  const agents = asArray(record.agents);
  if (agents.length === 0) {
    return null;
  }
  const agentsValid = agents.every((agent) => {
    const entry = asRecord(agent);
    return (
      entry !== null &&
      typeof entry.agentID === "string" &&
      typeof entry.username === "string"
    );
  });
  const events = asArray(record.events);
  const eventsValid = events.every((event) => {
    const entry = asRecord(event);
    return (
      entry !== null &&
      typeof entry.turnNumber === "number" &&
      typeof entry.sequence === "number" &&
      typeof entry.importance === "number" &&
      typeof entry.kind === "string" &&
      typeof entry.actorAgentID === "string"
    );
  });
  if (!agentsValid || !eventsValid) {
    return null;
  }
  return record as unknown as SpectatorTelemetry;
}

function metadataRecord(
  value: unknown,
): Record<string, string | number | boolean | null> | undefined {
  const record = asRecord(value);
  if (record === null) {
    return undefined;
  }
  const projected: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean" ||
      entry === null
    ) {
      projected[key] = entry;
    }
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * Re-nests the ten structured-deal stamps `decisionLogEntry` hoists from
 * `record.decisionMetadata` onto top-level `DecisionLogEntry` keys back into
 * the `decisionMetadata` shape `addDealEvents` reads. Verbatim copy — the
 * seven narrative/identity string stamps plus `dealStatedReason`, and the
 * `dealApplyAccepted` / `dealSeparateSlot` booleans; wrong-typed keys are
 * dropped rather than mis-projected. `undefined` when the line carries no
 * deal stamp at all (any pre-deals or flag-OFF line), keeping those lines'
 * projection unchanged.
 */
function dealDecisionMetadata(
  record: Record<string, unknown>,
): Record<string, string | number | boolean | null> | undefined {
  const projected: Record<string, string | number | boolean | null> = {};
  const copyString = (key: string) => {
    const value = asString(record[key]);
    if (value !== null) {
      projected[key] = value;
    }
  };
  copyString("dealAction");
  copyString("dealID");
  copyString("dealTemplate");
  copyString("dealCounterpartyID");
  copyString("dealCounterpartyName");
  copyString("dealPublicText");
  // The acting agent's OWN stated reason: viewer-facing claim text, already
  // ASCII-cleaned, content-policy filtered and length-capped at its stamp
  // site, and re-sanitized again by the telemetry emit boundary this feeds.
  copyString("dealStatedReason");
  if (typeof record.dealApplyAccepted === "boolean") {
    projected.dealApplyAccepted = record.dealApplyAccepted;
  }
  // Without this, a deal applied through the diplomacy slot while the game
  // action was REJECTED loses addDealEvents' gate and its beat disappears
  // from the rebuilt replay even though the in-pod run showed it.
  if (typeof record.dealSeparateSlot === "boolean") {
    projected.dealSeparateSlot = record.dealSeparateSlot;
  }
  copyString("dealComplianceEvent");
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * Tolerant projection of one `decisions.jsonl` line (a `DecisionLogEntry` —
 * see `AgentDecisionLogWriter.ts`'s `decisionLogEntry`) back into the minimal
 * `AgentDecisionRecord` shape `buildAgentSpectatorTelemetry` reads. Every
 * field it actually consumes round-trips exactly; fields it never reads
 * (`observationSummary`, `decidedAt`, …) get inert placeholders since they
 * don't affect the derived event stream. `economyFacts` and the deal stamps
 * ride back verbatim (the deal keys re-nested under `decisionMetadata`, where
 * `addDealEvents` reads them) so economy/deal events survive mirror-side
 * rebuilds; both are optional and absent on lines stamped before they
 * existed. Malformed/incomplete lines resolve to `null` and are skipped by
 * the caller — one torn line never fails the whole derivation.
 */
function decisionRecordFromMirroredLogLine(
  value: unknown,
): AgentDecisionRecord | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const sequence = asNumber(record.sequence);
  const turnNumber = asNumber(record.turnNumber);
  const agentID = asString(record.agentID);
  const username = asString(record.username);
  const profile = asString(record.profile);
  const brainType = asString(record.brainType);
  const chosenActionID = asString(record.selectedLegalActionId);
  const chosenActionKind = asString(record.selectedActionKind);
  const result = asRecord(record.result);
  if (
    sequence === null ||
    turnNumber === null ||
    agentID === null ||
    username === null ||
    profile === null ||
    brainType === null ||
    chosenActionID === null ||
    chosenActionKind === null ||
    result === null
  ) {
    return null;
  }
  const auditAfter = asRecord(record.auditAfter);
  const playerID = auditAfter === null ? null : asString(auditAfter.playerID);
  const economyFacts = asRecord(record.economyFacts);
  const decisionMetadata = dealDecisionMetadata(record) ?? {};
  const runtimeMode = normalizeAgentRuntimeMode(record.runtimeMode);
  if (runtimeMode !== undefined) {
    decisionMetadata.runtimeMode = runtimeMode;
  }
  if (record.fallbackUsed === true) {
    decisionMetadata.fallbackUsed = true;
  }
  if (record.llmPlannerDegraded === true) {
    decisionMetadata.llmPlannerDegraded = true;
  }
  // The cause travels with the flag, or the mirrored artifact reproduces exactly
  // the ambiguity this field exists to remove.
  const degradedCause = asAgentDegradationCause(record.degradedCause);
  if (degradedCause !== undefined) {
    decisionMetadata.degradedCause = degradedCause;
  }
  const persistedAuditStatus = asString(record.auditStatus);
  const auditStatus: AgentActionAuditStatus =
    persistedAuditStatus === "confirmed" ||
    persistedAuditStatus === "unknown" ||
    persistedAuditStatus === "failed" ||
    persistedAuditStatus === "not_applicable"
      ? persistedAuditStatus
      : "unknown";
  return {
    sequence,
    gameID: "",
    agentID,
    clientID: null,
    username,
    profile: profile as AgentDecisionRecord["profile"],
    brainType: brainType as AgentDecisionRecord["brainType"],
    turnNumber,
    decidedAt: 0,
    decisionLatencyMs: 0,
    observationSummary: "",
    legalActionIDs: [],
    legalActionIDsByKind: {},
    attackActionIDs: [],
    chosenActionID,
    chosenActionKind: chosenActionKind as LegalActionKind,
    reason: boundedString(record.reason) ?? "",
    decisionMetadata:
      Object.keys(decisionMetadata).length > 0 ? decisionMetadata : undefined,
    chosenActionMetadata: metadataRecord(record.selectedActionMetadata),
    economyFacts:
      economyFacts === null
        ? undefined
        : (economyFacts as unknown as AgentDecisionRecord["economyFacts"]),
    intent: (record.generatedIntent ?? null) as AgentDecisionRecord["intent"],
    result: {
      accepted: result.accepted === true,
      reason: asString(result.reason) ?? "",
      submittedIntent: null,
    },
    audit: {
      auditStatus,
      auditReason: boundedString(record.auditReason) ?? "",
      ...(playerID === null
        ? {}
        : {
            after: {
              tick: null,
              playerID,
              isAlive: null,
              hasSpawned: null,
              tilesOwned: null,
              troops: null,
              gold: null,
              unitCounts: {},
              outgoingAttackTargetIDs: [],
              outgoingAllianceRequestRecipientIDs: [],
              outgoingEmbargoTargetIDs: [],
            },
          }),
    },
  };
}

export interface MirroredDecisionRecords {
  records: AgentDecisionRecord[];
  roster: AgentRunRosterEntry[];
}

/**
 * Tolerant per-line parse of a mirrored run's raw `decisions.jsonl` into the
 * minimal `AgentDecisionRecord[]`/roster `buildAgentSpectatorTelemetry` (and,
 * downstream, `buildAgentDramaReport`/`buildAgentMatchStory`, which require
 * `records` verbatim — neither accepts a pre-built `SpectatorTelemetry`)
 * reads. Roster is derived by first-seen dedup on `agentID` — the mirror has
 * no separate roster document for a hosted episode, but every field these
 * generators actually read off a roster entry (`username`, and — inertly,
 * never read by any of them — `profile`/`brainType`) already round-trips off
 * every decision line. Torn/malformed lines are skipped, never fatal; an
 * empty `records` array signals "nothing usable", handled by callers.
 */
export function agentDecisionRecordsFromMirroredDecisionsLog(
  raw: string,
): MirroredDecisionRecords {
  const records: AgentDecisionRecord[] = [];
  const rosterByAgentID = new Map<string, AgentRunRosterEntry>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = decisionRecordFromMirroredLogLine(parsed);
    if (record === null) {
      continue;
    }
    records.push(record);
    if (!rosterByAgentID.has(record.agentID)) {
      rosterByAgentID.set(record.agentID, {
        agentID: record.agentID,
        username: record.username,
        profile: record.profile,
        clientID: null,
        brainType: record.brainType,
      });
    }
  }
  return { records, roster: [...rosterByAgentID.values()] };
}

/**
 * Fallback tier: rebuilds an equivalent `SpectatorTelemetry` straight from a
 * mirrored run's raw `decisions.jsonl`, for the rarer case where
 * `spectator-telemetry.json` is missing or fails
 * {@link parseMirroredSpectatorTelemetry}'s validation. `null` only when NO
 * line parsed into a usable record.
 */
export function deriveSpectatorTelemetryFromDecisionsLog(
  raw: string,
  runID: string,
): SpectatorTelemetry | null {
  const { records, roster } = agentDecisionRecordsFromMirroredDecisionsLog(raw);
  if (records.length === 0) {
    return null;
  }
  return buildAgentSpectatorTelemetry({ runID, records, roster });
}

export interface ResolvedMirroredMatchEvidence {
  /** Which artifact the telemetry was actually built from — for logging/observability only, never published. */
  source: "spectator-telemetry" | "decisions-log";
  telemetry: SpectatorTelemetry;
  /**
   * Raw records reconstructed from `decisions.jsonl` — the REQUIRED,
   * unmodified-signature input `buildAgentDramaReport`/`buildAgentMatchStory`
   * need (neither accepts a pre-built `SpectatorTelemetry`).
   * oversize, or unparseable while `spectatorTelemetryRaw` still resolved —
   * a real, distinct evidence gap (not an error): a caller needing records
   * degrades honestly (e.g. recap-only) rather than fabricating them.
   */
  records: AgentDecisionRecord[];
  roster: AgentRunRosterEntry[];
  finalState: AgentRunFinalState | undefined;
}

/**
 * Shared two-tier telemetry/record resolution for every mirror-side,
 * post-hoc match-narrative generator (drama report, match story, match
 * recap): prefers the faithful `spectator-telemetry.json` tier and falls
 * back to `decisions.jsonl` derivation. Always ALSO resolves the raw
 * `decisions.jsonl` records (independent of which telemetry tier wins)
 * since `buildAgentDramaReport`/`buildAgentMatchStory` need them directly.
 * `null` only when NEITHER input is usable at all.
 */
export function resolveMirroredMatchEvidence(input: {
  runID: string;
  spectatorTelemetryRaw: string | null;
  decisionsJsonlRaw: string | null;
  /** Authoritative turn count when known (from `match-summary.json`'s own `finalState`), else `null` to fall back to the telemetry's own max event turn (honest `degraded: true`). */
  finalTurnCount: number | null;
}): ResolvedMirroredMatchEvidence | null {
  const finalState: AgentRunFinalState | undefined =
    input.finalTurnCount !== null && input.finalTurnCount > 0
      ? {
          phase: "final",
          tick: null,
          turnCount: input.finalTurnCount,
          players: [],
        }
      : undefined;

  const fromDecisionsLog =
    input.decisionsJsonlRaw !== null
      ? agentDecisionRecordsFromMirroredDecisionsLog(input.decisionsJsonlRaw)
      : { records: [], roster: [] };

  if (input.spectatorTelemetryRaw !== null) {
    const telemetry = parseMirroredSpectatorTelemetry(
      input.spectatorTelemetryRaw,
    );
    if (telemetry !== null) {
      return {
        source: "spectator-telemetry",
        telemetry,
        records: fromDecisionsLog.records,
        roster: telemetry.agents.map((agent) => ({
          agentID: agent.agentID,
          username: agent.username,
          profile: agent.profile as AgentRunRosterEntry["profile"],
          clientID: null,
          brainType: "external-http" as AgentRunRosterEntry["brainType"],
        })),
        finalState,
      };
    }
  }
  if (fromDecisionsLog.records.length > 0) {
    const telemetry = buildAgentSpectatorTelemetry({
      runID: input.runID,
      records: fromDecisionsLog.records,
      roster: fromDecisionsLog.roster,
    });
    return {
      source: "decisions-log",
      telemetry,
      records: fromDecisionsLog.records,
      roster: fromDecisionsLog.roster,
      finalState,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Season Zero Phase 2: the sampled match-state series (`AgentMatchStateSeries.ts`).
// ---------------------------------------------------------------------------

/**
 * Tolerant parse + minimal shape validation of a mirrored run's
 * `spectator-replay.json` into the exact shape `buildAgentMatchStateSeries`
 * reads (`snapshots[].turnNumber`/`players[]`) — same light-touch trust
 * level as {@link parseMirroredSpectatorTelemetry} (this producer's own
 * trusted output, guarded only against a torn download or future schema
 * break). Malformed/unparseable input resolves to `null`, never a throw.
 */
export function parseMirroredSpectatorReplay(
  raw: string,
): Pick<AgentSpectatorReplay, "snapshots"> | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const snapshots = asArray(record.snapshots);
  const snapshotsValid = snapshots.every((snapshot) => {
    const entry = asRecord(snapshot);
    if (entry === null || typeof entry.turnNumber !== "number") return false;
    const players = asArray(entry.players);
    return players.every((player) => {
      const playerEntry = asRecord(player);
      return (
        playerEntry !== null &&
        typeof playerEntry.playerID === "string" &&
        typeof playerEntry.tilesOwned === "number" &&
        typeof playerEntry.troops === "number" &&
        typeof playerEntry.isAlive === "boolean"
      );
    });
  });
  if (!snapshotsValid) {
    return null;
  }
  return record as unknown as Pick<AgentSpectatorReplay, "snapshots">;
}

/**
 * Tolerant parse + minimal shape validation of an already-generated
 * `match-state-series.json` — used by every downstream consumer (recap)
 * that reads the series back rather than rebuilding it.
 * Requires the current `MATCH_STATE_SERIES_SCHEMA_VERSION`; a stale or
 * malformed artifact resolves to `null` (read as "no series yet"), never a
 * throw and never silently trusted past a schema change.
 */
export function parseMirroredMatchStateSeries(
  raw: string,
): MatchStateSeries | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (
    record === null ||
    record.schemaVersion !== MATCH_STATE_SERIES_SCHEMA_VERSION ||
    record.source !== "spectator-replay-snapshots"
  ) {
    return null;
  }
  const samples = asArray(record.samples);
  const samplesValid = samples.every((sample) => {
    const entry = asRecord(sample);
    return (
      entry !== null &&
      typeof entry.turn === "number" &&
      Array.isArray(entry.agents)
    );
  });
  if (!samplesValid) {
    return null;
  }
  return record as unknown as MatchStateSeries;
}

/**
 * Resolves (generates fresh, never reads an existing file) the match-state
 * series for one mirrored run dir from its `spectator-replay.json` +
 * whichever telemetry tier resolves — thin wrapper over
 * `buildAgentMatchStateSeries`, used by
 * `CoworldLeagueMatchStateSeriesBackfill.ts`. `null` when the replay is
 * absent/unusable (never a fabricated series) — telemetry alone, unlike
 * every other mirror-side generator in this file, is NOT sufficient input
 * here (see `AgentMatchStateSeries.ts`'s "source decision": this artifact
 * is a re-projection of `spectator-replay.json` specifically, not derivable
 * from `decisions.jsonl` the way `SpectatorTelemetry` is).
 */
export function resolveMirroredMatchStateSeries(input: {
  runID: string;
  matchID: string;
  spectatorReplayRaw: string | null;
  spectatorTelemetryRaw: string | null;
  decisionsJsonlRaw: string | null;
  finalTurnCount: number | null;
}): MatchStateSeries | null {
  if (input.spectatorReplayRaw === null) {
    return null;
  }
  const replay = parseMirroredSpectatorReplay(input.spectatorReplayRaw);
  if (replay === null) {
    return null;
  }
  const evidence = resolveMirroredMatchEvidence({
    runID: input.runID,
    spectatorTelemetryRaw: input.spectatorTelemetryRaw,
    decisionsJsonlRaw: input.decisionsJsonlRaw,
    finalTurnCount: input.finalTurnCount,
  });
  return buildAgentMatchStateSeries({
    runID: input.runID,
    matchID: input.matchID,
    replay,
    telemetry: evidence?.telemetry ?? null,
  });
}
