vi.mock("lit", () => ({
  html: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  }),
  LitElement: class extends EventTarget {
    requestUpdate() {}
  },
}));

vi.mock("lit/decorators.js", () => ({
  customElement: () => (clazz: unknown) => clazz,
  state: () => () => {},
  property: () => () => {},
  query: () => () => {},
}));

vi.mock("../../../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
}));

vi.mock("../../../../src/client/CrazyGamesSDK", () => ({
  crazyGamesSDK: {
    gameplayStop: vi.fn(),
    gameplayStart: vi.fn(),
    requestMidgameAd: vi.fn(),
  },
}));

vi.mock("../../../../src/client/LocalServer", () => ({
  AI_LEAGUE_REPLAY_CATCHUP_EVENT: "ai-league-replay-catchup",
}));

vi.mock("../../../../src/client/Transport", () => ({
  PauseGameIntentEvent: class {
    constructor(public paused: boolean) {}
  },
  SendWinnerEvent: class {},
}));

import { EventBus } from "../../../../src/core/EventBus";
import type { GameView } from "../../../../src/core/game/GameView";
import { CloseViewEvent } from "../../../../src/client/InputHandler";
import {
  GameRightSidebar,
  HUD_HIDDEN_BODY_CLASS,
} from "../../../../src/client/graphics/layers/GameRightSidebar";

function fakeGame(): GameView {
  return {
    config: () => ({
      gameConfig: () => ({ gameType: "replay", maxTimerValue: undefined }),
      isReplay: () => true,
    }),
    inSpawnPhase: () => false,
    myPlayer: () => null,
    ticks: () => 0,
  } as unknown as GameView;
}

function wiredSidebar(): { sidebar: GameRightSidebar; bus: EventBus } {
  const bus = new EventBus();
  const sidebar = new GameRightSidebar();
  (sidebar as any).requestUpdate = vi.fn();
  sidebar.game = fakeGame();
  sidebar.eventBus = bus;
  sidebar.init();
  return { sidebar, bus };
}

describe("GameRightSidebar - top-right control cluster", () => {
  afterEach(() => {
    document.body.classList.remove(HUD_HIDDEN_BODY_CLASS);
    vi.clearAllMocks();
  });

  test("renders speed, pause, and hide-interface controls; settings and exit are gone", () => {
    const { sidebar } = wiredSidebar();
    Object.defineProperty(document, "fullscreenEnabled", {
      value: true,
      configurable: true,
    });
    const rendered = JSON.stringify((sidebar as any).render());
    expect(rendered).toContain("game_controls.playback_speed");
    expect(rendered).toContain("game_controls.pause");
    expect(rendered).toContain("fullscreen.enter");
    expect(rendered).toContain("game_controls.hide_hud");
    expect(rendered).not.toContain("game_controls.settings");
    expect(rendered).not.toContain("game_controls.exit");
    expect((sidebar as any).onSettingsButtonClick).toBeUndefined();
    expect((sidebar as any).onExitButtonClick).toBeUndefined();
  });

  test("hide toggle collapses to a restore button and marks <body>", () => {
    const { sidebar } = wiredSidebar();
    (sidebar as any).onToggleHudClick();
    expect(document.body.classList.contains(HUD_HIDDEN_BODY_CLASS)).toBe(true);
    const collapsed = JSON.stringify((sidebar as any).render());
    expect(collapsed).toContain("game_controls.show_hud");
    expect(collapsed).not.toContain("game_controls.playback_speed");
    (sidebar as any).onToggleHudClick();
    expect(document.body.classList.contains(HUD_HIDDEN_BODY_CLASS)).toBe(false);
  });

  test("Escape (CloseViewEvent) restores a hidden interface", () => {
    const { sidebar, bus } = wiredSidebar();
    (sidebar as any).onToggleHudClick();
    expect(document.body.classList.contains(HUD_HIDDEN_BODY_CLASS)).toBe(true);
    bus.emit(new CloseViewEvent());
    expect(document.body.classList.contains(HUD_HIDDEN_BODY_CLASS)).toBe(false);
    expect((sidebar as any).hudHidden).toBe(false);
  });
});
