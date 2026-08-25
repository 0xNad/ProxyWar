import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDealLedgerEvent } from "../../src/server/agents/AgentDealCompliance";
import type { AgentDealLedgerSnapshot } from "../../src/server/agents/AgentDealManager";
import { buildAgentDramaReport } from "../../src/server/agents/AgentDramaReport";
import { buildAgentSpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";
import type { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";
import { DEALS_FLAG, fabricatedRecord, type StubSeat } from "./DealTestHarness";

// Phase B spectator events (PROXYWAR_TUNE_STRUCTURED_DEALS, default OFF):
// derived from records alone (the mirror-backfill path rebuilds telemetry
// from decisions.jsonl), provenance split by action/ledger source, bounded per
// agent, with server-authored publicText carried in the deal stamps. Tones per spec:
// deal_accepted = pact, deal_violated = betrayal (high importance).

const A: StubSeat = { agentID: "a1", playerID: "P_A", username: "Auri" };
const B: StubSeat = { agentID: "b1", playerID: "P_B", username: "Sefirot" };

const ROSTER = [A, B].map((seat) => ({
  agentID: seat.agentID,
  username: seat.username,
  profile: "diplomatic" as const,
  clientID: `CLNT_${seat.playerID}`,
  brainType: "rule" as const,
}));

beforeEach(() => {
  process.env[DEALS_FLAG] = "1";
});

afterEach(() => {
  delete process.env[DEALS_FLAG];
});

const DEAL_ID = "deal:P_A:P_B:non_aggression_pact:0";

function stampedRecord(
  sequence: number,
  seat: StubSeat,
  decisionMetadata: Record<string, string | number | boolean | null>,
  accepted = true,
): AgentDecisionRecord {
  const base = fabricatedRecord({
    sequence,
    agentID: seat.agentID,
    playerID: seat.playerID,
    username: seat.username,
    turnNumber: sequence * 25,
    kind: "hold",
    accepted,
  });
  return { ...base, decisionMetadata };
}

function telemetryFor(
  records: AgentDecisionRecord[],
  dealLedger?: AgentDealLedgerSnapshot,
) {
  return buildAgentSpectatorTelemetry({
    runID: "DEAL_TELEMETRY",
    records,
    roster: ROSTER,
    dealLedger,
  });
}

function finalizedLedger(
  events: AgentDealLedgerEvent[],
  finalizedAtStep = Math.max(0, ...events.map((event) => event.step)),
  finalizedAtTurn = finalizedAtStep * 100 + 400,
): AgentDealLedgerSnapshot {
  return {
    finalized: true,
    finalizedAtStep,
    finalizedAtTurn,
    decisionSteps: Array.from({ length: finalizedAtStep + 1 }, (_, step) => ({
      step,
      turnNumber: step * 100,
      recordsBeforeStep: step * 2,
    })),
    deals: [],
    events,
    actionEvidence: [],
  };
}

describe("spectator telemetry — structured-deal events", () => {
  it("maps propose/accept/reject stamps to accepted-action events with record provenance", () => {
    const records = [
      stampedRecord(1, A, {
        dealAction: "propose",
        dealID: DEAL_ID,
        dealTemplate: "non_aggression_pact",
        dealCounterpartyID: B.playerID,
        dealCounterpartyName: B.username,
        dealApplyAccepted: true,
        fallbackUsed: true,
        llmPlannerDegraded: true,
        dealPublicText:
          "Auri proposed a non-aggression pact to Sefirot (12 decisions).",
      }),
      stampedRecord(2, B, {
        dealAction: "accept",
        dealID: DEAL_ID,
        dealCounterpartyID: A.playerID,
        dealCounterpartyName: A.username,
        dealApplyAccepted: true,
        dealPublicText:
          "Sefirot accepted Auri's non-aggression pact (12 decisions).",
      }),
      stampedRecord(3, B, {
        dealAction: "reject",
        dealID: "deal:P_A:P_B:trade_security_pact:2",
        dealCounterpartyID: A.playerID,
        dealCounterpartyName: A.username,
        dealApplyAccepted: true,
        dealPublicText: "Sefirot rejected Auri's trade-security pact.",
      }),
    ];
    const telemetry = telemetryFor(records);
    const events = telemetry.events.filter((event) =>
      event.kind.startsWith("deal_"),
    );
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      kind: "deal_proposed",
      tone: "info",
      importance: 55,
      actionKind: "deal_propose",
      evidenceLevel: "accepted_action",
      fallbackUsed: true,
      llmPlannerDegraded: true,
      auditStatus: "not_applicable",
      actorAgentID: A.agentID,
      targetAgentID: B.agentID,
      publicText:
        "Auri proposed a non-aggression pact to Sefirot (12 decisions).",
    });
    expect(events[1]).toMatchObject({
      kind: "deal_accepted",
      tone: "pact",
      importance: 78,
      actionKind: "deal_accept",
      evidenceLevel: "accepted_action",
      actorAgentID: B.agentID,
      targetAgentID: A.agentID,
    });
    expect(events[1].message).toBe(
      "Sefirot accepted Auri's non-aggression pact (12 decisions).",
    );
    expect(events[2]).toMatchObject({ kind: "deal_rejected", tone: "info" });
    expect(telemetry.communicationThreads).toHaveLength(1);
    expect(telemetry.communicationThreads[0]?.messages).toHaveLength(3);
  });

  it("emits nothing for withdrawals, failed applies, or rejected results", () => {
    const records = [
      stampedRecord(1, A, {
        dealAction: "withdraw",
        dealID: DEAL_ID,
        dealApplyAccepted: true,
      }),
      stampedRecord(2, A, {
        dealAction: "propose",
        dealID: DEAL_ID,
        dealApplyAccepted: false,
      }),
      stampedRecord(
        3,
        A,
        {
          dealAction: "propose",
          dealID: DEAL_ID,
          dealApplyAccepted: true,
          dealPublicText: "never emitted",
        },
        false,
      ),
    ];
    expect(
      telemetryFor(records).events.some((event) =>
        event.kind.startsWith("deal_"),
      ),
    ).toBe(false);
  });

  it("carries referee verdicts (dealComplianceEvent JSON) through with authored tone/importance/text", () => {
    const verdict = {
      event: "deal_violated",
      dealID: DEAL_ID,
      template: "non_aggression_pact",
      actorPlayerID: B.playerID,
      actorName: B.username,
      targetPlayerID: A.playerID,
      targetName: A.username,
      tone: "betrayal",
      importance: 96,
      publicText:
        "VERDICT: Sefirot violated the pact — land attack on Auri at step 214.",
      step: 214,
      sourceSequence: 91,
      sourceTurnNumber: 2140,
      sourceFallbackUsed: true,
      sourceLlmPlannerDegraded: true,
      sourceAuditStatus: "confirmed",
      sourceAuditReason: "confirmed source attack",
    };
    // The stamp rides A's record (the carrier), but the ACTOR is Sefirot —
    // telemetry maps the actor from the event's own playerID. Every live seat
    // produces records, so B's seat is present (that is how the roster maps
    // playerIDs).
    const records = [
      stampedRecord(1, B, {}),
      stampedRecord(2, A, {
        dealComplianceEvent: JSON.stringify([verdict]),
      }),
      stampedRecord(3, A, { dealComplianceEvent: "not json at all" }),
      stampedRecord(4, A, {
        dealComplianceEvent: JSON.stringify([{ event: "deal_violated" }]),
      }),
    ];
    const events = telemetryFor(records).events.filter((event) =>
      event.kind.startsWith("deal_"),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "deal_violated",
      tone: "betrayal",
      importance: 96,
      actionKind: "none",
      evidenceLevel: "state_derived",
      fallbackUsed: true,
      llmPlannerDegraded: true,
      auditStatus: "confirmed",
      sequence: 91,
      turnNumber: 2140,
      actorAgentID: B.agentID,
      actorName: B.username,
      targetAgentID: A.agentID,
      publicText: verdict.publicText,
    });
  });

  it("drops an unresolved counterparty actor instead of fabricating the carrier as actor", () => {
    const carrier = stampedRecord(1, A, {
      dealComplianceEvent: JSON.stringify([
        {
          event: "deal_violated",
          dealID: DEAL_ID,
          template: "non_aggression_pact",
          // B has no retained record/player-ID join in this fixture. The
          // lifecycle stamp rides A's record, but A is only the carrier.
          actorPlayerID: B.playerID,
          actorName: B.username,
          targetPlayerID: A.playerID,
          targetName: A.username,
          tone: "betrayal",
          importance: 96,
          publicText: "VERDICT: Sefirot violated the pact.",
          step: 1,
          sourceTurnNumber: 100,
        },
      ]),
    });
    const telemetry = telemetryFor([carrier]);

    expect(
      telemetry.events.filter((event) => event.kind.startsWith("deal_")),
    ).toEqual([]);
    expect(telemetry.dealEventCoverage).toMatchObject({
      authority: "decision_records",
      complete: false,
      sourceEventCount: 1,
      emittedEventCount: 0,
      droppedEventCount: 1,
      sourceCountsByKind: { deal_violated: 1 },
      emittedCountsByKind: { deal_violated: 0 },
    });
  });

  it("carries a linked redundant-accept supersession into public telemetry", () => {
    const supersedingDealID = "deal:P_B:P_A:non_aggression_pact:0";
    const publicText =
      "Sefirot's acceptance of Auri's non-aggression pact was redundant; their equivalent deal was already accepted.";
    const record = stampedRecord(2, B, {
      dealAction: "accept",
      dealID: DEAL_ID,
      dealApplyAccepted: false,
      dealTerminalCause: "redundant_accept_superseded",
      dealSupersededByDealID: supersedingDealID,
      dealComplianceEvent: JSON.stringify([
        {
          event: "deal_superseded",
          dealID: DEAL_ID,
          template: "non_aggression_pact",
          actorPlayerID: B.playerID,
          actorName: B.username,
          targetPlayerID: A.playerID,
          targetName: A.username,
          tone: "info",
          importance: 42,
          publicText,
          supersededByDealID: supersedingDealID,
          step: 1,
        },
      ]),
    });

    const records = [
      stampedRecord(1, A, {}),
      record,
      stampedRecord(3, B, {
        dealComplianceEvent: JSON.stringify([
          {
            event: "deal_superseded",
            dealID: `${DEAL_ID}:malformed`,
            template: "non_aggression_pact",
            actorPlayerID: B.playerID,
            actorName: B.username,
            targetPlayerID: A.playerID,
            targetName: A.username,
            tone: "info",
            importance: 42,
            publicText: "must not be narrated without the terminal link",
            step: 1,
          },
        ]),
      }),
    ];
    const events = telemetryFor(records).events.filter((event) =>
      event.kind.startsWith("deal_"),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "deal_superseded",
        actorAgentID: B.agentID,
        targetAgentID: A.agentID,
        actionKind: "none",
        evidenceLevel: "state_derived",
        supersededByDealID: supersedingDealID,
        publicText,
        message: publicText,
      }),
    ]);
    expect(telemetryFor(records).communicationThreads[0]?.messages).toEqual(
      events,
    );
  });

  it("bounds the legacy record-only fallback and reports every dropped event", () => {
    const records: AgentDecisionRecord[] = [];
    for (let index = 0; index < 30; index += 1) {
      records.push(
        stampedRecord(index + 1, A, {
          dealComplianceEvent: JSON.stringify([
            {
              event: "deal_fulfilled",
              dealID: `deal:P_A:P_B:non_aggression_pact:${index}`,
              template: "non_aggression_pact",
              actorPlayerID: A.playerID,
              actorName: A.username,
              targetPlayerID: B.playerID,
              targetName: B.username,
              tone: "pact",
              importance: 62,
              publicText: `pact ${index} honored`,
              step: index,
            },
          ]),
        }),
      );
    }
    const events = telemetryFor(records).events.filter(
      (event) => event.kind === "deal_fulfilled",
    );
    expect(events).toHaveLength(24);
    expect(telemetryFor(records).dealEventCoverage).toEqual({
      authority: "decision_records",
      complete: false,
      sourceEventCount: 30,
      emittedEventCount: 24,
      droppedEventCount: 6,
      sourceCountsByKind: {
        deal_proposed: 0,
        deal_accepted: 0,
        deal_rejected: 0,
        deal_superseded: 0,
        deal_expired: 0,
        deal_fulfilled: 30,
        deal_violated: 0,
      },
      emittedCountsByKind: {
        deal_proposed: 0,
        deal_accepted: 0,
        deal_rejected: 0,
        deal_superseded: 0,
        deal_expired: 0,
        deal_fulfilled: 24,
        deal_violated: 0,
      },
    });
  });

  it("projects every finalized-ledger event beyond 24, including late supersession links and final expiry", () => {
    const supersedingDealID = "deal:P_B:P_A:non_aggression_pact:75";
    const fulfilled: AgentDealLedgerEvent[] = Array.from(
      { length: 30 },
      (_, index) => ({
        event: "deal_fulfilled",
        dealID: `deal:P_A:P_B:non_aggression_pact:${index}`,
        template: "non_aggression_pact",
        actorPlayerID: A.playerID,
        actorName: A.username,
        targetPlayerID: B.playerID,
        targetName: B.username,
        tone: "pact",
        importance: 62,
        publicText: `pact ${index} honored`,
        step: index,
        sourceTurnNumber: index * 100,
      }),
    );
    const supersededDealID = "deal:P_A:P_B:non_aggression_pact:75";
    const events: AgentDealLedgerEvent[] = [
      ...fulfilled,
      {
        event: "deal_superseded",
        dealID: supersededDealID,
        template: "non_aggression_pact",
        actorPlayerID: B.playerID,
        actorName: B.username,
        targetPlayerID: A.playerID,
        targetName: A.username,
        tone: "info",
        importance: 42,
        publicText:
          "Sefirot's acceptance was redundant; the reciprocal pact was already accepted.",
        supersededByDealID: supersedingDealID,
        step: 76,
      },
      {
        event: "deal_expired",
        dealID: "deal:P_A:P_B:joint_attack:99",
        template: "joint_attack",
        actorPlayerID: B.playerID,
        actorName: B.username,
        targetPlayerID: A.playerID,
        targetName: A.username,
        tone: "info",
        importance: 38,
        publicText: "Sefirot let Auri's attack pledge expire unanswered.",
        step: 100,
        sourceTurnNumber: 10_400,
      },
    ];
    const ledger = finalizedLedger(events, 100, 10_400);
    const telemetry = telemetryFor(
      [stampedRecord(1, A, {}), stampedRecord(2, B, {})],
      ledger,
    );
    const publicDealEvents = telemetry.events.filter((event) =>
      event.kind.startsWith("deal_"),
    );

    expect(publicDealEvents).toHaveLength(events.length);
    expect(
      publicDealEvents.filter((event) => event.kind === "deal_fulfilled"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceLevel: "state_derived",
          auditStatus: "not_applicable",
          auditReason: "event derived from authoritative deal lifecycle state",
        }),
      ]),
    );
    expect(
      publicDealEvents.find(
        (event) =>
          event.kind === "deal_superseded" &&
          event.actionID ===
            `deal:deal_superseded:${supersededDealID}:${B.playerID}`,
      ),
    ).toMatchObject({
      supersededByDealID: supersedingDealID,
      actorAgentID: B.agentID,
      targetAgentID: A.agentID,
      actionKind: "none",
      evidenceLevel: "state_derived",
    });
    expect(publicDealEvents.at(-1)).toMatchObject({
      kind: "deal_expired",
      turnNumber: 10_400,
      publicText: "Sefirot let Auri's attack pledge expire unanswered.",
      actionID: "deal:deal_expired:deal:P_A:P_B:joint_attack:99:P_B",
      actionKind: "none",
      evidenceLevel: "state_derived",
    });
    const ledgerCounts = events.reduce<Record<string, number>>(
      (counts, event) => ({
        ...counts,
        [event.event]: (counts[event.event] ?? 0) + 1,
      }),
      {},
    );
    const publicCounts = publicDealEvents.reduce<Record<string, number>>(
      (counts, event) => ({
        ...counts,
        [event.kind]: (counts[event.kind] ?? 0) + 1,
      }),
      {},
    );
    expect(publicCounts).toEqual(ledgerCounts);
    expect(telemetry.dealEventCoverage).toMatchObject({
      authority: "finalized_deal_ledger",
      complete: true,
      sourceEventCount: 32,
      emittedEventCount: 32,
      droppedEventCount: 0,
      sourceCountsByKind: {
        deal_fulfilled: 30,
        deal_superseded: 1,
        deal_expired: 1,
      },
    });
  });

  it("keeps exact source audit only for decision-derived verdicts, never passive lifecycle fulfillment", () => {
    const ledger = finalizedLedger(
      [
        {
          event: "deal_violated",
          dealID: DEAL_ID,
          template: "non_aggression_pact",
          actorPlayerID: A.playerID,
          actorName: A.username,
          targetPlayerID: B.playerID,
          targetName: B.username,
          tone: "betrayal",
          importance: 96,
          publicText: "VERDICT: Auri violated the pact.",
          step: 2,
          sourceSequence: 1,
          sourceTurnNumber: 250,
          sourceFallbackUsed: true,
          sourceLlmPlannerDegraded: true,
          sourceAuditStatus: "confirmed",
          sourceAuditReason: "confirmed hostile source action",
        },
        {
          event: "deal_fulfilled",
          dealID: "deal:P_A:P_B:non_aggression_pact:3",
          template: "non_aggression_pact",
          actorPlayerID: A.playerID,
          actorName: A.username,
          targetPlayerID: B.playerID,
          targetName: B.username,
          tone: "pact",
          importance: 50,
          publicText: "Auri held the pact through its elapsed window.",
          step: 6,
          // Exact lifecycle turn, but deliberately no sourceSequence: no
          // decision can truthfully inherit an effect audit here.
          sourceTurnNumber: 600,
          sourceAuditStatus: "confirmed",
          sourceAuditReason: "must not be conflated with a decision audit",
        },
      ],
      7,
      700,
    );
    const telemetry = telemetryFor(
      [stampedRecord(1, A, {}), stampedRecord(2, B, {})],
      ledger,
    );
    expect(
      telemetry.events.find((event) => event.kind === "deal_violated"),
    ).toMatchObject({
      turnNumber: 250,
      sequence: 1,
      evidenceLevel: "state_derived",
      fallbackUsed: true,
      llmPlannerDegraded: true,
      auditStatus: "confirmed",
      auditReason: "confirmed hostile source action",
    });
    expect(
      telemetry.events.find((event) => event.kind === "deal_fulfilled"),
    ).toMatchObject({
      turnNumber: 600,
      evidenceLevel: "state_derived",
      fallbackUsed: false,
      llmPlannerDegraded: false,
      auditStatus: "not_applicable",
      auditReason: "event derived from authoritative deal lifecycle state",
    });
  });

  it("does not copy the separate gameplay action audit onto accepted deal-slot events", () => {
    const proposal = stampedRecord(1, A, {
      dealAction: "propose",
      dealID: DEAL_ID,
      dealCounterpartyID: B.playerID,
      dealCounterpartyName: B.username,
      dealApplyAccepted: true,
      dealSeparateSlot: true,
      fallbackUsed: true,
      llmPlannerDegraded: true,
      dealPublicText: "Auri proposed a pact to Sefirot.",
    });
    proposal.audit = {
      ...proposal.audit,
      auditStatus: "confirmed",
      auditReason: "the separate primary gameplay action was confirmed",
    };
    const acceptance = stampedRecord(2, B, {
      dealAction: "accept",
      dealID: DEAL_ID,
      dealCounterpartyID: A.playerID,
      dealCounterpartyName: A.username,
      dealApplyAccepted: true,
      dealSeparateSlot: true,
      dealPublicText: "Sefirot accepted Auri's pact.",
    });
    acceptance.audit = {
      ...acceptance.audit,
      auditStatus: "failed",
      auditReason: "the separate primary gameplay action failed",
    };
    const ledger = finalizedLedger([
      {
        event: "deal_proposed",
        dealID: DEAL_ID,
        template: "non_aggression_pact",
        actorPlayerID: A.playerID,
        actorName: A.username,
        targetPlayerID: B.playerID,
        targetName: B.username,
        tone: "info",
        importance: 55,
        publicText: "Auri proposed a pact to Sefirot.",
        step: 0,
      },
      {
        event: "deal_accepted",
        dealID: DEAL_ID,
        template: "non_aggression_pact",
        actorPlayerID: B.playerID,
        actorName: B.username,
        targetPlayerID: A.playerID,
        targetName: A.username,
        tone: "pact",
        importance: 78,
        publicText: "Sefirot accepted Auri's pact.",
        step: 1,
      },
    ]);
    const dealEventStreams = [
      // Legacy mirror/backfill path: decision records only, no ledger.
      telemetryFor([proposal, acceptance]),
      // New complete path: finalized ledger is authoritative.
      telemetryFor([proposal, acceptance], ledger),
    ].map((telemetry) =>
      telemetry.events.filter(
        (event) =>
          event.kind === "deal_proposed" || event.kind === "deal_accepted",
      ),
    );

    for (const dealEvents of dealEventStreams) {
      expect(dealEvents).toEqual([
        expect.objectContaining({
          kind: "deal_proposed",
          evidenceLevel: "accepted_action",
          fallbackUsed: true,
          llmPlannerDegraded: true,
          auditStatus: "not_applicable",
          auditReason:
            "deal action was accepted by the deal validator and manager; the primary gameplay action audit does not apply",
        }),
        expect.objectContaining({
          kind: "deal_accepted",
          evidenceLevel: "accepted_action",
          auditStatus: "not_applicable",
          auditReason:
            "deal action was accepted by the deal validator and manager; the primary gameplay action audit does not apply",
        }),
      ]);
      expect(JSON.stringify(dealEvents)).not.toContain(
        "primary gameplay action was confirmed",
      );
      expect(JSON.stringify(dealEvents)).not.toContain(
        "primary gameplay action failed",
      );
    }
  });

  it("feeds the drama report without disturbing its existing counters", () => {
    const records = [
      stampedRecord(1, A, {
        dealAction: "accept",
        dealID: DEAL_ID,
        dealCounterpartyID: B.playerID,
        dealCounterpartyName: B.username,
        dealApplyAccepted: true,
        dealPublicText:
          "Auri accepted Sefirot's non-aggression pact (12 decisions).",
      }),
      stampedRecord(2, B, {
        dealComplianceEvent: JSON.stringify([
          {
            event: "deal_violated",
            dealID: DEAL_ID,
            template: "non_aggression_pact",
            actorPlayerID: B.playerID,
            actorName: B.username,
            targetPlayerID: A.playerID,
            targetName: A.username,
            tone: "betrayal",
            importance: 96,
            publicText:
              "VERDICT: Sefirot violated the pact — land attack on Auri at step 214.",
            step: 214,
          },
        ]),
      }),
    ];
    const report = buildAgentDramaReport({
      runID: "DEAL_DRAMA",
      matchID: "match-1",
      scenario: "deal-test",
      brainMode: "rule",
      records,
      roster: ROSTER,
    });
    // Deal events are new vocabulary: alliance counters stay zero, while the
    // high-importance verdict registers and surfaces as a top moment.
    expect(report.allianceFormedCount).toBe(0);
    expect(report.allianceBrokenCount).toBe(0);
    expect(report.highImportanceEventCount).toBeGreaterThanOrEqual(1);
    expect(
      report.topMoments.some((moment) => moment.kind === "deal_violated"),
    ).toBe(true);
  });
});
