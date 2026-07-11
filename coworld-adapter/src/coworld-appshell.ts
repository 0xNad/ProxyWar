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

// Id of the replay-only winner banner injected on the /client/replay route.
export const COWORLD_WINNER_BANNER_ELEMENT_ID = "proxywar-coworld-winner-banner";

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
  // Replay watching surface only (/client/replay): suppress the native
  // end-of-game <win-modal> pop-up and show a non-blocking winner banner
  // instead. NOT injected on the "global" (live match spectate) or "player"
  // (live participant seat) routes, so live-game end-game behavior is
  // untouched. The client bundle is unchanged; this is adapter-only HTML/CSS/JS.
  const replayWinner = route === "replay" ? coworldReplayWinnerInjection() : "";
  // Conservative retitle: only when the shell's title doesn't already say
  // Proxy War (e.g. an image built from an unrebranded tree). Attributes on
  // the tag (data-i18n etc.) are preserved.
  const retitled = /<title[^>]*>(?![^<]*Proxy War)[^<]*<\/title>/i.test(html)
    ? html.replace(/(<title[^>]*>)[^<]*(<\/title>)/i, "$1Proxy War$2")
    : html;
  const bodyTag = retitled.match(/<body[^>]*>/i);
  if (bodyTag !== null && bodyTag.index !== undefined) {
    const insertAt = bodyTag.index + bodyTag[0].length;
    return (
      retitled.slice(0, insertAt) +
      splash +
      replayWinner +
      retitled.slice(insertAt)
    );
  }
  // Defensive: no <body> tag found — prepend so the splash still renders.
  return splash + replayWinner + retitled;
}

// Replay-only injection: CSS that hides the native <win-modal> pop-up, plus a
// small inline script that reads the winner from the modal's own title (the
// game engine's authoritative winner — Player.displayName()) once it appears,
// and renders a static "Winner: <name>" banner.
//
// Why the modal title, not a roster/tile-leader heuristic: the title is the
// engine's own winner determination (see WinModal.tick reading
// GameUpdateType.Win), so it is authoritative and never a tile-snapshot guess.
// We deliberately do NOT substring-match the title against any per-slot roster
// to recover the name — coworld-results.ts documents that name-substring
// matching collides ("War" inside "Warlord") and breaks on the 27-char in-game
// name truncation. Instead we extract the winner from the title's own known
// templates and otherwise fall back to the engine's full sentence verbatim, so
// the banner is always correct and never blank.
//
// Asset-assertion safe: contains no src=/href= attributes referencing
// assets/_assets, so assertCoworldAppShellAssets (no-docker-coworld-episode.ts)
// still passes for /client/replay.
function coworldReplayWinnerInjection(): string {
  const bannerId = COWORLD_WINNER_BANNER_ELEMENT_ID;
  const css =
    `<style id="${bannerId}-style">` +
    // Suppress the native end-game pop-up on the replay surface only.
    `win-modal{display:none!important;}` +
    `#${bannerId}{position:fixed;top:15%;left:50%;transform:translateX(-50%);` +
    `z-index:50002;pointer-events:none;display:none;align-items:center;` +
    `justify-content:center;gap:8px;max-width:min(560px,90vw);` +
    `padding:9px 16px;border-radius:8px;background:rgba(15,23,42,0.82);` +
    `color:#fff;font:700 16px/1.25 system-ui,-apple-system,BlinkMacSystemFont,` +
    `"Segoe UI",sans-serif;text-align:center;backdrop-filter:blur(8px);` +
    `box-shadow:0 12px 34px rgba(15,23,42,0.28);}` +
    `#${bannerId}.show{display:inline-flex;}` +
    `#${bannerId} .pw-winner-label{opacity:0.7;font-weight:600;` +
    `text-transform:uppercase;letter-spacing:0.08em;font-size:12px;}` +
    `</style>`;
  // The script body is plain ES5-safe DOM code so it runs before/independently
  // of the client bundle. JSON.stringify keeps the demo spectator-name remap in
  // one place and HTML/JS-escapes it safely.
  const spectatorNames = JSON.stringify({
    "Aggressive Agent 1": "Iron Atlas",
    "Defensive Agent 2": "Bastion",
    "Diplomatic Agent 3": "Silver Accord",
    "Opportunistic Agent 4": "Vantage",
    "Aggressive Agent 5": "Redline",
  });
  const script =
    `<script>(function(){` +
    `var BANNER_ID=${JSON.stringify(bannerId)};` +
    `var SPECTATOR=${spectatorNames};` +
    // Apply the demo spectator-name remap (no-op for real policy names).
    `function remap(n){return (SPECTATOR[n]||n);}` +
    // Recover "Winner: <name>" from the engine's localized title sentence.
    // Known English templates: "{player} has won!", "Nation {nation} has won!",
    // "{team} team has won!". Anything else -> show the sentence verbatim.
    `function winnerFromTitle(t){` +
    `t=(t||"").replace(/\\s+/g," ").trim();` +
    `if(!t)return null;` +
    `var m=t.match(/^Nation (.+?) has won!?$/i);if(m)return remap(m[1]);` +
    `m=t.match(/^(.+?) team has won!?$/i);if(m)return remap(m[1])+" team";` +
    `m=t.match(/^(.+?) has won!?$/i);if(m)return remap(m[1]);` +
    `return t;}` +
    `function bannerEl(){` +
    `var b=document.getElementById(BANNER_ID);` +
    `if(b)return b;` +
    `b=document.createElement("div");b.id=BANNER_ID;` +
    `b.setAttribute("role","status");` +
    `b.setAttribute("aria-live","polite");` +
    `document.body.appendChild(b);return b;}` +
    `function showWinner(name){` +
    `if(!name)return;` +
    `var b=bannerEl();` +
    // <= the only place untrusted text enters the DOM; use textContent.
    `var label=document.createElement("span");` +
    `label.className="pw-winner-label";label.textContent="Winner:";` +
    `var who=document.createElement("span");who.textContent=name;` +
    `b.textContent="";b.appendChild(label);b.appendChild(who);` +
    `b.classList.add("show");}` +
    // The win-modal uses light DOM (createRenderRoot returns this), so its
    // <h2> title is directly queryable. It becomes visible exactly at game end.
    `function modalTitle(){` +
    `var m=document.querySelector("win-modal");if(!m)return null;` +
    `var h=m.querySelector("h2");` +
    `return h?h.textContent:null;}` +
    `function visibleWin(){` +
    `var m=document.querySelector("win-modal");if(!m)return false;` +
    // Win modal toggles a child wrapper between "hidden" and a visible class
    // set; treat any non-hidden, non-empty title as a decided outcome.
    `var t=modalTitle();return !!(t&&t.replace(/\\s+/g,"").length);}` +
    `var done=false;` +
    `function check(){` +
    `if(done)return;` +
    `if(!visibleWin())return;` +
    `var name=winnerFromTitle(modalTitle());` +
    `if(!name)return;` +
    `done=true;showWinner(name);}` +
    // Observe the whole document: the win-modal may not exist yet at inject
    // time, and its title is populated later by the client bundle.
    `function start(){` +
    `try{` +
    `var obs=new MutationObserver(check);` +
    `obs.observe(document.documentElement,{childList:true,subtree:true,` +
    `characterData:true,attributes:true});` +
    `}catch(e){}` +
    `check();}` +
    `if(document.readyState==="loading"){` +
    `document.addEventListener("DOMContentLoaded",start);}else{start();}` +
    `})();</script>`;
  return css + script;
}
