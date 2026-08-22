import type { AgentGamePhase, AgentStrategyProfile } from "./AgentTypes";

export const strategicOptionFamilies = [
  "expand",
  "develop_economy",
  "pressure_rival",
  "survive",
] as const;

export type StrategicOptionFamily = (typeof strategicOptionFamilies)[number];

/** Stable across decisions; low-level LegalAction ids deliberately are not. */
export type StrategicOptionId =
  | Exclude<StrategicOptionFamily, "pressure_rival">
  | `pressure_rival:${string}`;

export interface ExpandStrategicOptionEvidence {
  neutralLandReachable: boolean;
  neutralBoatReachable: boolean;
  ownTroops: number;
  ownTiles: number;
}

export interface DevelopEconomyStrategicOptionEvidence {
  economicBuildAvailable: boolean;
  economicUpgradeAvailable: boolean;
  gold: string;
  ownTiles: number;
}

export interface PressureRivalStrategicOptionEvidence {
  sharesBorder: boolean;
  targetTroops: number;
  targetTiles: number;
  ownTroops: number;
  targetIsAllied: boolean;
  targetAttackedMeRecently: boolean;
}

export interface SurviveStrategicOptionEvidence {
  incomingAttackCount: number;
  strongerBorderRivalCount: number;
  ownTroops: number;
  borderTiles: number;
}

/** Facts only. These objects intentionally have no score or recommendation fields. */
export type StrategicOptionEvidence =
  | ExpandStrategicOptionEvidence
  | DevelopEconomyStrategicOptionEvidence
  | PressureRivalStrategicOptionEvidence
  | SurviveStrategicOptionEvidence;

/**
 * Internal executable proof. This type must never be serialized for a Commander.
 * Bindings are rebuilt from the current offered menu on every construction.
 */
export interface StrategicOptionCandidate {
  id: StrategicOptionId;
  family: StrategicOptionFamily;
  targetPlayerID: string | null;
  targetName: string | null;
  binding: {
    alignedPrimaryActionIDs: string[];
    alignedSupportActionIDs: string[];
  };
  evidence: StrategicOptionEvidence;
}

/** Commander-visible projection. No LegalAction ids, scores, ranks, or risks. */
export interface ExposedStrategicOption {
  id: StrategicOptionId;
  family: StrategicOptionFamily;
  targetPlayerID: string | null;
  targetName: string | null;
  evidence: StrategicOptionEvidence;
}

export type StrategicOptionOmissionReason =
  | "family_cap"
  | "pressure_target_cap"
  | "exposure_cap";

export interface StrategicOptionOmission {
  id: StrategicOptionId;
  reason: StrategicOptionOmissionReason;
}

/**
 * Stage 1 accounting only. The state-bound request fingerprint described by the
 * plan also needs decisionSequence and Commander state, so it belongs to Stage 2.
 */
export interface StrategicOptionSetRecord {
  eligibleOptionIds: StrategicOptionId[];
  exposedOptionIds: StrategicOptionId[];
  omitted: StrategicOptionOmission[];
}

export interface BuiltStrategicOptions {
  candidates: StrategicOptionCandidate[];
  exposed: ExposedStrategicOption[];
  record: StrategicOptionSetRecord;
}

export const commanderReplanTriggers = [
  "horizon_expiry",
  "option_not_executable",
  "target_dead",
  "home_attacked",
  "option_appeared",
] as const;

export type CommanderReplanTrigger = (typeof commanderReplanTriggers)[number];

export const MIN_COMMANDER_HORIZON_DECISIONS = 2;
export const MAX_COMMANDER_HORIZON_DECISIONS = 6;
export const DEFAULT_COMMANDER_HORIZON_DECISIONS = 3;
export const MAX_COMMANDER_INTENT_LENGTH = 160;

export interface CommanderSelfState {
  name: string;
  profile: AgentStrategyProfile;
  phase: AgentGamePhase;
  turnNumber: number;
  troops: number;
  maxTroops: number | null;
  gold: string;
  tilesOwned: number;
  tileShare: number | null;
  borderTiles: number;
  incomingAttacks: number;
  outgoingAttacks: number;
  alivePlayerCount: number;
}

export interface CommanderRivalState {
  playerID: string;
  name: string;
  isAlive: boolean;
  troops: number;
  tilesOwned: number;
  tileShare: number | null;
  sharesBorder: boolean;
  isAllied: boolean;
  attackedMeRecently: boolean;
  iAmAttackingThem: boolean;
}

export interface CommanderPlanProgressSnapshot {
  decisionsExecuted: number;
  tilesDelta: number;
  troopsDelta: number;
  newIncomingAttackerIDs: string[];
}

/**
 * Stage 2 only defines this bounded snapshot shape. Stage 3 owns persistence,
 * progress calculation, and every plan transition.
 */
export interface CommanderPlanSnapshot {
  selectedStrategicOptionId: StrategicOptionId;
  family: StrategicOptionFamily;
  targetPlayerID: string | null;
  horizonDecisions: number;
  replanTriggers: CommanderReplanTrigger[];
  progress: CommanderPlanProgressSnapshot;
}

/**
 * Typed factual inputs for the fixed recent-event templates. Stage 3 may
 * derive these events; Stage 2 only bounds and renders them.
 */
export type CommanderRecentEvent =
  | {
      kind: "territory_changed";
      fromTiles: number;
      toTiles: number;
    }
  | {
      kind: "troops_changed";
      fromTroops: number;
      toTroops: number;
    }
  | {
      kind: "incoming_attacker";
      playerID: string;
    }
  | {
      kind: "rival_eliminated";
      playerID: string;
    }
  | {
      kind: "tiles_lost";
      fromTiles: number;
      toTiles: number;
    };

/** The complete and only object serialized into a Commander prompt. */
export interface CommanderState {
  self: CommanderSelfState;
  rivals: CommanderRivalState[];
  plan: CommanderPlanSnapshot | null;
  recentEvents: string[];
  options: ExposedStrategicOption[];
}

export interface CommanderFingerprints {
  exposedOptionSet: string;
  materialState: string;
}

export interface BuiltCommanderState {
  state: CommanderState;
  fingerprints: CommanderFingerprints;
}

export interface CommanderResponse {
  selectedStrategicOptionId: StrategicOptionId;
  horizonDecisions: number;
  intent: string;
  replanTriggers: CommanderReplanTrigger[];
  confidence?: number;
}

export type CommanderResponseParseResult =
  | ({ ok: true; raw: string } & CommanderResponse)
  | { ok: false; reason: string; raw: string };
