import { coworldSpawnPriorityMetadataFromConfig } from "./coworld-spawn-priority-metadata.ts";
import type { CoworldConfig } from "./no-docker-coworld-episode.ts";

/**
 * The exact runtime derivation `runProxyWarEpisode` uses to populate
 * `AgentLeagueMatchOptions.episodeIndex` for the real
 * `new modules.AgentLeagueMatchRunner({...})` construction - split into this
 * side-effect-free sibling module (matching `coworld-seat-specs.ts` etc.)
 * because `no-docker-coworld-episode.ts` itself runs `main()` unconditionally
 * at import time and so cannot be imported directly by a unit test.
 * Competition commissioners stamp a consecutive episode ordinal within a
 * same-variant recurrence block. Rated play rejects an omitted ordinal; only
 * explicitly unrated local/certification fixtures retain the legacy zero.
 */
export function episodeIndexFromConfig(config: CoworldConfig): number {
  return coworldSpawnPriorityMetadataFromConfig(config).episodeIndex;
}
