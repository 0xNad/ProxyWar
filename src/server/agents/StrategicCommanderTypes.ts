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
