export const MAX_COWORLD_EPISODE_SEED = 26 ** 6 - 1;

export type CoworldEpisodeIdentity = {
  readonly gameId: string;
  readonly seed: number | null;
};

/**
 * Convert an optional Coworld seed into the exact eight-character GameServer
 * identity that drives ProxyWar's deterministic RNG. Six base-26 letters keep
 * every supported seed distinct under OpenFront's current simpleHash input
 * encoding while the fixed `PW` prefix preserves the result-schema shape.
 *
 * Omitting the seed deliberately preserves the historical certification and
 * replay identity instead of pretending an unseeded episode was seeded.
 */
export function coworldEpisodeIdentity(
  seed: number | undefined,
): CoworldEpisodeIdentity {
  if (seed === undefined) {
    return { gameId: "COWRLD01", seed: null };
  }
  if (
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    seed > MAX_COWORLD_EPISODE_SEED
  ) {
    throw new Error(
      `Coworld seed must be an integer from 0 through ${MAX_COWORLD_EPISODE_SEED}`,
    );
  }

  let remaining = seed;
  const encoded = Array.from({ length: 6 }, () => "A");
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] = String.fromCharCode(65 + (remaining % 26));
    remaining = Math.floor(remaining / 26);
  }
  return {
    gameId: `PW${encoded.join("")}`,
    seed,
  };
}
