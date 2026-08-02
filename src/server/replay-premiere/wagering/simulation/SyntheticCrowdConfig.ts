import { MIN_STAKE, STARTING_BANKROLL, maxStake } from "../ReplayPremiereMarketRules";
import type {
  SyntheticCrowdConfig,
  SyntheticCrowdPersonaKind,
} from "./SyntheticCrowdTypes";

export const DEFAULT_SYNTHETIC_CROWD_PERSONA_WEIGHTS: Readonly<
  Record<SyntheticCrowdPersonaKind, number>
> = {
  "favorite-backer": 3,
  "value-hunter": 2,
  "momentum-chaser": 2,
  "noise-trader": 1,
};

/**
 * Off by default (`enabled: false`) — this module exists to make thin
 * markets legible during demos and tester sessions and MUST stay off in
 * anything resembling production. Every field is overridable per run.
 *
 * `bankrollEach`/`minStake`/`maxStake` are pinned to the real market's own
 * `STARTING_BANKROLL`/`MIN_STAKE`/`maxStake()` rules (ReplayPremiereMarketRules.ts)
 * rather than duplicated magic numbers, so a synthetic bettor's self-sizing
 * matches what the server will actually grant/accept and doesn't spuriously
 * trip `insufficient_funds`/`above_max_stake` rejections.
 */
export const DEFAULT_SYNTHETIC_CROWD_CONFIG: SyntheticCrowdConfig = {
  enabled: false,
  count: 8,
  seed: 1,
  bankrollEach: STARTING_BANKROLL,
  aggressiveness: 0.5,
  minStake: MIN_STAKE,
  maxStake: maxStake(STARTING_BANKROLL),
  threshold: 3,
  activityCurve: "u-shaped",
  activityProbability: 0.35,
  personaWeights: DEFAULT_SYNTHETIC_CROWD_PERSONA_WEIGHTS,
};
