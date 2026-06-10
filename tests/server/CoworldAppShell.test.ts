import { describe, expect, it } from "vitest";

import {
  COWORLD_SPLASH_ELEMENT_ID,
  coworldAppShellRoute,
  injectCoworldSplash,
} from "../../coworld-adapter/src/coworld-appshell";

const SHELL_HTML = [
  "<!doctype html>",
  "<html>",
  "<head><title>OpenFront</title></head>",
  '<body class="landing">',
  '<div id="page-main">landing page content</div>',
  "</body>",
  "</html>",
].join("\n");

describe("Coworld app shell splash", () => {
  it("maps exactly the three /client routes (mirroring handleHttp)", () => {
    expect(coworldAppShellRoute("/client/global")).toBe("global");
    expect(coworldAppShellRoute("/client/replay")).toBe("replay");
    expect(coworldAppShellRoute("/client/player")).toBe("player");
    expect(coworldAppShellRoute("/client/other")).toBeNull();
    expect(coworldAppShellRoute("/client/replay/extra")).toBeNull();
    expect(coworldAppShellRoute("/")).toBeNull();
  });

  it("injects the splash immediately after the body tag so it paints first", () => {
    const html = injectCoworldSplash(SHELL_HTML, "replay");

    const bodyIndex = html.indexOf('<body class="landing">');
    const splashIndex = html.indexOf(`id="${COWORLD_SPLASH_ELEMENT_ID}"`);
    const landingIndex = html.indexOf("landing page content");
    expect(bodyIndex).toBeGreaterThan(-1);
    expect(splashIndex).toBeGreaterThan(bodyIndex);
    // Splash renders before (covers) the landing DOM; the landing content is
    // covered, not removed — the client still needs its elements.
    expect(splashIndex).toBeLessThan(landingIndex);
    expect(html).toContain("PROXY WAR");
    expect(html).toContain("Loading replay…");
  });

  it("re-titles an unrebranded shell, preserving title attributes", () => {
    const html = injectCoworldSplash(SHELL_HTML, "replay");
    expect(html).toContain("<title>Proxy War</title>");
    expect(html).not.toContain("<title>OpenFront</title>");

    const attributed = SHELL_HTML.replace(
      "<title>OpenFront</title>",
      '<title data-i18n="main.title">OpenFront</title>',
    );
    const attributedResult = injectCoworldSplash(attributed, "replay");
    expect(attributedResult).toContain(
      '<title data-i18n="main.title">Proxy War</title>',
    );
  });

  it("leaves an already-rebranded title untouched (including i18n attrs)", () => {
    const rebranded = SHELL_HTML.replace(
      "<title>OpenFront</title>",
      '<title data-i18n="main.title">Proxy War (ALPHA)</title>',
    );
    const html = injectCoworldSplash(rebranded, "replay");
    expect(html).toContain(
      '<title data-i18n="main.title">Proxy War (ALPHA)</title>',
    );
  });

  it("uses a route-specific message for the player surface", () => {
    expect(injectCoworldSplash(SHELL_HTML, "player")).toContain(
      "Connecting you to the match…",
    );
    expect(injectCoworldSplash(SHELL_HTML, "global")).toContain(
      "Loading live match view…",
    );
  });

  it("still renders a splash when no body tag exists (defensive)", () => {
    const html = injectCoworldSplash("<p>bare fragment</p>", "replay");
    expect(html.startsWith("<div id=")).toBe(true);
    expect(html).toContain("bare fragment");
  });

  it("keeps the splash below the client loading overlay z-index (100000)", () => {
    const html = injectCoworldSplash(SHELL_HTML, "replay");
    const match = html.match(/z-index:(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThan(100000);
  });
});
