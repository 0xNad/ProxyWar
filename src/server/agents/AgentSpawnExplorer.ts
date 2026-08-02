import { spawnProfilePreference, stableFraction } from "./AgentPlannerExecutor";
import { AgentStrategyProfile, LegalAction } from "./AgentTypes";

// How far below the strategic-anchor score a candidate may be and still join the
// exploration pool. Wider = the agent jumps across more (and more varied) strong
// regions; narrower = it dances closer to the single best tile. Tunable after watching
// the first replay.
export const SPAWN_EXPLORE_BAND = 0.18;

// Fraction of the spawn phase after which the agent stops exploring and commits to its
// settle tile. 0.8 => it jumps for the first 80% of the spawn phase, then holds the
// committed tile for the final 20%.
export const SPAWN_CONVERGE_PROGRESS = 0.8;

// The settle commits to one of the top-N strong-pool tiles, drawn per (game, agent).
// Larger = more per-game spawn variety on maps with several near-equal strong tiles;
// 1 = the old always-the-single-anchor behavior (identical spawns every game on a
// given map). Tunable after watching replays.
export const SPAWN_SETTLE_POOL_MAX = 8;

/**
 * Deterministic built-in-nation-style spawn selection. Built-in nations re-jitter their
 * spawn near a region every spawn-phase tick and settle; this gives the agent the same
 * behavior WITHOUT the LLM (latency-free): rank spawns by `spawnProfilePreference`, and
 * EXPLORE across spawn-phase ticks — each tick a different strong candidate (the "jump
 * around") chosen by a seeded PRNG keyed by (gameID, agentID, tick) — then CONVERGE (the
 * "settle") onto a committed tile drawn from the top of the strong pool by a seeded PRNG
 * keyed by (gameID, agentID). The settle draw — not always the single best tile — is what
 * makes different games on the same map open from different (still anchor-grade) spawns.
 * Pure + deterministic: no Math.random / wall-clock, so a given game reproduces exactly.
 * Returns undefined when no spawn action is offered.
 */
export function selectSpawnTile(input: {
  spawnActions: readonly LegalAction[];
  profile: AgentStrategyProfile;
  gameID: string;
  agentID: string;
  tick: number;
  /** Spawn-phase progress 0..1 = game.ticks() / numSpawnPhaseTurns(). */
  spawnProgress: number;
}): LegalAction | undefined {
  const spawns = input.spawnActions.filter((action) => action.kind === "spawn");
  if (spawns.length === 0) {
    return undefined;
  }
  // Strategic anchor: the best spawn for this profile, deterministic tie-break by id.
  const ranked = [...spawns].sort(
    (a, b) =>
      spawnProfilePreference(b, input.profile) -
        spawnProfilePreference(a, input.profile) || a.id.localeCompare(b.id),
  );
  const anchor = ranked[0];
  const anchorScore = spawnProfilePreference(anchor, input.profile);
  // Strong pool: every candidate within EXPLORE_BAND of the anchor's score. `ranked` is
  // sorted by score best-first, so the filter keeps a best-first prefix.
  const pool = ranked.filter(
    (action) =>
      spawnProfilePreference(action, input.profile) >=
      anchorScore - SPAWN_EXPLORE_BAND,
  );
  // Settle: commit to a per-(game, agent) draw among the top of the strong pool and hold
  // it through the final stretch. The seed has NO tick component and DOES have the
  // gameID: the same game re-derives the same pick (evals/replays reproduce) while
  // different games on the same map settle differently. The pick is positional, so it is
  // fixed while the offered pool is stable; when runSpawnPhase's stake exclusion
  // reshapes the top of the pool mid-settle, the pick follows the pool — every pick is
  // still anchor-grade, and the last accepted stake is the tile that actually spawns.
  if (input.spawnProgress >= SPAWN_CONVERGE_PROGRESS) {
    const settlePool = pool.slice(0, SPAWN_SETTLE_POOL_MAX);
    // stableFraction divides by 2^32 - 1 and can return exactly 1, which would floor to
    // settlePool.length — the modulo keeps the index in range.
    const settleIndex =
      Math.floor(
        stableFraction(`spawn:settle:${input.gameID}:${input.agentID}`) *
          settlePool.length,
      ) % settlePool.length;
    return settlePool[settleIndex];
  }
  // Explore: jump among the strong pool — a different tile each tick, mirroring how a
  // nation's per-tick jitter moves its spawn marker. A seeded per-agent OFFSET plus a
  // per-tick ROTATION visits the strong pool (rather than hashing each tick
  // independently — FNV clusters badly on sequential single-char-delta seeds, collapsing
  // to a few tiles). Deterministic; different (game, agent) start at different tiles so
  // seats explore differently.
  const offset = Math.floor(
    stableFraction(`spawn:explore:${input.gameID}:${input.agentID}`) *
      pool.length,
  );
  const index = (offset + input.tick) % pool.length;
  return pool[index];
}
