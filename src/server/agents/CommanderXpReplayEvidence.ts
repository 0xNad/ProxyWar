import { createHash } from "node:crypto";

import { sha256Canonical } from "./CommanderXpProtocol";

export function commanderXpReplayEvidenceProjection(
  replayURL: string,
  xp: Record<string, unknown>,
  projectedResults: Record<string, unknown> | null,
  bytes: Uint8Array,
): Record<string, unknown> {
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024 * 1024) {
    throw new Error("XP replay byte length is invalid");
  }
  const raw = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as Record<string, unknown>;
  const config = publicReplayConfig(raw.config);
  const replayResults =
    projectedResults === null ? null : publicReplayResults(raw.results);
  return {
    schemaVersion: 2,
    xpRequestID: xp.xpRequestID,
    episodeRequestID: xp.episodeRequestID,
    jobID: xp.jobID,
    episodeID: xp.episodeID,
    replayPath: xp.replayPath,
    replayURLSha256: xp.replayURLSha256,
    contentSha256: sha256(bytes),
    byteLength: bytes.byteLength,
    sourceSchemaVersion: raw.schemaVersion,
    replayKind: raw.replayKind,
    runID: raw.runID,
    matchID: raw.matchID,
    config,
    configSha256: sha256Canonical(config),
    results: replayResults,
    resultsSha256:
      replayResults === null ? null : sha256Canonical(replayResults),
  };
}

function publicReplayConfig(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("XP replay config is invalid");
  }
  const input = value as Record<string, unknown>;
  const projection = Object.fromEntries(
    [
      "commander_xp_phase",
      "commander_xp_run_key",
      "max_decision_steps",
      "turns_per_decision_step",
      "max_decision_ms",
      "map",
      "map_size",
      "difficulty",
      "seed",
      "episodeIndex",
      "replay_tail_turns",
      "player_connect_timeout_seconds",
      "player_count",
      "num_agents",
      "episode_timeout_seconds",
    ].flatMap((key) => (key in input ? [[key, input[key]]] : [])),
  );
  if ("players" in input) {
    if (!Array.isArray(input.players) || input.players.length !== 4) {
      throw new Error("XP replay config players are invalid");
    }
    projection.players = input.players.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("XP replay config player is invalid");
      }
      return { name: (entry as Record<string, unknown>).name };
    });
  }
  return projection;
}

function publicReplayResults(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("XP replay results are invalid");
  }
  const raw = value as Record<string, unknown>;
  const players = Array.isArray(raw.players) ? raw.players : [];
  return {
    schemaVersion: 2,
    gameID: raw.game_id,
    seed: raw.seed,
    scores: raw.scores,
    winnerSlot: raw.winner_slot,
    turnCount: raw.turn_count,
    tick: raw.tick,
    decisionCount: raw.decision_count,
    acceptedDecisionCount: raw.accepted_decision_count,
    fallbackCount: raw.fallback_count,
    degradedCount: raw.degraded_count,
    players: players.map((entry) => {
      const player = entry as Record<string, unknown>;
      return {
        slot: player.slot,
        name: player.name,
        score: player.score,
        tilesOwned: player.tiles_owned,
        isAlive: player.is_alive,
      };
    }),
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
