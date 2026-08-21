export interface RatedSpawnRoundVerification {
  ok: true;
  roundID: string;
  episodeCount: number;
  firstEpisodeIndex: number;
  lastEpisodeIndex: number;
  distinctOffsets: number;
  distinctAppliedOrders: number;
  algorithmVersion: string;
}

export function verifyRatedSpawnRound(
  episodeRows: unknown,
  resultByEpisodeID: Record<string, unknown>,
): RatedSpawnRoundVerification;
