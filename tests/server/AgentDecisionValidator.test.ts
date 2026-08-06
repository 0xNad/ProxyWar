import { Game, PlayerInfo, PlayerType } from "../../src/core/game/Game";
import { SpawnExecution } from "../../src/core/execution/SpawnExecution";
import {
  validateAgentDecision,
  validateSpawnDecision,
} from "../../src/server/agents/AgentDecisionValidator";
import { SpawnLegalityContext } from "../../src/server/agents/AgentSpawnLegality";
import {
  AgentDecision,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import { buildSpawnCandidates } from "../../src/server/agents/LegalActionBuilder";
import { setup } from "../util/Setup";

function holdAction(): LegalAction {
  return {
    id: "hold",
    kind: "hold",
    label: "Hold this turn",
    intent: null,
    risk: { level: "none", score: 0 },
  };
}

function attackAction(): LegalAction {
  return {
    id: "attack:42",
    kind: "attack",
    label: "Attack",
    intent: { type: "attack", targetID: null, troops: 1 },
    risk: { level: "low", score: 0.1 },
  };
}

describe("validateSpawnDecision", () => {
  function ctx(gameState: Game, minSpawnDistance = 8): SpawnLegalityContext {
    return { gameState, minSpawnDistance, rivalStakes: [] };
  }

  it("is identical to validateAgentDecision for an exact offered id, spawn or not", async () => {
    const game = await setup("half_land_half_ocean");
    const legalActions = [holdAction(), attackAction()];
    const decision: AgentDecision = { actionID: "attack:42", reason: null };

    const exact = validateAgentDecision(decision, legalActions);
    const viaSpawn = validateSpawnDecision(decision, legalActions, ctx(game));

    expect(viaSpawn).toEqual(exact);
    expect(viaSpawn.ok).toBe(true);
  });

  it("accepts a well-formed off-menu spawn:<tile> id for a currently-legal tile", async () => {
    const game = await setup("half_land_half_ocean");
    const candidate = buildSpawnCandidates(game.map(), { maxCandidates: 5 })[0];
    // The tile is NOT in the offered menu - only "hold" is offered.
    const legalActions = [
      holdAction(),
      {
        id: "spawn:999999999",
        kind: "spawn" as const,
        label: "Spawn at tile 999999999",
        intent: { type: "spawn" as const, tile: 999999999 },
        risk: { level: "medium" as const, score: 0.5 },
      },
    ];
    const decision: AgentDecision = {
      actionID: `spawn:${candidate.tile}`,
      reason: "I choose this coordinate",
    };

    const result = validateSpawnDecision(decision, legalActions, ctx(game));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.kind).toBe("spawn");
      expect(result.action.metadata?.tile).toBe(candidate.tile);
      expect(result.action.intent).toEqual({
        type: "spawn",
        tile: candidate.tile,
      });
    }
  });

  it("rejects a well-formed off-menu spawn:<tile> id for an illegal tile with a specific reason and hold fallback", async () => {
    const game = await setup("half_land_half_ocean");
    let waterTile: number | null = null;
    game.forEachTile((tile) => {
      if (waterTile === null && !game.isLand(tile)) {
        waterTile = tile;
      }
    });
    const hold = holdAction();
    const legalActions: LegalAction[] = [
      hold,
      {
        id: "spawn:1",
        kind: "spawn",
        label: "Spawn at tile 1",
        intent: { type: "spawn", tile: 1 },
        risk: { level: "medium", score: 0.5 },
      },
    ];
    const decision: AgentDecision = {
      actionID: `spawn:${waterTile}`,
      reason: "trying an illegal coordinate",
    };

    const result = validateSpawnDecision(decision, legalActions, ctx(game));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("tile is water");
      expect(result.fallback).toEqual(hold);
    }
  });

  it("never invents a phantom spawn kind when no spawn action is offered", async () => {
    const game = await setup("half_land_half_ocean");
    const candidate = buildSpawnCandidates(game.map(), { maxCandidates: 5 })[0];
    // Active phase: only non-spawn actions offered.
    const legalActions = [holdAction(), attackAction()];
    const decision: AgentDecision = {
      actionID: `spawn:${candidate.tile}`,
      reason: "spawn requested outside the spawn phase",
    };

    const result = validateSpawnDecision(decision, legalActions, ctx(game));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("unknown action id");
    }
  });

  it("falls through to validateAgentDecision's unchanged behavior for a malformed id", async () => {
    const game = await setup("half_land_half_ocean");
    const legalActions = [
      holdAction(),
      {
        id: "spawn:1",
        kind: "spawn" as const,
        label: "Spawn at tile 1",
        intent: { type: "spawn" as const, tile: 1 },
        risk: { level: "medium" as const, score: 0.5 },
      },
    ];
    const decision: AgentDecision = { actionID: "spawn:not-a-tile", reason: null };

    const exact = validateAgentDecision(decision, legalActions);
    const viaSpawn = validateSpawnDecision(decision, legalActions, ctx(game));

    expect(viaSpawn).toEqual(exact);
    expect(viaSpawn.ok).toBe(false);
  });

  it("rejects a conflicting off-menu request against another agent's already-spawned tile", async () => {
    const game = await setup("half_land_half_ocean");
    const seedInfo = new PlayerInfo("seed", PlayerType.Human, "seed_client", "seed_id");
    const seedTile = buildSpawnCandidates(game.map(), { maxCandidates: 5 })[0].tile;
    game.addExecution(new SpawnExecution("game_id", seedInfo, seedTile));
    while (game.inSpawnPhase() && game.playerByClientID("seed_client") === null) {
      game.executeNextTick();
    }
    if (game.inSpawnPhase()) {
      game.executeNextTick();
    }
    expect(game.hasOwner(seedTile)).toBe(true);

    const legalActions: LegalAction[] = [
      holdAction(),
      {
        id: "spawn:1",
        kind: "spawn",
        label: "Spawn at tile 1",
        intent: { type: "spawn", tile: 1 },
        risk: { level: "medium", score: 0.5 },
      },
    ];
    const decision: AgentDecision = {
      actionID: `spawn:${seedTile}`,
      reason: "requesting an already-occupied tile",
    };

    const result = validateSpawnDecision(decision, legalActions, ctx(game));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("tile is occupied");
    }
  });
});
