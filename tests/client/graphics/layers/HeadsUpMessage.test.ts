/**
 * P0 fix (2026-08-03, deploy 3.9, item 3a): combat toasts ("show-message"
 * window events fired for build/attack/etc.) kept firing and stacking up
 * over the win banner once a match ended. The toast (`z-[800]`,
 * `top-6 left-1/2`) and WinModal's centered banner (`z-[10010]`,
 * `top-1/2 left-1/2`) never overlap on screen, so a toast stayed fully
 * VISIBLE alongside the banner regardless of z-index stacking — a
 * "frozen HUD" over a finished match rather than a clean end state.
 */
import { GameUpdateType } from "../../../../src/core/game/GameUpdates";

interface MinimalGame {
  updatesSinceLastTick: () => Record<number, unknown[]>;
  config: () => {
    numSpawnPhaseTurns: () => number;
    hasExtendedSpawnImmunity: () => boolean;
    isReplay: () => boolean;
    isRandomSpawn: () => boolean;
  };
  ticks: () => number;
  inSpawnPhase: () => boolean;
  isSpawnImmunityActive: () => boolean;
  isCatchingUp: () => boolean;
}

interface HeadsUpMessageTestHooks {
  game: unknown;
  tick: () => void;
  init: () => void;
  connectedCallback: () => void;
  disconnectedCallback: () => void;
  toastMessage: string | null;
}

function baseGame(overrides: Partial<MinimalGame> = {}): MinimalGame {
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
    ticks: () => 500,
    inSpawnPhase: () => false,
    isSpawnImmunityActive: () => false,
    isCatchingUp: () => false,
    ...overrides,
  };
}

async function newMessage(): Promise<HeadsUpMessageTestHooks> {
  const { HeadsUpMessage } = await import(
    "../../../../src/client/graphics/layers/HeadsUpMessage"
  );
  const message = new HeadsUpMessage() as unknown as HeadsUpMessageTestHooks;
  message.game = baseGame();
  message.connectedCallback();
  message.init();
  return message;
}

describe("HeadsUpMessage match-end toast suppression", () => {
  let message: HeadsUpMessageTestHooks | null = null;

  afterEach(() => {
    message?.disconnectedCallback();
    message = null;
  });

  it("clears an already-showing toast the instant the match ends", async () => {
    message = await newMessage();
    // Simulate an in-flight combat toast (as "show-message" would set it).
    window.dispatchEvent(
      new CustomEvent("show-message", {
        detail: { message: "Attack launched", duration: 2000, color: "green" },
      }),
    );
    expect(message.toastMessage).toBe("Attack launched");

    message.game = baseGame({
      updatesSinceLastTick: () => ({
        [GameUpdateType.GamePaused]: [],
        [GameUpdateType.Win]: [{ winner: ["player", "WINNER_CLIENT"] }],
      }),
    });
    message.tick();

    expect(message.toastMessage).toBeNull();
  });

  it("suppresses any new toast fired after the match has ended", async () => {
    message = await newMessage();
    message.game = baseGame({
      updatesSinceLastTick: () => ({
        [GameUpdateType.GamePaused]: [],
        [GameUpdateType.Win]: [{ winner: ["player", "WINNER_CLIENT"] }],
      }),
    });
    message.tick();
    expect(message.toastMessage).toBeNull();

    window.dispatchEvent(
      new CustomEvent("show-message", {
        detail: {
          message: "A late-arriving combat message",
          duration: 2000,
          color: "green",
        },
      }),
    );

    expect(message.toastMessage).toBeNull();
  });

  it("still shows toasts normally before the match has ended", async () => {
    message = await newMessage();
    message.tick();

    window.dispatchEvent(
      new CustomEvent("show-message", {
        detail: { message: "Attack launched", duration: 2000, color: "green" },
      }),
    );

    expect(message.toastMessage).toBe("Attack launched");
  });
});
