import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplayEndCard } from "../../src/client/graphics/layers/ReplayEndCard";
import { GameUpdateType } from "../../src/core/game/GameUpdates";
import type { GameView } from "../../src/core/game/GameView";

/**
 * END-01, observed live 2026-08-19: a league match ends on the commissioner's
 * TURN BUDGET, not an in-simulation victory, so `GameImpl.setWinner` is never
 * called and no `Win` update ever arrives. The transport froze at
 * "00:07 · 11500/11500", the board micro-animated on, and the end card never
 * came — the replay had no terminal event to end on.
 */
const TOTAL_TURNS = 11_500;

/**
 * THE NUMBER THAT MATTERS IS ONE.
 *
 * `Layer.tick()` is driven once per GAME TURN (`ClientGameRunner` calls
 * `renderer.tick()` inside the game-update handler; `TradeAttackLanes` carries
 * the same warning), and `game.ticks() >= totalTurns` first becomes true on the
 * final delivered update — after which `LocalServer.endGame()` clears the turn
 * interval and nothing ticks again. So production delivers EXACTLY ONE
 * exhausted tick, ever.
 *
 * An earlier version of this suite looped `card.tick()` thirty times to satisfy
 * a thirty-"frame" delay. It passed while the shipped card could never appear:
 * the loop was supplying ticks the client does not send, so the test measured
 * the harness rather than the client. Any test here that needs more than one
 * exhausted tick to make the card fire is testing a cadence that does not
 * exist — that is the regression this file exists to prevent.
 */
const EXHAUSTED_TICKS_IN_PRODUCTION = 1;

/** Far more ticks than production could ever deliver, for negative cases. */
const MANY_TICKS = 90;

function playerView(name: string, tiles: number) {
  return {
    isAlive: () => tiles > 0,
    numTilesOwned: () => tiles,
    troops: () => 1_000,
    gold: () => 1_000n,
    displayName: () => name,
    name: () => name,
    clientID: () => null,
    smallID: () => 1,
    id: () => name,
    isPlayer: () => true,
    team: () => null,
    info: () => ({ name }),
    territoryColor: () => ({ toHex: () => "#888888" }),
    borderColor: () => ({ toHex: () => "#666666" }),
  };
}

function gameAt(ticks: number, winUpdate?: unknown): GameView {
  return {
    ticks: () => ticks,
    playerViews: () => [playerView("Auri", 900), playerView("richard", 400)],
    numLandTiles: () => 2_000,
    numTilesWithFallout: () => 0,
    updatesSinceLastTick: () =>
      winUpdate === undefined
        ? null
        : ({ [GameUpdateType.Win]: [winUpdate] } as never),
    config: () => ({ theme: () => ({}), maxTroops: () => 100_000 }),
  } as unknown as GameView;
}

function cardFor(game: GameView) {
  const card = new ReplayEndCard() as unknown as {
    game: GameView | null;
    snapshot: unknown;
    tick(): void;
    sampleBoard(game: GameView): void;
  };
  card.game = game;
  // sampleBoard walks trend state this fixture does not model; the exhaustion
  // path under test runs after it, so stub it out rather than fake the world.
  card.sampleBoard = () => {};
  return card;
}

describe("ReplayEndCard end-of-replay exhaustion", () => {
  beforeEach(() => {
    document.body.classList.add("ai-league-replay-mode");
    document.body.dataset.pwReplayTotalTurns = String(TOTAL_TURNS);
  });
  afterEach(() => {
    document.body.classList.remove("ai-league-replay-mode", "pw-endcard-open");
    delete document.body.dataset.pwReplayTotalTurns;
  });

  /**
   * THE REGRESSION TEST. Give the card exactly what the client gives it — one
   * tick, at the final turn, and then silence, because `LocalServer` has ended
   * the game and will never tick again. If this needs a second tick to pass,
   * the shipped card is unreachable and the viewer sits on a frozen clock.
   */
  it("closes out a turn-limited match on the single tick production delivers", () => {
    const card = cardFor(gameAt(TOTAL_TURNS));
    expect(card.snapshot).toBeNull();
    for (let tick = 0; tick < EXHAUSTED_TICKS_IN_PRODUCTION; tick += 1) {
      card.tick();
    }
    expect(card.snapshot).not.toBeNull();
    expect(document.body.classList.contains("pw-endcard-open")).toBe(true);
  });

  it("does not fire while turns remain", () => {
    const card = cardFor(gameAt(TOTAL_TURNS - 1));
    for (let tick = 0; tick < MANY_TICKS; tick += 1) card.tick();
    expect(card.snapshot).toBeNull();
  });

  /**
   * A rewound clock is BELOW the final turn, so the exhaustion counter zeroes
   * and stays zeroed however long the viewer watches from there. This is the
   * property that keeps a scrubbed-back viewer from being handed a result card
   * mid-match.
   */
  it("stays closed for a viewer who has rewound into the match", () => {
    const card = cardFor(gameAt(TOTAL_TURNS - 500));
    for (let tick = 0; tick < MANY_TICKS; tick += 1) card.tick();
    expect(card.snapshot).toBeNull();
  });

  /**
   * The no-winner path must never pre-empt a real victory. In production the
   * two cannot race: a `Win` rides in the same update batch as the final tick,
   * installs a snapshot, and `tick()` returns early on an existing snapshot
   * before the exhaustion check runs. Pin the outcome — the winner is named.
   */
  it("announces a real winner rather than declaring no result", () => {
    const card = cardFor(gameAt(TOTAL_TURNS, { winner: ["nation", "Auri"] }));
    card.tick();
    expect(card.snapshot).not.toBeNull();
    expect(JSON.stringify(card.snapshot)).toContain("Auri");
  });

  it("never fires in live play, where the replay key is absent", () => {
    delete document.body.dataset.pwReplayTotalTurns;
    const card = cardFor(gameAt(TOTAL_TURNS));
    for (let tick = 0; tick < MANY_TICKS; tick += 1) card.tick();
    expect(card.snapshot).toBeNull();
  });
});
