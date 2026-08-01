import { z } from "zod";
import { SlugSchema } from "../../identity/IdentitySchemas";

/**
 * Season Zero activation prompt Phase 4 ("Programme Season Zero") — "a
 * simple Season model", explicitly NOT a second rating system: no points,
 * no standings math, no per-agent season score. Everything competitive
 * stays owned by Coworld; a Season is purely an editorial programme
 * wrapper — a bounded window, a title, a schedule of `FeaturedMatch`
 * events, and REFERENCES to already-computed Coworld standings snapshots
 * (never a copy of scores into a second table — see
 * `standingsSnapshotRefs`'s own doc below and
 * `CoworldLeagueStandingsHistory.ts`, the store those refs point into).
 *
 * Storage choice (see `SeasonRegistry.ts`'s own doc for the full
 * justification): tracked, git-reviewed JSON — the SAME pattern
 * `src/server/identity/IdentitySchemas.ts` already uses for
 * Builders/Agents/Versions — not a locked operational store like
 * `FeaturedMatch.ts`. A Season is deliberately-rare, operator-authored
 * editorial content (draft -> active -> completed, once per programme
 * cycle) with no automatic runtime writer ever touching it — the
 * concurrency guarantees `FeaturedMatch.ts`'s locked store exists for
 * (a demo server route AND several CLIs mutating the same file from
 * separate OS processes, continuously) simply do not apply here.
 */

export const SeasonStateSchema = z.enum(["draft", "active", "completed"]);
export type SeasonState = z.infer<typeof SeasonStateSchema>;

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO YYYY-MM-DD date");
const IsoTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
  "expected an ISO-8601 UTC timestamp",
);

const FEATURED_MATCH_ID_PATTERN = /^feat_[a-f0-9]{20}$/;

/**
 * One flagship/highlight slot in the season's programme — a REFERENCE to a
 * `FeaturedMatch` id, never a copy of its title/participants/evidence (the
 * `FeaturedMatch` store, or once generated its `EventPackage`, remains the
 * single source of truth for that content; a season slot's only job is to
 * say "this match is part of this season's programme, on this date").
 * `scheduledAt` is the SEASON PROGRAMME's own calendar entry — independent
 * of (and may be entered before) the `FeaturedMatch` record's own
 * `scheduledAt`, e.g. when an operator blocks out "week 3's flagship slot"
 * before a specific candidate has even been picked from `premiere:candidates`.
 */
export const SeasonEventSlotSchema = z
  .object({
    featuredMatchId: z
      .string()
      .regex(FEATURED_MATCH_ID_PATTERN, "expected feat_<20 lowercase hex>"),
    scheduledAt: IsoTimestampSchema.nullable(),
    addedAt: IsoTimestampSchema,
  })
  .strict();
export type SeasonEventSlot = z.infer<typeof SeasonEventSlotSchema>;

/**
 * A REFERENCE into `CoworldLeagueStandingsHistory.ts`'s own snapshot
 * store — identified by that store's own `snapshot.generatedAt` (its
 * de-dup key — see that module's doc), never a copy of ranks/scores.
 * `label` is operator-facing context only (e.g. "season open", "season
 * close") — never itself a ranking claim.
 */
export const SeasonStandingsSnapshotRefSchema = z
  .object({
    snapshotGeneratedAt: IsoTimestampSchema,
    label: z.string().min(1),
  })
  .strict();
export type SeasonStandingsSnapshotRef = z.infer<
  typeof SeasonStandingsSnapshotRefSchema
>;

export const SeasonSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Deterministic from `slug` (`season_<slug>`) — a season is a small, explicitly-named editorial object created once, not a high-volume record needing a random id (contrast `FeaturedMatch.newFeaturedMatchId`). */
    id: z.string().regex(/^season_[a-z0-9]+(-[a-z0-9]+)*$/, "expected season_<slug>"),
    slug: SlugSchema,
    title: z.string().min(1),
    /** Public-facing programme blurb — e.g. "an eight-week bounded flagship programme leading into the Coworld season close." Never championship-points language (spec: "Do not invent championship points in this iteration"). */
    description: z.string(),
    startDate: IsoDateSchema,
    endDate: IsoDateSchema,
    state: SeasonStateSchema,
    eventSlots: z.array(SeasonEventSlotSchema),
    /** Archive-lane `FeaturedMatch` ids folded into this season's retrospective archive presentation — reference only, same rule as `eventSlots`. */
    archiveFeaturedMatchIds: z.array(
      z.string().regex(FEATURED_MATCH_ID_PATTERN, "expected feat_<20 lowercase hex>"),
    ),
    standingsSnapshotRefs: z.array(SeasonStandingsSnapshotRefSchema),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .strict()
  .superRefine((season, ctx) => {
    if (season.startDate >= season.endDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `startDate (${season.startDate}) must be before endDate (${season.endDate})`,
        path: ["endDate"],
      });
    }
    if (season.id !== `season_${season.slug}`) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `id (${season.id}) must be exactly "season_" + slug (season_${season.slug})`,
        path: ["id"],
      });
    }
    const slotIds = season.eventSlots.map((slot) => slot.featuredMatchId);
    if (new Set(slotIds).size !== slotIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "eventSlots must not repeat the same featuredMatchId",
        path: ["eventSlots"],
      });
    }
  });
export type Season = z.infer<typeof SeasonSchema>;

export const SeasonRegistryFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    seasons: z.array(SeasonSchema),
  })
  .strict();
export type SeasonRegistryFile = z.infer<typeof SeasonRegistryFileSchema>;

export function seasonIdFromSlug(slug: string): string {
  return `season_${slug}`;
}
