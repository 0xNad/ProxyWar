import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  isBroadcastReplayPresentation,
  isStaticReplayBroadcast,
  REPLAY_SEAT_COLORS,
} from "../../src/core/configuration/Colors";
import { PastelTheme } from "../../src/core/configuration/PastelTheme";
import { PlayerType } from "../../src/core/game/Game";
import type { PlayerView } from "../../src/core/game/GameView";
import { UserSettings } from "../../src/core/game/UserSettings";

/**
 * THE TWO BROADCAST PLANES MUST LOOK THE SAME.
 *
 * The same archived league match is presented on two surfaces:
 *
 *   1. the offline static-replay bundle the Coworld Observatory serves
 *      (vite mode "static-replay" -> `__PROXYWAR_STATIC_REPLAY__`), and
 *   2. proxywar.xyz's own hosted replay routes, served off the ORDINARY
 *      production build, where that build flag is false by construction.
 *
 * Every look-and-feel gate used to key on the build flag alone, so the two
 * planes drifted visibly apart until the operator reported it on 2026-08-19:
 * "no nuke animation, I don't see messages on bottom right, colours are not
 * right, it is also in day mode vs night mode."
 *
 * These tests pin the plane — not the build — as the thing presentation keys
 * on, and pin that LIVE PLAY is untouched, which is the whole reason the
 * predicate is opt-in rather than a default.
 */

type BroadcastWindow = typeof window & {
  __PROXYWAR_STATIC_REPLAY__?: boolean;
  __PROXYWAR_BROADCAST_REPLAY__?: boolean;
};

function broadcastWindow(): BroadcastWindow {
  return window as BroadcastWindow;
}

function clearPlaneGlobals(): void {
  delete broadcastWindow().__PROXYWAR_STATIC_REPLAY__;
  delete broadcastWindow().__PROXYWAR_BROADCAST_REPLAY__;
}

/** Minimal stand-in: territoryColor() reads only these three. */
function humanPlayer(id: string): PlayerView {
  return {
    team: () => null,
    type: () => PlayerType.Human,
    id: () => id,
  } as unknown as PlayerView;
}

afterEach(() => {
  clearPlaneGlobals();
  localStorage.clear();
});

describe("broadcast presentation plane", () => {
  test("is off by default — live play keeps stock presentation", () => {
    clearPlaneGlobals();
    expect(isBroadcastReplayPresentation()).toBe(false);
    expect(isStaticReplayBroadcast()).toBe(false);
  });

  test("the Observatory's static bundle is a broadcast plane", () => {
    broadcastWindow().__PROXYWAR_STATIC_REPLAY__ = true;
    expect(isBroadcastReplayPresentation()).toBe(true);
  });

  test("a hosted replay route is a broadcast plane WITHOUT the build flag", () => {
    // The regression in one line: proxywar.xyz never sets the build flag, and
    // before this global existed that made it a non-broadcast surface.
    broadcastWindow().__PROXYWAR_BROADCAST_REPLAY__ = true;
    expect(isStaticReplayBroadcast()).toBe(false);
    expect(isBroadcastReplayPresentation()).toBe(true);
  });

  test("neither global persists — it cannot leak into the next page", () => {
    broadcastWindow().__PROXYWAR_BROADCAST_REPLAY__ = true;
    expect(isBroadcastReplayPresentation()).toBe(true);
    clearPlaneGlobals();
    expect(isBroadcastReplayPresentation()).toBe(false);
  });

  test("an explicit false is not a broadcast plane", () => {
    broadcastWindow().__PROXYWAR_STATIC_REPLAY__ = false;
    broadcastWindow().__PROXYWAR_BROADCAST_REPLAY__ = false;
    expect(isBroadcastReplayPresentation()).toBe(false);
  });
});

describe("dark theme follows the plane, not the build", () => {
  test("hosted replay routes run the dark ops-room theme", () => {
    const settings = new UserSettings();
    expect(settings.darkMode()).toBe(false);

    broadcastWindow().__PROXYWAR_BROADCAST_REPLAY__ = true;
    expect(settings.darkMode()).toBe(true);
  });

  test("the static bundle still runs it, exactly as before", () => {
    const settings = new UserSettings();
    broadcastWindow().__PROXYWAR_STATIC_REPLAY__ = true;
    expect(settings.darkMode()).toBe(true);
  });

  test("live play still honours the player's own saved setting", () => {
    clearPlaneGlobals();
    const settings = new UserSettings();
    expect(settings.darkMode()).toBe(false);
    settings.toggleDarkMode();
    expect(settings.darkMode()).toBe(true);
    settings.toggleDarkMode();
    expect(settings.darkMode()).toBe(false);
  });

  test("the broadcast plane does not write the player's saved setting", () => {
    broadcastWindow().__PROXYWAR_BROADCAST_REPLAY__ = true;
    const settings = new UserSettings();
    expect(settings.darkMode()).toBe(true);

    // Leaving the broadcast surface must restore the stock answer: the plane
    // forces the theme, it never persists a preference the viewer never made.
    clearPlaneGlobals();
    expect(settings.darkMode()).toBe(false);
  });

  test("darkMode() and isBroadcastReplayPresentation() stay in lockstep", () => {
    // UserSettings deliberately re-reads the globals inline instead of
    // importing Colors (it is constructed on the simulation side). That is a
    // duplicated predicate, so pin the two against each other.
    const settings = new UserSettings();
    for (const globals of [
      {},
      { __PROXYWAR_STATIC_REPLAY__: true },
      { __PROXYWAR_BROADCAST_REPLAY__: true },
      { __PROXYWAR_STATIC_REPLAY__: true, __PROXYWAR_BROADCAST_REPLAY__: true },
    ] as Partial<BroadcastWindow>[]) {
      clearPlaneGlobals();
      Object.assign(broadcastWindow(), globals);
      expect(settings.darkMode()).toBe(isBroadcastReplayPresentation());
    }
  });
});

describe("the 16-seat broadcast palette follows the plane", () => {
  test("a hosted replay gets seat colours, not the stock pastels", () => {
    broadcastWindow().__PROXYWAR_BROADCAST_REPLAY__ = true;
    const theme = new PastelTheme();
    const seat = theme.territoryColor(humanPlayer("seat-0"));
    expect(REPLAY_SEAT_COLORS.map((c) => c.toHex())).toContain(seat.toHex());
  });

  test("live play keeps the stock allocator", () => {
    clearPlaneGlobals();
    const theme = new PastelTheme();
    const stock = theme.territoryColor(humanPlayer("seat-0"));
    expect(REPLAY_SEAT_COLORS.map((c) => c.toHex())).not.toContain(
      stock.toHex(),
    );
  });

  test("both planes allocate the SAME colour for the same seat order", () => {
    // "Exactly the same as the Observatory" is a per-seat claim, not just a
    // palette-membership one: seat N must be the same swatch on both.
    broadcastWindow().__PROXYWAR_STATIC_REPLAY__ = true;
    const staticTheme = new PastelTheme();
    const staticSeats = ["a", "b", "c"].map((id) =>
      staticTheme.territoryColor(humanPlayer(id)).toHex(),
    );

    clearPlaneGlobals();
    broadcastWindow().__PROXYWAR_BROADCAST_REPLAY__ = true;
    const hostedTheme = new PastelTheme();
    const hostedSeats = ["a", "b", "c"].map((id) =>
      hostedTheme.territoryColor(humanPlayer(id)).toHex(),
    );

    expect(hostedSeats).toEqual(staticSeats);
  });
});

/**
 * The shell is where the plane is decided, and it is plain inline JS in an EJS
 * template that no bundler or typechecker guards. Evaluate the real thing.
 */
describe("app shell decides the plane before the bundle runs", () => {
  const repoRoot = path.resolve(__dirname, "../..");

  function evaluateShellPlane(
    pathname: string,
    staticReplayBuild: boolean,
  ): { aiReplay: boolean; broadcast: boolean } {
    const html = readFileSync(path.join(repoRoot, "index.html"), "utf8");
    const start = html.indexOf("window.__PROXYWAR_STATIC_REPLAY__ =");
    const marker = "window.__PROXYWAR_BROADCAST_REPLAY__ =";
    const markerAt = html.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    expect(markerAt).toBeGreaterThan(start);
    const end = html.indexOf(";", html.indexOf("isCoworldRoute", markerAt));
    expect(end).toBeGreaterThan(markerAt);

    const snippet = html
      .slice(start, end + 1)
      .replace(
        /<%-\s*staticReplayBuild \? "true" : "false"\s*%>/,
        String(staticReplayBuild),
      );
    expect(snippet).not.toContain("<%");

    const fakeWindow: Record<string, unknown> = {};
    const run = new Function(
      "window",
      "location",
      `${snippet}\nreturn {
         aiReplay: window.__PROXYWAR_AI_REPLAY__ === true,
         broadcast: window.__PROXYWAR_BROADCAST_REPLAY__ === true,
       };`,
    );
    return run(fakeWindow, { origin: "https://proxywar.xyz", pathname }) as {
      aiReplay: boolean;
      broadcast: boolean;
    };
  }

  test.each([
    ["/ai-league-replay/league-coworld-2026-08-19T14-52-03-301Z-7a2a953d"],
    ["/proxywar-replay/abc123"],
    ["/openfront-replay/abc123"],
    ["/premiere/prem_abcdef0123456789"],
    ["/client/replay"],
    ["/client/global"],
  ])("%s is a broadcast surface", (pathname) => {
    expect(evaluateShellPlane(pathname, false).broadcast).toBe(true);
  });

  test.each([["/"], ["/league"], ["/watch"], ["/join/ABCDEF"]])(
    "%s is live play, not a broadcast surface",
    (pathname) => {
      const plane = evaluateShellPlane(pathname, false);
      expect(plane.aiReplay).toBe(false);
      expect(plane.broadcast).toBe(false);
    },
  );

  test("/client/player is a play surface and keeps stock presentation", () => {
    // A human plays there, live. It is an AI-replay ROUTE (asset base, boot
    // class) but deliberately NOT a broadcast presentation surface.
    const plane = evaluateShellPlane("/client/player", false);
    expect(plane.aiReplay).toBe(true);
    expect(plane.broadcast).toBe(false);
  });

  test("the static bundle stays a broadcast surface at any path", () => {
    // An offline bundle can never be demoted by the path it is opened at —
    // including /client/player, which would otherwise subtract it.
    expect(evaluateShellPlane("/client/player", true).broadcast).toBe(true);
    expect(evaluateShellPlane("/", true).broadcast).toBe(true);
  });
});

/**
 * REGRESSION CLASS, not a single bug. Presentation work keeps landing keyed on
 * the Coworld-shaped flag and silently excluding proxywar.xyz's own routes:
 * PR #110 did it twice (the spectator skin and the decision feed), and the
 * theme, palette and opening speed did it again here. The build flag has a few
 * legitimate readers; presentation is not one of them.
 */
describe("no presentation gate reads the build flag directly", () => {
  const repoRoot = path.resolve(__dirname, "../..");

  /** Each entry says WHY that file is allowed to read the build flag. */
  const allowed = new Map<string, string>([
    [
      "src/core/configuration/Colors.ts",
      "defines both predicates — this is the choke point",
    ],
    [
      "src/core/game/UserSettings.ts",
      "the deliberate inline twin of isBroadcastReplayPresentation(), pinned in lockstep above",
    ],
    [
      "src/client/CoworldStaticReplay.ts",
      "TRANSPORT: only the offline bundle carries an inline replay envelope",
    ],
    [
      "src/client/AiLeagueReplayMode.ts",
      "ROUTE detection: the bundle has no meaningful pathname",
    ],
    [
      "src/client/analytics/AnalyticsClient.ts",
      "TELEMETRY: an offline bundle must not phone home",
    ],
    [
      "src/client/graphics/TransformHandler.ts",
      "CAMERA landing fit is deliberately Observatory-only — Softmax controls that framing, we do not",
    ],
  ]);

  test("every reader of __PROXYWAR_STATIC_REPLAY__ is a declared exception", async () => {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(
      "git",
      ["grep", "-l", "__PROXYWAR_STATIC_REPLAY__", "--", "src"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const readers = out.split("\n").filter((line) => line.length > 0);
    expect(readers.length).toBeGreaterThan(0);
    const undeclared = readers.filter((file) => !allowed.has(file));
    expect(
      undeclared,
      `These read the static-replay BUILD flag but presentation must key on the PLANE (isBroadcastReplayPresentation). If a new reader is genuinely transport/route/telemetry, add it to \`allowed\` with the reason:\n  ${undeclared.join("\n  ")}`,
    ).toEqual([]);
  });
});
