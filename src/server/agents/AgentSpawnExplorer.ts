import {
  spawnProfilePreference,
  stableFraction,
} from "./AgentPlannerExecutor";
import { AgentStrategyProfile, LegalAction } from "./AgentTypes";

// How far below the strategic-anchor score a candidate may be and still join the
// exploration pool. Wider = the agent jumps across more (and more varied) strong
// regions; narrower = it dances closer to the single best tile. Tunable after watching
// the first replay.
export const SPAWN_EXPLORE_BAND = 0.18;

// Fraction of the spawn phase after which the agent stops exploring and commits to the
// strategic anchor (the "settle"). 0.8 => it jumps for the first 80% of the spawn phase,
// then holds the best tile for the final 20%.
export const SPAWN_CONVERGE_PROGRESS = 0.8;

/**
 * Deterministic built-in-nation-style spawn selection. Built-in nations re-jitter their
 * spawn near a region every spawn-phase tick and settle; this gives the agent the same
 * behavior WITHOUT the LLM (latency-free): pick the strategically-best spawn (the anchor)
 * by `spawnProfilePreference`, but EXPLORE across spawn-phase ticks — each tick a
 * different strong candidate (the "jump around") chosen by a seeded PRNG keyed by
 * (gameID, agentID, tick) — then CONVERGE to the anchor in the final fraction of the
 * spawn phase (the "settle"). Pure + deterministic: no Math.random / wall-clock, so eval
 * runs reproduce. Returns undefined when no spawn action is offered.
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
  // Settle: hold the strategic anchor through the final stretch of the spawn phase.
  if (input.spawnProgress >= SPAWN_CONVERGE_PROGRESS) {
    return anchor;
  }
  // Explore: jump among the strong pool (within EXPLORE_BAND of the anchor's score) — a
  // different tile each tick, mirroring how a nation's per-tick jitter moves its spawn
  // marker. A seeded per-agent OFFSET plus a per-tick ROTATION visits the strong pool
  // (rather than hashing each tick independently — FNV clusters badly on sequential
  // single-char-delta seeds, collapsing to a few tiles). Deterministic; different
  // (game, agent) start at different tiles so seats explore differently.
  const anchorScore = spawnProfilePreference(anchor, input.profile);
  const pool = ranked.filter(
    (action) =>
      spawnProfilePreference(action, input.profile) >=
      anchorScore - SPAWN_EXPLORE_BAND,
  );
  const offset = Math.floor(
    stableFraction(`spawn:explore:${input.gameID}:${input.agentID}`) *
      pool.length,
  );
  const index = (offset + input.tick) % pool.length;
  return pool[index];
}
