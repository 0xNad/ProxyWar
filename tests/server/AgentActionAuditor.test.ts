import { describe, expect, it } from "vitest";
import {
  Game,
  Player,
  PlayerDonation,
  UnitType,
} from "../../src/core/game/Game";
import {
  auditDecisionEffect,
  captureDecisionAuditBaselines,
} from "../../src/server/agents/AgentActionAuditor";
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

  it("confirms an immediately resolved reciprocal alliance request from alliance state", () => {
    const before = fakeGame({ actor: fakePlayer({ alliedPlayerIDs: [] }) });
    const after = fakeGame({
      actor: fakePlayer({ alliedPlayerIDs: ["TARGET01"] }),
      target: fakePlayer({ playerID: "TARGET01", clientID: "TARGETCLIENT" }),
    });
    const audit = auditDecisionEffect(
      baseRecord({
        chosenActionKind: "alliance_request",
        chosenActionID: "alliance_request:TARGET01",
        intent: { type: "allianceRequest", recipient: "TARGET01" },
      }),
      before,
      after,
    );

    expect(audit.auditStatus).toBe("confirmed");
    expect(audit.auditReason).toContain("newly formed core alliance");
  });

  it("confirms a core alliance break from the before/after alliance delta", () => {
    const before = fakeGame({
      actor: fakePlayer({ alliedPlayerIDs: ["TARGET01"] }),
      target: fakePlayer({ playerID: "TARGET01", clientID: "TARGETCLIENT" }),
    });
    const after = fakeGame({
      actor: fakePlayer({ alliedPlayerIDs: [] }),
      target: fakePlayer({ playerID: "TARGET01", clientID: "TARGETCLIENT" }),
    });
    const audit = auditDecisionEffect(
      baseRecord({
        chosenActionKind: "break_alliance",
        chosenActionID: "break_alliance:TARGET01",
        intent: { type: "breakAlliance", recipient: "TARGET01" },
      }),
      before,
      after,
    );

    expect(audit.auditStatus).toBe("confirmed");
    expect(audit.auditReason).toContain("no longer shows a core alliance");
  });

  it("preserves the pre-advance cursor and confirms an exact core donation receipt despite flat net resources", () => {
    const donations: PlayerDonation[] = [];
    const actor = fakePlayer({ donations, gold: "1000" });
    const target = fakePlayer({
      playerID: "TARGET01",
      clientID: "TARGETCLIENT",
      gold: "1000",
    });
    const game = fakeGame({ actor, target });
    const record = baseRecord({
      chosenActionKind: "donate_gold",
      chosenActionID: "donate_gold:TARGET01",
      chosenActionMetadata: { recipientID: "TARGET01", gold: 50000 },
      intent: { type: "donate_gold", recipient: "TARGET01", gold: 50000 },
    });
    const baseline = captureDecisionAuditBaselines([record], game).get(record);
    donations.push({
      recipientID: "TARGET01",
      tick: 11,
      resource: "gold",
      amount: 30000n,
    });

    const audit = auditDecisionEffect(record, null, game, baseline);

    expect(audit.before?.sentDonationCount).toBe(0);
    expect(audit.after?.sentDonationCount).toBe(1);
    expect(audit.auditStatus).toBe("confirmed");
    expect(audit.confirmedDonation).toEqual({
      recipientPlayerID: "TARGET01",
      tick: 11,
      resource: "gold",
      amount: "30000",
    });
  });

  it("does not confirm a receipt for the wrong recipient or resource", () => {
    const beforeDonations: PlayerDonation[] = [];
    const afterDonations: PlayerDonation[] = [
      {
        recipientID: "OTHER01",
        tick: 11,
        resource: "troops",
        amount: 5000,
      },
    ];
    const record = baseRecord({
      chosenActionKind: "donate_gold",
      chosenActionID: "donate_gold:TARGET01",
      intent: { type: "donate_gold", recipient: "TARGET01", gold: 50000 },
    });
    const audit = auditDecisionEffect(
      record,
      fakeGame({ actor: fakePlayer({ donations: beforeDonations }) }),
      fakeGame({ actor: fakePlayer({ donations: afterDonations }) }),
    );

    expect(audit.auditStatus).toBe("unknown");
    expect(audit.confirmedDonation).toBeUndefined();
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
  alliedPlayerIDs?: string[];
  troops?: number;
  gold?: string;
  donations?: PlayerDonation[];
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
    troops: () => input.troops ?? 100,
    gold: () => ({ toString: () => input.gold ?? "1000" }),
    donationCount: () => input.donations?.length ?? 0,
    donationsSentSince: (cursor: number) =>
      (input.donations ?? []).slice(cursor),
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
    allies: () =>
      (input.alliedPlayerIDs ?? []).map((alliedID) =>
        fakePlayer({ playerID: alliedID, clientID: alliedID }),
      ),
    getEmbargoes: () =>
      (input.embargoTargetIDs ?? []).map((targetID) => ({
        createdAt: 1,
        isTemporary: false,
        target: fakePlayer({ playerID: targetID, clientID: targetID }),
      })),
  } as unknown as Player;
}
