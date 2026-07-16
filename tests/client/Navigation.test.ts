import { beforeEach, describe, expect, it } from "vitest";
import { initNavigation } from "../../src/client/Navigation";

describe("initNavigation replay isolation", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="sidebar-menu"></div>
      <div id="mobile-menu-backdrop"></div>
      <div id="page-play" class="hidden"></div>
      <div id="page-host-lobby" class="page-content hidden"></div>
    `;
    delete window.currentPageId;
  });

  it.each([
    "/ai-league-replay/league-test",
    "/proxywar-replay/league-test",
    "/openfront-replay/league-test",
    "/client/replay",
    "/sessions/episode/proxy/client/player",
  ])("does not expose app pages on replay-only route %s", (pathname) => {
    history.replaceState(null, "", pathname);

    initNavigation();
    window.showPage?.("page-host-lobby");

    expect(window.currentPageId).toBeUndefined();
    expect(document.getElementById("page-play")?.classList).toContain("hidden");
    expect(document.getElementById("page-host-lobby")?.classList).toContain(
      "hidden",
    );
  });

  it("preserves normal page navigation outside replay routes", () => {
    history.replaceState(null, "", "/");

    initNavigation();

    expect(window.currentPageId).toBe("page-play");
    expect(document.getElementById("page-play")?.classList).not.toContain(
      "hidden",
    );

    window.showPage?.("page-host-lobby");
    expect(window.currentPageId).toBe("page-host-lobby");
    expect(document.getElementById("page-play")?.classList).toContain("hidden");
    expect(document.getElementById("page-host-lobby")?.classList).not.toContain(
      "hidden",
    );
  });

  it("restores page navigation after leaving a replay route", () => {
    history.replaceState(null, "", "/ai-league-replay/league-test");
    initNavigation();
    window.showPage?.("page-host-lobby");
    expect(window.currentPageId).toBeUndefined();

    history.replaceState(null, "", "/");
    window.showPage?.("page-host-lobby");

    expect(window.currentPageId).toBe("page-host-lobby");
    expect(document.getElementById("page-host-lobby")?.classList).not.toContain(
      "hidden",
    );
  });
});
