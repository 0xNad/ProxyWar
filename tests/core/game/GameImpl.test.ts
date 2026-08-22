import { GameID } from "../../../src/core/Schemas";
import { AttackExecution } from "../../../src/core/execution/AttackExecution";
import { SpawnExecution } from "../../../src/core/execution/SpawnExecution";
//import { TransportShipExecution } from "../../../src/core/execution/TransportShipExecution";
import { AllianceRequestExecution } from "../../../src/core/execution/alliance/AllianceRequestExecution";
import {
  Game,
  Player,
  PlayerInfo,
  PlayerType,
  UnitType,
} from "../../../src/core/game/Game";
import { TileRef } from "../../../src/core/game/GameMap";
import { setup } from "../../util/Setup";

const gameID: GameID = "game_id";
let game: Game;
let attacker: Player;
let defender: Player;
let defenderSpawn: TileRef;
let attackerSpawn: TileRef;

describe("GameImpl", () => {
  beforeEach(async () => {
    game = await setup("ocean_and_land", {
      infiniteGold: true,
      instantBuild: true,
      infiniteTroops: true,
    });
    const attackerInfo = new PlayerInfo(
      "attacker dude",
      PlayerType.Human,
      null,
      "attacker_id",
    );
    game.addPlayer(attackerInfo);
    const defenderInfo = new PlayerInfo(
      "defender dude",
      PlayerType.Human,
      null,
      "defender_id",
    );
    game.addPlayer(defenderInfo);

    defenderSpawn = game.ref(0, 15);
    attackerSpawn = game.ref(0, 14);

    game.addExecution(
      new SpawnExecution(
        gameID,
        game.player(attackerInfo.id).info(),
        attackerSpawn,
      ),
      new SpawnExecution(
        gameID,
        game.player(defenderInfo.id).info(),
        defenderSpawn,
      ),
    );

    while (game.inSpawnPhase()) {
      game.executeNextTick();
    }

    attacker = game.player(attackerInfo.id);
    defender = game.player(defenderInfo.id);
  });

  test("Don't become traitor when betraying inactive player", async () => {
    vi.spyOn(attacker, "canSendAllianceRequest").mockReturnValue(true);
    vi.spyOn(defender, "canSendAllianceRequest").mockReturnValue(true);
    game.addExecution(new AllianceRequestExecution(attacker, defender.id()));
    game.executeNextTick();

    game.addExecution(new AllianceRequestExecution(defender, attacker.id()));
    game.executeNextTick();

    expect(attacker.allianceWith(defender)).toBeTruthy();
    expect(defender.allianceWith(attacker)).toBeTruthy();

    //Defender is marked disconnected
    defender.markDisconnected(true);

    game.executeNextTick();
    game.executeNextTick();

    // STEP 1: First betray (manually break alliance)
    const alliance = attacker.allianceWith(defender);
    expect(alliance).toBeTruthy();
    attacker.breakAlliance(alliance!);

    // STEP 2: Then attack after betrayal
    game.addExecution(new AttackExecution(100, attacker, defender.id()));

    do {
      game.executeNextTick();
    } while (attacker.outgoingAttacks().length > 0);

    expect(attacker.isTraitor()).toBe(false);
    expect(attacker.allianceWith(defender)).toBeFalsy();
  });

  test("Do become traitor when betraying active player", async () => {
    vi.spyOn(attacker, "canSendAllianceRequest").mockReturnValue(true);
    vi.spyOn(defender, "canSendAllianceRequest").mockReturnValue(true);
    game.addExecution(new AllianceRequestExecution(attacker, defender.id()));
    game.executeNextTick();

    game.addExecution(new AllianceRequestExecution(defender, attacker.id()));
    game.executeNextTick();

    expect(attacker.allianceWith(defender)).toBeTruthy();
    expect(defender.allianceWith(attacker)).toBeTruthy();

    //Defender is NOT marked disconnected

    game.executeNextTick();
    game.executeNextTick();

    // First betray (manually break alliance)
    const alliance = attacker.allianceWith(defender);
    expect(alliance).toBeTruthy();
    attacker.breakAlliance(alliance!);

    game.executeNextTick();

    game.addExecution(new AttackExecution(100, attacker, defender.id()));

    do {
      game.executeNextTick();
    } while (attacker.outgoingAttacks().length > 0);

    expect(attacker.isTraitor()).toBe(true);
    expect(attacker.allianceWith(defender)).toBeFalsy();
  });

  test("Warship patrolTile rejects missing, malformed, inherited, and out-of-map values", () => {
    const lastTile = game.ref(game.width() - 1, game.height() - 1);
    const buildWith = (params: unknown) =>
      attacker.buildUnit(
        UnitType.Warship,
        attackerSpawn,
        params as { patrolTile: TileRef },
      );

    expect(() => {
      // @ts-expect-error Runtime callers can bypass the compile-time requirement.
      attacker.buildUnit(UnitType.Warship, attackerSpawn, {});
    }).toThrow(/Warship constructed with invalid patrolTile/);
    for (const patrolTile of [
      undefined,
      null,
      false,
      "0",
      0n,
      {},
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.5,
      -1,
      lastTile + 1,
    ]) {
      expect(() => buildWith({ patrolTile })).toThrow(
        /Warship constructed with invalid patrolTile/,
      );
    }
    expect(() =>
      buildWith(Object.create({ patrolTile: attackerSpawn })),
    ).toThrow(/Warship constructed with invalid patrolTile/);
    expect(attacker.units(UnitType.Warship)).toHaveLength(0);
  });

  test("Warship patrolTile accepts the first and last valid map references", () => {
    const lastTile = game.ref(game.width() - 1, game.height() - 1);
    const first = attacker.buildUnit(UnitType.Warship, attackerSpawn, {
      patrolTile: 0,
    });
    const last = attacker.buildUnit(UnitType.Warship, attackerSpawn, {
      patrolTile: lastTile,
    });

    expect(first.warshipState().patrolTile).toBe(0);
    expect(last.warshipState().patrolTile).toBe(lastTile);
  });

  test("invalid Warship patrolTile does not consume deterministic state", () => {
    const gameWithUnitIDs = game as Game & { nextUnitID(): number };
    const lastIssuedUnitID = gameWithUnitIDs.nextUnitID();
    const nextUnitID = vi.spyOn(gameWithUnitIDs, "nextUnitID");
    const unitBuild = vi.spyOn(game.stats(), "unitBuild");
    const addUpdate = vi.spyOn(game, "addUpdate");
    const goldBefore = attacker.gold();
    const troopsBefore = attacker.troops();
    const unitsBefore = attacker.units().length;

    expect(() =>
      attacker.buildUnit(UnitType.Warship, attackerSpawn, {
        patrolTile: game.width() * game.height(),
      }),
    ).toThrow(/Warship constructed with invalid patrolTile/);

    expect(nextUnitID).not.toHaveBeenCalled();
    expect(unitBuild).not.toHaveBeenCalled();
    expect(addUpdate).not.toHaveBeenCalled();
    expect(attacker.gold()).toBe(goldBefore);
    expect(attacker.troops()).toBe(troopsBefore);
    expect(attacker.units()).toHaveLength(unitsBefore);

    const valid = attacker.buildUnit(UnitType.Warship, attackerSpawn, {
      patrolTile: attackerSpawn,
    });
    expect(valid.id()).toBe(lastIssuedUnitID + 1);
    expect(nextUnitID).toHaveBeenCalledTimes(1);
  });

  test("Warship construction snapshots patrolTile before allocating state", () => {
    let patrolTileReads = 0;
    const changingParams = Object.defineProperty({}, "patrolTile", {
      enumerable: true,
      get: () => {
        patrolTileReads += 1;
        return patrolTileReads === 1
          ? attackerSpawn
          : game.width() * game.height();
      },
    });

    const warship = attacker.buildUnit(
      UnitType.Warship,
      attackerSpawn,
      changingParams as { patrolTile: TileRef },
    );

    expect(patrolTileReads).toBe(1);
    expect(warship.warshipState().patrolTile).toBe(attackerSpawn);
  });
});
