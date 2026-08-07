import type { CoworldConfig } from "./no-docker-coworld-episode.ts";

/**
 * The exact runtime derivation `runProxyWarEpisode` uses to populate
 * `AgentLeagueMatchOptions.episodeIndex` for the real
 * `new modules.AgentLeagueMatchRunner({...})` construction - split into this
 * side-effect-free sibling module (matching `coworld-seat-specs.ts` etc.)
 * because `no-docker-coworld-episode.ts` itself runs `main()` unconditionally
 * at import time and so cannot be imported directly by a unit test.
 */
export function episodeIndexFromConfig(config: CoworldConfig): number {
  return config.episodeIndex ?? 0;
}
