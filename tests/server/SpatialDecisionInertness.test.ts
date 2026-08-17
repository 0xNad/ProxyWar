import { afterEach, describe, expect, it } from "vitest";

import { Game, PlayerInfo, PlayerType } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import { rankLegalActionsForPrompt } from "../../src/server/agents/AgentPlannerExecutor";
import type { AgentObservation } from "../../src/server/agents/AgentTypes";
import { LegalActionBuilder } from "../../src/server/agents/LegalActionBuilder";
import { setup } from "../util/Setup";

/**
 * Spatial observation must be DECISION-INERT for the deterministic engine.
 *
 * The existing suite pins that a flag-OFF observation and prompt are
 * byte-identical to shipped behaviour, and that the flag-ON observation gains the
 * right blocks. Nothing pinned the other half: with the flag ON, does the engine
 * DECIDE differently?
 *
 * It must not, and the reason matters for reading any spatial A/B. `grep` finds
 * zero spatial reads in `AgentPlannerExecutor`, `AgentStrategicSkills` and
 * `AgentPersonalityDiplomacyPolicy`: the scorer that ranks actions — the same
 * `rankLegalActionsForPrompt` that builds the LLM's shortlist — never sees
 * bearing, distanceClass, bordersWith, ownShape or the minimap. So:
 *
 *   - a local A/B run with deterministic or mock brains CANNOT show a spatial
 *     effect, by construction. Zero difference is the expected result, not
 *     evidence that spatial is useless;
 *   - the only consumer is the LLM-facing state (`buildState` in the public
 *     starter reads ownShape and validates the 24x12 minimap), so the benefit
 *     question needs a real model;
 *   - even with the flag ON, the ranked shortlist the model is nudged toward is
 *     spatial-blind, which bounds any achievable effect to the model overriding
 *     the engine's prior.
 *
 * If someone later wires spatial into the scorer, this test fails and tells them
 * the inertness assumption — which every flag-OFF safety argument leans on — has
 * changed. The arms are also asserted to genuinely DIFFER in the observation, so
 * the equality assertions can never pass vacuously.
 */

const SPATIAL_FLAG = "PROXYWAR_TUNE_SPATIAL_OBSERVATION";
const MINIMAP_FLAG = "PROXYWAR_TUNE_SPATIAL_MINIMAP";

const PLAYERS = [
  new PlayerInfo("Observer", PlayerType.Human, "CLNT_OBS", "P_OBS"),
  new PlayerInfo("Rival A", PlayerType.Human, "CLNT_A", "P_A"),
  new PlayerInfo("Rival B", PlayerType.Human, "CLNT_B", "P_B"),
  new PlayerInfo("Rival C", PlayerType.Human, "CLNT_C", "P_C"),
];

function conquerRectangle(
  game: Game,
  playerID: string,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): void {
  const player = game.player(playerID);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      player.conquer(game.ref(x, y));
    }
  }
}

/** Bordering territory for four seats, so the menu carries real diplomacy and
 * attack families rather than a hold-only stub. */
async function shapedGame(): Promise<Game> {
  const game = await setup(
    "plains",
    { nations: "disabled", instantBuild: true, infiniteGold: true },
    PLAYERS,
  );
  conquerRectangle(game, "P_OBS", 20, 20, 59, 59);
  conquerRectangle(game, "P_A", 60, 20, 79, 59);
  conquerRectangle(game, "P_B", 20, 60, 59, 79);
  conquerRectangle(game, "P_C", 80, 20, 99, 59);
  while (game.inSpawnPhase()) game.executeNextTick();
  for (let tick = 0; tick < 5; tick++) game.executeNextTick();
  return game;
}

interface Arm {
  observation: AgentObservation;
  actionIDs: string[];
  ranked: { id: string; totalScore: number; module: string }[];
  top: string | undefined;
}

function buildArm(game: Game, flags: Record<string, string>): Arm {
  delete process.env[SPATIAL_FLAG];
  delete process.env[MINIMAP_FLAG];
  for (const [key, value] of Object.entries(flags)) process.env[key] = value;

  const observation = new AgentObservationBuilder().build({
    agentID: "agent-P_OBS",
    clientID: "CLNT_OBS",
    username: "Observer",
    profile: "aggressive",
    gameID: "SPATIAL_INERTNESS",
    turnNumber: game.ticks(),
    gameState: game,
  });
  const legalActions = new LegalActionBuilder().build({ observation });
  const ranked = rankLegalActionsForPrompt({
    input: { observation, legalActions },
    profile: observation.profile,
    limit: 12,
  }).map((candidate) => ({
    id: candidate.id,
    totalScore: candidate.totalScore,
    module: candidate.module,
  }));
  return {
    observation,
    actionIDs: legalActions.map((action) => action.id),
    ranked,
    top: ranked[0]?.id,
  };
}

describe("spatial observation is decision-inert for the engine", () => {
  afterEach(() => {
    delete process.env[SPATIAL_FLAG];
    delete process.env[MINIMAP_FLAG];
  });

  it("changes the observation but not the menu, the ranking, or the pick", async () => {
    const game = await shapedGame();

    const off = buildArm(game, {});
    const spatial = buildArm(game, { [SPATIAL_FLAG]: "1" });
    const minimap = buildArm(game, {
      [SPATIAL_FLAG]: "1",
      [MINIMAP_FLAG]: "1",
    });

    // The arms must genuinely differ, or every equality below is vacuous.
    expect(off.observation.spatial).toBeUndefined();
    expect(spatial.observation.spatial).toBeDefined();
    expect(spatial.observation.spatial?.minimap).toBeUndefined();
    expect(minimap.observation.spatial?.minimap).toBeDefined();
    expect(JSON.stringify(minimap.observation).length).toBeGreaterThan(
      JSON.stringify(off.observation).length,
    );

    // Menu: spatial adds observation fields, never actions.
    expect(spatial.actionIDs).toEqual(off.actionIDs);
    expect(minimap.actionIDs).toEqual(off.actionIDs);
    expect(off.actionIDs.length).toBeGreaterThan(1);

    // Ranking: the shared scorer is spatial-blind, so order AND scores match.
    expect(spatial.ranked).toEqual(off.ranked);
    expect(minimap.ranked).toEqual(off.ranked);
    expect(off.ranked.length).toBeGreaterThan(1);

    // And therefore the engine's pick is unchanged.
    expect(spatial.top).toBe(off.top);
    expect(minimap.top).toBe(off.top);
    expect(off.top).toBeDefined();
  }, 120_000);

  it("keeps the ranking stable across repeated builds on the same board", async () => {
    // Guards the comparison itself: if ranking were nondeterministic, the
    // equality assertions above would be meaningless.
    const game = await shapedGame();
    const first = buildArm(game, {});
    const second = buildArm(game, {});
    expect(second.ranked).toEqual(first.ranked);
    expect(second.actionIDs).toEqual(first.actionIDs);
  }, 120_000);
});
