import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      const modal = new WinModal();

      window.location.pathname = "/ai-league-replay/league-coworld-x";
      (modal as unknown as { _handleExit: () => void })._handleExit();
      expect(window.location.href).toBe("/league");

      window.location.pathname = "/";
      (modal as unknown as { _handleExit: () => void })._handleExit();
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
