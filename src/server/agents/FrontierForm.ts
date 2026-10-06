import path from "node:path";
import { writeFileAtomic } from "./CoworldLeagueSiteWriter";
import {
  sanitizeFrontierPublicText,
  uniqueFrontierGames,
  type FrontierFourTeam,
  type FrontierGameRecord,
  type FrontierGameRecordV2,
  type FrontierHarness,
  type FrontierSeatTelemetry,
} from "./FrontierFourWorld";

/**
 * Nerf Watch (`frontier-form.json`): how each Frontier model did, day by
 * day, and whether its latest day stands out against the days before it.
 *
 * People ask whether a model got worse. One day of battles cannot say, so
 * the published verdict only states what the numbers support:
 *
 * - Results get a chance, not a label: from the model's win rate over the
 *   30 days before, how often a day this bad or worse happens anyway
 *   (binomial). The words "nerfed" and "weaker" are never used.
 * - Only games on the same model count: when a label moves to a new model
 *   slug, the new model starts a fresh record instead of inheriting the
 *   old one's.
 * - Speed and answer length are compared with the 7 days before, among
 *   games run with the same setup (a change on our side is not the
 *   model's), and the day itself counts only its games run that way. A
 *   shift is named only when the day falls outside every earlier day's
 *   value, is more than 15% off the earlier median, and rests on at least
 *   8 plans; it is then called a speed or length shift, never a result.
 * - Fewer than 10 earlier battles: too few to compare, said plainly.
 *
 * The day under review is the model's latest UTC day with a battle (today
 * when it has fought today). "Trailing" means the days BEFORE that day, so
 * the day is never compared with itself. Pure: the same records and `now`
 * always give the same file.
 */

export const FRONTIER_FORM_FILE = "frontier-form.json";
export const FRONTIER_FORM_RESULT_DAYS = 30;
export const FRONTIER_FORM_SPEED_DAYS = 7;
export const FRONTIER_FORM_MIN_TRAILING_BATTLES = 10;
export const FRONTIER_FORM_MIN_PLANS = 8;
/** A speed, length or failure shift must exceed this (15%). */
export const FRONTIER_FORM_MIN_SHIFT = 0.15;
const FRONTIER_FORM_DAY_LIMIT = 90;
const FRONTIER_FORM_SENTENCE_MAX_CHARS = 240;

export interface FrontierFormDay {
  /** UTC day, `YYYY-MM-DD`. */
  readonly day: string;
  readonly battles: number;
  readonly wins: number;
  readonly meanLandShare: number | null;
  /** Finishing places that day, in game order. */
  readonly ranks: readonly number[];
  /** `null` when no game that day recorded the figure. */
  readonly plans: number | null;
  readonly planFailures: number | null;
  /** Median of the day's per-game medians. */
  readonly latencyMsMedian: number | null;
  readonly outputTokensMedian: number | null;
}

/** The days before the day under review, on the model under review only. */
export interface FrontierFormTrailing {
  /** Days before the day under review that count for results. */
  readonly days: number;
  readonly battles: number;
  readonly wins: number;
  readonly winRate: number | null;
  /** Over the `speedDays` before, same setup only. */
  readonly latencyMsMedian: number | null;
  readonly outputTokensMedian: number | null;
  readonly speedDays: number;
}

export type FrontierVerdictKind =
  | "normal"
  | "slower"
  | "faster"
  | "wordier"
  | "terser"
  | "flakier"
  | "too_few";

export interface FrontierFormToday {
  /** The day under review; `null` before the model's first battle. */
  readonly day: string | null;
  readonly verdictKind: FrontierVerdictKind;
  /** P(this many wins or fewer) at the trailing win rate. */
  readonly chanceOfResult: number | null;
  readonly sentence: string;
}

export interface FrontierFormModel {
  readonly label: string;
  readonly displayName: string;
  readonly provider: string;
  /** Oldest first. */
  readonly days: readonly FrontierFormDay[];
  readonly trailing: FrontierFormTrailing;
  readonly today: FrontierFormToday;
}

export interface FrontierForm {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  /** How the latest game's seats were run. */
  readonly harness: FrontierHarness | null;
  readonly models: readonly FrontierFormModel[];
}

/** One model's part in one game. */
interface ModelGame {
  readonly day: string;
  readonly completedAt: string;
  /** The slug this side ran on in this game. */
  readonly model: string;
  readonly won: boolean;
  readonly landShare: number | null;
  readonly rank: number | null;
  readonly telemetry: FrontierSeatTelemetry | null;
  /** The model and how its seat was run; speed compares only like with like. */
  readonly setup: string;
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomialAtMost(k: number, n: number, p: number): number {
  if (!Number.isInteger(n) || n < 0) throw new Error("n must be a count");
  if (k < 0) return 0;
  if (k >= n) return 1;
  if (p <= 0) return 1;
  if (p >= 1) return 0;
  let term = Math.pow(1 - p, n);
  let total = term;
  for (let i = 1; i <= k; i++) {
    term *= ((n - i + 1) / i) * (p / (1 - p));
    total += term;
  }
  return Math.min(1, Math.max(0, total));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function roundOrNull(value: number | null, digits: number): number | null {
  return value === null ? null : round(value, digits);
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The model plus the game-wide harness settings. `reasoning` is left out:
 * the scheduler takes it from whichever seat logged first, and a seat whose
 * route refused reasoning logs "dropped", so it changes with seat order
 * rather than with how the game was run.
 */
function setupKey(model: string, harness: FrontierHarness | null): string {
  return JSON.stringify([
    model,
    ...(harness === null
      ? ["unknown"]
      : [
          harness.playerVersion,
          harness.planEvery,
          harness.plansPerSeat,
          harness.maxOutputTokens,
        ]),
  ]);
}

function modelGames(
  records: readonly FrontierGameRecordV2[],
  label: string,
): ModelGame[] {
  const games: ModelGame[] = [];
  for (const record of records) {
    const side = record.sides.find((entry) => entry.label === label);
    if (side === undefined) continue;
    const standing =
      record.standings.find((entry) => entry.label === label) ?? null;
    games.push({
      day: record.completedAt.slice(0, 10),
      completedAt: record.completedAt,
      model: side.model,
      won: record.winnerLabel === label,
      landShare: standing?.landShare ?? null,
      rank: standing?.rank ?? null,
      telemetry: Object.hasOwn(record.telemetry, label)
        ? record.telemetry[label]
        : null,
      setup: setupKey(side.model, record.harness),
    });
  }
  return games;
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0
    ? null
    : present.reduce((total, value) => total + value, 0);
}

function present(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null);
}

function dayOf(day: string, games: readonly ModelGame[]): FrontierFormDay {
  const shares = present(games.map((game) => game.landShare));
  return {
    day,
    battles: games.length,
    wins: games.filter((game) => game.won).length,
    meanLandShare:
      shares.length === 0
        ? null
        : round(
            shares.reduce((total, share) => total + share, 0) / shares.length,
            4,
          ),
    ranks: present(games.map((game) => game.rank)),
    plans: sumOrNull(games.map((game) => game.telemetry?.plans ?? null)),
    planFailures: sumOrNull(
      games.map((game) => game.telemetry?.planFailures ?? null),
    ),
    latencyMsMedian: roundOrNull(
      median(
        present(games.map((game) => game.telemetry?.latencyMsMedian ?? null)),
      ),
      0,
    ),
    outputTokensMedian: roundOrNull(
      median(
        present(
          games.map((game) => game.telemetry?.outputTokensMedian ?? null),
        ),
      ),
      0,
    ),
  };
}

function groupByDay(games: readonly ModelGame[]): FrontierFormDay[] {
  const byDay = new Map<string, ModelGame[]>();
  for (const game of games) {
    const list = byDay.get(game.day) ?? [];
    list.push(game);
    byDay.set(game.day, list);
  }
  return [...byDay.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([day, list]) => dayOf(day, list));
}

function failureRate(day: {
  plans: number | null;
  planFailures: number | null;
}): number | null {
  return day.plans === null || day.plans === 0 || day.planFailures === null
    ? null
    : day.planFailures / day.plans;
}

/** `"up"` or `"down"` when the day is outside every earlier day AND >15% off. */
function shift(
  value: number | null,
  base: number | null,
  earlierDays: readonly number[],
): "up" | "down" | null {
  if (value === null || base === null || base <= 0) return null;
  if (earlierDays.length === 0) return null;
  if (
    value > Math.max(...earlierDays) &&
    value > base * (1 + FRONTIER_FORM_MIN_SHIFT)
  ) {
    return "up";
  }
  if (
    value < Math.min(...earlierDays) &&
    value < base * (1 - FRONTIER_FORM_MIN_SHIFT)
  ) {
    return "down";
  }
  return null;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function whenWords(day: string, today: string): string {
  if (day === today) return "today";
  if (day === addDays(today, -1)) return "yesterday";
  const date = new Date(`${day}T00:00:00.000Z`);
  return `on ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function resultSentence(
  day: FrontierFormDay,
  when: string,
  winRate: number | null,
  chance: number | null,
): string {
  const battles = day.battles === 1 ? "battle" : "battles";
  const record = `Won ${day.wins} of ${day.battles} ${battles} ${when}`;
  if (winRate === null || chance === null) return `${record}.`;
  if (day.wins >= day.battles * winRate) {
    return `${record}, at or above its usual ${percent(winRate)} win rate.`;
  }
  const often =
    chance < 0.01
      ? "less than 1% of the time"
      : `${percent(chance)} of the time`;
  return `${record}. At its usual ${percent(winRate)} win rate, a day this bad or worse happens ${often}.`;
}

function finishSentence(parts: readonly string[]): string {
  const full = sanitizeFrontierPublicText(
    parts.join(" "),
    FRONTIER_FORM_SENTENCE_MAX_CHARS,
  );
  return full ?? sanitizeFrontierPublicText(parts[0], 240) ?? "";
}

/**
 * The verdict on the day under review. `games` is every game this model
 * played; `now` decides what "today" means in the sentence.
 */
function frontierFormVerdict(
  games: readonly ModelGame[],
  now: string,
): { today: FrontierFormToday; trailing: FrontierFormTrailing } {
  const today = now.slice(0, 10);
  const reviewDay =
    games.length === 0
      ? null
      : games.reduce(
          (latest, game) => (game.day > latest ? game.day : latest),
          games[0].day,
        );
  const anchor = reviewDay ?? today;
  const dayGames = games.filter((game) => game.day === anchor);
  // The day's latest game names the model, and the setup, under review.
  const latest = [...dayGames]
    .sort((left, right) => (left.completedAt < right.completedAt ? -1 : 1))
    .at(-1);
  const resultFrom = addDays(anchor, -FRONTIER_FORM_RESULT_DAYS);
  const resultWindow = games.filter(
    (game) => game.day >= resultFrom && game.day < anchor,
  );
  // Results only against the same model: a label moved to a new slug starts
  // a fresh record.
  const resultGames = resultWindow.filter(
    (game) => game.model === latest?.model,
  );
  const modelChanged = resultWindow.some(
    (game) => game.model !== latest?.model,
  );
  // Speed and length only against games run the same way as the latest one,
  // on both sides of the comparison.
  const speedFrom = addDays(anchor, -FRONTIER_FORM_SPEED_DAYS);
  const speedGames = games.filter(
    (game) =>
      game.day >= speedFrom &&
      game.day < anchor &&
      game.setup === latest?.setup,
  );
  const wins = resultGames.filter((game) => game.won).length;
  const winRate =
    resultGames.length === 0 ? null : round(wins / resultGames.length, 4);
  const baseLatency = median(
    present(speedGames.map((game) => game.telemetry?.latencyMsMedian ?? null)),
  );
  const baseOutput = median(
    present(
      speedGames.map((game) => game.telemetry?.outputTokensMedian ?? null),
    ),
  );
  const trailing: FrontierFormTrailing = {
    days: FRONTIER_FORM_RESULT_DAYS,
    battles: resultGames.length,
    wins,
    winRate,
    latencyMsMedian: roundOrNull(baseLatency, 0),
    outputTokensMedian: roundOrNull(baseOutput, 0),
    speedDays: FRONTIER_FORM_SPEED_DAYS,
  };

  if (reviewDay === null) {
    return {
      trailing,
      today: {
        day: null,
        verdictKind: "too_few",
        chanceOfResult: null,
        sentence: "No battles yet.",
      },
    };
  }
  const day = dayOf(
    reviewDay,
    dayGames.filter((game) => game.model === latest?.model),
  );
  const speedDay = dayOf(
    reviewDay,
    dayGames.filter((game) => game.setup === latest?.setup),
  );
  const when = whenWords(reviewDay, today);
  if (resultGames.length < FRONTIER_FORM_MIN_TRAILING_BATTLES) {
    return {
      trailing,
      today: {
        day: reviewDay,
        verdictKind: "too_few",
        chanceOfResult: null,
        sentence: finishSentence([
          resultSentence(day, when, null, null),
          modelChanged
            ? "Its model changed recently, so there are too few battles on the new one to compare yet."
            : "Too few earlier battles to compare yet.",
        ]),
      },
    };
  }

  const chance = round(binomialAtMost(day.wins, day.battles, winRate ?? 0), 4);
  let verdictKind: FrontierVerdictKind = "normal";
  let shiftSentence: string | null = null;
  if (speedDay.plans !== null && speedDay.plans >= FRONTIER_FORM_MIN_PLANS) {
    const earlier = groupByDay(speedGames);
    const todayFailures = failureRate(speedDay);
    const earlierPlans = sumOrNull(earlier.map((entry) => entry.plans));
    const earlierFailures = sumOrNull(
      earlier.map((entry) => entry.planFailures),
    );
    const baseFailures =
      earlierPlans === null || earlierPlans === 0 || earlierFailures === null
        ? null
        : earlierFailures / earlierPlans;
    const earlierFailureRates = present(earlier.map(failureRate));
    const latencyShift = shift(
      speedDay.latencyMsMedian,
      baseLatency,
      present(earlier.map((entry) => entry.latencyMsMedian)),
    );
    const outputShift = shift(
      speedDay.outputTokensMedian,
      baseOutput,
      present(earlier.map((entry) => entry.outputTokensMedian)),
    );
    const change = (value: number | null, base: number | null) =>
      value === null || base === null || base <= 0
        ? ""
        : percent(Math.abs(value / base - 1));
    if (
      todayFailures !== null &&
      baseFailures !== null &&
      earlierFailureRates.length > 0 &&
      todayFailures > Math.max(...earlierFailureRates) &&
      todayFailures > baseFailures + FRONTIER_FORM_MIN_SHIFT
    ) {
      verdictKind = "flakier";
      shiftSentence = `Reliability: ${speedDay.planFailures} of its ${speedDay.plans} plans failed, against ${percent(baseFailures)} the week before.`;
    } else if (latencyShift === "up") {
      verdictKind = "slower";
      shiftSentence = `Speed: its answers took ${change(speedDay.latencyMsMedian, baseLatency)} longer than the week before.`;
    } else if (latencyShift === "down") {
      verdictKind = "faster";
      shiftSentence = `Speed: its answers took ${change(speedDay.latencyMsMedian, baseLatency)} less time than the week before.`;
    } else if (outputShift === "up") {
      verdictKind = "wordier";
      shiftSentence = `Length: its answers were ${change(speedDay.outputTokensMedian, baseOutput)} longer than the week before.`;
    } else if (outputShift === "down") {
      verdictKind = "terser";
      shiftSentence = `Length: its answers were ${change(speedDay.outputTokensMedian, baseOutput)} shorter than the week before.`;
    }
  }
  return {
    trailing,
    today: {
      day: reviewDay,
      verdictKind,
      chanceOfResult: chance,
      sentence: finishSentence(
        shiftSentence === null
          ? [resultSentence(day, when, winRate, chance)]
          : [resultSentence(day, when, winRate, chance), shiftSentence],
      ),
    },
  };
}

/**
 * The whole Nerf Watch file: one entry per side, roster order first. Only
 * Season 2 records count; Season 1 carried no per-model telemetry.
 */
export function buildFrontierForm(
  records: readonly FrontierGameRecord[],
  options: {
    readonly now: string;
    readonly teams: readonly FrontierFourTeam[];
  },
): FrontierForm {
  const seasonTwo = uniqueFrontierGames(records)
    .filter(
      (record): record is FrontierGameRecordV2 => record.schemaVersion === 2,
    )
    .sort((left, right) =>
      left.completedAt < right.completedAt
        ? -1
        : left.completedAt > right.completedAt
          ? 1
          : left.episodeRequestId.localeCompare(right.episodeRequestId),
    );
  const teams = [...options.teams];
  for (const record of seasonTwo) {
    for (const side of record.sides) {
      if (teams.some((team) => team.label === side.label)) continue;
      teams.push({
        label: side.label,
        model: side.model,
        displayName: side.label,
        provider: side.model.split("/")[0] ?? "",
        color: "#94a3b8",
        secondaryColor: "#1e293b",
        emblemSvg: "",
      });
    }
  }
  const models = teams.map((team): FrontierFormModel => {
    const games = modelGames(seasonTwo, team.label);
    const { today, trailing } = frontierFormVerdict(games, options.now);
    return {
      label: team.label,
      displayName: team.displayName,
      provider: team.provider,
      days: groupByDay(games).slice(-FRONTIER_FORM_DAY_LIMIT),
      trailing,
      today,
    };
  });
  return {
    schemaVersion: 1,
    generatedAt: options.now,
    harness: seasonTwo.at(-1)?.harness ?? null,
    models,
  };
}

/** Writes `frontier-form.json` beside `world.json`; unchanged content is not rewritten. */
export async function publishFrontierForm(args: {
  readonly siteDir: string;
  readonly records: readonly FrontierGameRecord[];
  readonly teams: readonly FrontierFourTeam[];
  readonly now: string;
}): Promise<{ readonly formPath: string; readonly form: FrontierForm }> {
  const form = buildFrontierForm(args.records, {
    now: args.now,
    teams: args.teams,
  });
  const formPath = path.join(args.siteDir, FRONTIER_FORM_FILE);
  await writeFileAtomic(formPath, `${JSON.stringify(form)}\n`);
  return { formPath, form };
}
