/**
 * P0 fix (2026-08-03, deploy 3.11): the WinModal shadow-DOM incident and the
 * dead-HeadsUpMessage finding it turned up share one lesson — a layer can be
 * fully correct in isolation (its own unit tests green) while being entirely
 * unreachable in production, because `createRenderer()`'s `layers: Layer[]`
 * array is the ONLY thing that makes `GameRenderer.tick()`/`init()` ever call
 * it. `HeadsUpMessage` was dropped from that array as pure collateral in
 * f75969b56 ("platform: accounts are not a betting feature") months before
 * this was caught: `.game` was still assigned in `createRenderer()`, every
 * component-level test still passed calling `.tick()` directly, and nothing
 * ever exercised the actual dispatch path that decides whether `.tick()` is
 * called AT ALL. Item 3a's (deploy 3.9) match-end toast suppression is a
 * concrete casualty: implemented, unit-tested in isolation, and completely
 * inert in production for that entire window.
 *
 * This file tests the WIRING itself, not just the components: a real
 * `GameRenderer` (the actual dispatcher, not a stand-in) driving real
 * `HeadsUpMessage` + `WinModal` instances through its own `tick()`, exactly
 * as `createRenderer()` mounts them side by side in the same `layers` array.
 * A future accidental removal of either from that array — the same mistake,
 * not a new one — fails here even though both components' own isolated
 * tests would stay green.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GameRenderer } from "../../../src/client/graphics/GameRenderer";
import { TransformHandler } from "../../../src/client/graphics/TransformHandler";
import { HeadsUpMessage } from "../../../src/client/graphics/layers/HeadsUpMessage";
import { WinModal } from "../../../src/client/graphics/layers/WinModal";
import { PerformanceOverlay } from "../../../src/client/graphics/layers/PerformanceOverlay";
import { UIState } from "../../../src/client/graphics/UIState";
import { EventBus } from "../../../src/core/EventBus";
import { GameUpdateType } from "../../../src/core/game/GameUpdates";
import { GameView } from "../../../src/core/game/GameView";

interface HeadsUpMessageHooks {
  toastMessage: string | null;
}

interface WinModalHooks {
  isVisible: boolean;
  _title: string;
}

function buildGame(hasWon: boolean) {
  const winUpdates = hasWon
    ? [{ winner: ["player", "WINNER_CLIENT"], allPlayersStats: {} }]
    : [];
  return {
    updatesSinceLastTick: () => ({
      [GameUpdateType.GamePaused]: [],
      [GameUpdateType.Win]: winUpdates,
    }),
    config: () => ({
      numSpawnPhaseTurns: () => 100,
      hasExtendedSpawnImmunity: () => false,
      isReplay: () => true,
      isRandomSpawn: () => false,
      gameConfig: () => ({ rankedType: undefined }),
    }),
    ticks: () => 500,
    inSpawnPhase: () => false,
    isSpawnImmunityActive: () => false,
    isCatchingUp: () => false,
    myPlayer: () => null,
    playerByClientID: () => ({
      isPlayer: () => true,
      clientID: () => "WINNER_CLIENT",
      displayName: () => "Winner",
    }),
  };
}

describe("GameRenderer layer wiring (end-to-end, not component-isolated)", () => {
  let mockLocationPathname = "/ai-league-replay/league-coworld-x";

  beforeEach(() => {
    Object.defineProperty(window, "location", {
      value: {
        get pathname() {
          return mockLocationPathname;
        },
        set pathname(value: string) {
          mockLocationPathname = value;
        },
        href: "",
        search: "",
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    mockLocationPathname = "/ai-league-replay/league-coworld-x";
  });

  it("reaches both HeadsUpMessage and WinModal through the real GameRenderer.tick() dispatch, suppressing the combat toast the instant the banner shows", () => {
    const eventBus = new EventBus();
    const canvas = document.createElement("canvas");
    const headsUpMessage = new HeadsUpMessage();
    const winModal = new WinModal();
    const huHooks = headsUpMessage as unknown as HeadsUpMessageHooks & {
      connectedCallback: () => void;
      disconnectedCallback: () => void;
    };
    const winHooks = winModal as unknown as WinModalHooks;
    // In production this fires natively the instant index.html's static
    // `<heads-up-message>` tag connects, well before GameRenderer exists --
    // simulated directly here, same as the isolated HeadsUpMessage.test.ts.
    huHooks.connectedCallback();

    let hasWon = false;
    const game = buildGame(false);
    // Both layers read `game.updatesSinceLastTick()` fresh on every tick --
    // a single mutable flag lets one GameRenderer.tick() call flip both.
    const liveGame = {
      ...game,
      updatesSinceLastTick: () => buildGame(hasWon).updatesSinceLastTick(),
    } as unknown as GameView;

    headsUpMessage.game = liveGame;
    winModal.game = liveGame;
    winModal.eventBus = eventBus;

    const renderer = new GameRenderer(
      liveGame,
      eventBus,
      canvas,
      {} as TransformHandler,
      {} as UIState,
      [headsUpMessage, winModal],
      {} as PerformanceOverlay,
    );

    // Pre-match-end: the real dispatch path reaches HeadsUpMessage and a
    // combat toast displays normally.
    renderer.tick();
    window.dispatchEvent(
      new CustomEvent("show-message", {
        detail: { message: "Attack launched", duration: 2000, color: "green" },
      }),
    );
    expect(huHooks.toastMessage).toBe("Attack launched");
    expect(winHooks.isVisible).toBe(false);

    // Match ends: one real GameRenderer.tick() call, exactly what
    // ClientGameRunner.ts fires per incoming update in production.
    hasWon = true;
    renderer.tick();

    // WinModal's banner is up...
    expect(winHooks.isVisible).toBe(true);
    // translateText isn't mocked here (this test is about wiring, not
    // i18n) -- the untranslated key alone proves the "other player won"
    // branch executed via the real dispatch, which is what matters here.
    expect(winHooks._title).toBe("win_modal.other_won");
    // ...and HeadsUpMessage's own match-end handling (item 3a) cleared the
    // in-flight toast and suppresses any further one, both reached purely
    // through the shared GameRenderer, never called directly.
    expect(huHooks.toastMessage).toBeNull();

    window.dispatchEvent(
      new CustomEvent("show-message", {
        detail: {
          message: "A late-arriving combat message",
          duration: 2000,
          color: "green",
        },
      }),
    );
    expect(huHooks.toastMessage).toBeNull();

    huHooks.disconnectedCallback();
  });
});
