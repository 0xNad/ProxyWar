import { z } from "zod";

/**
 * Client-side validation for `GET /ai-league-runs/league/world.json` — the
 * `/world` page's read model (server: `CoworldLeagueWorld.ts`'s
 * `buildPublicWorldModel`). Independent of the server type for the same
 * reason as `ReadModelSchema.ts`: this is what the browser is willing to
 * trust from the wire, so a malformed publication fails loudly here instead
 * of rendering a half-drawn world.
 */

export const WORLD_THEATRE_IDS = [
  "north_america",
  "south_america",
  "britannia",
  "europe",
  "black_sea",
  "middle_east",
  "africa",
  "asia",
  "east_asia",
  "oceania",
  "crown",
] as const;

export const WorldTheatreIdSchema = z.enum(WORLD_THEATRE_IDS);
export type WorldTheatreId = z.infer<typeof WorldTheatreIdSchema>;

const WorldBattleSchema = z.object({
  episodeRequestId: z.string(),
  map: z.string(),
  winner: z.string().nullable(),
  at: z.string(),
  href: z.string(),
});
export type WorldBattle = z.infer<typeof WorldBattleSchema>;

const WorldReignSchema = z.object({
  holder: z.string(),
  from: z.string(),
  to: z.string().nullable(),
  battles: z.number(),
  wins: z.number(),
});
export type WorldReign = z.infer<typeof WorldReignSchema>;

const WorldTheatreSchema = z.object({
  id: WorldTheatreIdSchema,
  battlefields: z.array(z.string()),
  status: z.enum(["unclaimed", "held", "contested"]),
  holder: z.string().nullable(),
  heldSince: z.string().nullable(),
  holderWins: z.number(),
  challenger: z.string().nullable(),
  challengerWins: z.number(),
  battleCount: z.number(),
  lastBattleAt: z.string().nullable(),
  window: z.array(WorldBattleSchema),
  tallies: z.array(z.object({ name: z.string(), wins: z.number() })),
  maps: z.array(z.object({ map: z.string(), battles: z.number() })),
  reigns: z.array(WorldReignSchema),
});
export type WorldTheatre = z.infer<typeof WorldTheatreSchema>;

const WorldEventSchema = z.object({
  kind: z.enum(["claim", "conquest", "siege", "held"]),
  theatreId: WorldTheatreIdSchema,
  at: z.string(),
  episodeRequestId: z.string(),
  map: z.string(),
  agent: z.string(),
  rival: z.string().nullable(),
  agentWins: z.number(),
  rivalWins: z.number(),
  href: z.string(),
});
export type WorldEvent = z.infer<typeof WorldEventSchema>;

const WorldAgentSchema = z.object({
  name: z.string(),
  label: z.string(),
  slug: z.string().nullable(),
  color: z.string(),
  secondaryColor: z.string(),
  emblemSvg: z.string().nullable(),
  isHouse: z.boolean(),
  theatres: z.array(WorldTheatreIdSchema),
  conquests: z.number(),
  battlesWon: z.number(),
});
export type WorldAgent = z.infer<typeof WorldAgentSchema>;

const WorldDaySchema = z.object({
  day: z.string(),
  holders: z.record(z.string(), z.string().nullable()),
});
export type WorldDay = z.infer<typeof WorldDaySchema>;

export const WorldModelSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  windowSize: z.number(),
  battleCount: z.number(),
  battlesLast24h: z.number(),
  firstBattleAt: z.string().nullable(),
  lastBattleAt: z.string().nullable(),
  feed: z.object({
    stale: z.boolean(),
    lastGoodSyncAt: z.string(),
    currentRoundNumber: z.number().nullable(),
    roundIntervalMinutes: z.number().nullable(),
  }),
  theatres: z.array(WorldTheatreSchema),
  events: z.array(WorldEventSchema),
  timeline: z.array(WorldDaySchema),
  agents: z.array(WorldAgentSchema),
});
export type WorldModel = z.infer<typeof WorldModelSchema>;

export const WORLD_MODEL_PATH = "/ai-league-runs/league/world.json";

/** Fetches and validates `world.json`; throws on a network failure or schema mismatch. */
export async function fetchWorldModel(
  fetchImpl: typeof fetch = fetch,
): Promise<WorldModel> {
  const response = await fetchImpl(WORLD_MODEL_PATH, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`world_model_fetch_failed_${response.status}`);
  }
  const body: unknown = await response.json();
  return WorldModelSchema.parse(body);
}
