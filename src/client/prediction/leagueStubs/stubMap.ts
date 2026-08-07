/**
 * League-client stub map — the single source of truth for which wagering
 * modules the LEAGUE client build (`PROXYWAR_LEAGUE_CLIENT=1`) replaces
 * with inert stubs, and with what.
 *
 * `src/client/prediction/wagering/**` is the betting/wagering client
 * surface (operator boundary 2026-07-27: speculation lives only on the
 * separate bet surface, never inside the league). The entries below are
 * the ONLY modules in that tree that non-wagering client code imports
 * (`src/client/Main.ts`, `src/client/platform/TraderProfilePage.ts`);
 * stubbing them severs the entire wagering module graph from the bundle.
 *
 * Consumed by:
 *  - `vite.config.ts` — builds `resolve.alias` entries from this map in
 *    league mode, and backs them with a guard plugin that FAILS the build
 *    if any module under `src/client/prediction/wagering/` is ever loaded
 *    anyway (i.e. a new import appeared that this map does not cover; the
 *    fix is to route it through a stub here, never to widen the bundle).
 *  - `tests/client/prediction/wagering/LeagueStubParity.test.ts` — pins
 *    that every stub exports exactly the same runtime names as its real
 *    module, and that this map and that test never drift apart.
 *
 * End-to-end proof on emitted assets is the sentinel scan
 * (`scripts/scan-wagering-sentinel.mjs`; see
 * `src/client/prediction/wagering/buildSentinel.ts`).
 */

export interface LeagueWageringStubEntry {
  /**
   * Real module path, rooted at the repo root, extensionless — exactly the
   * suffix importers write after their `./`/`../`/`src/client` prefix.
   */
  readonly realModule: string;
  /** Replacement stub module path, rooted at the repo root, extensionless. */
  readonly stubModule: string;
}

export const LEAGUE_WAGERING_STUB_MAP: readonly LeagueWageringStubEntry[] = [
  {
    realModule: "src/client/prediction/wagering/page/BettingPremierePage",
    stubModule: "src/client/prediction/leagueStubs/BettingPremierePage",
  },
  {
    realModule: "src/client/prediction/wagering/page/AccountPage",
    stubModule: "src/client/prediction/leagueStubs/AccountPage",
  },
  {
    realModule: "src/client/prediction/wagering/page/PremiereEndedPage",
    stubModule: "src/client/prediction/leagueStubs/PremiereEndedPage",
  },
  {
    realModule: "src/client/prediction/wagering/components/pnlDisplay",
    stubModule: "src/client/prediction/leagueStubs/pnlDisplay",
  },
];
