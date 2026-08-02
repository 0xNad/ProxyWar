import { z } from "zod";

/**
 * Shared Zod schema for winrate-over-time and score-over-time, validated by
 * both `/agent/:slug` (`publicapp/ReadModelSchema.ts`'s `PublicAgentSchema`)
 * and `/player/:name` (`platform/PlayerProfilePage.ts`) — same pairing
 * `AgentStatsSchema.ts` already establishes for the fingerprint/social
 * stats: one schema, reused, so the two client trees can never drift on
 * what shape they trust from the wire. Mirrors `AgentTimeSeries.ts`'s
 * server types field-for-field.
 *
 * A sub-series (`winrate` or `score`) is `null` below its own documented
 * sample threshold — never a fabricated 1- or 2-point "trend" — so every
 * render site must treat `null` as "omit this chart entirely".
 */

export const WinrateSeriesPointSchema = z.object({
  completedAt: z.string(),
  winRate: z.number(),
  episodesSoFar: z.number(),
});
export type WinrateSeriesPoint = z.infer<typeof WinrateSeriesPointSchema>;

export const WinrateSeriesSchema = z.object({
  points: z.array(WinrateSeriesPointSchema),
  threshold: z.number(),
  methodology: z.string(),
});
export type WinrateSeries = z.infer<typeof WinrateSeriesSchema>;

export const ScoreSeriesPointSchema = z.object({
  recordedAt: z.string(),
  score: z.number(),
  rank: z.number(),
  activeVersionLabel: z.string().nullable(),
  versionFirstObserved: z.boolean(),
});
export type ScoreSeriesPoint = z.infer<typeof ScoreSeriesPointSchema>;

export const ScoreSeriesSchema = z.object({
  points: z.array(ScoreSeriesPointSchema),
  recordedSince: z.string(),
  methodology: z.string(),
});
export type ScoreSeries = z.infer<typeof ScoreSeriesSchema>;

export const AgentTimeSeriesSchema = z.object({
  winrate: WinrateSeriesSchema.nullable(),
  score: ScoreSeriesSchema.nullable(),
});
export type AgentTimeSeries = z.infer<typeof AgentTimeSeriesSchema>;
