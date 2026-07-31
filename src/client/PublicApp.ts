import "./LangSelector";
import "./publicapp/AboutPage";
import "./publicapp/AgentProfilePage";
import "./publicapp/AgentsDirectoryPage";
import "./publicapp/BuilderProfilePage";
import "./publicapp/BuildersDirectoryPage";
import "./publicapp/LobbyPage";
import "./publicapp/WatchPage";

/**
 * Entry point for the Stage 2 public app (`/`, `/watch`, `/agents`,
 * `/agent/:slug`, `/builders`, `/builder/:slug`, `/about`) — a deliberately
 * separate, minimal Vite entry from `Main.ts`'s game/replay/premiere
 * client. `Main.ts` statically imports the entire game engine (Pixi
 * renderer, `ClientGameRunner`, ad SDKs, etc.), so any route that loads it
 * downloads that whole bundle regardless of which page renders — this file
 * exists so the public pages never do. `public.html` (sibling to
 * `index.html`) references this file instead of `Main.ts`, and
 * `sendPublicAppShellPage` in `ai-agent-demo-server.ts` serves
 * `public.html`'s built output for exactly these routes; every other route
 * (game, `/ai-league-replay/*`, `/premiere/*`, `/bet/*`, `/player/:name`,
 * `/account`, `/trader/:accountId`) is untouched and keeps loading
 * `index.html` + `Main.ts` exactly as before.
 *
 * Each public page fully replaces `document.body` on mount (see
 * `PlayerProfilePage`'s doc comment for the same pattern) — real
 * `<a href>` navigation only, no client-side route transitions — so this
 * file only needs a one-shot dispatch on load, not `Main.ts`'s
 * popstate/hashchange machinery.
 *
 * `translateText()` (`Utils.ts`) requires a connected `<lang-selector>`
 * element to resolve keys; in the game shell that element lives inside
 * `Footer.ts`, nested under the header/nav chrome `index.html` renders
 * unconditionally. These pages have no such chrome and call
 * `document.body.replaceChildren(...)`, which would otherwise remove any
 * `<lang-selector>` that happened to be a body descendant before it ever
 * finishes loading translations. Creating one here, once, and appending it
 * to `<head>` (never touched by a body swap) keeps translateText working
 * across every page mount for the lifetime of the document.
 */
document.head.appendChild(document.createElement("lang-selector"));

function mount(pathname: string): boolean {
  if (pathname === "/") {
    document.body.replaceChildren(document.createElement("lobby-page"));
    return true;
  }
  if (pathname === "/watch") {
    document.body.replaceChildren(document.createElement("watch-page"));
    return true;
  }
  if (pathname === "/agents") {
    document.body.replaceChildren(
      document.createElement("agents-directory-page"),
    );
    return true;
  }
  const agentProfileMatch = pathname.match(/^\/agent\/([^/]+)$/);
  if (agentProfileMatch !== null) {
    const page = document.createElement("agent-profile-page");
    page.setAttribute("slug", decodeURIComponent(agentProfileMatch[1]));
    document.body.replaceChildren(page);
    return true;
  }
  if (pathname === "/builders") {
    document.body.replaceChildren(
      document.createElement("builders-directory-page"),
    );
    return true;
  }
  const builderProfileMatch = pathname.match(/^\/builder\/([^/]+)$/);
  if (builderProfileMatch !== null) {
    const page = document.createElement("builder-profile-page");
    page.setAttribute("slug", decodeURIComponent(builderProfileMatch[1]));
    document.body.replaceChildren(page);
    return true;
  }
  if (pathname === "/about") {
    document.body.replaceChildren(document.createElement("about-page"));
    return true;
  }
  return false;
}

if (!mount(window.location.pathname)) {
  // Server-side routing only ever serves this entry for the routes `mount`
  // handles; reaching here means a stale cached `public.html` outlived a
  // route removal. Fail safe to the real league page rather than a blank
  // document.
  window.location.href = "/league";
}
