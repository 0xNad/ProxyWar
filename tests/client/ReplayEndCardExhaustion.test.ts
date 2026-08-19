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
const EXHAUSTION_FRAMES = 30;

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

  it("closes out a turn-limited match that never produced a winner", () => {
    const card = cardFor(gameAt(TOTAL_TURNS));
    for (let frame = 0; frame < EXHAUSTION_FRAMES; frame += 1) {
      expect(card.snapshot).toBeNull();
      card.tick();
    }
    expect(card.snapshot).not.toBeNull();
    expect(document.body.classList.contains("pw-endcard-open")).toBe(true);
  });

  it("does not fire while turns remain", () => {
    const card = cardFor(gameAt(TOTAL_TURNS - 1));
    for (let frame = 0; frame < EXHAUSTION_FRAMES * 3; frame += 1) card.tick();
    expect(card.snapshot).toBeNull();
  });

  it("resets its patience if the viewer rewinds before it fires", () => {
    const card = cardFor(gameAt(TOTAL_TURNS));
    for (let frame = 0; frame < EXHAUSTION_FRAMES - 1; frame += 1) card.tick();
    // Scrub back: the counter must start over, not resume one frame short.
    card.game = gameAt(TOTAL_TURNS - 500);
    card.tick();
    card.game = gameAt(TOTAL_TURNS);
    card.tick();
    expect(card.snapshot).toBeNull();
  });

  // The race the delay exists for: a real victory can land a tick after the
  // final turn is reached, and firing instantly would freeze "No winner" over
  // a match somebody actually won.
  it("lets a late-arriving real victory win the race", () => {
    const card = cardFor(gameAt(TOTAL_TURNS));
    for (let frame = 0; frame < EXHAUSTION_FRAMES - 2; frame += 1) card.tick();
    expect(card.snapshot).toBeNull();
    card.game = gameAt(TOTAL_TURNS, { winner: ["nation", "Auri"] });
    card.tick();
    expect(card.snapshot).not.toBeNull();
    expect(JSON.stringify(card.snapshot)).toContain("Auri");
  });

  it("never fires in live play, where the replay key is absent", () => {
    delete document.body.dataset.pwReplayTotalTurns;
    const card = cardFor(gameAt(TOTAL_TURNS));
    for (let frame = 0; frame < EXHAUSTION_FRAMES * 3; frame += 1) card.tick();
    expect(card.snapshot).toBeNull();
  });
});
