/**
 * Season Zero Phase 2: per-match share image. INVESTIGATED before writing
 * this: `package.json` carries no PNG rasterizer suitable for a lightweight
 * static image (no `sharp`/`resvg`/headless-screenshot pipeline sized for
 * this — the only rasterization in this repo is
 * `replay-premiere-clip-render-lib.ts`'s ffmpeg+headless-Chrome VIDEO
 * pipeline, wildly out of proportion for a single static poster). The
 * repo's OWN existing precedent for a per-object `og:image` is
 * `ReplayPremierePublicPage.ts`'s `renderReplayPremiereCardSvg` — a
 * server-rendered SVG served directly as `og:image`/`twitter:image`,
 * already live in production for every premiere. This module follows that
 * EXACT convention for `/match/:matchId`, rather than inventing a new PNG
 * pipeline this repo has no rasterizer for.
 *
 * Spoiler safety is STRUCTURAL, not a runtime check on hidden fields: the
 * caller passes `result: null` for anything not yet safe to reveal (a
 * `FeaturedMatch` that hasn't reached `"revealed"`/`"archived"`) and a real
 * `MatchShareCardResult` only once it is — this module has no visibility
 * into embargo state and cannot leak what it was never handed.
 */

export interface MatchShareCardResult {
  winnerName: string | null;
  placements: readonly { name: string; placement: number }[];
}

export interface MatchShareCardInput {
  /** Stable id embedded as a `data-*` attribute for scraper/debug provenance — never rendered as visible text. */
  matchId: string;
  title: string;
  mapLabel: string;
  participants: readonly string[];
  /** `null` for a spoiler-safe pre-match card; a real result for the post-match card. */
  result: MatchShareCardResult | null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Renders the spoiler-safe pre-match OR the post-match result SVG (1200x630, the standard `og:image` size — same dimensions this repo's premiere card already uses), depending only on whether `input.result` is provided. */
export function renderMatchShareCardSvg(input: MatchShareCardInput): string {
  const participantsLine = truncateText(input.participants.join(" · "), 100);
  const label = input.result === null ? "PROXY WAR MATCH" : "PROXY WAR RESULT";
  const headline =
    input.result === null
      ? truncateText(input.title, 40)
      : truncateText(
          input.result.winnerName !== null
            ? `${input.result.winnerName} wins`
            : "Match complete",
          40,
        );
  const placementsLines = (input.result?.placements ?? [])
    .slice(0, 6)
    .map(
      (entry) => `#${entry.placement} ${entry.name}`,
    );
  const bodyLines =
    input.result === null
      ? [participantsLine]
      : placementsLines.length > 0
        ? placementsLines
        : [participantsLine];
  const bodyText = bodyLines
    .map(
      (line, index) =>
        `<text x="84" y="${420 + index * 34}" fill="#c3cbe0" font-family="Inter, Arial, sans-serif" font-size="24">${escapeXml(truncateText(line, 88))}</text>`,
    )
    .join("\n  ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeXml(`${label}: ${headline}`)}" data-match-id="${escapeXml(input.matchId)}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#090d16"/><stop offset="0.55" stop-color="#111a2c"/><stop offset="1" stop-color="#20152e"/></linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#66e3ff"/><stop offset="1" stop-color="#c76cff"/></linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="54" y="54" width="1092" height="522" rx="30" fill="#0c1220" fill-opacity="0.88" stroke="#ffffff" stroke-opacity="0.12"/>
  <rect x="84" y="86" width="236" height="42" rx="21" fill="url(#accent)"/>
  <text x="202" y="114" text-anchor="middle" fill="#071019" font-family="Inter, Arial, sans-serif" font-size="19" font-weight="800" letter-spacing="1.5">${escapeXml(label)}</text>
  <text x="84" y="214" fill="#f7f9ff" font-family="Inter, Arial, sans-serif" font-size="54" font-weight="800">${escapeXml(headline)}</text>
  <text x="84" y="270" fill="#8fa0c6" font-family="Inter, Arial, sans-serif" font-size="21">${escapeXml(`Map: ${input.mapLabel}`)}</text>
  <line x1="84" y1="330" x2="1116" y2="330" stroke="#ffffff" stroke-opacity="0.12"/>
  ${bodyText}
  <text x="84" y="596" fill="#7584a8" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15">proxywar.xyz</text>
</svg>`;
}
