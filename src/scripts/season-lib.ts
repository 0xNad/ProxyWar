import {
  addArchiveMatch,
  addEventSlot,
  addStandingsSnapshotRef,
  activateSeason,
  completeSeason,
  createSeason,
  defaultSeasonRegistryPath,
  isEventCurrentlyLive,
  loadSeasonRegistry,
  removeEventSlot,
  saveSeasonRegistry,
  withSeason,
  type SeasonMutationResult,
} from "../server/agents/season/SeasonRegistry";
import type { Season, SeasonEventSlot, SeasonRegistryFile } from "../server/agents/season/SeasonSchemas";
import {
  readFeaturedMatchStore,
  resolveFeaturedMatchStateRoot,
  type FeaturedMatch,
} from "../server/agents/FeaturedMatch";
import {
  findEventPackage,
  readEventPackageStore,
  resolveEventPackageStateRoot,
  type EventPackage,
} from "../server/agents/season/EventPackage";
import { isFeaturedEventRevealed, isPubliclyPromotable } from "../server/agents/season/EventPackageGate";

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

export interface SeasonRemoveEventOptions {
  seasonId: string;
  featuredMatchId: string;
}

/**
 * `season:remove-event` — the sanctioned counterpart to `add-event` that
 * never existed before this fix (Season Zero's re-activation had to drop
 * an aged-out slot via a hand-called `loadSeasonRegistry`/
 * `saveSeasonRegistry`, see `SEASON_ZERO_BASELINE.md`). Validated
 * (unknown season/slot handled cleanly, idempotent on an already-absent
 * slot — see `removeEventSlot`'s own doc) and refuses a slot whose event
 * is currently live/airing (`SeasonRegistry.isEventCurrentlyLive`) —
 * checked HERE, not inside the pure `removeEventSlot` mutation, because
 * it needs a `FeaturedMatch` lookup this otherwise season-registry-only
 * module never performs (see that function's own doc).
 */
export async function runSeasonRemoveEvent(
  options: SeasonRemoveEventOptions,
  registryPath = defaultSeasonRegistryPath(),
  featuredMatchStateRoot = resolveFeaturedMatchStateRoot(),
  now: () => Date = () => new Date(),
): Promise<SeasonCliResult> {
  const registry = await loadSeasonRegistry(registryPath);
  const season = registry.seasons.find((entry) => entry.id === options.seasonId);
  if (season === undefined) {
    return { ok: false, message: `season_not_found: ${options.seasonId}`, registryPath };
  }
  const slot = season.eventSlots.find((entry) => entry.featuredMatchId === options.featuredMatchId);
  if (slot !== undefined) {
    const featuredMatchStore = await readFeaturedMatchStore(featuredMatchStateRoot);
    const match = featuredMatchStore.matches.find((entry) => entry.matchId === options.featuredMatchId);
    if (match !== undefined && isEventCurrentlyLive(match, slot, now())) {
      return {
        ok: false,
        message: `event_currently_live: ${options.featuredMatchId} is currently airing (scheduledAt=${match.scheduledAt ?? slot.scheduledAt}) — refusing to remove; wait for it to reach revealed/archived/cancelled, or cancel the premiere first`,
        registryPath,
      };
    }
  }
  return applyMutation(registryPath, (reg) =>
    removeEventSlot(reg, options.seasonId, options.featuredMatchId, now().toISOString()),
  );
}

export interface SlotHealth {
  /** `false` when no `FeaturedMatch` record for this slot's `featuredMatchId` exists in the store at all — a dangling reference, distinct from "exists but incomplete". */
  matchFound: boolean;
  /** `EventPackageGate.isPubliclyPromotable(match, package).ok`. */
  promotable: boolean;
  /** `EventPackageGate.isFeaturedEventRevealed(match)` — archive lane is always aired; premiere lane once `revealed`/`archived`. */
  aired: boolean;
  /**
   * The slot's own programme date has already passed while the event
   * neither aired nor became promotable — the exact real-world shape
   * the Season Zero re-activation hit (`feat_21d64517e31863134746` "aged
   * out of the live standings window", `SEASON_ZERO_BASELINE.md`).
   * `false` for a slot whose event already aired or is still promotable,
   * and `false` for a future-dated slot that simply hasn't come due yet.
   */
  agedOut: boolean;
}

/** Pure per-slot health computation backing `season:status`'s health line — see `SlotHealth`'s own field docs. */
export function computeSlotHealth(
  slot: SeasonEventSlot,
  matches: readonly FeaturedMatch[],
  packages: readonly EventPackage[],
  now: Date,
): SlotHealth {
  const match = matches.find((entry) => entry.matchId === slot.featuredMatchId);
  if (match === undefined) {
    return { matchFound: false, promotable: false, aired: false, agedOut: false };
  }
  const pkg = findEventPackage({ schemaVersion: 1, packages: [...packages] }, slot.featuredMatchId);
  const aired = isFeaturedEventRevealed(match);
  const promotable = isPubliclyPromotable(match, pkg).ok;
  const scheduledAt = slot.scheduledAt ?? match.scheduledAt;
  const scheduledTime = scheduledAt === null ? NaN : Date.parse(scheduledAt);
  const isPastDue = !Number.isNaN(scheduledTime) && scheduledTime < now.getTime();
  const agedOut = isPastDue && !aired && !promotable;
  return { matchFound: true, promotable, aired, agedOut };
}

function renderSlotHealth(health: SlotHealth): string {
  if (!health.matchFound) return "featured match not found";
  return `promotable: ${health.promotable}, aired: ${health.aired}, aged-out: ${health.agedOut}`;
}

export function renderSeasonStatus(
  registry: SeasonRegistryFile,
  seasonId?: string,
  matches: readonly FeaturedMatch[] = [],
  packages: readonly EventPackage[] = [],
  now: Date = new Date(),
): string {
  const seasons = seasonId === undefined ? registry.seasons : registry.seasons.filter((s) => s.id === seasonId);
  if (seasons.length === 0) {
    return seasonId === undefined ? "(no seasons registered)" : `season_not_found: ${seasonId}`;
  }
  return seasons
    .map((season) => {
      const lines = [
        `${season.id} — "${season.title}" [${season.state}] ${season.startDate}..${season.endDate}`,
        `  event slots: ${season.eventSlots.length}`,
        ...season.eventSlots.flatMap((slot) => [
          `    - ${slot.featuredMatchId} @ ${slot.scheduledAt ?? "(unscheduled)"}`,
          `      health: ${renderSlotHealth(computeSlotHealth(slot, matches, packages, now))}`,
        ]),
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
  featuredMatchStateRoot = resolveFeaturedMatchStateRoot(),
  eventPackageStateRoot = resolveEventPackageStateRoot(),
  now: () => Date = () => new Date(),
): Promise<string> {
  const registry = await loadSeasonRegistry(registryPath);
  const [featuredMatchStore, eventPackageStore] = await Promise.all([
    readFeaturedMatchStore(featuredMatchStateRoot),
    readEventPackageStore(eventPackageStateRoot),
  ]);
  return renderSeasonStatus(registry, seasonId, featuredMatchStore.matches, eventPackageStore.packages, now());
}
