import { promises as fs } from "node:fs";
import path from "node:path";
import {
  SeasonRegistryFileSchema,
  SeasonSchema,
  seasonIdFromSlug,
  type Season,
  type SeasonEventSlot,
  type SeasonRegistryFile,
  type SeasonStandingsSnapshotRef,
  type SeasonState,
} from "./SeasonSchemas";

/**
 * Tracked, human-readable Season registry — see `SeasonSchemas.ts`'s own
 * doc for why this follows `IdentityRegistry.ts`'s tracked-file pattern
 * rather than `FeaturedMatch.ts`'s locked operational store. Lives under
 * `resources/season/` beside `resources/identity/`, the repo's existing
 * precedent for "small, curated, per-entity JSON an operator hand-edits
 * occasionally via a CLI, then commits."
 */
export const SEASON_REGISTRY_DIR_ENV = "PROXYWAR_SEASON_REGISTRY_DIR" as const;

/** Same `environment`/`cwd`-parameterized shape as `resolveIdentityRegistryDir`, so the default is unit-testable without touching `process.env` globally. */
export function resolveSeasonRegistryDir(
  environment: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = environment[SEASON_REGISTRY_DIR_ENV];
  if (configured !== undefined && configured !== "") {
    return path.resolve(cwd, configured);
  }
  return path.join(cwd, "resources", "season");
}

export const defaultSeasonRegistryDir = resolveSeasonRegistryDir();
export const defaultSeasonRegistryPath = (dir = defaultSeasonRegistryDir) =>
  path.join(dir, "seasons.json");

export class SeasonRegistryError extends Error {
  constructor(
    public readonly filePath: string,
    message: string,
  ) {
    super(`season registry error (${filePath}): ${message}`);
    this.name = "SeasonRegistryError";
  }
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * Reads the registry, returning an empty (schema-valid) file when it does
 * not exist yet — a fresh checkout or a test fixture directory that never
 * ran `season:create` is a normal cold start, not an error. A genuinely
 * corrupt/invalid file still throws loudly — same "never silently reset"
 * discipline `FeaturedMatch.ts`'s `readFeaturedMatchStore` documents.
 */
export async function loadSeasonRegistry(
  filePath = defaultSeasonRegistryPath(),
): Promise<SeasonRegistryFile> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { schemaVersion: 1, seasons: [] };
    }
    throw new SeasonRegistryError(
      filePath,
      `could not read registry file: ${(error as Error).message}`,
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new SeasonRegistryError(
      filePath,
      `not valid JSON: ${(error as Error).message}`,
    );
  }
  const parsed = SeasonRegistryFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new SeasonRegistryError(filePath, parsed.error.message);
  }
  return parsed.data;
}

/** Pretty-printed, trailing-newline JSON — matches `IdentityRegistry.ts`'s `serializeRegistryFile` so diffs stay reviewable. */
export async function saveSeasonRegistry(
  file: SeasonRegistryFile,
  filePath = defaultSeasonRegistryPath(),
): Promise<void> {
  const validated = SeasonRegistryFileSchema.parse(file);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}

export interface SeasonMutationOk {
  ok: true;
  season: Season;
}
export interface SeasonMutationError {
  ok: false;
  reason: string;
}
export type SeasonMutationResult = SeasonMutationOk | SeasonMutationError;

/**
 * Business-rule guard for `state` transitions — the zod schema itself only
 * validates the enum's SHAPE (any of the three strings parses), never
 * lifecycle order; that is this function's job, same split
 * `FeaturedMatch.ts` uses (schema shape vs. caller-enforced state-machine
 * order). Walks forward only, `completed` is terminal — mirrors the spec's
 * "clear beginning and end" framing.
 */
function canTransition(from: SeasonState, to: SeasonState): boolean {
  if (from === "draft" && to === "active") return true;
  if (from === "active" && to === "completed") return true;
  return false;
}

/** Creates a new draft Season. Fails if the slug (and therefore derived id) is already taken — seasons are never silently overwritten. */
export function createSeason(
  registry: SeasonRegistryFile,
  input: {
    slug: string;
    title: string;
    description: string;
    startDate: string;
    endDate: string;
  },
  now: string,
): SeasonMutationResult {
  const id = seasonIdFromSlug(input.slug);
  if (registry.seasons.some((season) => season.id === id)) {
    return { ok: false, reason: `season_already_exists: ${id}` };
  }
  const draft: Season = {
    schemaVersion: 1,
    id,
    slug: input.slug,
    title: input.title,
    description: input.description,
    startDate: input.startDate,
    endDate: input.endDate,
    state: "draft",
    eventSlots: [],
    archiveFeaturedMatchIds: [],
    standingsSnapshotRefs: [],
    createdAt: now,
    updatedAt: now,
  };
  const parsed = SeasonSchema.safeParse(draft);
  if (!parsed.success) {
    return { ok: false, reason: `invalid_season: ${parsed.error.message}` };
  }
  return { ok: true, season: parsed.data };
}

function requireSeason(
  registry: SeasonRegistryFile,
  id: string,
): Season | SeasonMutationError {
  const season = registry.seasons.find((entry) => entry.id === id);
  if (season === undefined) {
    return { ok: false, reason: `season_not_found: ${id}` };
  }
  return season;
}

function isError(value: Season | SeasonMutationError): value is SeasonMutationError {
  return "ok" in value;
}

/**
 * `draft -> active`. Also enforces "one active flagship programme at a
 * time" — the spec frames Season Zero as a single bounded programme;
 * nothing in this codebase's presentation surfaces is designed to render
 * two concurrently-active seasons, so this is a real invariant, not an
 * arbitrary restriction.
 */
export function activateSeason(
  registry: SeasonRegistryFile,
  id: string,
  now: string,
): SeasonMutationResult {
  const found = requireSeason(registry, id);
  if (isError(found)) return found;
  if (!canTransition(found.state, "active")) {
    return {
      ok: false,
      reason: `invalid_transition: cannot activate a season in state "${found.state}" (must be "draft")`,
    };
  }
  const alreadyActive = registry.seasons.find(
    (season) => season.id !== id && season.state === "active",
  );
  if (alreadyActive !== undefined) {
    return {
      ok: false,
      reason: `another_season_active: ${alreadyActive.id} is already active — complete it before activating another`,
    };
  }
  return { ok: true, season: { ...found, state: "active", updatedAt: now } };
}

/** `active -> completed`. */
export function completeSeason(
  registry: SeasonRegistryFile,
  id: string,
  now: string,
): SeasonMutationResult {
  const found = requireSeason(registry, id);
  if (isError(found)) return found;
  if (!canTransition(found.state, "completed")) {
    return {
      ok: false,
      reason: `invalid_transition: cannot complete a season in state "${found.state}" (must be "active")`,
    };
  }
  return { ok: true, season: { ...found, state: "completed", updatedAt: now } };
}

/**
 * Adds (or re-times) one flagship/highlight event slot. Never allowed once
 * a season is `completed` — a wrapped-up programme's schedule is final.
 * Re-adding an already-present `featuredMatchId` updates its `scheduledAt`
 * in place rather than duplicating the slot.
 */
export function addEventSlot(
  registry: SeasonRegistryFile,
  id: string,
  slot: Pick<SeasonEventSlot, "featuredMatchId" | "scheduledAt">,
  now: string,
): SeasonMutationResult {
  const found = requireSeason(registry, id);
  if (isError(found)) return found;
  if (found.state === "completed") {
    return {
      ok: false,
      reason: "season_completed: cannot add an event slot to a completed season",
    };
  }
  const withoutExisting = found.eventSlots.filter(
    (entry) => entry.featuredMatchId !== slot.featuredMatchId,
  );
  const eventSlots: SeasonEventSlot[] = [
    ...withoutExisting,
    { featuredMatchId: slot.featuredMatchId, scheduledAt: slot.scheduledAt, addedAt: now },
  ];
  const parsed = SeasonSchema.safeParse({ ...found, eventSlots, updatedAt: now });
  if (!parsed.success) {
    return { ok: false, reason: `invalid_season: ${parsed.error.message}` };
  }
  return { ok: true, season: parsed.data };
}

/** Folds one archive-lane `FeaturedMatch` id into this season's retrospective archive presentation — reference only, deduped. */
export function addArchiveMatch(
  registry: SeasonRegistryFile,
  id: string,
  featuredMatchId: string,
  now: string,
): SeasonMutationResult {
  const found = requireSeason(registry, id);
  if (isError(found)) return found;
  const archiveFeaturedMatchIds = found.archiveFeaturedMatchIds.includes(featuredMatchId)
    ? found.archiveFeaturedMatchIds
    : [...found.archiveFeaturedMatchIds, featuredMatchId];
  const parsed = SeasonSchema.safeParse({
    ...found,
    archiveFeaturedMatchIds,
    updatedAt: now,
  });
  if (!parsed.success) {
    return { ok: false, reason: `invalid_season: ${parsed.error.message}` };
  }
  return { ok: true, season: parsed.data };
}

/** Appends a reference to an official Coworld standings snapshot (`CoworldLeagueStandingsHistory.ts`) — never a score copy, see `SeasonStandingsSnapshotRefSchema`'s own doc. */
export function addStandingsSnapshotRef(
  registry: SeasonRegistryFile,
  id: string,
  ref: SeasonStandingsSnapshotRef,
  now: string,
): SeasonMutationResult {
  const found = requireSeason(registry, id);
  if (isError(found)) return found;
  if (found.standingsSnapshotRefs.some((entry) => entry.snapshotGeneratedAt === ref.snapshotGeneratedAt)) {
    return { ok: false, reason: `snapshot_already_referenced: ${ref.snapshotGeneratedAt}` };
  }
  const parsed = SeasonSchema.safeParse({
    ...found,
    standingsSnapshotRefs: [...found.standingsSnapshotRefs, ref],
    updatedAt: now,
  });
  if (!parsed.success) {
    return { ok: false, reason: `invalid_season: ${parsed.error.message}` };
  }
  return { ok: true, season: parsed.data };
}

/** Replaces one season by id in the registry file (upsert-by-id), used by every mutation CLI after computing the new record with one of the pure functions above. */
export function withSeason(
  registry: SeasonRegistryFile,
  season: Season,
): SeasonRegistryFile {
  const withoutExisting = registry.seasons.filter((entry) => entry.id !== season.id);
  return { ...registry, seasons: [...withoutExisting, season] };
}
