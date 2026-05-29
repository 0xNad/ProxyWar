import { describe, expect, it } from "vitest";
import { Game, Player, UnitType } from "../../src/core/game/Game";
import { auditDecisionEffect } from "../../src/server/agents/AgentActionAuditor";
import { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";

describe("AgentActionAuditor", () => {
  it("confirms accepted build effects when a structure appears", () => {
    const before = fakeGame({
      actor: fakePlayer({
        unitCounts: { [UnitType.DefensePost]: 0 },
      }),
    });
    const after = fakeGame({
      actor: fakePlayer({
        unitCounts: { [UnitType.DefensePost]: 1 },
        units: [{ type: UnitType.DefensePost, tile: 42 }],
      }),
    });

    const audit = auditDecisionEffect(
      baseRecord({
        chosenActionKind: "build",
        chosenActionID: "build:Defense Post:42",
        intent: {
          type: "build_unit",
          unit: UnitType.DefensePost,
          tile: 42,
        },
        chosenActionMetadata: { buildTile: 42 },
      }),
      before,
      after,
    );

    expect(audit.auditStatus).toBe("confirmed");
    expect(audit.auditReason).toContain("build_unit accepted");
    expect(audit.before?.unitCounts[UnitType.DefensePost]).toBe(0);
    expect(audit.after?.unitCounts[UnitType.DefensePost]).toBe(1);
  });

  it("confirms accepted embargo effects when the outgoing embargo appears", () => {
    const before = fakeGame({
      actor: fakePlayer({ embargoTargetIDs: [] }),
      target: fakePlayer({ playerID: "TARGET01", clientID: "TARGETCLIENT" }),
    });
    const after = fakeGame({
      actor: fakePlayer({ embargoTargetIDs: ["TARGET01"] }),
      target: fakePlayer({ playerID: "TARGET01", clientID: "TARGETCLIENT" }),
    });

    const audit = auditDecisionEffect(
      baseRecord({
        chosenActionKind: "embargo",
        chosenActionID: "embargo:TARGET01:start",
        intent: {
          type: "embargo",
          targetID: "TARGET01",
          action: "start",
        },
      }),
      before,
      after,
    );

    expect(audit.auditStatus).toBe("confirmed");
    expect(audit.auditReason).toContain("outgoing embargo");
    expect(audit.after?.outgoingEmbargoTargetIDs).toContain("TARGET01");
  });

  it("records unknown when an accepted effect cannot be proven", () => {
    const audit = auditDecisionEffect(
      baseRecord({
        chosenActionKind: "attack",
        chosenActionID: "attack:TARGET01:10",
        intent: {
          type: "attack",
          targetID: "TARGET01",
          troops: 50,
        },
      }),
      null,
      null,
    );

    expect(audit.auditStatus).toBe("unknown");
    expect(audit.auditReason).toContain("after-state mirror snapshot");
  });
});

function baseRecord(
  overrides: Partial<AgentDecisionRecord>,
): AgentDecisionRecord {
  return {
    sequence: 1,
    gameID: "AUDITGAME",
    agentID: "agent-1",
    clientID: "CLIENT01",
    username: "Audit Agent",
    profile: "aggressive",
    brainType: "rule",
    turnNumber: 1,
    decidedAt: Date.UTC(2026, 0, 1),
    decisionLatencyMs: 1,
    observationSummary: "aggressive Audit Agent",
    legalActionIDs: [overrides.chosenActionID ?? "hold"],
    legalActionIDsByKind: {
      [overrides.chosenActionKind ?? "hold"]: [
        overrides.chosenActionID ?? "hold",
      ],
    },
    attackActionIDs: [],
    chosenActionID: "hold",
    chosenActionKind: "hold",
    reason: "test",
    intent: null,
    result: {
      accepted: true,
      reason: "accepted",
      submittedIntent: null,
    },
    ...overrides,
  };
}

function fakeGame(input: { actor: Player; target?: Player }): Game {
  const players = [input.actor, ...(input.target ? [input.target] : [])];
  return {
    ticks: () => 10,
    playerByClientID: (clientID: string) =>
      players.find((player) => player.clientID() === clientID) ?? null,
    players: () => players,
  } as unknown as Game;
}

function fakePlayer(input: {
  playerID?: string;
  clientID?: string;
  unitCounts?: Partial<Record<UnitType, number>>;
  units?: Array<{ type: UnitType; tile: number }>;
  embargoTargetIDs?: string[];
  outgoingAttackTargetIDs?: string[];
  allianceRecipientIDs?: string[];
}): Player {
  const playerID = input.playerID ?? "PLAYER01";
  const clientID = input.clientID ?? "CLIENT01";
  const units = input.units ?? [];
  return {
    id: () => playerID,
    clientID: () => clientID,
    isAlive: () => true,
    hasSpawned: () => true,
    numTilesOwned: () => 10,
    troops: () => 100,
    gold: () => ({ toString: () => "1000" }),
    units: (type?: UnitType) =>
      units
        .filter((unit) => type === undefined || unit.type === type)
        .map((unit) => ({
          tile: () => unit.tile,
        })),
    outgoingAttacks: () =>
      (input.outgoingAttackTargetIDs ?? []).map((targetID) => ({
        target: () => fakePlayer({ playerID: targetID, clientID: targetID }),
      })),
    outgoingAllianceRequests: () =>
      (input.allianceRecipientIDs ?? []).map((recipientID) => ({
        recipient: () =>
          fakePlayer({ playerID: recipientID, clientID: recipientID }),
      })),
    getEmbargoes: () =>
      (input.embargoTargetIDs ?? []).map((targetID) => ({
        createdAt: 1,
        isTemporary: false,
        target: fakePlayer({ playerID: targetID, clientID: targetID }),
      })),
  } as unknown as Player;
}
