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
  const base: AgentEconomyRecordFacts = {
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
  // Mirror production derivation: unless a fixture provides pairLinks
  // explicitly (the cap-eviction cases), treat its counterparties as the
  // full list and derive the uncapped pair-link entries from it.
  base.pairLinks ??= base.counterparties
    .filter(
      (pair) =>
        pair.myEligibleDestinationsTheyOwn > 0 ||
        pair.embargoOursOnThem ||
        pair.embargoTheirsOnUs,
    )
    .map((pair) => ({
      playerID: pair.playerID,
      name: pair.name,
      links: pair.myEligibleDestinationsTheyOwn,
      embargoOursOnThem: pair.embargoOursOnThem,
      embargoTheirsOnUs: pair.embargoTheirsOnUs,
    }));
  return base;
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
      "1 of Auri's 1 factories has no City or Port on its rail network, so no trains can run from it.",
    );
    // Derived-from-state events carry the non-action marker, never a fake
    // submitted-action kind.
    expect(events.every((event) => event.actionKind === "none")).toBe(true);

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
          pairLinks: [],
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

  it("M1: capped-list eviction churn with stable uncapped links emits no severed/established events", () => {
    process.env[FLAG] = "1";
    // Nine linked counterparties: the rich list is capped at 8 and its
    // membership churns between records (structural rank), but the UNCAPPED
    // pairLinks are identical — no pair transition actually happened.
    const allPairs = Array.from({ length: 9 }, (_, index) =>
      counterparty({
        playerID: `p${index + 10}`,
        name: `N${index + 10}`,
        myEligibleDestinationsTheyOwn: 1,
        eligibleDestinationSharePct: 11,
      }),
    );
    const pairLinks = allPairs.map((pair) => ({
      playerID: pair.playerID,
      name: pair.name,
      links: 1,
      embargoOursOnThem: false,
      embargoTheirsOnUs: false,
    }));
    const first = facts({
      factoryCount: 1,
      operationalFactoryCount: 1,
      eligibleDestinationCount: 9,
      counterparties: allPairs.slice(0, 8), // cap drops p18
      pairLinks,
    });
    const churned = facts({
      factoryCount: 1,
      operationalFactoryCount: 1,
      eligibleDestinationCount: 9,
      counterparties: allPairs.slice(1, 9), // churn: drops p10, admits p18
      pairLinks,
    });
    const events = economyEvents([
      record(1, first),
      record(2, churned),
      record(3, churned),
    ]);

    // All nine real links establish once from the zero baseline (turn 100);
    // cap churn afterwards produces NOTHING — no severed events, no
    // re-established events, and no false "stations destroyed" claims.
    expect(
      events.filter((event) => event.kind === "trade_severed"),
    ).toHaveLength(0);
    const established = events.filter(
      (event) => event.kind === "trade_link_established",
    );
    expect(established).toHaveLength(9);
    expect(established.every((event) => event.turnNumber === 100)).toBe(true);
    expect(
      events.some((event) =>
        (event.publicText ?? "").includes("destroyed or changed owners"),
      ),
    ).toBe(false);
  });

  it("M1: a real embargo still severs with exact attribution even when the cap evicts the pair from the rich list", () => {
    process.env[FLAG] = "1";
    const others = Array.from({ length: 8 }, (_, index) =>
      counterparty({
        playerID: `p${index + 10}`,
        name: `N${index + 10}`,
        myEligibleDestinationsTheyOwn: 1,
        eligibleDestinationSharePct: 11,
      }),
    );
    const sefirot = counterparty({
      myEligibleDestinationsTheyOwn: 1,
      eligibleDestinationSharePct: 11,
    }); // playerID p2, resolves to agent a2 ("Sefirot")
    const linkedPairLinks = [sefirot, ...others].map((pair) => ({
      playerID: pair.playerID,
      name: pair.name,
      links: 1,
      embargoOursOnThem: false,
      embargoTheirsOnUs: false,
    }));
    const linked = facts({
      factoryCount: 1,
      operationalFactoryCount: 1,
      eligibleDestinationCount: 9,
      counterparties: [sefirot, ...others.slice(0, 7)],
      pairLinks: linkedPairLinks,
    });
    // Sefirot embargoes Auri: links drop to zero AND the pair falls out of
    // the capped rich list at the same decision. The pairLinks entry (kept
    // because of the embargo edge) still carries the exact attribution.
    const severed = facts({
      factoryCount: 1,
      blockedFactoryCount: 1,
      eligibleDestinationCount: 8,
      embargoBlockedDestinationCount: 1,
      counterparties: others, // Sefirot evicted by rank churn
      pairLinks: [
        {
          playerID: "p2",
          name: "Sefirot",
          links: 0,
          embargoOursOnThem: false,
          embargoTheirsOnUs: true,
        },
        ...linkedPairLinks.slice(1),
      ],
    });
    const events = economyEvents([record(1, linked), record(2, severed)]);

    const severedEvents = events.filter(
      (event) => event.kind === "trade_severed",
    );
    expect(severedEvents).toHaveLength(1);
    expect(severedEvents[0].turnNumber).toBe(200);
    expect(severedEvents[0].targetAgentID).toBe("a2");
    expect(severedEvents[0].publicText).toBe(
      "Sefirot's embargo on Auri cut Auri's eligible rail destinations owned by Sefirot to zero.",
    );
  });

  it("m4: flag OFF telemetry is byte-identical with vs without economyFacts on the records (whole object, generatedAt normalized)", () => {
    delete process.env[FLAG];
    const richFacts = facts({
      factoryCount: 2,
      operationalFactoryCount: 1,
      idleFactoryCount: 1,
      eligibleDestinationCount: 2,
      counterparties: [
        counterparty({
          myEligibleDestinationsTheyOwn: 2,
          eligibleDestinationSharePct: 100,
        }),
      ],
    });
    const build = (economyFacts: AgentEconomyRecordFacts | undefined) =>
      telemetryFor([
        record(1, economyFacts, {
          chosenActionKind: "attack",
          chosenActionID: "attack:p2",
          chosenActionMetadata: { targetID: "p2", targetName: "Sefirot" },
        }),
        record(2, economyFacts, {
          chosenActionKind: "alliance_request",
          chosenActionID: "alliance_request:p2",
          chosenActionMetadata: { recipientID: "p2", recipientName: "Sefirot" },
        }),
      ]);
    const normalize = (telemetry: unknown) =>
      JSON.stringify({
        ...(telemetry as Record<string, unknown>),
        generatedAt: "NORMALIZED",
      });
    expect(normalize(build(richFacts))).toBe(normalize(build(undefined)));
  });
});
