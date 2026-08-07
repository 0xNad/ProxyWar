import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { withFileMutex } from "./FileMutex";

/**
 * The typed, persisted model for Stage 3's editorial layer (product
 * overhaul spec Stage 3 item 1): a curated selection of matches turned
 * into events, distinct from the continuous league standings/archive.
 *
 * Two lanes, NEVER mixed (spec item 2) — enforced by the `lane` +
 * `state` combination, not by convention:
 *
 * - `"premiere"` lane: a SEALED, UNPUBLISHED match from the existing
 *   premiere queue (`premiere-queue-lib.sh`'s `ready/` directory).
 *   `state` walks scheduled -> published -> (a future turn's admission
 *   flips it toward revealed/archived) or -> cancelled. `queueItemName`
 *   is set; `episodeRequestId` is set once the queue item's own
 *   `meta.json` carries one (rated-Coworld sourced items do; a
 *   generated exhibition-only item may not).
 * - `"archive"` lane: a COMPLETED, ALREADY-PUBLISHED league match
 *   selected for Featured Archive placement (Stage 5/6). These are
 *   NEVER premiered — `state` is
 *   always `"published"` from creation (there is no unpublished state
 *   for an archive-lane record: the underlying match was already public
 *   before this record existed), and `scheduledAt`/`revealAt` are
 *   always `null`. Results are UI-gated ("Reveal result"), never
 *   embargoed — see `result`'s own doc.
 *
 * `result` is the ONE field under a real presentation embargo (spec
 * item 5): for a premiere-lane record, it MUST stay `null` until this
 * turn's future counterpart actually reveals the underlying premiere —
 * `buildProxyWarPublicReadModel`-style projections must never read a
 * populated `result` off an unrevealed premiere-lane record into the
 * public read model. Archive-lane `result` may be populated immediately
 * at creation (the match is already public) — the read model's OWN
 * projection is what UI-gates it behind "Reveal result", not an
 * embargo on this store.
 */

export const FeaturedMatchLaneSchema = z.enum(["premiere", "archive"]);
export type FeaturedMatchLane = z.infer<typeof FeaturedMatchLaneSchema>;

/** Walks forward only; `cancelled` is terminal and reachable from `scheduled`/`published` (premiere lane only — see class doc). */
export const FeaturedMatchStateSchema = z.enum([
  "candidate",
  "scheduled",
  "published",
  "revealed",
  "archived",
  "cancelled",
]);
export type FeaturedMatchState = z.infer<typeof FeaturedMatchStateSchema>;

/**
 * Only ever set when the evidence genuinely supports the specific claim
 * (spec item 1: "only when data supports the claim") — every writer in
 * this codebase that sets `category` must be able to point at the exact
 * field(s) that justified it; there is no "reasonable guess" category.
 */
export const FeaturedMatchCategorySchema = z.enum([
  "top_four",
  "champion_vs_challengers",
  "version_debut",
  "rivalry",
  "builder_showcase",
  "open_source_challenge",
  "notable_league_battle",
]);
export type FeaturedMatchCategory = z.infer<typeof FeaturedMatchCategorySchema>;

/**
 * A participant reference by STABLE identity — Agent/AgentVersion/Builder
 * ids from the identity registry, never a raw Coworld player name alone
 * (that stays available for the join, per `playerName`, but is never the
 * primary key here — see the "three identities" rule, spec §3). `agentId`/
 * `agentVersionId`/`builderId` are `null` when the identity registry has
 * no match yet (an unregistered/unclaimed participant) — never fabricated.
 */
export const FeaturedMatchParticipantSchema = z.object({
  playerName: z.string(),
  agentId: z.string().nullable(),
  agentVersionId: z.string().nullable(),
  builderId: z.string().nullable(),
});
export type FeaturedMatchParticipant = z.infer<
  typeof FeaturedMatchParticipantSchema
>;

/**
 * Every signal `premiere:candidates`/`feature:candidates` may rank on,
 * ALWAYS present with an explicit null/false rather than an absent key —
 * this is the "inspectable evidence" the spec's acceptance criteria
 * require, and its shape doubles as the CLI table's column set. Drama/
 * story scores are frequently unavailable and that is expected, not an
 * error: `AgentDramaReport`/`AgentMatchStory` require per-turn decision
 * records, which sealed premiere-queue bundles never retain past sealing
 * (`generate-premiere-queue.sh` deletes them once `bundle.source.json` is
 * built) and hosted league episodes never download in the first place
 * (`decisions.jsonl` stays private/server-side on Coworld's own
 * infrastructure). A candidate with `dramaScore: null` is not degraded —
 * it is a match this pipeline cannot score on that one axis, and both
 * ranking CLIs must say so plainly rather than silently treating it as a
 * zero.
 */
export const FeaturedMatchEvidenceSchema = z.object({
  dramaScore: z.number().min(0).max(100).nullable(),
  dramaGrade: z.string().nullable(),
  entertainmentScore: z.number().min(0).max(100).nullable(),
  storyGrade: z.string().nullable(),
  turnCount: z.number().int().nonnegative().nullable(),
  decisionCount: z.number().int().nonnegative().nullable(),
  degradedCount: z.number().int().nonnegative().nullable(),
  seatCount: z.number().int().nonnegative().nullable(),
  replayComplete: z.boolean(),
  /** Human-readable reasons the ranking landed where it did, or why a signal is absent — never blank for a ranked candidate. */
  notes: z.array(z.string()),
});
export type FeaturedMatchEvidence = z.infer<typeof FeaturedMatchEvidenceSchema>;

/**
 * Embargoed as a whole — see the class doc. `placements` is ordered
 * finish order, agent ids only (never a raw player name leak past this
 * point; the read-model projection re-resolves display identity itself).
 */
export const FeaturedMatchResultSchema = z.object({
  winnerAgentId: z.string().nullable(),
  placements: z.array(
    z.object({ agentId: z.string().nullable(), placement: z.number().int() }),
  ),
});
export type FeaturedMatchResult = z.infer<typeof FeaturedMatchResultSchema>;

export const FeaturedMatchSchema = z
  .object({
    schemaVersion: z.literal(1),
    matchId: z
      .string()
      .regex(/^feat_[a-f0-9]{20}$/, "expected feat_<20 lowercase hex>"),
    lane: FeaturedMatchLaneSchema,
    /** Coworld's own episode request id — null for a premiere-lane candidate whose queue item predates episode-id tracking (an old exhibition-only bundle); always set for archive-lane records (they come FROM a published episode). */
    episodeRequestId: z.string().nullable(),
    /** `premiere-queue-lib.sh` `ready/<timestamp>-<runId>` item name — premiere lane only, null for archive lane. */
    queueItemName: z.string().nullable(),
    title: z.string().min(1),
    description: z.string(),
    participants: z.array(FeaturedMatchParticipantSchema),
    map: z.string(),
    format: z.string(),
    provenance: z.object({
      source: z.enum(["premiere-queue", "league-archive"]),
      /** The queue item name or episodeRequestId this record was built from — same value as `queueItemName`/`episodeRequestId` above, kept here too so provenance survives independently of which one is null for this lane. */
      sourceRef: z.string(),
      capturedAt: z.string(),
    }),
    state: FeaturedMatchStateSchema,
    category: FeaturedMatchCategorySchema.nullable(),
    scheduledAt: z.string().nullable(),
    revealAt: z.string().nullable(),
    evidence: FeaturedMatchEvidenceSchema,
    postMatchSummary: z.string().nullable(),
    /** EMBARGOED for an unrevealed premiere-lane record — see class doc. */
    result: FeaturedMatchResultSchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.lane === "premiere" && record.queueItemName === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a premiere-lane record must carry its queue item name",
        path: ["queueItemName"],
      });
    }
    if (record.lane === "archive" && record.queueItemName !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "an archive-lane record must never carry a queue item name — the two lanes are never mixed",
        path: ["queueItemName"],
      });
    }
    if (record.lane === "archive" && record.episodeRequestId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "an archive-lane record must carry the episode it was published from",
        path: ["episodeRequestId"],
      });
    }
    if (
      record.lane === "archive" &&
      (record.scheduledAt !== null || record.revealAt !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "an archive-lane record is never scheduled or embargoed — it was already public before this record existed",
        path: ["scheduledAt"],
      });
    }
    if (
      record.lane === "premiere" &&
      (record.state === "candidate" || record.state === "scheduled") &&
      record.result !== null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "embargo violation: an unrevealed premiere-lane record must never carry a result",
        path: ["result"],
      });
    }
  });
export type FeaturedMatch = z.infer<typeof FeaturedMatchSchema>;

const FeaturedMatchStoreFileSchema = z.object({
  schemaVersion: z.literal(1),
  matches: z.array(FeaturedMatchSchema),
});
export type FeaturedMatchStoreFile = z.infer<
  typeof FeaturedMatchStoreFileSchema
>;

export function newFeaturedMatchId(): string {
  return `feat_${randomBytes(10).toString("hex")}`;
}

// ---------------------------------------------------------------------
// Storage — one JSON file, atomically written, following the same
// temp-file+rename pattern `CoworldLeagueSiteWriter.ts`'s own
// `writeFileAtomic` uses (kept local here too: neither module exports
// its copy, and the pattern is three lines, not worth a shared util for).
// ---------------------------------------------------------------------

export const FEATURED_MATCH_STATE_ROOT_ENV =
  "PROXYWAR_FEATURED_MATCH_STATE_ROOT" as const;
const STORE_FILE_NAME = "featured-matches.json";

/**
 * Resolves the directory the featured-match store lives in — same
 * override-with-safe-default shape as `resolvePlatformPrivateStateRoot`/
 * `resolveReplayPremierePrivateStateRoot`. Local test suites and any
 * throwaway CLI run against this repo's ~17 GiB-free internal disk MUST
 * override this to a path under the external workspace volume (or any
 * volume with real headroom) — this module does not enforce a free-space
 * floor itself (that discipline lives in the premiere runtime's own
 * `ReplayPremiereSecrets.ts`/`ReplayPremierePrivateStaging.ts`, which this
 * store is deliberately independent of: a featured-match record is
 * editorial metadata, not premiere private state, and must survive a
 * premiere state-root wipe).
 */
export function resolveFeaturedMatchStateRoot(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configured = environment[FEATURED_MATCH_STATE_ROOT_ENV]?.trim();
  const selected =
    configured === undefined || configured === ""
      ? path.join(
          homeDirectory,
          "Library",
          "Application Support",
          "ProxyWar",
          "storage",
          "featured-matches",
        )
      : configured;
  const resolved = path.resolve(selected);
  if (
    !path.isAbsolute(selected) ||
    resolved === path.parse(resolved).root ||
    resolved === path.resolve(homeDirectory)
  ) {
    throw new Error(`invalid_featured_match_state_root: ${selected}`);
  }
  return resolved;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

async function writeFileAtomic(
  destinationPath: string,
  contents: string,
): Promise<void> {
  const temporaryPath = `${destinationPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, destinationPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Reads the store, returning an empty (schema-valid) file when it does not exist yet — never throws on a cold start. Throws on a corrupt/invalid file: a bad store is a loud failure, never a silent reset to empty. */
export async function readFeaturedMatchStore(
  stateRoot: string,
): Promise<FeaturedMatchStoreFile> {
  const filePath = path.join(stateRoot, STORE_FILE_NAME);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { schemaVersion: 1, matches: [] };
    }
    throw error;
  }
  return FeaturedMatchStoreFileSchema.parse(JSON.parse(raw));
}

/**
 * Cross-process concurrency contract for this store: EVERY read-modify-write
 * caller — `FeaturedMatchReconcile.ts`'s `reconcileFeaturedMatchStore`
 * (server routes), and every `premiere:schedule`/`publish`/`cancel` operator
 * CLI (separate OS processes, NOT covered by any in-process mutex) — MUST
 * use {@link mutateFeaturedMatchStore}, which holds ONE cross-process file
 * lock (`FileMutex.ts`, keyed on `stateRoot`) across the entire
 * read -> mutate -> write cycle. A caller that reads separately and later
 * calls a write function on its own reopens exactly the lost-update race
 * this contract exists to close: the later writer's snapshot silently
 * discards whatever an interleaved writer already committed.
 *
 * `writeFeaturedMatchStoreUnlocked` is the raw write primitive, exported
 * ONLY for a caller that already holds this store's lock itself (e.g.
 * `reconcileFeaturedMatchStoreLocked`, which does async work between its own
 * read and write and so cannot fit `mutateFeaturedMatchStore`'s synchronous
 * `mutate` shape) — calling it without already holding the lock reopens the
 * same race. `writeFeaturedMatchStore` is the locked public form, for the
 * rare caller that writes a value not derived from reading this store first
 * (so there is no read-then-write window to protect).
 */
export async function writeFeaturedMatchStoreUnlocked(
  stateRoot: string,
  file: FeaturedMatchStoreFile,
): Promise<void> {
  const validated = FeaturedMatchStoreFileSchema.parse(file);
  await fs.mkdir(stateRoot, { recursive: true });
  await writeFileAtomic(
    path.join(stateRoot, STORE_FILE_NAME),
    `${JSON.stringify(validated, null, 2)}\n`,
  );
}

/** Writes the whole store atomically, holding this store's cross-process lock for the duration of the write — see the concurrency contract above `writeFeaturedMatchStoreUnlocked`. */
export async function writeFeaturedMatchStore(
  stateRoot: string,
  file: FeaturedMatchStoreFile,
): Promise<void> {
  await withFileMutex(stateRoot, () =>
    writeFeaturedMatchStoreUnlocked(stateRoot, file),
  );
}

/**
 * The canonical read-modify-write primitive for this store: read, apply,
 * validate, write, all under ONE hold of this store's cross-process lock
 * (`FileMutex.ts`, keyed on `stateRoot` — the SAME lock
 * `reconcileFeaturedMatchStore` holds for its own read-modify-write). Every
 * true read-modify-write caller in this family — every operator CLI
 * (`premiere:schedule`/`publish`/`cancel`, via `upsertRecord` in
 * `premiere-schedule-lib.ts`) included — MUST go through this function, not
 * a separate read followed by a separate write. Throws (never swallows) if
 * `mutate` returns a store that fails schema validation, so an operator CLI
 * bug fails loudly instead of corrupting the store.
 */
export async function mutateFeaturedMatchStore(
  stateRoot: string,
  mutate: (file: FeaturedMatchStoreFile) => FeaturedMatchStoreFile,
): Promise<FeaturedMatchStoreFile> {
  return withFileMutex(stateRoot, async () => {
    const current = await readFeaturedMatchStore(stateRoot);
    const next = mutate(current);
    await writeFeaturedMatchStoreUnlocked(stateRoot, next);
    return next;
  });
}
