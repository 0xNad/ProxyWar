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
}));

vi.mock("../../../../src/client/Utils", () => ({
  translateText: vi.fn((key: string) => key),
}));

import { GameUpdateType } from "../../../../src/core/game/GameUpdates";
import type { GameView } from "../../../../src/core/game/GameView";
import { HeadsUpMessage } from "../../../../src/client/graphics/layers/HeadsUpMessage";

function spawnPhaseGame(): GameView {
  return {
    updatesSinceLastTick: () => ({
      [GameUpdateType.GamePaused]: [],
      [GameUpdateType.Win]: [],
    }),
    config: () => ({
      numSpawnPhaseTurns: () => 100,
      hasExtendedSpawnImmunity: () => false,
      isReplay: () => true,
      isRandomSpawn: () => false,
    }),
    ticks: () => 5,
    inSpawnPhase: () => true,
    isSpawnImmunityActive: () => false,
    isCatchingUp: () => false,
  } as unknown as GameView;
}

function withPath<T>(pathname: string, run: () => T): T {
  const original = window.location.pathname;
  Object.defineProperty(window, "location", {
    value: { ...window.location, pathname },
    writable: true,
    configurable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(window, "location", {
      value: { ...window.location, pathname: original },
      writable: true,
      configurable: true,
    });
  }
}

describe("HeadsUpMessage - spawn banner visibility", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Operator decision 2026-08-10: "Choose a starting location" is a player
  // instruction; spectators can't spawn, so it never shows on watch routes.
  it("hides the spawn-phase banner for replay spectators", () => {
    const hud = new HeadsUpMessage();
    hud.game = spawnPhaseGame();
    withPath("/ai-league-replay/league-coworld-x", () => hud.tick());
    expect((hud as any).isVisible).toBe(false);
  });

  it("still shows the spawn-phase banner in an ordinary game", () => {
    const hud = new HeadsUpMessage();
    hud.game = spawnPhaseGame();
    withPath("/", () => hud.tick());
    expect((hud as any).isVisible).toBe(true);
  });

  it("keeps the catching-up notice for spectators", () => {
    const hud = new HeadsUpMessage();
    const game = spawnPhaseGame();
    (game as any).config = () => ({
      numSpawnPhaseTurns: () => 100,
      hasExtendedSpawnImmunity: () => false,
      isReplay: () => false,
      isRandomSpawn: () => false,
    });
    (game as any).isCatchingUp = () => true;
    hud.game = game;
    withPath("/ai-league-replay/league-coworld-x", () => {
      for (let i = 0; i < 12; i++) hud.tick();
    });
    expect((hud as any).isVisible).toBe(true);
  });
});
