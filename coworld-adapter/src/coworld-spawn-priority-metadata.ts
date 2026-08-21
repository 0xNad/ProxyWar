import type { CoworldConfig } from "./no-docker-coworld-episode.ts";

export const MAX_COWORLD_PLAYER_ID_LENGTH = 128;

export interface CoworldSpawnPriorityMetadata {
  readonly ratedPlay: boolean;
  readonly episodeIndex: number;
  /** Immutable Coworld player ids aligned with config.players, or null for an unrated fixture. */
  readonly playerIDs: readonly string[] | null;
}

/**
 * Resolve the per-episode fairness contract before the game or any player
 * process starts. Tournament variants set rated_play=true in the manifest, so
 * a scheduler cannot silently obtain a rated result after omitting the dynamic
 * episode index or immutable player identities.
 */
export function coworldSpawnPriorityMetadataFromConfig(
  config: CoworldConfig,
): CoworldSpawnPriorityMetadata {
  if (
    config.rated_play !== undefined &&
    typeof config.rated_play !== "boolean"
  ) {
    throw new Error("Coworld rated_play must be a boolean when provided");
  }
  const ratedPlay = config.rated_play === true;
  const episodeIndex = config.episodeIndex;
  if (episodeIndex === undefined) {
    if (ratedPlay) {
      throw new Error(
        "Coworld rated play requires per-episode episodeIndex metadata",
      );
    }
  } else if (!Number.isSafeInteger(episodeIndex) || episodeIndex < 0) {
    throw new Error("Coworld episodeIndex must be a non-negative safe integer");
  }

  const playerIDs = config.player_ids;
  if (playerIDs === undefined) {
    if (ratedPlay) {
      throw new Error(
        "Coworld rated play requires immutable player_ids metadata",
      );
    }
    return {
      ratedPlay,
      episodeIndex: episodeIndex ?? 0,
      playerIDs: null,
    };
  }
  if (!Array.isArray(playerIDs)) {
    throw new Error("Coworld player_ids must be an array when provided");
  }
  if (playerIDs.length !== config.players.length) {
    throw new Error(
      `Coworld player_ids must align with players (${playerIDs.length} != ${config.players.length})`,
    );
  }
  const seen = new Set<string>();
  for (const playerID of playerIDs) {
    if (
      typeof playerID !== "string" ||
      playerID.length === 0 ||
      playerID.length > MAX_COWORLD_PLAYER_ID_LENGTH
    ) {
      throw new Error(
        `Coworld player_ids must be non-empty strings of at most ${MAX_COWORLD_PLAYER_ID_LENGTH} characters`,
      );
    }
    if (seen.has(playerID)) {
      throw new Error(
        "Coworld rated player_ids must be unique within an episode",
      );
    }
    seen.add(playerID);
  }
  return {
    ratedPlay,
    episodeIndex: episodeIndex ?? 0,
    playerIDs: [...playerIDs],
  };
}
