export const MAX_COWORLD_EPISODE_SEED = 26 ** 5 - 1;

export type CoworldEpisodeIdentity = {
  readonly gameId: string;
  readonly seed: number | null;
};

/**
 * Convert an optional Coworld seed into the exact eight-character GameServer
 * identity that drives ProxyWar's deterministic RNG. The fixed `PWS` prefix
 * plus five base-26 letters keeps every supported seed distinct both as text
 * and after OpenFront's current `Math.abs(simpleHash(...))` conversion. The
 * older six-letter range crossed zero in the signed hash and therefore had
 * symmetric positive/negative collisions.
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
  const encoded = Array.from({ length: 5 }, () => "A");
  for (let index = encoded.length - 1; index >= 0; index -= 1) {
    encoded[index] = String.fromCharCode(65 + (remaining % 26));
    remaining = Math.floor(remaining / 26);
  }
  return {
    gameId: `PWS${encoded.join("")}`,
    seed,
  };
}
