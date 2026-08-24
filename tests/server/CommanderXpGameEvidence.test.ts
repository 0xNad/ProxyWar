import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";
import {
  COMMANDER_XP_GAME_EVIDENCE_PREFIX,
  commanderXpGameEvidenceLine,
  projectCommanderXpGameEvidence,
} from "../../src/server/agents/CommanderXpGameEvidence";

describe("Commander XP game-owned evidence", () => {
  const runKey = "commander-xp-v2/test/canary/r00/C";

  it("loads game evidence through the packaged ProxyWar module root", () => {
    const adapterSource = readFileSync(
      path.join(
        process.cwd(),
        "coworld-adapter",
        "src",
        "no-docker-coworld-episode.ts",
      ),
      "utf8",
    );
    expect(adapterSource).toContain(
      'importProxyWar("src/server/agents/CommanderXpGameEvidence.ts")',
    );
    expect(adapterSource).toContain(
      'importProxyWar("src/server/agents/CommanderXpCoworldIdentity.ts")',
    );
    expect(adapterSource).not.toMatch(
      /from\s+["']\.\.\/\.\.\/src\/server\/agents\/CommanderXpGameEvidence\.ts["']/,
    );
    expect(adapterSource).not.toContain('from "./coworld-seed.ts"');
  });

  it("projects execution and social outcomes while excluding text/provider material", () => {
    const record = {
      sequence: 7,
      gameID: "game",
      agentID: "agent",
      clientID: "client",
      username: "subject",
      profile: "aggressive",
      brainType: "external-http",
      turnNumber: 100,
      decidedAt: 1,
      decisionLatencyMs: 2,
      observationSummary: "PRIVATE OBSERVATION",
      legalActionIDs: ["hold:1", "attack:2", "message:3"],
      legalActionIDsByKind: {
        hold: ["hold:1"],
        attack: ["attack:2"],
        message: ["message:3"],
      },
      attackActionIDs: ["attack:2"],
      chosenActionID: "attack:2",
      chosenActionKind: "attack",
      reason: "do it",
      decisionMetadata: {
        coworldRequestID: "req_exact",
        coworldSlot: 2,
        commanderExecutionSha256: "4".repeat(64),
        planID: "plan-pressure-fixture",
        planObjective: "pressure_rival:rival",
        commanderOptionSurfaceSha256: "5".repeat(64),
        commanderPreviousPlanID: null,
        commanderReplanReason: "no_active_plan",
        commanderPlanAgeDecisions: 0,
        commanderEmergencyCondition: null,
        commanderFidelity: "aligned_primary",
        batchIndex: 0,
        batchSize: 1,
        batchActionIDs: "attack:2",
        externalRawOutput: "RAW PROVIDER OUTPUT",
        commsSlotActionID: "message:3",
        commsSlotRecipientID: "rival",
        commsSlotText: "PRIVATE MESSAGE BODY",
        commsSlotAccepted: true,
        commsSlotResult: "accepted",
      },
      chosenActionMetadata: {
        targetID: "rival",
        expansion: false,
        privatePlannerNote: "PRIVATE ACTION NOTE",
      },
      intent: { type: "attack", targetID: "rival", troops: 10 },
      result: {
        accepted: true,
        reason: "submitted",
        submittedIntent: { type: "attack", targetID: "rival", troops: 10 },
      },
      audit: { auditStatus: "confirmed", auditReason: "confirmed" },
    } as unknown as AgentDecisionRecord;

    const evidence = projectCommanderXpGameEvidence(record, runKey);
    expect(evidence).not.toBeNull();
    expect(evidence?.requestID).toBe("req_exact");
    expect(evidence?.chosen).toEqual({
      id: "attack:2",
      kind: "attack",
      metadata: { targetID: "rival", expansion: false },
    });
    expect(evidence?.generatedIntent).toEqual({
      type: "attack",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      canonical: { type: "attack", targetID: "rival", troops: 10 },
    });
    expect(evidence?.commander).toMatchObject({
      commanderExecutionSha256: "4".repeat(64),
      planID: "plan-pressure-fixture",
      planObjective: "pressure_rival:rival",
      commanderOptionSurfaceSha256: "5".repeat(64),
      commanderFidelity: "aligned_primary",
      batchIndex: 0,
      batchSize: 1,
      batchActionIDs: "attack:2",
    });
    expect(evidence?.comms).toEqual({
      requestedID: null,
      actionID: "message:3",
      recipientID: "rival",
      accepted: true,
      rejected: null,
    });
    const line = commanderXpGameEvidenceLine(evidence!);
    expect(line.startsWith(COMMANDER_XP_GAME_EVIDENCE_PREFIX)).toBe(true);
    expect(line).not.toContain("PRIVATE");
    expect(line).not.toContain("externalRawOutput");
    expect(line).not.toContain("commsSlotText");
    expect(line).not.toContain("submittedReason");
    expect(line).not.toContain("privatePlannerNote");
  });

  it("rejects records without a joinable Coworld request identity", () => {
    expect(
      projectCommanderXpGameEvidence(
        {
          decisionMetadata: {},
        } as unknown as AgentDecisionRecord,
        runKey,
      ),
    ).toBeNull();
  });
});
