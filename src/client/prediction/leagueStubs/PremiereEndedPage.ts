/**
 * League-build stub for `../wagering/page/PremiereEndedPage` — see
 * `stubMap.ts` for the aliasing contract. Bundled only when vite runs
 * with `PROXYWAR_LEAGUE_CLIENT=1`.
 *
 * The real `premiere-ended-page` element serves BOTH surfaces
 * (`/premiere/<id>` and `/bet/<id>` dead links — `Main.ts`'s
 * `openPremiereEndedPage`), and beyond its headline it is a betting
 * surface: it fetches `/api/premieres/account` and the settlement ledger
 * to show the viewer's P&L. The league stub keeps the non-betting half of
 * that contract — a `premiere_not_found` bootstrap still lands on a
 * themed, honest "this premiere has ended" page with a league CTA, never
 * a silent dead end — and drops the wagering data entirely. That matches
 * what the real page already renders against a wagering-off server
 * (both wagering fetches 404 there, so it falls back to this same
 * generic copy).
 *
 * Copy is hardcoded English on purpose: it duplicates the REAL page's own
 * strings verbatim ("This premiere has ended", "Go to the league", the
 * no-data fallback line), and that page — like the rest of the wagering
 * surface — deliberately does not go through `translateText()`. No new
 * user-visible text is introduced here.
 *
 * Runtime-export parity with the real module is pinned by
 * `tests/client/prediction/wagering/LeagueStubParity.test.ts`.
 */
import { LEAGUE_HOME_PATH, warnWageringStubbed } from "./leagueStubShared";

export class PremiereEndedPage extends HTMLElement {
  connectedCallback(): void {
    warnWageringStubbed("the premiere ended page");
    this.classList.add("block", "w-full", "grow");
    this.replaceChildren(this.buildPage());
  }

  private buildPage(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className =
      "flex min-h-screen flex-col items-center bg-surface px-4 py-10 text-ink sm:px-6";

    const column = document.createElement("div");
    column.className = "flex w-full max-w-md flex-col gap-6";
    wrap.append(column);

    const header = document.createElement("header");
    const homeLink = document.createElement("a");
    homeLink.href = "/";
    homeLink.className =
      "inline-flex items-center gap-1 text-sm font-semibold text-ink-muted outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent";
    const chevron = document.createElement("span");
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "‹";
    homeLink.append(chevron, document.createTextNode(" Proxy War"));
    header.append(homeLink);

    const card = document.createElement("div");
    card.className =
      "flex flex-col gap-4 rounded-lg border border-line bg-surface-2 p-6 text-center";
    const title = document.createElement("h1");
    title.className = "text-xl font-bold text-ink";
    title.textContent = "This premiere has ended";
    const body = document.createElement("p");
    body.className = "text-sm text-ink-muted";
    body.textContent =
      "This match is no longer live, and this link no longer leads " +
      "anywhere — nothing more is available for it here.";
    card.append(title, body);

    const cta = document.createElement("a");
    // The league page is the one honest destination on a league build,
    // for BOTH surfaces — the real page's `/bet` CTA has nothing behind
    // it here.
    cta.href = LEAGUE_HOME_PATH;
    cta.className =
      "inline-flex items-center justify-center rounded-md bg-accent px-4 py-2.5 text-sm font-bold text-on-accent outline-none transition-colors hover:bg-accent-strong focus-visible:ring-2 focus-visible:ring-accent";
    cta.textContent = "Go to the league";

    column.append(header, card, cta);
    return wrap;
  }
}

// Guarded (unlike the real module's `@customElement`) so importing both the
// real module and this stub in one test module graph cannot double-define.
if (customElements.get("premiere-ended-page") === undefined) {
  customElements.define("premiere-ended-page", PremiereEndedPage);
}
