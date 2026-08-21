import fs from "fs/promises";
import os from "os";
import path from "path";
import { writeAgentLeagueRunArtifacts } from "../../src/server/agents/AgentDecisionLogWriter";
import type { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";
import { fabricatedRecord } from "./DealTestHarness";

function commanderRecord(
  sequence: number,
  actionID: string,
  fidelity: "aligned_primary" | "aligned_support",
): AgentDecisionRecord {
  const record = fabricatedRecord({
    sequence,
    agentID: "COMMANDER",
    playerID: "P1",
    username: "Commander",
    turnNumber: 10,
    actionID,
    kind: fidelity === "aligned_primary" ? "attack" : "embargo",
  });
  record.brainType = "strategic-commander";
  record.decisionMetadata = {
    runtimeMode: "commander-v0-selector",
    planID: "commander:10:abc",
    planObjective: "pressure_rival:P7",
    planRationale: "pressure P7 without retargeting",
    planFollowed: true,
    plannerRan: sequence === 1,
    plannerFallbackUsed: false,
    commanderSelectorSource: "llm",
    commanderFingerprint: "aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb",
    commanderExposedOptionIds: "expand,pressure_rival:P7,survive",
    commanderOmittedOptions: "pressure_rival:P9:pressure_target_cap",
    commanderFidelity: fidelity,
    commanderReplanReason: sequence === 1 ? "no_active_plan" : "within_horizon",
    commanderPreviousPlanID: "commander:7:old",
    commanderHorizonDecisions: 4,
    commanderPlanAgeDecisions: 0,
    commanderBlockedReason: null,
    commanderImmediateReplan: false,
    commanderEmergencyCondition: null,
    commanderBatchFidelities: JSON.stringify({
      "attack:p7": "aligned_primary",
      "embargo:p7:start": "aligned_support",
    }),
  };
  return record;
}

describe("Commander artifact stamps", () => {
  it("hoists every public scalar with distinct per-action fidelity", async () => {
    const rootDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "commander-artifact-"),
    );
    try {
      const records = [
        commanderRecord(1, "attack:p7", "aligned_primary"),
        commanderRecord(2, "embargo:p7:start", "aligned_support"),
      ];
      const paths = await writeAgentLeagueRunArtifacts({
        rootDir,
        runID: "commander-run",
        matchID: "commander-match",
        scenario: "commander-stage4",
        brainMode: "strategic-commander",
        startedAt: 0,
        completedAt: 1,
        records,
        roster: [
          {
            agentID: "COMMANDER",
            username: "Commander",
            profile: "diplomatic",
            clientID: "CLNT_P1",
            brainType: "strategic-commander",
          },
        ],
      });
      const entries = (await fs.readFile(paths.decisionsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(entries.map((entry) => entry.commanderFidelity)).toEqual([
        "aligned_primary",
        "aligned_support",
      ]);
      expect(entries[0]).toMatchObject({
        brainType: "strategic-commander",
        runtimeMode: "commander-v0-selector",
        planID: "commander:10:abc",
        planObjective: "pressure_rival:P7",
        planRationale: "pressure P7 without retargeting",
        planFollowed: true,
        commanderSelectorSource: "llm",
        commanderFingerprint: "aaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbb",
        commanderExposedOptionIds: "expand,pressure_rival:P7,survive",
        commanderOmittedOptions: "pressure_rival:P9:pressure_target_cap",
        commanderReplanReason: "no_active_plan",
        commanderPreviousPlanID: "commander:7:old",
        commanderHorizonDecisions: 4,
        commanderPlanAgeDecisions: 0,
        commanderImmediateReplan: false,
      });
      expect(entries[0]).not.toHaveProperty("commanderBatchFidelities");
      expect(entries[0]).not.toHaveProperty("commanderBlockedReason");
      expect(entries[0]).not.toHaveProperty("commanderEmergencyCondition");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
