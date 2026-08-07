import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentDramaReport } from "../../src/server/agents/AgentDramaReport";
import { buildAgentSpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";
import type { AgentDecisionRecord } from "../../src/server/agents/AgentTypes";
import { DEALS_FLAG, fabricatedRecord, type StubSeat } from "./DealTestHarness";

// Phase B spectator events (PROXYWAR_TUNE_STRUCTURED_DEALS, default OFF):
// derived from records alone (the mirror-backfill path rebuilds telemetry
// from decisions.jsonl), actionKind "none", bounded per agent, with
// server-authored publicText carried in the deal stamps. Tones per spec:
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

function telemetryFor(records: AgentDecisionRecord[]) {
  return buildAgentSpectatorTelemetry({
    runID: "DEAL_TELEMETRY",
    records,
    roster: ROSTER,
  });
}

describe("spectator telemetry — structured-deal events", () => {
  it("maps propose/accept/reject stamps to events with spec tones and actionKind none", () => {
    const records = [
      stampedRecord(1, A, {
        dealAction: "propose",
        dealID: DEAL_ID,
        dealTemplate: "non_aggression_pact",
        dealCounterpartyID: B.playerID,
        dealCounterpartyName: B.username,
        dealApplyAccepted: true,
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
    const events = telemetryFor(records).events.filter((event) =>
      event.kind.startsWith("deal_"),
    );
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      kind: "deal_proposed",
      tone: "info",
      importance: 55,
      actionKind: "none",
      actorAgentID: A.agentID,
      targetAgentID: B.agentID,
      publicText:
        "Auri proposed a non-aggression pact to Sefirot (12 decisions).",
    });
    expect(events[1]).toMatchObject({
      kind: "deal_accepted",
      tone: "pact",
      importance: 78,
      actionKind: "none",
      actorAgentID: B.agentID,
      targetAgentID: A.agentID,
    });
    expect(events[1].message).toBe(
      "Sefirot accepted Auri's non-aggression pact (12 decisions).",
    );
    expect(events[2]).toMatchObject({ kind: "deal_rejected", tone: "info" });
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
      actorAgentID: B.agentID,
      actorName: B.username,
      targetAgentID: A.agentID,
      publicText: verdict.publicText,
    });
  });

  it("bounds deal events per agent per match", () => {
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
