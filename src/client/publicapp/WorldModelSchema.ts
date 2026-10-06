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

/**
 * A battle's link exactly as the server writes it, `/match/<encoded id>`.
 * Both world pages bind it straight into `href`, so another origin, a
 * `javascript:` URL or a path outside `/match/` fails validation.
 */
const MatchHrefSchema = z.string().regex(/^\/match\/[^/?#\\\s]+$/);

const WorldBattleSchema = z.object({
  episodeRequestId: z.string(),
  map: z.string(),
  winner: z.string().nullable(),
  at: z.string(),
  href: MatchHrefSchema,
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
  href: MatchHrefSchema,
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

/**
 * An array whose bad entries are dropped one by one. The Season 2 fields
 * are extras on a world that renders without them, so one malformed quote
 * or standing costs that entry, never the page.
 */
function lenientArray<T extends z.ZodType>(item: T) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((entries) =>
      entries.flatMap((entry) => {
        const parsed = item.safeParse(entry);
        return parsed.success ? [parsed.data as z.infer<T>] : [];
      }),
    );
}

/**
 * Where "watch" may go: a `/match/<id>` page on this site or an https page
 * (the hosted replay viewer). Anything else is dropped, never bound into
 * an `href`, and so is a raw `.replay` file: a download of megabytes of
 * JSON, not something to watch.
 */
export function safeWatchHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (MatchHrefSchema.safeParse(value).success) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return /\.replay(?:\.[a-z0-9]+)?$/i.test(url.pathname) ? null : value;
  } catch {
    return null;
  }
}

const HexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

/** One side of the Frontier: a model, its display name and its maker. */
const WorldTeamSchema = z.object({
  label: z.string(),
  model: z.string(),
  /** Season 2: "Claude Opus 5.5". Absent from a Frontier Four world. */
  displayName: z.string().optional().catch(undefined),
  /** Season 2: "Anthropic". */
  provider: z.string().optional().catch(undefined),
  color: HexColorSchema.optional().catch(undefined),
});
export type WorldTeam = z.infer<typeof WorldTeamSchema>;

/** Season 2's fixed battle times, and the next one when one is booked. */
const WorldScheduleSchema = z.object({
  timesUtc: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).catch([]),
  nextBattleAt: z.string().nullable().catch(null),
});
export type WorldSchedule = z.infer<typeof WorldScheduleSchema>;

const WorldStandingSchema = z.object({
  label: z.string(),
  /** Share of the map's land at the end, 0..1. */
  landShare: z.number().min(0).max(1).nullable().catch(null),
  isAlive: z.boolean().nullable().optional().catch(null),
  eliminatedAtTurn: z.number().nullable().optional().catch(null),
  rank: z.number().int().positive().nullable().optional().catch(null),
});
export type WorldStanding = z.infer<typeof WorldStandingSchema>;

/** A model's own words from a battle: its public dispatch or a message to a rival. */
const WorldVoiceSchema = z.object({
  label: z.string(),
  kind: z.enum(["dispatch", "message"]),
  to: z.string().nullable().optional().catch(null),
  turn: z.number().nullable().optional().catch(null),
  text: z.string(),
});
export type WorldVoice = z.infer<typeof WorldVoiceSchema>;

const WorldLatestBattleSchema = z.object({
  episodeRequestId: z.string(),
  map: z.string(),
  /** The front the battle counted for: a front id or its name. */
  frontLabel: z.string().nullable().optional().catch(null),
  completedAt: z.string(),
  winnerLabel: z.string().nullable().catch(null),
  winType: z.enum(["conquest", "points", "none"]).optional().catch(undefined),
  standings: lenientArray(WorldStandingSchema),
  voices: lenientArray(WorldVoiceSchema),
  watchHref: z.unknown().transform(safeWatchHref),
});
export type WorldLatestBattle = z.infer<typeof WorldLatestBattleSchema>;

const WorldSeasonRecapSchema = z.object({
  battles: z.number().int().nonnegative(),
  winsByLabel: z.record(z.string(), z.number().int().nonnegative()).catch({}),
  note: z.string().nullable().optional().catch(null),
});
export type WorldSeasonRecap = z.infer<typeof WorldSeasonRecapSchema>;

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
  /** Absent from a world.json published before the front page existed. */
  links: z
    .object({ accountUrl: z.string(), enterTheLeagueUrl: z.string() })
    .nullable()
    .optional(),
  /**
   * Absent for the league's world; `frontier-four` (Season 1) and
   * `frontier` (Season 2, one nation per model) name the teams. An unknown
   * mode reads as the league's rather than failing the page.
   */
  mode: z
    .enum(["league", "frontier-four", "frontier"])
    .optional()
    .catch(undefined),
  teams: z.array(WorldTeamSchema).optional().catch(undefined),
  // Season 2 extras. Each is optional and dropped when malformed, so a
  // world published without them, or with one gone wrong, still renders.
  season: z.number().int().positive().optional().catch(undefined),
  schedule: WorldScheduleSchema.optional().catch(undefined),
  seasonOneRecap: WorldSeasonRecapSchema.optional().catch(undefined),
  latestBattle: WorldLatestBattleSchema.nullable().optional().catch(undefined),
});
export type WorldModel = z.infer<typeof WorldModelSchema>;
export type WorldMode = NonNullable<WorldModel["mode"]>;

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

// ------------------------------------------------------------ Nerf Watch

/**
 * `frontier-form.json`, published beside `world.json` in Season 2: each
 * model's battles and planner telemetry per day, its trailing record, and
 * the publisher's plain verdict on today. Optional: when it is missing or
 * malformed the page simply leaves the Nerf Watch out.
 */

const FormDaySchema = z.object({
  /** A UTC date, "2026-10-06". */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  battles: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  meanLandShare: z.number().min(0).max(1).nullable().catch(null),
  ranks: z.array(z.number()).catch([]),
  plans: z.number().nonnegative().nullable().catch(null),
  planFailures: z.number().nonnegative().nullable().catch(null),
  latencyMsMedian: z.number().nonnegative().nullable().catch(null),
  outputTokensMedian: z.number().nonnegative().nullable().catch(null),
});
export type FormDay = z.infer<typeof FormDaySchema>;

const FormTrailingSchema = z.object({
  days: z.number().int().positive(),
  battles: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  winRate: z.number().min(0).max(1).nullable().catch(null),
  /** Over the `speedDays` before, among games run the same way. */
  latencyMsMedian: z.number().nonnegative().nullable().catch(null),
  outputTokensMedian: z.number().nonnegative().nullable().catch(null),
  /**
   * The window the medians above (and the publisher's speed, length and
   * failure verdicts) cover; `days` is the window for results.
   */
  speedDays: z.number().int().positive().optional().catch(undefined),
});
export type FormTrailing = z.infer<typeof FormTrailingSchema>;

export const FORM_VERDICT_KINDS = [
  "normal",
  "slower",
  "faster",
  "wordier",
  "terser",
  "flakier",
  "too_few",
] as const;

const FormTodaySchema = z.object({
  verdictKind: z.enum(FORM_VERDICT_KINDS).nullable().catch(null),
  /** P(a result this bad or worse) at the model's trailing win rate. */
  chanceOfResult: z.number().min(0).max(1).nullable().catch(null),
  /**
   * The publisher's English summary. Read but not shown: the page says the
   * same from the numbers above in the visitor's language.
   */
  sentence: z.string().nullable().catch(null),
});
export type FormToday = z.infer<typeof FormTodaySchema>;

const FormModelSchema = z.object({
  label: z.string(),
  displayName: z.string().optional().catch(undefined),
  provider: z.string().optional().catch(undefined),
  days: lenientArray(FormDaySchema),
  trailing: FormTrailingSchema.nullable().optional().catch(null),
  today: FormTodaySchema.nullable().optional().catch(null),
});
export type FormModel = z.infer<typeof FormModelSchema>;

export const FrontierFormSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  models: lenientArray(FormModelSchema),
});
export type FrontierForm = z.infer<typeof FrontierFormSchema>;

export const FRONTIER_FORM_PATH = "/ai-league-runs/league/frontier-form.json";

/**
 * Fetches and validates `frontier-form.json`. Never throws: a missing
 * file, a network failure or a schema mismatch is `null`, and the page
 * leaves the section out.
 */
export async function fetchFrontierForm(
  fetchImpl: typeof fetch = fetch,
): Promise<FrontierForm | null> {
  try {
    const response = await fetchImpl(FRONTIER_FORM_PATH, {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) return null;
    const parsed = FrontierFormSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
