import {
  parseCoworldSeed,
  type CoworldEpisodeSeedContract,
  type CoworldSeedConfig,
} from "./coworld-seed";

export type CoworldEpisodeConfig = CoworldSeedConfig & {
  tokens: string[];
  players: Array<{ name: string }>;
  max_decision_steps: number;
  turns_per_decision_step: number;
  max_decision_ms: number;
  map: string;
  map_size: string;
  difficulty: string;
  replay_tail_turns?: number;
  player_connect_timeout_seconds?: number;
};

export function assembleCoworldResults<T extends object>(
  base: T,
  seedContract: CoworldEpisodeSeedContract,
): T & CoworldEpisodeSeedContract["results"] {
  return { ...base, ...seedContract.results };
}

export function assembleCoworldReplay<T extends object>(
  base: T,
  seedContract: CoworldEpisodeSeedContract,
): T & CoworldEpisodeSeedContract["replay"] {
  return { ...base, ...seedContract.replay };
}

export function assembleCoworldRunnerConfig<T extends object>(
  base: T,
  seedContract: CoworldEpisodeSeedContract,
): T & CoworldEpisodeSeedContract["runner"] {
  return { ...base, ...seedContract.runner };
}

export function publicCoworldConfig(
  config: CoworldEpisodeConfig,
): Record<string, unknown> {
  return {
    players: config.players,
    max_decision_steps: config.max_decision_steps,
    turns_per_decision_step: config.turns_per_decision_step,
    max_decision_ms: config.max_decision_ms,
    map: config.map,
    map_size: config.map_size,
    difficulty: config.difficulty,
    seed: config.seed,
    replay_tail_turns: config.replay_tail_turns,
    player_connect_timeout_seconds: config.player_connect_timeout_seconds,
    player_count: config.tokens.length,
  };
}

export function replayCoworldConfig(
  payload: unknown,
): CoworldEpisodeConfig | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    !("config" in payload) ||
    (payload as { config?: unknown }).config === null ||
    typeof (payload as { config?: unknown }).config !== "object"
  ) {
    return null;
  }
  const config = (payload as { config: Record<string, unknown> }).config;
  const players = Array.isArray(config.players)
    ? (config.players as Array<{ name: string }>)
    : [];
  const playerCount =
    typeof config.player_count === "number"
      ? config.player_count
      : players.length;
  return {
    tokens: Array.from({ length: playerCount }, () => ""),
    players,
    max_decision_steps: Number(config.max_decision_steps ?? 1),
    turns_per_decision_step: Number(config.turns_per_decision_step ?? 1),
    max_decision_ms: Number(config.max_decision_ms ?? 1000),
    map: String(config.map ?? "Pangaea"),
    map_size: String(config.map_size ?? "Compact"),
    difficulty: String(config.difficulty ?? "Easy"),
    seed: parseCoworldSeed(config.seed),
    replay_tail_turns:
      typeof config.replay_tail_turns === "number"
        ? config.replay_tail_turns
        : undefined,
    player_connect_timeout_seconds:
      typeof config.player_connect_timeout_seconds === "number"
        ? config.player_connect_timeout_seconds
        : 1,
  };
}
