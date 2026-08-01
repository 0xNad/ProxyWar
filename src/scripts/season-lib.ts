import {
  addArchiveMatch,
  addEventSlot,
  addStandingsSnapshotRef,
  activateSeason,
  completeSeason,
  createSeason,
  defaultSeasonRegistryPath,
  loadSeasonRegistry,
  saveSeasonRegistry,
  withSeason,
  type SeasonMutationResult,
} from "../server/agents/season/SeasonRegistry";
import type { Season, SeasonRegistryFile } from "../server/agents/season/SeasonSchemas";

/**
 * Shared load/mutate/save cycle for the five `season:*` operator CLIs
 * (product overhaul spec Season Zero activation prompt Phase 4 — "CLIs:
 * season:create/activate/complete/add-event/status"), mirroring
 * `premiere-schedule-lib.ts`'s "thin script wraps a shared lib" split so
 * the five entry scripts stay one function each.
 *
 * No file lock here (see `SeasonRegistry.ts`'s own doc for why): this is
 * tracked, git-reviewed content an operator edits occasionally through
 * one CLI invocation at a time, not a store multiple live processes race
 * to mutate.
 */
export function parseValueArg(argv: readonly string[], prefix: string): string | undefined {
  const arg = argv.find((entry) => entry.startsWith(prefix));
  return arg === undefined ? undefined : arg.slice(prefix.length);
}

export interface SeasonCliResult {
  ok: boolean;
  message: string;
  season?: Season;
  registryPath: string;
}

async function applyMutation(
  registryPath: string,
  mutate: (registry: SeasonRegistryFile) => SeasonMutationResult,
): Promise<SeasonCliResult> {
  const registry = await loadSeasonRegistry(registryPath);
  const result = mutate(registry);
  if (!result.ok) {
    return { ok: false, message: result.reason, registryPath };
  }
  await saveSeasonRegistry(withSeason(registry, result.season), registryPath);
  return {
    ok: true,
    message: `season ${result.season.id} saved (state: ${result.season.state})`,
    season: result.season,
    registryPath,
  };
}

export async function runSeasonCreate(
  options: {
    slug: string;
    title: string;
    description: string;
    startDate: string;
    endDate: string;
  },
  registryPath = defaultSeasonRegistryPath(),
  now: () => Date = () => new Date(),
): Promise<SeasonCliResult> {
  return applyMutation(registryPath, (registry) =>
    createSeason(registry, options, now().toISOString()),
  );
}

export async function runSeasonActivate(
  id: string,
  registryPath = defaultSeasonRegistryPath(),
  now: () => Date = () => new Date(),
): Promise<SeasonCliResult> {
  return applyMutation(registryPath, (registry) => activateSeason(registry, id, now().toISOString()));
}

export async function runSeasonComplete(
  id: string,
  registryPath = defaultSeasonRegistryPath(),
  now: () => Date = () => new Date(),
): Promise<SeasonCliResult> {
  return applyMutation(registryPath, (registry) => completeSeason(registry, id, now().toISOString()));
}

export interface SeasonAddEventOptions {
  seasonId: string;
  featuredMatchId: string;
  scheduledAt: string | null;
  /** When set, folds `featuredMatchId` into the season's archive refs instead of a scheduled event slot — for an already-published archive-lane `FeaturedMatch`. */
  archive?: boolean;
}

export async function runSeasonAddEvent(
  options: SeasonAddEventOptions,
  registryPath = defaultSeasonRegistryPath(),
  now: () => Date = () => new Date(),
): Promise<SeasonCliResult> {
  return applyMutation(registryPath, (registry) =>
    options.archive === true
      ? addArchiveMatch(registry, options.seasonId, options.featuredMatchId, now().toISOString())
      : addEventSlot(
          registry,
          options.seasonId,
          { featuredMatchId: options.featuredMatchId, scheduledAt: options.scheduledAt },
          now().toISOString(),
        ),
  );
}

export async function runSeasonAddStandingsSnapshot(
  seasonId: string,
  snapshotGeneratedAt: string,
  label: string,
  registryPath = defaultSeasonRegistryPath(),
  now: () => Date = () => new Date(),
): Promise<SeasonCliResult> {
  return applyMutation(registryPath, (registry) =>
    addStandingsSnapshotRef(
      registry,
      seasonId,
      { snapshotGeneratedAt, label },
      now().toISOString(),
    ),
  );
}

export function renderSeasonStatus(registry: SeasonRegistryFile, seasonId?: string): string {
  const seasons = seasonId === undefined ? registry.seasons : registry.seasons.filter((s) => s.id === seasonId);
  if (seasons.length === 0) {
    return seasonId === undefined ? "(no seasons registered)" : `season_not_found: ${seasonId}`;
  }
  return seasons
    .map((season) => {
      const lines = [
        `${season.id} — "${season.title}" [${season.state}] ${season.startDate}..${season.endDate}`,
        `  event slots: ${season.eventSlots.length}`,
        ...season.eventSlots.map(
          (slot) => `    - ${slot.featuredMatchId} @ ${slot.scheduledAt ?? "(unscheduled)"}`,
        ),
        `  archive matches: ${season.archiveFeaturedMatchIds.length}`,
        `  standings snapshot refs: ${season.standingsSnapshotRefs.length}`,
      ];
      return lines.join("\n");
    })
    .join("\n\n");
}

export async function runSeasonStatus(
  seasonId: string | undefined,
  registryPath = defaultSeasonRegistryPath(),
): Promise<string> {
  const registry = await loadSeasonRegistry(registryPath);
  return renderSeasonStatus(registry, seasonId);
}
