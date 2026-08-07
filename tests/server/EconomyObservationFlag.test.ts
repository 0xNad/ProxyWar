import { afterEach, describe, expect, it } from "vitest";
import { CityExecution } from "../../src/core/execution/CityExecution";
import { FactoryExecution } from "../../src/core/execution/FactoryExecution";
import { RecomputeRailClusterExecution } from "../../src/core/execution/RecomputeRailClusterExecution";
import {
  Game,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../src/core/game/Game";
import { AgentObservationBuilder } from "../../src/server/agents/AgentObservationBuilder";
import type { AgentObservation } from "../../src/server/agents/AgentTypes";
import { setup } from "../util/Setup";

// Phase A flag gate (PROXYWAR_TUNE_ECONOMY_OBSERVATION, default OFF):
// with the flag off, observations AND tactical affordances must be
// byte-identical to shipped behavior — proven by JSON.stringify equality on a
// real game (template: tests/server/DiplomacyReservedSlots.test.ts). With the
// flag on, the ONLY changes are the new optional keys (economy block,
// economyNetwork affordance + its note line, per-rival unitCounts/isTraitor).

const FLAG = "PROXYWAR_TUNE_ECONOMY_OBSERVATION";

async function railObservationGame(): Promise<Game> {
  const infos = [
    new PlayerInfo("Agent", PlayerType.Human, "CLNT_AGENT", "P_AGENT"),
    new PlayerInfo("Rival A", PlayerType.Human, "CLNT_A", "P_A"),
    new PlayerInfo("Rival B", PlayerType.Human, "CLNT_B", "P_B"),
  ];
  const game = await setup("plains", {}, infos);
  game.player("P_AGENT").conquer(game.ref(10, 90));
  game.player("P_A").conquer(game.ref(13, 90));
  game.player("P_B").conquer(game.ref(16, 90));
  game.player("P_AGENT").addGold(10_000_000n);
  while (game.inSpawnPhase()) {
    game.executeNextTick();
  }
  game.addExecution(new RecomputeRailClusterExecution(game.railNetwork()));
  // A real rail economy: the agent's factory + own city, plus a rival city in
  // the same cluster, so the ON-arm block has clusters, counterparties, and a
  // bottleneck to report.
  const factory = game
    .player("P_AGENT")
    .buildUnit(UnitType.Factory, game.ref(10, 50), {});
  game.addExecution(new FactoryExecution(factory));
  for (let i = 0; i < 5; i++) {
    game.executeNextTick();
  }
  const ownCity = game
    .player("P_AGENT")
    .buildUnit(UnitType.City, game.ref(30, 50), {});
  const rivalCity = game
    .player("P_A")
    .buildUnit(UnitType.City, game.ref(50, 50), {});
  game.addExecution(new CityExecution(ownCity), new CityExecution(rivalCity));
  for (let i = 0; i < 5; i++) {
    game.executeNextTick();
  }
  return game;
}

function observe(game: Game): AgentObservation {
  return new AgentObservationBuilder().build({
    agentID: "agent-1",
    clientID: "CLNT_AGENT",
    username: "Agent",
    profile: "aggressive",
    gameID: "ECONOMY_FLAG",
    turnNumber: 42,
    gameState: game,
  });
}

const ECONOMY_NOTE_PREFIX = "economy_network flags an economy bottleneck";

/**
 * Removes exactly the flag-added keys from an ON-arm observation (parsed from
 * JSON, so key order is the serialized order). If the ON arm changed ANYTHING
 * else, the re-serialized result will not match the OFF arm byte-for-byte.
 */
function stripEconomyAdditions(parsed: {
  economy?: unknown;
  tacticalAffordances?: { economyNetwork?: unknown; notes?: string[] };
  visiblePlayers?: Array<{ unitCounts?: unknown; isTraitor?: unknown }>;
}): unknown {
  delete parsed.economy;
  if (parsed.tacticalAffordances !== undefined) {
    delete parsed.tacticalAffordances.economyNetwork;
    if (parsed.tacticalAffordances.notes !== undefined) {
      parsed.tacticalAffordances.notes =
        parsed.tacticalAffordances.notes.filter(
          (note) => !note.startsWith(ECONOMY_NOTE_PREFIX),
        );
    }
  }
  for (const player of parsed.visiblePlayers ?? []) {
    delete player.unitCounts;
    delete player.isTraitor;
  }
  return parsed;
}

describe("economy observation flag (PROXYWAR_TUNE_ECONOMY_OBSERVATION)", () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it("flag OFF: repeated builds are byte-identical and carry none of the new keys", async () => {
    delete process.env[FLAG];
    const game = await railObservationGame();
    const first = observe(game);
    const second = observe(game);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    expect(first.economy).toBeUndefined();
    expect(first.tacticalAffordances?.economyNetwork).toBeUndefined();
    expect(
      first.tacticalAffordances?.notes.some((note) =>
        note.startsWith(ECONOMY_NOTE_PREFIX),
      ),
    ).toBe(false);
    for (const player of first.visiblePlayers) {
      expect("unitCounts" in player).toBe(false);
      expect("isTraitor" in player).toBe(false);
    }
  });

  it("flag ON adds ONLY the new keys: stripping them restores the OFF bytes exactly", async () => {
    const game = await railObservationGame();

    delete process.env[FLAG];
    const offJson = JSON.stringify(observe(game));

    process.env[FLAG] = "1";
    const onJson = JSON.stringify(observe(game));
    expect(onJson).not.toBe(offJson);

    const stripped = stripEconomyAdditions(JSON.parse(onJson));
    expect(JSON.stringify(stripped)).toBe(offJson);
  });

  it("flag ON: economy block, economyNetwork affordance, and rival unitCounts/isTraitor are populated", async () => {
    process.env[FLAG] = "1";
    const game = await railObservationGame();
    const observation = observe(game);

    const economy = observation.economy;
    expect(economy).toBeDefined();
    expect(economy!.factoryCount).toBe(1);
    expect(economy!.factoryStatusCounts.operational).toBe(1);
    expect(economy!.clusterCount).toBeGreaterThanOrEqual(1);
    expect(economy!.eligibleDestinationCount).toBe(2);
    const counterparty = economy!.counterparties.find(
      (candidate) => candidate.playerID === "P_A",
    );
    expect(counterparty).toMatchObject({
      myEligibleDestinationsTheyOwn: 1,
      eligibleDestinationSharePct: 50,
    });
    expect(economy!.bottleneck.kind).toBe("foreign_dependency");

    const affordance = observation.tacticalAffordances?.economyNetwork;
    expect(affordance).toMatchObject({
      tacticID: "economy_network",
      recommended: true,
      factoryCount: 1,
      operationalFactoryCount: 1,
      bottleneckKind: "foreign_dependency",
      topCounterpartyID: "P_A",
      topCounterpartyDependencyPct: 50,
    });
    expect(affordance!.reasons.length).toBeGreaterThan(0);
    expect(
      observation.tacticalAffordances?.notes.some((note) =>
        note.startsWith(ECONOMY_NOTE_PREFIX),
      ),
    ).toBe(true);

    for (const player of observation.visiblePlayers) {
      expect(player.isTraitor).toBe(false);
      expect(Object.keys(player.unitCounts ?? {})).toEqual([
        UnitType.City,
        UnitType.Factory,
        UnitType.Port,
      ]);
    }
    const rivalA = observation.visiblePlayers.find(
      (player) => player.playerID === "P_A",
    );
    expect(rivalA?.unitCounts?.[UnitType.City]).toBe(1);
    expect(rivalA?.unitCounts?.[UnitType.Factory]).toBe(0);
  });
});
