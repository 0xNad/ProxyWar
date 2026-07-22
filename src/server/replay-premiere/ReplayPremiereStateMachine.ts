import {
  isPremiereId,
  type PremiereState,
  type PremiereTerminalReasonCode,
  type ReleasedPremiereChunk,
} from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import { isSha256Hex } from "./ReplayPremiereIntegrity";
import {
  VerifiedPremiereEligibilityGate,
  VerifiedPremiereTerminalChunk,
} from "./ReplayPremierePublication";

const issuedRevealGates = new WeakSet<object>();

export interface PremiereLifecycleSnapshot {
  schemaVersion: 1;
  premiereId: string;
  state: PremiereState;
  eligibilityRecordHash: string | null;
  publicationCommitmentHash: string | null;
  sourceRunId: string | null;
  sourceReplaySha256: string | null;
  lastSafeReleasedSequence: number;
  terminalReasonCode: PremiereTerminalReasonCode | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type PremiereTransitionAction =
  | "publish"
  | "start"
  | "open_checkpoint"
  | "resume"
  | "reveal"
  | "fail"
  | "cancel"
  | "archive";

export type PremiereTransitionRequest =
  | {
      action: "publish";
      actor: "operator";
      occurredAt: string;
      gate: VerifiedPremiereEligibilityGate;
    }
  | {
      action: "start";
      actor: "service";
      occurredAt: string;
      serviceReady: boolean;
    }
  | {
      action: "open_checkpoint" | "resume";
      actor: "service";
      occurredAt: string;
    }
  | {
      action: "reveal";
      actor: "service";
      occurredAt: string;
      gate: VerifiedPremiereRevealGate;
    }
  | {
      action: "fail";
      actor: "operator" | "service";
      occurredAt: string;
      reasonCode: "integrity_failure" | "outage_exceeded" | "runtime_failure";
    }
  | {
      action: "cancel";
      actor: "operator";
      occurredAt: string;
      reasonCode: "cancelled_by_operator" | "source_ineligible";
    }
  | {
      action: "archive";
      actor: "operator" | "service";
      occurredAt: string;
    };

export interface PremiereTransitionAuditEvent {
  schemaVersion: 1;
  eventKind: "premiere_transition";
  premiereId: string;
  action: PremiereTransitionAction;
  fromState: PremiereState;
  toState: PremiereState;
  actor: "operator" | "service";
  occurredAt: string;
  lifecycleVersion: number;
  eligibilityRecordHash: string | null;
  publicationCommitmentHash: string | null;
  sourceRunId: string | null;
  sourceReplaySha256: string | null;
  terminalReasonCode: PremiereTerminalReasonCode | null;
  lastSafeReleasedSequence: number;
}

export interface PremiereTransitionResult {
  snapshot: PremiereLifecycleSnapshot;
  auditEvent: PremiereTransitionAuditEvent;
}

const allowedTransitions: Readonly<
  Record<
    PremiereState,
    Partial<Record<PremiereTransitionAction, PremiereState>>
  >
> = {
  draft: { publish: "scheduled", cancel: "cancelled" },
  scheduled: { start: "playing", cancel: "cancelled" },
  playing: {
    open_checkpoint: "checkpoint",
    reveal: "revealed",
    fail: "failed",
  },
  checkpoint: { resume: "playing", fail: "failed" },
  revealed: { archive: "archived" },
  failed: { archive: "archived" },
  cancelled: { archive: "archived" },
  archived: {},
};

/**
 * Runtime-unforgeable reveal proof. Module-private issuance registries prevent
 * prototype fabrication from bypassing the locked publication/lifecycle gate.
 */
export class VerifiedPremiereRevealGate {
  private constructor(
    readonly premiereId: string,
    readonly lifecycleVersion: number,
    readonly publicationCommitmentHash: string,
    readonly terminalChunkHash: string,
    readonly finalSequence: number,
    readonly resultHash: string,
    readonly revealedAt: string,
  ) {}

  static verify(options: {
    lockedLifecycle: PremiereLifecycleSnapshot;
    publicationGate: VerifiedPremiereEligibilityGate;
    terminal: VerifiedPremiereTerminalChunk;
    previousChunk: ReleasedPremiereChunk | null;
  }): VerifiedPremiereRevealGate {
    validateLifecycleSnapshot(options.lockedLifecycle);
    if (
      !VerifiedPremiereEligibilityGate.isAuthentic(options.publicationGate) ||
      !VerifiedPremiereTerminalChunk.isAuthenticFor(
        options.terminal,
        options.publicationGate,
      )
    ) {
      throw revealGateFailure();
    }
    const terminalChunk = options.terminal.chunk();
    const descriptor = terminalChunk.descriptor;
    if (
      options.lockedLifecycle.state !== "playing" ||
      !options.publicationGate.matchesLifecycleBinding(
        options.lockedLifecycle,
      ) ||
      descriptor.premiereId !== options.lockedLifecycle.premiereId ||
      descriptor.terminal !== true ||
      descriptor.startSequence !==
        options.lockedLifecycle.lastSafeReleasedSequence + 1 ||
      !options.terminal.matchesPrevious(options.previousChunk) ||
      options.terminal.finalSequence !== options.publicationGate.finalSequence
    ) {
      throw revealGateFailure();
    }
    const gate = new VerifiedPremiereRevealGate(
      options.lockedLifecycle.premiereId,
      options.lockedLifecycle.version,
      options.publicationGate.publicationCommitmentHash,
      descriptor.chunkHash,
      descriptor.endSequence,
      options.terminal.resultHash,
      options.terminal.revealedAt,
    );
    issuedRevealGates.add(gate);
    Object.freeze(gate);
    return gate;
  }

  static isAuthentic(value: unknown): value is VerifiedPremiereRevealGate {
    return (
      value instanceof VerifiedPremiereRevealGate &&
      issuedRevealGates.has(value)
    );
  }

  matches(lifecycle: PremiereLifecycleSnapshot, occurredAt: string): boolean {
    return (
      this.premiereId === lifecycle.premiereId &&
      this.lifecycleVersion === lifecycle.version &&
      this.publicationCommitmentHash === lifecycle.publicationCommitmentHash &&
      this.revealedAt === occurredAt
    );
  }
}

export function createDraftPremiereLifecycle(options: {
  premiereId: string;
  createdAt: string;
}): PremiereLifecycleSnapshot {
  if (!isPremiereId(options.premiereId)) {
    throw invalidStateRequest("invalid_premiere_id");
  }
  assertCanonicalTimestamp(options.createdAt, "createdAt");
  return {
    schemaVersion: 1,
    premiereId: options.premiereId,
    state: "draft",
    eligibilityRecordHash: null,
    publicationCommitmentHash: null,
    sourceRunId: null,
    sourceReplaySha256: null,
    lastSafeReleasedSequence: -1,
    terminalReasonCode: null,
    version: 0,
    createdAt: options.createdAt,
    updatedAt: options.createdAt,
  };
}

export function transitionPremiereLifecycle(
  current: PremiereLifecycleSnapshot,
  request: PremiereTransitionRequest,
): PremiereTransitionResult {
  validateLifecycleSnapshot(current);
  const occurredAtMs = assertCanonicalTimestamp(
    request.occurredAt,
    "occurredAt",
  );
  if (occurredAtMs < Date.parse(current.updatedAt)) {
    throw invalidStateRequest("non_monotonic_transition_time");
  }
  validateTransitionActor(request);
  const nextState = allowedTransitions[current.state][request.action];
  if (nextState === undefined) {
    throw invalidStateRequest(
      `invalid_transition_${current.state}_${request.action}`,
    );
  }
  validateTransitionPreconditions(current, request);

  let eligibilityRecordHash = current.eligibilityRecordHash;
  let publicationCommitmentHash = current.publicationCommitmentHash;
  let sourceRunId = current.sourceRunId;
  let sourceReplaySha256 = current.sourceReplaySha256;
  if (request.action === "publish") {
    eligibilityRecordHash = request.gate.eligibilityRecordHash;
    publicationCommitmentHash = request.gate.publicationCommitmentHash;
    sourceRunId = request.gate.sourceRunId;
    sourceReplaySha256 = request.gate.sourceReplaySha256;
  }
  let terminalReasonCode = current.terminalReasonCode;
  if (request.action === "fail" || request.action === "cancel") {
    terminalReasonCode = request.reasonCode;
  }
  const snapshot: PremiereLifecycleSnapshot = {
    ...current,
    state: nextState,
    eligibilityRecordHash,
    publicationCommitmentHash,
    sourceRunId,
    sourceReplaySha256,
    terminalReasonCode,
    lastSafeReleasedSequence:
      request.action === "reveal"
        ? request.gate.finalSequence
        : current.lastSafeReleasedSequence,
    version: current.version + 1,
    updatedAt: request.occurredAt,
  };
  validateLifecycleSnapshot(snapshot);
  return {
    snapshot,
    auditEvent: {
      schemaVersion: 1,
      eventKind: "premiere_transition",
      premiereId: current.premiereId,
      action: request.action,
      fromState: current.state,
      toState: nextState,
      actor: request.actor,
      occurredAt: request.occurredAt,
      lifecycleVersion: snapshot.version,
      eligibilityRecordHash,
      publicationCommitmentHash,
      sourceRunId,
      sourceReplaySha256,
      terminalReasonCode,
      lastSafeReleasedSequence: snapshot.lastSafeReleasedSequence,
    },
  };
}

function validateTransitionActor(request: PremiereTransitionRequest): void {
  const actorPermitted =
    request.action === "fail" || request.action === "archive"
      ? request.actor === "operator" || request.actor === "service"
      : request.action === "publish" || request.action === "cancel"
        ? request.actor === "operator"
        : request.actor === "service";
  if (!actorPermitted) {
    throw invalidStateRequest(`unauthorized_${request.action}_actor`);
  }
}

export function recordSafeReleasedSequence(
  current: PremiereLifecycleSnapshot,
  sequence: number,
  occurredAt: string,
): PremiereLifecycleSnapshot {
  validateLifecycleSnapshot(current);
  const occurredAtMs = assertCanonicalTimestamp(occurredAt, "occurredAt");
  if (current.state !== "playing") {
    throw invalidStateRequest("release_not_permitted_in_current_state");
  }
  if (
    !Number.isSafeInteger(sequence) ||
    sequence !== current.lastSafeReleasedSequence + 1
  ) {
    throw invalidStateRequest("released_sequence_not_contiguous");
  }
  if (occurredAtMs < Date.parse(current.updatedAt)) {
    throw invalidStateRequest("non_monotonic_release_time");
  }
  return {
    ...current,
    lastSafeReleasedSequence: sequence,
    version: current.version + 1,
    updatedAt: occurredAt,
  };
}

export function mayReleasePremiereSequence(
  snapshot: PremiereLifecycleSnapshot,
): boolean {
  return snapshot.state === "playing";
}

function validateTransitionPreconditions(
  current: PremiereLifecycleSnapshot,
  request: PremiereTransitionRequest,
): void {
  switch (request.action) {
    case "publish":
      if (
        !VerifiedPremiereEligibilityGate.isAuthentic(request.gate) ||
        request.gate.premiereId !== current.premiereId
      ) {
        throw new ReplayPremiereError(
          "source_ineligible_for_publish",
          "PREMIERE_SOURCE_INELIGIBLE",
          422,
          "An ineligible replay premiere cannot leave draft",
        );
      }
      return;
    case "start":
      if (!request.serviceReady) {
        throw invalidStateRequest("service_not_ready_to_start");
      }
      return;
    case "reveal":
      if (
        !VerifiedPremiereRevealGate.isAuthentic(request.gate) ||
        !request.gate.matches(current, request.occurredAt)
      ) {
        throw new ReplayPremiereError(
          "reveal_integrity_gate_failed",
          "PREMIERE_INTEGRITY_FAILURE",
          409,
          "Replay premiere reveal preconditions are not satisfied",
        );
      }
      return;
    case "fail":
      if (
        request.reasonCode !== "integrity_failure" &&
        request.reasonCode !== "outage_exceeded" &&
        request.reasonCode !== "runtime_failure"
      ) {
        throw invalidStateRequest("invalid_failure_reason");
      }
      return;
    case "cancel":
      if (
        request.reasonCode !== "cancelled_by_operator" &&
        request.reasonCode !== "source_ineligible"
      ) {
        throw invalidStateRequest("invalid_cancellation_reason");
      }
      if (
        request.reasonCode === "source_ineligible" &&
        current.state !== "draft"
      ) {
        throw invalidStateRequest("source_ineligible_after_publish");
      }
      return;
    case "open_checkpoint":
    case "resume":
    case "archive":
      return;
  }
}

function validateLifecycleSnapshot(snapshot: PremiereLifecycleSnapshot): void {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    throw invalidStateRequest("invalid_lifecycle_snapshot");
  }
  const expectedKeys = [
    "schemaVersion",
    "premiereId",
    "state",
    "eligibilityRecordHash",
    "publicationCommitmentHash",
    "sourceRunId",
    "sourceReplaySha256",
    "lastSafeReleasedSequence",
    "terminalReasonCode",
    "version",
    "createdAt",
    "updatedAt",
  ].sort();
  const actualKeys = Object.keys(snapshot as unknown as object).sort();
  const states: readonly PremiereState[] = [
    "draft",
    "scheduled",
    "playing",
    "checkpoint",
    "revealed",
    "failed",
    "cancelled",
    "archived",
  ];
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    snapshot.schemaVersion !== 1 ||
    !isPremiereId(snapshot.premiereId) ||
    !states.includes(snapshot.state) ||
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 0 ||
    !Number.isSafeInteger(snapshot.lastSafeReleasedSequence) ||
    snapshot.lastSafeReleasedSequence < -1
  ) {
    throw invalidStateRequest("invalid_lifecycle_snapshot");
  }
  const bindingValues = [
    snapshot.eligibilityRecordHash,
    snapshot.publicationCommitmentHash,
    snapshot.sourceRunId,
    snapshot.sourceReplaySha256,
  ];
  const hasBinding = bindingValues.some((value) => value !== null);
  const hasCompleteBinding =
    isSha256Hex(snapshot.eligibilityRecordHash) &&
    isSha256Hex(snapshot.publicationCommitmentHash) &&
    typeof snapshot.sourceRunId === "string" &&
    snapshot.sourceRunId.length > 0 &&
    isSha256Hex(snapshot.sourceReplaySha256);
  if (
    (hasBinding && !hasCompleteBinding) ||
    (!hasBinding && bindingValues.some((value) => value !== null))
  ) {
    throw invalidStateRequest("invalid_lifecycle_publication_binding");
  }
  const createdAt = assertCanonicalTimestamp(snapshot.createdAt, "createdAt");
  const updatedAt = assertCanonicalTimestamp(snapshot.updatedAt, "updatedAt");
  if (createdAt > updatedAt) {
    throw invalidStateRequest("non_monotonic_lifecycle_time");
  }
  const failureReasons: readonly PremiereTerminalReasonCode[] = [
    "integrity_failure",
    "outage_exceeded",
    "runtime_failure",
  ];
  const cancellationReasons: readonly PremiereTerminalReasonCode[] = [
    "cancelled_by_operator",
    "source_ineligible",
  ];
  const validTerminalReasons = [...failureReasons, ...cancellationReasons];
  if (
    (snapshot.terminalReasonCode !== null &&
      !validTerminalReasons.includes(snapshot.terminalReasonCode)) ||
    (snapshot.state === "draft" &&
      (snapshot.version !== 0 ||
        hasBinding ||
        snapshot.lastSafeReleasedSequence !== -1 ||
        snapshot.terminalReasonCode !== null)) ||
    (snapshot.state === "scheduled" &&
      (!hasCompleteBinding ||
        snapshot.lastSafeReleasedSequence !== -1 ||
        snapshot.terminalReasonCode !== null)) ||
    ((snapshot.state === "playing" ||
      snapshot.state === "checkpoint" ||
      snapshot.state === "revealed" ||
      snapshot.state === "failed") &&
      !hasCompleteBinding) ||
    (snapshot.state === "revealed" &&
      (snapshot.lastSafeReleasedSequence < 0 ||
        snapshot.terminalReasonCode !== null)) ||
    (snapshot.state === "failed" &&
      (snapshot.terminalReasonCode === null ||
        !failureReasons.includes(snapshot.terminalReasonCode))) ||
    (snapshot.state === "cancelled" &&
      (snapshot.lastSafeReleasedSequence !== -1 ||
        snapshot.terminalReasonCode === null ||
        !cancellationReasons.includes(snapshot.terminalReasonCode) ||
        (snapshot.terminalReasonCode === "source_ineligible" && hasBinding))) ||
    ((snapshot.state === "playing" || snapshot.state === "checkpoint") &&
      snapshot.terminalReasonCode !== null) ||
    (snapshot.state === "archived" &&
      !isValidArchivedSemantics({
        hasBinding,
        hasCompleteBinding,
        lastSafeReleasedSequence: snapshot.lastSafeReleasedSequence,
        terminalReasonCode: snapshot.terminalReasonCode,
        failureReasons,
      }))
  ) {
    throw invalidStateRequest("invalid_lifecycle_state_semantics");
  }
}

function isValidArchivedSemantics(options: {
  hasBinding: boolean;
  hasCompleteBinding: boolean;
  lastSafeReleasedSequence: number;
  terminalReasonCode: PremiereTerminalReasonCode | null;
  failureReasons: readonly PremiereTerminalReasonCode[];
}): boolean {
  if (options.terminalReasonCode === null) {
    return options.hasCompleteBinding && options.lastSafeReleasedSequence >= 0;
  }
  if (options.failureReasons.includes(options.terminalReasonCode)) {
    return options.hasCompleteBinding;
  }
  if (options.terminalReasonCode === "source_ineligible") {
    return !options.hasBinding && options.lastSafeReleasedSequence === -1;
  }
  if (options.terminalReasonCode === "cancelled_by_operator") {
    return (
      (!options.hasBinding || options.hasCompleteBinding) &&
      options.lastSafeReleasedSequence === -1
    );
  }
  return false;
}

export function assertValidPremiereLifecycleSnapshot(
  snapshot: PremiereLifecycleSnapshot,
): void {
  validateLifecycleSnapshot(snapshot);
}

function revealGateFailure(): ReplayPremiereError {
  return new ReplayPremiereError(
    "reveal_gate_verification_failed",
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    "Replay premiere reveal material failed locked-state verification",
  );
}

function assertCanonicalTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw invalidStateRequest(`invalid_${field}_timestamp`);
  }
  return parsed;
}

function invalidStateRequest(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    409,
    `Replay premiere state request rejected: ${operatorCode}`,
  );
}
