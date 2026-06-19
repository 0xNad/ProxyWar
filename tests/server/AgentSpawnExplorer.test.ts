import { describe, expect, it } from "vitest";
import {
  selectSpawnTile,
  SPAWN_CONVERGE_PROGRESS,
} from "../../src/server/agents/AgentSpawnExplorer";
import { LegalAction } from "../../src/server/agents/AgentTypes";

function spawnAction(
  tile: number,
  scores: Partial<Record<string, number>>,
): LegalAction {
  return {
    id: `spawn:${tile}`,
    kind: "spawn",
    label: `Spawn at ${tile}`,
    intent: { type: "spawn", tile },
    risk: { level: "medium", score: 0.5 },
    metadata: {
      x: tile % 50,
      y: Math.floor(tile / 50),
      pressureScore: scores.pressureScore ?? 0.5,
      safetyScore: scores.safetyScore ?? 0.5,
      diplomacyScore: scores.diplomacyScore ?? 0.5,
      opportunityScore: scores.opportunityScore ?? 0.5,
      localLandScore: scores.localLandScore ?? 0.5,
    },
  };
}

// 25 spawn tiles whose scores cluster near the top with small per-tile variation, so
// most are within the explore band of the best (as a real buildSpawnCandidates pool's
// strong region is) — giving the explorer many strong tiles to jump among.
function spawnPool(n: number): LegalAction[] {
  return Array.from({ length: n }, (_, i) =>
    spawnAction(100 + i, {
      safetyScore: 0.6 + (i % 10) * 0.01,
      localLandScore: 0.6 + (i % 8) * 0.012,
      opportunityScore: 0.6 + (i % 12) * 0.008,
      pressureScore: 0.5 + (i % 6) * 0.01,
      diplomacyScore: 0.5 + (i % 9) * 0.01,
    }),
  );
}

describe("selectSpawnTile (built-in-style spawn exploration)", () => {
  const base = {
    gameID: "G1",
    agentID: "A1",
    profile: "opportunistic" as const,
  };
  const pool = spawnPool(25);

  it("explores multiple distinct tiles across spawn-phase ticks (jumps around)", () => {
    const tiles = new Set<string>();
    for (let tick = 0; tick < 24; tick += 1) {
      const chosen = selectSpawnTile({
        ...base,
        spawnActions: pool,
        tick,
        spawnProgress: 0.1,
      });
      tiles.add(chosen?.id ?? "none");
    }
    expect(tiles.size).toBeGreaterThanOrEqual(8);
  });

  it("settles on the single strategic anchor in the final stretch (converge)", () => {
    const settled = new Set<string>();
    for (let tick = 0; tick < 12; tick += 1) {
      const chosen = selectSpawnTile({
        ...base,
        spawnActions: pool,
        tick,
        spawnProgress: SPAWN_CONVERGE_PROGRESS,
      });
      settled.add(chosen?.id ?? "none");
    }
    // Converged: the same anchor every tick, regardless of the per-tick seed.
    expect(settled.size).toBe(1);
  });

  it("is deterministic (same gameID/agentID/tick -> same tile)", () => {
    const a = selectSpawnTile({
      ...base,
      spawnActions: pool,
      tick: 3,
      spawnProgress: 0.1,
    });
    const b = selectSpawnTile({
      ...base,
      spawnActions: pool,
      tick: 3,
      spawnProgress: 0.1,
    });
    expect(a?.id).toBe(b?.id);
    expect(a?.id).toBeDefined();
  });

  it("is profile-sensitive: aggressive vs defensive settle differently", () => {
    // The safest tile is NOT the most aggressive tile, so the strategic anchors diverge.
    const divergent = [
      spawnAction(1, {
        safetyScore: 0.95,
        diplomacyScore: 0.9,
        pressureScore: 0.05,
        opportunityScore: 0.05,
        localLandScore: 0.5,
      }),
      spawnAction(2, {
        safetyScore: 0.05,
        diplomacyScore: 0.05,
        pressureScore: 0.95,
        opportunityScore: 0.95,
        localLandScore: 0.5,
      }),
    ];
    const aggressive = selectSpawnTile({
      ...base,
      profile: "aggressive",
      spawnActions: divergent,
      tick: 0,
      spawnProgress: 1,
    });
    const defensive = selectSpawnTile({
      ...base,
      profile: "defensive",
      spawnActions: divergent,
      tick: 0,
      spawnProgress: 1,
    });
    expect(aggressive?.id).toBe("spawn:2");
    expect(defensive?.id).toBe("spawn:1");
  });

  it("returns undefined when no spawn action is offered", () => {
    expect(
      selectSpawnTile({
        ...base,
        spawnActions: [],
        tick: 0,
        spawnProgress: 0,
      }),
    ).toBeUndefined();
  });
});
