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
  renderDuration: vi.fn(),
  renderNumber: vi.fn((n: unknown) => String(n)),
  renderTroops: vi.fn((n: unknown) => String(n)),
}));

import { EventBus } from "../../../../src/core/EventBus";
import { PlayerType } from "../../../../src/core/game/Game";
import type {
  GameView,
  PlayerView,
} from "../../../../src/core/game/GameView";
import {
  ContextMenuEvent,
  MouseUpEvent,
} from "../../../../src/client/InputHandler";
import { PlayerPanel } from "../../../../src/client/graphics/layers/PlayerPanel";
import type { TransformHandler } from "../../../../src/client/graphics/TransformHandler";

function fakeOther(overrides: Record<string, unknown> = {}): PlayerView {
  return {
    id: () => 2,
    displayName: () => "Vendetta",
    type: () => PlayerType.Bot,
    isPlayer: () => true,
    isTraitor: () => false,
    cosmetics: {},
    gold: () => 759_000,
    troops: () => 310_000,
    allies: () => [],
    data: { betrayals: 0, embargoes: new Set() },
    profile: () => Promise.resolve(null),
    ...overrides,
  } as unknown as PlayerView;
}

function fakeGame(options: {
  owner?: unknown;
  myPlayer?: PlayerView | null;
  validCoord?: boolean;
}): GameView {
  const owner = options.owner ?? fakeOther();
  return {
    isValidCoord: () => options.validCoord !== false,
    ref: (x: number, y: number) => x * 1000 + y,
    owner: () => owner,
    myPlayer: () => options.myPlayer ?? null,
    ticks: () => 0,
  } as unknown as GameView;
}

const transformHandler = {
  screenToWorldCoordinates: (x: number, y: number) => ({ x, y }),
} as unknown as TransformHandler;

function wiredPanel(game: GameView): { panel: PlayerPanel; bus: EventBus } {
  const bus = new EventBus();
  const panel = new PlayerPanel();
  (panel as any).requestUpdate = vi.fn();
  panel.g = game;
  panel.transformHandler = transformHandler;
  panel.initEventBus(bus);
  panel.init();
  return { panel, bus };
}

describe("PlayerPanel - spectator right-click card", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("right-click on an owned tile opens the card without a viewer player", () => {
    const { panel, bus } = wiredPanel(fakeGame({ myPlayer: null }));
    expect(panel.isVisible).toBe(false);
    bus.emit(new ContextMenuEvent(10, 20));
    expect(panel.isVisible).toBe(true);
  });

  test("right-click on unowned land/ocean dismisses an open card", () => {
    const game = fakeGame({ myPlayer: null });
    const { panel, bus } = wiredPanel(game);
    bus.emit(new ContextMenuEvent(10, 20));
    expect(panel.isVisible).toBe(true);
    (game as any).owner = () => ({ isPlayer: () => false });
    bus.emit(new ContextMenuEvent(30, 40));
    expect(panel.isVisible).toBe(false);
  });

  test("clicking the map (mouse up) closes the card", () => {
    const { panel, bus } = wiredPanel(fakeGame({ myPlayer: null }));
    bus.emit(new ContextMenuEvent(10, 20));
    expect(panel.isVisible).toBe(true);
    bus.emit(new MouseUpEvent(5, 5));
    expect(panel.isVisible).toBe(false);
  });

  test("off-map right-clicks are ignored", () => {
    const { panel, bus } = wiredPanel(
      fakeGame({ myPlayer: null, validCoord: false }),
    );
    bus.emit(new ContextMenuEvent(10, 20));
    expect(panel.isVisible).toBe(false);
  });

  test("renders stats but no action buttons for a spectator", () => {
    const { panel, bus } = wiredPanel(fakeGame({ myPlayer: null }));
    bus.emit(new ContextMenuEvent(10, 20));
    const rendered = JSON.stringify((panel as any).render());
    for (const kept of [
      "player_panel.gold",
      "player_panel.troops",
      "player_panel.betrayals",
      "player_panel.trading",
      "player_panel.alliances",
    ]) {
      expect(rendered).toContain(kept);
    }
    for (const removed of [
      "player_panel.chat",
      "player_panel.emotes",
      "player_panel.target",
      "player_panel.start_trade",
      "player_panel.stop_trade",
      "player_panel.send_alliance",
      "player_panel.break_alliance",
      "player_panel.moderation",
    ]) {
      expect(rendered).not.toContain(removed);
    }
    // The action machinery is gone, not merely hidden.
    expect((panel as any).renderActions).toBeUndefined();
    expect((panel as any).handleChat).toBeUndefined();
    expect((panel as any).openSendGoldModal).toBeUndefined();
  });

  test("spectator trading row reflects the player's global embargo stance", () => {
    const trading = fakeOther();
    const stopped = fakeOther({
      data: { betrayals: 3, embargoes: new Set(["someone"]) },
    });
    const panel = new PlayerPanel();
    expect(JSON.stringify((panel as any).renderStats(trading, null))).toContain(
      "player_panel.active",
    );
    expect(JSON.stringify((panel as any).renderStats(stopped, null))).toContain(
      "player_panel.stopped",
    );
  });

  test("with a viewer player the trading row stays pairwise", () => {
    const my = {} as unknown as PlayerView;
    const other = fakeOther({
      hasEmbargoAgainst: (p: PlayerView) => p === my,
      data: { betrayals: 0, embargoes: new Set() },
    });
    const panel = new PlayerPanel();
    expect(JSON.stringify((panel as any).renderStats(other, my))).toContain(
      "player_panel.stopped",
    );
  });
});
