import fs from "node:fs/promises";
import path from "node:path";
import {
  COWORLD_LEAGUE_WORLD_FILE,
  COWORLD_LEAGUE_WORLD_SOURCE_FILE,
  writeFileAtomic,
  type CoworldLeagueEpisodeRow,
  type CoworldLeagueMirrorData,
} from "./CoworldLeagueSiteWriter";
import {
  buildPublicWorldModel,
  EMPTY_WORLD_LEDGER,
  mergeWorldLedger,
  reduceWorld,
  type PublicWorldLinks,
  type PublicWorldModel,
  type WorldAgentIdentity,
  type WorldLedgerBattle,
} from "./CoworldLeagueWorld";

/**
 * The Frontier: frontier models fighting over the fronts of the world map
 * in hosted games that our own scheduler creates. This module turns the
 * scheduler's game records into the same world the league feeds, publishes
 * `world.json` from them, and marks the site so the league mirror leaves the
 * world alone while the Frontier holds it.
 *
 * Season 1 (the Frontier Four, `schemaVersion: 1` records) was four teams of
 * three nations, each team one model. Season 2 (`schemaVersion: 2`, contract
 * B in the Season 2 spec) is one nation per model, free-for-all, with any
 * number of sides; most games end at the step cap and are decided on points.
 *
 * A game record is one completed hosted episode. The scheduler appends one
 * JSON line per game to its games file; this module never writes that file,
 * only reads it, so the records are the ledger.
 */

export const FRONTIER_FOUR_GAMES_FILE = "frontier-four-games.jsonl";
/** Season 2's games file: one `schemaVersion: 2` record per line. */
export const FRONTIER_FFA_GAMES_FILE = "frontier-ffa-games.jsonl";
/** `/match/<id>` rows for Frontier games, read by the demo server. */
export const FRONTIER_FOUR_EPISODES_FILE = "frontier-episodes.json";
/** Season 2: the latest battle on a front decides it. */
export const FRONTIER_FRONT_WINDOW = 1;
export const FRONTIER_SEASON = 2;
export const FRONTIER_DEFAULT_BATTLE_TIMES_UTC: readonly string[] = [
  "13:00",
  "19:00",
];
export const FRONTIER_LATEST_VOICE_LIMIT = 6;
export const FRONTIER_DISPATCH_MAX_CHARS = 140;
export const FRONTIER_MESSAGE_MAX_CHARS = 280;
const FRONTIER_GAME_VOICE_LIMIT = 40;
const FRONTIER_MOMENT_LIMIT = 40;
const FRONTIER_MOMENT_MAX_CHARS = 140;
const FRONTIER_FRONT_LABEL_MAX_CHARS = 60;

/** Season 1's two setup flaws, said plainly beside its record. */
export const FRONTIER_SEASON_ONE_NOTE =
  "Season 1 was not a fair test. Grok always picked its starting spot last because seats went in name order, and the two most expensive models often ran out of budget to think partway through a game. Season 2 rotates who picks first and lets every model think the same number of times.";

export interface FrontierFourTeam {
  /** The side's name on the map, e.g. `Opus`. */
  readonly label: string;
  /** The canonical OpenRouter slug the side's seats run on. */
  readonly model: string;
  /** The model's public name, e.g. `Claude Opus 5.5`. */
  readonly displayName: string;
  /** Who makes the model, e.g. `Anthropic`. */
  readonly provider: string;
  readonly color: string;
  readonly secondaryColor: string;
  readonly emblemSvg: string;
}

function emblem(letter: string, color: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="4" fill="${color}"/>` +
    `<text x="16" y="22" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="18" font-weight="700" fill="#0b1220">${letter}</text>` +
    `</svg>`
  );
}

const ASTRA: FrontierFourTeam = {
  label: "Astra",
  model: "openai/gpt-6-astra",
  displayName: "GPT-6 Astra",
  provider: "OpenAI",
  color: "#60a5fa",
  secondaryColor: "#1e3a8a",
  emblemSvg: emblem("A", "#60a5fa"),
};
const FABLE: FrontierFourTeam = {
  label: "Fable",
  model: "anthropic/claude-fable-5.1",
  displayName: "Claude Fable 5.1",
  provider: "Anthropic",
  color: "#f59e0b",
  secondaryColor: "#78350f",
  emblemSvg: emblem("F", "#f59e0b"),
};
// Pink: apart from Astra's blue, Fable's amber, Gemini's violet and Grok's
// green, and light enough to read on the dark map.
const OPUS: FrontierFourTeam = {
  label: "Opus",
  model: "anthropic/claude-opus-5.5",
  displayName: "Claude Opus 5.5",
  provider: "Anthropic",
  color: "#f472b6",
  secondaryColor: "#831843",
  emblemSvg: emblem("O", "#f472b6"),
};
const GEMINI: FrontierFourTeam = {
  label: "Gemini",
  model: "google/gemini-3.1-pro-preview",
  displayName: "Gemini 3.1 Pro",
  provider: "Google",
  color: "#a78bfa",
  secondaryColor: "#4c1d95",
  emblemSvg: emblem("G", "#a78bfa"),
};
const GROK: FrontierFourTeam = {
  label: "Grok",
  model: "x-ai/grok-4.7",
  displayName: "Grok 4.7",
  provider: "xAI",
  color: "#34d399",
  secondaryColor: "#064e3b",
  emblemSvg: emblem("X", "#34d399"),
};

/** Season 1's four teams. */
export const FRONTIER_FOUR_TEAMS: readonly FrontierFourTeam[] = [
  ASTRA,
  FABLE,
  GEMINI,
  GROK,
];

/** Season 2's default roster; `--roster` replaces it. */
export const FRONTIER_SEASON_TWO_TEAMS: readonly FrontierFourTeam[] = [
  ASTRA,
  FABLE,
  OPUS,
  GEMINI,
  GROK,
];

/** Colours for sides a game names that the roster does not. */
const FALLBACK_TEAM_COLORS: readonly (readonly [string, string])[] = [
  ["#fb923c", "#7c2d12"],
  ["#22d3ee", "#164e63"],
  ["#facc15", "#713f12"],
  ["#a3e635", "#365314"],
  ["#e879f9", "#701a75"],
  ["#f87171", "#7f1d1d"],
];
const FALLBACK_COLOR = "#94a3b8";
const FALLBACK_SECONDARY_COLOR = "#1e293b";
const FALLBACK_COLORS: readonly [string, string] = [
  FALLBACK_COLOR,
  FALLBACK_SECONDARY_COLOR,
];

const PROVIDER_BY_SLUG_PREFIX: Readonly<Record<string, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "x-ai": "xAI",
  "meta-llama": "Meta",
  mistralai: "Mistral",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  moonshotai: "Moonshot AI",
};

function providerOfModel(model: string): string {
  const prefix = model.split("/")[0] ?? "";
  return Object.hasOwn(PROVIDER_BY_SLUG_PREFIX, prefix)
    ? PROVIDER_BY_SLUG_PREFIX[prefix]
    : prefix;
}

// ---------------------------------------------------------------------------
// Public text
// ---------------------------------------------------------------------------

const CONTROL_PATTERN = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const FORMAT_PATTERN = /\p{Cf}/gu;
const URL_PATTERN = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S*/gi;
const BARE_DOMAIN_PATTERN =
  /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|xyz|gg|co|app|dev|me|ly|tv|link|site|info|biz|sh|to)\b(?:\/\S*)?/gi;
// Any other `name.tld/path`: with a path it is a link whatever the ending.
const DOMAIN_WITH_PATH_PATTERN =
  /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/\S*/gi;
const HANDLE_PATTERN = /@[\p{L}\p{N}_.]+/gu;
const SPEAKABLE_PATTERN = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/**
 * Text a model wrote, made safe to show: no links, no @handles, no control
 * or invisible formatting characters, one line. Too long is dropped rather
 * than cut, so a line never ends mid-thought; nothing left is `null`. The
 * scheduler sanitizes too; this is the second pass before publishing.
 */
export function sanitizeFrontierPublicText(
  value: unknown,
  maxChars: number,
): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .normalize("NFKC")
    .replace(CONTROL_PATTERN, " ")
    .replace(FORMAT_PATTERN, "")
    .replace(URL_PATTERN, " ")
    .replace(HANDLE_PATTERN, " ")
    .replace(DOMAIN_WITH_PATH_PATTERN, " ")
    .replace(BARE_DOMAIN_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!SPEAKABLE_PATTERN.test(text)) return null;
  return [...text].length <= maxChars ? text : null;
}

// ---------------------------------------------------------------------------
// Game records
// ---------------------------------------------------------------------------

export interface FrontierFourGameTeam {
  readonly label: string;
  readonly model: string;
  /** The engine's team name for this side (`Red`, `Blue`, …), once known. */
  readonly team: string | null;
  readonly slots: readonly number[];
}

export interface FrontierFourGamePlayer {
  readonly slot: number;
  readonly name: string;
  readonly team: string | null;
  readonly tilesOwned: number | null;
  readonly isAlive: boolean | null;
}

/** A Season 1 record: four teams of three seats. */
export interface FrontierFourGameRecord {
  readonly schemaVersion: 1;
  readonly experienceRequestId: string;
  readonly episodeRequestId: string;
  readonly variantId: string;
  readonly map: string;
  readonly mapSize: string;
  readonly completedAt: string;
  readonly replayUrl: string | null;
  /** The hosted replay viewer page for this game, when the scheduler knew one. */
  readonly viewerUrl: string | null;
  readonly costUsd: number | null;
  /** The scheduler's cycle through the fronts; stands in for a round number. */
  readonly cycle: number;
  readonly teams: readonly FrontierFourGameTeam[];
  readonly winnerTeam: string | null;
  readonly scores: readonly number[];
  readonly players: readonly FrontierFourGamePlayer[];
  readonly turnCount: number | null;
  readonly decisionCount: number | null;
  readonly degradedCount: number | null;
}

export interface FrontierGameSide extends FrontierFourGameTeam {
  /** When this side chose its start in the spawn ballot (1 = first). */
  readonly pickOrder: number | null;
}

export type FrontierWinType = "conquest" | "points" | "none";

export interface FrontierStanding {
  readonly label: string;
  /** Share of the owned land, 0..1. */
  readonly landShare: number;
  readonly tilesOwned: number | null;
  readonly isAlive: boolean | null;
  readonly eliminatedAtTurn: number | null;
  readonly rank: number;
}

/** One side's model calls in one game; any figure may be missing. */
export interface FrontierSeatTelemetry {
  readonly plans: number | null;
  readonly planFailures: number | null;
  readonly timeouts: number | null;
  readonly latencyMsMedian: number | null;
  readonly latencyMsP90: number | null;
  readonly outputTokensMedian: number | null;
  readonly inputTokensMedian: number | null;
  readonly reasoningTokensMedian: number | null;
  readonly usd: number | null;
  readonly capped: boolean | null;
}

export interface FrontierVoice {
  readonly label: string;
  readonly kind: "dispatch" | "message";
  readonly to: string | null;
  readonly turn: number | null;
  readonly text: string;
}

export type FrontierMomentKind =
  | "elimination"
  | "betrayal"
  | "nuke"
  | "alliance"
  | "lead_change";

export interface FrontierMoment {
  readonly turn: number | null;
  readonly kind: FrontierMomentKind;
  readonly text: string;
}

/** How the seats were run; a change here can move speed and length. */
export interface FrontierHarness {
  readonly playerVersion: string | null;
  readonly planEvery: number | null;
  readonly plansPerSeat: number | null;
  readonly reasoning: string | null;
  readonly maxOutputTokens: number | null;
}

/** A Season 2 record (contract B): one seat per side, free-for-all. */
export interface FrontierGameRecordV2 {
  readonly schemaVersion: 2;
  readonly season: number;
  readonly format: string;
  readonly experienceRequestId: string;
  readonly episodeRequestId: string;
  readonly variantId: string;
  readonly map: string;
  readonly mapSize: string;
  /** The front's name as people read it, e.g. `East Asia`. */
  readonly frontLabel: string | null;
  readonly completedAt: string;
  readonly replayUrl: string | null;
  readonly viewerUrl: string | null;
  readonly costUsd: number | null;
  readonly cycle: number | null;
  readonly gameIndex: number | null;
  readonly episodeIndex: number | null;
  readonly sides: readonly FrontierGameSide[];
  readonly winnerLabel: string | null;
  readonly winType: FrontierWinType;
  /** Best rank first. */
  readonly standings: readonly FrontierStanding[];
  readonly turnCount: number | null;
  readonly decisionCount: number | null;
  readonly degradedCount: number | null;
  readonly telemetry: Readonly<Record<string, FrontierSeatTelemetry>>;
  readonly voices: readonly FrontierVoice[];
  readonly moments: readonly FrontierMoment[];
  readonly harness: FrontierHarness | null;
}

export type FrontierGameRecord = FrontierFourGameRecord | FrontierGameRecordV2;

const EPISODE_REQUEST_ID_PATTERN = /^ereq_[A-Za-z0-9_-]{1,160}$/;
// Accepts every label the scheduler's config accepts (letters, digits, `_`,
// `.` and single spaces), so a valid config never makes its games unreadable.
const FRONTIER_LABEL_PATTERN = /^[\p{L}\p{N}_][\p{L}\p{N} _.'-]{0,39}$/u;
const FRONTIER_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const FRONTIER_MAP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _'-]{0,59}$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MOMENT_KINDS: ReadonlySet<string> = new Set([
  "elimination",
  "betrayal",
  "nuke",
  "alliance",
  "lead_change",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  const number = optionalNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const number = nonNegativeNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function positiveInteger(value: unknown): number | null {
  const number = nonNegativeInteger(value);
  return number !== null && number >= 1 ? number : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function frontierLabel(value: unknown): string | null {
  return typeof value === "string" && FRONTIER_LABEL_PATTERN.test(value)
    ? value
    : null;
}

function slotsOf(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter(
        (slot): slot is number =>
          typeof slot === "number" && Number.isInteger(slot) && slot >= 0,
      )
    : [];
}

/** An `https:` link, or `null`; a watch link is never anything else. */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function canonicalCompletedAt(value: unknown): string | null {
  const text = optionalString(value);
  if (text === null) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** One Season 1 line of the games file, or `null` when it is not a usable record. */
export function parseFrontierFourGameRecord(
  value: unknown,
): FrontierFourGameRecord | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const episodeRequestId = optionalString(value.episodeRequestId);
  if (
    episodeRequestId === null ||
    !EPISODE_REQUEST_ID_PATTERN.test(episodeRequestId)
  ) {
    return null;
  }
  const map = optionalString(value.map);
  const completedAt = canonicalCompletedAt(value.completedAt);
  if (map === null || completedAt === null) return null;
  const cycle = optionalNumber(value.cycle);
  if (cycle === null || !Number.isInteger(cycle) || cycle < 1) return null;
  const teams = Array.isArray(value.teams) ? value.teams : [];
  const parsedTeams: FrontierFourGameTeam[] = [];
  for (const entry of teams) {
    if (!isRecord(entry)) return null;
    const label = optionalString(entry.label);
    const model = optionalString(entry.model);
    const slots = slotsOf(entry.slots);
    if (label === null || model === null || slots.length === 0) return null;
    parsedTeams.push({
      label,
      model,
      team: optionalString(entry.team),
      slots,
    });
  }
  if (parsedTeams.length < 2) return null;
  const players = Array.isArray(value.players) ? value.players : [];
  const parsedPlayers: FrontierFourGamePlayer[] = [];
  for (const entry of players) {
    if (!isRecord(entry)) continue;
    const slot = optionalNumber(entry.slot);
    const name = optionalString(entry.name);
    if (slot === null || name === null) continue;
    parsedPlayers.push({
      slot,
      name,
      team: optionalString(entry.team),
      tilesOwned: optionalNumber(entry.tilesOwned),
      isAlive: optionalBoolean(entry.isAlive),
    });
  }
  return {
    schemaVersion: 1,
    experienceRequestId: optionalString(value.experienceRequestId) ?? "",
    episodeRequestId,
    variantId: optionalString(value.variantId) ?? "",
    map,
    mapSize: optionalString(value.mapSize) ?? "",
    completedAt,
    replayUrl: optionalString(value.replayUrl),
    viewerUrl: optionalString(value.viewerUrl),
    costUsd: optionalNumber(value.costUsd),
    cycle,
    teams: parsedTeams,
    winnerTeam: optionalString(value.winnerTeam),
    scores: Array.isArray(value.scores)
      ? value.scores.filter(
          (score): score is number => typeof score === "number",
        )
      : [],
    players: parsedPlayers,
    turnCount: optionalNumber(value.turnCount),
    decisionCount: optionalNumber(value.decisionCount),
    degradedCount: optionalNumber(value.degradedCount),
  };
}

function parseTelemetry(entry: Record<string, unknown>): FrontierSeatTelemetry {
  return {
    plans: nonNegativeInteger(entry.plans),
    planFailures: nonNegativeInteger(entry.planFailures),
    timeouts: nonNegativeInteger(entry.timeouts),
    latencyMsMedian: nonNegativeNumber(entry.latencyMsMedian),
    latencyMsP90: nonNegativeNumber(entry.latencyMsP90),
    outputTokensMedian: nonNegativeNumber(entry.outputTokensMedian),
    inputTokensMedian: nonNegativeNumber(entry.inputTokensMedian),
    reasoningTokensMedian: nonNegativeNumber(entry.reasoningTokensMedian),
    usd: nonNegativeNumber(entry.usd),
    capped: optionalBoolean(entry.capped),
  };
}

function parseVoices(
  value: unknown,
  labels: ReadonlySet<string>,
): FrontierVoice[] {
  const voices: FrontierVoice[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (voices.length >= FRONTIER_GAME_VOICE_LIMIT) break;
    if (!isRecord(entry)) continue;
    const label = frontierLabel(entry.label);
    if (label === null || !labels.has(label)) continue;
    const kind =
      entry.kind === "dispatch" || entry.kind === "message" ? entry.kind : null;
    if (kind === null) continue;
    const text = sanitizeFrontierPublicText(
      entry.text,
      kind === "dispatch"
        ? FRONTIER_DISPATCH_MAX_CHARS
        : FRONTIER_MESSAGE_MAX_CHARS,
    );
    if (text === null) continue;
    const to = kind === "message" ? frontierLabel(entry.to) : null;
    voices.push({
      label,
      kind,
      to: to !== null && labels.has(to) ? to : null,
      turn: nonNegativeInteger(entry.turn),
      text,
    });
  }
  return voices;
}

function parseMoments(value: unknown): FrontierMoment[] {
  const moments: FrontierMoment[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (moments.length >= FRONTIER_MOMENT_LIMIT) break;
    if (!isRecord(entry) || typeof entry.kind !== "string") continue;
    if (!MOMENT_KINDS.has(entry.kind)) continue;
    const text = sanitizeFrontierPublicText(
      entry.text,
      FRONTIER_MOMENT_MAX_CHARS,
    );
    if (text === null) continue;
    moments.push({
      turn: nonNegativeInteger(entry.turn),
      kind: entry.kind as FrontierMomentKind,
      text,
    });
  }
  return moments;
}

function parseHarness(value: unknown): FrontierHarness | null {
  if (!isRecord(value)) return null;
  return {
    playerVersion: sanitizeFrontierPublicText(value.playerVersion, 64),
    planEvery: positiveInteger(value.planEvery),
    plansPerSeat: positiveInteger(value.plansPerSeat),
    reasoning: sanitizeFrontierPublicText(value.reasoning, 24),
    maxOutputTokens: positiveInteger(value.maxOutputTokens),
  };
}

/** One Season 2 line of the games file, or `null` when it is not a usable record. */
export function parseFrontierGameRecordV2(
  value: unknown,
): FrontierGameRecordV2 | null {
  if (!isRecord(value) || value.schemaVersion !== 2) return null;
  const episodeRequestId = optionalString(value.episodeRequestId);
  if (
    episodeRequestId === null ||
    !EPISODE_REQUEST_ID_PATTERN.test(episodeRequestId)
  ) {
    return null;
  }
  const map =
    typeof value.map === "string" && FRONTIER_MAP_PATTERN.test(value.map)
      ? value.map
      : null;
  const completedAt = canonicalCompletedAt(value.completedAt);
  if (map === null || completedAt === null) return null;

  const sides: FrontierGameSide[] = [];
  for (const entry of Array.isArray(value.sides) ? value.sides : []) {
    if (!isRecord(entry)) return null;
    const label = frontierLabel(entry.label);
    const model =
      typeof entry.model === "string" &&
      FRONTIER_MODEL_PATTERN.test(entry.model)
        ? entry.model
        : null;
    const slots = slotsOf(entry.slots);
    if (label === null || model === null || slots.length === 0) return null;
    if (sides.some((side) => side.label === label)) return null;
    sides.push({
      label,
      model,
      team: optionalString(entry.team),
      slots,
      pickOrder: positiveInteger(entry.pickOrder),
    });
  }
  if (sides.length < 2) return null;
  const labels = new Set(sides.map((side) => side.label));

  // A winner the game did not field, or a win with no way of winning, is a
  // broken record: better missing from the world than wrong on it.
  let winnerLabel: string | null = null;
  if (value.winnerLabel !== null && value.winnerLabel !== undefined) {
    winnerLabel = frontierLabel(value.winnerLabel);
    if (winnerLabel === null || !labels.has(winnerLabel)) return null;
  }
  let winType: FrontierWinType = "none";
  if (winnerLabel !== null) {
    if (value.winType !== "conquest" && value.winType !== "points") {
      return null;
    }
    winType = value.winType;
  }

  const standings: FrontierStanding[] = [];
  for (const entry of Array.isArray(value.standings) ? value.standings : []) {
    if (!isRecord(entry)) continue;
    const label = frontierLabel(entry.label);
    if (label === null || !labels.has(label)) continue;
    if (standings.some((standing) => standing.label === label)) continue;
    const landShare = nonNegativeNumber(entry.landShare);
    const rank = positiveInteger(entry.rank);
    if (landShare === null || landShare > 1 || rank === null) continue;
    standings.push({
      label,
      landShare,
      tilesOwned: nonNegativeInteger(entry.tilesOwned),
      isAlive: optionalBoolean(entry.isAlive),
      eliminatedAtTurn: nonNegativeInteger(entry.eliminatedAtTurn),
      rank,
    });
  }
  standings.sort(
    (left, right) =>
      left.rank - right.rank || left.label.localeCompare(right.label),
  );

  const telemetry: Record<string, FrontierSeatTelemetry> = {};
  if (isRecord(value.telemetry)) {
    for (const side of sides) {
      if (!Object.hasOwn(value.telemetry, side.label)) continue;
      const entry = value.telemetry[side.label];
      if (isRecord(entry)) telemetry[side.label] = parseTelemetry(entry);
    }
  }

  return {
    schemaVersion: 2,
    season: positiveInteger(value.season) ?? FRONTIER_SEASON,
    format: sanitizeFrontierPublicText(value.format, 24) ?? "ffa",
    experienceRequestId: optionalString(value.experienceRequestId) ?? "",
    episodeRequestId,
    variantId: optionalString(value.variantId) ?? "",
    map,
    mapSize: sanitizeFrontierPublicText(value.mapSize, 24) ?? "",
    frontLabel: sanitizeFrontierPublicText(
      value.frontLabel,
      FRONTIER_FRONT_LABEL_MAX_CHARS,
    ),
    completedAt,
    replayUrl: httpsUrl(value.replayUrl),
    viewerUrl: httpsUrl(value.viewerUrl),
    costUsd: nonNegativeNumber(value.costUsd),
    cycle: positiveInteger(value.cycle),
    gameIndex: nonNegativeInteger(value.gameIndex),
    episodeIndex: nonNegativeInteger(value.episodeIndex),
    sides,
    winnerLabel,
    winType,
    standings,
    turnCount: nonNegativeInteger(value.turnCount),
    decisionCount: nonNegativeInteger(value.decisionCount),
    degradedCount: nonNegativeInteger(value.degradedCount),
    telemetry,
    voices: parseVoices(value.voices, labels),
    moments: parseMoments(value.moments),
    harness: parseHarness(value.harness),
  };
}

/** One line of either season's games file, or `null`. */
export function parseFrontierGameRecord(
  value: unknown,
): FrontierGameRecord | null {
  return parseFrontierFourGameRecord(value) ?? parseFrontierGameRecordV2(value);
}

/**
 * One record per game, the first copy kept (as the world ledger does). The
 * scheduler appends a game before it saves its own state, so a crash in
 * between can append the same game twice.
 */
export function uniqueFrontierGames<T extends FrontierGameRecord>(
  records: readonly T[],
): T[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.episodeRequestId)) return false;
    seen.add(record.episodeRequestId);
    return true;
  });
}

/**
 * Every usable record of either season, in file order, each game once; a
 * missing file is no games.
 */
export async function readFrontierGames(
  gamesPath: string,
): Promise<FrontierGameRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(gamesPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: FrontierGameRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parseFrontierGameRecord(value);
    if (record !== null) records.push(record);
  }
  return uniqueFrontierGames(records);
}

/** Every usable Season 1 record in the games file, in file order. */
export async function readFrontierFourGames(
  gamesPath: string,
): Promise<FrontierFourGameRecord[]> {
  return (await readFrontierGames(gamesPath)).filter(
    (record): record is FrontierFourGameRecord => record.schemaVersion === 1,
  );
}

/** The sides a game fielded: Season 1 teams, or Season 2 single seats. */
export function frontierGameSides(
  record: FrontierGameRecord,
): readonly FrontierFourGameTeam[] {
  return record.schemaVersion === 2 ? record.sides : record.teams;
}

/**
 * The winning side's label. Season 2 records name it. Season 1 records name
 * the engine team, so the label is found by the engine team name the
 * scheduler recorded, else by which side the winning players' slots belong to.
 */
export function frontierFourWinnerLabel(
  record: FrontierGameRecord,
): string | null {
  if (record.schemaVersion === 2) return record.winnerLabel;
  if (record.winnerTeam === null) return null;
  const byTeam = record.teams.find((team) => team.team === record.winnerTeam);
  if (byTeam !== undefined) return byTeam.label;
  const winningSlots = new Set(
    record.players
      .filter((player) => player.team === record.winnerTeam)
      .map((player) => player.slot),
  );
  const bySlot = record.teams.find((team) =>
    team.slots.some((slot) => winningSlots.has(slot)),
  );
  return bySlot?.label ?? null;
}

/** One game as a world battle: the side, not the seat, holds the front. */
export function frontierFourBattle(
  record: FrontierGameRecord,
): WorldLedgerBattle {
  return {
    episodeRequestId: record.episodeRequestId,
    map: record.map,
    winnerName: frontierFourWinnerLabel(record),
    playerCount:
      record.schemaVersion === 2 ? record.sides.length : record.players.length,
    roundNumber: record.cycle,
    battleAt: record.completedAt,
  };
}

function teamOfSlot(
  record: FrontierFourGameRecord,
  slot: number,
): FrontierFourGameTeam | null {
  return record.teams.find((team) => team.slots.includes(slot)) ?? null;
}

/** The `/match/<id>` row for a game, in the league's own row shape. */
export function frontierFourEpisodeRow(
  record: FrontierGameRecord,
  teams: readonly FrontierFourTeam[] = FRONTIER_SEASON_TWO_TEAMS,
): CoworldLeagueEpisodeRow {
  const winnerLabel = frontierFourWinnerLabel(record);
  const colorOf = (label: string | null) =>
    teams.find((team) => team.label === label)?.color ?? FALLBACK_COLOR;
  const players =
    record.schemaVersion === 2
      ? record.sides
          .map((side) => {
            const standing = record.standings.find(
              (entry) => entry.label === side.label,
            );
            return {
              slot: side.slots[0],
              name: side.label,
              tilesOwned: standing?.tilesOwned ?? 0,
              isAlive: standing?.isAlive ?? false,
              isWinner: side.label === winnerLabel,
              color: colorOf(side.label),
            };
          })
          .sort((left, right) => left.slot - right.slot)
      : record.players.map((player) => {
          const side = teamOfSlot(record, player.slot);
          return {
            slot: player.slot,
            name: player.name,
            tilesOwned: player.tilesOwned ?? 0,
            isAlive: player.isAlive ?? false,
            isWinner:
              winnerLabel !== null &&
              side !== null &&
              side.label === winnerLabel,
            color: colorOf(side?.label ?? null),
          };
        });
  return {
    episodeRequestId: record.episodeRequestId,
    shortId: record.episodeRequestId.replace(/^ereq_/, "").slice(0, 8),
    roundNumber: record.cycle,
    completedAt: record.completedAt,
    map: record.map,
    mapSize: record.mapSize,
    turnCount: record.turnCount,
    decisionCount: record.decisionCount,
    degradedCount: record.degradedCount,
    winnerName: winnerLabel,
    players,
    // The viewer page when known; the raw replay file otherwise.
    watchHref: record.viewerUrl ?? record.replayUrl,
    fullRenderHref: null,
  };
}

/**
 * The sides as page identities, keyed by label. Season 2 shows the model's
 * public name, so nobody has to know which label is which model.
 */
export function frontierFourIdentities(
  teams: readonly FrontierFourTeam[] = FRONTIER_FOUR_TEAMS,
  options: { readonly showDisplayName?: boolean } = {},
): Map<string, WorldAgentIdentity> {
  return new Map(
    teams.map((team) => [
      team.label,
      {
        name: team.label,
        label: options.showDisplayName === true ? team.displayName : team.label,
        slug: null,
        color: team.color,
        secondaryColor: team.secondaryColor,
        emblemSvg: team.emblemSvg,
        isHouse: false,
      },
    ]),
  );
}

function fallbackTeam(
  label: string,
  model: string,
  colors: readonly [string, string],
): FrontierFourTeam {
  return {
    label,
    model,
    displayName: label,
    provider: providerOfModel(model),
    color: colors[0],
    secondaryColor: colors[1],
    emblemSvg: emblem(label.slice(0, 1).toUpperCase(), colors[0]),
  };
}

/** The public name and maker of a slug, from the roster or the usual five. */
function identityOfModel(
  model: string,
  roster: readonly FrontierFourTeam[],
): { displayName: string; provider: string } | null {
  const known =
    roster.find((team) => team.model === model) ??
    FRONTIER_SEASON_TWO_TEAMS.find((team) => team.model === model);
  return known === undefined
    ? null
    : { displayName: known.displayName, provider: known.provider };
}

/** Each Season 2 side's model in the latest game it played. */
function latestModelByLabel(
  records: readonly FrontierGameRecord[],
): Map<string, string> {
  const latest = new Map<string, { at: string; id: string; model: string }>();
  for (const record of records) {
    if (record.schemaVersion !== 2) continue;
    for (const side of record.sides) {
      const seen = latest.get(side.label);
      if (
        seen === undefined ||
        record.completedAt > seen.at ||
        (record.completedAt === seen.at && record.episodeRequestId > seen.id)
      ) {
        latest.set(side.label, {
          at: record.completedAt,
          id: record.episodeRequestId,
          model: side.model,
        });
      }
    }
  }
  return new Map(
    [...latest.entries()].map(([label, { model }]) => [label, model]),
  );
}

/** `team` on the model it last played, named for that model. */
function onPlayedModel(
  team: FrontierFourTeam,
  model: string | undefined,
  roster: readonly FrontierFourTeam[],
): FrontierFourTeam {
  if (model === undefined || model === team.model) return team;
  const identity = identityOfModel(model, roster);
  return {
    ...team,
    model,
    displayName: identity?.displayName ?? team.label,
    provider: identity?.provider ?? providerOfModel(model),
  };
}

/**
 * The roster plus any side the games fielded that the roster does not name,
 * in roster order then first appearance, each with a colour of its own: a
 * known model keeps its usual identity when its colour is free.
 *
 * A side is shown on the model its latest Season 2 game ran, so when the
 * roster and the games disagree (the operator moved a label to a new model
 * and it has not played yet, or the roster is out of date) the page names
 * the model that actually fought. Season 1 records only add missing sides.
 */
export function frontierTeamsFor(
  roster: readonly FrontierFourTeam[],
  records: readonly FrontierGameRecord[],
): FrontierFourTeam[] {
  const played = latestModelByLabel(records);
  const teams = roster.map((team) =>
    onPlayedModel(team, played.get(team.label), roster),
  );
  const known = new Set(roster.map((team) => team.label));
  const usedColors = new Set(roster.map((team) => team.color.toLowerCase()));
  for (const record of records) {
    for (const side of frontierGameSides(record)) {
      if (known.has(side.label)) continue;
      known.add(side.label);
      const usual = FRONTIER_SEASON_TWO_TEAMS.find(
        (team) =>
          team.label === side.label &&
          !usedColors.has(team.color.toLowerCase()),
      );
      if (usual !== undefined) {
        usedColors.add(usual.color.toLowerCase());
        teams.push(onPlayedModel(usual, played.get(side.label), roster));
        continue;
      }
      const colors =
        FALLBACK_TEAM_COLORS.find(([color]) => !usedColors.has(color)) ??
        FALLBACK_COLORS;
      usedColors.add(colors[0]);
      const model = played.get(side.label) ?? side.model;
      const identity = identityOfModel(model, roster);
      teams.push({ ...fallbackTeam(side.label, model, colors), ...identity });
    }
  }
  return teams;
}

/**
 * Where the roster and the games disagree on a side's model, one plain line
 * each for the publisher's log.
 */
export function frontierRosterMismatches(
  roster: readonly FrontierFourTeam[],
  teams: readonly FrontierFourTeam[],
): string[] {
  return roster.flatMap((team) => {
    const shown = teams.find((entry) => entry.label === team.label);
    return shown === undefined || shown.model === team.model
      ? []
      : [
          `${team.label}: the roster names ${team.model} but its latest game ran ${shown.model}; showing ${shown.model} until it plays on the roster's model`,
        ];
  });
}

/**
 * A roster from config (`--roster <file>`, or the scheduler config's
 * `teams`): a JSON array of `{label, model, displayName?, provider?, color?,
 * secondaryColor?}`; other keys are ignored. Without a colour, a known label
 * keeps its usual colour while no other entry claims it, and anything else
 * gets a spare. Throws on anything it cannot publish, so a bad config fails
 * loudly.
 */
export function parseFrontierRoster(value: unknown): FrontierFourTeam[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("the roster must be a non-empty JSON array");
  }
  const entries: {
    label: string;
    model: string;
    displayName: string | null;
    provider: string | null;
    colors: readonly [string, string] | null;
  }[] = [];
  for (const entry of value) {
    if (!isRecord(entry))
      throw new Error("each roster entry must be an object");
    const label = frontierLabel(entry.label);
    const model =
      typeof entry.model === "string" &&
      FRONTIER_MODEL_PATTERN.test(entry.model)
        ? entry.model
        : null;
    if (label === null || model === null) {
      throw new Error(
        `roster entry needs a plain label and a model slug: ${JSON.stringify(entry).slice(0, 120)}`,
      );
    }
    if (entries.some((team) => team.label === label)) {
      throw new Error(`roster label used twice: ${label}`);
    }
    let colors: readonly [string, string] | null = null;
    if (
      typeof entry.color === "string" &&
      HEX_COLOR_PATTERN.test(entry.color)
    ) {
      colors = [
        entry.color.toLowerCase(),
        typeof entry.secondaryColor === "string" &&
        HEX_COLOR_PATTERN.test(entry.secondaryColor)
          ? entry.secondaryColor.toLowerCase()
          : FALLBACK_SECONDARY_COLOR,
      ];
    } else if (entry.color !== undefined) {
      throw new Error(`roster colour must be #rrggbb: ${label}`);
    }
    entries.push({
      label,
      model,
      displayName: sanitizeFrontierPublicText(entry.displayName, 60),
      provider: sanitizeFrontierPublicText(entry.provider, 40),
      colors,
    });
  }
  // Given colours first, so a known label never takes one an entry asked for.
  const usedColors = new Set(
    entries.flatMap((entry) =>
      entry.colors === null ? [] : [entry.colors[0]],
    ),
  );
  return entries.map((entry) => {
    let team: FrontierFourTeam;
    const usual =
      entry.colors === null
        ? FRONTIER_SEASON_TWO_TEAMS.find(
            (known) =>
              known.label === entry.label &&
              !usedColors.has(known.color.toLowerCase()),
          )
        : undefined;
    if (usual !== undefined) {
      usedColors.add(usual.color.toLowerCase());
      team = { ...usual, model: entry.model };
    } else {
      const colors =
        entry.colors ??
        FALLBACK_TEAM_COLORS.find(([color]) => !usedColors.has(color)) ??
        FALLBACK_COLORS;
      usedColors.add(colors[0]);
      team = fallbackTeam(entry.label, entry.model, colors);
    }
    const identity = identityOfModel(entry.model, []);
    return {
      ...team,
      displayName: entry.displayName ?? identity?.displayName ?? entry.label,
      provider:
        entry.provider ?? identity?.provider ?? providerOfModel(entry.model),
    };
  });
}

/** The feed facts the world builder reads, for a world the league did not play. */
export function frontierFourMirrorData(
  records: readonly FrontierGameRecord[],
  now: string,
  league: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
  } = {
    id: "frontier-four",
    name: "Frontier Four",
    description:
      "Four teams of three nations, each team one frontier model, fight over the fronts of the world map.",
  },
): CoworldLeagueMirrorData {
  const latestCycle = records.reduce(
    (best, record) => Math.max(best, record.cycle ?? 0),
    0,
  );
  return {
    generatedAt: now,
    lastGoodSyncAt: now,
    stale: false,
    league: {
      id: league.id,
      name: league.name,
      description: league.description,
      divisionName: league.name,
      roundIntervalMinutes: null,
      episodesPerRound: null,
      currentRoundNumber: latestCycle > 0 ? latestCycle : null,
      currentRoundStatus: latestCycle > 0 ? "running" : null,
      scoreLabel: "Wins",
    },
    standings: [],
    rounds: [],
    episodes: [],
    links: {
      enterTheLeagueUrl: "https://github.com/0xNad/proxywar-coworld-starter",
      platformLabel: "Softmax Observatory",
    },
  };
}

export interface FrontierFourPublication {
  readonly worldPath: string;
  readonly episodesPath: string;
  readonly games: number;
  readonly battles: number;
}

/** Writes the marker, the `/match/<id>` rows and `world.json`, in that order. */
async function writeFrontierWorldFiles(
  siteDir: string,
  now: string,
  rows: readonly CoworldLeagueEpisodeRow[],
  world: object,
): Promise<{ worldPath: string; episodesPath: string }> {
  const worldPath = path.join(siteDir, COWORLD_LEAGUE_WORLD_FILE);
  const episodesPath = path.join(siteDir, FRONTIER_FOUR_EPISODES_FILE);
  await fs.mkdir(siteDir, { recursive: true });
  // The marker first, so a mirror publish racing this one already yields.
  await writeFileAtomic(
    path.join(siteDir, COWORLD_LEAGUE_WORLD_SOURCE_FILE),
    `${JSON.stringify({ source: "frontier-four" })}\n`,
  );
  await writeFileAtomic(
    episodesPath,
    `${JSON.stringify({ schemaVersion: 1, generatedAt: now, episodes: rows })}\n`,
  );
  await writeFileAtomic(worldPath, `${JSON.stringify(world)}\n`);
  return { worldPath, episodesPath };
}

/**
 * Publishes the Season 1 world (`world.json`, the `/match/<id>` rows and the
 * source marker) into the league site directory from the games file.
 * Idempotent: the same games produce the same files.
 */
export async function publishFrontierFourWorld(args: {
  readonly siteDir: string;
  readonly gamesPath?: string;
  readonly now?: string;
  readonly links?: PublicWorldLinks | null;
  readonly teams?: readonly FrontierFourTeam[];
}): Promise<FrontierFourPublication> {
  const gamesPath =
    args.gamesPath ?? path.join(args.siteDir, FRONTIER_FOUR_GAMES_FILE);
  const now = args.now ?? new Date().toISOString();
  const teams = args.teams ?? FRONTIER_FOUR_TEAMS;
  const records = await readFrontierFourGames(gamesPath);
  const ledger = mergeWorldLedger(
    EMPTY_WORLD_LEDGER,
    records.map(frontierFourBattle),
  );
  const world = buildPublicWorldModel({
    state: reduceWorld(ledger),
    ledger,
    data: frontierFourMirrorData(records, now),
    readModelAgents: [],
    identities: frontierFourIdentities(teams),
    links: args.links ?? null,
    generatedAt: now,
  });
  const written = await writeFrontierWorldFiles(
    args.siteDir,
    now,
    records.map((record) => frontierFourEpisodeRow(record, teams)),
    {
      ...world,
      mode: "frontier-four",
      teams: teams.map((team) => ({ label: team.label, model: team.model })),
    },
  );
  return {
    ...written,
    games: records.length,
    battles: ledger.battles.length,
  };
}

// ---------------------------------------------------------------------------
// Season 2
// ---------------------------------------------------------------------------

export interface FrontierSchedule {
  /** Daily battle times, `HH:MM` UTC, earliest first. */
  readonly timesUtc: readonly string[];
  /** `null` when no battle is planned (paused, or out of credits). */
  readonly nextBattleAt: string | null;
}

export interface FrontierSeasonOneRecap {
  readonly battles: number;
  /** Every Season 1 side, most wins first. */
  readonly winsByLabel: Readonly<Record<string, number>>;
  readonly note: string;
}

export interface FrontierLatestBattle {
  readonly episodeRequestId: string;
  readonly map: string;
  readonly frontLabel: string;
  readonly completedAt: string;
  readonly winnerLabel: string | null;
  readonly winType: FrontierWinType;
  readonly standings: readonly FrontierStanding[];
  readonly voices: readonly FrontierVoice[];
  readonly watchHref: string | null;
}

export interface FrontierWorldTeam {
  readonly label: string;
  readonly model: string;
  readonly displayName: string;
  readonly provider: string;
  readonly color: string;
}

/** `world.json` while the Frontier holds the world (contract C). */
export type FrontierWorldModel = Omit<PublicWorldModel, "mode" | "teams"> & {
  readonly mode: "frontier";
  readonly season: number;
  readonly teams: readonly FrontierWorldTeam[];
  readonly schedule: FrontierSchedule;
  readonly latestBattle: FrontierLatestBattle | null;
  readonly seasonOneRecap: FrontierSeasonOneRecap | null;
};

const BATTLE_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
// The scheduler's own reading of a time: one or two hour digits.
const LOOSE_BATTLE_TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** `"9:00"` → `"09:00"`, or `null` when it is not a time of day. */
function normalizeBattleTime(value: string): string | null {
  const match = LOOSE_BATTLE_TIME_PATTERN.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

/**
 * `"19:00, 9:00"` → `["09:00", "19:00"]`, read the way the scheduler reads
 * its config; throws on anything else.
 */
export function parseFrontierBattleTimes(value: string): string[] {
  const times = value
    .split(",")
    .map((time) => time.trim())
    .filter((time) => time !== "")
    .map((time) => normalizeBattleTime(time));
  if (times.length === 0 || times.some((time) => time === null)) {
    throw new Error(
      `battle times must be HH:MM in UTC, separated by commas: ${value}`,
    );
  }
  return [...new Set(times as string[])].sort();
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The first battle time strictly after `now`, or `null` with no times. */
export function frontierNextBattleAt(
  timesUtc: readonly string[],
  now: string,
): string | null {
  const nowTime = Date.parse(now);
  if (!Number.isFinite(nowTime)) return null;
  const today = new Date(nowTime).toISOString().slice(0, 10);
  let next: number | null = null;
  for (const day of [today, addDays(today, 1)]) {
    for (const time of timesUtc) {
      if (!BATTLE_TIME_PATTERN.test(time)) continue;
      const at = Date.parse(`${day}T${time}:00.000Z`);
      if (at > nowTime && (next === null || at < next)) next = at;
    }
  }
  return next === null ? null : new Date(next).toISOString();
}

/**
 * The published schedule. While the scheduler holds for a credits refill
 * (`holdUntil` in the future), the next battle is the first time at or
 * after the refill, so the page never promises a battle that cannot start.
 */
export function frontierSchedule(args: {
  readonly timesUtc: readonly string[];
  readonly now: string;
  readonly holdUntil?: string | null;
}): FrontierSchedule {
  const nowTime = Date.parse(args.now);
  const holdTime = Date.parse(args.holdUntil ?? "");
  const from =
    Number.isFinite(holdTime) && Number.isFinite(nowTime) && holdTime > nowTime
      ? new Date(holdTime - 1).toISOString()
      : args.now;
  return {
    timesUtc: [...args.timesUtc],
    nextBattleAt: frontierNextBattleAt(args.timesUtc, from),
  };
}

/**
 * Battle times and a credits hold from the scheduler's own files (its
 * config's `schedule.times_utc`, its state's `credits_hold_until`); either
 * may be absent or unreadable, which reads as "not known". Times the
 * scheduler would refuse come back as a warning, not silently as defaults.
 */
export function frontierSchedulerFacts(args: {
  readonly config: unknown;
  readonly state: unknown;
}): {
  timesUtc: string[] | null;
  holdUntil: string | null;
  warnings: string[];
} {
  let timesUtc: string[] | null = null;
  const warnings: string[] = [];
  const schedule = isRecord(args.config) ? args.config.schedule : null;
  const configured = isRecord(schedule) ? schedule.times_utc : undefined;
  // The scheduler uses its default times for a missing or empty list.
  if (Array.isArray(configured) && configured.length > 0) {
    const times = configured.map((time) =>
      typeof time === "string" ? normalizeBattleTime(time) : null,
    );
    if (times.every((time) => time !== null)) {
      timesUtc = [...new Set(times as string[])].sort();
    } else {
      warnings.push(
        `the scheduler config's schedule.times_utc is not a list of HH:MM times (${JSON.stringify(configured).slice(0, 120)}); publishing the default times`,
      );
    }
  } else if (configured !== undefined && !Array.isArray(configured)) {
    warnings.push(
      "the scheduler config's schedule.times_utc is not a list; publishing the default times",
    );
  }
  const hold = isRecord(args.state) ? args.state.credits_hold_until : null;
  return {
    timesUtc,
    holdUntil: canonicalCompletedAt(hold),
    warnings,
  };
}

/** Season 1's record, from its games file. */
export function frontierSeasonOneRecap(
  records: readonly FrontierGameRecord[],
): FrontierSeasonOneRecap {
  const seasonOne = records.filter((record) => record.schemaVersion === 1);
  const wins = new Map<string, number>();
  for (const record of seasonOne) {
    for (const side of record.teams) {
      if (!wins.has(side.label)) wins.set(side.label, 0);
    }
  }
  for (const record of seasonOne) {
    const winner = frontierFourWinnerLabel(record);
    if (winner !== null) wins.set(winner, (wins.get(winner) ?? 0) + 1);
  }
  return {
    battles: seasonOne.length,
    winsByLabel: Object.fromEntries(
      [...wins.entries()].sort(
        ([leftLabel, left], [rightLabel, right]) =>
          right - left || leftLabel.localeCompare(rightLabel),
      ),
    ),
    note: FRONTIER_SEASON_ONE_NOTE,
  };
}

/**
 * At most `limit` lines for the latest-battle panel: each side's last
 * dispatch first (its closing word), then messages taken in turn from each
 * speaker so no one model fills the panel, then earlier dispatches. Shown
 * in game order, each re-sanitized.
 */
export function selectFrontierLatestVoices(
  voices: readonly FrontierVoice[],
  limit = FRONTIER_LATEST_VOICE_LIMIT,
): FrontierVoice[] {
  const ordered = voices
    .map((voice, index) => ({ voice, index }))
    .sort(
      (left, right) =>
        (left.voice.turn ?? Number.MAX_SAFE_INTEGER) -
          (right.voice.turn ?? Number.MAX_SAFE_INTEGER) ||
        left.index - right.index,
    )
    .map(({ voice }) => voice);
  const chosen = new Set<FrontierVoice>();
  const lastDispatch = new Map<string, FrontierVoice>();
  for (const voice of ordered) {
    if (voice.kind === "dispatch") lastDispatch.set(voice.label, voice);
  }
  for (const voice of lastDispatch.values()) {
    if (chosen.size >= limit) break;
    chosen.add(voice);
  }
  const takeInTurns = (kind: FrontierVoice["kind"]) => {
    const queues = new Map<string, FrontierVoice[]>();
    for (const voice of ordered) {
      if (voice.kind !== kind || chosen.has(voice)) continue;
      const queue = queues.get(voice.label) ?? [];
      queue.push(voice);
      queues.set(voice.label, queue);
    }
    let added = true;
    while (chosen.size < limit && added) {
      added = false;
      for (const queue of queues.values()) {
        const voice = queue.shift();
        if (voice === undefined) continue;
        if (chosen.size >= limit) break;
        chosen.add(voice);
        added = true;
      }
    }
  };
  takeInTurns("message");
  takeInTurns("dispatch");
  const result: FrontierVoice[] = [];
  for (const voice of ordered) {
    if (!chosen.has(voice)) continue;
    const text = sanitizeFrontierPublicText(
      voice.text,
      voice.kind === "dispatch"
        ? FRONTIER_DISPATCH_MAX_CHARS
        : FRONTIER_MESSAGE_MAX_CHARS,
    );
    if (text !== null) result.push({ ...voice, text });
  }
  return result;
}

function compareRecords(
  left: FrontierGameRecord,
  right: FrontierGameRecord,
): number {
  if (left.completedAt !== right.completedAt) {
    return left.completedAt < right.completedAt ? -1 : 1;
  }
  return left.episodeRequestId.localeCompare(right.episodeRequestId);
}

/** The newest game, as the world page's latest-battle panel. */
export function frontierLatestBattle(
  records: readonly FrontierGameRecordV2[],
): FrontierLatestBattle | null {
  const latest = [...records].sort(compareRecords).at(-1);
  if (latest === undefined) return null;
  return {
    episodeRequestId: latest.episodeRequestId,
    map: latest.map,
    frontLabel: latest.frontLabel ?? latest.map,
    completedAt: latest.completedAt,
    winnerLabel: latest.winnerLabel,
    winType: latest.winType,
    standings: latest.standings,
    voices: selectFrontierLatestVoices(latest.voices),
    watchHref: latest.viewerUrl ?? latest.replayUrl,
  };
}

export interface FrontierWorldPublication extends FrontierFourPublication {
  readonly season: number;
  /** The season's records, for the form file. */
  readonly records: readonly FrontierGameRecordV2[];
  /**
   * The roster plus any side the Season 2 games named that it did not, each
   * on the model its latest game ran.
   */
  readonly teams: readonly FrontierFourTeam[];
  /** Plain lines for the publisher's log (roster and games disagreeing). */
  readonly warnings: readonly string[];
}

/**
 * Publishes the Season 2 world from the Season 2 games file only. A front
 * goes to whoever won the latest battle there (window size 1); a battle
 * nobody won leaves the holder in place. Season 1's games, when given, add
 * the recap and keep their `/match/<id>` pages working; they never move a
 * front.
 */
export async function publishFrontierWorld(args: {
  readonly siteDir: string;
  readonly gamesPath: string;
  readonly seasonOneGamesPath?: string | null;
  readonly season?: number;
  readonly now?: string;
  readonly links?: PublicWorldLinks | null;
  readonly roster?: readonly FrontierFourTeam[];
  readonly timesUtc?: readonly string[];
  /** `undefined` works it out from the times; `null` says none is planned. */
  readonly nextBattleAt?: string | null;
  /** The scheduler's credits hold, when it is waiting for a refill. */
  readonly holdUntil?: string | null;
}): Promise<FrontierWorldPublication> {
  const now = args.now ?? new Date().toISOString();
  const season = args.season ?? FRONTIER_SEASON;
  const records = (await readFrontierGames(args.gamesPath)).filter(
    (record): record is FrontierGameRecordV2 =>
      record.schemaVersion === 2 && record.season === season,
  );
  const seasonOne =
    args.seasonOneGamesPath === undefined || args.seasonOneGamesPath === null
      ? null
      : await readFrontierFourGames(args.seasonOneGamesPath);
  const roster = args.roster ?? FRONTIER_SEASON_TWO_TEAMS;
  // Season 2's sides only: a model that left the roster after Season 1 is
  // not listed as if it were still fighting.
  const teams = frontierTeamsFor(roster, records);
  // Season 1's sides only colour its old `/match` rows.
  const rowTeams = frontierTeamsFor(teams, seasonOne ?? []);
  const ledger = mergeWorldLedger(
    EMPTY_WORLD_LEDGER,
    records.map(frontierFourBattle),
  );
  const world = buildPublicWorldModel({
    state: reduceWorld(ledger, FRONTIER_FRONT_WINDOW),
    ledger,
    data: frontierFourMirrorData(records, now, {
      id: "frontier",
      name: "Frontier",
      description:
        "Frontier models, one nation each, fight over the fronts of the world map.",
    }),
    readModelAgents: [],
    identities: frontierFourIdentities(teams, { showDisplayName: true }),
    links: args.links ?? null,
    generatedAt: now,
  });
  const timesUtc = args.timesUtc ?? FRONTIER_DEFAULT_BATTLE_TIMES_UTC;
  const frontierWorld: FrontierWorldModel = {
    ...world,
    mode: "frontier",
    season,
    teams: teams.map((team) => ({
      label: team.label,
      model: team.model,
      displayName: team.displayName,
      provider: team.provider,
      color: team.color,
    })),
    schedule:
      args.nextBattleAt === undefined
        ? frontierSchedule({ timesUtc, now, holdUntil: args.holdUntil })
        : { timesUtc: [...timesUtc], nextBattleAt: args.nextBattleAt },
    latestBattle: frontierLatestBattle(records),
    seasonOneRecap:
      seasonOne === null ? null : frontierSeasonOneRecap(seasonOne),
  };
  // Season 1 rows stay so links shared during Season 1 keep working.
  const rows = new Map<string, CoworldLeagueEpisodeRow>();
  for (const record of [...(seasonOne ?? []), ...records]) {
    if (rows.has(record.episodeRequestId)) continue;
    rows.set(record.episodeRequestId, frontierFourEpisodeRow(record, rowTeams));
  }
  const written = await writeFrontierWorldFiles(
    args.siteDir,
    now,
    [...rows.values()],
    frontierWorld,
  );
  return {
    ...written,
    season,
    games: records.length,
    battles: ledger.battles.length,
    records,
    teams,
    warnings: frontierRosterMismatches(roster, teams),
  };
}

/** Hands `world.json` back to the league mirror; the next mirror publish rebuilds it. */
export async function restoreLeagueWorldSource(siteDir: string): Promise<void> {
  await writeFileAtomic(
    path.join(siteDir, COWORLD_LEAGUE_WORLD_SOURCE_FILE),
    `${JSON.stringify({ source: "league" })}\n`,
  );
}
