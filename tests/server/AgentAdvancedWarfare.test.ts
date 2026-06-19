import { describe, expect, it } from "vitest";
import { ConstructionExecution } from "../../src/core/execution/ConstructionExecution";
import { NukeExecution } from "../../src/core/execution/NukeExecution";
import { WarshipExecution } from "../../src/core/execution/WarshipExecution";
import { Game, PlayerInfo, PlayerType, UnitType } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import { LegalAction } from "../../src/server/agents/AgentTypes";
import { LegalActionBuilder } from "../../src/server/agents/LegalActionBuilder";
import { setup } from "../util/Setup";
import { constructionExecution, executeTicks } from "../util/utils";

// Directed proof that the in-house agent can EXECUTE advanced-warfare actions WITH
// REAL EFFECT once the prerequisite infrastructure exists. In real games the agent
// never built the Silo/Port/SAM, so these actions were never even offered. Here we
// SEED the infrastructure, confirm the LegalActionBuilder then OFFERS the action
// (offering proof), and execute it through the core to assert an observable effect.

async function agentVsEnemy() {
  const agent = new PlayerInfo("Agent", PlayerType.Human, "CLNT_AGENT", "P_AGENT");
  const enemy = new PlayerInfo("Enemy", PlayerType.Human, "CLNT_ENEMY", "P_ENEMY");
  const game = await setup(
    "plains",
    { infiniteGold: true, instantBuild: true, infiniteTroops: true },
    [agent, enemy],
  );
  const pAgent = game.player("P_AGENT");
  const pEnemy = game.player("P_ENEMY");
  // Each side holds a cluster so nuke/SAM effects are observable (not instant elimination).
  for (let dx = 0; dx < 6; dx += 1) {
    for (let dy = 0; dy < 6; dy += 1) {
      const at = game.ref(2 + dx, 2 + dy);
      if (game.isLand(at)) pAgent.conquer(at);
      const et = game.ref(12 + dx, 12 + dy);
      if (game.isLand(et)) pEnemy.conquer(et);
    }
  }
  while (game.inSpawnPhase()) {
    game.executeNextTick();
  }
  return { game, pAgent, pEnemy };
}

function agentLegalActions(game: Game): LegalAction[] {
  const observation = new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: "CLNT_AGENT",
    username: "Agent",
    profile: "aggressive",
    gameID: "ADV",
    turnNumber: 50,
    gameState: game,
  });
  return new LegalActionBuilder().build({ observation });
}

describe("agent advanced warfare (directed proof, executed-with-effect)", () => {
  it("NUKE: a built Missile Silo makes the nuke action OFFERED, and it detonates with effect", async () => {
    const { game, pAgent, pEnemy } = await agentVsEnemy();
    constructionExecution(game, pAgent, 2, 2, UnitType.MissileSilo);
    expect(pAgent.units(UnitType.MissileSilo)).toHaveLength(1);

    // OFFERING PROOF: the agent now sees a nuke option (kind "nuke") — it never did
    // in real games because no silo was ever built.
    const nukeActions = agentLegalActions(game).filter((a) => a.kind === "nuke");
    expect(nukeActions.length).toBeGreaterThan(0);

    // EFFECT PROOF: launch a real nuke (the same ConstructionExecution(AtomBomb) the
    // agent's nuke intent creates) at the enemy cluster -> detonation destroys tiles.
    const enemyTilesBefore = pEnemy.numTilesOwned();
    game.addExecution(
      new ConstructionExecution(pAgent, UnitType.AtomBomb, game.ref(14, 14)),
    );
    executeTicks(game, 12);
    expect(pEnemy.numTilesOwned()).toBeLessThan(enemyTilesBefore);
  });

  it("SAM: a SAM Launcher is OFFERED, and it intercepts an incoming nuke (protective effect)", async () => {
    // OFFERING PROOF: with gold, the agent can build a SAM Launcher.
    {
      const { game } = await agentVsEnemy();
      const sams = agentLegalActions(game).filter(
        (a) => a.kind === "build" && a.id.includes("build:SAM Launcher"),
      );
      expect(sams.length).toBeGreaterThan(0);
    }

    // BASELINE: an UNDEFENDED agent loses tiles to an incoming nuke.
    {
      const { game, pAgent, pEnemy } = await agentVsEnemy();
      constructionExecution(game, pEnemy, 14, 14, UnitType.MissileSilo);
      const before = pAgent.numTilesOwned();
      game.addExecution(
        new NukeExecution(UnitType.AtomBomb, pEnemy, game.ref(3, 3), null),
      );
      executeTicks(game, 18);
      expect(pAgent.numTilesOwned()).toBeLessThan(before);
    }

    // EFFECT PROOF: the SAME incoming nuke is intercepted by the agent's SAM -> tiles preserved.
    const { game, pAgent, pEnemy } = await agentVsEnemy();
    constructionExecution(game, pEnemy, 14, 14, UnitType.MissileSilo);
    constructionExecution(game, pAgent, 3, 3, UnitType.SAMLauncher);
    expect(pAgent.units(UnitType.SAMLauncher)).toHaveLength(1);
    const before = pAgent.numTilesOwned();
    game.addExecution(
      new NukeExecution(UnitType.AtomBomb, pEnemy, game.ref(3, 3), null),
    );
    executeTicks(game, 18);
    expect(pAgent.numTilesOwned()).toBe(before);
  });

  it("WARSHIP: a Port makes the warship build OFFERED, and the agent's warship captures an enemy trade ship", async () => {
    const coastX = 7;
    const agent = new PlayerInfo("Agent", PlayerType.Human, "CLNT_AGENT", "P_AGENT");
    const enemy = new PlayerInfo("Enemy", PlayerType.Human, "CLNT_ENEMY", "P_ENEMY");
    const game = await setup(
      "half_land_half_ocean",
      { infiniteGold: true, instantBuild: true, infiniteTroops: true },
      [agent, enemy],
    );
    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }
    const pAgent = game.player("P_AGENT");
    const pEnemy = game.player("P_ENEMY");

    // Agent owns coastal land + a Port (the warship prerequisite).
    pAgent.conquer(game.ref(coastX, 10));
    pAgent.buildUnit(UnitType.Port, game.ref(coastX, 10), {});
    expect(pAgent.units(UnitType.Port)).toHaveLength(1);

    // OFFERING PROOF: with a Port the agent is offered a warship build (kind "warship").
    const warshipActions = agentLegalActions(game).filter(
      (a) => a.kind === "warship",
    );
    expect(warshipActions.length).toBeGreaterThan(0);

    // EFFECT PROOF: the agent fields a warship -> it captures an enemy trade ship.
    const portTile = game.ref(coastX, 10);
    game.addExecution(
      new WarshipExecution(
        pAgent.buildUnit(UnitType.Warship, portTile, { patrolTile: portTile }),
      ),
    );
    const tradeShip = pEnemy.buildUnit(UnitType.TradeShip, game.ref(coastX + 1, 7), {
      targetUnit: pEnemy.buildUnit(UnitType.Port, game.ref(coastX, 10), {}),
    });
    expect(tradeShip.owner().id()).toBe(pEnemy.id());
    executeTicks(game, 12);
    expect(tradeShip.owner()).toBe(pAgent);
  });

  it("sanity: a direct NukeExecution detonates (mechanic baseline)", async () => {
    const { game, pAgent, pEnemy } = await agentVsEnemy();
    constructionExecution(game, pAgent, 2, 2, UnitType.MissileSilo);
    const before = pEnemy.numTilesOwned();
    game.addExecution(
      new NukeExecution(UnitType.AtomBomb, pAgent, game.ref(14, 14), null),
    );
    executeTicks(game, 12);
    expect(pEnemy.numTilesOwned()).toBeLessThan(before);
  });
});
