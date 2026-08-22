import { z } from "zod";
import { PublicAgentStatsSchema } from "../AgentStatsSchema";
import { AgentTimeSeriesSchema } from "../AgentTimeSeriesSchema";
export {
  PublicAgentStatsSchema,
  type AgentMetric,
  type AgentStatsSlice,
  type NamedCount,
  type PublicAgentStats,
} from "../AgentStatsSchema";
export {
  AgentTimeSeriesSchema,
  type AgentTimeSeries,
  type ScoreSeries,
  type WinrateSeries,
} from "../AgentTimeSeriesSchema";

/**
 * Client-side Zod validation for `GET /ai-league-runs/league/read-model.json`
 * — every public page in `src/client/publicapp/` fetches through this, never
 * trusting the response shape blindly (same discipline
 * `PlayerProfilePage.ts`'s `profileResponseSchema` already applies to
 * `/api/players/:name`). Deliberately independent of the SERVER's own
 * `ProxyWarPublicReadModel` type (`src/server/ProxyWarPublicReadModel.ts`):
 * this is what the CLIENT is willing to trust from the wire, so a server
 * bug that emits a malformed field fails a Zod parse in the browser instead
 * of silently rendering garbage.
 */

const PublicAgentStandingSchema = z.object({
  rank: z.number(),
  score: z.number().nullable(),
  roundsPlayed: z.number().nullable(),
  isHouse: z.boolean(),
});

const PublicAgentActiveVersionSchema = z.object({
  publicVersionLabel: z.string(),
  source: z.enum(["champion", "rating"]),
  familyMismatch: z.boolean(),
  firstObservedAt: z.string().nullable(),
});

export const PublicAgentSchema = z.object({
  registered: z.boolean(),
  id: z.string().nullable(),
  slug: z.string().nullable(),
  playerName: z.string(),
  displayName: z.string(),
  shortCode: z.string().nullable(),
  emblemSvg: z.string().nullable(),
  primaryColor: z.string().nullable(),
  secondaryColor: z.string().nullable(),
  /** Purely cosmetic fallback for `registered: false` — see server `ProvisionalIdentity.ts`'s module doc. `.optional()` for the SAME reason `timeSeries` below is: an additive field existing `PublicAgent` test fixtures across this codebase don't all need updating for; a missing value means "no provisional identity", identical to explicit `null`. */
  provisionalSlug: z.string().nullable().optional(),
  provisionalEmblemSvg: z.string().nullable().optional(),
  provisionalPrimaryColor: z.string().nullable().optional(),
  provisionalSecondaryColor: z.string().nullable().optional(),
  tagline: z.string().nullable(),
  builderId: z.string().nullable(),
  builderDisplayName: z.string().nullable(),
  status: z.enum(["verified", "house", "unclaimed", "unregistered"]),
  standing: PublicAgentStandingSchema.nullable(),
  activeVersion: PublicAgentActiveVersionSchema.nullable(),
  provenance: z.object({
    ratingPolicyLabel: z.string().nullable(),
    activeChampionPolicyLabel: z.string().nullable(),
  }),
  stats: PublicAgentStatsSchema.nullable(),
  /** Product overhaul spec: winrate/score-over-time. Optional on the WIRE schema (the server always emits it — see `ProxyWarPublicReadModel.ts`'s `PublicAgent.timeSeries`, non-optional there) purely so older cached responses and every other page's own `PublicAgent` test fixture don't need updating for an additive field; callers default a missing value to "both series null" (see `AgentProfilePage.ts`'s render call site). */
  timeSeries: AgentTimeSeriesSchema.optional(),
});
export type PublicAgent = z.infer<typeof PublicAgentSchema>;

export const PublicBuilderSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string().nullable(),
  shortBio: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  status: z.enum(["verified", "house", "unclaimed"]),
});
export type PublicBuilder = z.infer<typeof PublicBuilderSchema>;

const PublicMatchParticipantSchema = z.object({
  slot: z.number(),
  agentSlug: z.string().nullable(),
  displayName: z.string(),
  tilesOwned: z.number(),
  isAlive: z.boolean(),
  isWinner: z.boolean(),
  color: z.string(),
});

export const PublicMatchSchema = z.object({
  matchId: z.string(),
  shortId: z.string(),
  roundNumber: z.number().nullable(),
  completedAt: z.string().nullable(),
  map: z.string(),
  mapSize: z.string(),
  turnCount: z.number().nullable(),
  decisionCount: z.number().nullable(),
  degradedCount: z.number().nullable(),
  winnerAgentSlug: z.string().nullable(),
  participants: z.array(PublicMatchParticipantSchema),
  watchHref: z.string().nullable(),
  fullRenderHref: z.string().nullable(),
  premiereHref: z.string().nullable(),
  dramaEvidence: z
    .object({
      curatedDramaScore: z.number().nullable(),
      entertainmentGrade: z.string(),
    })
    .nullable(),
});
export type PublicMatch = z.infer<typeof PublicMatchSchema>;

const PublicPremiereLiveSchema = z.object({
  premiereId: z.string(),
  roundNumber: z.number().nullable(),
  mapLabel: z.string(),
  scheduledAt: z.string(),
  premierePageLive: z.boolean(),
});

const PublicPremiereLatestSchema = z.object({
  premiereId: z.string(),
  roundNumber: z.number().nullable(),
  mapLabel: z.string(),
  revealedAt: z.string(),
  href: z.string(),
});

const PublicFeaturedMatchResultSchema = z.object({
  winnerAgentId: z.string().nullable(),
  placements: z.array(
    z.object({ agentId: z.string().nullable(), placement: z.number() }),
  ),
});

/**
 * The PUBLIC-SAFE subset of the server's `FeaturedMatch` model (spec
 * Stage 3 items 1/5), independent of the server's own Zod schema per this
 * file's class doc. Deliberately never carries a `participants` field —
 * see `ProxyWarPublicReadModel.ts`'s `PublicFeaturedMatch` doc for why.
 * `result`/`postMatchSummary` are `null` until the server's own embargo
 * projection decides the record is revealed; this client schema only
 * validates wire SHAPE, it does not re-derive the embargo itself.
 */
export const PublicFeaturedMatchSchema = z.object({
  matchId: z.string(),
  lane: z.enum(["premiere", "archive"]),
  title: z.string(),
  description: z.string(),
  map: z.string(),
  format: z.string(),
  category: z
    .enum([
      "top_four",
      "champion_vs_challengers",
      "version_debut",
      "rivalry",
      "builder_showcase",
      "open_source_challenge",
      "notable_league_battle",
    ])
    .nullable(),
  state: z.enum([
    "candidate",
    "scheduled",
    "published",
    "revealed",
    "archived",
    "cancelled",
  ]),
  scheduledAt: z.string().nullable(),
  revealAt: z.string().nullable(),
  /** 2026-08-01 P0 — see `ProxyWarPublicReadModel.ts`'s `PublicFeaturedMatch.completedAt` for the full contract (the ACTUAL match completion date, distinct from `scheduledAt`). */
  completedAt: z.string().nullable(),
  /** Full-replay-access bugfix (2026-08-05) — see `ProxyWarPublicReadModel.ts`'s `PublicFeaturedMatch.watchHref`/`.fullRenderHref` for the full contract. Resolved the SAME way as `completedAt` just above (independent of `isPubliclyPromotable`/the package fields below) — `null` under the identical honest "not mirrored yet" conditions. */
  watchHref: z.string().nullable(),
  fullRenderHref: z.string().nullable(),
  postMatchSummary: z.string().nullable(),
  result: PublicFeaturedMatchResultSchema.nullable(),
  /**
   * Season Zero activation prompt Phase 4/5 — see
   * `ProxyWarPublicReadModel.ts`'s `PublicFeaturedMatch.isPubliclyPromotable`
   * for the full contract. THE flag Phase 5's hero/watch/schedule surfaces
   * must check before treating this record as a promoted Featured Event
   * rather than ordinary archive content.
   */
  isPubliclyPromotable: z.boolean(),
  /** `EventPackage`-derived fields — all `null` together whenever `isPubliclyPromotable` is `false` (see the server type's own doc). `reasonToWatch` is claim TEXT only. */
  subtitle: z.string().nullable(),
  reasonToWatch: z.array(z.string()).nullable(),
  canonicalMatchUrl: z.string().nullable(),
  canonicalPremiereUrl: z.string().nullable(),
});
export type PublicFeaturedMatch = z.infer<typeof PublicFeaturedMatchSchema>;

/** Season Zero activation prompt Phase 5 — see `ProxyWarPublicReadModel.ts`'s `PublicSeason` for the full doc. `draft` seasons never reach the wire. */
export const PublicSeasonSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  state: z.enum(["active", "completed"]),
  eventSlots: z.array(
    z.object({
      featuredMatchId: z.string(),
      scheduledAt: z.string().nullable(),
    }),
  ),
});
export type PublicSeason = z.infer<typeof PublicSeasonSchema>;

const RoundIntegrityAssessmentSchema = z.object({
  roundId: z.string(),
  roundNumber: z.number(),
  completedAt: z.string(),
  expectedEpisodeCount: z.number(),
  observedEpisodeCount: z.number(),
  scoreBearingCount: z.number(),
  effectiveFailureCount: z.number(),
  phantomFailureCount: z.number(),
  otherFailureCount: z.number(),
  allowedFailureCount: z.number(),
  allowedFailureRate: z.number(),
  verdict: z.enum(["healthy", "breach"]),
  evidenceHash: z.string(),
});

const RoundIntegrityStateSchema = z.object({
  status: z.enum(["healthy", "confirmation_pending", "degraded"]),
  checkedAt: z.string(),
  settings: z.object({
    expectedEpisodesPerRound: z.number(),
    roundIntervalMinutes: z.number(),
    allowedFailureRate: z.number(),
    allowedFailureCount: z.number(),
  }),
  latestCompletedRound: RoundIntegrityAssessmentSchema,
  lastConfirmedBreach: RoundIntegrityAssessmentSchema.nullable(),
  breachObservations: z.array(
    z.object({
      roundId: z.string(),
      evidenceHash: z.string(),
      firstObservedAt: z.string(),
    }),
  ),
});

export const ReadModelSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  lastGoodSyncAt: z.string(),
  stale: z.boolean(),
  feedStates: z.object({
    championFeedStale: z.boolean(),
    replayFeedStale: z.boolean(),
    // Additive for cached/pre-upgrade read models; the server emits it on
    // every new publication while older snapshots safely parse as absent.
    roundIntegrityFeedStale: z.boolean().optional(),
  }),
  roundIntegrity: RoundIntegrityStateSchema.nullable().optional(),
  league: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    divisionName: z.string(),
    roundIntervalMinutes: z.number().nullable(),
    episodesPerRound: z.number().nullable(),
    currentRoundNumber: z.number().nullable(),
    currentRoundStatus: z.string().nullable(),
    scoreLabel: z.string(),
  }),
  builders: z.array(PublicBuilderSchema),
  agents: z.array(PublicAgentSchema),
  versions: z.array(z.record(z.string(), z.unknown())),
  rounds: z.array(
    z.object({
      roundNumber: z.number(),
      status: z.string(),
      startedAt: z.string().nullable(),
      completedAt: z.string().nullable(),
    }),
  ),
  matches: z.array(PublicMatchSchema),
  featuredMatches: z.array(PublicFeaturedMatchSchema),
  seasons: z.array(PublicSeasonSchema),
  premieres: z.object({
    live: PublicPremiereLiveSchema.nullable(),
    latest: PublicPremiereLatestSchema.nullable(),
  }),
  links: z.object({
    enterTheLeagueUrl: z.string(),
    platformLabel: z.string(),
    accountUrl: z.string(),
  }),
});
export type ReadModel = z.infer<typeof ReadModelSchema>;

export const READ_MODEL_PATH = "/ai-league-runs/league/read-model.json";

/** Fetches and validates the read model — throws on a network failure or a schema mismatch; callers set their own loading/error state around this (same pattern as `PlayerProfilePage.load`). */
export async function fetchReadModel(
  fetchImpl: typeof fetch = fetch,
): Promise<ReadModel> {
  const response = await fetchImpl(READ_MODEL_PATH, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`read_model_fetch_failed_${response.status}`);
  }
  const body: unknown = await response.json();
  return ReadModelSchema.parse(body);
}
