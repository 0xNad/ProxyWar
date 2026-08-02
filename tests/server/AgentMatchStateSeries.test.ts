import { describe, expect, it } from "vitest";
import {
  buildAgentMatchStateSeries,
  computeAllianceIntervals,
  MATCH_STATE_SERIES_SCHEMA_VERSION,
  type MatchStateSeries,
} from "../../src/server/agents/AgentMatchStateSeries";
import type {
  AgentSpectatorPlayerState,
  AgentSpectatorSnapshot,
} from "../../src/server/agents/AgentSpectatorReplay";
import type { SpectatorEvent, SpectatorTelemetry } from "../../src/server/agents/AgentSpectatorTelemetry";

/**
 * Hand-computed fixture shared by AgentMatchStateSeries.test.ts and
 * AgentMatchStateDerivations.test.ts: a synthetic-but-realistic 4-agent
 * match across 6 sampled turns, engineered to exercise a confirmed lead
 * change, a flicker-filtered near-miss, an elimination, an alliance
 * formed+betrayed and a second alliance left ongoing, and a >=3-place rank
 * reversal — every expected value below was computed by hand against the
 * exact tile/troop numbers in `player()` calls, not reverse-engineered from
 * the implementation.
 */
function player(
  playerID: string,
  username: string,
  tilesOwned: number,
  troops: number,
  isAlive: boolean,
): AgentSpectatorPlayerState {
  return {
    agentID: `agent-${playerID}`,
    clientID: `client-${playerID}`,
    playerID,
    username,
    profile: null,
    brainType: null,
    color: "#000000",
    isAlive,
    hasSpawned: true,
    tilesOwned,
    troops,
    gold: "0",
    tiles: [],
    units: [],
  };
}

function snapshot(
  turnNumber: number,
  players: AgentSpectatorPlayerState[],
): AgentSpectatorSnapshot {
  return {
    label: `turn-${turnNumber}`,
    turnNumber,
    tick: turnNumber * 10,
    phase: "active",
    decisions: [],
    players,
  };
}

export const FIXTURE_SNAPSHOTS: AgentSpectatorSnapshot[] = [
  snapshot(0, [
    player("p1", "Alpha", 10, 100, true),
    player("p2", "Bravo", 10, 100, true),
    player("p3", "Charlie", 10, 100, true),
    player("p4", "Delta", 10, 100, true),
  ]),
  snapshot(10, [
    player("p1", "Alpha", 40, 100, true),
    player("p2", "Bravo", 25, 100, true),
    player("p3", "Charlie", 20, 100, true),
    player("p4", "Delta", 15, 100, true),
  ]),
  snapshot(20, [
    player("p1", "Alpha", 35, 100, true),
    player("p2", "Bravo", 45, 100, true),
    player("p3", "Charlie", 15, 100, true),
    player("p4", "Delta", 5, 100, true),
  ]),
  snapshot(30, [
    player("p1", "Alpha", 25, 200, true),
    player("p2", "Bravo", 50, 100, true),
    player("p3", "Charlie", 0, 0, false),
    player("p4", "Delta", 25, 150, true),
  ]),
  snapshot(40, [
    player("p1", "Alpha", 13, 200, true),
    player("p2", "Bravo", 45, 100, true),
    player("p3", "Charlie", 0, 0, false),
    player("p4", "Delta", 42, 150, true),
  ]),
  snapshot(50, [
    player("p1", "Alpha", 5, 200, true),
    player("p2", "Bravo", 30, 100, true),
    player("p3", "Charlie", 0, 0, false),
    player("p4", "Delta", 65, 150, true),
  ]),
];

function allianceEvent(
  overrides: Partial<SpectatorEvent> & Pick<SpectatorEvent, "id" | "turnNumber" | "kind" | "actorAgentID" | "targetAgentID">,
): SpectatorEvent {
  return {
    sequence: overrides.turnNumber,
    tone: "pact",
    actorName: overrides.actorAgentID,
    targetName: overrides.targetAgentID ?? "",
    message: "",
    actionKind: "alliance_request",
    actionID: overrides.id,
    importance: 90,
    ...overrides,
  };
}

export const FIXTURE_EVENTS: SpectatorEvent[] = [
  allianceEvent({
    id: "e1",
    turnNumber: 5,
    kind: "alliance_formed",
    actorAgentID: "agent-p1",
    targetAgentID: "agent-p2",
  }),
  allianceEvent({
    id: "e2",
    turnNumber: 12,
    kind: "alliance_formed",
    actorAgentID: "agent-p3",
    targetAgentID: "agent-p4",
  }),
  allianceEvent({
    id: "e3",
    turnNumber: 35,
    kind: "alliance_break",
    tone: "betrayal",
    actorAgentID: "agent-p2",
    targetAgentID: "agent-p1",
  }),
];

export const FIXTURE_TELEMETRY: SpectatorTelemetry = {
  version: 1,
  runID: "run-fixture",
  generatedAt: new Date(0).toISOString(),
  agents: [],
  relationships: [],
  events: FIXTURE_EVENTS,
  communicationThreads: [],
  timelineBuckets: [],
};

export function buildFixtureSeries(): MatchStateSeries {
  const series = buildAgentMatchStateSeries({
    runID: "run-fixture",
    matchID: "match-fixture",
    replay: { snapshots: FIXTURE_SNAPSHOTS },
    telemetry: FIXTURE_TELEMETRY,
  });
  if (series === null) throw new Error("fixture series unexpectedly null");
  return series;
}

describe("buildAgentMatchStateSeries", () => {
  it("returns null when the source replay has zero snapshots", () => {
    expect(
      buildAgentMatchStateSeries({
        runID: "r",
        matchID: "m",
        replay: { snapshots: [] },
        telemetry: null,
      }),
    ).toBeNull();
  });

  it("carries schemaVersion, source, and totalTurns from the last sample", () => {
    const series = buildFixtureSeries();
    expect(series.schemaVersion).toBe(MATCH_STATE_SERIES_SCHEMA_VERSION);
    expect(series.source).toBe("spectator-replay-snapshots");
    expect(series.totalTurns).toBe(50);
    expect(series.samples).toHaveLength(6);
  });

  it("computes territoryShare and rank per sample with deterministic tie-breaking", () => {
    const series = buildFixtureSeries();
    const turn20 = series.samples.find((sample) => sample.turn === 20)!;
    const bravo = turn20.agents.find((agent) => agent.playerID === "p2")!;
    expect(bravo.territoryShare).toBeCloseTo(0.45, 5);
    expect(bravo.rank).toBe(1);
    const alpha = turn20.agents.find((agent) => agent.playerID === "p1")!;
    expect(alpha.rank).toBe(2);

    const turn30 = series.samples.find((sample) => sample.turn === 30)!;
    // p1 (tiles=25, troops=200) outranks p4 (tiles=25, troops=150) on the troops tie-break.
    expect(turn30.agents.find((a) => a.playerID === "p1")!.rank).toBe(2);
    expect(turn30.agents.find((a) => a.playerID === "p4")!.rank).toBe(3);
    expect(turn30.agents.find((a) => a.playerID === "p3")!.rank).toBe(4);
  });

  it("reports alive=false and tilesOwned=0 for an eliminated agent from its dead sample onward", () => {
    const series = buildFixtureSeries();
    const turn30Charlie = series.samples.find((s) => s.turn === 30)!.agents.find(
      (a) => a.playerID === "p3",
    )!;
    expect(turn30Charlie.alive).toBe(false);
    expect(turn30Charlie.tilesOwned).toBe(0);
  });

  it("derives activeAlliancePairs per sample from alliance_formed/alliance_break telemetry, chronologically", () => {
    const series = buildFixtureSeries();
    const pairsAt = (turn: number) =>
      series.samples
        .find((s) => s.turn === turn)!
        .activeAlliancePairs.map((pair) => pair.join("+"))
        .sort();

    expect(pairsAt(0)).toEqual([]);
    expect(pairsAt(10)).toEqual(["agent-p1+agent-p2"]);
    expect(pairsAt(20)).toEqual(["agent-p1+agent-p2", "agent-p3+agent-p4"]);
    // p1<->p2 broken (betrayal) at turn 35; p3<->p4 never broken.
    expect(pairsAt(40)).toEqual(["agent-p3+agent-p4"]);
    expect(pairsAt(50)).toEqual(["agent-p3+agent-p4"]);
  });

  it("degrades activeAlliancePairs to always-empty with a note when telemetry is unavailable", () => {
    const series = buildAgentMatchStateSeries({
      runID: "r",
      matchID: "m",
      replay: { snapshots: FIXTURE_SNAPSHOTS },
      telemetry: null,
    })!;
    expect(series.samples.every((sample) => sample.activeAlliancePairs.length === 0)).toBe(true);
    expect(series.notes.some((note) => note.includes("unavailable"))).toBe(true);
  });
});

describe("computeAllianceIntervals", () => {
  it("pairs a formation with its break, tags betrayal tone, and leaves an unbroken pair open", () => {
    const intervals = computeAllianceIntervals(FIXTURE_EVENTS);
    expect(intervals).toHaveLength(2);

    const p1p2 = intervals.find(
      (interval) => interval.agentIDs.includes("agent-p1") && interval.agentIDs.includes("agent-p2"),
    )!;
    expect(p1p2.formedTurn).toBe(5);
    expect(p1p2.brokenTurn).toBe(35);
    expect(p1p2.brokenByBetrayal).toBe(true);

    const p3p4 = intervals.find(
      (interval) => interval.agentIDs.includes("agent-p3") && interval.agentIDs.includes("agent-p4"),
    )!;
    expect(p3p4.formedTurn).toBe(12);
    expect(p3p4.brokenTurn).toBeNull();
    expect(p3p4.brokenByBetrayal).toBeNull();
  });

  it("normalizes agentIDs into a lexicographically sorted pair regardless of actor/target order", () => {
    const intervals = computeAllianceIntervals(FIXTURE_EVENTS);
    for (const interval of intervals) {
      expect(interval.agentIDs[0] < interval.agentIDs[1]).toBe(true);
    }
  });
});
