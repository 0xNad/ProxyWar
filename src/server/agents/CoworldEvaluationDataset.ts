import { commissionerTopScoreSlots } from "./CoworldScoreSemantics";

export type CoworldTelemetryPrimitive = string | number | boolean | null;

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
  fallbackRate: number | null;
  fallbackOrDegradedRate: number | null;
  degradationRate: number | null;
  parseFailureRate: number | null;
  treatmentExposed: boolean;
  treatmentMarkerCounts: Record<string, number>;
  episodeReported: CoworldEpisodeReportedTelemetry;
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
}

export interface CoworldEvaluationDataset {
  schemaVersion: 3;
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

export function buildCoworldEvaluationDataset(input: {
  episodes: readonly CoworldEvaluationEpisode[];
  selector: CoworldDatasetSelector;
  treatmentMarkers?: readonly CoworldTreatmentMarker[];
  spawnPhaseTurns?: number | null;
  spawnSettleThreshold?: number;
  warnings?: readonly string[];
  skippedNonCompletedEntries?: number;
  skippedByStatus?: Readonly<Record<string, number>>;
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
    schemaVersion: 3,
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
  ].join("; ");
}
