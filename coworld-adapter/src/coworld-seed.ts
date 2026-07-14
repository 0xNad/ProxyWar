export const DEFAULT_COWORLD_GAME_ID = "COWRLD01";

const COWORLD_SEED_DIGITS = 6;
const COWORLD_SEED_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const COWORLD_SEED_RADIX = COWORLD_SEED_ALPHABET.length;

/**
 * Six base-26 letters keep the derived id inside OpenFront's eight-character
 * game-id contract. With A..Z digits evaluated by OpenFront's base-31
 * `simpleHash`, each more-significant digit outweighs every possible suffix.
 * The full CWAAAAAA..CWZZZZZZ range also stays inside one negative signed
 * 32-bit interval before `Math.abs`, so its simulation hashes are injective.
 */
export const MAX_COWORLD_SEED = COWORLD_SEED_RADIX ** COWORLD_SEED_DIGITS - 1;

export type CoworldSeedConfig = {
  seed?: number;
};

export type CoworldEpisodeSeedContract = {
  seed: number | null;
  gameID: string;
  results: {
    seed: number | null;
    game_id: string;
  };
  replay: {
    seed: number | null;
    gameID: string;
  };
  runner: {
    seed: number | null;
    gameID: string;
  };
};

export function parseCoworldSeed(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_COWORLD_SEED
  ) {
    throw new Error(
      `Coworld seed must be an integer from 0 through ${MAX_COWORLD_SEED}`,
    );
  }
  return value;
}

/** Validate the optional seed while leaving the rest of Coworld's config intact. */
export function parseCoworldSeedConfig<T extends Record<string, unknown>>(
  value: T,
): T & CoworldSeedConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Coworld config must be an object");
  }
  const seed = parseCoworldSeed(value.seed);
  return seed === undefined ? value : { ...value, seed };
}

export function coworldGameID(seed: number | undefined): string {
  const parsedSeed = parseCoworldSeed(seed);
  if (parsedSeed === undefined) {
    return DEFAULT_COWORLD_GAME_ID;
  }
  let remaining = parsedSeed;
  let encoded = "";
  for (let index = 0; index < COWORLD_SEED_DIGITS; index += 1) {
    encoded = COWORLD_SEED_ALPHABET[remaining % COWORLD_SEED_RADIX] + encoded;
    remaining = Math.floor(remaining / COWORLD_SEED_RADIX);
  }
  return `CW${encoded}`;
}

/**
 * One canonical metadata object feeds every episode output surface, preventing
 * the runner, results, and replay from disagreeing about the simulation seed.
 */
export function coworldEpisodeSeedContract(
  config: CoworldSeedConfig,
): CoworldEpisodeSeedContract {
  const parsedSeed = parseCoworldSeed(config.seed);
  const seed = parsedSeed ?? null;
  const gameID = coworldGameID(parsedSeed);
  return {
    seed,
    gameID,
    results: { seed, game_id: gameID },
    replay: { seed, gameID },
    runner: { seed, gameID },
  };
}
