import type {
  WorldEvent,
  WorldModel,
  WorldTheatre,
  WorldTheatreId,
} from "./WorldModelSchema";
import {
  frontDisplayState,
  hexToRgb,
  worldVerdict,
  type FrontDisplayState,
  type WorldVerdict,
} from "./WorldPresentation";

/**
 * Pure rules for the front page (`HomePage.ts`) — what it says and in which
 * order, kept apart from markup so every edge case (tie, empty world, paused
 * feed, no takeovers yet) is unit-testable without a DOM.
 */

export type RegionFront = WorldTheatre & {
  readonly id: Exclude<WorldTheatreId, "crown">;
};

export function regionFronts(model: WorldModel): RegionFront[] {
  return model.theatres.filter(
    (theatre): theatre is RegionFront => theatre.id !== "crown",
  );
}

export function crownFront(model: WorldModel): WorldTheatre | null {
  return model.theatres.find((theatre) => theatre.id === "crown") ?? null;
}

/**
 * The front page's verdict: `worldVerdict`, except that a world with a
 * single claimed front has a leader (one front to none), not "no agent is
 * ahead".
 */
export function frontPageVerdict(model: WorldModel): WorldVerdict {
  const verdict = worldVerdict(model);
  if (verdict.kind !== "scattered" || verdict.claimed !== 1) return verdict;
  const holder = regionFronts(model).find(
    (front) => front.holder !== null,
  )?.holder;
  return holder === undefined || holder === null
    ? verdict
    : { kind: "leader", name: holder, fronts: 1, claimed: 1 };
}

/**
 * A relative time precise enough for a live page: minutes while it is
 * fresh, hours and minutes for the first three hours, then hours, days and
 * finally a date. Returned as a translation key and its parameters.
 */
export type PreciseAge =
  | { readonly key: "now" }
  | { readonly key: "minutes"; readonly minutes: number }
  | {
      readonly key: "hours_minutes";
      readonly hours: number;
      readonly minutes: number;
    }
  | { readonly key: "hours"; readonly hours: number }
  | { readonly key: "days"; readonly days: number }
  | { readonly key: "date"; readonly iso: string };

export function preciseAge(iso: string, now: number): PreciseAge {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return { key: "date", iso };
  const minutes = Math.floor(Math.max(0, now - time) / 60_000);
  if (minutes < 1) return { key: "now" };
  if (minutes < 60) return { key: "minutes", minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 3) {
    return minutes % 60 === 0
      ? { key: "hours", hours }
      : { key: "hours_minutes", hours, minutes: minutes % 60 };
  }
  if (hours < 48) return { key: "hours", hours };
  const days = Math.floor(hours / 24);
  if (days < 7) return { key: "days", days };
  return { key: "date", iso };
}

/** The newest change of hands. */
export function latestTakeover(model: WorldModel): WorldEvent | null {
  return (
    model.events.find(
      (event) => event.kind === "conquest" || event.kind === "claim",
    ) ?? null
  );
}

/**
 * The battle the "watch" button opens: the newest change of hands from the
 * last day, else the newest event of any kind, else none (the button then
 * opens `/watch`). News first, so the button always has a reason to exist.
 */
export function watchEvent(model: WorldModel, now: number): WorldEvent | null {
  const takeover = latestTakeover(model);
  if (
    takeover !== null &&
    now - Date.parse(takeover.at) <= 24 * 60 * 60 * 1000
  ) {
    return takeover;
  }
  return model.events[0] ?? null;
}

export type LeaderCaveat =
  | { readonly kind: "siege"; readonly front: RegionFront }
  | { readonly kind: "quiet"; readonly front: RegionFront };

/**
 * What is fragile about a lead, in the order a reader should hear it: a
 * front under siege (one battle from changing hands), then a front that has
 * not seen a battle in weeks (held only because nobody fights there).
 */
export function leaderCaveats(
  model: WorldModel,
  leader: string,
  now: number,
): LeaderCaveat[] {
  const held = regionFronts(model).filter((front) => front.holder === leader);
  return [
    ...held
      .filter(
        (front) =>
          frontDisplayState(front, now) === "contested" &&
          front.challenger !== null,
      )
      .map((front) => ({ kind: "siege" as const, front })),
    ...held
      .filter(
        (front) =>
          frontDisplayState(front, now) === "quiet" &&
          front.lastBattleAt !== null,
      )
      .map((front) => ({ kind: "quiet" as const, front })),
  ].slice(0, 2);
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number | null {
  const luminance = (hex: string) => {
    const rgb = hexToRgb(hex);
    if (rgb === null) return null;
    const [r, g, bl] = rgb.map((value) => {
      const channel = value / 255;
      return channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface HolderGroup {
  readonly holder: string;
  readonly fronts: readonly RegionFront[];
}

/**
 * Who holds what, as a ranked list: the leader first, then by fronts held,
 * then by the most recent battle on any of their fronts. The map's legend on
 * narrow screens, where placards would cover the map.
 */
export function holderGroups(model: WorldModel): HolderGroup[] {
  const verdict = worldVerdict(model);
  const leader = verdict.kind === "leader" ? verdict.name : null;
  const groups = new Map<string, RegionFront[]>();
  for (const front of regionFronts(model)) {
    if (front.holder === null) continue;
    const list = groups.get(front.holder) ?? [];
    list.push(front);
    groups.set(front.holder, list);
  }
  const latest = (fronts: readonly RegionFront[]) =>
    Math.max(
      ...fronts.map((front) =>
        front.lastBattleAt === null ? 0 : Date.parse(front.lastBattleAt),
      ),
    );
  return [...groups.entries()]
    .map(([holder, fronts]) => ({ holder, fronts }))
    .sort(
      (a, b) =>
        Number(b.holder === leader) - Number(a.holder === leader) ||
        b.fronts.length - a.fronts.length ||
        latest(b.fronts) - latest(a.fronts) ||
        a.holder.localeCompare(b.holder),
    );
}

export function frontsInState(
  model: WorldModel,
  state: FrontDisplayState,
  now: number,
): RegionFront[] {
  return regionFronts(model).filter(
    (front) => frontDisplayState(front, now) === state,
  );
}

/**
 * The front that best teaches the rule on today's data: a siege if there is
 * one (it shows the tie rule), else one of the leader's fronts, else the
 * held front with the most recent battle. Its real last-12 window becomes
 * the worked example.
 */
export function exampleFront(
  model: WorldModel,
  now: number,
): RegionFront | null {
  const live = regionFronts(model).filter(
    (front) => front.window.length > 0 && front.holder !== null,
  );
  const byRecent = (a: RegionFront, b: RegionFront) =>
    (b.lastBattleAt ?? "").localeCompare(a.lastBattleAt ?? "");
  const sieges = live
    .filter((front) => frontDisplayState(front, now) === "contested")
    .sort(byRecent);
  if (sieges.length > 0) return sieges[0];
  const held = live
    .filter((front) => frontDisplayState(front, now) === "held")
    .sort(byRecent);
  const verdict = worldVerdict(model);
  const leaders = held.filter(
    (front) => verdict.kind === "leader" && front.holder === verdict.name,
  );
  return leaders[0] ?? held[0] ?? null;
}

/**
 * For the key swatches: the siege whose holder and challenger colours differ
 * most, so the hatching is visible at swatch size (a red-on-orange siege is
 * not).
 */
export function clearestSiege(
  model: WorldModel,
  colorOf: (name: string | null) => string,
  now: number,
): RegionFront | null {
  let best: RegionFront | null = null;
  let bestDistance = -1;
  for (const front of frontsInState(model, "contested", now)) {
    const a = hexToRgb(colorOf(front.holder));
    const b = hexToRgb(colorOf(front.challenger));
    if (a === null || b === null) continue;
    const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (distance > bestDistance) {
      bestDistance = distance;
      best = front;
    }
  }
  return best;
}

/** Day number of the war (day 1 is the day of the first battle, UTC). */
export function warDay(model: WorldModel, now: number): number | null {
  if (model.firstBattleAt === null) return null;
  const first = Date.parse(model.firstBattleAt.slice(0, 10));
  if (!Number.isFinite(first)) return null;
  const today = Date.parse(new Date(now).toISOString().slice(0, 10));
  return Math.floor((today - first) / 86_400_000) + 1;
}
