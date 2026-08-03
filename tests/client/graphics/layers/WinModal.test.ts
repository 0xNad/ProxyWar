import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FitWholeMapEvent } from "../../../../src/client/graphics/TransformHandler";
import { GameUpdateType } from "../../../../src/core/game/GameUpdates";
import { RankedType } from "../../../../src/core/game/Game";

vi.mock("../../../../src/client/Utils", () => ({
  translateText: vi.fn(
    (key: string, params?: Record<string, string | number>) => {
      const translations: Record<string, string> = {
        "win_modal.exit": "Exit",
        "win_modal.requeue": "Play Again",
        "win_modal.keep": "Keep Playing",
        "win_modal.spectate": "Spectate",
        "win_modal.other_won": "{player} won",
        "win_modal.nation_won": "{nation} nation won",
      };
      const message = translations[key] || key;
      if (params === undefined) return message;
      return Object.entries(params).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
        message,
      );
    },
  ),
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
    localStorage.clear();
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

    // P0 regression (2026-08-03, deploy 3.10): the Anonymous Names edit
    // above (deploy 3.9, item 2) replaced this class's `createRenderRoot()`
    // override + empty `constructor()` with the new connectedCallback/
    // disconnectedCallback pair, accidentally deleting the override in the
    // process. Without it, WinModal falls back to LitElement's default
    // shadow DOM, which isolates it from the global Tailwind stylesheet
    // (index.html light DOM only) -- every class above (`fixed`, `z-[10010]`,
    // centering, the 95% background just asserted) silently stops applying.
    // `isVisible`/`_title` still flip correctly and `tick()`/`show()` still
    // run clean, so nothing throws and nothing else here catches it: the
    // banner just renders as an unstyled, invisible sliver. This is the
    // exact contract a real DOM instantiation (not just render()'s
    // TemplateResult) can check directly.
    it("renders into light DOM, not an isolated shadow root (Tailwind must reach the banner)", async () => {
      const { WinModal } = await import(
        "../../../../src/client/graphics/layers/WinModal"
      );
      const modal = new WinModal() as unknown as {
        createRenderRoot: () => Node;
      };
      expect(modal.createRenderRoot()).toBe(modal);
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

  // P0 fix (2026-08-03): WinModal is a top-level `<win-modal>` element
  // (index.html), entirely outside AiLeagueReplayOverlay.ts's
  // renderDetails() rebuild path -- the "Anonymous Names" setting never
  // reached the winner's name here, both at first display (the raw
  // PlayerView.displayName() was never routed through
  // aiLeagueSpectatorDisplayName at all) and on a mid-session toggle
  // (nothing ever re-derived the already-baked title).
  describe("Anonymous Names (deploy 3.9, item 2)", () => {
    interface WinModalAnonymizeHooks {
      _title: string;
      eventBus: unknown;
      game: unknown;
      tick: () => void;
      connectedCallback: () => void;
      disconnectedCallback: () => void;
    }

    function winGame(displayName: string): MinimalGame {
      const winner: MinimalWinnerPlayer = {
        isPlayer: () => true,
        clientID: () => "WINNER_CLIENT",
        displayName: () => displayName,
      };
      return {
        myPlayer: () => null,
        updatesSinceLastTick: () => ({
          [GameUpdateType.Win]: [
            { winner: ["player", "WINNER_CLIENT"], allPlayersStats: {} },
          ],
        }),
        playerByClientID: () => winner,
        inSpawnPhase: () => false,
        config: () => ({ gameConfig: () => ({ rankedType: undefined }) }),
      };
    }

    // UserSettings keeps a private static in-memory cache alongside
    // localStorage -- clearing localStorage in afterEach does NOT reset
    // it, so a prior test's toggleRandomName() call leaks into the next
    // test's starting state. Checking-then-toggling (same idiom
    // AiLeagueReplayMode.test.ts already uses) is robust regardless of
    // what an earlier test in this file left behind.
    async function setAnonymousNames(enabled: boolean): Promise<void> {
      const { UserSettings } = await import(
        "../../../../src/core/game/UserSettings"
      );
      const settings = new UserSettings();
      if (settings.anonymousNames() !== enabled) {
        settings.toggleRandomName();
      }
    }

    it("anonymizes the winner's name in the title when Anonymous Names is already on", async () => {
      await setAnonymousNames(true);
      const { WinModal } = await import(
        "../../../../src/client/graphics/layers/WinModal"
      );
      const modal = new WinModal() as unknown as WinModalAnonymizeHooks;
      modal.eventBus = { emit: () => {} };
      modal.game = winGame("Real Agent Name");

      modal.tick();

      expect(modal._title).not.toContain("Real Agent Name");
      expect(modal._title).toMatch(/Agent \d+/);
    });

    it("re-anonymizes the already-displayed winner name the instant Anonymous Names toggles mid-session, both directions", async () => {
      await setAnonymousNames(false);
      const { UserSettings } = await import(
        "../../../../src/core/game/UserSettings"
      );
      const { WinModal } = await import(
        "../../../../src/client/graphics/layers/WinModal"
      );
      const modal = new WinModal() as unknown as WinModalAnonymizeHooks;
      modal.eventBus = { emit: () => {} };
      modal.game = winGame("Real Agent Name");
      modal.connectedCallback();

      modal.tick();
      expect(modal._title).toContain("Real Agent Name");

      new UserSettings().toggleRandomName();
      expect(modal._title).not.toContain("Real Agent Name");
      expect(modal._title).toMatch(/Agent \d+/);

      new UserSettings().toggleRandomName();
      expect(modal._title).toContain("Real Agent Name");

      modal.disconnectedCallback();
    });

    it("never touches the title for the local player's own win, team win, or nation win (nothing to anonymize)", async () => {
      await setAnonymousNames(true);
      const { UserSettings } = await import(
        "../../../../src/core/game/UserSettings"
      );
      const { WinModal } = await import(
        "../../../../src/client/graphics/layers/WinModal"
      );
      const modal = new WinModal() as unknown as WinModalAnonymizeHooks;
      modal.eventBus = { emit: () => {} };
      modal.connectedCallback();
      modal.game = {
        myPlayer: () => null,
        updatesSinceLastTick: () => ({
          [GameUpdateType.Win]: [
            { winner: ["nation", "Real Nation Name"], allPlayersStats: {} },
          ],
        }),
        inSpawnPhase: () => false,
        config: () => ({ gameConfig: () => ({ rankedType: undefined }) }),
      };

      modal.tick();
      expect(modal._title).toContain("Real Nation Name");

      // A settings toggle after a nation win must never crash or fabricate
      // a player-title recompute — there is no otherPlayerWinnerRawName to
      // re-derive from.
      new UserSettings().toggleRandomName();
      expect(modal._title).toContain("Real Nation Name");
    });
  });
});
