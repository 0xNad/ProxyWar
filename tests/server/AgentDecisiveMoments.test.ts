import { describe, expect, it } from "vitest";
import {
  buildAgentDecisiveMoments,
  sanitizeStatedReason,
  MAX_DECISIVE_MOMENTS,
  MIN_DECISIVE_MOMENTS,
} from "../../src/server/agents/AgentDecisiveMoments";
import { buildAgentMatchStateSeries } from "../../src/server/agents/AgentMatchStateSeries";
import type { AgentSpectatorSnapshot } from "../../src/server/agents/AgentSpectatorReplay";
import type { SpectatorEvent } from "../../src/server/agents/AgentSpectatorTelemetry";
import {
  buildFixtureSeries,
  FIXTURE_EVENTS,
  FIXTURE_SNAPSHOTS,
} from "./AgentMatchStateSeries.test";

/**
 * Reuses the shared hand-computed fixture (`AgentMatchStateSeries.test.ts`)
 * — the same real numbers `AgentMatchStateDerivations.test.ts` verifies —
 * so this suite only has to check moment SELECTION/shape, not re-derive the
 * underlying lead-change/reversal/elimination/swing math a third time.
 */

const CONFIRMED_FIXTURE_EVENTS: SpectatorEvent[] = FIXTURE_EVENTS.map(
  (event) => ({
    ...event,
    evidenceLevel: "confirmed_effect",
    fallbackUsed: false,
    llmPlannerDegraded: false,
    auditStatus: "confirmed",
  }),
);

describe("buildAgentDecisiveMoments", () => {
  it("selects between MIN and MAX moments, chronologically ordered, deduplicated across the same real swing", () => {
    const series = buildFixtureSeries();
    const artifact = buildAgentDecisiveMoments({
      runID: "run-fixture",
      series,
      telemetryEvents: CONFIRMED_FIXTURE_EVENTS,
      totalTurns: 50,
      replaySnapshots: FIXTURE_SNAPSHOTS,
    });
    expect(artifact).not.toBeNull();
    const moments = artifact!.moments;
    expect(moments.length).toBeGreaterThanOrEqual(MIN_DECISIVE_MOMENTS);
    expect(moments.length).toBeLessThanOrEqual(MAX_DECISIVE_MOMENTS);
    for (let i = 1; i < moments.length; i += 1) {
      expect(moments[i].turn).toBeGreaterThanOrEqual(moments[i - 1].turn);
    }
    // Delta's turn-50 lead change and the same-turn-50 rank-1 reversal are
    // the SAME real swing — only one moment should survive at that turn.
    const at50 = moments.filter((m) => m.turn === 50);
    expect(at50).toHaveLength(1);
  });

  it("every moment carries a real before/after state and a jump turn equal to its own turn", () => {
    const series = buildFixtureSeries();
    const artifact = buildAgentDecisiveMoments({
      runID: "run-fixture",
      series,
      telemetryEvents: CONFIRMED_FIXTURE_EVENTS,
      totalTurns: 50,
      replaySnapshots: FIXTURE_SNAPSHOTS,
    });
    for (const moment of artifact!.moments) {
      expect(moment.jumpToReplayTurn).toBe(moment.turn);
      expect(moment.afterState).not.toBeNull();
      expect(moment.headline.length).toBeGreaterThan(0);
      expect(moment.involvedAgents.length).toBeGreaterThan(0);
    }
  });

  it("is deterministic — identical input produces an identical artifact", () => {
    const series = buildFixtureSeries();
    const input = {
      runID: "run-fixture",
      series,
      telemetryEvents: CONFIRMED_FIXTURE_EVENTS,
      totalTurns: 50,
      replaySnapshots: FIXTURE_SNAPSHOTS,
    };
    const first = buildAgentDecisiveMoments(input);
    const second = buildAgentDecisiveMoments(input);
    // `generatedAt` is a real wall-clock timestamp (see the module doc),
    // never itself claimed deterministic — everything else must match.
    expect(first?.moments).toEqual(second?.moments);
    expect(first?.schemaVersion).toEqual(second?.schemaVersion);
    expect(first?.runID).toEqual(second?.runID);
  });

  it("elevates only clean state-derived deal verdicts and keeps the exact agent claim bound to the server fact", () => {
    const verdict = {
      id: "7:700:deal_violated",
      sequence: 700,
      turnNumber: 7,
      kind: "deal_violated",
      tone: "betrayal",
      actorAgentID: "agent-p4",
      actorName: "Delta",
      targetAgentID: "agent-p1",
      targetName: "Alpha",
      message: "VERDICT: Delta violated the pact by attacking Alpha.",
      publicText: "VERDICT: Delta violated the pact by attacking Alpha.",
      statedReason: "Alpha became too dangerous to leave alone.",
      actionKind: "none",
      actionID: "deal:deal_violated:fixture",
      evidenceLevel: "state_derived",
      fallbackUsed: false,
      llmPlannerDegraded: false,
      auditStatus: "not_applicable",
      importance: 96,
    } satisfies SpectatorEvent;
    const artifact = buildAgentDecisiveMoments({
      runID: "run-deal-verdict",
      series: buildFixtureSeries(),
      telemetryEvents: [...CONFIRMED_FIXTURE_EVENTS, verdict],
      totalTurns: 50,
      replaySnapshots: FIXTURE_SNAPSHOTS,
    });
    const moment = artifact?.moments.find(
      (candidate) => candidate.type === "deal_violated",
    );
    expect(moment).toMatchObject({
      turn: 7,
      headline: verdict.publicText,
      involvedAgents: ["Delta", "Alpha"],
      statedReason: verdict.statedReason,
    });

    const notVerdicts: SpectatorEvent[] = [
      { ...verdict, id: "accepted", evidenceLevel: "accepted_action" },
      { ...verdict, id: "fallback", fallbackUsed: true },
      { ...verdict, id: "degraded", llmPlannerDegraded: true },
      {
        ...verdict,
        id: "passive-fulfillment",
        kind: "deal_fulfilled",
        importance: 62,
      },
    ];
    const filtered = buildAgentDecisiveMoments({
      runID: "run-filtered-deal-verdicts",
      series: buildFixtureSeries(),
      telemetryEvents: [...CONFIRMED_FIXTURE_EVENTS, ...notVerdicts],
      totalTurns: 50,
      replaySnapshots: FIXTURE_SNAPSHOTS,
    });
    expect(
      filtered?.moments.some(
        (candidate) =>
          candidate.type === "deal_violated" ||
          candidate.type === "deal_fulfilled",
      ),
    ).toBe(false);
  });

  it("does not turn accepted audit-unknown effects into alliance-betrayal or final-confrontation moments", () => {
    const unknownBase = {
      tone: "war",
      actorAgentID: "agent-p1",
      actorName: "Alpha",
      targetAgentID: "agent-p2",
      targetName: "Bravo",
      publicText: "Accepted action; effect not observed.",
      message: "Accepted action; effect not observed.",
      actionKind: "attack",
      evidenceLevel: "accepted_action",
      fallbackUsed: false,
      llmPlannerDegraded: false,
      auditStatus: "unknown",
      auditReason: "effect not observed",
      importance: 100,
    } as const;
    const unknownEffects: SpectatorEvent[] = [
      {
        ...unknownBase,
        id: "unknown-alliance",
        sequence: 5,
        turnNumber: 5,
        kind: "alliance_formed",
        tone: "pact",
        actionKind: "alliance_request",
        actionID: "alliance_request:unknown",
      },
      {
        ...unknownBase,
        id: "unknown-break",
        sequence: 35,
        turnNumber: 35,
        kind: "alliance_break",
        tone: "betrayal",
        actionKind: "break_alliance",
        actionID: "break_alliance:unknown",
      },
      {
        ...unknownBase,
        id: "unknown-attack",
        sequence: 45,
        turnNumber: 45,
        kind: "attack",
        actionID: "attack:unknown",
      },
      {
        ...unknownBase,
        id: "unknown-nuke",
        sequence: 48,
        turnNumber: 48,
        kind: "nuke",
        tone: "threat",
        actionKind: "nuke",
        actionID: "nuke:unknown",
      },
    ];
    const artifact = buildAgentDecisiveMoments({
      runID: "run-unconfirmed-effects",
      series: buildFixtureSeries(),
      telemetryEvents: unknownEffects,
      totalTurns: 50,
      replaySnapshots: FIXTURE_SNAPSHOTS,
    });

    expect(artifact).not.toBeNull();
    expect(
      artifact?.moments.some(
        (moment) =>
          moment.type === "alliance_betrayal" ||
          moment.type === "final_confrontation",
      ),
    ).toBe(false);
  });

  it("finds a stated reason from the replay's per-snapshot decision log when one exists for an involved agent near the moment turn", () => {
    const snapshotsWithDecision: AgentSpectatorSnapshot[] = FIXTURE_SNAPSHOTS.map((snapshot) =>
      snapshot.turnNumber === 50
        ? {
            ...snapshot,
            decisions: [
              {
                sequence: 1,
                agentID: "agent-p4",
                username: "Delta",
                profile: "aggressive",
                brainType: "planner-executor",
                turnNumber: 50,
                selectedLegalActionId: "attack:1",
                selectedActionKind: "attack",
                reason: "Delta presses the advantage while Bravo is overextended.",
                decisionLatencyMs: 10,
                accepted: true,
                resultReason: "ok",
                fallbackUsed: false,
                intentSummary: "attack",
              },
            ],
          }
        : snapshot,
    );
    const series = buildAgentMatchStateSeries({
      runID: "run-fixture",
      matchID: "match-fixture",
      replay: { snapshots: snapshotsWithDecision },
      telemetry: null,
    })!;
    const artifact = buildAgentDecisiveMoments({
      runID: "run-fixture",
      series,
      telemetryEvents: [],
      totalTurns: 50,
      replaySnapshots: snapshotsWithDecision,
    });
    const at50 = artifact!.moments.find((m) => m.turn === 50)!;
    expect(at50.statedReason).toBe(
      "Delta presses the advantage while Bravo is overextended.",
    );
  });

  it("returns null (never padded) when fewer than MIN_DECISIVE_MOMENTS candidates are supported", () => {
    // A flat, eventless match: nobody's territory share ever moves.
    const flatSnapshots: AgentSpectatorSnapshot[] = [0, 10, 20].map((turn) => ({
      label: `t${turn}`,
      turnNumber: turn,
      tick: turn,
      phase: "active" as const,
      decisions: [],
      players: [
        {
          agentID: "agent-p1",
          clientID: "c1",
          playerID: "p1",
          username: "Alpha",
          profile: null,
          brainType: null,
          color: "#000",
          isAlive: true,
          hasSpawned: true,
          tilesOwned: 10,
          troops: 100,
          gold: "0",
          tiles: [],
          units: [],
        },
        {
          agentID: "agent-p2",
          clientID: "c2",
          playerID: "p2",
          username: "Bravo",
          profile: null,
          brainType: null,
          color: "#000",
          isAlive: true,
          hasSpawned: true,
          tilesOwned: 10,
          troops: 100,
          gold: "0",
          tiles: [],
          units: [],
        },
      ],
    }));
    const series = buildAgentMatchStateSeries({
      runID: "run-flat",
      matchID: "match-flat",
      replay: { snapshots: flatSnapshots },
      telemetry: null,
    })!;
    const artifact = buildAgentDecisiveMoments({
      runID: "run-flat",
      series,
      telemetryEvents: [],
      totalTurns: 20,
      replaySnapshots: flatSnapshots,
    });
    expect(artifact).toBeNull();
  });
});

describe("buildAgentDecisiveMoments — importance rebalance (real-production-data quality pass)", () => {
  /**
   * A real-production-data editorial review of ~10 retained matches found
   * `reversal` candidates from the volatile opening spawn/expansion phase
   * (huge rank-place swings, small real consequence) systematically
   * crowding out genuinely decisive `lead_change`/late `territorial_swing`
   * moments. This fixture reproduces the pattern directly: Alpha leads
   * early; Bravo overtakes for a large, confirmed, held lead at turn 2000
   * (the match's real turning point); Charlie has an EARLY 3-place
   * reversal (rank 3->6, turn 0->1000) AND a LATER 3-place reversal of
   * the same magnitude climbing back (rank 6->3, turn 1000->8000).
   */
  function player(playerID: string, username: string, tilesOwned: number, isAlive = true) {
    return {
      agentID: `agent-${playerID}`,
      clientID: `c-${playerID}`,
      playerID,
      username,
      profile: null,
      brainType: null,
      color: "#000",
      isAlive,
      hasSpawned: true,
      tilesOwned,
      troops: 100,
      gold: "0",
      tiles: [],
      units: [],
    };
  }
  function snapshot(turnNumber: number, players: ReturnType<typeof player>[]): AgentSpectatorSnapshot {
    return { label: `t${turnNumber}`, turnNumber, tick: turnNumber, phase: "active", decisions: [], players };
  }
  function buildFixture() {
    const snapshots: AgentSpectatorSnapshot[] = [
      snapshot(0, [
        player("p1", "Alpha", 30),
        player("p2", "Bravo", 25),
        player("p3", "Charlie", 20),
        player("p4", "Delta", 15),
        player("p5", "Echo", 10),
        player("p6", "Foxtrot", 5),
      ]),
      snapshot(1000, [
        player("p1", "Alpha", 32),
        player("p2", "Bravo", 27),
        player("p3", "Charlie", 3),
        player("p4", "Delta", 17),
        player("p5", "Echo", 12),
        player("p6", "Foxtrot", 9),
      ]),
      snapshot(2000, [
        player("p1", "Alpha", 20),
        player("p2", "Bravo", 45),
        player("p3", "Charlie", 5),
        player("p4", "Delta", 15),
        player("p5", "Echo", 10),
        player("p6", "Foxtrot", 5, false),
      ]),
      snapshot(8000, [
        player("p1", "Alpha", 15),
        player("p2", "Bravo", 50),
        player("p3", "Charlie", 10),
        player("p4", "Delta", 10),
        player("p5", "Echo", 10),
        player("p6", "Foxtrot", 0, false),
      ]),
      snapshot(10000, [
        player("p1", "Alpha", 10),
        player("p2", "Bravo", 55),
        player("p3", "Charlie", 10),
        player("p4", "Delta", 10),
        player("p5", "Echo", 10),
        player("p6", "Foxtrot", 0, false),
      ]),
    ];
    const series = buildAgentMatchStateSeries({
      runID: "run-rebalance",
      matchID: "match-rebalance",
      replay: { snapshots },
      telemetry: null,
    })!;
    return buildAgentDecisiveMoments({
      runID: "run-rebalance",
      series,
      telemetryEvents: [],
      totalTurns: series.totalTurns,
      replaySnapshots: snapshots,
    });
  }

  it("selects the confirmed lead change over Charlie's same-magnitude EARLY reversal — the real turning point wins", () => {
    const artifact = buildFixture();
    expect(artifact).not.toBeNull();
    const leadChangeMoment = artifact!.moments.find((m) => m.type === "lead_change");
    expect(leadChangeMoment).toBeDefined();
    expect(leadChangeMoment!.turn).toBe(2000);
    expect(leadChangeMoment!.headline).toBe("Bravo overtakes Alpha for the territory lead.");
  });

  it("prefers Charlie's LATER reversal (turn 8000, climbing back) over the earlier same-magnitude one (turn 1000, collapsing) once both are candidates", () => {
    const artifact = buildFixture();
    expect(artifact).not.toBeNull();
    const reversalMoment = artifact!.moments.find((m) => m.type === "reversal");
    expect(reversalMoment).toBeDefined();
    expect(reversalMoment!.turn).toBe(8000);
    expect(reversalMoment!.headline).toBe("Charlie claws back to 3rd place from 6th.");
  });

  it("stays within the 3-5 bound and chronologically ordered even with the rebalanced weights", () => {
    const artifact = buildFixture();
    expect(artifact).not.toBeNull();
    expect(artifact!.moments.length).toBeGreaterThanOrEqual(MIN_DECISIVE_MOMENTS);
    expect(artifact!.moments.length).toBeLessThanOrEqual(MAX_DECISIVE_MOMENTS);
    for (let i = 1; i < artifact!.moments.length; i += 1) {
      expect(artifact!.moments[i].turn).toBeGreaterThanOrEqual(artifact!.moments[i - 1].turn);
    }
  });
});

describe("sanitizeStatedReason", () => {
  it("PRODUCTION INCIDENT: rejects the exact raw LLM-provider error string that shipped publicly (HTTP 403 'Invalid API Key format')", () => {
    expect(
      sanitizeStatedReason(
        'LLM decision rejected (LLM provider failed: HTTP 403 "Invalid API Key format"); fallback: expand toward the nearest neutral territory',
      ),
    ).toBeNull();
  });

  it("rejects other real provider/network-failure error shapes", () => {
    expect(
      sanitizeStatedReason(
        "LLM provider failed: OpenAI Responses API returned invalid JSON: Unexpected token < in JSON at position 0",
      ),
    ).toBeNull();
    expect(sanitizeStatedReason("Error: connect ECONNREFUSED 127.0.0.1:443")).toBeNull();
    expect(sanitizeStatedReason("Request timed out after 15000ms")).toBeNull();
    expect(sanitizeStatedReason("fetch failed")).toBeNull();
    expect(sanitizeStatedReason("Rate limited by upstream provider")).toBeNull();
  });

  it("rejects HTTP status code vocabulary", () => {
    expect(sanitizeStatedReason("HTTP 500 Internal Server Error")).toBeNull();
    expect(sanitizeStatedReason("Request failed with status 429")).toBeNull();
    expect(sanitizeStatedReason("401 Unauthorized")).toBeNull();
  });

  it("rejects stack-trace-shaped text", () => {
    expect(
      sanitizeStatedReason(
        "TypeError: Cannot read properties of undefined (reading foo)\n    at Object.<anonymous> (/app/src/server/agents/LlmAgentBrain.ts:88:20)",
      ),
    ).toBeNull();
    expect(sanitizeStatedReason("Failure at LlmDecisionParser.ts:73 during parse")).toBeNull();
  });

  it("rejects serialized JSON/object-shaped payloads (does not start like prose)", () => {
    expect(
      sanitizeStatedReason('{"actionKind":"attack","targetID":"p-victim","confidence":0.8}'),
    ).toBeNull();
    expect(sanitizeStatedReason('["attack", "expand", "hold"]')).toBeNull();
  });

  it("rejects empty, whitespace-only, and overlong text", () => {
    expect(sanitizeStatedReason("")).toBeNull();
    expect(sanitizeStatedReason("   \n\t  ")).toBeNull();
    expect(sanitizeStatedReason("x".repeat(401))).toBeNull();
  });

  it("preserves genuine prose reasons unchanged, including ones that mention adjacent-but-not-denylisted words", () => {
    expect(
      sanitizeStatedReason(
        "Pressing the attack now while their defenses are still spread thin from the earlier naval assault.",
      ),
    ).toBe(
      "Pressing the attack now while their defenses are still spread thin from the earlier naval assault.",
    );
    expect(
      sanitizeStatedReason(
        "Forming an alliance with Bravo to counter the growing threat from the north.",
      ),
    ).toBe("Forming an alliance with Bravo to counter the growing threat from the north.");
    expect(
      sanitizeStatedReason(
        "This alliance offer seems suspicious given their recent history, declining for now.",
      ),
    ).toBe(
      "This alliance offer seems suspicious given their recent history, declining for now.",
    );
  });

  it("trims surrounding whitespace on an otherwise-valid reason", () => {
    expect(sanitizeStatedReason("  Holding position to consolidate the northern border.  ")).toBe(
      "Holding position to consolidate the northern border.",
    );
  });
});

describe("buildAgentDecisiveMoments — statedReason sanitization (P0 integration)", () => {
  it("a contaminated NEAREST decision degrades statedReason to null — the honest-absence convention, never the raw junk", () => {
    const snapshotsWithBadDecision: AgentSpectatorSnapshot[] = FIXTURE_SNAPSHOTS.map((snapshot) =>
      snapshot.turnNumber === 50
        ? {
            ...snapshot,
            decisions: [
              {
                sequence: 1,
                agentID: "agent-p4",
                username: "Delta",
                profile: "aggressive",
                brainType: "planner-executor",
                turnNumber: 50,
                selectedLegalActionId: "attack:1",
                selectedActionKind: "attack",
                reason:
                  'LLM decision rejected (LLM provider failed: HTTP 403 "Invalid API Key format"); fallback: expand toward the nearest neutral territory',
                decisionLatencyMs: 10,
                accepted: true,
                resultReason: "ok",
                fallbackUsed: false,
                intentSummary: "attack",
              },
            ],
          }
        : snapshot,
    );
    const series = buildAgentMatchStateSeries({
      runID: "run-fixture",
      matchID: "match-fixture",
      replay: { snapshots: snapshotsWithBadDecision },
      telemetry: null,
    })!;
    const artifact = buildAgentDecisiveMoments({
      runID: "run-fixture",
      series,
      telemetryEvents: [],
      totalTurns: 50,
      replaySnapshots: snapshotsWithBadDecision,
    });
    const at50 = artifact!.moments.find((m) => m.turn === 50)!;
    expect(at50.statedReason).toBeNull();
  });

  it("falls through a contaminated near decision to a genuine one slightly farther away within the same window", () => {
    const snapshotsWithMixedDecisions: AgentSpectatorSnapshot[] = FIXTURE_SNAPSHOTS.map(
      (snapshot) => {
        if (snapshot.turnNumber === 50) {
          return {
            ...snapshot,
            decisions: [
              {
                sequence: 1,
                agentID: "agent-p4",
                username: "Delta",
                profile: "aggressive",
                brainType: "planner-executor",
                turnNumber: 50,
                selectedLegalActionId: "attack:1",
                selectedActionKind: "attack",
                reason: "Error: connect ECONNREFUSED 127.0.0.1:443",
                decisionLatencyMs: 10,
                accepted: true,
                resultReason: "ok",
                fallbackUsed: false,
                intentSummary: "attack",
              },
            ],
          };
        }
        if (snapshot.turnNumber === 40) {
          return {
            ...snapshot,
            decisions: [
              {
                sequence: 1,
                agentID: "agent-p4",
                username: "Delta",
                profile: "aggressive",
                brainType: "planner-executor",
                turnNumber: 40,
                selectedLegalActionId: "attack:1",
                selectedActionKind: "attack",
                reason: "Delta commits to the final push while Bravo's forces are overextended.",
                decisionLatencyMs: 10,
                accepted: true,
                resultReason: "ok",
                fallbackUsed: false,
                intentSummary: "attack",
              },
            ],
          };
        }
        return snapshot;
      },
    );
    const series = buildAgentMatchStateSeries({
      runID: "run-fixture",
      matchID: "match-fixture",
      replay: { snapshots: snapshotsWithMixedDecisions },
      telemetry: null,
    })!;
    const artifact = buildAgentDecisiveMoments({
      runID: "run-fixture",
      series,
      telemetryEvents: [],
      totalTurns: 50,
      replaySnapshots: snapshotsWithMixedDecisions,
    });
    const at50 = artifact!.moments.find((m) => m.turn === 50)!;
    expect(at50.statedReason).toBe(
      "Delta commits to the final push while Bravo's forces are overextended.",
    );
  });
});
