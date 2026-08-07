/**
 * Shared unrealized-P&L display logic for the price board, positions panel,
 * and position summary. A flat "green if positive, red if negative" readout
 * only carries direction — the viewer also needs magnitude at a glance (is
 * this a rounding blip or a real swing), and colour can never be the ONLY
 * signal (see accessibility constraints), so every tier pairs a colour with
 * a triangle glyph and a signed number. Percent is versus cost basis, since
 * "+40 cr" reads very differently on a 20 cr stake than a 2,000 cr one.
 */

// Build-provenance sentinel (side-effect import; see its own doc): if this
// module ever leaks into a league client bundle, the sentinel leaks with it
// and `scripts/scan-wagering-sentinel.mjs` fails that build. League builds
// alias this module to `src/client/prediction/leagueStubs/pnlDisplay.ts`.
import "../buildSentinel";

export interface PnlTier {
  /** Text colour for the headline number and icon. */
  readonly colorClass: string;
  /** Card/row border tint — intensifies with magnitude. */
  readonly borderClass: string;
  /** Card/row background tint — intensifies with magnitude. */
  readonly bgClass: string;
  /** Direction glyph — never rely on colour alone to convey up/down. */
  readonly icon: "▲" | "▼" | "•";
}

const FLAT: PnlTier = {
  colorClass: "text-ink-muted",
  borderClass: "border-line",
  bgClass: "bg-surface-2",
  icon: "•",
};

// Tailwind's scanner needs every class name to appear as a literal token
// somewhere in source — template-interpolated names (`text-${tone}`) never
// get generated. Every tier below is spelled out in full for that reason.
const POSITIVE_STRONG: PnlTier = {
  colorClass: "text-positive",
  borderClass: "border-positive/50",
  bgClass: "bg-positive/15",
  icon: "▲",
};
const POSITIVE_NOTABLE: PnlTier = {
  colorClass: "text-positive",
  borderClass: "border-positive/30",
  bgClass: "bg-positive/8",
  icon: "▲",
};
const POSITIVE_MILD: PnlTier = {
  colorClass: "text-positive",
  borderClass: "border-line",
  bgClass: "bg-surface-2",
  icon: "▲",
};
const NEGATIVE_STRONG: PnlTier = {
  colorClass: "text-danger",
  borderClass: "border-danger/50",
  bgClass: "bg-danger/15",
  icon: "▼",
};
const NEGATIVE_NOTABLE: PnlTier = {
  colorClass: "text-danger",
  borderClass: "border-danger/30",
  bgClass: "bg-danger/8",
  icon: "▼",
};
const NEGATIVE_MILD: PnlTier = {
  colorClass: "text-danger",
  borderClass: "border-line",
  bgClass: "bg-surface-2",
  icon: "▼",
};

/** Points at which a move stops being noise and starts being a real swing. */
const NOTABLE_PERCENT = 5;
const STRONG_PERCENT = 15;

/** Percent change vs. cost basis; `null` when there's no basis to compare against. */
export function pnlPercent(
  unrealizedPnl: number,
  costBasis: number,
): number | null {
  if (costBasis <= 0) return null;
  return (unrealizedPnl / costBasis) * 100;
}

/** Magnitude-aware tone for one P&L figure. */
export function pnlTier(
  unrealizedPnl: number,
  percent: number | null,
): PnlTier {
  if (unrealizedPnl === 0) return FLAT;
  const magnitude = percent === null ? 0 : Math.abs(percent);
  const strong = magnitude >= STRONG_PERCENT;
  const notable = magnitude >= NOTABLE_PERCENT;
  if (unrealizedPnl > 0) {
    return strong
      ? POSITIVE_STRONG
      : notable
        ? POSITIVE_NOTABLE
        : POSITIVE_MILD;
  }
  return strong ? NEGATIVE_STRONG : notable ? NEGATIVE_NOTABLE : NEGATIVE_MILD;
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
