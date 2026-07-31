import { z } from "zod";

/**
 * Shared Zod schema for the strategic fingerprint + social record stats
 * both `/agent/:slug` (`publicapp/ReadModelSchema.ts`'s `PublicAgentSchema`)
 * and `/player/:name` (`platform/PlayerProfilePage.ts`) validate against —
 * literally the same schema, not two hand-copied ones, so the two client
 * trees can never drift on what shape they trust from the wire (spec
 * Stage 6 item 6: "one computation source, two views, never divergent
 * numbers" extends to the TYPES, not just the runtime values). Mirrors
 * `AgentStatsPipeline.ts`'s server types field-for-field.
 *
 * A metric is `null` below its own sample threshold — never a fabricated
 * zero — so every render site must treat `null` as "omit this row
 * entirely", not "show 0%".
 */

export const AgentMetricSchema = z.object({
  value: z.number(),
  sampleSize: z.number(),
  threshold: z.number(),
  methodology: z.string(),
});
export type AgentMetric = z.infer<typeof AgentMetricSchema>;

export const NamedCountSchema = z.object({
  name: z.string(),
  count: z.number(),
});
export type NamedCount = z.infer<typeof NamedCountSchema>;

const TerritoryShareResultSchema = z.object({
  share: AgentMetricSchema.nullable(),
  absoluteTiles: z
    .object({ mean: z.number(), sampleSize: z.number() })
    .nullable(),
  meanRank: z.object({ value: z.number(), sampleSize: z.number() }).nullable(),
});

const AgentFingerprintSchema = z.object({
  aggression: AgentMetricSchema.nullable(),
  diplomacyInitiated: AgentMetricSchema.nullable(),
  economicFocus: AgentMetricSchema.nullable(),
  territory: TerritoryShareResultSchema,
  armyStrength: AgentMetricSchema.nullable(),
});

const AgentSocialRecordSchema = z.object({
  alliancesInitiated: AgentMetricSchema.nullable(),
  allianceAcceptanceRate: AgentMetricSchema.nullable(),
  betrayalCount: AgentMetricSchema.nullable(),
  frequentAllies: z.array(NamedCountSchema),
  primaryAdversaries: z.array(NamedCountSchema),
  treatyDuration: AgentMetricSchema.nullable(),
});

export const AgentStatsSliceSchema = z.object({
  episodeCount: z.number(),
  fingerprint: AgentFingerprintSchema,
  social: AgentSocialRecordSchema,
});
export type AgentStatsSlice = z.infer<typeof AgentStatsSliceSchema>;

export const PublicAgentStatsSchema = z.object({
  career: AgentStatsSliceSchema,
  currentVersion: AgentStatsSliceSchema
    .extend({ versionLabel: z.string() })
    .nullable(),
});
export type PublicAgentStats = z.infer<typeof PublicAgentStatsSchema>;
