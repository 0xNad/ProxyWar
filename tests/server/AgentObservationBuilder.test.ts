import { describe, expect, it } from "vitest";
import { AttackExecution } from "../../src/core/execution/AttackExecution";
import { AllianceRequestExecution } from "../../src/core/execution/alliance/AllianceRequestExecution";
import { PlayerInfo, PlayerType } from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import { setup } from "../util/Setup";

async function threePlayerGame() {
  const agent = new PlayerInfo("Agent", PlayerType.Human, "CLNT_AGENT", "P_AGENT");
  const rivalA = new PlayerInfo("Rival A", PlayerType.Human, "CLNT_A", "P_A");
  const rivalB = new PlayerInfo("Rival B", PlayerType.Human, "CLNT_B", "P_B");
  const game = await setup(
    "plains",
    { nations: "disabled", infiniteGold: true, instantBuild: true, infiniteTroops: true },
    [agent, rivalA, rivalB],
  );
  game.player("P_AGENT").conquer(game.ref(0, 0));
  game.player("P_A").conquer(game.ref(0, 1));
  game.player("P_B").conquer(game.ref(0, 2));
  while (game.inSpawnPhase()) {
    game.executeNextTick();
  }
  return game;
}

function observe(game: Awaited<ReturnType<typeof threePlayerGame>>) {
  return new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: "CLNT_AGENT",
    username: "Agent",
    profile: "aggressive",
    gameID: "COALITION",
    turnNumber: 10,
    gameState: game,
  });
}

function ally(
  game: Awaited<ReturnType<typeof threePlayerGame>>,
  a: string,
  b: string,
): void {
  const pa = game.player(a);
  const pb = game.player(b);
  game.addExecution(new AllianceRequestExecution(pa, pb.id()));
  game.executeNextTick();
  game.addExecution(new AllianceRequestExecution(pb, pa.id()));
  game.executeNextTick();
}

describe("AgentObservationBuilder rival-rival coalition graph", () => {
  it("surfaces which rivals are allied with EACH OTHER (not just with the agent)", async () => {
    const game = await threePlayerGame();
    ally(game, "P_A", "P_B");
    expect(game.player("P_A").isAlliedWith(game.player("P_B"))).toBe(true);

    const observation = observe(game);
    const seenA = observation.visiblePlayers.find((p) => p.playerID === "P_A");
    const seenB = observation.visiblePlayers.find((p) => p.playerID === "P_B");

    // The agent (not part of the coalition) can SEE the rival-rival alliance.
    expect(seenA?.alliedWithVisibleIds).toEqual(["P_B"]);
    expect(seenB?.alliedWithVisibleIds).toEqual(["P_A"]);
    // And the agent's own alliance flag stays false for both — this is a coalition it is
    // NOT in (the 3v1-forming signal that was previously invisible).
    expect(seenA?.isAllied).toBe(false);
    expect(seenB?.isAllied).toBe(false);
  });

  it("omits alliedWithVisibleIds when a rival has no alliances", async () => {
    const game = await threePlayerGame();
    const observation = observe(game);
    for (const rival of observation.visiblePlayers) {
      expect(rival.alliedWithVisibleIds).toBeUndefined();
    }
  });

  it("excludes the agent's own alliance from a rival's coalition list", async () => {
    // The agent allies rivalA. That must show as isAllied on rivalA, NOT as a rival-rival
    // edge — alliedWithVisibleIds is strictly OTHER rivals (the agent is excluded).
    const game = await threePlayerGame();
    ally(game, "P_AGENT", "P_A");
    expect(game.player("P_AGENT").isAlliedWith(game.player("P_A"))).toBe(true);

    const observation = observe(game);
    const seenA = observation.visiblePlayers.find((p) => p.playerID === "P_A");
    expect(seenA?.isAllied).toBe(true);
    // rivalA is allied only with the agent, so it has no rival-rival edge.
    expect(seenA?.alliedWithVisibleIds).toBeUndefined();
  });

  it("marks a rival under siege when another rival has a live attack on it", async () => {
    const game = await threePlayerGame();
    const rivalA = game.player("P_A");
    const rivalB = game.player("P_B");
    rivalA.conquer(game.ref(1, 1));
    rivalA.conquer(game.ref(2, 1));

    game.addExecution(new AttackExecution(100, rivalB, rivalA.id()));
    game.executeNextTick();

    expect(rivalA.incomingAttacks().length).toBeGreaterThan(0);
    const seenA = observe(game).visiblePlayers.find(
      (player) => player.playerID === "P_A",
    );
    expect(seenA?.underSiege).toBe(true);
    expect(seenA?.incomingAttack).toBe(false);
  });
});

describe("AgentObservationBuilder quick-chat wire identities", () => {
  it("does not expose two quick-chat intents through one LegalAction.id", async () => {
    const game = await threePlayerGame();
    const quickChats = observe(game).nonCombat.quickChatOptions ?? [];
    const wireIDs = quickChats.map(
      (chat) => `quick_chat:${chat.recipientID}:${chat.quickChatKey}`,
    );

    expect(new Set(wireIDs).size).toBe(wireIDs.length);
    expect(quickChats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientID: "P_A",
          quickChatKey: "attack.focus",
          targetID: "P_B",
        }),
      ]),
    );
  });
});
