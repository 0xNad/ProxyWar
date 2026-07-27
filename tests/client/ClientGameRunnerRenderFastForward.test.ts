import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientGameRunner } from "../../src/client/ClientGameRunner";
import { TogglePauseIntentEvent } from "../../src/client/InputHandler";
import { REPLAY_RENDER_FAST_FORWARD_PARAM } from "../../src/client/ReplayRenderFastForward";
import { ReplayPresentationCadenceEvent } from "../../src/client/graphics/ReplayPresentationSmoothing";
import type { GameUpdates } from "../../src/core/game/Game";
import { GameUpdateType } from "../../src/core/game/GameUpdates";

function emptyUpdates(): GameUpdates {
  return Object.fromEntries(
    Object.values(GameUpdateType)
      .filter((value) => typeof value === "number")
      .map((type) => [type, []]),
  ) as unknown as GameUpdates;
}

function gameUpdate(tick: number, options: { terminal?: boolean } = {}) {
  const update = {
    tick,
    updates: emptyUpdates(),
    packedTileUpdates: new Uint32Array(),
    playerNameViewData: {},
    tickExecutionDuration: 1,
  };
  if (options.terminal === true) {
    update.updates[GameUpdateType.Win].push({
      type: GameUpdateType.Win,
      winner: ["player", "must-not-leak"],
      allPlayersStats: {},
    });
  }
  return update;
}

interface Harness {
  updateCallback: (update: never) => void;
  eventBus: { emit: ReturnType<typeof vi.fn> };
  renderer: {
    initialize: ReturnType<typeof vi.fn>;
    tick: ReturnType<typeof vi.fn>;
  };
  transport: { turnComplete: ReturnType<typeof vi.fn> };
  gameView: { update: ReturnType<typeof vi.fn> };
}

function mountRunner(lobby: Record<string, unknown>): Harness {
  let updateCallback: (update: never) => void = () => {
    throw new Error("worker callback was not registered");
  };
  const eventBus = { on: vi.fn(), emit: vi.fn() };
  const renderer = {
    initialize: vi.fn(),
    tick: vi.fn(),
    transformHandler: { centerAll: vi.fn() },
  };
  const input = { initialize: vi.fn() };
  const transport = {
    updateCallback: vi.fn(),
    rejoinGame: vi.fn(),
    leaveGame: vi.fn(),
    turnComplete: vi.fn(),
    turnsComplete: vi.fn(),
  };
  const worker = {
    start: vi.fn((callback: (update: never) => void) => {
      updateCallback = callback;
    }),
    cleanup: vi.fn(),
  };
  const gameView = {
    update: vi.fn(),
    inSpawnPhase: () => false,
    players: () => [],
  };
  const runner = new ClientGameRunner(
    lobby as never,
    undefined,
    eventBus as never,
    renderer as never,
    input as never,
    transport as never,
    worker as never,
    gameView as never,
  );
  runner.start();
  return {
    updateCallback: (update) => updateCallback(update),
    eventBus,
    renderer,
    transport,
    gameView,
  };
}

describe("ClientGameRunner render fast-forward gating", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    history.replaceState(null, "", "/");
  });

  it("coalesces presentation below the target on a plain replay, then resumes the full pipeline", () => {
    history.replaceState(
      null,
      "",
      `/ai-league-replay/league-ffwd?${REPLAY_RENDER_FAST_FORWARD_PARAM}=1000`,
    );
    const harness = mountRunner({
      gameID: "FFWD0001",
      gameStartInfo: { gameID: "FFWD0001" },
      gameRecord: {},
    });

    // Below the target: consumed by the fast-forward lane. State application
    // and turn accounting stay exact; the renderer is NOT invoked per turn.
    for (let tick = 1; tick <= 5; tick++) {
      harness.updateCallback(gameUpdate(tick) as never);
    }
    expect(harness.transport.turnComplete).toHaveBeenCalledTimes(5);
    expect(harness.renderer.tick).not.toHaveBeenCalled();
    expect(harness.gameView.update).not.toHaveBeenCalled();

    // The boundary update flushes the coalesced prefix (one render pass) and
    // then runs the ordinary pipeline for itself (a second render pass).
    harness.updateCallback(gameUpdate(1000) as never);
    expect(harness.gameView.update).toHaveBeenCalledTimes(2);
    expect(harness.renderer.tick).toHaveBeenCalledTimes(2);
    expect(harness.transport.turnComplete).toHaveBeenCalledTimes(6);
    // The coalesced flush carries the buffered span's final tick.
    const flushed = harness.gameView.update.mock.calls[0][0] as {
      tick: number;
    };
    expect(flushed.tick).toBe(5);
  });

  it("emits a spoiler-neutral terminal frame when Win occurs below the target", () => {
    history.replaceState(
      null,
      "",
      `/ai-league-replay/league-terminal?${REPLAY_RENDER_FAST_FORWARD_PARAM}=100000`,
    );
    const terminalFrames: Array<Record<string, unknown>> = [];
    document.addEventListener("ai-league-replay-frame", (event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (detail.terminal === true) terminalFrames.push(detail);
    });
    const harness = mountRunner({
      gameID: "TERM0001",
      gameStartInfo: { gameID: "TERM0001" },
      gameRecord: {},
    });

    harness.updateCallback(gameUpdate(32250) as never);
    harness.updateCallback(gameUpdate(32251, { terminal: true }) as never);

    expect(terminalFrames).toHaveLength(1);
    expect(terminalFrames[0]).toMatchObject({
      tick: 32251,
      terminal: true,
    });
    expect(terminalFrames[0]).not.toHaveProperty("winner");
    expect(JSON.stringify(terminalFrames[0])).not.toContain("must-not-leak");
    expect(harness.gameView.update).toHaveBeenCalledTimes(1);
    expect(harness.renderer.tick).toHaveBeenCalledTimes(1);
  });

  it("ignores the parameter entirely without a plain gameRecord (premiere pages unaffected)", () => {
    history.replaceState(
      null,
      "",
      `/premiere/prem_0123456789abcdef?${REPLAY_RENDER_FAST_FORWARD_PARAM}=1000`,
    );
    const harness = mountRunner({
      gameID: "PREM0001",
      gameStartInfo: { gameID: "PREM0001" },
      progressiveReplay: { playbackRate: 1 },
      gameRecord: undefined,
    });
    harness.updateCallback(gameUpdate(3) as never);
    // Full pipeline ran: the sealed premiere presentation is untouched by the
    // pacing parameter (it can only ever exist on plain-record replays).
    expect(harness.gameView.update).toHaveBeenCalledTimes(1);
    expect(harness.renderer.tick).toHaveBeenCalledTimes(1);
  });

  it.each([
    [2, 50],
    [4, 25],
  ] as const)(
    "publishes the committed %ix Premiere cadence to initialized renderer layers",
    (playbackRate, expectedIntervalMs) => {
      const harness = mountRunner({
        gameID: `PREM000${playbackRate}`,
        gameStartInfo: { gameID: `PREM000${playbackRate}` },
        progressiveReplay: { playbackRate },
      });
      const cadenceEvent = harness.eventBus.emit.mock.calls
        .map(([event]) => event)
        .find((event) => event instanceof ReplayPresentationCadenceEvent);

      expect(cadenceEvent).toBeInstanceOf(ReplayPresentationCadenceEvent);
      expect(cadenceEvent?.presentationIntervalMs).toBe(expectedIntervalMs);
      expect(
        harness.renderer.initialize.mock.invocationCallOrder[0],
      ).toBeLessThan(harness.eventBus.emit.mock.invocationCallOrder[0]);
    },
  );

  it("runs the ordinary per-turn pipeline when the parameter is absent", () => {
    history.replaceState(null, "", "/ai-league-replay/league-normal");
    const frameDetails: Array<Record<string, unknown>> = [];
    document.addEventListener(
      "ai-league-replay-frame",
      (event) =>
        frameDetails.push(
          (event as CustomEvent<Record<string, unknown>>).detail,
        ),
      { once: true },
    );
    const harness = mountRunner({
      gameID: "PLAIN001",
      gameStartInfo: { gameID: "PLAIN001" },
      gameRecord: {},
    });
    harness.updateCallback(gameUpdate(1) as never);
    harness.updateCallback(gameUpdate(2) as never);
    expect(harness.gameView.update).toHaveBeenCalledTimes(2);
    expect(harness.renderer.tick).toHaveBeenCalledTimes(2);
    expect(frameDetails[0]).toMatchObject({ tick: 1, terminal: false });
  });

  it.each([55, 605])(
    "uses the carried Clip Preview target %i after the replay query has been rewritten",
    (target) => {
      // Main deliberately rewrites the address after joining. The validated
      // LobbyConfig target must remain authoritative when no query survives.
      history.replaceState(null, "", "/ai-league-replay/league-preview");
      const frameDetails: Array<Record<string, unknown>> = [];
      const onFrame = (event: Event) => {
        frameDetails.push(
          (event as CustomEvent<Record<string, unknown>>).detail,
        );
      };
      document.addEventListener("ai-league-replay-frame", onFrame);
      try {
        const harness = mountRunner({
          gameID: "PREVIEW1",
          gameStartInfo: { gameID: "PREVIEW1" },
          gameRecord: {},
          replayClipPreviewTarget: target,
        });
        expect(
          harness.eventBus.emit.mock.calls.filter(
            ([event]) => event instanceof TogglePauseIntentEvent,
          ),
        ).toHaveLength(1);

        for (let tick = 1; tick <= target; tick += 1) {
          harness.updateCallback(gameUpdate(tick) as never);
        }

        expect(harness.transport.turnComplete).toHaveBeenCalledTimes(target);
        expect(frameDetails.at(-1)).toMatchObject({
          tick: target,
          terminal: false,
        });
        expect(frameDetails.some((detail) => detail.tick === target + 1)).toBe(
          false,
        );
        expect(
          (harness.gameView.update.mock.calls.at(-1)?.[0] as { tick: number })
            .tick,
        ).toBe(target);
        if (target > 240) {
          expect(harness.renderer.tick.mock.calls.length).toBeLessThan(target);
        }
      } finally {
        document.removeEventListener("ai-league-replay-frame", onFrame);
      }
    },
  );
});
