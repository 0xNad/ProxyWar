import { afterEach, describe, expect, it } from "vitest";
import { buildAgentSpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";
import type {
  AgentDecisionRecord,
  AgentEconomyRecordCounterpartyFacts,
  AgentEconomyRecordFacts,
} from "../../src/server/agents/AgentTypes";

// Phase A economy spectator events (PROXYWAR_TUNE_ECONOMY_EVENTS, default
// OFF): derived transition-only from the compact economy facts stamped on
// decision records; absent entirely without the flag; bounded per agent;
// server-authored one-sentence publicText that keeps physical connection,
// trade eligibility, relationship, and income distinct and never claims an
// agent controls trains or ships.

const FLAG = "PROXYWAR_TUNE_ECONOMY_EVENTS";

const ECONOMY_KINDS = [
  "factory_operational",
  "factory_idle",
  "trade_link_established",
  "trade_severed",
  "economy_dependency",
] as const;

const ROSTER = [
  {
    agentID: "a1",
    username: "Auri",
    profile: "diplomatic" as const,
    clientID: "c1",
    brainType: "planner-executor" as const,
  },
  {
    agentID: "a2",
    username: "Sefirot",
    profile: "aggressive" as const,
    clientID: "c2",
    brainType: "planner-executor" as const,
  },
];

function counterparty(
  overrides: Partial<AgentEconomyRecordCounterpartyFacts> = {},
): AgentEconomyRecordCounterpartyFacts {
  return {
    playerID: "p2",
    name: "Sefirot",
    isAllied: false,
    myEligibleDestinationsTheyOwn: 0,
    eligibleDestinationSharePct: null,
    embargoOursOnThem: false,
    embargoTheirsOnUs: false,
    ...overrides,
  };
}

function facts(
  overrides: Partial<AgentEconomyRecordFacts> = {},
): AgentEconomyRecordFacts {
  return {
    factoryCount: 0,
    operationalFactoryCount: 0,
    idleFactoryCount: 0,
    blockedFactoryCount: 0,
    eligibleDestinationCount: 0,
    embargoBlockedDestinationCount: 0,
    counterparties: [],
    bottleneckKind: "none",
    ...overrides,
  };
}

function record(
  sequence: number,
  economyFacts: AgentEconomyRecordFacts | undefined,
  extra: Partial<AgentDecisionRecord> = {},
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "ECONOMY",
    agentID: "a1",
    clientID: "client-a1",
    username: "Auri",
    profile: "diplomatic",
    brainType: "planner-executor",
    turnNumber: sequence * 100,
    decidedAt: Date.UTC(2026, 0, 1, 0, 0, sequence),
    decisionLatencyMs: 10,
    observationSummary: "Auri sees the board",
    legalActionIDs: ["hold"],
    legalActionIDsByKind: { hold: ["hold"] },
    attackActionIDs: [],
    chosenActionID: "hold",
    chosenActionKind: "hold",
    reason: "test",
    chosenActionMetadata: {},
    ...(economyFacts !== undefined ? { economyFacts } : {}),
    intent: null,
    result: { accepted: true, reason: "accepted", submittedIntent: null },
    audit: {
      auditStatus: "not_applicable",
      auditReason: "hold",
      after: {
        tick: sequence,
        playerID: "p1",
        isAlive: true,
        hasSpawned: true,
        tilesOwned: 10,
        troops: 1000,
        gold: "100",
        unitCounts: {},
        outgoingAttackTargetIDs: [],
        outgoingAllianceRequestRecipientIDs: [],
        outgoingEmbargoTargetIDs: [],
      },
    },
    ...extra,
  };
}

function telemetryFor(records: AgentDecisionRecord[]) {
  return buildAgentSpectatorTelemetry({
    runID: "economy-events-run",
    roster: ROSTER,
    records,
    finalState: {
      phase: "finished",
      tick: 900,
      turnCount: 900,
      players: [
        {
          agentID: "a1",
          username: "Auri",
          profile: "diplomatic",
          playerID: "p1",
          isAlive: true,
          tilesOwned: 100,
          troops: 1000,
          gold: "100",
        },
        {
          agentID: "a2",
          username: "Sefirot",
          profile: "aggressive",
          playerID: "p2",
          isAlive: true,
          tilesOwned: 100,
          troops: 1000,
          gold: "100",
        },
      ],
    },
  });
}

function economyEvents(records: AgentDecisionRecord[]) {
  return telemetryFor(records).events.filter((event) =>
    (ECONOMY_KINDS as readonly string[]).includes(event.kind),
  );
}

describe("AgentSpectatorTelemetry economy events (PROXYWAR_TUNE_ECONOMY_EVENTS)", () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it("flag OFF: records carrying economy facts produce zero economy events", () => {
    delete process.env[FLAG];
    const events = economyEvents([
      record(1, facts({ factoryCount: 1, idleFactoryCount: 1 })),
      record(2, facts({ factoryCount: 1, operationalFactoryCount: 1 })),
    ]);
    expect(events).toHaveLength(0);
  });

  it("emits once per transition (idle -> operational -> link -> severed) with correct kinds, targets, and vocabulary-safe text", () => {
    process.env[FLAG] = "1";
    const idle = facts({ factoryCount: 1, idleFactoryCount: 1 });
    const operationalLinked = facts({
      factoryCount: 1,
      operationalFactoryCount: 1,
      eligibleDestinationCount: 3,
      counterparties: [
        counterparty({
          myEligibleDestinationsTheyOwn: 1,
          eligibleDestinationSharePct: 33,
        }),
      ],
    });
    const severedByTheirEmbargo = facts({
      factoryCount: 1,
      blockedFactoryCount: 1,
      embargoBlockedDestinationCount: 1,
      counterparties: [
        counterparty({
          myEligibleDestinationsTheyOwn: 0,
          eligibleDestinationSharePct: 0,
          embargoTheirsOnUs: true,
        }),
      ],
    });
    const events = economyEvents([
      record(1, idle),
      record(2, idle), // unchanged state: no duplicate event
      record(3, operationalLinked),
      record(4, operationalLinked), // unchanged again
      record(5, severedByTheirEmbargo),
    ]);

    expect(events.map((event) => event.kind)).toEqual([
      "factory_idle",
      "factory_operational",
      "trade_link_established",
      "factory_idle",
      "trade_severed",
    ]);

    const idleEvent = events[0];
    expect(idleEvent.turnNumber).toBe(100);
    expect(idleEvent.publicText).toBe(
      "1 of Auri's 1 factories have no City or Port on their rail network, so no trains can run from them.",
    );

    const operationalEvent = events[1];
    expect(operationalEvent.turnNumber).toBe(300);
    expect(operationalEvent.publicText).toContain("eligible City or Port");

    const linkEvent = events[2];
    expect(linkEvent.targetAgentID).toBe("a2");
    expect(linkEvent.publicText).toBe(
      "Auri's rail network reaches 1 eligible destination owned by Sefirot; trade between them is not embargoed.",
    );

    const severedEvent = events[4];
    expect(severedEvent.kind).toBe("trade_severed");
    expect(severedEvent.turnNumber).toBe(500);
    expect(severedEvent.targetAgentID).toBe("a2");
    // Cause attribution: the counterparty's NEW embargo did it.
    expect(severedEvent.publicText).toBe(
      "Sefirot's embargo on Auri cut Auri's eligible rail destinations owned by Sefirot to zero.",
    );

    // Vocabulary discipline: no event claims the agent drives trains/ships.
    for (const event of events) {
      expect(event.publicText).not.toMatch(
        /(sent|routed|dispatched|stopped) (a|the|its) train/i,
      );
      expect(event.publicText).not.toMatch(/earn(s|ed)? \d/i);
    }
  });

  it("economy_dependency fires only when the share crosses the 50% threshold, naming the counterparty and alliance state", () => {
    process.env[FLAG] = "1";
    const below = facts({
      factoryCount: 1,
      operationalFactoryCount: 1,
      eligibleDestinationCount: 3,
      counterparties: [
        counterparty({
          myEligibleDestinationsTheyOwn: 1,
          eligibleDestinationSharePct: 33,
        }),
      ],
    });
    const above = facts({
      factoryCount: 1,
      operationalFactoryCount: 1,
      eligibleDestinationCount: 3,
      counterparties: [
        counterparty({
          isAllied: true,
          myEligibleDestinationsTheyOwn: 2,
          eligibleDestinationSharePct: 66,
        }),
      ],
    });
    const events = economyEvents([
      record(1, below),
      record(2, above),
      record(3, above), // no re-fire while above threshold
    ]);
    const dependency = events.filter(
      (event) => event.kind === "economy_dependency",
    );
    expect(dependency).toHaveLength(1);
    expect(dependency[0].turnNumber).toBe(200);
    expect(dependency[0].publicText).toBe(
      "Sefirot owns 66% of the eligible City/Port destinations on Auri's rail network (allied; allied train stops pay more).",
    );
  });

  it("falls back to facts embedded in a retained economyNetwork affordance when economyFacts is absent", () => {
    process.env[FLAG] = "1";
    const affordanceRecord = record(1, undefined, {
      tacticalAffordances: {
        transportTroopBanking: {
          tacticID: "transport_troop_banking",
          nearCap: false,
          recommended: false,
          ownTroops: null,
          maxTroops: null,
          troopRatio: null,
          activeTransportCount: 0,
          activeTransportTroops: 0,
          largestActiveTransportTroops: 0,
          activeBankRatio: null,
          continuationReady: false,
          availableBoatLaunchActionCount: 0,
          availableBoatLaunchTroops: [],
          largestAvailableBoatLaunchTroops: 0,
          incomingThreatTroops: 0,
          incomingThreatRatio: null,
          homeDanger: "low",
          effectiveFutureTroops: null,
          effectiveFutureTroopRatio: null,
          reasons: [],
        },
        economyNetwork: {
          tacticID: "economy_network",
          recommended: false,
          turnNumber: 100,
          factoryCount: 1,
          operationalFactoryCount: 1,
          idleFactoryCount: 0,
          blockedFactoryCount: 0,
          clusterCount: 1,
          eligibleDestinationCount: 1,
          embargoBlockedDestinationCount: 0,
          trainSelfIncome: "0",
          trainExternalIncome: "0",
          tradeShipIncome: "0",
          topCounterpartyID: null,
          topCounterpartyName: null,
          topCounterpartyDependencyPct: null,
          topCounterpartyAllied: null,
          counterparties: [],
          bottleneckKind: "none",
          bottleneckEvidence: "1 factories operational",
          reasons: [],
        },
        notes: [],
      },
    });
    const events = economyEvents([affordanceRecord]);
    expect(events.map((event) => event.kind)).toEqual(["factory_operational"]);
  });

  it("bounds economy events per agent per match", () => {
    process.env[FLAG] = "1";
    // Oscillate idle <-> operational: each flip is a genuine transition, but
    // the per-agent bound caps the total.
    const idle = facts({ factoryCount: 1, idleFactoryCount: 1 });
    const operational = facts({
      factoryCount: 1,
      operationalFactoryCount: 1,
      eligibleDestinationCount: 1,
    });
    const records = Array.from({ length: 40 }, (_, index) =>
      record(index + 1, index % 2 === 0 ? idle : operational),
    );
    const events = economyEvents(records);
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThanOrEqual(12);
  });

  it("existing telemetry stays untouched when the flag is on but no record carries economy data", () => {
    process.env[FLAG] = "1";
    const telemetry = telemetryFor([
      record(1, undefined, {
        chosenActionKind: "attack",
        chosenActionID: "attack:p2",
        chosenActionMetadata: { targetID: "p2", targetName: "Sefirot" },
      }),
    ]);
    expect(telemetry.events.map((event) => event.kind)).toEqual(["attack"]);
  });
});
