import { describe, expect, it } from "vitest";
import {
  buildAgentDecisiveMoments,
  MAX_DECISIVE_MOMENTS,
  MIN_DECISIVE_MOMENTS,
} from "../../src/server/agents/AgentDecisiveMoments";
import { buildAgentMatchStateSeries } from "../../src/server/agents/AgentMatchStateSeries";
import type { AgentSpectatorSnapshot } from "../../src/server/agents/AgentSpectatorReplay";
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

describe("buildAgentDecisiveMoments", () => {
  it("selects between MIN and MAX moments, chronologically ordered, deduplicated across the same real swing", () => {
    const series = buildFixtureSeries();
    const artifact = buildAgentDecisiveMoments({
      runID: "run-fixture",
      series,
      telemetryEvents: FIXTURE_EVENTS,
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
      telemetryEvents: FIXTURE_EVENTS,
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
      telemetryEvents: FIXTURE_EVENTS,
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
