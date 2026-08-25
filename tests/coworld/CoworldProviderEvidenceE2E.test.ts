import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  composeCoworldDecision,
  normalizeDecisionResponse,
} from "../../coworld-adapter/src/coworld-decision-wire";
import { writeAgentLeagueRunArtifacts } from "../../src/server/agents/AgentDecisionLogWriter";
import { fabricatedRecord } from "../server/DealTestHarness";

describe("Coworld provider evidence persisted accounting", () => {
  it("counts one valid planner call and one invalid attestation without inventing an action call", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "provider-e2e-"));
    try {
      const normalized = normalizeDecisionResponse({
        selectedLegalActionId: "hold",
      });
      const valid = composeCoworldDecision({
        normalized,
        message: {
          providerEvidence: {
            callKind: "planner",
            provider: "bedrock-sidecar",
            requestedModel: "us.anthropic.claude-sonnet-4-6",
            attemptedModels: [
              "us.anthropic.claude-sonnet-4-6",
              "us.anthropic.claude-haiku-4-5",
            ],
            attemptCount: 2,
            completedAttemptCount: 1,
            failedAttemptCount: 1,
            timedOutAttemptCount: 0,
            responseModel: "us.anthropic.claude-sonnet-4-6",
            requestID: "req-provider-e2e",
            inputTokens: 100,
            outputTokens: 20,
            rawOutputPresent: true,
          },
        },
        slot: 0,
        requestID: "req-wire-valid",
        offeredLegalActionCount: 1,
      });
      const invalid = composeCoworldDecision({
        normalized,
        message: {
          providerEvidence: {
            callKind: "planner",
            provider: "bedrock-sidecar",
            requestedModel: "model",
          },
        },
        slot: 0,
        requestID: "req-wire-invalid",
        offeredLegalActionCount: 1,
      });

      const paths = await writeAgentLeagueRunArtifacts({
        rootDir,
        runID: "provider-e2e-run",
        matchID: "PROVEVID",
        scenario: "coworld",
        brainMode: "external-http",
        startedAt: Date.UTC(2026, 7, 25),
        completedAt: Date.UTC(2026, 7, 25, 0, 0, 1),
        records: [
          {
            ...fabricatedRecord({
              sequence: 1,
              agentID: "provider-agent",
              playerID: "P_PROVIDER",
              username: "Provider Agent",
              turnNumber: 5,
            }),
            decisionMetadata: valid.metadata,
          },
          {
            ...fabricatedRecord({
              sequence: 2,
              agentID: "invalid-agent",
              playerID: "P_INVALID",
              username: "Invalid Agent",
              turnNumber: 5,
            }),
            decisionMetadata: invalid.metadata,
          },
        ],
        roster: [],
      });

      const entries = (await fs.readFile(paths.decisionsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries[0]).toMatchObject({
        externalPlannerCall: true,
        externalActionCall: false,
        providerCallKind: "planner",
        providerName: "bedrock-sidecar",
        providerAttemptCount: 2,
        providerCompletedAttemptCount: 1,
        providerFailedAttemptCount: 1,
        providerTimedOutAttemptCount: 0,
        providerInputTokens: 100,
        providerOutputTokens: 20,
      });
      expect(entries[1]).toMatchObject({
        externalPlannerCall: false,
        externalActionCall: false,
        providerEvidenceInvalid: true,
      });

      const summary = JSON.parse(
        await fs.readFile(paths.summaryPath, "utf8"),
      ) as Record<string, unknown>;
      expect(summary).toMatchObject({
        policySelfAttestedPlannerActivityRecordCount: 1,
        policySelfAttestedActionActivityRecordCount: 0,
        policySelfAttestedProviderAttemptCount: 2,
        policySelfAttestedProviderCompletedAttemptCount: 1,
        policySelfAttestedProviderFailedAttemptCount: 1,
        policySelfAttestedProviderTimedOutAttemptCount: 0,
        externalPlannerCallCount: 1,
        externalActionCallCount: 0,
        externalCallCountSemantics:
          "deprecated decision-record activity booleans; not provider call or cost proof",
        rawProviderOutputRecordCount: 1,
        invalidProviderEvidenceRecordCount: 1,
      });
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
