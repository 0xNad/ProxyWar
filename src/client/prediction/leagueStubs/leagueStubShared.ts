/**
 * Shared helpers for the league-client wagering stubs (see `stubMap.ts`
 * for what these stubs are and when they are bundled).
 *
 * Bundled ONLY when vite runs with `PROXYWAR_LEAGUE_CLIENT=1`; the normal
 * build resolves the real wagering modules and never includes this file.
 * Nothing here may import from `src/client/prediction/wagering/**` at
 * runtime, and nothing here may contain the wagering build sentinel
 * literal — the league bundle must carry neither.
 */

/**
 * Where a stubbed betting surface sends the viewer. The league page is the
 * one destination that exists on every league deployment of this bundle.
 */
export const LEAGUE_HOME_PATH = "/league";

const warnedSurfaces = new Set<string>();

/**
 * Log once per surface, so a stubbed route stays diagnosable in the
 * console without ever getting noisy (`Main.ts` retry/rejoin paths can
 * hit a stub more than once).
 */
export function warnWageringStubbed(surface: string): void {
  if (warnedSurfaces.has(surface)) return;
  warnedSurfaces.add(surface);
  console.warn(
    `[league-client] ${surface} is not part of the league build; ` +
      `redirecting to ${LEAGUE_HOME_PATH}. Betting lives on the separate ` +
      `bet surface only.`,
  );
}

/**
 * Best-effort hard redirect to the league page. `location.replace` (not
 * `assign`) so the dead betting URL never lands in history. Swallows the
 * jsdom "navigation not implemented" error so unit tests and any other
 * non-navigating environment stay inert instead of crashing.
 */
export function redirectToLeagueHome(): void {
  try {
    window.location.replace(LEAGUE_HOME_PATH);
  } catch {
    // Non-navigating environment (jsdom) — stay inert.
  }
}
