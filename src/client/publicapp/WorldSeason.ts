import {
  WORLD_THEATRE_IDS,
  type FormDay,
  type FormModel,
  type WorldLatestBattle,
  type WorldModel,
  type WorldSchedule,
  type WorldStanding,
  type WorldTeam,
  type WorldTheatreId,
  type WorldVoice,
} from "./WorldModelSchema";
import { battlefieldKey } from "./WorldPresentation";

/**
 * Season 2 of the Frontier (`mode: "frontier"`): five frontier models, one
 * nation each, two battles a day at fixed UTC times. Pure rules for what
 * `/world` and the front page show of it — names, the schedule, which of a
 * battle's lines to quote — kept apart from markup so they are testable
 * without a DOM. Shapes: contract C of the Season 2 spec.
 */

/** The open starter a builder begins an agent of their own from. */
export const STARTER_REPOSITORY_URL =
  "https://github.com/0xNad/proxywar-coworld-starter";
/** Where a builder tests an agent of their own (as the build page links it). */
export const OBSERVATORY_URL = "https://softmax.com/observatory";

/** A quoted dispatch is at most this long, a message to a rival this long. */
export const DISPATCH_MAX_CHARS = 140;
export const MESSAGE_MAX_CHARS = 280;
/** How many of a battle's lines the hero quotes. */
export const HERO_VOICES = 3;
/** After its slot, a battle reads as "due" for this long or until it ends. */
export const BATTLE_DUE_MS = 90 * 60 * 1000;
/** Fewer trailing battles than this and a day's result cannot be judged. */
export const FORM_MIN_TRAILING_BATTLES = 10;
/** The publisher judges speed, length and failures only on this many plans. */
export const FORM_MIN_PLANS = 8;
/** The Season 1 note is shown whole or not at all, never cut mid-sentence. */
export const RECAP_NOTE_MAX_CHARS = 600;

export function isSeasonTwo(model: { readonly mode?: string }): boolean {
  return model.mode === "frontier";
}

export function teamOf(
  model: Pick<WorldModel, "teams">,
  label: string | null,
): WorldTeam | undefined {
  if (label === null) return undefined;
  return model.teams?.find((team) => team.label === label);
}

/**
 * A side's name as people know it: the model's full name ("Claude Opus
 * 5.5") where the world gives one, else the agent's label, else the name.
 */
export function displayNameOf(
  model: Pick<WorldModel, "teams" | "agents">,
  name: string,
): string {
  const displayName = nonEmpty(teamOf(model, name)?.displayName);
  if (displayName !== null) return displayName;
  return model.agents.find((agent) => agent.name === name)?.label ?? name;
}

/** Who made the model ("Anthropic"), when the world says. */
export function providerOf(
  model: Pick<WorldModel, "teams">,
  name: string | null,
): string | null {
  return nonEmpty(teamOf(model, name)?.provider);
}

/** A trimmed string, or null when there is nothing in it. */
export function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

// The publisher's patterns (sanitizeFrontierPublicText), mirrored so the
// two passes agree: line breaks and control characters become spaces;
// invisible formatting characters, including the separator the page uses
// to splice names into translated sentences, are removed outright so they
// cannot split a link the patterns below would otherwise catch.
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const FORMAT = /\p{Cf}/gu;
const LINK = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S*/gi;
const BARE_DOMAIN =
  /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|xyz|gg|co|app|dev|me|ly|tv|link|site|info|biz|sh|to)\b(?:\/\S*)?/gi;
const HANDLE = /@[\p{L}\p{N}_.]+/gu;

function cleanText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(CONTROL, " ")
    .replace(FORMAT, "")
    .replace(LINK, " ")
    .replace(BARE_DOMAIN, " ")
    .replace(HANDLE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A model's words made safe to show, again on this side of the wire: no
 * links or bare domains, no @handles, no control or invisible characters,
 * one line, at most `max` characters (cut at a word, with an ellipsis).
 * The publisher does the same; this is the second line of defence.
 */
export function publicText(text: string, max: number): string {
  const cleaned = cleanText(text);
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Like `publicText`, but a sentence that does not fit is left out rather
 * than cut, so it never ends mid-thought (as the publisher does).
 */
export function wholePublicText(text: string, max: number): string {
  const cleaned = cleanText(text);
  return [...cleaned].length <= max ? cleaned : "";
}

/**
 * The lines the hero quotes from a battle: public dispatches before
 * messages, the winner's first, one per model before anyone gets a second,
 * then told in the order they were said.
 */
export function pickVoices(
  voices: readonly WorldVoice[],
  winner: string | null,
  max = HERO_VOICES,
): WorldVoice[] {
  const usable = voices
    .map((voice, index) => ({
      voice: {
        ...voice,
        text: publicText(
          voice.text,
          voice.kind === "dispatch" ? DISPATCH_MAX_CHARS : MESSAGE_MAX_CHARS,
        ),
      },
      index,
    }))
    .filter((entry) => entry.voice.text !== "");
  const ranked = [...usable].sort(
    (a, b) =>
      (a.voice.kind === "dispatch" ? 0 : 1) -
        (b.voice.kind === "dispatch" ? 0 : 1) ||
      (a.voice.label === winner ? 0 : 1) - (b.voice.label === winner ? 0 : 1) ||
      a.index - b.index,
  );
  const picked: typeof usable = [];
  const speakers = new Set<string>();
  for (const entry of ranked) {
    if (picked.length >= max) break;
    if (speakers.has(entry.voice.label)) continue;
    picked.push(entry);
    speakers.add(entry.voice.label);
  }
  for (const entry of ranked) {
    if (picked.length >= max) break;
    if (!picked.includes(entry)) picked.push(entry);
  }
  return picked
    .sort(
      (a, b) =>
        (a.voice.turn ?? Number.MAX_SAFE_INTEGER) -
          (b.voice.turn ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
    )
    .map((entry) => entry.voice);
}

/**
 * The front a battle counted for: its `frontLabel` when that is a front id,
 * else the front whose maps include the battle's map, else the label as
 * written (a name) or nothing.
 */
export function battleFront(
  model: Pick<WorldModel, "theatres">,
  battle: Pick<WorldLatestBattle, "frontLabel" | "map">,
): { readonly id: WorldTheatreId } | { readonly name: string } | null {
  const label = publicText(battle.frontLabel ?? "", 60);
  const byId = (WORLD_THEATRE_IDS as readonly string[]).includes(label)
    ? (label as WorldTheatreId)
    : null;
  if (byId !== null) return { id: byId };
  const key = battlefieldKey(battle.map);
  const byMap = model.theatres.find((theatre) =>
    theatre.battlefields.includes(key),
  );
  if (byMap !== undefined) return { id: byMap.id };
  return label === "" ? null : { name: label };
}

/**
 * Where "Watch the replay" goes: the hosted viewer the publisher named,
 * else this site's page for the battle (from the world's events, or built
 * from an id of the usual shape), else nowhere.
 */
export function watchHrefOf(
  model: Pick<WorldModel, "events">,
  battle: Pick<WorldLatestBattle, "watchHref" | "episodeRequestId">,
): string | null {
  if (battle.watchHref !== null) return battle.watchHref;
  const event = model.events.find(
    (entry) => entry.episodeRequestId === battle.episodeRequestId,
  );
  if (event !== undefined) return event.href;
  return /^ereq_[A-Za-z0-9_-]+$/.test(battle.episodeRequestId)
    ? `/match/${battle.episodeRequestId}`
    : null;
}

/** A battle's final order: by rank, else by land held. */
export function orderedStandings(
  standings: readonly WorldStanding[],
): WorldStanding[] {
  return [...standings].sort(
    (a, b) =>
      (a.rank ?? Number.MAX_SAFE_INTEGER) -
        (b.rank ?? Number.MAX_SAFE_INTEGER) ||
      (b.landShare ?? -1) - (a.landShare ?? -1),
  );
}

export type ScheduleStatus =
  /** The next battle is booked and still ahead. */
  | { readonly kind: "next"; readonly at: string; readonly minutes: number }
  /** Its time has just passed: it is probably being fought. */
  | { readonly kind: "due"; readonly at: string }
  /** No booking to trust: the timetable itself. */
  | { readonly kind: "times"; readonly times: readonly string[] };

const DAY_MS = 86_400_000;

/** The timetable's slots on the UTC days around `now`, earliest first. */
function slotsAround(timesUtc: readonly string[], now: number): number[] {
  const midnight = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
  const slots: number[] = [];
  for (const offset of [-1, 0, 1]) {
    for (const time of timesUtc) {
      const [hours, minutes] = time.split(":").map(Number);
      slots.push(midnight + offset * DAY_MS + (hours * 60 + minutes) * 60_000);
    }
  }
  return slots.sort((a, b) => a - b);
}

/**
 * What to say about the next battle, from the timetable, the booking the
 * publisher wrote and when the newest battle finished.
 *
 * The publisher books the first slot after the moment it runs, and it runs
 * again within a minute of each slot, so the booking moves on to the
 * following slot while that slot's battle is still being fought. A slot
 * that passed less than `BATTLE_DUE_MS` ago with no battle finished since
 * is therefore "due", whatever the booking says, unless the booking skips
 * past the following slot too (a hold until credits refill: nothing is
 * being fought). A booking is a promise only while battles are actually
 * happening: after a whole day without one, or with no booking at all
 * (out of credits, say), the page states the timetable instead.
 */
export function scheduleStatus(
  schedule: WorldSchedule | undefined,
  now: number,
  lastBattleAt: string | null = null,
): ScheduleStatus | null {
  if (schedule === undefined) return null;
  const times: ScheduleStatus | null =
    schedule.timesUtc.length > 0
      ? { kind: "times", times: schedule.timesUtc }
      : null;
  const next =
    schedule.nextBattleAt === null ? NaN : Date.parse(schedule.nextBattleAt);
  if (!Number.isFinite(next)) return times;
  const last = lastBattleAt === null ? NaN : Date.parse(lastBattleAt);
  const slots = slotsAround(schedule.timesUtc, now);
  const following = slots.find((slot) => slot > now) ?? null;
  const held = following !== null && next > following;
  if (!held) {
    const due = [...slots.filter((slot) => slot <= next), next]
      .filter(
        (slot) => slot <= now && now - slot <= BATTLE_DUE_MS && !(last >= slot),
      )
      .reduce<
        number | null
      >((latest, slot) => (latest === null || slot > latest ? slot : latest), null);
    if (due !== null) {
      return { kind: "due", at: new Date(due).toISOString() };
    }
  }
  const idle = Number.isFinite(last) && now - last > DAY_MS + BATTLE_DUE_MS;
  if (next > now && (held || !idle)) {
    return {
      kind: "next",
      at: new Date(next).toISOString(),
      minutes: Math.ceil((next - now) / 60_000),
    };
  }
  return times;
}

/** "13:00": a moment's time of day in UTC, on the 24-hour clock. */
export function utcClock(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const date = new Date(time);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(
    date.getUTCMinutes(),
  ).padStart(2, "0")}`;
}

/** The UTC calendar day of a moment, as the form file names days. */
export function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** A model's newest day in the form file, if it has fought at all. */
export function latestFormDay(model: FormModel): FormDay | null {
  const days = model.days.filter((day) => day.battles > 0);
  if (days.length === 0) return null;
  return days.reduce((latest, day) => (day.day > latest.day ? day : latest));
}

/**
 * How many days before the judged day the brain scan compares with. The
 * publisher measures think time and answer length over its `speedDays`
 * (the week before, same setup), while `days` counts for results (30), so
 * the scan reads `speedDays` when the file gives it.
 */
export function scanWindowDays(model: FormModel): number {
  return model.trailing?.speedDays ?? model.trailing?.days ?? 7;
}

/**
 * The share of plans that failed over the scan window, leaving out the day
 * being judged so it is compared with the days before it; `null` when
 * those days made no plans.
 */
export function trailingFailureRate(
  model: FormModel,
  judged: FormDay | null,
): number | null {
  const window = scanWindowDays(model);
  const newest = judged?.day ?? null;
  const earliest =
    newest === null
      ? null
      : utcDay(Date.parse(`${newest}T00:00:00Z`) - window * DAY_MS);
  let plans = 0;
  let failures = 0;
  for (const day of model.days) {
    if (newest !== null && day.day >= newest) continue;
    if (earliest !== null && day.day < earliest) continue;
    if (day.plans === null || day.plans <= 0) continue;
    plans += day.plans;
    failures += day.planFailures ?? 0;
  }
  return plans === 0 ? null : failures / plans;
}
