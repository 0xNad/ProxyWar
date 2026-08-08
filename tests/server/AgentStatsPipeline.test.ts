import { describe, expect, it } from "vitest";
import type { AgentRunFinalState } from "../../src/server/agents/AgentDecisionLogWriter";
import { buildAgentSpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";
import {
  aggregateAgentStats,
  computeMatchAgentMetrics,
  type RawMatchAgentMetrics,
} from "../../src/server/agents/AgentStatsPipeline";
import {
  AgentDecisionRecord,
  LegalActionKind,
} from "../../src/server/agents/AgentTypes";

const ROSTER = [
  {
    agentID: "a1",
    username: "Atlas",
    profile: "diplomatic" as const,
    clientID: "c1",
    brainType: "planner-executor" as const,
  },
  {
    agentID: "a2",
    username: "Blitz",
    profile: "aggressive" as const,
    clientID: "c2",
    brainType: "planner-executor" as const,
  },
  {
    agentID: "a3",
    username: "Cinder",
    profile: "opportunistic" as const,
    clientID: "c3",
    brainType: "planner-executor" as const,
  },
];

function record(
  sequence: number,
  turnNumber: number,
  agentID: string,
  username: string,
  playerID: string,
  kind: LegalActionKind,
  metadata: Record<string, string | number | boolean | null> = {},
): AgentDecisionRecord {
  return {
    sequence,
    gameID: "STATS-TEST",
    agentID,
    clientID: `client-${agentID}`,
    username,
    profile: "diplomatic",
    brainType: "planner-executor",
    turnNumber,
    decidedAt: Date.UTC(2026, 0, 1, 0, 0, sequence),
    decisionLatencyMs: 12,
    observationSummary: `${username} sees the board`,
    legalActionIDs: [`${kind}:${sequence}`],
    legalActionIDsByKind: { [kind]: [`${kind}:${sequence}`] },
    attackActionIDs: kind === "attack" ? [`${kind}:${sequence}`] : [],
    chosenActionID: `${kind}:${sequence}`,
    chosenActionKind: kind,
    reason: `${username} selects ${kind}`,
    chosenActionMetadata: metadata,
    intent: null,
    result: { accepted: true, reason: "ok", submittedIntent: null },
    audit: {
      auditStatus: "confirmed",
      auditReason: "the metrics fixture represents a realized effect",
    },
    fallbackUsed: false,
  } as AgentDecisionRecord;
}

function finalState(
  players: {
    agentID: string;
    username: string;
    tilesOwned: number;
    troops: number;
  }[],
): AgentRunFinalState {
  return {
    phase: "finished",
    tick: 10_000,
    turnCount: 10_000,
    players: players.map((p) => ({
      agentID: p.agentID,
      username: p.username,
      profile: "diplomatic",
      playerID: `p-${p.agentID}`,
      isAlive: true,
      tilesOwned: p.tilesOwned,
      troops: p.troops,
      gold: "500",
    })),
  };
}

/** Atlas<->Blitz mutually ally (2 requests -> alliance_formed), Cinder unilaterally offers Atlas (never reciprocated: only received, never accepted), Blitz later betrays Atlas, plus a mix of attacks/builds so aggregate event counts are controllable per test. */
function scenario(): AgentDecisionRecord[] {
  return [
    record(1, 100, "a1", "Atlas", "p-a1", "alliance_request", {
      recipientID: "p-a2",
      recipientName: "Blitz",
    }),
    record(2, 101, "a2", "Blitz", "p-a2", "alliance_request", {
      recipientID: "p-a1",
      recipientName: "Atlas",
    }), // -> alliance_formed(Blitz, Atlas) at turn 101
    record(3, 150, "a3", "Cinder", "p-a3", "alliance_request", {
      recipientID: "p-a1",
      recipientName: "Atlas",
    }), // Atlas received an offer from Cinder, never reciprocated
    record(4, 300, "a2", "Blitz", "p-a2", "attack", {
      targetID: "p-a3",
      targetName: "Cinder",
    }),
    record(5, 301, "a2", "Blitz", "p-a2", "attack", {
      targetID: "p-a3",
      targetName: "Cinder",
    }),
    record(6, 500, "a2", "Blitz", "p-a2", "break_alliance", {
      recipientID: "p-a1",
      recipientName: "Atlas",
    }), // betrayal: Blitz breaks the alliance it holds with Atlas
    record(7, 600, "a1", "Atlas", "p-a1", "build", {}),
    record(8, 601, "a1", "Atlas", "p-a1", "build", {}),
  ];
}

describe("computeMatchAgentMetrics", () => {
  const telemetry = buildAgentSpectatorTelemetry({
    runID: "stats-run",
    records: scenario(),
    roster: ROSTER,
    finalState: finalState([
      { agentID: "a1", username: "Atlas", tilesOwned: 300, troops: 1000 },
      { agentID: "a2", username: "Blitz", tilesOwned: 500, troops: 3000 },
      { agentID: "a3", username: "Cinder", tilesOwned: 200, troops: 1000 },
    ]),
  });

  it("returns null for an agentID absent from this match's telemetry", () => {
    expect(computeMatchAgentMetrics(telemetry, "ghost", null)).toBeNull();
  });

  it("derives alliance acceptance purely from alliance_request/alliance_formed events, never relationships[].allianceState", () => {
    const atlas = computeMatchAgentMetrics(telemetry, "a1", null);
    expect(atlas).not.toBeNull();
    // Atlas received offers from Blitz (mutual -> formed) AND Cinder (never
    // reciprocated) = 2 distinct offerors.
    expect(atlas?.offersReceivedFrom).toEqual(new Set(["a2", "a3"]));
    // Only the Blitz pair actually formed (alliance_formed touches a1<->a2).
    expect(atlas?.offersAcceptedWith).toEqual(new Set(["a2"]));
  });

  it("counts attacks, alliance requests, and economic actions per agent", () => {
    const blitz = computeMatchAgentMetrics(telemetry, "a2", null);
    expect(blitz?.attackCount).toBe(2);
    expect(blitz?.allianceRequestCount).toBe(1);
    const atlas = computeMatchAgentMetrics(telemetry, "a1", null);
    expect(atlas?.economicActionCount).toBe(2);
  });

  it("records a betrayal only for the actor of a betrayal-toned alliance_break", () => {
    const blitz = computeMatchAgentMetrics(telemetry, "a2", null);
    const atlas = computeMatchAgentMetrics(telemetry, "a1", null);
    expect(blitz?.betrayalCount).toBe(1);
    expect(atlas?.betrayalCount).toBe(0);
  });

  it("computes treaty duration as the alliance_formed -> alliance_break turn span", () => {
    const atlas = computeMatchAgentMetrics(telemetry, "a1", null);
    // formed at turn 101 (Blitz's reciprocating request), broken at turn 500.
    expect(atlas?.treatyDurationsTurns).toEqual([399]);
  });

  it("excludes accepted but unconfirmed effect kinds from persistent metrics", () => {
    const unconfirmedTelemetry = buildAgentSpectatorTelemetry({
      runID: "stats-unconfirmed",
      records: scenario().map((value) => ({ ...value, audit: undefined })),
      roster: ROSTER,
    });
    const blitz = computeMatchAgentMetrics(unconfirmedTelemetry, "a2", null);

    expect(blitz?.attackCount).toBe(0);
    expect(blitz?.offersAcceptedWith).toEqual(new Set());
    expect(blitz?.betrayalCount).toBe(0);
    expect(blitz?.treatyDurationsTurns).toEqual([]);
    // Accepted action/opportunity counts remain distinct from realized effects.
    expect(blitz?.allianceRequestCount).toBe(1);
  });

  it("computes real territory share only when a real land-tile count is supplied", () => {
    const withDenominator = computeMatchAgentMetrics(telemetry, "a1", 3_000);
    expect(withDenominator?.finalTilesOwned).toBe(300);
    expect(withDenominator?.realLandTileCount).toBe(3_000);
    const withoutDenominator = computeMatchAgentMetrics(telemetry, "a1", null);
    expect(withoutDenominator?.realLandTileCount).toBeNull();
    // Absolute tiles are always present regardless of denominator resolution.
    expect(withoutDenominator?.finalTilesOwned).toBe(300);
  });

  it("computes rank by finalTilesOwned and relative army strength by finalTroops", () => {
    const blitz = computeMatchAgentMetrics(telemetry, "a2", null);
    // Blitz has the most tiles (500) among 300/500/200 -> rank 1.
    expect(blitz?.rank).toBe(1);
    // Blitz troops 3000 / sum(1000+3000+1000)=5000 = 0.6.
    expect(blitz?.relativeArmyStrength).toBeCloseTo(0.6);
  });

  it("looks up decision reliability by agentID, and returns null decisionCount/fallbackCount when absent — never fabricated as 0", () => {
    const withReliability = computeMatchAgentMetrics(
      telemetry,
      "a2",
      null,
      new Map([
        ["a1", { decisionCount: 10, fallbackCount: 1 }],
        ["a2", { decisionCount: 40, fallbackCount: 4 }],
      ]),
    );
    expect(withReliability?.decisionCount).toBe(40);
    expect(withReliability?.fallbackCount).toBe(4);

    const noMapAtAll = computeMatchAgentMetrics(telemetry, "a2", null);
    expect(noMapAtAll?.decisionCount).toBeNull();
    expect(noMapAtAll?.fallbackCount).toBeNull();

    const notInMap = computeMatchAgentMetrics(
      telemetry,
      "a2",
      null,
      new Map([["a1", { decisionCount: 10, fallbackCount: 1 }]]),
    );
    expect(notInMap?.decisionCount).toBeNull();
    expect(notInMap?.fallbackCount).toBeNull();
  });
});

describe("aggregateAgentStats — threshold gating (spec item 2: hide below threshold)", () => {
  function rawMatch(
    overrides: Partial<RawMatchAgentMetrics> = {},
  ): RawMatchAgentMetrics {
    return {
      totalEventCount: 0,
      attackCount: 0,
      allianceRequestCount: 0,
      economicActionCount: 0,
      finalTilesOwned: null,
      realLandTileCount: null,
      rank: null,
      finalTroops: null,
      relativeArmyStrength: null,
      alliancesInitiatedCount: 0,
      offersReceivedFrom: new Set(),
      offersAcceptedWith: new Set(),
      betrayalCount: 0,
      alliedNames: [],
      adversaryCounts: new Map(),
      treatyDurationsTurns: [],
      decisionCount: null,
      fallbackCount: null,
      ...overrides,
    };
  }

  it("hides aggression below its 50-event aggregate threshold, and shows it once the threshold is met", () => {
    const belowThreshold = aggregateAgentStats([
      rawMatch({ totalEventCount: 20, attackCount: 10 }),
      rawMatch({ totalEventCount: 20, attackCount: 10 }),
    ]);
    expect(belowThreshold.fingerprint.aggression).toBeNull();

    const atThreshold = aggregateAgentStats([
      rawMatch({ totalEventCount: 30, attackCount: 15 }),
      rawMatch({ totalEventCount: 20, attackCount: 10 }),
    ]);
    expect(atThreshold.fingerprint.aggression).not.toBeNull();
    expect(atThreshold.fingerprint.aggression?.value).toBeCloseTo(0.5);
    expect(atThreshold.fingerprint.aggression?.sampleSize).toBe(50);
  });

  it("sums numerators and denominators across episodes BEFORE computing the ratio (not an average of per-episode ratios)", () => {
    // Episode 1: 90/100 attacks (0.9). Episode 2: 10/100 attacks (0.1).
    // A naive average-of-ratios would report 0.5; pooled is 100/200 = 0.5
    // here too by construction — use an UNEVEN split to distinguish them.
    const stats = aggregateAgentStats([
      rawMatch({ totalEventCount: 100, attackCount: 90 }),
      rawMatch({ totalEventCount: 300, attackCount: 30 }),
    ]);
    // Pooled: (90+30)/(100+300) = 120/400 = 0.3. Naive average would be
    // (0.9 + 0.1) / 2 = 0.5 — a materially different, wrong number.
    expect(stats.fingerprint.aggression?.value).toBeCloseTo(0.3);
  });

  it("hides alliance acceptance rate below 2 offers received, computed from offersReceivedFrom/offersAcceptedWith sets only", () => {
    const oneOffer = aggregateAgentStats([
      rawMatch({
        offersReceivedFrom: new Set(["x"]),
        offersAcceptedWith: new Set(["x"]),
      }),
    ]);
    expect(oneOffer.social.allianceAcceptanceRate).toBeNull();

    const twoOffers = aggregateAgentStats([
      rawMatch({
        offersReceivedFrom: new Set(["x", "y"]),
        offersAcceptedWith: new Set(["x"]),
      }),
    ]);
    expect(twoOffers.social.allianceAcceptanceRate?.value).toBeCloseTo(0.5);
    expect(twoOffers.social.allianceAcceptanceRate?.methodology).toContain(
      "never relationships",
    );
  });

  it("reports territory share only from episodes with a resolved real denominator, but keeps absolute tiles/rank from every episode", () => {
    const stats = aggregateAgentStats([
      rawMatch({ finalTilesOwned: 100, realLandTileCount: 1_000, rank: 2 }),
      rawMatch({ finalTilesOwned: 200, realLandTileCount: null, rank: 1 }),
    ]);
    expect(stats.fingerprint.territory.share?.sampleSize).toBe(1);
    expect(stats.fingerprint.territory.share?.value).toBeCloseTo(0.1);
    // Absolute tiles/rank draw from BOTH episodes, denominator or not.
    expect(stats.fingerprint.territory.absoluteTiles?.sampleSize).toBe(2);
    expect(stats.fingerprint.territory.absoluteTiles?.mean).toBeCloseTo(150);
    expect(stats.fingerprint.territory.meanRank?.sampleSize).toBe(2);
    expect(stats.fingerprint.territory.meanRank?.value).toBeCloseTo(1.5);
  });

  it("returns null territory share entirely when no episode ever resolved a real denominator", () => {
    const stats = aggregateAgentStats([
      rawMatch({ finalTilesOwned: 100, realLandTileCount: null, rank: 1 }),
    ]);
    expect(stats.fingerprint.territory.share).toBeNull();
    expect(stats.fingerprint.territory.absoluteTiles).not.toBeNull();
  });

  it("pools treaty durations across episodes and hides below 2 broken alliances", () => {
    const one = aggregateAgentStats([
      rawMatch({ treatyDurationsTurns: [500] }),
    ]);
    expect(one.social.treatyDuration).toBeNull();
    const two = aggregateAgentStats([
      rawMatch({ treatyDurationsTurns: [500] }),
      rawMatch({ treatyDurationsTurns: [300] }),
    ]);
    expect(two.social.treatyDuration?.value).toBeCloseTo(400);
    expect(two.social.treatyDuration?.sampleSize).toBe(2);
  });

  it("ranks frequent allies and primary adversaries by aggregate count, highest first, across episodes", () => {
    const stats = aggregateAgentStats([
      rawMatch({
        alliedNames: ["Blitz", "Cinder"],
        adversaryCounts: new Map([["Blitz", 3]]),
      }),
      rawMatch({
        alliedNames: ["Blitz"],
        adversaryCounts: new Map([
          ["Blitz", 2],
          ["Cinder", 6],
        ]),
      }),
    ]);
    expect(stats.social.frequentAllies).toEqual([
      { name: "Blitz", count: 2 },
      { name: "Cinder", count: 1 },
    ]);
    expect(stats.social.primaryAdversaries).toEqual([
      { name: "Cinder", count: 6 },
      { name: "Blitz", count: 5 },
    ]);
  });

  it("hides reliability below its 30-decision aggregate threshold, pools fallbackCount/decisionCount across episodes BEFORE dividing, and excludes episodes with no decisions.jsonl entirely (never treats them as 0 decisions)", () => {
    const belowThreshold = aggregateAgentStats([
      rawMatch({ decisionCount: 10, fallbackCount: 1 }),
      rawMatch({ decisionCount: 15, fallbackCount: 3 }),
    ]);
    expect(belowThreshold.fingerprint.reliability).toBeNull();

    // Pooled: 1 - (1+3+2)/(10+15+30) = 1 - 6/55 ≈ 0.8909. A naive
    // average of per-episode rates would differ — same statistical
    // argument as aggression's pooling test above.
    const atThreshold = aggregateAgentStats([
      rawMatch({ decisionCount: 10, fallbackCount: 1 }),
      rawMatch({ decisionCount: 15, fallbackCount: 3 }),
      rawMatch({ decisionCount: 30, fallbackCount: 2 }),
    ]);
    expect(atThreshold.fingerprint.reliability).not.toBeNull();
    expect(atThreshold.fingerprint.reliability?.sampleSize).toBe(55);
    expect(atThreshold.fingerprint.reliability?.value).toBeCloseTo(1 - 6 / 55);

    // An episode with no decisions.jsonl (decisionCount: null, the
    // default from rawMatch()) must be EXCLUDED from both numerator and
    // denominator, not counted as a 0-decision/0-fallback episode.
    const withMissingEpisode = aggregateAgentStats([
      rawMatch({ decisionCount: 10, fallbackCount: 1 }),
      rawMatch({ decisionCount: 15, fallbackCount: 3 }),
      rawMatch({ decisionCount: 30, fallbackCount: 2 }),
      rawMatch(), // decisionCount/fallbackCount null — no artifact.
    ]);
    expect(withMissingEpisode.fingerprint.reliability?.sampleSize).toBe(55);
    expect(withMissingEpisode.fingerprint.reliability?.value).toBeCloseTo(
      1 - 6 / 55,
    );
  });

  it("never fabricates a metric as zero when the underlying sample is empty — always null, not 0", () => {
    const stats = aggregateAgentStats([]);
    expect(stats.episodeCount).toBe(0);
    expect(stats.fingerprint.aggression).toBeNull();
    expect(stats.fingerprint.diplomacyInitiated).toBeNull();
    expect(stats.fingerprint.economicFocus).toBeNull();
    expect(stats.fingerprint.territory.share).toBeNull();
    expect(stats.fingerprint.territory.absoluteTiles).toBeNull();
    expect(stats.fingerprint.armyStrength).toBeNull();
    expect(stats.fingerprint.reliability).toBeNull();
    expect(stats.social.alliancesInitiated).toBeNull();
    expect(stats.social.allianceAcceptanceRate).toBeNull();
    expect(stats.social.betrayalCount).toBeNull();
    expect(stats.social.treatyDuration).toBeNull();
    expect(stats.social.frequentAllies).toEqual([]);
    expect(stats.social.primaryAdversaries).toEqual([]);
  });
});
