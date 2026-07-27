import { describe, expect, it, vi } from "vitest";
import {
  parseReplayRenderFastForwardUntilTurn,
  REPLAY_RENDER_FAST_FORWARD_PARAM,
  ReplayRenderFastForward,
} from "../../src/client/ReplayRenderFastForward";
import { GameUpdates } from "../../src/core/game/Game";
import {
  GameUpdateType,
  GameUpdateViewData,
} from "../../src/core/game/GameUpdates";

function emptyUpdates(): GameUpdates {
  return Object.fromEntries(
    Object.values(GameUpdateType)
      .filter((value): value is GameUpdateType => typeof value === "number")
      .map((type) => [type, []]),
  ) as unknown as GameUpdates;
}

function update(
  tick: number,
  packedTileUpdates: number[],
  options: { terminal?: boolean } = {},
): GameUpdateViewData {
  const gameUpdate = {
    tick,
    updates: emptyUpdates(),
    packedTileUpdates: Uint32Array.from(packedTileUpdates),
    playerNameViewData: {},
  };
  if (options.terminal === true) {
    gameUpdate.updates[GameUpdateType.Win].push({
      type: GameUpdateType.Win,
      winner: ["player", "terminal-test-player"],
      allPlayersStats: {},
    });
  }
  return gameUpdate;
}

describe("parseReplayRenderFastForwardUntilTurn", () => {
  it("accepts only a plain bounded positive integer", () => {
    expect(
      parseReplayRenderFastForwardUntilTurn(
        `?${REPLAY_RENDER_FAST_FORWARD_PARAM}=17350`,
      ),
    ).toBe(17350);
    expect(
      parseReplayRenderFastForwardUntilTurn(
        `?foo=1&${REPLAY_RENDER_FAST_FORWARD_PARAM}=50350&bar=2`,
      ),
    ).toBe(50350);
    for (const bad of [
      "",
      "?other=5",
      `?${REPLAY_RENDER_FAST_FORWARD_PARAM}=`,
      `?${REPLAY_RENDER_FAST_FORWARD_PARAM}=0`,
      `?${REPLAY_RENDER_FAST_FORWARD_PARAM}=-5`,
      `?${REPLAY_RENDER_FAST_FORWARD_PARAM}=007`,
      `?${REPLAY_RENDER_FAST_FORWARD_PARAM}=1.5`,
      `?${REPLAY_RENDER_FAST_FORWARD_PARAM}=1e6`,
      `?${REPLAY_RENDER_FAST_FORWARD_PARAM}=12345678`, // 8 digits, over grammar
      `?${REPLAY_RENDER_FAST_FORWARD_PARAM}=NaN`,
    ]) {
      expect(parseReplayRenderFastForwardUntilTurn(bad)).toBeNull();
    }
  });
});

describe("ReplayRenderFastForward", () => {
  it("buffers below the target and flushes one coalesced pass per window", () => {
    const applied: Array<{ tick: number; completedTurns: number }> = [];
    const fastForward = new ReplayRenderFastForward(
      100,
      {
        applyCoalesced: (coalesced, completedTurns) =>
          applied.push({ tick: coalesced.tick, completedTurns }),
      },
      3,
    );
    expect(fastForward.offer(update(1, [7, 70]))).toBe(true);
    expect(fastForward.offer(update(2, [7, 71]))).toBe(true);
    expect(applied).toEqual([]);
    // Third buffered turn completes the window: one coalesced apply.
    expect(fastForward.offer(update(3, [8, 80]))).toBe(true);
    expect(applied).toEqual([{ tick: 3, completedTurns: 3 }]);
    expect(fastForward.bufferedTurns()).toBe(0);
  });

  it("flushes the buffered prefix before handing back the boundary update", () => {
    const order: string[] = [];
    const fastForward = new ReplayRenderFastForward(
      50,
      {
        applyCoalesced: (coalesced, completedTurns) =>
          order.push(`coalesced:${coalesced.tick}:${completedTurns}`),
      },
      100,
    );
    expect(fastForward.offer(update(48, [1, 10]))).toBe(true);
    expect(fastForward.offer(update(49, [1, 11]))).toBe(true);
    // The park-boundary update is NOT consumed; the prefix flushes first so
    // presentation order is exact when the caller runs its normal pipeline.
    expect(fastForward.offer(update(50, [2, 20]))).toBe(false);
    expect(order).toEqual(["coalesced:49:2"]);
    // Later (capture window) updates flow straight through.
    expect(fastForward.offer(update(51, [2, 21]))).toBe(false);
    expect(order).toEqual(["coalesced:49:2"]);
  });

  it("flushes a Win update immediately below the target", () => {
    const seen: GameUpdateViewData[] = [];
    const fastForward = new ReplayRenderFastForward(
      1_000,
      { applyCoalesced: (coalesced) => seen.push(coalesced) },
      240,
    );
    expect(fastForward.offer(update(100, [1, 10]))).toBe(true);
    expect(fastForward.offer(update(101, [1, 11], { terminal: true }))).toBe(
      true,
    );
    expect(fastForward.bufferedTurns()).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].tick).toBe(101);
    expect(seen[0].updates[GameUpdateType.Win]).toHaveLength(1);
  });

  it("coalesces intermediate tile states to their final value", () => {
    const seen: GameUpdateViewData[] = [];
    const fastForward = new ReplayRenderFastForward(
      1_000,
      { applyCoalesced: (coalesced) => seen.push(coalesced) },
      2,
    );
    fastForward.offer(update(1, [42, 1]));
    fastForward.offer(update(2, [42, 2, 43, 9]));
    expect(seen).toHaveLength(1);
    const tiles = seen[0].packedTileUpdates;
    const asPairs = new Map<number, number>();
    for (let index = 0; index + 1 < tiles.length; index += 2) {
      asPairs.set(tiles[index], tiles[index + 1]);
    }
    // Tile 42 keeps only its FINAL state — the renderer never replays stale
    // intermediate paints during fast-forward.
    expect(asPairs.get(42)).toBe(2);
    expect(asPairs.get(43)).toBe(9);
  });

  it("ignores flush with an empty buffer and rejects invalid construction", () => {
    const applyCoalesced = vi.fn();
    const fastForward = new ReplayRenderFastForward(10, { applyCoalesced }, 4);
    fastForward.flush();
    expect(applyCoalesced).not.toHaveBeenCalled();
    expect(() => new ReplayRenderFastForward(0, { applyCoalesced })).toThrow();
    expect(
      () => new ReplayRenderFastForward(10, { applyCoalesced }, 0),
    ).toThrow();
  });
});
