/**
 * Build-provenance sentinel for the REAL wagering client graph.
 *
 * `scripts/scan-wagering-sentinel.mjs` searches every emitted build asset
 * for the exact literal below, in both directions:
 *
 *  - a NORMAL client build (beta.proxywar.xyz, bet.proxywar.xyz) MUST
 *    contain it — proving the sentinel itself has not rotted out of the
 *    bundled graph (the scrub can never pass vacuously);
 *  - a LEAGUE client build (`PROXYWAR_LEAGUE_CLIENT=1`, the coworld
 *    package image) MUST NOT contain it — proving no module under
 *    `src/client/prediction/wagering/**` reached the league bundle
 *    (operator boundary 2026-07-27: speculation lives only on the
 *    separate bet surface, never inside the league).
 *
 * Survival through minification is load-bearing. The literal is written to
 * a `globalThis` key at module-evaluation time — an observable property
 * write no minifier may treat as dead code — and `BettingPremierePage.ts`
 * additionally stamps it onto `document.body.dataset` when the betting
 * page mounts, so the marker is a real, inspectable runtime value rather
 * than an unused constant that tree-shaking could drop. Every league-
 * excluded entry module (`page/AccountPage.ts`, `page/BettingPremierePage.ts`,
 * `page/PremiereEndedPage.ts`, `components/pnlDisplay.ts` — the exact set
 * aliased away by `src/client/prediction/leagueStubs/stubMap.ts`) imports
 * this module, so if ANY of them leaks into a league bundle the sentinel
 * leaks with it and the scan fails the build.
 *
 * The league stubs under `src/client/prediction/leagueStubs/` must NEVER
 * import this module or repeat the literal —
 * `tests/client/prediction/wagering/LeagueStubParity.test.ts` pins that.
 */
export const WAGERING_BUILD_SENTINEL = "PROXYWAR-WAGERING-SENTINEL-daf98298";

(globalThis as Record<string, unknown>)["__PROXYWAR_WAGERING_BUILD__"] =
  WAGERING_BUILD_SENTINEL;
