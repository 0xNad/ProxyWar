import { createHash } from "node:crypto";
import { GameConfigSchema, type GameConfig } from "../../core/Schemas";

export const COMMANDER_GAME_ID_DERIVATION_VERSION =
  "commander-seed-sha256-hex6-v1";

export interface CommanderCanonicalPublicGameModifiers {
  isCompact: boolean | null;
  isRandomSpawn: boolean | null;
  isCrowded: boolean | null;
  isHardNations: boolean | null;
  startingGold: number | null;
  goldMultiplier: number | null;
  isAlliancesDisabled: boolean | null;
  isPortsDisabled: boolean | null;
  isNukesDisabled: boolean | null;
  isSAMsDisabled: boolean | null;
  isPeaceTime: boolean | null;
  isWaterNukes: boolean | null;
}

export interface CommanderCanonicalHostCheats {
  infiniteGold: boolean | null;
  infiniteTroops: boolean | null;
  goldMultiplier: number | null;
  startingGold: number | null;
}

/**
 * Exact, bounded projection of every GameConfig field that can affect the
 * simulation. Optional source fields are represented explicitly as null so
 * JSON persistence cannot silently erase a mismatch.
 */
export interface CommanderCanonicalGameConfig {
  gameMap: string;
  difficulty: string;
  donateGold: boolean;
  donateTroops: boolean;
  /** Present only when enabled; absence is the byte-stable default false. */
  donateToNonFriendly?: true;
  gameType: string;
  gameMode: string;
  rankedType: string | null;
  gameMapSize: string;
  publicGameModifiers: CommanderCanonicalPublicGameModifiers | null;
  nations: number | "default" | "disabled";
  bots: number;
  infiniteGold: boolean;
  infiniteTroops: boolean;
  instantBuild: boolean;
  disableNavMesh: boolean | null;
  disableAlliances: boolean | null;
  waterNukes: boolean | null;
  randomSpawn: boolean;
  maxPlayers: number | null;
  maxTimerValue: number | null;
  spawnImmunityDuration: number | null;
  disabledUnits: string[];
  playerTeams: number | string | null;
  goldMultiplier: number | null;
  startingGold: number | null;
  hostCheats: CommanderCanonicalHostCheats | null;
}

export function commanderGameIDFromSeed(seed: string): string {
  if (seed.trim() === "") {
    throw new Error("Commander execution seed must be non-empty");
  }
  return `CM${createHash("sha256").update(seed).digest("hex").slice(0, 6)}`;
}

export function normalizeCommanderGameConfig(
  config: GameConfig,
): CommanderCanonicalGameConfig {
  return {
    gameMap: String(config.gameMap),
    difficulty: String(config.difficulty),
    donateGold: config.donateGold,
    donateTroops: config.donateTroops,
    ...(config.donateToNonFriendly === true
      ? { donateToNonFriendly: true as const }
      : {}),
    gameType: String(config.gameType),
    gameMode: String(config.gameMode),
    rankedType:
      config.rankedType === undefined ? null : String(config.rankedType),
    gameMapSize: String(config.gameMapSize),
    publicGameModifiers:
      config.publicGameModifiers === undefined
        ? null
        : {
            isCompact: config.publicGameModifiers.isCompact ?? null,
            isRandomSpawn: config.publicGameModifiers.isRandomSpawn ?? null,
            isCrowded: config.publicGameModifiers.isCrowded ?? null,
            isHardNations: config.publicGameModifiers.isHardNations ?? null,
            startingGold: config.publicGameModifiers.startingGold ?? null,
            goldMultiplier: config.publicGameModifiers.goldMultiplier ?? null,
            isAlliancesDisabled:
              config.publicGameModifiers.isAlliancesDisabled ?? null,
            isPortsDisabled: config.publicGameModifiers.isPortsDisabled ?? null,
            isNukesDisabled: config.publicGameModifiers.isNukesDisabled ?? null,
            isSAMsDisabled: config.publicGameModifiers.isSAMsDisabled ?? null,
            isPeaceTime: config.publicGameModifiers.isPeaceTime ?? null,
            isWaterNukes: config.publicGameModifiers.isWaterNukes ?? null,
          },
    nations: config.nations,
    bots: config.bots,
    infiniteGold: config.infiniteGold,
    infiniteTroops: config.infiniteTroops,
    instantBuild: config.instantBuild,
    disableNavMesh: config.disableNavMesh ?? null,
    disableAlliances: config.disableAlliances ?? null,
    waterNukes: config.waterNukes ?? null,
    randomSpawn: config.randomSpawn,
    maxPlayers: config.maxPlayers ?? null,
    maxTimerValue: config.maxTimerValue ?? null,
    spawnImmunityDuration: config.spawnImmunityDuration ?? null,
    disabledUnits: [...(config.disabledUnits ?? [])].map(String).sort(),
    playerTeams: config.playerTeams ?? null,
    goldMultiplier: config.goldMultiplier ?? null,
    startingGold: config.startingGold ?? null,
    hostCheats:
      config.hostCheats === undefined
        ? null
        : {
            infiniteGold: config.hostCheats.infiniteGold ?? null,
            infiniteTroops: config.hostCheats.infiniteTroops ?? null,
            goldMultiplier: config.hostCheats.goldMultiplier ?? null,
            startingGold: config.hostCheats.startingGold ?? null,
          },
  };
}

export function parseCommanderCanonicalGameConfig(
  value: unknown,
): CommanderCanonicalGameConfig {
  const hasDonationAudience =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "donateToNonFriendly");
  const config = exactRecord(
    value,
    hasDonationAudience
      ? canonicalGameConfigKeys
      : legacyCanonicalGameConfigKeys,
  );
  const publicGameModifiers =
    config.publicGameModifiers === null
      ? null
      : parsePublicGameModifiers(config.publicGameModifiers);
  const hostCheats =
    config.hostCheats === null ? null : parseHostCheats(config.hostCheats);
  const nations = config.nations;
  if (
    !(
      (Number.isSafeInteger(nations) &&
        Number(nations) >= 1 &&
        Number(nations) <= 400) ||
      nations === "default" ||
      nations === "disabled"
    )
  ) {
    throw new Error("Commander selected game configuration is malformed");
  }
  const disabledUnits = stringArray(config.disabledUnits);
  if (
    new Set(disabledUnits).size !== disabledUnits.length ||
    disabledUnits.some(
      (entry, index) => index > 0 && disabledUnits[index - 1]! > entry,
    )
  ) {
    throw new Error("Commander selected game configuration is malformed");
  }
  const playerTeams = config.playerTeams;
  if (
    playerTeams !== null &&
    typeof playerTeams !== "string" &&
    !Number.isFinite(playerTeams)
  ) {
    throw new Error("Commander selected game configuration is malformed");
  }
  const parsed: CommanderCanonicalGameConfig = {
    gameMap: requiredString(config.gameMap),
    difficulty: requiredString(config.difficulty),
    donateGold: requiredBoolean(config.donateGold),
    donateTroops: requiredBoolean(config.donateTroops),
    ...(hasDonationAudience
      ? { donateToNonFriendly: requiredEnabled(config.donateToNonFriendly) }
      : {}),
    gameType: requiredString(config.gameType),
    gameMode: requiredString(config.gameMode),
    rankedType: nullableString(config.rankedType),
    gameMapSize: requiredString(config.gameMapSize),
    publicGameModifiers,
    nations: nations as CommanderCanonicalGameConfig["nations"],
    bots: requiredSafeInteger(config.bots, 0, 400),
    infiniteGold: requiredBoolean(config.infiniteGold),
    infiniteTroops: requiredBoolean(config.infiniteTroops),
    instantBuild: requiredBoolean(config.instantBuild),
    disableNavMesh: nullableBoolean(config.disableNavMesh),
    disableAlliances: nullableBoolean(config.disableAlliances),
    waterNukes: nullableBoolean(config.waterNukes),
    randomSpawn: requiredBoolean(config.randomSpawn),
    maxPlayers: nullableFiniteNumber(config.maxPlayers),
    maxTimerValue: nullableFiniteNumber(config.maxTimerValue),
    spawnImmunityDuration: nullableFiniteNumber(config.spawnImmunityDuration),
    disabledUnits,
    playerTeams: playerTeams as number | string | null,
    goldMultiplier: nullableFiniteNumber(config.goldMultiplier),
    startingGold: nullableFiniteNumber(config.startingGold),
    hostCheats,
  };
  const schemaResult = GameConfigSchema.safeParse(
    canonicalGameConfigSource(parsed),
  );
  if (!schemaResult.success) {
    throw new Error("Commander selected game configuration is malformed");
  }
  const normalized = normalizeCommanderGameConfig(schemaResult.data);
  if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
    throw new Error("Commander selected game configuration is malformed");
  }
  return normalized;
}

function canonicalGameConfigSource(
  config: CommanderCanonicalGameConfig,
): Record<string, unknown> {
  const source: Record<string, unknown> = {
    gameMap: config.gameMap,
    difficulty: config.difficulty,
    donateGold: config.donateGold,
    donateTroops: config.donateTroops,
    donateToNonFriendly: config.donateToNonFriendly ?? false,
    gameType: config.gameType,
    gameMode: config.gameMode,
    gameMapSize: config.gameMapSize,
    nations: config.nations,
    bots: config.bots,
    infiniteGold: config.infiniteGold,
    infiniteTroops: config.infiniteTroops,
    instantBuild: config.instantBuild,
    randomSpawn: config.randomSpawn,
    disabledUnits: [...config.disabledUnits],
  };
  addNonNull(source, "rankedType", config.rankedType);
  addNonNull(source, "disableNavMesh", config.disableNavMesh);
  addNonNull(source, "disableAlliances", config.disableAlliances);
  addNonNull(source, "waterNukes", config.waterNukes);
  addNonNull(source, "maxPlayers", config.maxPlayers);
  addNonNull(source, "maxTimerValue", config.maxTimerValue);
  addNonNull(source, "spawnImmunityDuration", config.spawnImmunityDuration);
  addNonNull(source, "playerTeams", config.playerTeams);
  addNonNull(source, "goldMultiplier", config.goldMultiplier);
  addNonNull(source, "startingGold", config.startingGold);
  if (config.publicGameModifiers !== null) {
    const modifiers: Record<string, unknown> = {};
    addNonNull(modifiers, "isCompact", config.publicGameModifiers.isCompact);
    addNonNull(
      modifiers,
      "isRandomSpawn",
      config.publicGameModifiers.isRandomSpawn,
    );
    addNonNull(modifiers, "isCrowded", config.publicGameModifiers.isCrowded);
    addNonNull(
      modifiers,
      "isHardNations",
      config.publicGameModifiers.isHardNations,
    );
    addNonNull(
      modifiers,
      "startingGold",
      config.publicGameModifiers.startingGold,
    );
    addNonNull(
      modifiers,
      "goldMultiplier",
      config.publicGameModifiers.goldMultiplier,
    );
    addNonNull(
      modifiers,
      "isAlliancesDisabled",
      config.publicGameModifiers.isAlliancesDisabled,
    );
    addNonNull(
      modifiers,
      "isPortsDisabled",
      config.publicGameModifiers.isPortsDisabled,
    );
    addNonNull(
      modifiers,
      "isNukesDisabled",
      config.publicGameModifiers.isNukesDisabled,
    );
    addNonNull(
      modifiers,
      "isSAMsDisabled",
      config.publicGameModifiers.isSAMsDisabled,
    );
    addNonNull(
      modifiers,
      "isPeaceTime",
      config.publicGameModifiers.isPeaceTime,
    );
    addNonNull(
      modifiers,
      "isWaterNukes",
      config.publicGameModifiers.isWaterNukes,
    );
    source.publicGameModifiers = modifiers;
  }
  if (config.hostCheats !== null) {
    const hostCheats: Record<string, unknown> = {};
    addNonNull(hostCheats, "infiniteGold", config.hostCheats.infiniteGold);
    addNonNull(hostCheats, "infiniteTroops", config.hostCheats.infiniteTroops);
    addNonNull(hostCheats, "goldMultiplier", config.hostCheats.goldMultiplier);
    addNonNull(hostCheats, "startingGold", config.hostCheats.startingGold);
    source.hostCheats = hostCheats;
  }
  return source;
}

function addNonNull(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== null) target[key] = value;
}

const canonicalGameConfigKeys = [
  "gameMap",
  "difficulty",
  "donateGold",
  "donateTroops",
  "donateToNonFriendly",
  "gameType",
  "gameMode",
  "rankedType",
  "gameMapSize",
  "publicGameModifiers",
  "nations",
  "bots",
  "infiniteGold",
  "infiniteTroops",
  "instantBuild",
  "disableNavMesh",
  "disableAlliances",
  "waterNukes",
  "randomSpawn",
  "maxPlayers",
  "maxTimerValue",
  "spawnImmunityDuration",
  "disabledUnits",
  "playerTeams",
  "goldMultiplier",
  "startingGold",
  "hostCheats",
] as const;

const legacyCanonicalGameConfigKeys = canonicalGameConfigKeys.filter(
  (key) => key !== "donateToNonFriendly",
);

const publicGameModifierKeys = [
  "isCompact",
  "isRandomSpawn",
  "isCrowded",
  "isHardNations",
  "startingGold",
  "goldMultiplier",
  "isAlliancesDisabled",
  "isPortsDisabled",
  "isNukesDisabled",
  "isSAMsDisabled",
  "isPeaceTime",
  "isWaterNukes",
] as const;

const hostCheatKeys = [
  "infiniteGold",
  "infiniteTroops",
  "goldMultiplier",
  "startingGold",
] as const;

function parsePublicGameModifiers(
  value: unknown,
): CommanderCanonicalPublicGameModifiers {
  const modifiers = exactRecord(value, publicGameModifierKeys);
  return {
    isCompact: nullableBoolean(modifiers.isCompact),
    isRandomSpawn: nullableBoolean(modifiers.isRandomSpawn),
    isCrowded: nullableBoolean(modifiers.isCrowded),
    isHardNations: nullableBoolean(modifiers.isHardNations),
    startingGold: nullableFiniteNumber(modifiers.startingGold),
    goldMultiplier: nullableFiniteNumber(modifiers.goldMultiplier),
    isAlliancesDisabled: nullableBoolean(modifiers.isAlliancesDisabled),
    isPortsDisabled: nullableBoolean(modifiers.isPortsDisabled),
    isNukesDisabled: nullableBoolean(modifiers.isNukesDisabled),
    isSAMsDisabled: nullableBoolean(modifiers.isSAMsDisabled),
    isPeaceTime: nullableBoolean(modifiers.isPeaceTime),
    isWaterNukes: nullableBoolean(modifiers.isWaterNukes),
  };
}

function parseHostCheats(value: unknown): CommanderCanonicalHostCheats {
  const hostCheats = exactRecord(value, hostCheatKeys);
  return {
    infiniteGold: nullableBoolean(hostCheats.infiniteGold),
    infiniteTroops: nullableBoolean(hostCheats.infiniteTroops),
    goldMultiplier: nullableFiniteNumber(hostCheats.goldMultiplier),
    startingGold: nullableFiniteNumber(hostCheats.startingGold),
  };
}

function exactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Commander selected game configuration is malformed");
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error("Commander selected game configuration is malformed");
  }
  return record as Record<Keys[number], unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Commander selected game configuration is malformed");
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Commander selected game configuration is malformed");
  }
  return value;
}

function requiredEnabled(value: unknown): true {
  if (requiredBoolean(value) !== true) {
    throw new Error("Commander selected game configuration is malformed");
  }
  return true;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null) return null;
  return requiredBoolean(value);
}

function requiredSafeInteger(value: unknown, min: number, max: number): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  ) {
    throw new Error("Commander selected game configuration is malformed");
  }
  return Number(value);
}

function nullableFiniteNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Commander selected game configuration is malformed");
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("Commander selected game configuration is malformed");
  }
  return [...value];
}
