import {
  mix,
  QUIET_AMOUNT,
  QUIET_RGB,
  STRIPE_AMOUNT,
  UNCLAIMED_RGB,
  type FrontPaint,
  type Rgb,
} from "./WorldMapRenderer";
import type {
  WorldAgent,
  WorldModel,
  WorldTheatre,
  WorldTheatreId,
} from "./WorldModelSchema";

/**
 * Pure presentation rules for `/world` — everything the page decides that
 * isn't markup, kept here so it is unit-testable without a DOM.
 */

/**
 * The map's banner colours. League identity colours are generated per
 * player and collide often (two near-identical purples hold neighbouring
 * fronts today), which makes a political map unreadable. Each agent the
 * map can show gets the free banner colour closest in hue to its own
 * identity colour, so colours stay recognisable but never clash. Twelve
 * hues 30° apart, tuned for the dark navy ocean.
 */
export const WORLD_BANNER_PALETTE = [
  "#ff5d5b",
  "#ff9a3d",
  "#ffd23f",
  "#a3e050",
  "#38d68f",
  "#21cfc3",
  "#3ab8f5",
  "#5d8cf0",
  "#8d7cf8",
  "#c06cf4",
  "#f064c6",
  "#ff7d9d",
] as const;

/** A front with no battle for this long reads as quiet (dormant), not live. */
export const WORLD_QUIET_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
/** Newest battle older than this means the league feed has stalled. */
export const WORLD_FEED_PAUSED_AFTER_MS = 3 * 60 * 60 * 1000;

export type FrontDisplayState = "unclaimed" | "held" | "contested" | "quiet";

export function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function hueOf(hex: string): number | null {
  const rgb = hexToRgb(hex);
  if (rgb === null) return null;
  const [r, g, b] = rgb.map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return null;
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return (hue * 60 + 360) % 360;
}

function hueDistance(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360;
  return difference > 180 ? 360 - difference : difference;
}

/**
 * Deterministic banner colour per agent. Priority order (who gets first
 * pick): current holders by fronts held, then current challengers, then
 * everyone else the history chart shows, by how long they held fronts.
 * Agents past the twelfth keep their identity colour — they never appear
 * on the map at the same time as all twelve.
 */
export function assignBannerColors(model: WorldModel): Map<string, string> {
  const agentsByName = new Map(
    model.agents.map((agent) => [agent.name, agent]),
  );
  const order: string[] = [];
  const push = (name: string | null) => {
    if (name !== null && !order.includes(name) && agentsByName.has(name)) {
      order.push(name);
    }
  };
  const holderCounts = new Map<string, number>();
  for (const theatre of model.theatres) {
    if (theatre.holder !== null) {
      holderCounts.set(
        theatre.holder,
        (holderCounts.get(theatre.holder) ?? 0) + 1,
      );
    }
  }
  [...holderCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([name]) => push(name));
  model.theatres
    .map((theatre) => theatre.challenger)
    .sort((a, b) => (a ?? "").localeCompare(b ?? ""))
    .forEach(push);
  const frontDays = new Map<string, number>();
  for (const day of model.timeline) {
    for (const holder of Object.values(day.holders)) {
      if (holder !== null)
        frontDays.set(holder, (frontDays.get(holder) ?? 0) + 1);
    }
  }
  [...frontDays.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .forEach(([name]) => push(name));
  model.agents.forEach((agent) => push(agent.name));

  const free = [...WORLD_BANNER_PALETTE] as string[];
  const colors = new Map<string, string>();
  for (const name of order) {
    const agent = agentsByName.get(name) as WorldAgent;
    if (free.length === 0) {
      colors.set(name, agent.color);
      continue;
    }
    const identityHue = hueOf(agent.color);
    let bestIndex = 0;
    if (identityHue !== null) {
      let bestDistance = Number.POSITIVE_INFINITY;
      free.forEach((candidate, index) => {
        const distance = hueDistance(identityHue, hueOf(candidate) ?? 0);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
    }
    colors.set(name, free[bestIndex]);
    free.splice(bestIndex, 1);
  }
  return colors;
}

export function frontDisplayState(
  theatre: WorldTheatre,
  now: number,
): FrontDisplayState {
  if (theatre.status === "unclaimed" || theatre.holder === null) {
    return "unclaimed";
  }
  const last =
    theatre.lastBattleAt === null ? NaN : Date.parse(theatre.lastBattleAt);
  if (Number.isFinite(last) && now - last > WORLD_QUIET_AFTER_MS)
    return "quiet";
  return theatre.status === "contested" ? "contested" : "held";
}

/** An agent's map colour: its banner, else its identity colour. */
export function bannerColorOf(
  name: string | null,
  colors: ReadonlyMap<string, string>,
  model: WorldModel,
): string {
  if (name === null) return "#64748b";
  return (
    colors.get(name) ??
    model.agents.find((agent) => agent.name === name)?.color ??
    "#94a3b8"
  );
}

/**
 * How each front is painted in one map frame: the holder's banner, the
 * challenger's hatching while under siege, muted once quiet. `revealed`
 * lets a page bring fronts in one by one; `changed` outlines the fronts
 * that changed hands since the visitor's last visit.
 */
export function frontPaints(
  model: WorldModel,
  colors: ReadonlyMap<string, string>,
  now: number,
  options: {
    readonly revealed?: (id: WorldTheatreId) => boolean;
    readonly changed?: readonly WorldTheatreId[];
  } = {},
): Partial<Record<WorldTheatreId, FrontPaint>> {
  const rgb = (name: string | null) =>
    name === null ? null : hexToRgb(bannerColorOf(name, colors, model));
  const paints: Partial<Record<WorldTheatreId, FrontPaint>> = {};
  for (const theatre of model.theatres) {
    if (theatre.id === "crown") continue;
    const display = frontDisplayState(theatre, now);
    const revealed = options.revealed?.(theatre.id) ?? true;
    paints[theatre.id] = {
      fill: display === "unclaimed" || !revealed ? null : rgb(theatre.holder),
      stripe:
        display === "contested" && revealed ? rgb(theatre.challenger) : null,
      quiet: display === "quiet",
      changed: options.changed?.includes(theatre.id) ?? false,
    };
  }
  return paints;
}

export function rgbHex(rgb: Rgb): string {
  return `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

/** Land no agent holds, as a CSS colour. */
export const UNCLAIMED_HEX = rgbHex(UNCLAIMED_RGB);

/**
 * CSS paint for a front's swatch, computed with the renderer's own maths so
 * a key or legend swatch matches the map: the holder's banner, faded once
 * quiet, hatched with the challenger's colour while under siege.
 */
export function frontSwatch(
  front: WorldTheatre | null,
  colorOf: (name: string | null) => string,
  now: number,
): string {
  if (front === null || front.holder === null) return UNCLAIMED_HEX;
  const display = frontDisplayState(front, now);
  const holder = hexToRgb(colorOf(front.holder));
  if (holder === null || display === "unclaimed") return UNCLAIMED_HEX;
  if (display === "quiet") {
    return rgbHex(mix(holder, QUIET_RGB, QUIET_AMOUNT));
  }
  if (display === "contested") {
    const rival = hexToRgb(colorOf(front.challenger));
    if (rival !== null) {
      const stripe = rgbHex(mix(holder, rival, STRIPE_AMOUNT));
      return `repeating-linear-gradient(135deg,${stripe} 0 2px,${rgbHex(holder)} 2px 7px)`;
    }
  }
  return rgbHex(holder);
}

export type FeedState =
  | { kind: "live"; lastBattleAt: string }
  | { kind: "paused"; lastBattleAt: string }
  | { kind: "empty" };

export function feedState(model: WorldModel, now: number): FeedState {
  if (model.lastBattleAt === null) return { kind: "empty" };
  const last = Date.parse(model.lastBattleAt);
  if (!Number.isFinite(last)) return { kind: "empty" };
  return now - last > WORLD_FEED_PAUSED_AFTER_MS
    ? { kind: "paused", lastBattleAt: model.lastBattleAt }
    : { kind: "live", lastBattleAt: model.lastBattleAt };
}

export type WorldVerdict =
  | { kind: "empty" }
  | { kind: "leader"; name: string; fronts: number; claimed: number }
  | { kind: "tied"; names: string[]; fronts: number; claimed: number }
  | { kind: "scattered"; claimed: number };

/** Region fronts only — the Crown is its own title, not territory. */
export function worldVerdict(model: WorldModel): WorldVerdict {
  const counts = new Map<string, number>();
  let claimed = 0;
  for (const theatre of model.theatres) {
    if (theatre.id === "crown" || theatre.holder === null) continue;
    claimed += 1;
    counts.set(theatre.holder, (counts.get(theatre.holder) ?? 0) + 1);
  }
  if (claimed === 0) return { kind: "empty" };
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const [topName, topCount] = ranked[0];
  if (topCount <= 1) return { kind: "scattered", claimed };
  const tied = ranked.filter(([, count]) => count === topCount);
  if (tied.length > 1) {
    return {
      kind: "tied",
      names: tied.map(([name]) => name),
      fronts: topCount,
      claimed,
    };
  }
  return { kind: "leader", name: topName, fronts: topCount, claimed };
}

/** Compact relative time: "just now", "12m", "5h", "3d", or a date past a week. */
export function relativeAge(
  iso: string,
  now: number,
): { unit: "now" | "m" | "h" | "d" | "date"; value: number; date: Date } {
  const time = Date.parse(iso);
  const date = new Date(Number.isFinite(time) ? time : now);
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 60) return { unit: "now", value: 0, date };
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { unit: "m", value: minutes, date };
  const hours = Math.round(minutes / 60);
  if (hours < 48) return { unit: "h", value: hours, date };
  const days = Math.round(hours / 24);
  if (days <= 7) return { unit: "d", value: days, date };
  return { unit: "date", value: days, date };
}

export const WORLD_REGION_IDS: readonly WorldTheatreId[] = [
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
];

/** Lower-case battlefield key, same normalisation `getMapName` uses for `map.<key>` translations. */
export function battlefieldKey(map: string): string {
  return map.toLowerCase().replace(/[\s.]+/g, "");
}

/** Holder snapshot persisted per visitor for the "since your last visit" diff. */
export interface WorldVisitSnapshot {
  readonly at: string;
  readonly holders: Partial<Record<WorldTheatreId, string | null>>;
}

export function visitSnapshot(model: WorldModel): WorldVisitSnapshot {
  const holders: Partial<Record<WorldTheatreId, string | null>> = {};
  for (const theatre of model.theatres) holders[theatre.id] = theatre.holder;
  return { at: model.generatedAt, holders };
}

/** Fronts whose holder changed since the stored snapshot. */
export function changedSinceVisit(
  model: WorldModel,
  previous: WorldVisitSnapshot | null,
): WorldTheatreId[] {
  if (previous === null) return [];
  return model.theatres
    .filter(
      (theatre) =>
        Object.prototype.hasOwnProperty.call(previous.holders, theatre.id) &&
        previous.holders[theatre.id] !== theatre.holder &&
        theatre.holder !== null,
    )
    .map((theatre) => theatre.id);
}

export function parseVisitSnapshot(
  raw: string | null,
): WorldVisitSnapshot | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { at?: unknown }).at === "string" &&
      typeof (parsed as { holders?: unknown }).holders === "object" &&
      (parsed as { holders?: unknown }).holders !== null
    ) {
      return parsed as WorldVisitSnapshot;
    }
  } catch {
    // A corrupt snapshot is just a first visit.
  }
  return null;
}
