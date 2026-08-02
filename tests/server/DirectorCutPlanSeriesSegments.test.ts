import { describe, expect, it } from "vitest";
import { buildDirectorCutPlan } from "../../src/server/agents/DirectorCutPlan";
import { buildAgentMatchStateSeries } from "../../src/server/agents/AgentMatchStateSeries";
import type { AgentSpectatorPlayerState, AgentSpectatorSnapshot } from "../../src/server/agents/AgentSpectatorReplay";
import type { AgentRunFinalState } from "../../src/server/agents/AgentDecisionLogWriter";
import { buildFixtureSeries } from "./AgentMatchStateSeries.test";

/**
 * Season Zero Phase 2: `lead_change`/`reversal` `DirectorCutSegment`s built
 * from the sampled match-state series (see `DirectorCutPlan.ts`'s
 * `buildSeriesDerivedSegments`). The lead-change assertions reuse the SAME
 * hand-computed fixture as `AgentMatchStateDerivations.test.ts` (turn 20
 * confirmed lead change). The reversal assertions use a SEPARATE local
 * fixture: in the shared fixture, Delta's rank-1 reversal turn (50)
 * coincides with Delta's lead-change turn (50) — the SAME real swing, so
 * the higher-importance `lead_change` label correctly wins that window
 * (verified separately below) and no independent `reversal` segment
 * survives there. This fixture instead climbs an agent to 2nd place
 * (never 1st), so its reversal never collides with a lead change.
 */

const ROSTER = ["Alpha", "Bravo", "Charlie", "Delta"].map((username, index) => ({
  agentID: `agent-p${index + 1}`,
  username,
  profile: "diplomatic" as const,
  clientID: `client-p${index + 1}`,
  brainType: "planner-executor" as const,
}));

/**
 * Everyone alive at match end — the DirectorCutPlan-level `finalState` is
 * deliberately NOT wired to the shared series fixture's own per-agent
 * `alive` flags here (Charlie is eliminated in that fixture, see
 * `AgentMatchStateSeries.test.ts`): `buildAgentSpectatorTelemetry` synthesizes
 * a real, high-importance (90) `elimination` event for any `finalState`
 * player marked `isAlive: false`, which would legitimately outrank and
 * absorb a series-derived segment in the SAME turn window — a correct
 * interaction this suite is not testing, so it's avoided here to isolate
 * the lead-change/reversal segment assertions.
 */
function finalState(totalTurns: number, roster: typeof ROSTER): AgentRunFinalState {
  return {
    phase: "finished",
    tick: totalTurns,
    turnCount: totalTurns,
    players: roster.map((entry) => ({
      agentID: entry.agentID,
      username: entry.username,
      profile: "diplomatic",
      playerID: entry.agentID.replace("agent-", ""),
      isAlive: true,
      tilesOwned: 10,
      troops: 100,
      gold: "0",
    })),
  };
}

function player(
  playerID: string,
  username: string,
  tilesOwned: number,
): AgentSpectatorPlayerState {
  return {
    agentID: `agent-${playerID}`,
    clientID: `client-${playerID}`,
    playerID,
    username,
    profile: null,
    brainType: null,
    color: "#000000",
    isAlive: true,
    hasSpawned: true,
    tilesOwned,
    troops: 100,
    gold: "0",
    tiles: [],
    units: [],
  };
}

function snapshot(turnNumber: number, players: AgentSpectatorPlayerState[]): AgentSpectatorSnapshot {
  return { label: `t${turnNumber}`, turnNumber, tick: turnNumber, phase: "active", decisions: [], players };
}

/**
 * Alpha stays the dominant leader (50 tiles) at every sample, so
 * `computeLeadChanges` is empty throughout — no lead-change window can
 * collide with the reversal under test. Echo climbs from 5th place (turn
 * 20) to 2nd place (turn 60), a clean 3-place reversal that never reaches
 * 1st.
 */
const REVERSAL_ONLY_ROSTER = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map(
  (username, index) => ({
    agentID: `agent-p${index + 1}`,
    username,
    profile: "diplomatic" as const,
    clientID: `client-p${index + 1}`,
    brainType: "planner-executor" as const,
  }),
);

function buildReversalOnlySeries() {
  const snapshots = [
    snapshot(0, [
      player("p1", "Alpha", 50),
      player("p2", "Bravo", 15),
      player("p3", "Charlie", 10),
      player("p4", "Delta", 8),
      player("p5", "Echo", 2),
    ]),
    snapshot(20, [
      player("p1", "Alpha", 50),
      player("p2", "Bravo", 15),
      player("p3", "Charlie", 10),
      player("p4", "Delta", 8),
      player("p5", "Echo", 2),
    ]),
    snapshot(40, [
      player("p1", "Alpha", 50),
      player("p2", "Bravo", 15),
      player("p3", "Charlie", 10),
      player("p4", "Delta", 8),
      player("p5", "Echo", 9),
    ]),
    snapshot(60, [
      player("p1", "Alpha", 50),
      player("p2", "Bravo", 15),
      player("p3", "Charlie", 10),
      player("p4", "Delta", 8),
      player("p5", "Echo", 20),
    ]),
    snapshot(80, [
      player("p1", "Alpha", 50),
      player("p2", "Bravo", 15),
      player("p3", "Charlie", 10),
      player("p4", "Delta", 8),
      player("p5", "Echo", 22),
    ]),
    snapshot(100, [
      player("p1", "Alpha", 50),
      player("p2", "Bravo", 15),
      player("p3", "Charlie", 10),
      player("p4", "Delta", 8),
      player("p5", "Echo", 25),
    ]),
  ];
  const series = buildAgentMatchStateSeries({
    runID: "run-reversal-only",
    matchID: "match-reversal-only",
    replay: { snapshots },
    telemetry: null,
  });
  if (series === null) throw new Error("reversal-only fixture series unexpectedly null");
  return series;
}

describe("buildDirectorCutPlan — series-derived segments", () => {
  it("produces zero lead_change/reversal segments when no series is passed (backward compatible)", () => {
    const plan = buildDirectorCutPlan({
      runID: "r",
      matchID: "m",
      records: [],
      roster: ROSTER,
      finalState: finalState(50, ROSTER),
    });
    expect(plan.segments.some((s) => s.eventReason === "lead_change")).toBe(false);
    expect(plan.segments.some((s) => s.eventReason === "reversal")).toBe(false);
  });

  it("produces a lead_change segment anchored near the confirmed overtake turn (20)", () => {
    const plan = buildDirectorCutPlan({
      runID: "r",
      matchID: "m",
      records: [],
      roster: ROSTER,
      finalState: finalState(50, ROSTER),
      matchStateSeries: buildFixtureSeries(),
    });
    const leadChangeSegments = plan.segments.filter((s) => s.eventReason === "lead_change");
    expect(leadChangeSegments.length).toBeGreaterThan(0);
    const nearTurn20 = leadChangeSegments.find((s) => s.startTurn <= 20 && s.endTurn >= 20);
    expect(nearTurn20).toBeDefined();
    expect(nearTurn20!.participatingAgents).toEqual(
      expect.arrayContaining(["Alpha", "Bravo"]),
    );
    expect(nearTurn20!.importance).toBeGreaterThanOrEqual(60);
  });

  it("also anchors a (higher-importance) lead_change segment at the shared fixture's turn-50 overtake, which absorbs that same-window reversal", () => {
    const plan = buildDirectorCutPlan({
      runID: "r",
      matchID: "m",
      records: [],
      roster: ROSTER,
      finalState: finalState(50, ROSTER),
      matchStateSeries: buildFixtureSeries(),
    });
    const at50 = plan.segments.find((s) => s.startTurn <= 50 && s.endTurn >= 50);
    expect(at50?.eventReason).toBe("lead_change");
    expect(at50?.participatingAgents).toEqual(expect.arrayContaining(["Delta"]));
  });

  it("produces an independent reversal segment when the swing never reaches the lead", () => {
    const series = buildReversalOnlySeries();
    const plan = buildDirectorCutPlan({
      runID: "r",
      matchID: "m",
      records: [],
      roster: REVERSAL_ONLY_ROSTER,
      finalState: finalState(100, REVERSAL_ONLY_ROSTER),
      matchStateSeries: series,
    });
    expect(plan.segments.some((s) => s.eventReason === "lead_change")).toBe(false);
    const reversalSegments = plan.segments.filter((s) => s.eventReason === "reversal");
    expect(reversalSegments).toHaveLength(1);
    expect(reversalSegments[0].participatingAgents).toEqual(["Echo"]);
    expect(reversalSegments[0].startTurn).toBeLessThanOrEqual(60);
    expect(reversalSegments[0].endTurn).toBeGreaterThanOrEqual(60);
  });

  it("still partitions [0, totalTurns] with no gaps or overlaps when series segments are present", () => {
    const plan = buildDirectorCutPlan({
      runID: "r",
      matchID: "m",
      records: [],
      roster: ROSTER,
      finalState: finalState(50, ROSTER),
      matchStateSeries: buildFixtureSeries(),
    });
    let cursor = 0;
    for (const segment of plan.segments) {
      expect(segment.startTurn).toBe(cursor);
      expect(segment.endTurn).toBeGreaterThanOrEqual(segment.startTurn);
      cursor = segment.endTurn + 1;
    }
    expect(cursor).toBe(plan.totalTurns + 1);
  });
});
