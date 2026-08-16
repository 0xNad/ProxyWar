import {
  AgentDecision,
  AgentSpawnBallotInvalidReason,
  AgentSpawnBallotSource,
  AgentSpawnSelectionDefaultReason,
  AgentSpawnSelectionEvidence,
  LegalAction,
} from "./AgentTypes";
import { MAX_SPAWN_PREFERENCE_ACTION_IDS } from "./AgentWireProtocol";

export type {
  AgentSpawnBallotInvalidReason,
  AgentSpawnBallotSource,
  AgentSpawnSelectionDefaultReason,
  AgentSpawnSelectionEvidence,
} from "./AgentTypes";

/**
 * One sealed ranked ballot followed by deterministic serial dictatorship.
 * Changing any ordering, validation, completion, or default rule requires a
 * new version: retained decisions.jsonl evidence must remain replayable.
 */
export const AGENT_SPAWN_SELECTION_ALGORITHM_VERSION =
  "sealed-ranked-serial-dictatorship-v1";

export const MAX_SPAWN_PREFERENCES = MAX_SPAWN_PREFERENCE_ACTION_IDS;

/**
 * Canonical Coworld/template participant ceiling. This is intentionally
 * independent from the authored ballot cap above: a 25-seat match still
 * accepts at most 16 authored preferences and completes the remaining tail in
 * the frozen offered order.
 */
export const MAX_AGENT_SPAWN_PARTICIPANTS = 25;

const MAX_RECORDED_ACTION_ID_LENGTH = 120;
const MAX_RECORDED_REASON_LENGTH = 280;
const MAX_PRIORITY_USERNAME_LENGTH = 120;
const MAX_DEGRADATION_REASON_LENGTH = 240;

export interface AgentSpawnBallotInput {
  /**
   * Stable allocator identity. Callers with potentially colliding display
   * names must provide this; legacy unique-name callers may omit it.
   */
  participantID?: string;
  username: string;
  decision: AgentDecision | null;
  stageLatencyMs: number;
  /**
   * Forces report-independent offered-order defaulting even if the returned
   * decision has a syntactically valid ballot (provider fallback/degradation).
   */
  forcedDefaultReason?: AgentSpawnSelectionDefaultReason | null;
  stageDegradationReason?: string | null;
}

export interface AgentSpawnAssignment {
  participantID: string;
  username: string;
  action: LegalAction;
  decision: AgentDecision | null;
  evidence: AgentSpawnSelectionEvidence;
}

/** Public validation surface for parsers/tests that need the exact backend verdict. */
export function validateAgentSpawnBallot(
  decision: AgentDecision | null,
  offeredActions: readonly LegalAction[],
): {
  valid: boolean;
  invalidReason: AgentSpawnBallotInvalidReason | null;
} {
  const invalidReason = validateCapturedBallot(
    captureSubmittedBallot(decision),
    offeredActions,
  );
  return { valid: invalidReason === null, invalidReason };
}

interface NormalizedBallot {
  source: AgentSpawnBallotSource;
  submittedActionIDs: Array<string | null>;
  submittedEntryTypes: string[];
  submittedCount: number;
  submittedTruncated: boolean;
  submittedReason: string | null;
  submittedStringActionIDs: string[];
  normalizedActionIDs: string[];
  valid: boolean;
  invalidReason: AgentSpawnBallotInvalidReason | null;
  defaultReason: AgentSpawnSelectionDefaultReason | null;
  degradationReason: string | null;
}

export interface AgentSpawnPriorityParticipant {
  participantID: string;
  username: string;
}

/**
 * Report-independent priority: display usernames are code-unit sorted, with a
 * stable participant id as the duplicate-name tie-breaker, then rotated by
 * episodeIndex. It does not read participant array order, response arrival,
 * ballot contents, provider metadata, or mutable game state.
 *
 * The string form is retained for unique-username callers and returns those
 * usernames. Identity-bearing callers receive participant ids in priority
 * order, allowing duplicate display names without ambiguous map keys.
 */
export function buildAgentSpawnPriority(
  participants: readonly (string | AgentSpawnPriorityParticipant)[],
  episodeIndex: number,
): string[] {
  if (!Number.isSafeInteger(episodeIndex) || episodeIndex < 0) {
    throw new Error(
      `buildAgentSpawnPriority: episodeIndex must be a non-negative safe integer, got ${episodeIndex}`,
    );
  }
  if (
    participants.length === 0 ||
    participants.length > MAX_AGENT_SPAWN_PARTICIPANTS
  ) {
    throw new Error(
      `buildAgentSpawnPriority: expected 1-${MAX_AGENT_SPAWN_PARTICIPANTS} participants, got ${participants.length}`,
    );
  }

  const normalized = participants.map((participant) =>
    typeof participant === "string"
      ? { participantID: participant, username: participant }
      : participant,
  );
  const seenParticipantIDs = new Set<string>();
  for (const { participantID, username } of normalized) {
    if (
      typeof username !== "string" ||
      username.length === 0 ||
      username.length > MAX_PRIORITY_USERNAME_LENGTH
    ) {
      throw new Error(
        `buildAgentSpawnPriority: usernames must be non-empty strings of at most ${MAX_PRIORITY_USERNAME_LENGTH} characters`,
      );
    }
    if (
      typeof participantID !== "string" ||
      participantID.length === 0 ||
      participantID.length > MAX_PRIORITY_USERNAME_LENGTH
    ) {
      throw new Error(
        `buildAgentSpawnPriority: participant ids must be non-empty strings of at most ${MAX_PRIORITY_USERNAME_LENGTH} characters`,
      );
    }
    if (seenParticipantIDs.has(participantID)) {
      throw new Error(
        `buildAgentSpawnPriority: participant ids must be unique; duplicate ${recordedString(participantID, MAX_PRIORITY_USERNAME_LENGTH)}`,
      );
    }
    seenParticipantIDs.add(participantID);
  }

  const stable = [...normalized].sort(
    (left, right) =>
      compareCodeUnits(left.username, right.username) ||
      compareCodeUnits(left.participantID, right.participantID),
  );
  const offset = episodeIndex % stable.length;
  return [...stable.slice(offset), ...stable.slice(0, offset)].map(
    (participant) => participant.participantID,
  );
}

/**
 * Resolves one simultaneous sealed ranked-ballot stage. `priorityOrder` must
 * be computed before dispatching brains via buildAgentSpawnPriority.
 */
export function resolveAgentSpawnSelection(input: {
  offeredActions: readonly LegalAction[];
  ballots: readonly AgentSpawnBallotInput[];
  priorityOrder: readonly string[];
}): AgentSpawnAssignment[] {
  const offeredActions = validateOfferedSpawnActions(
    input.offeredActions,
    input.ballots.length,
  );
  validatePriorityOrder(input.ballots, input.priorityOrder);

  const offeredActionIDs = offeredActions.map((action) => action.id);
  const actionByID = new Map(
    offeredActions.map((action) => [action.id, action]),
  );
  const ballotByParticipantID = new Map(
    input.ballots.map((ballot) => [spawnParticipantID(ballot), ballot]),
  );
  const normalizedByParticipantID = new Map<string, NormalizedBallot>();
  for (const ballot of input.ballots) {
    normalizedByParticipantID.set(
      spawnParticipantID(ballot),
      normalizeBallot(ballot, offeredActions, offeredActionIDs),
    );
  }
  const priorityDisplayOrder = input.priorityOrder.map(
    (participantID) => ballotByParticipantID.get(participantID)!.username,
  );

  const available = new Set(offeredActionIDs);
  const assignments: AgentSpawnAssignment[] = [];
  for (
    let priorityIndex = 0;
    priorityIndex < input.priorityOrder.length;
    priorityIndex += 1
  ) {
    const participantID = input.priorityOrder[priorityIndex];
    const ballot = ballotByParticipantID.get(participantID);
    const normalized = normalizedByParticipantID.get(participantID);
    if (ballot === undefined || normalized === undefined) {
      throw new Error(
        `resolveAgentSpawnSelection: priority named unknown participant ${participantID}`,
      );
    }
    const assignedActionID = normalized.normalizedActionIDs.find((id) =>
      available.has(id),
    );
    if (assignedActionID === undefined) {
      throw new Error(
        `resolveAgentSpawnSelection: no spawn remained for ${participantID}; normalized ballots must be full permutations`,
      );
    }
    const action = actionByID.get(assignedActionID);
    if (action === undefined) {
      throw new Error(
        `resolveAgentSpawnSelection: assigned unknown offered id ${assignedActionID}`,
      );
    }
    available.delete(assignedActionID);
    const submittedRank =
      normalized.submittedStringActionIDs.indexOf(assignedActionID);
    assignments.push({
      participantID,
      username: ballot.username,
      action,
      decision: ballot.decision,
      evidence: {
        algorithmVersion: AGENT_SPAWN_SELECTION_ALGORITHM_VERSION,
        offeredActionIDs: [...offeredActionIDs],
        ballotSource: normalized.source,
        submittedBallotActionIDs: [...normalized.submittedActionIDs],
        submittedBallotEntryTypes: [...normalized.submittedEntryTypes],
        submittedBallotCount: normalized.submittedCount,
        submittedBallotTruncated: normalized.submittedTruncated,
        submittedReason: normalized.submittedReason,
        normalizedBallotActionIDs: [...normalized.normalizedActionIDs],
        ballotValid: normalized.valid,
        ballotInvalidReason: normalized.invalidReason,
        defaultReason: normalized.defaultReason,
        participantID,
        priorityParticipantIDs: [...input.priorityOrder],
        priorityOrder: [...priorityDisplayOrder],
        priorityRank: priorityIndex + 1,
        assignedActionID,
        assignedPreferenceRank:
          normalized.normalizedActionIDs.indexOf(assignedActionID) + 1,
        assignedSubmittedPreferenceRank:
          submittedRank === -1 ? null : submittedRank + 1,
        stageLatencyMs: boundedLatency(ballot.stageLatencyMs),
        stageFallbackUsed: normalized.defaultReason !== null,
        stageDegradationReason: normalized.degradationReason,
      },
    });
  }

  if (available.size !== 0) {
    throw new Error(
      `resolveAgentSpawnSelection: allocation left ${available.size} offered spawn(s) unassigned`,
    );
  }
  return assignments;
}

function normalizeBallot(
  input: AgentSpawnBallotInput,
  offeredActions: readonly LegalAction[],
  offeredActionIDs: readonly string[],
): NormalizedBallot {
  const captured = captureSubmittedBallot(input.decision);
  let invalidReason = validateCapturedBallot(captured, offeredActions);
  const forcedDefaultReason = input.forcedDefaultReason ?? null;
  if (input.decision === null && invalidReason === null) {
    invalidReason = "no-decision";
  }
  const defaultReason =
    forcedDefaultReason ?? (invalidReason === null ? null : "invalid-ballot");
  const effectiveSubmitted =
    invalidReason === null && forcedDefaultReason === null
      ? captured.stringActionIDs
      : [];
  const normalizedActionIDs = [
    ...effectiveSubmitted,
    ...offeredActionIDs.filter((id) => !effectiveSubmitted.includes(id)),
  ];
  const validationDegradation =
    invalidReason === null ? null : `invalid-ballot:${invalidReason}`;

  return {
    source: captured.source,
    submittedActionIDs: captured.actionIDs,
    submittedEntryTypes: captured.entryTypes,
    submittedCount: captured.count,
    submittedTruncated: captured.truncated,
    submittedReason: boundedNullableString(
      input.decision?.reason,
      MAX_RECORDED_REASON_LENGTH,
    ),
    submittedStringActionIDs: captured.stringActionIDs,
    normalizedActionIDs,
    valid: invalidReason === null,
    invalidReason,
    defaultReason,
    degradationReason: boundedNullableString(
      input.stageDegradationReason ?? validationDegradation,
      MAX_DEGRADATION_REASON_LENGTH,
    ),
  };
}

interface CapturedBallot {
  source: AgentSpawnBallotSource;
  actionID: unknown;
  hasExecutableActionBatch: boolean;
  rawPreferences: unknown;
  actionIDs: Array<string | null>;
  entryTypes: string[];
  stringActionIDs: string[];
  count: number;
  truncated: boolean;
}

function captureSubmittedBallot(
  decision: AgentDecision | null,
): CapturedBallot {
  if (decision === null) {
    return {
      source: "none",
      actionID: undefined,
      hasExecutableActionBatch: false,
      rawPreferences: undefined,
      actionIDs: [],
      entryTypes: [],
      stringActionIDs: [],
      count: 0,
      truncated: false,
    };
  }
  const runtimeDecision = decision as AgentDecision & {
    actionID: unknown;
    spawnPreferenceActionIDs?: unknown;
  };
  const explicit = Object.prototype.hasOwnProperty.call(
    runtimeDecision,
    "spawnPreferenceActionIDs",
  );
  const rawPreferences = runtimeDecision.spawnPreferenceActionIDs;
  const rawEntries = explicit
    ? Array.isArray(rawPreferences)
      ? rawPreferences
      : []
    : [runtimeDecision.actionID];
  const captureCount = Math.min(rawEntries.length, MAX_SPAWN_PREFERENCES);
  const actionIDs: Array<string | null> = [];
  const entryTypes: string[] = [];
  const stringActionIDs: string[] = [];
  for (let index = 0; index < captureCount; index += 1) {
    const value = rawEntries[index];
    entryTypes.push(runtimeType(value));
    if (typeof value === "string") {
      actionIDs.push(recordedString(value, MAX_RECORDED_ACTION_ID_LENGTH));
      stringActionIDs.push(value);
    } else {
      actionIDs.push(null);
    }
  }
  return {
    source: explicit ? "explicit-ranked" : "scalar-action-id",
    actionID: runtimeDecision.actionID,
    hasExecutableActionBatch: Object.prototype.hasOwnProperty.call(
      runtimeDecision,
      "actionIDs",
    ),
    rawPreferences,
    actionIDs,
    entryTypes,
    stringActionIDs,
    count: Array.isArray(rawPreferences)
      ? rawPreferences.length
      : explicit
        ? 0
        : 1,
    truncated: rawEntries.length > captureCount,
  };
}

function validateCapturedBallot(
  captured: CapturedBallot,
  offeredActions: readonly LegalAction[],
): AgentSpawnBallotInvalidReason | null {
  if (captured.source === "none") {
    return "no-decision";
  }
  if (typeof captured.actionID !== "string") {
    return "action-id-not-string";
  }
  if (captured.actionID.length > MAX_RECORDED_ACTION_ID_LENGTH) {
    return "action-id-too-long";
  }
  if (captured.hasExecutableActionBatch) {
    return "executable-action-batch-on-spawn";
  }
  if (
    captured.source === "explicit-ranked" &&
    !Array.isArray(captured.rawPreferences)
  ) {
    return "preferences-not-array";
  }
  if (captured.count === 0) {
    return "empty-preference-ballot";
  }
  if (captured.count > MAX_SPAWN_PREFERENCES) {
    return "too-many-preferences";
  }
  if (captured.entryTypes.some((type) => type !== "string")) {
    return "preference-not-string";
  }
  if (
    captured.stringActionIDs.some(
      (actionID) => actionID.length > MAX_RECORDED_ACTION_ID_LENGTH,
    )
  ) {
    return "preference-id-too-long";
  }
  if (
    new Set(captured.stringActionIDs).size !== captured.stringActionIDs.length
  ) {
    return "duplicate-preference";
  }
  if (captured.stringActionIDs[0] !== captured.actionID) {
    return "first-preference-mismatch";
  }
  const offeredByID = new Map(
    offeredActions.map((action) => [action.id, action]),
  );
  for (const actionID of captured.stringActionIDs) {
    const action = offeredByID.get(actionID);
    if (action === undefined) {
      return "off-menu-preference";
    }
    if (action.kind !== "spawn") {
      return "wrong-kind-preference";
    }
  }
  return null;
}

function validateOfferedSpawnActions(
  offered: readonly LegalAction[],
  participantCount: number,
): LegalAction[] {
  if (
    participantCount < 1 ||
    participantCount > MAX_AGENT_SPAWN_PARTICIPANTS ||
    offered.length !== participantCount
  ) {
    throw new Error(
      `resolveAgentSpawnSelection: expected exactly one offered spawn per participant (participants=${participantCount}, offered=${offered.length}, max=${MAX_AGENT_SPAWN_PARTICIPANTS})`,
    );
  }
  const ids = new Set<string>();
  for (const action of offered) {
    if (action.kind !== "spawn" || action.intent?.type !== "spawn") {
      throw new Error(
        `resolveAgentSpawnSelection: offered action ${recordedString(action.id, MAX_RECORDED_ACTION_ID_LENGTH)} is not a spawn LegalAction`,
      );
    }
    if (action.id.length > MAX_RECORDED_ACTION_ID_LENGTH) {
      throw new Error(
        `resolveAgentSpawnSelection: offered spawn id exceeds ${MAX_RECORDED_ACTION_ID_LENGTH} characters`,
      );
    }
    if (ids.has(action.id)) {
      throw new Error(
        `resolveAgentSpawnSelection: duplicate offered spawn id ${action.id}`,
      );
    }
    ids.add(action.id);
  }
  return [...offered];
}

function validatePriorityOrder(
  ballots: readonly AgentSpawnBallotInput[],
  priorityOrder: readonly string[],
): void {
  if (priorityOrder.length !== ballots.length) {
    throw new Error(
      `resolveAgentSpawnSelection: priority length ${priorityOrder.length} does not match ballot count ${ballots.length}`,
    );
  }
  const ballotParticipantIDs = new Set(
    ballots.map((ballot) => spawnParticipantID(ballot)),
  );
  if (
    [...ballotParticipantIDs].some(
      (participantID) =>
        participantID.length === 0 ||
        participantID.length > MAX_PRIORITY_USERNAME_LENGTH,
    )
  ) {
    throw new Error(
      `resolveAgentSpawnSelection: participant ids must be non-empty strings of at most ${MAX_PRIORITY_USERNAME_LENGTH} characters`,
    );
  }
  if (ballotParticipantIDs.size !== ballots.length) {
    throw new Error(
      "resolveAgentSpawnSelection: ballot participant ids must be unique",
    );
  }
  const priorityParticipantIDs = new Set(priorityOrder);
  if (
    priorityParticipantIDs.size !== priorityOrder.length ||
    [...priorityParticipantIDs].some(
      (participantID) => !ballotParticipantIDs.has(participantID),
    )
  ) {
    throw new Error(
      "resolveAgentSpawnSelection: priority must be an exact permutation of ballot participant ids",
    );
  }
}

function spawnParticipantID(ballot: AgentSpawnBallotInput): string {
  return ballot.participantID ?? ballot.username;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function recordedString(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength - 3)}...`;
}

function boundedNullableString(
  value: unknown,
  maximumLength: number,
): string | null {
  return typeof value === "string"
    ? recordedString(value, maximumLength)
    : null;
}

function runtimeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function boundedLatency(value: number): number {
  return Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), 2_147_483_647)
    : 0;
}
