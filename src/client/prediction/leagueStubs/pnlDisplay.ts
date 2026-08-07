/**
 * League-build stub for `../wagering/components/pnlDisplay` — see
 * `stubMap.ts` for the aliasing contract. Bundled only when vite runs
 * with `PROXYWAR_LEAGUE_CLIENT=1`.
 *
 * The one consumer outside the wagering graph is
 * `src/client/platform/TraderProfilePage.ts` (`formatSignedCredits`), so
 * that page renders identical numbers under the league build (against a
 * league server its betting API is absent anyway and the page shows its
 * own empty/error state). The formatting functions below are faithful
 * copies of the real pure functions; `pnlTier` is deliberately reduced to
 * direction-only tone (correct sign, glyph, and text colour; neutral
 * border/background) because every magnitude-tier consumer lives inside
 * the excluded wagering graph. If a league surface ever needs full
 * magnitude tiering, move the tier table to a shared non-wagering module
 * — do not import the wagering original.
 *
 * Runtime-export parity with the real module is pinned by
 * `tests/client/prediction/wagering/LeagueStubParity.test.ts`. Types are
 * re-exported type-only from the real module (erased at build).
 */
import type { PnlTier } from "../wagering/components/pnlDisplay";

export type { PnlTier } from "../wagering/components/pnlDisplay";

const FLAT: PnlTier = {
  colorClass: "text-ink-muted",
  borderClass: "border-line",
  bgClass: "bg-surface-2",
  icon: "•",
};
const POSITIVE: PnlTier = {
  colorClass: "text-positive",
  borderClass: "border-line",
  bgClass: "bg-surface-2",
  icon: "▲",
};
const NEGATIVE: PnlTier = {
  colorClass: "text-danger",
  borderClass: "border-line",
  bgClass: "bg-surface-2",
  icon: "▼",
};

/** Percent change vs. cost basis; `null` when there's no basis to compare against. */
export function pnlPercent(
  unrealizedPnl: number,
  costBasis: number,
): number | null {
  if (costBasis <= 0) return null;
  return (unrealizedPnl / costBasis) * 100;
}

/** Direction-only tone (see module doc for why magnitude tiers are dropped here). */
export function pnlTier(
  unrealizedPnl: number,
  percent: number | null,
): PnlTier {
  if (unrealizedPnl === 0) return FLAT;
  return unrealizedPnl > 0 ? POSITIVE : NEGATIVE;
}

/** `+1,234` / `-1,234` / `0` — matches the sign convention already used across settlement/positions. */
export function formatSignedCredits(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toLocaleString()}`;
}

/** `+12.3%` / `-12.3%`; empty string when there's nothing to compare against. */
export function formatSignedPercent(percent: number | null): string {
  if (percent === null) return "";
  return `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
}
