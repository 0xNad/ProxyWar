import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDealLedgerSnapshot } from "../../src/server/agents/AgentDealManager";
import { writeAgentLeagueRunArtifacts } from "../../src/server/agents/AgentDecisionLogWriter";
import type { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";
import {
  DEALS_FLAG,
  dealLeagueHarness,
  pickWithDeal,
  type StubSeat,
} from "./DealTestHarness";

const A: StubSeat = { agentID: "a1", playerID: "P_A", username: "Auri" };
const B: StubSeat = { agentID: "b1", playerID: "P_B", username: "Sefirot" };
const DEAL_ID = "deal:P_A:P_B:non_aggression_pact:0";
const REJECTED_REQUESTED_ID = `deal_reject:PRIVATE\u0000${"X".repeat(512)}`;
const scratchDirs: string[] = [];

beforeEach(() => {
  process.env[DEALS_FLAG] = "1";
});

afterEach(async () => {
  delete process.env[DEALS_FLAG];
  await Promise.all(
    scratchDirs
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function runAcceptedPact() {
  const harness = dealLeagueHarness({
    seats: [A, B],
    scripts: [
      [
        pickWithDeal(
          null,
          "deal_propose:P_B:non_aggression_pact",
          "I want a quiet western border",
        ),
        () => null,
        pickWithDeal(
          null,
          REJECTED_REQUESTED_ID,
          "PRIVATE REJECTED REASON MUST NOT ENTER LEDGER",
        ),
      ],
      [
        () => null,
        pickWithDeal(
          null,
          `deal_accept:${DEAL_ID}`,
          "I accept while rebuilding",
        ),
        () => null,
      ],
    ],
    gameID: "DEAL_LEDGER",
    brainType: "external-http",
  });
  await harness.league.runDecisionTurn({ turnNumber: 0 });
  await harness.league.runDecisionTurn({ turnNumber: 25 });
  await harness.league.runDecisionTurn({ turnNumber: 50 });
  return harness;
}

async function writeRun(
  dealLedger: AgentDealLedgerSnapshot,
  records: AgentDecisionRecord[],
) {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "deal-ledger-artifact-"),
  );
  scratchDirs.push(rootDir);
  return writeAgentLeagueRunArtifacts({
    rootDir,
    runID: "deal-ledger-run",
    matchID: "DEAL_LEDGER",
    scenario: "coworld",
    brainMode: "external-http",
    startedAt: Date.UTC(2026, 7, 8),
    completedAt: Date.UTC(2026, 7, 8, 0, 1),
    records,
    roster: [A, B].map((seat) => ({
      agentID: seat.agentID,
      username: seat.username,
      profile: "diplomatic" as const,
      clientID: `CLNT_${seat.playerID}`,
      brainType: "external-http" as const,
    })),
    dealLedger,
  });
}

describe("final structured-deal ledger artifact", () => {
  it("persists moot force-resolutions with stable ids, turns, facts, and separate claims", async () => {
    const harness = await runAcceptedPact();
    harness.records()[0].decisionMetadata = {
      ...harness.records()[0].decisionMetadata,
      llmPrompt: "PRIVATE PROMPT MUST NOT ENTER LEDGER",
    };
    expect(
      harness
        .records()
        .find((record) =>
          record.dealSlotEvidence?.requestedActionID.startsWith(
            "deal_reject:PRIVATE",
          ),
        )?.dealSlotEvidence,
    ).toMatchObject({
      requestedActionID: expect.stringContaining("deal_reject:PRIVATE"),
      validation: { accepted: false },
      application: { attempted: false },
    });
    harness.league.finalizeDeals({ turnNumber: 75 });
    const ledger = harness.league.dealLedger();

    expect(ledger).toMatchObject({
      finalized: true,
      finalizedAtStep: 2,
      finalizedAtTurn: 75,
      decisionSteps: [
        { step: 0, turnNumber: 0, recordsBeforeStep: 0 },
        { step: 1, turnNumber: 25, recordsBeforeStep: 2 },
        { step: 2, turnNumber: 50, recordsBeforeStep: 4 },
      ],
    });
    expect(ledger.actionEvidence).toHaveLength(2);
    expect(ledger.actionEvidence[0]).toMatchObject({
      sequence: expect.any(Number),
      turnNumber: 0,
      actorPlayerID: "P_A",
      actorName: "Auri",
      offeredActionIDs: expect.arrayContaining([
        "deal_propose:P_B:non_aggression_pact",
      ]),
      selectedActionID: "deal_propose:P_B:non_aggression_pact",
      selectedActionKind: "deal_propose",
      managerApplied: true,
      sourceFallbackUsed: false,
      sourceLlmPlannerDegraded: false,
    });
    expect(ledger.actionEvidence[1]).toMatchObject({
      sequence: expect.any(Number),
      turnNumber: 25,
      actorPlayerID: "P_B",
      actorName: "Sefirot",
      offeredActionIDs: expect.arrayContaining([`deal_accept:${DEAL_ID}`]),
      selectedActionID: `deal_accept:${DEAL_ID}`,
      selectedActionKind: "deal_accept",
      managerApplied: true,
    });
    for (const evidence of ledger.actionEvidence) {
      expect(evidence.offeredActionIDs).toContain(evidence.selectedActionID);
    }
    expect(ledger.actionEvidence[0].sequence).toBeLessThan(
      ledger.actionEvidence[1].sequence,
    );
    const deal = ledger.deals.find(
      (candidate) => candidate.dealID === DEAL_ID,
    )!;
    expect(deal).toMatchObject({
      status: "accepted",
      proposedAtStep: 0,
      proposedAtTurn: 0,
      respondedAtStep: 1,
      respondedAtTurn: 25,
      activeFromStep: 2,
      expiresAfterStep: 13,
      proposerStatedReason: "I want a quiet western border",
      acceptorStatedReason: "I accept while rebuilding",
    });
    expect(
      deal.obligations.map((obligation) => ({
        obligationID: obligation.obligationID,
        obligorPlayerID: obligation.obligorPlayerID,
        counterpartyPlayerID: obligation.counterpartyPlayerID,
        status: obligation.status,
        forcedResolution: obligation.forcedResolution,
      })),
    ).toEqual([
      {
        obligationID: `obligation:${DEAL_ID}:P_A:non_aggression`,
        obligorPlayerID: "P_A",
        counterpartyPlayerID: "P_B",
        status: "moot",
        forcedResolution: true,
      },
      {
        obligationID: `obligation:${DEAL_ID}:P_B:non_aggression`,
        obligorPlayerID: "P_B",
        counterpartyPlayerID: "P_A",
        status: "moot",
        forcedResolution: true,
      },
    ]);
    const proposalEvent = ledger.events.find(
      (event) => event.event === "deal_proposed",
    )!;
    expect(proposalEvent.statedReason).toBe("I want a quiet western border");
    expect(proposalEvent.publicText).not.toContain(proposalEvent.statedReason);

    const firstPaths = await writeRun(ledger, harness.records());
    const secondPaths = await writeRun(ledger, harness.records());
    expect(firstPaths.dealLedgerPath).toBeDefined();
    const firstBytes = await fs.readFile(firstPaths.dealLedgerPath!, "utf8");
    const secondBytes = await fs.readFile(secondPaths.dealLedgerPath!, "utf8");
    expect(secondBytes).toBe(firstBytes);
    expect(firstBytes).not.toContain("PRIVATE PROMPT MUST NOT ENTER LEDGER");
    expect(firstBytes).not.toContain("PRIVATE REJECTED REASON");
    expect(firstBytes).not.toContain("deal_reject:PRIVATE");

    const publicTelemetry = JSON.parse(
      await fs.readFile(firstPaths.spectatorTelemetryPath, "utf8"),
    );
    const publicDealEvents = publicTelemetry.events.filter(
      (event: { kind?: unknown }) =>
        typeof event.kind === "string" && event.kind.startsWith("deal_"),
    );
    expect(publicTelemetry.dealEventCoverage).toMatchObject({
      authority: "finalized_deal_ledger",
      complete: true,
      sourceEventCount: ledger.events.length,
      emittedEventCount: ledger.events.length,
      droppedEventCount: 0,
    });
    expect(
      publicDealEvents.map((event: { kind: string }) => event.kind),
    ).toEqual(ledger.events.map((event) => event.event));
    expect(publicDealEvents).toHaveLength(ledger.events.length);
    expect(publicDealEvents).toEqual([
      expect.objectContaining({
        kind: "deal_proposed",
        actionKind: "deal_propose",
        actionID: `deal:deal_proposed:${DEAL_ID}`,
        evidenceLevel: "accepted_action",
        actorAgentID: A.agentID,
        targetAgentID: B.agentID,
      }),
      expect.objectContaining({
        kind: "deal_accepted",
        actionKind: "deal_accept",
        actionID: `deal:deal_accepted:${DEAL_ID}`,
        evidenceLevel: "accepted_action",
        actorAgentID: B.agentID,
        targetAgentID: A.agentID,
      }),
    ]);

    const artifact = JSON.parse(firstBytes);
    expect(JSON.stringify(artifact)).not.toContain("PRIVATE");
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      runID: "deal-ledger-run",
      matchID: "DEAL_LEDGER",
      finalizedAtStep: 2,
      finalizedAtTurn: 75,
      actionEvidence: ledger.actionEvidence,
    });
    for (const persistedDeal of artifact.deals) {
      for (const obligation of persistedDeal.obligations) {
        expect(obligation.status).not.toBe("pending");
      }
    }

    // Finalization is an immutable boundary: another decision step is loud.
    await expect(
      harness.league.runDecisionTurn({ turnNumber: 75 }),
    ).rejects.toThrow("deal ledger is finalized");
    expect(harness.league.dealLedger()).toEqual(ledger);
  });

  it("refuses to write a ledger before match-end finalization", async () => {
    const harness = await runAcceptedPact();
    const unfinalized = harness.league.dealLedger();
    expect(unfinalized.finalized).toBe(false);
    await expect(writeRun(unfinalized, harness.records())).rejects.toThrow(
      "before finalizeDeals() completed",
    );
  });
});
