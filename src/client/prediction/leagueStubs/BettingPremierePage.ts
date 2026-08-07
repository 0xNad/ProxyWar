/**
 * League-build stub for `../wagering/page/BettingPremierePage` — see
 * `stubMap.ts` for the aliasing contract. Bundled only when vite runs
 * with `PROXYWAR_LEAGUE_CLIENT=1`.
 *
 * `Main.ts` keeps its full `/bet/<id>` route classification and
 * `openBettingPremiere` bootstrap in the league bundle (that code is
 * shared with `/premiere/<id>` and must behave identically there —
 * requirement of the exclusion, not an accident). What changes is the
 * mount: `openBettingPremierePage` here warns once, redirects to the
 * league page, and hands back an inert handle whose `start()` never
 * settles — the redirect replaces the document, and neither resolving
 * (would run the caller's veil-finish machinery over a page that renders
 * nothing) nor rejecting (would flash a spurious failure screen mid-
 * navigation) is more honest than that.
 *
 * Runtime-export parity with the real module is pinned by
 * `tests/client/prediction/wagering/LeagueStubParity.test.ts`. Type
 * exports below are re-exported type-only from the real module (erased
 * at build — nothing from `wagering/**` reaches the league bundle), so
 * importers typecheck against the one true API. Never import the real
 * module or `../wagering/buildSentinel` as VALUES here, and never spell
 * the sentinel literal in this file.
 */
import type { ReplayPremiereRuntimeController } from "../../ReplayPremiereRuntime";
import type {
  BettingPremierePageCallbacks,
  BettingPremierePageHandle,
} from "../wagering/page/BettingPremierePage";
import { redirectToLeagueHome, warnWageringStubbed } from "./leagueStubShared";

export type {
  BettingPremierePageCallbacks,
  BettingPremierePageHandle,
} from "../wagering/page/BettingPremierePage";

/**
 * Inert stand-in for the real market controller. Nothing outside the
 * wagering graph constructs one (only the real `openBettingPremierePage`
 * does), so this exists purely for export parity; every member is a
 * deliberate no-op with the real class's public shape.
 */
export class BettingPremiereMarketController {
  public onPremiereGone?: () => void;

  attachOverlay(_overlay: unknown): void {}

  start(): void {}

  dispose(): void {}
}

/**
 * Same route grammar as the real module (and as
 * `AiLeagueReplayMode.ts`'s `isBettingPremiereRoute`, which already
 * duplicates it): `/bet/<id>` must still CLASSIFY as a betting route in
 * the league bundle — otherwise the URL would fall through to the lobby
 * landing flow — so the caller reaches `openBettingPremierePage` below
 * and gets the honest redirect instead.
 */
export function parseBettingPremiereRoute(pathname: string): string | null {
  const match = pathname.match(/^\/bet\/(prem_[a-z0-9]{16,32})$/);
  return match?.[1] ?? null;
}

/** League stub: warn once, redirect to the league page, return an inert handle. */
export function openBettingPremierePage(
  premiereId: string,
  callbacks: BettingPremierePageCallbacks,
): BettingPremierePageHandle {
  warnWageringStubbed("the betting premiere page (/bet/<id>)");
  redirectToLeagueHome();
  const runtime = {
    start: () => new Promise<void>(() => {}),
    dispose: () => {},
  } as unknown as ReplayPremiereRuntimeController;
  return { runtime, dispose: () => {} };
}

/**
 * League stub: there is never a live betting premiere to resolve. `null`
 * matches the real contract's "nothing honestly resolvable" branch, so
 * `Main.ts`'s rejoin path falls back to its existing premiere-ended CTA
 * (whose element is also league-stubbed) instead of fabricating an id.
 */
export async function resolveCurrentBettingPremiereId(
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  return null;
}
