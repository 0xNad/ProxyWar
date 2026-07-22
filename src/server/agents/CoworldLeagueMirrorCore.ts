import type { AgentSpectatorReplay } from "./AgentSpectatorReplay";
import type {
  CoworldLeagueEpisodePlayerRow,
  CoworldLeagueEpisodeRow,
  CoworldLeagueRoundRow,
  CoworldLeagueStandingRow,
} from "./CoworldLeagueSiteWriter";

/**
 * Pure transforms from Coworld Observatory read-API JSON (as emitted by the
 * `coworld` CLI `--json` verbs) and hosted replay payloads into the league
 * mirror's site data. No IO here — the mirror script owns fetching.
 */

const housePolicyName = "proxywar-keystone";

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
      (substatus !== null && substatus !== "active") ||
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
    const ratingPolicyLabel = asString(row.policy_label) ?? "unknown policy";
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
  };
}

export function shortEpisodeId(episodeRequestId: string): string {
  const cleaned = episodeRequestId.replace(/^ereq_/, "").toLowerCase();
  const safe = cleaned.replace(/[^a-z0-9-]/g, "");
  return safe.slice(0, 8) === "" ? "episode" : safe.slice(0, 8);
}
