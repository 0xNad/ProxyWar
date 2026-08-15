import { render as renderTemplate } from "lit";
import { describe, expect, it, vi } from "vitest";
import { Leaderboard } from "../../../../src/client/graphics/layers/Leaderboard";

/**
 * Regression: a prior POV-removal edit accidentally swept `createRenderRoot()`
 * out along with the deleted `povPlayerId`/`init()` PointOfViewChangeEvent
 * subscription it happened to sit beside. Without `createRenderRoot()`
 * returning `this`, LitElement falls back to its default behavior of
 * attaching a real Shadow DOM root — which would put every leaderboard row
 * behind a shadow boundary Tailwind's global stylesheet can never reach,
 * rendering it completely unstyled in production. This pins the light-DOM
 * contract directly, independent of any POV-related behavior.
 */
describe("Leaderboard light DOM (Tailwind support)", () => {
  it("createRenderRoot() returns the element itself, not a Shadow DOM boundary", () => {
    const leaderboard = new Leaderboard();
    const root = leaderboard.createRenderRoot();
    expect(root).toBe(leaderboard);
  });

  it("never attaches a shadowRoot — global Tailwind stylesheets must reach every rendered row", () => {
    const leaderboard = new Leaderboard();
    leaderboard.createRenderRoot();
    expect(leaderboard.shadowRoot).toBeNull();
  });
});

describe("Leaderboard broadcast scorebug column contract", () => {
  it("marks every broadcast column with the semantic hook used by responsive CSS", () => {
    const leaderboard = new Leaderboard();
    leaderboard.broadcast = true;
    leaderboard.visible = true;
    leaderboard.players = [
      {
        name: "Alpha",
        position: 1,
        score: "50%",
        gold: "1K",
        maxTroops: "2K",
        isMyPlayer: false,
        isOnSameTeam: false,
        player: { id: () => "alpha" },
        seatColor: "#fff",
        seatRim: "#000",
        alive: true,
        crowned: false,
        marginNote: "▲10 over 2nd",
      } as (typeof leaderboard.players)[number],
    ];
    const host = document.createElement("div");
    renderTemplate(leaderboard.render(), host);

    const header = host.querySelector(".contents.font-bold");
    expect(header).not.toBeNull();
    expect(
      Array.from(header!.children, (cell) =>
        cell.getAttribute("data-scorebug-column"),
      ),
    ).toEqual(["rank", "player", "owned", "gold", "max-troops"]);

    const playerRow = host.querySelector('[data-scorebug-row="player"]');
    expect(playerRow).not.toBeNull();
    expect(
      Array.from(playerRow!.children, (cell) =>
        cell.getAttribute("data-scorebug-column"),
      ),
    ).toEqual(["rank", "player", "owned", "gold", "max-troops"]);
    expect(playerRow!.querySelector("[data-scorebug-margin]")).not.toBeNull();
  });

  it("restores territory sorting when a desktop viewer enters compact mode", () => {
    let changeListener: ((event: MediaQueryListEvent) => void) | null = null;
    const mediaQuery = {
      matches: false,
      media: "(max-width: 980px)",
      addEventListener: vi.fn(
        (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          changeListener = listener;
        },
      ),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mediaQuery),
    );

    const leaderboard = new Leaderboard();
    leaderboard.broadcast = true;
    leaderboard.visible = false;
    const sortState = leaderboard as unknown as {
      _sortKey: "tiles" | "gold" | "maxtroops";
      _sortOrder: "asc" | "desc";
    };
    sortState._sortKey = "gold";
    sortState._sortOrder = "asc";

    try {
      document.body.appendChild(leaderboard);
      expect(changeListener).not.toBeNull();
      changeListener!({ matches: true } as MediaQueryListEvent);
      expect(sortState._sortKey).toBe("tiles");
      expect(sortState._sortOrder).toBe("desc");
    } finally {
      leaderboard.remove();
      vi.unstubAllGlobals();
    }
  });
});
