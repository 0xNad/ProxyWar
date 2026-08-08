// Pure Coworld result-contract helpers — no I/O and no module-load side effects,
// so they are unit-testable independently of the container-only episode runner.
// Extracted from no-docker-coworld-episode.ts (ADAPTER-02): the episode winner
// must be mapped to a player slot by IDENTITY, never by a display-name substring.

/** Identity of the episode winner. Game.getWinner() returns Player | Team | null,
 *  and Team is a string label (src/core/game/Game.ts), so a team win is a string. */
export type WinnerRef =
  | { readonly type: "none" }
  | { readonly type: "player"; readonly id: unknown }
  | { readonly type: "team"; readonly team: string };

/** Minimal per-slot identity needed to credit a winner. */
export interface ResolvedPlayerIdentity {
  /** Player.id() for the slot's live player, or null when the slot has no live player. */
  readonly id: unknown;
  /** Player.team() (a team label string) or null. */
  readonly team: string | null;
  /** Tiles owned; used only to pick a representative slot for a team win. */
  readonly tilesOwned: number;
}

/**
 * Map an episode winner to a player slot by IDENTITY.
 * - A single Player winner is matched by Player.id() equality — never a name
 *   substring, which collides ("War" inside "Warlord") and breaks on the 27-char
 *   in-game name truncation.
 * - A Team winner (team play is disabled in the Coworld FFA config; handled
 *   defensively) credits the on-team slot holding the most tiles.
 * - An unresolvable winner returns null, so scoring falls back to tile-share.
 * A slot with a null id (no live player) never matches.
 */
export function resolveWinnerSlot(
  players: readonly ResolvedPlayerIdentity[],
  winner: WinnerRef,
): number | null {
  if (winner.type === "none") {
    return null;
  }
  if (winner.type === "team") {
    let bestTiles = -1;
    let slot: number | null = null;
    players.forEach((player, index) => {
      if (
        player.id !== null &&
        player.team === winner.team &&
        player.tilesOwned > bestTiles
      ) {
        bestTiles = player.tilesOwned;
        slot = index;
      }
    });
    return slot;
  }
  const index = players.findIndex(
    (player) => player.id !== null && player.id === winner.id,
  );
  return index >= 0 ? index : null;
}

/**
 * Structural inputs the results builder needs — never the full episode/config
 * types, so this module stays decoupled and importable without pulling in
 * no-docker-coworld-episode.ts (which runs `await main()` at module load and
 * is therefore unsafe to import from a test).
 */
export interface CoworldResultsFinalState {
  readonly winnerSlot: number | null;
  readonly turnCount: number | null;
  readonly tick: number | null;
  readonly players: ReadonlyArray<{
    readonly username: string;
    readonly tilesOwned: number | null;
    readonly isAlive: boolean | null;
  }>;
}

export interface CoworldDecisionRecord {
  readonly result: { readonly accepted: boolean };
  readonly decisionMetadata?: {
    readonly fallbackUsed?: boolean;
    readonly llmPlannerDegraded?: boolean;
  };
}

/** Coworld's game-written results.json contract (coworld_manifest.json's
 *  results_schema, `required`: seed, game_id, scores, winner_slot,
 *  turn_count, tick, decision_count, accepted_decision_count,
 *  fallback_count, players). */
export interface CoworldResults {
  /** GameServer match id (e.g. "COWRLD01") — the value that seeds the
   *  deterministic simulation RNG via simpleHash(gameID). Always 8
   *  alphanumeric chars, matching results_schema's game_id pattern. */
  readonly game_id: string;
  /** Configured episode seed encoded into game_id, or null when the episode
   *  deliberately used the historical seedless identity. */
  readonly seed: number | null;
  readonly scores: number[];
  readonly winner_slot: number | null;
  readonly turn_count: number | null;
  readonly tick: number | null;
  readonly decision_count: number;
  readonly accepted_decision_count: number;
  readonly fallback_count: number;
  readonly degraded_count: number;
  readonly players: Array<{
    slot: number;
    name: string;
    score: number;
    tiles_owned: number | null;
    is_alive: boolean | null;
  }>;
}

/**
 * Build the Coworld results.json contract for one episode. Pure function of
 * its inputs — no I/O, no module-load side effects (see file header).
 */
export function coworldResults(input: {
  /** GameServer.id for this episode (e.g. "COWRLD01"); pass game.id from the
   *  caller — never recompute it here, so this stays the single source of
   *  the deterministic match identity. */
  gameId: string;
  /** Exact configured seed used to derive gameId; null for seedless runs. */
  seed: number | null;
  players: ReadonlyArray<{ readonly name: string }>;
  finalState: CoworldResultsFinalState;
  records: readonly CoworldDecisionRecord[];
}): CoworldResults {
  const totalTiles = input.finalState.players.reduce(
    (sum, player) => sum + Math.max(0, player.tilesOwned ?? 0),
    0,
  );
  // Winner slot is resolved by identity in finalKnownState (not a name substring).
  const winner_slot = input.finalState.winnerSlot;
  const scores = input.finalState.players.map((player, index) => {
    if (winner_slot !== null) {
      return index === winner_slot ? 1 : 0;
    }
    if (totalTiles <= 0 || player.tilesOwned === null) {
      return 0;
    }
    return player.tilesOwned / totalTiles;
  });
  return {
    game_id: input.gameId,
    seed: input.seed,
    scores,
    winner_slot,
    turn_count: input.finalState.turnCount,
    tick: input.finalState.tick,
    decision_count: input.records.length,
    accepted_decision_count: input.records.filter(
      (record) => record.result.accepted,
    ).length,
    // A decision is a fallback if it fell back OR the LLM planner degraded —
    // a degraded-but-not-fallback decision (e.g. the standing directive kept
    // executing after a Commander failure) must not read as 0 fallbacks.
    fallback_count: input.records.filter(
      (record) =>
        record.decisionMetadata?.fallbackUsed === true ||
        record.decisionMetadata?.llmPlannerDegraded === true,
    ).length,
    degraded_count: input.records.filter(
      (record) => record.decisionMetadata?.llmPlannerDegraded === true,
    ).length,
    players: input.finalState.players.map((player, slot) => ({
      slot,
      name: input.players[slot]?.name ?? player.username,
      score: scores[slot] ?? 0,
      tiles_owned: player.tilesOwned,
      is_alive: player.isAlive,
    })),
  };
}
