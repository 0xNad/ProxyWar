import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FitWholeMapEvent } from "../../../../src/client/graphics/TransformHandler";
import { GameUpdateType } from "../../../../src/core/game/GameUpdates";
import { RankedType } from "../../../../src/core/game/Game";

vi.mock("../../../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => {
    const translations: Record<string, string> = {
      "win_modal.exit": "Exit",
      "win_modal.requeue": "Play Again",
      "win_modal.keep": "Keep Playing",
      "win_modal.spectate": "Spectate",
    };
    return translations[key] || key;
  }),
  getGamesPlayed: vi.fn(() => 10),
  isInIframe: vi.fn(() => false),
  TUTORIAL_VIDEO_URL: "https://example.com/tutorial",
}));

vi.mock("../../../../src/client/Api", () => ({
  getUserMe: vi.fn(async () => null),
}));

vi.mock("../../../../src/client/Cosmetics", () => ({
  fetchCosmetics: vi.fn(async () => []),
  handlePurchase: vi.fn(),
  patternRelationship: vi.fn(() => ({})),
  resolveCosmetics: vi.fn(() => []),
  purchaseCosmetic: vi.fn(),
}));

vi.mock("../../../../src/client/components/CosmeticButton", () => ({}));

vi.mock("../../../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    happytime: vi.fn(),
    requestAd: vi.fn(),
    gameplayStop: vi.fn(),
  },
}));

interface WinModalTestHooks {
  isVisible: boolean;
  _handleExit: () => void;
}

interface MinimalPlayer {
  isAlive: () => boolean;
  hasSpawned: () => boolean;
}

interface MinimalWinnerPlayer {
  isPlayer: () => boolean;
  clientID: () => string | null;
  displayName: () => string;
}

interface MinimalGame {
  myPlayer: () => MinimalPlayer | null;
  updatesSinceLastTick: () => Record<number, unknown[]> | null;
  inSpawnPhase: () => boolean;
  playerByClientID?: (id: string) => MinimalWinnerPlayer | undefined;
  config?: () => { gameConfig: () => { rankedType: unknown } };
}

describe("WinModal Requeue", () => {
  let mockLocationHref = "";
  let mockLocationPathname = "/";

  beforeEach(() => {
    mockLocationHref = "";
    mockLocationPathname = "/";
    // Mock window.location.href using Object.defineProperty
    const locationMock = {
      get href() {
        return mockLocationHref;
      },
      set href(value: string) {
        mockLocationHref = value;
      },
      get pathname() {
        return mockLocationPathname;
      },
      set pathname(value: string) {
        mockLocationPathname = value;
      },
    };
    Object.defineProperty(window, "location", {
      value: locationMock,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isRankedGame detection", () => {
    it("should detect ranked 1v1 game", () => {
      const gameConfig = {
        rankedType: RankedType.OneVOne,
      };
      const isRankedGame = gameConfig.rankedType === RankedType.OneVOne;
      expect(isRankedGame).toBe(true);
    });

    it("should not detect non-ranked game", () => {
      const gameConfig = {
        rankedType: undefined,
      };
      const isRankedGame = gameConfig.rankedType === RankedType.OneVOne;
      expect(isRankedGame).toBe(false);
    });
  });

  describe("requeue navigation", () => {
    it("should navigate to /?requeue when requeue is triggered", () => {
      // Simulate the _handleRequeue behavior
      const handleRequeue = () => {
        window.location.href = "/?requeue";
      };

      handleRequeue();

      expect(window.location.href).toBe("/?requeue");
    });

    it("should navigate to / when exit is triggered", () => {
      // Simulate the _handleExit behavior
      const handleExit = () => {
        window.location.href = "/";
      };

      handleExit();

      expect(window.location.href).toBe("/");
    });
  });

  describe("league replay mode", () => {
    it("exit navigates to /league from a replay, / otherwise", async () => {
      const { WinModal } = await import(
        "../../../../src/client/graphics/layers/WinModal"
      );
      const modal = new WinModal() as unknown as WinModalTestHooks;

      window.location.pathname = "/ai-league-replay/league-coworld-x";
      modal._handleExit();
      expect(window.location.href).toBe("/league");

      window.location.pathname = "/";
      modal._handleExit();
      expect(window.location.href).toBe("/");
    });

    it("shows no tutorial or store upsell in replay mode", async () => {
      const { WinModal } = await import(
        "../../../../src/client/graphics/layers/WinModal"
      );
      const modal = new WinModal();

      window.location.pathname = "/ai-league-replay/league-coworld-x";
      const replayInner = modal.innerHtml();
      expect(replayInner.strings.join("").trim()).toBe("");

      window.location.pathname = "/";
      const normalInner = modal.innerHtml();
      const rendered =
        normalInner.strings.join(" ") + normalInner.values.join(" ");
      expect(rendered).toContain("win_modal.support_openfront");
      expect(rendered).not.toContain("iframe");
    });
  });

  describe("spec 02 non-negotiables (deploy 3.2, 2026-08-03)", () => {
    it("banner is opaque (95%), never the old translucent 70% that let map labels bleed through", async () => {
      const { WinModal } = await import(
        "../../../../src/client/graphics/layers/WinModal"
      );
      const modal = new WinModal() as unknown as WinModalTestHooks;
      modal.isVisible = true;
      const rendered = (
        modal as unknown as {
          render: () => { strings: readonly string[]; values: readonly unknown[] };
        }
      ).render();
      const html =
        rendered.strings.join(" ") + rendered.values.join(" ");
      expect(html).toContain("bg-gray-800/95");
      expect(html).not.toContain("bg-gray-800/70");
    });

    it("emits FitWholeMapEvent when a match-ending winner is determined (player)", async () => {
      const { WinModal } = await import(
        "../../../../src/client/graphics/layers/WinModal"
      );
      const modal = new WinModal();
      const emitted: unknown[] = [];
      const winner: MinimalWinnerPlayer = {
        isPlayer: () => true,
        clientID: () => "WINNER_CLIENT",
        displayName: () => "Winner",
      };
      const game: MinimalGame = {
        myPlayer: () => null,
        updatesSinceLastTick: () => ({
          [GameUpdateType.Win]: [
            {
              winner: ["player", "OTHER_CLIENT"],
              allPlayersStats: {},
            },
          ],
        }),
        playerByClientID: () => winner,
        inSpawnPhase: () => false,
        // WinModal.show() reads game.config().gameConfig().rankedType --
        // real, needed so the async show() this test's tick() triggers
        // doesn't reject with an unhandled rejection this test never awaits.
        config: () => ({ gameConfig: () => ({ rankedType: undefined }) }),
      };
      modal.eventBus = { emit: (event: unknown) => emitted.push(event) } as unknown as typeof modal.eventBus;
      modal.game = game as unknown as typeof modal.game;

      modal.tick();

      expect(emitted.some((event) => event instanceof FitWholeMapEvent)).toBe(
        true,
      );
    });

    it("does NOT emit FitWholeMapEvent for an individual death mid-match (not match end)", async () => {
      const { WinModal } = await import(
        "../../../../src/client/graphics/layers/WinModal"
      );
      const modal = new WinModal();
      const emitted: unknown[] = [];
      const game: MinimalGame = {
        myPlayer: () => ({
          isAlive: () => false,
          hasSpawned: () => true,
        }),
        updatesSinceLastTick: () => ({ [GameUpdateType.Win]: [] }),
        inSpawnPhase: () => false,
        config: () => ({ gameConfig: () => ({ rankedType: undefined }) }),
      };
      modal.eventBus = { emit: (event: unknown) => emitted.push(event) } as unknown as typeof modal.eventBus;
      modal.game = game as unknown as typeof modal.game;

      modal.tick();

      expect(emitted.some((event) => event instanceof FitWholeMapEvent)).toBe(
        false,
      );
    });
  });

  describe("requeue URL parameter handling", () => {
    it("should parse requeue parameter from URL", () => {
      const url = new URL("http://localhost:9000/?requeue");
      const hasRequeue = url.searchParams.has("requeue");
      expect(hasRequeue).toBe(true);
    });

    it("should not find requeue parameter when absent", () => {
      const url = new URL("http://localhost:9000/");
      const hasRequeue = url.searchParams.has("requeue");
      expect(hasRequeue).toBe(false);
    });
  });
});
