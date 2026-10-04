/** Keep experiment reproducibility fields out of the hosted XP seed metadata. */
export function normalizeCoworldExperimentConfig<
  T extends {
    seed?: number;
    episodeIndex?: number;
    experiment_seed?: number;
    experiment_episode_index?: number;
  },
>(config: T): T {
  const { experiment_seed, experiment_episode_index, ...rest } = config;
  const result = { ...rest } as T;
  for (const [alias, value, key, maximum] of [
    ["experiment_seed", experiment_seed, "seed", 11881375],
    [
      "experiment_episode_index",
      experiment_episode_index,
      "episodeIndex",
      Number.MAX_SAFE_INTEGER,
    ],
  ] as const) {
    if (value === undefined) continue;
    if (config[key] !== undefined)
      throw new Error(`${alias} conflicts with ${key}`);
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new Error(`${alias} is out of range`);
    }
    result[key] = value;
  }
  return result;
}

/** Explicit, equal-size teams for unranked format experiments. */
export function resolveCoworldTeams(
  config: { team_count?: number; seat_teams?: number[] },
  seatCount: number,
): { count: number; clanTags: string[] } | null {
  if (config.team_count === undefined && config.seat_teams === undefined) {
    return null;
  }
  const count = config.team_count;
  if (!Number.isInteger(count) || count! < 2 || count! > 8) {
    throw new Error("team_count must be an integer from 2 to 8");
  }
  const assignments = config.seat_teams;
  if (!Array.isArray(assignments) || assignments.length !== seatCount) {
    throw new Error("seat_teams must assign every policy slot exactly once");
  }
  const sizes = Array<number>(count!).fill(0);
  for (const team of assignments) {
    if (!Number.isInteger(team) || team < 0 || team >= count!) {
      throw new Error("seat_teams contains an out-of-range team index");
    }
    sizes[team]++;
  }
  if (sizes.some((size) => size === 0 || size !== sizes[0])) {
    throw new Error(
      "Coworld team experiments require nonempty equal-size teams",
    );
  }
  // The engine's existing clan allocator keeps each complete group together.
  // These are experiment groups, not claims about a builder's actual clan.
  return {
    count: count!,
    clanTags: assignments.map((team) => `XP${team + 1}`),
  };
}
