import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { UnitType } from "../../core/game/Game";
import {
  agentStrategyProfiles,
  type AgentGamePhase,
  type AgentObservation,
} from "./AgentTypes";
import { sanitizeUntrustedDisplayString } from "./PromptSanitizer";
import {
  commanderReplanTriggers,
  MAX_COMMANDER_HORIZON_DECISIONS,
  MIN_COMMANDER_HORIZON_DECISIONS,
  type BuiltCommanderState,
  type CommanderPlanSnapshot,
  type CommanderRecentEvent,
  type CommanderRivalState,
  type CommanderState,
  type DevelopEconomyStrategicOptionEvidence,
  type ExpandStrategicOptionEvidence,
  type ExposedStrategicOption,
  type PressureRivalStrategicOptionEvidence,
  type StrategicOptionFamily,
  type StrategicOptionId,
  type SurviveStrategicOptionEvidence,
} from "./StrategicCommanderTypes";
import { MAX_EXPOSED_STRATEGIC_OPTIONS } from "./StrategicOptionBuilder";

export const MAX_COMMANDER_RIVALS = 6;
export const MAX_COMMANDER_RECENT_EVENTS = 8;
export const MAX_COMMANDER_RECENT_EVENT_LENGTH = 120;
export const MAX_COMMANDER_PLAN_ATTACKER_IDS = 6;
export const MAX_COMMANDER_PLAYER_ID_LENGTH = 128;
export const MAX_COMMANDER_OPTION_ID_LENGTH = 160;
export const MAX_COMMANDER_REQUEST_ID_LENGTH = 256;
export const MAX_COMMANDER_CANONICAL_STRING_LENGTH = 256;
export const MAX_COMMANDER_CANONICAL_JSON_BYTES = 32_768;

const MAX_GOLD_DIGITS = 40;
const MAX_STRUCTURE_COUNT = 9_999;
const OPTION_SET_FINGERPRINT_DOMAIN =
  "proxywar-strategic-commander-option-set-v1";
const MATERIAL_STATE_FINGERPRINT_DOMAIN =
  "proxywar-strategic-commander-material-state-v1";
const commanderGamePhases: readonly AgentGamePhase[] = [
  "lobby",
  "spawn",
  "active",
  "finished",
  "unknown",
];

export interface BuildCommanderStateInput {
  observation: AgentObservation;
  exposedOptions: readonly ExposedStrategicOption[];
  decisionSequence: number;
  plan?: CommanderPlanSnapshot | null;
  recentEvents?: readonly CommanderRecentEvent[];
}

export interface CommanderMaterialFingerprintInput {
  gameID: string;
  agentID: string;
  state: CommanderState;
}

export class CommanderStateBuilder {
  build(input: BuildCommanderStateInput): BuiltCommanderState {
    return buildCommanderState(input);
  }
}

/**
 * Builds the only state object a StrategicCommander may see. The API cannot
 * receive AgentBrainInput, LegalAction, or binding-bearing candidates.
 */
export function buildCommanderState(
  input: BuildCommanderStateInput,
): BuiltCommanderState {
  const own = input.observation.ownState;
  if (own === null) {
    throw new Error("Commander state requires available own player state");
  }
  assertNonNegativeInteger(input.decisionSequence, "decisionSequence");

  const options = normalizeExposedOptions(input.exposedOptions);
  const incomingAttackers = new Set(
    input.observation.combat.incomingAttackPlayerIDs,
  );
  const outgoingTargets = new Set(
    input.observation.combat.outgoingAttackPlayerIDs,
  );
  const rivals = selectRivals({
    observation: input.observation,
    options,
    planTargetPlayerID: input.plan?.targetPlayerID ?? null,
    incomingAttackers,
    outgoingTargets,
  });
  const alivePlayerCount =
    input.observation.alivePlayerCount ??
    (own.isAlive ? 1 : 0) +
      input.observation.visiblePlayers.filter((player) => player.isAlive)
        .length;
  const state: CommanderState = {
    self: {
      name: sanitizeUntrustedDisplayString(input.observation.username),
      profile: enumValue(
        input.observation.profile,
        agentStrategyProfiles,
        "observation.profile",
      ),
      phase: enumValue(
        input.observation.phase,
        commanderGamePhases,
        "observation.phase",
      ),
      turnNumber: nonNegativeInteger(
        input.observation.turnNumber,
        "observation.turnNumber",
      ),
      tick:
        input.observation.tick === null
          ? null
          : nonNegativeInteger(input.observation.tick, "observation.tick"),
      decisionSequence: input.decisionSequence,
      territoryRank:
        1 +
        input.observation.visiblePlayers.filter(
          (player) => player.isAlive && player.tilesOwned > own.tilesOwned,
        ).length,
      alivePlayerCount: nonNegativeInteger(
        alivePlayerCount,
        "observation.alivePlayerCount",
      ),
      troops: nonNegativeFinite(own.troops, "ownState.troops"),
      maxTroops: optionalNonNegativeFinite(own.maxTroops, "ownState.maxTroops"),
      troopRatio: optionalUnitInterval(own.troopRatio, "ownState.troopRatio"),
      gold: boundedGold(own.gold, "ownState.gold"),
      tilesOwned: nonNegativeInteger(own.tilesOwned, "ownState.tilesOwned"),
      tileShare: optionalUnitInterval(own.tileShare, "ownState.tileShare"),
      borderTiles: nonNegativeInteger(own.borderTiles, "ownState.borderTiles"),
      incomingAttacks: nonNegativeInteger(
        own.incomingAttacks,
        "ownState.incomingAttacks",
      ),
      outgoingAttacks: nonNegativeInteger(
        own.outgoingAttacks,
        "ownState.outgoingAttacks",
      ),
      structures: {
        cities: boundedStructureCount(own.unitCounts?.[UnitType.City]),
        factories: boundedStructureCount(own.unitCounts?.[UnitType.Factory]),
        ports: boundedStructureCount(own.unitCounts?.[UnitType.Port]),
        defensePosts: boundedStructureCount(
          own.unitCounts?.[UnitType.DefensePost],
        ),
        samLaunchers: boundedStructureCount(
          own.unitCounts?.[UnitType.SAMLauncher],
        ),
      },
    },
    rivals,
    plan: normalizePlan(
      input.plan ?? null,
      new Set(
        input.observation.visiblePlayers.map((player) => player.playerID),
      ),
    ),
    recentEvents: normalizeRecentEvents(
      input.recentEvents ?? [],
      new Set(
        input.observation.visiblePlayers.map((player) => player.playerID),
      ),
    ),
    options,
  };

  return {
    state,
    fingerprints: {
      exposedOptionSet: fingerprintExposedOptionSet(options),
      materialState: fingerprintCommanderMaterialState({
        gameID: input.observation.gameID,
        agentID: input.observation.agentID,
        state,
      }),
    },
  };
}

export function fingerprintExposedOptionSet(
  options: readonly ExposedStrategicOption[],
): string {
  if (options.length > MAX_EXPOSED_STRATEGIC_OPTIONS) {
    throw new Error("Option-set fingerprint exceeds the exposure bound");
  }
  const optionIDs = [
    ...new Set(
      options.map((option) =>
        boundedIdentifier(
          option.id,
          "option-set fingerprint option.id",
          MAX_COMMANDER_OPTION_ID_LENGTH,
        ),
      ),
    ),
  ].sort(stableStringCompare);
  return shortFingerprint(OPTION_SET_FINGERPRINT_DOMAIN, optionIDs);
}

export function fingerprintCommanderMaterialState(
  input: CommanderMaterialFingerprintInput,
): string {
  const state = input.state;
  assertFingerprintStateBounds(state);
  const projection: CommanderJsonValue = [
    boundedIdentifier(
      input.gameID,
      "fingerprint.gameID",
      MAX_COMMANDER_REQUEST_ID_LENGTH,
    ),
    boundedIdentifier(
      input.agentID,
      "fingerprint.agentID",
      MAX_COMMANDER_REQUEST_ID_LENGTH,
    ),
    state.self.turnNumber,
    state.self.decisionSequence,
    [...state.options].map((option) => option.id).sort(stableStringCompare),
    [state.self.troops, state.self.tilesOwned, state.self.incomingAttacks],
    [...state.rivals]
      .sort((a, b) => stableStringCompare(a.playerID, b.playerID))
      .map((rival) => [
        rival.playerID,
        rival.isAlive,
        rival.tilesOwned,
        rival.sharesBorder,
      ]),
  ];
  return shortFingerprint(MATERIAL_STATE_FINGERPRINT_DOMAIN, projection);
}

function assertFingerprintStateBounds(state: CommanderState): void {
  if (
    state.rivals.length > MAX_COMMANDER_RIVALS ||
    state.options.length > MAX_EXPOSED_STRATEGIC_OPTIONS ||
    state.recentEvents.length > MAX_COMMANDER_RECENT_EVENTS ||
    (state.plan?.progress.newIncomingAttackerIDs.length ?? 0) >
      MAX_COMMANDER_PLAN_ATTACKER_IDS
  ) {
    throw new Error("Commander state exceeds a material fingerprint bound");
  }
  for (const rival of state.rivals) {
    boundedIdentifier(
      rival.playerID,
      "fingerprint.rival.playerID",
      MAX_COMMANDER_PLAYER_ID_LENGTH,
    );
  }
  for (const option of state.options) {
    boundedIdentifier(
      option.id,
      "fingerprint.option.id",
      MAX_COMMANDER_OPTION_ID_LENGTH,
    );
    if (option.targetPlayerID !== null) {
      boundedIdentifier(
        option.targetPlayerID,
        "fingerprint.option.targetPlayerID",
        MAX_COMMANDER_PLAYER_ID_LENGTH,
      );
    }
  }
  if (state.plan !== null) {
    const planID = boundedIdentifier(
      state.plan.selectedStrategicOptionId,
      "fingerprint.plan.selectedStrategicOptionId",
      MAX_COMMANDER_OPTION_ID_LENGTH,
    ) as StrategicOptionId;
    const planTarget =
      state.plan.targetPlayerID === null
        ? null
        : boundedIdentifier(
            state.plan.targetPlayerID,
            "fingerprint.plan.targetPlayerID",
            MAX_COMMANDER_PLAYER_ID_LENGTH,
          );
    assertStrategicIdentity(
      planID,
      state.plan.family,
      planTarget,
      "fingerprint.plan",
    );
    for (const playerID of state.plan.progress.newIncomingAttackerIDs) {
      boundedIdentifier(
        playerID,
        "fingerprint.plan.progress.newIncomingAttackerIDs",
        MAX_COMMANDER_PLAYER_ID_LENGTH,
      );
    }
  }
  for (const event of state.recentEvents) {
    if (
      typeof event !== "string" ||
      event.length > MAX_COMMANDER_RECENT_EVENT_LENGTH ||
      sanitizeUntrustedDisplayString(
        event,
        MAX_COMMANDER_RECENT_EVENT_LENGTH,
      ) !== event
    ) {
      throw new Error("Commander state contains an invalid recent event");
    }
  }
}

/** Canonical JSON for prompt serialization and the two fingerprint preimages. */
export function canonicalCommanderJson(value: unknown): string {
  const budget = { nodes: 0 };
  const canonical = canonicalize(value, 0, budget);
  if (
    Buffer.byteLength(canonical, "utf8") > MAX_COMMANDER_CANONICAL_JSON_BYTES
  ) {
    throw new Error("Commander canonical JSON exceeds its byte bound");
  }
  return canonical;
}

function selectRivals(input: {
  observation: AgentObservation;
  options: readonly ExposedStrategicOption[];
  planTargetPlayerID: string | null;
  incomingAttackers: ReadonlySet<string>;
  outgoingTargets: ReadonlySet<string>;
}): CommanderRivalState[] {
  const projected = input.observation.visiblePlayers
    .map((player) => {
      const playerID = boundedIdentifier(
        player.playerID,
        "rival.playerID",
        MAX_COMMANDER_PLAYER_ID_LENGTH,
      );
      return {
        playerID,
        name: sanitizeUntrustedDisplayString(player.name),
        isAlive: booleanValue(player.isAlive, `rival ${playerID} isAlive`),
        isDisconnected: booleanValue(
          player.isDisconnected,
          `rival ${playerID} isDisconnected`,
        ),
        troops: nonNegativeFinite(player.troops, `rival ${playerID} troops`),
        tilesOwned: nonNegativeInteger(
          player.tilesOwned,
          `rival ${playerID} tilesOwned`,
        ),
        tileShare: optionalUnitInterval(
          player.tileShare,
          `rival ${playerID} tileShare`,
        ),
        sharesBorder: booleanValue(
          player.sharesBorder,
          `rival ${playerID} sharesBorder`,
        ),
        isAllied: booleanValue(player.isAllied, `rival ${playerID} isAllied`),
        attackedMeRecently: input.incomingAttackers.has(playerID),
        iAmAttackingThem: input.outgoingTargets.has(playerID),
      };
    })
    .sort((a, b) => stableStringCompare(a.playerID, b.playerID));
  const byID = new Map<string, CommanderRivalState>();
  for (const rival of projected) {
    if (byID.has(rival.playerID)) {
      throw new Error(
        `Commander state has duplicate rival id: ${rival.playerID}`,
      );
    }
    byID.set(rival.playerID, rival);
  }

  const mandatoryTargetIDs = [
    ...new Set([
      ...input.options
        .map((option) => option.targetPlayerID)
        .filter((id): id is string => id !== null),
      ...(input.planTargetPlayerID === null
        ? []
        : [
            boundedIdentifier(
              input.planTargetPlayerID,
              "plan.targetPlayerID",
              MAX_COMMANDER_PLAYER_ID_LENGTH,
            ),
          ]),
    ]),
  ].sort(stableStringCompare);
  if (mandatoryTargetIDs.length > MAX_COMMANDER_RIVALS) {
    throw new Error(
      "Commander option and plan targets exceed the rival-state bound",
    );
  }
  for (const id of mandatoryTargetIDs) {
    if (!byID.has(id)) {
      throw new Error(`Commander target is not visible: ${id}`);
    }
  }

  const byPlayerID = (ids: Iterable<string>) =>
    [...new Set(ids)].sort(stableStringCompare);
  const aliveRivals = [...byID.values()].filter((rival) => rival.isAlive);
  const remainingByTerritory = aliveRivals.sort(
    (a, b) =>
      b.tilesOwned - a.tilesOwned ||
      stableStringCompare(a.playerID, b.playerID),
  );
  const selectionGroups: string[][] = [
    mandatoryTargetIDs,
    byPlayerID(input.incomingAttackers),
    byPlayerID(input.outgoingTargets),
    byPlayerID(
      aliveRivals
        .filter((rival) => rival.sharesBorder)
        .map((rival) => rival.playerID),
    ),
    remainingByTerritory.map((rival) => rival.playerID),
  ];
  const selected = new Set<string>();
  for (const group of selectionGroups) {
    for (const id of group) {
      if (!byID.has(id)) {
        continue;
      }
      selected.add(id);
      if (selected.size === MAX_COMMANDER_RIVALS) {
        break;
      }
    }
    if (selected.size === MAX_COMMANDER_RIVALS) {
      break;
    }
  }

  return [...selected].sort(stableStringCompare).map((id) => byID.get(id)!);
}

function normalizeExposedOptions(
  options: readonly ExposedStrategicOption[],
): ExposedStrategicOption[] {
  if (!Array.isArray(options)) {
    throw new Error("Commander options must be an array");
  }
  if (options.length > MAX_EXPOSED_STRATEGIC_OPTIONS) {
    throw new Error(
      `Commander options exceed ${MAX_EXPOSED_STRATEGIC_OPTIONS}`,
    );
  }
  const normalized = options.map(normalizeExposedOption);
  const seenOptionIDs = new Set<StrategicOptionId>();
  for (const option of normalized) {
    if (seenOptionIDs.has(option.id)) {
      throw new Error(`Commander options contain duplicate id: ${option.id}`);
    }
    seenOptionIDs.add(option.id);
  }
  return normalized;
}

function normalizeExposedOption(
  option: ExposedStrategicOption,
): ExposedStrategicOption {
  const optionID = boundedIdentifier(
    option.id,
    "option.id",
    MAX_COMMANDER_OPTION_ID_LENGTH,
  ) as StrategicOptionId;
  const targetPlayerID =
    option.targetPlayerID === null
      ? null
      : boundedIdentifier(
          option.targetPlayerID,
          "option.targetPlayerID",
          MAX_COMMANDER_PLAYER_ID_LENGTH,
        );
  const common = {
    id: optionID,
    family: option.family,
    targetPlayerID,
    targetName:
      option.targetName === null
        ? null
        : sanitizeUntrustedDisplayString(option.targetName),
  };
  switch (option.family) {
    case "expand": {
      assertOptionIdentity(option, "expand", null);
      const evidence = option.evidence as ExpandStrategicOptionEvidence;
      return {
        ...common,
        evidence: {
          neutralLandReachable: booleanValue(
            evidence.neutralLandReachable,
            "expand.neutralLandReachable",
          ),
          neutralBoatReachable: booleanValue(
            evidence.neutralBoatReachable,
            "expand.neutralBoatReachable",
          ),
          ownTroops: nonNegativeFinite(evidence.ownTroops, "expand.ownTroops"),
          ownTiles: nonNegativeInteger(evidence.ownTiles, "expand.ownTiles"),
        },
      };
    }
    case "develop_economy": {
      assertOptionIdentity(option, "develop_economy", null);
      const evidence = option.evidence as DevelopEconomyStrategicOptionEvidence;
      return {
        ...common,
        evidence: {
          economicBuildAvailable: booleanValue(
            evidence.economicBuildAvailable,
            "develop_economy.economicBuildAvailable",
          ),
          economicUpgradeAvailable: booleanValue(
            evidence.economicUpgradeAvailable,
            "develop_economy.economicUpgradeAvailable",
          ),
          gold: boundedGold(evidence.gold, "develop_economy.gold"),
          ownTiles: nonNegativeInteger(
            evidence.ownTiles,
            "develop_economy.ownTiles",
          ),
        },
      };
    }
    case "pressure_rival": {
      if (targetPlayerID === null) {
        throw new Error("pressure_rival option requires targetPlayerID");
      }
      assertOptionIdentity(
        option,
        `pressure_rival:${targetPlayerID}`,
        targetPlayerID,
      );
      const evidence = option.evidence as PressureRivalStrategicOptionEvidence;
      return {
        ...common,
        evidence: {
          sharesBorder: booleanValue(
            evidence.sharesBorder,
            "pressure_rival.sharesBorder",
          ),
          targetTroops: nonNegativeFinite(
            evidence.targetTroops,
            "pressure_rival.targetTroops",
          ),
          targetTiles: nonNegativeInteger(
            evidence.targetTiles,
            "pressure_rival.targetTiles",
          ),
          ownTroops: nonNegativeFinite(
            evidence.ownTroops,
            "pressure_rival.ownTroops",
          ),
          targetIsAllied: booleanValue(
            evidence.targetIsAllied,
            "pressure_rival.targetIsAllied",
          ),
          targetAttackedMeRecently: booleanValue(
            evidence.targetAttackedMeRecently,
            "pressure_rival.targetAttackedMeRecently",
          ),
        },
      };
    }
    case "survive": {
      assertOptionIdentity(option, "survive", null);
      const evidence = option.evidence as SurviveStrategicOptionEvidence;
      return {
        ...common,
        evidence: {
          incomingAttackCount: nonNegativeInteger(
            evidence.incomingAttackCount,
            "survive.incomingAttackCount",
          ),
          strongerBorderRivalCount: nonNegativeInteger(
            evidence.strongerBorderRivalCount,
            "survive.strongerBorderRivalCount",
          ),
          ownTroops: nonNegativeFinite(evidence.ownTroops, "survive.ownTroops"),
          borderTiles: nonNegativeInteger(
            evidence.borderTiles,
            "survive.borderTiles",
          ),
        },
      };
    }
    default:
      throw new Error(
        `Commander option has unsupported family: ${String(option.family)}`,
      );
  }
}

function normalizePlan(
  plan: CommanderPlanSnapshot | null,
  knownRivalIDs: ReadonlySet<string>,
): CommanderPlanSnapshot | null {
  if (plan === null) {
    return null;
  }
  const selectedStrategicOptionId = boundedIdentifier(
    plan.selectedStrategicOptionId,
    "plan.selectedStrategicOptionId",
    MAX_COMMANDER_OPTION_ID_LENGTH,
  ) as StrategicOptionId;
  const targetPlayerID =
    plan.targetPlayerID === null
      ? null
      : knownRivalIdentifier(
          plan.targetPlayerID,
          knownRivalIDs,
          "plan.targetPlayerID",
        );
  assertStrategicIdentity(
    selectedStrategicOptionId,
    plan.family,
    targetPlayerID,
    "plan",
  );
  if (
    !Number.isInteger(plan.horizonDecisions) ||
    plan.horizonDecisions < MIN_COMMANDER_HORIZON_DECISIONS ||
    plan.horizonDecisions > MAX_COMMANDER_HORIZON_DECISIONS
  ) {
    throw new Error("Commander plan horizon is outside the bounded range");
  }
  if (!Array.isArray(plan.replanTriggers)) {
    throw new Error("Commander plan replan triggers must be an array");
  }
  const triggers = [...plan.replanTriggers];
  if (
    triggers.length > commanderReplanTriggers.length ||
    new Set(triggers).size !== triggers.length ||
    triggers.some(
      (trigger) =>
        !commanderReplanTriggers.includes(
          trigger as (typeof commanderReplanTriggers)[number],
        ),
    )
  ) {
    throw new Error("Commander plan replan triggers are invalid");
  }
  if (!Array.isArray(plan.progress.newIncomingAttackerIDs)) {
    throw new Error("Commander plan attacker IDs must be an array");
  }
  const newIncomingAttackerIDs = [
    ...new Set(
      plan.progress.newIncomingAttackerIDs.map((playerID) =>
        knownRivalIdentifier(
          playerID,
          knownRivalIDs,
          "plan.progress.newIncomingAttackerIDs",
        ),
      ),
    ),
  ]
    .sort(stableStringCompare)
    .slice(0, MAX_COMMANDER_PLAN_ATTACKER_IDS);
  return {
    selectedStrategicOptionId,
    family: plan.family,
    targetPlayerID,
    horizonDecisions: plan.horizonDecisions,
    replanTriggers: triggers.sort(stableStringCompare),
    progress: {
      decisionsExecuted: nonNegativeInteger(
        plan.progress.decisionsExecuted,
        "plan.progress.decisionsExecuted",
      ),
      tilesDelta: finiteNumber(
        plan.progress.tilesDelta,
        "plan.progress.tilesDelta",
      ),
      troopsDelta: finiteNumber(
        plan.progress.troopsDelta,
        "plan.progress.troopsDelta",
      ),
      newIncomingAttackerIDs,
    },
  };
}

function normalizeRecentEvents(
  events: readonly CommanderRecentEvent[],
  knownRivalIDs: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(events)) {
    throw new Error("Commander recent events must be an array");
  }
  return events.slice(-MAX_COMMANDER_RECENT_EVENTS).map((event) => {
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw new Error("Commander recent event has an unsupported kind");
    }
    let rendered: string;
    switch (event.kind) {
      case "territory_changed":
        rendered = `territory ${nonNegativeInteger(
          event.fromTiles,
          "recentEvents.fromTiles",
        )}→${nonNegativeInteger(
          event.toTiles,
          "recentEvents.toTiles",
        )} since plan start`;
        break;
      case "troops_changed":
        rendered = `troops ${nonNegativeFinite(
          event.fromTroops,
          "recentEvents.fromTroops",
        )}→${nonNegativeFinite(
          event.toTroops,
          "recentEvents.toTroops",
        )} since plan start`;
        break;
      case "incoming_attacker":
        rendered = `${knownRivalIdentifier(
          event.playerID,
          knownRivalIDs,
          "recentEvents.incoming_attacker.playerID",
        )} began attacking you`;
        break;
      case "rival_eliminated":
        rendered = `${knownRivalIdentifier(
          event.playerID,
          knownRivalIDs,
          "recentEvents.rival_eliminated.playerID",
        )} was eliminated`;
        break;
      default:
        throw new Error("Commander recent event has an unsupported kind");
    }
    const sanitized = sanitizeUntrustedDisplayString(
      rendered,
      MAX_COMMANDER_RECENT_EVENT_LENGTH,
    );
    if (sanitized !== rendered) {
      throw new Error(
        "Commander recent event exceeds its fixed template bound",
      );
    }
    return rendered;
  });
}

function assertOptionIdentity(
  option: ExposedStrategicOption,
  expectedID: string,
  expectedTargetID: string | null,
): void {
  if (option.id !== expectedID || option.targetPlayerID !== expectedTargetID) {
    throw new Error(`Commander option identity is inconsistent: ${option.id}`);
  }
  if (expectedTargetID === null && option.targetName !== null) {
    throw new Error(
      `Commander option has an unexpected target name: ${option.id}`,
    );
  }
}

function assertStrategicIdentity(
  id: StrategicOptionId,
  family: StrategicOptionFamily,
  targetPlayerID: string | null,
  field: string,
): void {
  let expectedID: string | null;
  switch (family) {
    case "expand":
    case "develop_economy":
    case "survive":
      expectedID = family;
      break;
    case "pressure_rival":
      expectedID =
        targetPlayerID === null ? null : `pressure_rival:${targetPlayerID}`;
      break;
    default:
      throw new Error(`${field} has an unsupported strategic family`);
  }
  if (expectedID === null || id !== expectedID) {
    throw new Error(`${field} strategic identity is inconsistent`);
  }
  if (family !== "pressure_rival" && targetPlayerID !== null) {
    throw new Error(`${field} unexpectedly targets a rival`);
  }
}

function knownRivalIdentifier(
  value: unknown,
  knownRivalIDs: ReadonlySet<string>,
  field: string,
): string {
  const playerID = boundedIdentifier(
    value,
    field,
    MAX_COMMANDER_PLAYER_ID_LENGTH,
  );
  if (!knownRivalIDs.has(playerID)) {
    throw new Error(`${field} must reference a visible rival`);
  }
  return playerID;
}

function boundedIdentifier(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    Buffer.byteLength(value, "utf8") > maxLength ||
    sanitizeUntrustedDisplayString(value, maxLength) !== value
  ) {
    throw new Error(`${field} must be a bounded stable identifier`);
  }
  return value;
}

function boundedGold(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_GOLD_DIGITS ||
    !/^\d+$/.test(value)
  ) {
    throw new Error(`${field} must be a bounded decimal string`);
  }
  return value;
}

function boundedStructureCount(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  return Math.min(
    MAX_STRUCTURE_COUNT,
    nonNegativeInteger(value, "ownState.unitCounts"),
  );
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be boolean`);
  }
  return value;
}

function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${field} has an unsupported value`);
  }
  return value as T;
}

function finiteNumber(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be finite`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function optionalUnitInterval(
  value: number | undefined,
  field: string,
): number | null {
  if (value === undefined) {
    return null;
  }
  const normalized = finiteNumber(value, field);
  if (normalized < 0 || normalized > 1) {
    throw new Error(`${field} must be between zero and one`);
  }
  return normalized;
}

function nonNegativeFinite(value: number, field: string): number {
  const normalized = finiteNumber(value, field);
  if (normalized < 0) {
    throw new Error(`${field} must be non-negative`);
  }
  return normalized;
}

function optionalNonNegativeFinite(
  value: number | undefined,
  field: string,
): number | null {
  return value === undefined ? null : nonNegativeFinite(value, field);
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function assertNonNegativeInteger(value: number, field: string): void {
  nonNegativeInteger(value, field);
}

function shortFingerprint(domain: string, value: CommanderJsonValue): string {
  return createHash("sha256")
    .update(`${domain}\0${canonicalCommanderJson(value)}`)
    .digest("hex")
    .slice(0, 16);
}

export type CommanderJsonPrimitive = string | number | boolean | null;
export type CommanderJsonValue =
  | CommanderJsonPrimitive
  | CommanderJsonValue[]
  | { [key: string]: CommanderJsonValue };

function canonicalize(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): string {
  budget.nodes += 1;
  if (budget.nodes > 10_000 || depth > 32) {
    throw new Error("Commander canonical JSON exceeds its complexity bound");
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    if (
      typeof value === "string" &&
      value.length > MAX_COMMANDER_CANONICAL_STRING_LENGTH
    ) {
      throw new Error("Commander canonical JSON contains an unbounded string");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Commander canonical JSON contains a non-finite number");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => canonicalize(entry, depth + 1, budget))
      .join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new Error("Commander canonical JSON contains an unsupported value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Commander canonical JSON requires plain objects");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(stableStringCompare)
    .map((key) => {
      if (key.length > MAX_COMMANDER_CANONICAL_STRING_LENGTH) {
        throw new Error("Commander canonical JSON contains an unbounded key");
      }
      return `${JSON.stringify(key)}:${canonicalize(
        record[key]!,
        depth + 1,
        budget,
      )}`;
    })
    .join(",")}}`;
}

function stableStringCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
