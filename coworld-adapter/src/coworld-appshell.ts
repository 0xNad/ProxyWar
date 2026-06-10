// Coworld app-shell presentation helpers.
//
// The /client/* routes serve the full Proxy War client shell (the OpenFront-
// derived index.html). That HTML paints the game landing page before the JS
// bundle boots, so Observatory viewers saw a frontpage flash and inherited
// branding before a replay opened. injectCoworldSplash() covers the page with
// a Proxy War-branded splash from the very first paint; the client removes it
// by id once its own replay loading overlay is mounted
// (src/client/Main.ts openCoworldReplay — keep the id in sync there).

export type CoworldAppShellRoute = "global" | "replay" | "player";

export const COWORLD_SPLASH_ELEMENT_ID = "proxywar-coworld-splash";

// Splash sits just under the client's own loading overlay (z-index 100000 in
// openCoworldReplay) so the client overlay seamlessly covers it on handoff.
const SPLASH_Z_INDEX = 99999;

const ROUTE_MESSAGES: Record<CoworldAppShellRoute, string> = {
  global: "Loading live match view…",
  replay: "Loading replay…",
  player: "Connecting you to the match…",
};

/** Mirrors the exact /client/* pathname matching in handleHttp. */
export function coworldAppShellRoute(
  pathname: string,
): CoworldAppShellRoute | null {
  if (pathname === "/client/global") {
    return "global";
  }
  if (pathname === "/client/replay") {
    return "replay";
  }
  if (pathname === "/client/player") {
    return "player";
  }
  return null;
}

export function injectCoworldSplash(
  html: string,
  route: CoworldAppShellRoute,
): string {
  const splash =
    `<div id="${COWORLD_SPLASH_ELEMENT_ID}" style="position:fixed;inset:0;` +
    `z-index:${SPLASH_Z_INDEX};display:grid;place-items:center;` +
    `background:#070b12;color:#fff;font:600 18px system-ui,sans-serif;">` +
    `<div style="text-align:center;">` +
    `<div style="font-size:28px;letter-spacing:0.2em;margin-bottom:12px;">PROXY WAR</div>` +
    `<div style="opacity:0.75;">${ROUTE_MESSAGES[route]}</div>` +
    `</div></div>`;
  // Conservative retitle: only when the shell's title doesn't already say
  // Proxy War (e.g. an image built from an unrebranded tree). Attributes on
  // the tag (data-i18n etc.) are preserved.
  const retitled = /<title[^>]*>(?![^<]*Proxy War)[^<]*<\/title>/i.test(html)
    ? html.replace(/(<title[^>]*>)[^<]*(<\/title>)/i, "$1Proxy War$2")
    : html;
  const bodyTag = retitled.match(/<body[^>]*>/i);
  if (bodyTag !== null && bodyTag.index !== undefined) {
    const insertAt = bodyTag.index + bodyTag[0].length;
    return retitled.slice(0, insertAt) + splash + retitled.slice(insertAt);
  }
  // Defensive: no <body> tag found — prepend so the splash still renders.
  return splash + retitled;
}
