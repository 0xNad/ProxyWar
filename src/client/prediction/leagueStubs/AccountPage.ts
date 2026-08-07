/**
 * League-build stub for `../wagering/page/AccountPage` — see `stubMap.ts`
 * for the aliasing contract. Bundled only when vite runs with
 * `PROXYWAR_LEAGUE_CLIENT=1`.
 *
 * The real module's import (in `Main.ts`) exists for its side effect:
 * registering the `premiere-account-page` element that the standalone
 * `/account` route mounts. The account page is a betting surface (bankroll,
 * positions, lifetime points), so the league bundle replaces it with a
 * registration that renders nothing and sends the viewer to the league
 * page. Class name, tag name, and mount path all match the real module so
 * `Main.ts`'s `openAccountPage` needs no league-specific branch.
 *
 * Runtime-export parity with the real module is pinned by
 * `tests/client/prediction/wagering/LeagueStubParity.test.ts`.
 */
import { redirectToLeagueHome, warnWageringStubbed } from "./leagueStubShared";

export class PremiereAccountPage extends HTMLElement {
  connectedCallback(): void {
    warnWageringStubbed("the account page (/account)");
    redirectToLeagueHome();
  }
}

// Guarded (unlike the real module's `@customElement`) so importing both the
// real module and this stub in one test module graph cannot double-define.
if (customElements.get("premiere-account-page") === undefined) {
  customElements.define("premiere-account-page", PremiereAccountPage);
}
