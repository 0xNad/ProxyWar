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
