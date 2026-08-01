import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PREMIERE_ID_PATTERN } from "../replay-premiere/ReplayPremiereContracts";
import type { CoworldLeaguePremiereCard } from "./CoworldLeagueSiteWriter";

/**
 * Premiere-by-default league-mirror suppression contract (v1).
 *
 * This is the shared, fail-OPEN contract between the read-only Coworld league
 * mirror (`src/scripts/coworld-league-mirror.ts`) and — in Phase 2 — the
 * replay-premiere loop. The premiere loop atomically WRITES the contract to
 * declare which just-finished episodes it has claimed for a sealed premiere;
 * the mirror READS it and suppresses those episodes so the league page never
 * spoils a premiere before its reveal.
 *
 * Availability invariant (the single most important property here): the mirror
 * must degrade to *exactly today's behavior* whenever the contract is missing,
 * corrupt, from an unknown future version, or stale. Suppression is a
 * best-effort spoiler shield layered on top of an availability-first mirror,
 * never a new way to freeze or hide the league. Every non-usable state resolves
 * to `{ status: "stale", reason }` with a machine-readable reason for logging,
 * and every predicate returns the non-suppressing answer for a stale state.
 *
 * Since 2026-07-22 ("every round is premiere" operator directive) the loop
 * heartbeats a STANDING contract every live tick — zero holds is valid — so the
 * blanket `quarantineMs` defers every freshly-completed episode until the loop
 * has decided whether to premiere it. The operator explicitly accepted the
 * ~12-minute battle-card lag this creates, reversing the earlier suppression
 * reviewer requirement #4 ("never write a zero-hold active contract"). The
 * fail-open availability invariant above is unchanged and remains the load-
 * bearing safety property.
 */

export const PREMIERE_SUPPRESSION_SCHEMA_VERSION = 1 as const;

/**
 * A contract older than this is treated as stale (fail open). Bounds how long a
 * crashed/hung premiere loop can keep the mirror suppressing episodes: once the
 * loop stops refreshing `generatedAt`, suppression lifts automatically.
 */
export const PREMIERE_SUPPRESSION_STALE_MS = 15 * 60 * 1000;

/**
 * A contract whose `generatedAt` is further in the FUTURE than this is also
 * treated as stale (fail open). The staleness bound above only catches old
 * timestamps; without this a hung loop that wrote a future/clock-skewed
 * `generatedAt` and then stopped refreshing would keep suppressing until real
 * time crossed `generatedAt + STALE_MS`, defeating the safety net. A small skew
 * tolerates benign host/loop clock drift.
 */
export const PREMIERE_SUPPRESSION_MAX_CLOCK_SKEW_MS = 2 * 60 * 1000;

/**
 * Default blanket quarantine window a producer should write. Freshly-completed
 * episodes are deferred (not published) for this long so a premiere claim has
 * time to land before the episode is ever shown.
 */
export const PREMIERE_SUPPRESSION_DEFAULT_QUARANTINE_MS = 12 * 60 * 1000;

export interface PremiereSuppressionHold {
  episodeRequestId: string;
  premiereId: string;
  roundId: string | null;
  roundNumber: number | null;
  /** ISO timestamp the premiere is/was scheduled to reveal at. */
  scheduledAt: string;
  /** ISO timestamp after which this hold no longer suppresses (hard bound). */
  holdExpiresAt: string;
  premierePageLive: boolean;
  mapLabel: string;
}

export interface PremiereSuppressionContract {
  schemaVersion: typeof PREMIERE_SUPPRESSION_SCHEMA_VERSION;
  generatedAt: string;
  quarantineMs: number;
  holds: PremiereSuppressionHold[];
}

export type PremiereSuppressionStaleReason =
  | "not_configured"
  | "missing_file"
  | "unreadable_file"
  | "invalid_json"
  | "not_an_object"
  | "unknown_schema_version"
  | "invalid_generated_at"
  | "stale_generated_at"
  | "future_generated_at"
  | "invalid_quarantine_ms"
  | "invalid_holds";

/**
 * Loaded contract state. `active` is the only state that can suppress; every
 * `stale` state means "behave exactly as today" and carries a reason.
 */
export type PremiereSuppressionState =
  | {
      status: "active";
      contract: PremiereSuppressionContract;
      generatedAtMs: number;
    }
  | { status: "stale"; reason: PremiereSuppressionStaleReason };

export type EpisodeSuppressionDecision = "held" | "quarantined" | "publish";

/** Minimal shape both hosted metas and rendered episode rows satisfy. */
export interface SuppressibleEpisode {
  episodeRequestId: string;
  completedAt: string | null;
}

export function premiereSuppressionStorageStateDir(): string {
  const configured = process.env.PROXYWAR_STORAGE_STATE_DIR;
  return configured !== undefined && configured.length > 0
    ? configured
    : path.join(os.homedir(), "Library/Application Support/ProxyWar/storage");
}

/**
 * Canonical contract path. Never hardcode this string elsewhere — resolve it
 * through this helper so the storage-state-dir override stays a single knob.
 */
export function premiereSuppressionContractPath(
  stateDir: string = premiereSuppressionStorageStateDir(),
): string {
  return path.join(stateDir, "premiere-suppression", "contract-v1.json");
}

function staleState(
  reason: PremiereSuppressionStaleReason,
): PremiereSuppressionState {
  return { status: "stale", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseHold(value: unknown): PremiereSuppressionHold | null {
  if (!isRecord(value)) {
    return null;
  }
  const {
    episodeRequestId,
    premiereId,
    roundId,
    roundNumber,
    scheduledAt,
    holdExpiresAt,
    premierePageLive,
    mapLabel,
  } = value;
  if (
    typeof episodeRequestId !== "string" ||
    episodeRequestId.length === 0 ||
    typeof premiereId !== "string" ||
    premiereId.length === 0 ||
    typeof scheduledAt !== "string" ||
    parseIsoMs(scheduledAt) === null ||
    typeof holdExpiresAt !== "string" ||
    parseIsoMs(holdExpiresAt) === null ||
    typeof premierePageLive !== "boolean" ||
    typeof mapLabel !== "string"
  ) {
    return null;
  }
  if (roundId !== null && typeof roundId !== "string") {
    return null;
  }
  if (
    roundNumber !== null &&
    (typeof roundNumber !== "number" || !Number.isFinite(roundNumber))
  ) {
    return null;
  }
  return {
    episodeRequestId,
    premiereId,
    roundId: roundId ?? null,
    roundNumber: roundNumber ?? null,
    scheduledAt,
    holdExpiresAt,
    premierePageLive,
    mapLabel,
  };
}

/**
 * Tolerant parse of a raw contract string. Structural problems fail OPEN with a
 * reason; individual malformed hold entries inside an otherwise-valid array are
 * dropped rather than failing the whole contract.
 */
export function parsePremiereSuppressionContract(
  raw: string,
  now: Date,
): PremiereSuppressionState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return staleState("invalid_json");
  }
  if (!isRecord(value)) {
    return staleState("not_an_object");
  }
  if (value.schemaVersion !== PREMIERE_SUPPRESSION_SCHEMA_VERSION) {
    return staleState("unknown_schema_version");
  }
  const generatedAtMs = parseIsoMs(value.generatedAt);
  if (generatedAtMs === null) {
    return staleState("invalid_generated_at");
  }
  if (now.getTime() - generatedAtMs >= PREMIERE_SUPPRESSION_STALE_MS) {
    return staleState("stale_generated_at");
  }
  if (generatedAtMs - now.getTime() > PREMIERE_SUPPRESSION_MAX_CLOCK_SKEW_MS) {
    return staleState("future_generated_at");
  }
  if (
    typeof value.quarantineMs !== "number" ||
    !Number.isFinite(value.quarantineMs) ||
    value.quarantineMs < 0
  ) {
    return staleState("invalid_quarantine_ms");
  }
  if (!Array.isArray(value.holds)) {
    return staleState("invalid_holds");
  }
  const holds: PremiereSuppressionHold[] = [];
  for (const entry of value.holds) {
    const hold = parseHold(entry);
    if (hold !== null) {
      holds.push(hold);
    }
  }
  return {
    status: "active",
    contract: {
      schemaVersion: PREMIERE_SUPPRESSION_SCHEMA_VERSION,
      generatedAt: value.generatedAt as string,
      quarantineMs: value.quarantineMs,
      holds,
    },
    generatedAtMs,
  };
}

/**
 * Load and parse the contract file, resolving every failure to a stale state.
 * A missing file (the Phase-1 production reality) is the expected happy path
 * for "no suppression".
 */
export async function loadPremiereSuppressionContract(
  contractPath: string,
  now: Date = new Date(),
): Promise<PremiereSuppressionState> {
  let raw: string;
  try {
    raw = await fs.readFile(contractPath, "utf8");
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return staleState("missing_file");
    }
    return staleState("unreadable_file");
  }
  return parsePremiereSuppressionContract(raw, now);
}

export function createPremiereSuppressionContract(input: {
  generatedAt?: string;
  quarantineMs?: number;
  holds: PremiereSuppressionHold[];
}): PremiereSuppressionContract {
  return {
    schemaVersion: PREMIERE_SUPPRESSION_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    quarantineMs:
      input.quarantineMs ?? PREMIERE_SUPPRESSION_DEFAULT_QUARANTINE_MS,
    holds: input.holds,
  };
}

/**
 * Atomically write a contract (mkdir -p + temp file + rename). Phase 2 uses
 * this from the premiere loop; the mirror never writes.
 */
export async function writePremiereSuppressionContract(
  contractPath: string,
  contract: PremiereSuppressionContract,
): Promise<void> {
  await fs.mkdir(path.dirname(contractPath), { recursive: true });
  const temporaryPath = `${contractPath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(contract, null, 2)}\n`;
  try {
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, contractPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Hard availability bound: an episode is held only while an unexpired hold
 * names it. Once `now >= holdExpiresAt`, the episode is NOT held and normal
 * publication resumes even if the contract otherwise looks active.
 */
export function isHeld(
  state: PremiereSuppressionState,
  episodeRequestId: string,
  now: Date,
): boolean {
  if (state.status !== "active") {
    return false;
  }
  const nowMs = now.getTime();
  return state.contract.holds.some((hold) => {
    if (hold.episodeRequestId !== episodeRequestId) {
      return false;
    }
    const expiresMs = parseIsoMs(hold.holdExpiresAt);
    return expiresMs !== null && nowMs < expiresMs;
  });
}

/**
 * Blanket freshness quarantine: an episode that completed more recently than
 * `quarantineMs` is deferred so a premiere claim can still land. This is the
 * pure time-window component; callers apply {@link isHeld} first so a held
 * episode is classified "held", never merely "quarantined".
 */
export function isQuarantined(
  state: PremiereSuppressionState,
  episodeCompletedAt: string | null,
  now: Date,
): boolean {
  if (state.status !== "active") {
    return false;
  }
  const completedMs = parseIsoMs(episodeCompletedAt);
  if (completedMs === null) {
    return false;
  }
  return now.getTime() - completedMs < state.contract.quarantineMs;
}

/**
 * Held dominates quarantine dominates publish. A stale state always publishes,
 * which is what makes the mirror byte-identical when no usable contract exists.
 */
export function classifyEpisodeSuppression(
  state: PremiereSuppressionState,
  episode: SuppressibleEpisode,
  now: Date,
): EpisodeSuppressionDecision {
  if (state.status !== "active") {
    return "publish";
  }
  if (isHeld(state, episode.episodeRequestId, now)) {
    return "held";
  }
  if (isQuarantined(state, episode.completedAt, now)) {
    return "quarantined";
  }
  return "publish";
}

/**
 * Final-defense filter over the MERGED episode list. `mergeEpisodeRows` retains
 * previously-published cards, so a card published before a premiere claim must
 * be dropped here or it survives into `data.json`. Drops held (spoiler-
 * critical) and quarantined (freshness deferral) rows; returns the input
 * unchanged for a stale state.
 */
export function filterSuppressedEpisodeRows<T extends SuppressibleEpisode>(
  state: PremiereSuppressionState,
  episodes: readonly T[],
  now: Date,
): T[] {
  if (state.status !== "active") {
    return [...episodes];
  }
  return episodes.filter(
    (episode) => classifyEpisodeSuppression(state, episode, now) === "publish",
  );
}

/**
 * Pick the single hold to surface on the league page, or null when nothing is
 * currently premiering. Only unexpired holds are eligible; a live premiere
 * outranks a scheduled one, then earliest schedule, then premiere id for
 * determinism.
 */
export function selectDisplayHold(
  state: PremiereSuppressionState,
  now: Date,
): PremiereSuppressionHold | null {
  if (state.status !== "active") {
    return null;
  }
  const nowMs = now.getTime();
  const active = state.contract.holds.filter((hold) => {
    const expiresMs = parseIsoMs(hold.holdExpiresAt);
    return expiresMs !== null && nowMs < expiresMs;
  });
  if (active.length === 0) {
    return null;
  }
  return [...active].sort((left, right) => {
    if (left.premierePageLive !== right.premierePageLive) {
      return left.premierePageLive ? -1 : 1;
    }
    const leftScheduled =
      parseIsoMs(left.scheduledAt) ?? Number.MAX_SAFE_INTEGER;
    const rightScheduled =
      parseIsoMs(right.scheduledAt) ?? Number.MAX_SAFE_INTEGER;
    if (leftScheduled !== rightScheduled) {
      return leftScheduled - rightScheduled;
    }
    return left.premiereId.localeCompare(right.premiereId);
  })[0];
}

/**
 * Build the spoiler-safe league-page premiere card from contract fields ONLY.
 * By construction the result carries no episodeRequestId, run id, player name,
 * or outcome — the narrow return type is the guarantee. Returns null for a
 * stale state so `data.premiere` stays omitted (byte-identical mirror output).
 */
export function buildPremiereSiteBlock(
  state: PremiereSuppressionState,
  now: Date,
): CoworldLeaguePremiereCard | null {
  const hold = selectDisplayHold(state, now);
  if (hold === null) {
    return null;
  }
  return {
    premiereId: hold.premiereId,
    roundNumber: hold.roundNumber,
    mapLabel: hold.mapLabel,
    scheduledAt: hold.scheduledAt,
    premierePageLive: hold.premierePageLive,
  };
}

// ---------------------------------------------------------------------------
// Latest-revealed-premiere pointer (loop writes, mirror reads)
// ---------------------------------------------------------------------------

export const LATEST_PREMIERE_POINTER_SCHEMA_VERSION = 1 as const;

/**
 * Byte ceiling for tolerant pointer reads. A valid pointer is a few hundred
 * bytes; anything larger is treated as absent rather than parsed.
 */
export const LATEST_PREMIERE_POINTER_MAX_BYTES = 64 * 1024;

/** mapLabel values beyond this are treated as malformed (fail open). */
const LATEST_PREMIERE_POINTER_MAX_MAP_LABEL_LENGTH = 200;

/**
 * Small pointer the premiere loop rewrites atomically each time a hold is
 * released with outcome `revealed` — and ONLY then, so between premieres it
 * always names the most recent premiere whose outcome is already public. The
 * league mirror renders it as the compact "Latest premiere" card whenever no
 * live premiere card is showing. Every field is reveal-public: roundNumber and
 * mapLabel were on the live league card during the premiere, and revealedAt is
 * when the public reveal happened. Deliberately NO winner/outcome fields.
 */
export interface LatestPremierePointer {
  schemaVersion: typeof LATEST_PREMIERE_POINTER_SCHEMA_VERSION;
  premiereId: string;
  roundNumber: number | null;
  mapLabel: string;
  /** ISO timestamp of the public reveal. */
  revealedAt: string;
}

/**
 * Canonical pointer path — next to the suppression contract, resolved through
 * the same storage-state-dir knob. Never hardcode this string elsewhere.
 */
export function latestPremierePointerPath(
  stateDir: string = premiereSuppressionStorageStateDir(),
): string {
  return path.join(stateDir, "premiere-suppression", "latest-premiere.json");
}

/**
 * Tolerant parse of a raw pointer file. Any structural or field problem —
 * bad JSON, wrong schema version, malformed premiere id, unparseable
 * revealedAt, non-finite roundNumber, non-string/oversized mapLabel — yields
 * null (card simply absent), never a throw and never a partial pointer.
 */
export function parseLatestPremierePointer(
  raw: string,
): LatestPremierePointer | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (value.schemaVersion !== LATEST_PREMIERE_POINTER_SCHEMA_VERSION) {
    return null;
  }
  const { premiereId, roundNumber, mapLabel, revealedAt } = value;
  if (typeof premiereId !== "string" || !PREMIERE_ID_PATTERN.test(premiereId)) {
    return null;
  }
  if (typeof revealedAt !== "string" || parseIsoMs(revealedAt) === null) {
    return null;
  }
  if (
    roundNumber !== null &&
    (typeof roundNumber !== "number" || !Number.isFinite(roundNumber))
  ) {
    return null;
  }
  if (
    typeof mapLabel !== "string" ||
    mapLabel.length > LATEST_PREMIERE_POINTER_MAX_MAP_LABEL_LENGTH
  ) {
    return null;
  }
  return {
    schemaVersion: LATEST_PREMIERE_POINTER_SCHEMA_VERSION,
    premiereId,
    roundNumber: roundNumber ?? null,
    mapLabel,
    revealedAt,
  };
}

/**
 * Load the pointer file, resolving EVERY failure mode — missing (the normal
 * pre-first-reveal state), unreadable, not a regular file, over the byte
 * ceiling, malformed — to null. Fail-open: a bad pointer only costs the league
 * page its latest-premiere card, never a publication stall.
 */
export async function loadLatestPremierePointer(
  pointerPath: string,
): Promise<LatestPremierePointer | null> {
  try {
    const pointerStat = await fs.stat(pointerPath);
    if (
      !pointerStat.isFile() ||
      pointerStat.size > LATEST_PREMIERE_POINTER_MAX_BYTES
    ) {
      return null;
    }
    return parseLatestPremierePointer(await fs.readFile(pointerPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Atomically write the pointer (mkdir -p + temp file + rename), the same
 * pattern as {@link writePremiereSuppressionContract}. The premiere loop is
 * the only writer; the mirror only reads.
 */
export async function writeLatestPremierePointer(
  pointerPath: string,
  pointer: LatestPremierePointer,
): Promise<void> {
  await fs.mkdir(path.dirname(pointerPath), { recursive: true });
  const temporaryPath = `${pointerPath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = `${JSON.stringify(pointer, null, 2)}\n`;
  try {
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, pointerPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
