import { commissionerTopScoreSlots } from "./CoworldScoreSemantics";

export type CoworldTelemetryPrimitive = string | number | boolean | null;

export type CoworldCouncilEvaluationArmKind =
  | "v16"
  | "a1"
  | "v16-shadow"
  | "a1-shadow"
  | "v16-politics-guard"
  | "v16-diplomacy-adjudicator"
  | "v16-survival-shield";

export interface CoworldCouncilEvaluationArm {
  armID: string;
  kind: CoworldCouncilEvaluationArmKind;
  base: "v16" | "a1";
  shadow: boolean;
  expertMask: number;
  env: Record<string, string>;
}

export interface CoworldCouncilEvaluationAssignment {
  matrixID: string;
  blockID: string;
  pairID: string;
  jobID: string;
  arm: CoworldCouncilEvaluationArm;
  intentionToTreat: boolean;
  /** True only for a locked arm that can replace the v16 delegate at runtime. */
  actualTreatmentExposure: boolean;
  expertMask: number;
  variantID: string;
  seed: number;
  map: string;
  candidateSeat: number;
  rosterOrderID: string;
  candidateImageID: string;
  gameImageID: string;
  opponentImageIDs: string[];
}

export interface CoworldCouncilEvaluationPlanBlockEvidence {
  matrixID: string;
  blockID: string;
  pairID: string;
  jobIDs: string[];
}

export interface CoworldCouncilEvaluationPlanJobEvidence {
  assignment: CoworldCouncilEvaluationAssignment;
  status: "missing" | "invalid" | "joined";
  invalidReason: string | null;
  episodeId: string | null;
}

export interface CoworldCouncilEvaluationPlanEvidence {
  planPaths: string[];
  blocks: CoworldCouncilEvaluationPlanBlockEvidence[];
  jobs: CoworldCouncilEvaluationPlanJobEvidence[];
}

export type CoworldShadowCouncilHealth =
  | "healthy"
  | "partial"
  | "failed"
  | "unavailable";

export type CoworldShadowCouncilAgreement =
  | "agree"
  | "disagree"
  | "abstain"
  | "unavailable";

export type CoworldShadowCouncilSource =
  | "-"
  | "expansion"
  | "economy"
  | "conquest"
  | "politics"
  | "spawn"
  | "survival"
  | "binding_directive"
  | "fallback";

export type CoworldShadowCouncilTier =
  | "-"
  | "spawn"
  | "survival"
  | "binding_directive"
  | "expert_auction"
  | "hold";

/** Expanded, validated form of decision_response.shadowCouncil compact v1. */
export interface CoworldShadowCouncilDecisionTelemetry {
  version: 1;
  ordinal: number;
  resetOrdinal: number;
  reset: boolean;
  health: CoworldShadowCouncilHealth;
  proposalMask: number;
  errorMask: number;
  rejectionMask: number;
  diagnosticWinnerFingerprint: string;
  runnerUpFingerprint: string;
  authoritativeFingerprint: string;
  bidMarginBP: number | null;
  agreement: CoworldShadowCouncilAgreement;
  diagnosticWinnerSource: CoworldShadowCouncilSource;
  diagnosticWinnerTier: CoworldShadowCouncilTier;
  enabledExpertMask: number;
  elapsedUs: number;
}

export interface CoworldEvaluationRosterSeat {
  seat: number;
  policyVersionId: string | null;
  playerName: string | null;
  label: string | null;
  agentID: string | null;
}

export interface CoworldEvaluationDecision {
  seat: number | null;
  playerName: string | null;
  agentID: string | null;
  turnNumber: number | null;
  selectedLegalActionId: string | null;
  actionKind: string;
  attackTargetType: "neutral" | "hostile" | "unknown" | null;
  reason: string;
  selectedActionMetadata: Record<string, string | number | boolean | null>;
  fallback: boolean | null;
  degraded: boolean | null;
  parseFailure: boolean | null;
  wireDroppedFollowupCount: number | null;
  multiAction: boolean | null;
  commanderTelemetry: Record<string, CoworldTelemetryPrimitive>;
  /** Null/undefined means the decision artifact did not expose a response. */
  decisionResponseAvailable?: boolean | null;
  /** Null/undefined means no valid compact telemetry was present. */
  shadowCouncil?: CoworldShadowCouncilDecisionTelemetry | null;
  explicitTreatmentMarkers: string[];
  searchableText: string;
}

export interface CoworldEvaluationSnapshotPlayer {
  seat: number | null;
  playerName: string | null;
  agentID: string | null;
  tilesOwned: number | null;
  troops: number | null;
  gold: string | null;
  isAlive: boolean | null;
  hasSpawned: boolean | null;
}

export interface CoworldEvaluationSnapshot {
  label: string;
  turnNumber: number | null;
  tick: number | null;
  phase: string;
  players: CoworldEvaluationSnapshotPlayer[];
}

export interface CoworldReportedTelemetry {
  decisionCount: number | null;
  fallbackCount: number | null;
  degradedCount: number | null;
  parseFailureCount: number | null;
}

export interface CoworldEpisodeReportedTelemetry {
  result: CoworldReportedTelemetry;
  summary: CoworldReportedTelemetry;
}

export interface CoworldEvaluationEpisode {
  episodeId: string;
  sourcePaths: string[];
  runID: string | null;
  platformCompletedAt: string | null;
  runtimeCompletedAt: string | null;
  map: string;
  mapSize: string | null;
  scores: number[];
  outrightWinnerSlot: number | null;
  roster: CoworldEvaluationRosterSeat[];
  decisions: CoworldEvaluationDecision[];
  snapshots: CoworldEvaluationSnapshot[];
  episodeReportedTelemetry: CoworldEpisodeReportedTelemetry;
  councilEvaluation?: CoworldCouncilEvaluationAssignment | null;
}

export interface CoworldDatasetSelector {
  seat: number | null;
  policyVersionId: string | null;
  playerName: string | null;
}

export interface CoworldTreatmentMarker {
  id: string;
  needle: string;
}

export interface CoworldEvaluationPhaseSnapshotRow {
  label: string;
  turnNumber: number | null;
  tick: number | null;
  phase: string;
  tilesOwned: number | null;
  troops: number | null;
  gold: string | null;
  isAlive: boolean | null;
  hasSpawned: boolean | null;
}

export interface CoworldSeatTelemetry {
  available: boolean;
  decisionCount: number | null;
  actionMix: Record<string, number>;
  attackTargetMix: Record<string, number>;
  fallbackSampleCount: number;
  fallbackCount: number | null;
  fallbackOrDegradedSampleCount: number;
  fallbackOrDegradedCount: number | null;
  degradedSampleCount: number;
  degradedCount: number | null;
  parseFailureSampleCount: number;
  parseFailureCount: number | null;
  wireDroppedFollowupSampleCount: number;
  wireDroppedFollowupCount: number | null;
  multiActionSampleCount: number;
  multiActionDecisionCount: number | null;
  commanderTelemetry: CoworldCommanderTelemetryAggregate;
  shadowCouncil: CoworldShadowCouncilTelemetryAggregate;
  fallbackRate: number | null;
  fallbackOrDegradedRate: number | null;
  degradationRate: number | null;
  parseFailureRate: number | null;
  treatmentExposed: boolean;
  treatmentMarkerCounts: Record<string, number>;
  episodeReported: CoworldEpisodeReportedTelemetry;
}

export interface CoworldShadowCouncilTelemetryAggregate {
  available: boolean;
  decisionResponseSampleCount: number;
  validTelemetryDecisionCount: number;
  diagnosticWinnerDecisionCount: number;
  counterfactualAgreementDecisionCount: number;
  proposalMaskUnion: number;
  errorMaskUnion: number;
  rejectionMaskUnion: number;
  enabledExpertMaskUnion: number;
  sourceCounts: Record<string, number>;
  tierCounts: Record<string, number>;
  healthCounts: Record<string, number>;
  agreementCounts: Record<string, number>;
}

export interface CoworldPrimitiveTelemetryAggregate {
  samples: number;
  nullCount: number;
  trueCount: number;
  falseCount: number;
  numericSamples: number;
  numericSum: number;
  numericMean: number | null;
  numericMin: number | null;
  numericMax: number | null;
  valueCounts: Record<string, number>;
}

export interface CoworldCommanderTelemetryAggregate {
  available: boolean;
  decisionsWithTelemetry: number;
  fields: Record<string, CoworldPrimitiveTelemetryAggregate>;
}

export interface CoworldEvaluationDatasetRow {
  rowId: string;
  episodeId: string;
  sourcePaths: string[];
  runID: string | null;
  platformCompletedAt: string | null;
  runtimeCompletedAt: string | null;
  map: string;
  mapSize: string | null;
  seat: number;
  policyVersionId: string | null;
  playerName: string | null;
  roster: CoworldEvaluationRosterSeat[];
  opponents: CoworldEvaluationRosterSeat[];
  scores: number[];
  scoreShare: number;
  commissionerTopScoreWin: boolean;
  outrightWin: boolean;
  telemetry: CoworldSeatTelemetry;
  spawnDiagnostics: CoworldSpawnDiagnostics;
  phaseSnapshots: CoworldEvaluationPhaseSnapshotRow[];
  councilEvaluation: CoworldCouncilEvaluationAssignment | null;
}

export interface CoworldCouncilEvaluationTieAudit {
  rowId: string;
  episodeId: string;
  matrixID: string;
  blockID: string;
  pairID: string;
  jobID: string;
  armID: string;
  candidateSeat: number;
  topScoreSlots: number[];
  topScoreMultiplicity: number;
  tiedTopScore: boolean;
  soleTopScoreWin: boolean;
  positiveTopScore: boolean;
  allZeroTie: boolean;
  commissionerTopScoreWin: boolean;
  outrightWin: boolean;
  outcome: "outright" | "sole-top-score" | "shared-top-score" | "not-top-score";
}

export interface CoworldCouncilEvaluationShadowOverheadDelta {
  comparisonKind: "descriptive-shadow-overhead";
  matrixID: string;
  blockID: string;
  pairID: string;
  map: string;
  seed: number;
  candidateSeat: number;
  rosterOrderID: string;
  baseArmID: string;
  treatmentArmID: string;
  expertMask: number;
  baseRowId: string;
  treatmentRowId: string;
  baseTiedTopScore: boolean;
  treatmentTiedTopScore: boolean;
  scoreShareDelta: number;
  commissionerTopScoreWinDelta: number;
  outrightWinDelta: number;
}

export interface CoworldCouncilEvaluationAudit {
  available: boolean;
  planPaths: string[];
  matrixIDs: string[];
  plannedBlockCount: number;
  plannedJobCount: number;
  joinedJobCount: number;
  intentionToTreatJobIDs: string[];
  actualTreatmentExposureJobIDs: string[];
  completeBlockIDs: string[];
  missingJobIDs: string[];
  invalidJobIDs: string[];
  invalidJobs: Array<{ jobID: string; blockID: string; reason: string }>;
  unjoinedJobIDs: string[];
  missingBlockIDs: string[];
  invalidBlockIDs: string[];
  incompleteBlockIDs: string[];
  tieAudits: CoworldCouncilEvaluationTieAudit[];
  pairedShadowOverheadDeltas: CoworldCouncilEvaluationShadowOverheadDelta[];
}

export interface CoworldSpawnSelection {
  turnNumber: number | null;
  selectedLegalActionId: string | null;
  tile: number | null;
  metadata: Record<string, string | number | boolean | null>;
  spawnProgress: number | null;
  settleThresholdReached: boolean | null;
  explicitSettleMarker: boolean;
}

export interface CoworldSpawnDiagnostics {
  available: boolean;
  configuredSpawnPhaseTurns: number | null;
  configuredSettleThreshold: number;
  spawnDecisionCount: number;
  distinctSelectedTiles: number;
  selectionTurns: Array<number | null>;
  selections: CoworldSpawnSelection[];
  lastExecutableSpawn: CoworldSpawnSelection | null;
  lastSpawnProgress: number | null;
  settleThresholdReached: boolean | null;
  lastSpawnHasExplicitSettleMarker: boolean | null;
}

export interface CoworldEvaluationAggregate {
  episodes: number;
  rows: number;
  commissionerTopScoreWins: number;
  commissionerTopScoreWinRate: number | null;
  outrightWins: number;
  outrightWinRate: number | null;
  scoreShareSum: number;
  scoreShareMean: number | null;
  rowsWithDecisionTelemetry: number;
  decisionCount: number;
  fallbackSampleCount: number;
  fallbackCount: number | null;
  fallbackRate: number | null;
  fallbackOrDegradedSampleCount: number;
  fallbackOrDegradedCount: number | null;
  fallbackOrDegradedRate: number | null;
  degradedSampleCount: number;
  degradedCount: number | null;
  degradationRate: number | null;
  parseFailureSampleCount: number;
  parseFailureCount: number | null;
  parseFailureRate: number | null;
  wireDroppedFollowupSampleCount: number;
  wireDroppedFollowupCount: number | null;
  multiActionSampleCount: number;
  multiActionDecisionCount: number | null;
  treatmentExposedRows: number;
  actionMix: Record<string, number>;
  attackTargetMix: Record<string, number>;
  treatmentMarkerCounts: Record<string, number>;
  commanderTelemetry: CoworldCommanderTelemetryAggregate;
  shadowCouncil: CoworldShadowCouncilTelemetryAggregate;
}

export interface CoworldEvaluationDataset {
  schemaVersion: 4;
  selector: CoworldDatasetSelector;
  treatmentMarkers: CoworldTreatmentMarker[];
  spawnDiagnosticsConfig: {
    spawnPhaseTurns: number | null;
    settleThreshold: number;
  };
  sourceCount: number;
  ingestion: {
    skippedNonCompletedEntries: number;
    skippedByStatus: Record<string, number>;
  };
  warnings: string[];
  councilEvaluation: CoworldCouncilEvaluationAudit;
  rows: CoworldEvaluationDatasetRow[];
  aggregate: CoworldEvaluationAggregate;
  byMap: Record<string, CoworldEvaluationAggregate>;
  bySeat: Record<string, CoworldEvaluationAggregate>;
  byPolicyVersion: Record<string, CoworldEvaluationAggregate>;
}

function rate(count: number, total: number): number | null {
  return total === 0 ? null : count / total;
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeCounts(
  target: Record<string, number>,
  source: Readonly<Record<string, number>>,
): void {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function sortedCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function emptyPrimitiveTelemetry(): CoworldPrimitiveTelemetryAggregate {
  return {
    samples: 0,
    nullCount: 0,
    trueCount: 0,
    falseCount: 0,
    numericSamples: 0,
    numericSum: 0,
    numericMean: null,
    numericMin: null,
    numericMax: null,
    valueCounts: {},
  };
}

function primitiveValueKey(value: CoworldTelemetryPrimitive): string {
  return value === null ? "null" : `${typeof value}:${String(value)}`;
}

function commanderTelemetryAggregate(
  decisions: readonly CoworldEvaluationDecision[],
): CoworldCommanderTelemetryAggregate {
  const fields: Record<string, CoworldPrimitiveTelemetryAggregate> = {};
  let decisionsWithTelemetry = 0;
  for (const decision of decisions) {
    const entries = Object.entries(decision.commanderTelemetry);
    if (entries.length === 0) {
      continue;
    }
    decisionsWithTelemetry += 1;
    for (const [key, value] of entries) {
      const field = fields[key] ?? emptyPrimitiveTelemetry();
      field.samples += 1;
      increment(field.valueCounts, primitiveValueKey(value));
      if (value === null) {
        field.nullCount += 1;
      } else if (value === true) {
        field.trueCount += 1;
      } else if (value === false) {
        field.falseCount += 1;
      } else if (typeof value === "number") {
        field.numericSamples += 1;
        field.numericSum += value;
        field.numericMin =
          field.numericMin === null ? value : Math.min(field.numericMin, value);
        field.numericMax =
          field.numericMax === null ? value : Math.max(field.numericMax, value);
        field.numericMean = field.numericSum / field.numericSamples;
      }
      fields[key] = field;
    }
  }
  return {
    available: decisionsWithTelemetry > 0,
    decisionsWithTelemetry,
    fields: Object.fromEntries(
      Object.entries(fields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, field]) => [
          key,
          { ...field, valueCounts: sortedCounts(field.valueCounts) },
        ]),
    ),
  };
}

function mergeCommanderTelemetry(
  aggregates: readonly CoworldCommanderTelemetryAggregate[],
): CoworldCommanderTelemetryAggregate {
  const fields: Record<string, CoworldPrimitiveTelemetryAggregate> = {};
  for (const aggregate of aggregates) {
    for (const [key, incoming] of Object.entries(aggregate.fields)) {
      const field = fields[key] ?? emptyPrimitiveTelemetry();
      field.samples += incoming.samples;
      field.nullCount += incoming.nullCount;
      field.trueCount += incoming.trueCount;
      field.falseCount += incoming.falseCount;
      field.numericSamples += incoming.numericSamples;
      field.numericSum += incoming.numericSum;
      field.numericMin =
        field.numericMin === null
          ? incoming.numericMin
          : incoming.numericMin === null
            ? field.numericMin
            : Math.min(field.numericMin, incoming.numericMin);
      field.numericMax =
        field.numericMax === null
          ? incoming.numericMax
          : incoming.numericMax === null
            ? field.numericMax
            : Math.max(field.numericMax, incoming.numericMax);
      field.numericMean =
        field.numericSamples === 0
          ? null
          : field.numericSum / field.numericSamples;
      mergeCounts(field.valueCounts, incoming.valueCounts);
      fields[key] = field;
    }
  }
  const decisionsWithTelemetry = aggregates.reduce(
    (sum, aggregate) => sum + aggregate.decisionsWithTelemetry,
    0,
  );
  return {
    available: decisionsWithTelemetry > 0,
    decisionsWithTelemetry,
    fields: Object.fromEntries(
      Object.entries(fields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, field]) => [
          key,
          { ...field, valueCounts: sortedCounts(field.valueCounts) },
        ]),
    ),
  };
}

const shadowDiagnosticWinnerSources = new Set<CoworldShadowCouncilSource>([
  "expansion",
  "economy",
  "conquest",
  "politics",
  "spawn",
  "survival",
  "binding_directive",
  "fallback",
]);

function shadowCouncilTelemetryAggregate(
  decisions: readonly CoworldEvaluationDecision[],
): CoworldShadowCouncilTelemetryAggregate {
  const telemetry = decisions.flatMap((decision) =>
    decision.shadowCouncil === null || decision.shadowCouncil === undefined
      ? []
      : [decision.shadowCouncil],
  );
  const decisionResponseSampleCount = decisions.filter(
    (decision) => decision.decisionResponseAvailable === true,
  ).length;
  const sourceCounts: Record<string, number> = {};
  const tierCounts: Record<string, number> = {};
  const healthCounts: Record<string, number> = {};
  const agreementCounts: Record<string, number> = {};
  let proposalMaskUnion = 0;
  let errorMaskUnion = 0;
  let rejectionMaskUnion = 0;
  let enabledExpertMaskUnion = 0;
  let diagnosticWinnerDecisionCount = 0;
  let counterfactualAgreementDecisionCount = 0;

  for (const entry of telemetry) {
    proposalMaskUnion |= entry.proposalMask;
    errorMaskUnion |= entry.errorMask;
    rejectionMaskUnion |= entry.rejectionMask;
    enabledExpertMaskUnion |= entry.enabledExpertMask;
    increment(sourceCounts, entry.diagnosticWinnerSource);
    increment(tierCounts, entry.diagnosticWinnerTier);
    increment(healthCounts, entry.health);
    increment(agreementCounts, entry.agreement);
    if (shadowDiagnosticWinnerSources.has(entry.diagnosticWinnerSource)) {
      diagnosticWinnerDecisionCount += 1;
      if (entry.agreement === "agree") {
        counterfactualAgreementDecisionCount += 1;
      }
    }
  }

  return {
    available: telemetry.length > 0,
    decisionResponseSampleCount,
    validTelemetryDecisionCount: telemetry.length,
    diagnosticWinnerDecisionCount,
    counterfactualAgreementDecisionCount,
    proposalMaskUnion,
    errorMaskUnion,
    rejectionMaskUnion,
    enabledExpertMaskUnion,
    sourceCounts: sortedCounts(sourceCounts),
    tierCounts: sortedCounts(tierCounts),
    healthCounts: sortedCounts(healthCounts),
    agreementCounts: sortedCounts(agreementCounts),
  };
}

function mergeShadowCouncilTelemetry(
  aggregates: readonly CoworldShadowCouncilTelemetryAggregate[],
): CoworldShadowCouncilTelemetryAggregate {
  const sourceCounts: Record<string, number> = {};
  const tierCounts: Record<string, number> = {};
  const healthCounts: Record<string, number> = {};
  const agreementCounts: Record<string, number> = {};
  let decisionResponseSampleCount = 0;
  let validTelemetryDecisionCount = 0;
  let diagnosticWinnerDecisionCount = 0;
  let counterfactualAgreementDecisionCount = 0;
  let proposalMaskUnion = 0;
  let errorMaskUnion = 0;
  let rejectionMaskUnion = 0;
  let enabledExpertMaskUnion = 0;
  for (const aggregate of aggregates) {
    decisionResponseSampleCount += aggregate.decisionResponseSampleCount;
    validTelemetryDecisionCount += aggregate.validTelemetryDecisionCount;
    diagnosticWinnerDecisionCount += aggregate.diagnosticWinnerDecisionCount;
    counterfactualAgreementDecisionCount +=
      aggregate.counterfactualAgreementDecisionCount;
    proposalMaskUnion |= aggregate.proposalMaskUnion;
    errorMaskUnion |= aggregate.errorMaskUnion;
    rejectionMaskUnion |= aggregate.rejectionMaskUnion;
    enabledExpertMaskUnion |= aggregate.enabledExpertMaskUnion;
    mergeCounts(sourceCounts, aggregate.sourceCounts);
    mergeCounts(tierCounts, aggregate.tierCounts);
    mergeCounts(healthCounts, aggregate.healthCounts);
    mergeCounts(agreementCounts, aggregate.agreementCounts);
  }
  return {
    available: validTelemetryDecisionCount > 0,
    decisionResponseSampleCount,
    validTelemetryDecisionCount,
    diagnosticWinnerDecisionCount,
    counterfactualAgreementDecisionCount,
    proposalMaskUnion,
    errorMaskUnion,
    rejectionMaskUnion,
    enabledExpertMaskUnion,
    sourceCounts: sortedCounts(sourceCounts),
    tierCounts: sortedCounts(tierCounts),
    healthCounts: sortedCounts(healthCounts),
    agreementCounts: sortedCounts(agreementCounts),
  };
}

function decisionsForSeat(
  episode: CoworldEvaluationEpisode,
  seat: number,
): CoworldEvaluationDecision[] {
  return episode.decisions.filter((decision) => {
    if (decision.seat !== null) {
      return decision.seat === seat;
    }
    if (decision.agentID !== null) {
      const agentMatches = episode.roster.filter(
        (entry) => entry.agentID === decision.agentID,
      );
      return agentMatches.length === 1 && agentMatches[0].seat === seat;
    }
    if (decision.playerName === null) {
      return false;
    }
    const nameMatches = episode.roster.filter(
      (entry) => entry.playerName === decision.playerName,
    );
    return nameMatches.length === 1 && nameMatches[0].seat === seat;
  });
}

function markerCounts(
  decisions: readonly CoworldEvaluationDecision[],
  markers: readonly CoworldTreatmentMarker[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const marker of markers) {
    counts[marker.id] = decisions.filter(
      (decision) =>
        decision.explicitTreatmentMarkers.includes(marker.id) ||
        decision.searchableText.includes(marker.needle),
    ).length;
  }
  for (const decision of decisions) {
    for (const marker of decision.explicitTreatmentMarkers) {
      if (markers.some((configured) => configured.id === marker)) {
        continue;
      }
      increment(counts, marker);
    }
  }
  return sortedCounts(counts);
}

function seatTelemetry(
  episode: CoworldEvaluationEpisode,
  seat: number,
  markers: readonly CoworldTreatmentMarker[],
): CoworldSeatTelemetry {
  const decisions = decisionsForSeat(episode, seat);
  const available = decisions.length > 0;
  const actionMix: Record<string, number> = {};
  const attackTargetMix: Record<string, number> = {};
  for (const decision of decisions) {
    increment(actionMix, decision.actionKind);
    if (decision.attackTargetType !== null) {
      increment(attackTargetMix, decision.attackTargetType);
    }
  }
  const fallbackSamples = decisions.filter(
    (decision) => decision.fallback !== null,
  );
  const degradedSamples = decisions.filter(
    (decision) => decision.degraded !== null,
  );
  const fallbackOrDegradedSignals = decisions.map((decision) =>
    decision.fallback === true || decision.degraded === true
      ? true
      : decision.fallback === false && decision.degraded === false
        ? false
        : null,
  );
  const fallbackOrDegradedSamples = fallbackOrDegradedSignals.filter(
    (value): value is boolean => value !== null,
  );
  const parseFailureSamples = decisions.filter(
    (decision) => decision.parseFailure !== null,
  );
  const wireDroppedFollowupSamples = decisions.filter(
    (decision) => decision.wireDroppedFollowupCount !== null,
  );
  const multiActionSamples = decisions.filter(
    (decision) => decision.multiAction !== null,
  );
  const fallbackCount = fallbackSamples.filter(
    (decision) => decision.fallback === true,
  ).length;
  const degradedCount = degradedSamples.filter(
    (decision) => decision.degraded === true,
  ).length;
  const fallbackOrDegradedCount =
    fallbackOrDegradedSamples.filter(Boolean).length;
  const parseFailureCount = parseFailureSamples.filter(
    (decision) => decision.parseFailure === true,
  ).length;
  const wireDroppedFollowupCount = wireDroppedFollowupSamples.reduce(
    (sum, decision) => sum + (decision.wireDroppedFollowupCount ?? 0),
    0,
  );
  const multiActionDecisionCount = multiActionSamples.filter(
    (decision) => decision.multiAction === true,
  ).length;
  const treatmentMarkerCounts = markerCounts(decisions, markers);
  return {
    available,
    decisionCount: available ? decisions.length : null,
    actionMix: sortedCounts(actionMix),
    attackTargetMix: sortedCounts(attackTargetMix),
    fallbackSampleCount: fallbackSamples.length,
    fallbackCount: fallbackSamples.length > 0 ? fallbackCount : null,
    fallbackOrDegradedSampleCount: fallbackOrDegradedSamples.length,
    fallbackOrDegradedCount:
      fallbackOrDegradedSamples.length > 0 ? fallbackOrDegradedCount : null,
    degradedSampleCount: degradedSamples.length,
    degradedCount: degradedSamples.length > 0 ? degradedCount : null,
    parseFailureSampleCount: parseFailureSamples.length,
    parseFailureCount:
      parseFailureSamples.length > 0 ? parseFailureCount : null,
    wireDroppedFollowupSampleCount: wireDroppedFollowupSamples.length,
    wireDroppedFollowupCount:
      wireDroppedFollowupSamples.length > 0 ? wireDroppedFollowupCount : null,
    multiActionSampleCount: multiActionSamples.length,
    multiActionDecisionCount:
      multiActionSamples.length > 0 ? multiActionDecisionCount : null,
    commanderTelemetry: commanderTelemetryAggregate(decisions),
    shadowCouncil: shadowCouncilTelemetryAggregate(decisions),
    fallbackRate: rate(fallbackCount, fallbackSamples.length),
    fallbackOrDegradedRate: rate(
      fallbackOrDegradedCount,
      fallbackOrDegradedSamples.length,
    ),
    degradationRate: rate(degradedCount, degradedSamples.length),
    parseFailureRate: rate(parseFailureCount, parseFailureSamples.length),
    treatmentExposed: Object.values(treatmentMarkerCounts).some(
      (count) => count > 0,
    ),
    treatmentMarkerCounts,
    episodeReported: episode.episodeReportedTelemetry,
  };
}

function explicitSpawnSettleMarker(
  decision: CoworldEvaluationDecision,
): boolean {
  const metadata = decision.selectedActionMetadata;
  if (
    metadata.settled === true ||
    metadata.isAnchor === true ||
    metadata.converged === true
  ) {
    return true;
  }
  const mode = metadata.spawnMode ?? metadata.spawn_mode;
  return typeof mode === "string" && /^(anchor|converged|settled)$/i.test(mode);
}

function spawnDiagnostics(
  episode: CoworldEvaluationEpisode,
  seat: number,
  spawnPhaseTurns: number | null,
  settleThreshold: number,
): CoworldSpawnDiagnostics {
  const selections = decisionsForSeat(episode, seat)
    .filter((decision) => decision.actionKind === "spawn")
    .map((decision) => {
      const tile = decision.selectedActionMetadata.tile;
      const spawnProgress =
        spawnPhaseTurns === null || decision.turnNumber === null
          ? null
          : decision.turnNumber / spawnPhaseTurns;
      return {
        turnNumber: decision.turnNumber,
        selectedLegalActionId: decision.selectedLegalActionId,
        tile: typeof tile === "number" && Number.isFinite(tile) ? tile : null,
        metadata: decision.selectedActionMetadata,
        spawnProgress,
        settleThresholdReached:
          spawnProgress === null ? null : spawnProgress >= settleThreshold,
        explicitSettleMarker: explicitSpawnSettleMarker(decision),
      } satisfies CoworldSpawnSelection;
    })
    .sort(
      (left, right) =>
        (left.turnNumber ?? Number.MAX_SAFE_INTEGER) -
        (right.turnNumber ?? Number.MAX_SAFE_INTEGER),
    );
  const lastExecutableSpawn = selections[selections.length - 1] ?? null;
  return {
    available: selections.length > 0,
    configuredSpawnPhaseTurns: spawnPhaseTurns,
    configuredSettleThreshold: settleThreshold,
    spawnDecisionCount: selections.length,
    distinctSelectedTiles: new Set(
      selections.flatMap((selection) =>
        selection.tile === null ? [] : [selection.tile],
      ),
    ).size,
    selectionTurns: selections.map((selection) => selection.turnNumber),
    selections,
    lastExecutableSpawn,
    lastSpawnProgress: lastExecutableSpawn?.spawnProgress ?? null,
    settleThresholdReached: lastExecutableSpawn?.settleThresholdReached ?? null,
    lastSpawnHasExplicitSettleMarker:
      lastExecutableSpawn?.explicitSettleMarker ?? null,
  };
}

function playerMatchesSeat(
  player: CoworldEvaluationSnapshotPlayer,
  roster: readonly CoworldEvaluationRosterSeat[],
  seat: number,
): boolean {
  if (player.seat !== null) {
    return player.seat === seat;
  }
  if (player.agentID !== null) {
    const agentMatches = roster.filter(
      (entry) => entry.agentID === player.agentID,
    );
    return agentMatches.length === 1 && agentMatches[0].seat === seat;
  }
  if (player.playerName === null) {
    return false;
  }
  const nameMatches = roster.filter(
    (entry) => entry.playerName === player.playerName,
  );
  return nameMatches.length === 1 && nameMatches[0].seat === seat;
}

function phaseSnapshotsForSeat(
  episode: CoworldEvaluationEpisode,
  seat: number,
): CoworldEvaluationPhaseSnapshotRow[] {
  const snapshots = episode.snapshots.flatMap((snapshot) => {
    const player = snapshot.players.find((entry) =>
      playerMatchesSeat(entry, episode.roster, seat),
    );
    return player === undefined
      ? []
      : [
          {
            label: snapshot.label,
            turnNumber: snapshot.turnNumber,
            tick: snapshot.tick,
            phase: snapshot.phase,
            tilesOwned: player.tilesOwned,
            troops: player.troops,
            gold: player.gold,
            isAlive: player.isAlive,
            hasSpawned: player.hasSpawned,
          },
        ];
  });
  const byPhase = new Map<string, CoworldEvaluationPhaseSnapshotRow[]>();
  for (const snapshot of snapshots) {
    const group = byPhase.get(snapshot.phase) ?? [];
    group.push(snapshot);
    byPhase.set(snapshot.phase, group);
  }
  const boundaries = [...byPhase.values()].flatMap((group) => {
    if (group.length <= 1) {
      return group;
    }
    return [group[0], group[group.length - 1]];
  });
  const unique = new Map<string, CoworldEvaluationPhaseSnapshotRow>();
  for (const snapshot of boundaries) {
    unique.set(
      `${snapshot.phase}:${snapshot.turnNumber ?? "unknown"}:${snapshot.tick ?? "unknown"}`,
      snapshot,
    );
  }
  return [...unique.values()].sort(
    (left, right) =>
      (left.turnNumber ?? Number.MAX_SAFE_INTEGER) -
        (right.turnNumber ?? Number.MAX_SAFE_INTEGER) ||
      left.phase.localeCompare(right.phase),
  );
}

function selectedSeats(
  episode: CoworldEvaluationEpisode,
  selector: CoworldDatasetSelector,
): number[] {
  if (selector.seat !== null) {
    return episode.scores[selector.seat] === undefined ? [] : [selector.seat];
  }
  if (selector.policyVersionId !== null) {
    return episode.roster
      .filter((entry) => entry.policyVersionId === selector.policyVersionId)
      .map((entry) => entry.seat)
      .filter((seat) => episode.scores[seat] !== undefined);
  }
  if (selector.playerName !== null) {
    return episode.roster
      .filter((entry) => entry.playerName === selector.playerName)
      .map((entry) => entry.seat)
      .filter((seat) => episode.scores[seat] !== undefined);
  }
  return episode.scores.map((_, seat) => seat);
}

function aggregate(
  rows: readonly CoworldEvaluationDatasetRow[],
): CoworldEvaluationAggregate {
  const actionMix: Record<string, number> = {};
  const attackTargetMix: Record<string, number> = {};
  const treatmentMarkerCounts: Record<string, number> = {};
  let decisionCount = 0;
  let fallbackSampleCount = 0;
  let fallbackCount = 0;
  let fallbackOrDegradedSampleCount = 0;
  let fallbackOrDegradedCount = 0;
  let degradedSampleCount = 0;
  let degradedCount = 0;
  let parseFailureSampleCount = 0;
  let parseFailureCount = 0;
  let wireDroppedFollowupSampleCount = 0;
  let wireDroppedFollowupCount = 0;
  let multiActionSampleCount = 0;
  let multiActionDecisionCount = 0;
  for (const row of rows) {
    if (row.telemetry.available) {
      decisionCount += row.telemetry.decisionCount ?? 0;
      fallbackSampleCount += row.telemetry.fallbackSampleCount;
      fallbackCount += row.telemetry.fallbackCount ?? 0;
      fallbackOrDegradedSampleCount +=
        row.telemetry.fallbackOrDegradedSampleCount;
      fallbackOrDegradedCount += row.telemetry.fallbackOrDegradedCount ?? 0;
      degradedSampleCount += row.telemetry.degradedSampleCount;
      degradedCount += row.telemetry.degradedCount ?? 0;
      parseFailureSampleCount += row.telemetry.parseFailureSampleCount;
      parseFailureCount += row.telemetry.parseFailureCount ?? 0;
      wireDroppedFollowupSampleCount +=
        row.telemetry.wireDroppedFollowupSampleCount;
      wireDroppedFollowupCount += row.telemetry.wireDroppedFollowupCount ?? 0;
      multiActionSampleCount += row.telemetry.multiActionSampleCount;
      multiActionDecisionCount += row.telemetry.multiActionDecisionCount ?? 0;
    }
    mergeCounts(actionMix, row.telemetry.actionMix);
    mergeCounts(attackTargetMix, row.telemetry.attackTargetMix);
    mergeCounts(treatmentMarkerCounts, row.telemetry.treatmentMarkerCounts);
  }
  const scoreShareSum = rows.reduce((sum, row) => sum + row.scoreShare, 0);
  const commissionerTopScoreWins = rows.filter(
    (row) => row.commissionerTopScoreWin,
  ).length;
  const outrightWins = rows.filter((row) => row.outrightWin).length;
  return {
    episodes: new Set(rows.map((row) => row.episodeId)).size,
    rows: rows.length,
    commissionerTopScoreWins,
    commissionerTopScoreWinRate: rate(commissionerTopScoreWins, rows.length),
    outrightWins,
    outrightWinRate: rate(outrightWins, rows.length),
    scoreShareSum,
    scoreShareMean: rate(scoreShareSum, rows.length),
    rowsWithDecisionTelemetry: rows.filter((row) => row.telemetry.available)
      .length,
    decisionCount,
    fallbackSampleCount,
    fallbackCount: fallbackSampleCount > 0 ? fallbackCount : null,
    fallbackRate: rate(fallbackCount, fallbackSampleCount),
    fallbackOrDegradedSampleCount,
    fallbackOrDegradedCount:
      fallbackOrDegradedSampleCount > 0 ? fallbackOrDegradedCount : null,
    fallbackOrDegradedRate: rate(
      fallbackOrDegradedCount,
      fallbackOrDegradedSampleCount,
    ),
    degradedSampleCount,
    degradedCount: degradedSampleCount > 0 ? degradedCount : null,
    degradationRate: rate(degradedCount, degradedSampleCount),
    parseFailureSampleCount,
    parseFailureCount: parseFailureSampleCount > 0 ? parseFailureCount : null,
    parseFailureRate: rate(parseFailureCount, parseFailureSampleCount),
    wireDroppedFollowupSampleCount,
    wireDroppedFollowupCount:
      wireDroppedFollowupSampleCount > 0 ? wireDroppedFollowupCount : null,
    multiActionSampleCount,
    multiActionDecisionCount:
      multiActionSampleCount > 0 ? multiActionDecisionCount : null,
    treatmentExposedRows: rows.filter((row) => row.telemetry.treatmentExposed)
      .length,
    actionMix: sortedCounts(actionMix),
    attackTargetMix: sortedCounts(attackTargetMix),
    treatmentMarkerCounts: sortedCounts(treatmentMarkerCounts),
    commanderTelemetry: mergeCommanderTelemetry(
      rows.map((row) => row.telemetry.commanderTelemetry),
    ),
    shadowCouncil: mergeShadowCouncilTelemetry(
      rows.map((row) => row.telemetry.shadowCouncil),
    ),
  };
}

function aggregateBy(
  rows: readonly CoworldEvaluationDatasetRow[],
  key: (row: CoworldEvaluationDatasetRow) => string,
): Record<string, CoworldEvaluationAggregate> {
  const grouped = new Map<string, CoworldEvaluationDatasetRow[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const group = grouped.get(groupKey) ?? [];
    group.push(row);
    grouped.set(groupKey, group);
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([groupKey, group]) => [groupKey, aggregate(group)]),
  );
}

function councilEvaluationAudit(
  rows: readonly CoworldEvaluationDatasetRow[],
  evidence: CoworldCouncilEvaluationPlanEvidence | undefined,
): CoworldCouncilEvaluationAudit {
  if (evidence === undefined) {
    return {
      available: false,
      planPaths: [],
      matrixIDs: [],
      plannedBlockCount: 0,
      plannedJobCount: 0,
      joinedJobCount: 0,
      intentionToTreatJobIDs: [],
      actualTreatmentExposureJobIDs: [],
      completeBlockIDs: [],
      missingJobIDs: [],
      invalidJobIDs: [],
      invalidJobs: [],
      unjoinedJobIDs: [],
      missingBlockIDs: [],
      invalidBlockIDs: [],
      incompleteBlockIDs: [],
      tieAudits: [],
      pairedShadowOverheadDeltas: [],
    };
  }
  const jobsByBlock = new Map<
    string,
    CoworldCouncilEvaluationPlanJobEvidence[]
  >();
  for (const job of evidence.jobs) {
    const jobs = jobsByBlock.get(job.assignment.blockID) ?? [];
    jobs.push(job);
    jobsByBlock.set(job.assignment.blockID, jobs);
  }
  const completeBlockIDs: string[] = [];
  const missingBlockIDs: string[] = [];
  const invalidBlockIDs: string[] = [];
  const incompleteBlockIDs: string[] = [];
  for (const block of evidence.blocks) {
    const jobs = jobsByBlock.get(block.blockID) ?? [];
    const expectedJobIDs = [...block.jobIDs].sort();
    const actualJobIDs = jobs
      .map((job) => job.assignment.jobID)
      .sort((left, right) => left.localeCompare(right));
    const hasExactJobs =
      jobs.length === expectedJobIDs.length &&
      new Set(actualJobIDs).size === expectedJobIDs.length &&
      expectedJobIDs.every((jobID, index) => jobID === actualJobIDs[index]);
    if (hasExactJobs && jobs.every((job) => job.status === "joined")) {
      completeBlockIDs.push(block.blockID);
    }
    if (jobs.length > 0 && jobs.every((job) => job.status === "missing")) {
      missingBlockIDs.push(block.blockID);
    }
    if (jobs.some((job) => job.status === "invalid")) {
      invalidBlockIDs.push(block.blockID);
    }
    if (!hasExactJobs || jobs.some((job) => job.status !== "joined")) {
      incompleteBlockIDs.push(block.blockID);
    }
  }
  const candidateRows = rows.filter(
    (row) =>
      row.councilEvaluation !== null &&
      row.seat === row.councilEvaluation.candidateSeat,
  );
  const tieAudits = candidateRows.map((row) => {
    const assignment = row.councilEvaluation!;
    const topScoreSlots = commissionerTopScoreSlots(row.scores);
    return {
      rowId: row.rowId,
      episodeId: row.episodeId,
      matrixID: assignment.matrixID,
      blockID: assignment.blockID,
      pairID: assignment.pairID,
      jobID: assignment.jobID,
      armID: assignment.arm.armID,
      candidateSeat: assignment.candidateSeat,
      topScoreSlots,
      topScoreMultiplicity: topScoreSlots.length,
      tiedTopScore: topScoreSlots.length > 1,
      soleTopScoreWin:
        row.commissionerTopScoreWin && topScoreSlots.length === 1,
      positiveTopScore: Math.max(...row.scores) > 0,
      allZeroTie:
        topScoreSlots.length > 1 && row.scores.every((score) => score === 0),
      commissionerTopScoreWin: row.commissionerTopScoreWin,
      outrightWin: row.outrightWin,
      outcome: row.outrightWin
        ? "outright"
        : row.commissionerTopScoreWin
          ? topScoreSlots.length > 1
            ? "shared-top-score"
            : "sole-top-score"
          : "not-top-score",
    } satisfies CoworldCouncilEvaluationTieAudit;
  });
  const rowByJobID = new Map(
    candidateRows.map((row) => [row.councilEvaluation!.jobID, row]),
  );
  const completeBlocks = new Set(completeBlockIDs);
  const pairedShadowOverheadDeltas: CoworldCouncilEvaluationShadowOverheadDelta[] =
    [];
  for (const treatment of evidence.jobs) {
    const assignment = treatment.assignment;
    if (
      treatment.status !== "joined" ||
      !assignment.arm.shadow ||
      !completeBlocks.has(assignment.blockID)
    ) {
      continue;
    }
    const base = evidence.jobs.find(
      (candidate) =>
        candidate.status === "joined" &&
        candidate.assignment.blockID === assignment.blockID &&
        !candidate.assignment.arm.shadow &&
        candidate.assignment.arm.kind === assignment.arm.base,
    );
    const baseRow =
      base === undefined ? undefined : rowByJobID.get(base.assignment.jobID);
    const treatmentRow = rowByJobID.get(assignment.jobID);
    if (
      base === undefined ||
      baseRow === undefined ||
      treatmentRow === undefined
    ) {
      continue;
    }
    const baseTopScoreSlots = commissionerTopScoreSlots(baseRow.scores);
    const treatmentTopScoreSlots = commissionerTopScoreSlots(
      treatmentRow.scores,
    );
    pairedShadowOverheadDeltas.push({
      comparisonKind: "descriptive-shadow-overhead",
      matrixID: assignment.matrixID,
      blockID: assignment.blockID,
      pairID: assignment.pairID,
      map: assignment.map,
      seed: assignment.seed,
      candidateSeat: assignment.candidateSeat,
      rosterOrderID: assignment.rosterOrderID,
      baseArmID: base.assignment.arm.armID,
      treatmentArmID: assignment.arm.armID,
      expertMask: assignment.expertMask,
      baseRowId: baseRow.rowId,
      treatmentRowId: treatmentRow.rowId,
      baseTiedTopScore: baseTopScoreSlots.length > 1,
      treatmentTiedTopScore: treatmentTopScoreSlots.length > 1,
      scoreShareDelta: treatmentRow.scoreShare - baseRow.scoreShare,
      commissionerTopScoreWinDelta:
        Number(treatmentRow.commissionerTopScoreWin) -
        Number(baseRow.commissionerTopScoreWin),
      outrightWinDelta:
        Number(treatmentRow.outrightWin) - Number(baseRow.outrightWin),
    });
  }
  const sorted = (values: Iterable<string>): string[] =>
    [...values].sort((left, right) => left.localeCompare(right));
  return {
    available: evidence.planPaths.length > 0,
    planPaths: sorted(evidence.planPaths),
    matrixIDs: sorted(
      new Set(evidence.jobs.map((job) => job.assignment.matrixID)),
    ),
    plannedBlockCount: evidence.blocks.length,
    plannedJobCount: evidence.jobs.length,
    joinedJobCount: evidence.jobs.filter((job) => job.status === "joined")
      .length,
    intentionToTreatJobIDs: sorted(
      evidence.jobs
        .filter((job) => job.assignment.intentionToTreat)
        .map((job) => job.assignment.jobID),
    ),
    actualTreatmentExposureJobIDs: sorted(
      evidence.jobs
        .filter((job) => job.assignment.actualTreatmentExposure)
        .map((job) => job.assignment.jobID),
    ),
    completeBlockIDs: sorted(completeBlockIDs),
    missingJobIDs: sorted(
      evidence.jobs
        .filter((job) => job.status === "missing")
        .map((job) => job.assignment.jobID),
    ),
    invalidJobIDs: sorted(
      evidence.jobs
        .filter((job) => job.status === "invalid")
        .map((job) => job.assignment.jobID),
    ),
    invalidJobs: evidence.jobs
      .filter(
        (
          job,
        ): job is CoworldCouncilEvaluationPlanJobEvidence & {
          invalidReason: string;
        } => job.status === "invalid" && job.invalidReason !== null,
      )
      .map((job) => ({
        jobID: job.assignment.jobID,
        blockID: job.assignment.blockID,
        reason: job.invalidReason,
      }))
      .sort((left, right) => left.jobID.localeCompare(right.jobID)),
    unjoinedJobIDs: sorted(
      evidence.jobs
        .filter((job) => job.status !== "joined")
        .map((job) => job.assignment.jobID),
    ),
    missingBlockIDs: sorted(missingBlockIDs),
    invalidBlockIDs: sorted(invalidBlockIDs),
    incompleteBlockIDs: sorted(incompleteBlockIDs),
    tieAudits: tieAudits.sort((left, right) =>
      left.jobID.localeCompare(right.jobID),
    ),
    pairedShadowOverheadDeltas: pairedShadowOverheadDeltas.sort(
      (left, right) =>
        left.blockID.localeCompare(right.blockID) ||
        left.treatmentArmID.localeCompare(right.treatmentArmID),
    ),
  };
}

export function buildCoworldEvaluationDataset(input: {
  episodes: readonly CoworldEvaluationEpisode[];
  selector: CoworldDatasetSelector;
  treatmentMarkers?: readonly CoworldTreatmentMarker[];
  spawnPhaseTurns?: number | null;
  spawnSettleThreshold?: number;
  warnings?: readonly string[];
  skippedNonCompletedEntries?: number;
  skippedByStatus?: Readonly<Record<string, number>>;
  councilEvaluationPlan?: CoworldCouncilEvaluationPlanEvidence;
}): CoworldEvaluationDataset {
  const treatmentMarkers = [...(input.treatmentMarkers ?? [])];
  const spawnPhaseTurns = input.spawnPhaseTurns ?? null;
  const spawnSettleThreshold = input.spawnSettleThreshold ?? 0.8;
  const rows = input.episodes.flatMap((episode) => {
    const winnerSlots = new Set(commissionerTopScoreSlots(episode.scores));
    return selectedSeats(episode, input.selector).map((seat) => {
      const rosterSeat = episode.roster.find((entry) => entry.seat === seat);
      const scoreShare = episode.scores[seat];
      if (scoreShare === undefined || !Number.isFinite(scoreShare)) {
        throw new Error(
          `Episode ${episode.episodeId} seat ${seat} has no finite score`,
        );
      }
      return {
        rowId: `${episode.episodeId}:seat:${seat}`,
        episodeId: episode.episodeId,
        sourcePaths: [...episode.sourcePaths].sort(),
        runID: episode.runID,
        platformCompletedAt: episode.platformCompletedAt,
        runtimeCompletedAt: episode.runtimeCompletedAt,
        map: episode.map,
        mapSize: episode.mapSize,
        seat,
        policyVersionId: rosterSeat?.policyVersionId ?? null,
        playerName: rosterSeat?.playerName ?? null,
        roster: episode.roster,
        opponents: episode.roster.filter((entry) => entry.seat !== seat),
        scores: episode.scores,
        scoreShare,
        commissionerTopScoreWin: winnerSlots.has(seat),
        outrightWin: episode.outrightWinnerSlot === seat,
        telemetry: seatTelemetry(episode, seat, treatmentMarkers),
        spawnDiagnostics: spawnDiagnostics(
          episode,
          seat,
          spawnPhaseTurns,
          spawnSettleThreshold,
        ),
        phaseSnapshots: phaseSnapshotsForSeat(episode, seat),
        councilEvaluation:
          episode.councilEvaluation?.candidateSeat === seat
            ? episode.councilEvaluation
            : null,
      } satisfies CoworldEvaluationDatasetRow;
    });
  });
  rows.sort(
    (left, right) =>
      left.episodeId.localeCompare(right.episodeId) || left.seat - right.seat,
  );
  const sourceCount = new Set(
    input.episodes.flatMap((episode) => episode.sourcePaths),
  ).size;
  return {
    schemaVersion: 4,
    selector: input.selector,
    treatmentMarkers,
    spawnDiagnosticsConfig: {
      spawnPhaseTurns,
      settleThreshold: spawnSettleThreshold,
    },
    sourceCount,
    ingestion: {
      skippedNonCompletedEntries: input.skippedNonCompletedEntries ?? 0,
      skippedByStatus: sortedCounts({ ...(input.skippedByStatus ?? {}) }),
    },
    warnings: [...(input.warnings ?? [])],
    councilEvaluation: councilEvaluationAudit(
      rows,
      input.councilEvaluationPlan,
    ),
    rows,
    aggregate: aggregate(rows),
    byMap: aggregateBy(rows, (row) => row.map),
    bySeat: aggregateBy(rows, (row) => String(row.seat)),
    byPolicyVersion: aggregateBy(
      rows,
      (row) => row.policyVersionId ?? row.playerName ?? "unknown",
    ),
  };
}

export function conciseCoworldDatasetSummary(
  dataset: CoworldEvaluationDataset,
): string {
  const aggregate = dataset.aggregate;
  const percent = (value: number | null): string =>
    value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;
  const count = (value: number | null): string =>
    value === null ? "n/a" : String(value);
  return [
    `${aggregate.rows} seat-row(s) across ${aggregate.episodes} episode(s)`,
    `top-score ${aggregate.commissionerTopScoreWins}/${aggregate.rows} (${percent(aggregate.commissionerTopScoreWinRate)})`,
    `score share ${percent(aggregate.scoreShareMean)}`,
    `telemetry ${aggregate.rowsWithDecisionTelemetry}/${aggregate.rows} row(s)`,
    `fallback/degraded/parse ${count(aggregate.fallbackCount)}/${count(aggregate.degradedCount)}/${count(aggregate.parseFailureCount)}`,
    `wire-dropped ${count(aggregate.wireDroppedFollowupCount)} across ${count(aggregate.multiActionDecisionCount)} multi-action decision(s)`,
    `treatment exposed ${aggregate.treatmentExposedRows}/${aggregate.rows}`,
    ...(dataset.councilEvaluation.available
      ? [
          `council plan ${dataset.councilEvaluation.joinedJobCount}/${dataset.councilEvaluation.plannedJobCount} job(s), ${dataset.councilEvaluation.completeBlockIDs.length}/${dataset.councilEvaluation.plannedBlockCount} complete block(s)`,
        ]
      : []),
  ].join("; ");
}
