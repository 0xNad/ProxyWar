import {
  assessmentOptionsFromAdmission,
  DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS,
  readAdmissionVerifiedSource,
  ReplayPremiereAdmissionCatalog,
  type ReplayPremiereAdmissionRecordV1,
  type ReplayPremiereCatalogLimits,
} from "./ReplayPremiereCatalog";
import type { ReplayPremiereCheckpointProjector } from "./ReplayPremiereCheckpointProjection";
import { buildPremiereChunks } from "./ReplayPremiereChunks";
import type {
  PremiereChunkDraft,
  PremiereState,
} from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import {
  ReplayPremiereEventStore,
  type ReplayPremiereEventStoreLimits,
  type StoredReplayPremiereEvent,
} from "./ReplayPremiereEventStore";
import type { ReplayPremiereGuestSecurity } from "./ReplayPremiereGuestSecurity";
import {
  ReplayPremiereHttpRegistry,
  type ReplayPremiereHttpTarget,
} from "./ReplayPremiereHttp";
import {
  assertReplayPremiereJsonValue,
  hashReplayPremiereJson,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import {
  hashReplayPremiereCheckpointSchedule,
  loadReplayPremiereInteractions,
} from "./ReplayPremiereInteractionRecovery";
import type {
  ReplayPremiereInteractionLimits,
  ReplayPremiereReleasedContext,
} from "./ReplayPremiereInteractions";
import { verifyStoredReplayPremiereLeakAuditReceipt } from "./ReplayPremiereLeakAuditCollector";
import {
  importControlledPremiereSourceForPublication,
  VerifiedPremiereEligibilityGate,
} from "./ReplayPremierePublication";
import { REPLAY_PREMIERE_V1_MAX_REVEAL_STORED_EVENT_BYTES } from "./ReplayPremiereRevealEnvelopeCapacity";
import {
  ReplayPremiereRuntimeCoordinator,
  ReplayPremiereRuntimeRegistry,
  type ReplayPremiereRuntimeClock,
} from "./ReplayPremiereRuntimeCoordinator";

const DEFAULT_STARTUP_DEADLINE_MS = 10_000;
const MAX_STARTUP_DEADLINE_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RUNTIME_RETRY_BASE_MS = 1_000;
const RUNTIME_RETRY_MAX_MS = 60_000;
const MAX_RUNTIME_REPORTS_PER_INCIDENT = 4;
const MAX_DIAGNOSTIC_TARGET_BYTES = 160;
const SAFE_DIAGNOSTIC_TARGET = /^[A-Za-z0-9._:-]+$/;

export const DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS: ReplayPremiereEventStoreLimits =
  Object.freeze({
    maxEventBytes: REPLAY_PREMIERE_V1_MAX_REVEAL_STORED_EVENT_BYTES,
    maxAggregateEventBytes: 64 * 1024 * 1024,
    maxEventLogBytes: 128 * 1024 * 1024,
    maxSnapshotBytes: 16 * 1024 * 1024,
    maxPrivateStateBytes: 256 * 1024 * 1024,
  });

export interface ReplayPremiereStartupDiagnostic {
  target: string;
  premiereId: string | null;
  operatorCode: string;
}

export interface ReplayPremiereProductionStartupOptions {
  privateStateRoot: string;
  servedRoots: readonly string[];
  publicOrigin: string;
  security: ReplayPremiereGuestSecurity;
  httpRegistry: ReplayPremiereHttpRegistry;
  runtimeRegistry: ReplayPremiereRuntimeRegistry;
  checkpointProjector: ReplayPremiereCheckpointProjector;
  catalogLimits?: ReplayPremiereCatalogLimits;
  eventStoreLimits?: ReplayPremiereEventStoreLimits;
  interactionLimits?: Partial<ReplayPremiereInteractionLimits>;
  clock?: ReplayPremiereRuntimeClock;
  maxStartupMs?: number;
  onDiagnostic?: (diagnostic: ReplayPremiereStartupDiagnostic) => void;
  /** Bounded test/host barrier; abort is asserted again before journal writes. */
  beforeTargetRecovery?: (options: {
    record: ReplayPremiereAdmissionRecordV1;
    signal: AbortSignal;
  }) => Promise<void>;
}

export interface ReplayPremiereProductionStartupResult {
  service: ReplayPremiereProductionService;
  registeredPremiereIds: readonly string[];
  diagnostics: readonly ReplayPremiereStartupDiagnostic[];
}

interface AssembledPremiereTarget {
  runtime: ReplayPremiereRuntimeCoordinator;
  target: ReplayPremiereHttpTarget;
}

interface RecoveryProjection {
  state: PremiereState;
  releasedThroughSequence: number;
}

interface ReplayPremiereStartupOperationFence {
  signal: AbortSignal;
  enterNonAbortableCommit(): void;
}

/**
 * Owns the journal writer plus authoritative timers. The catalog lock is only
 * held while startup snapshots the admission set, so operators can admit the
 * next target while the current runtimes remain live. Closing never removes
 * retained evidence.
 */
export class ReplayPremiereProductionService {
  private readonly supervisor: ReplayPremiereRuntimeSupervisor;
  private readonly pendingAssemblies: Set<Promise<unknown>>;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly eventStore: ReplayPremiereEventStore,
    private readonly httpRegistry: ReplayPremiereHttpRegistry,
    private readonly runtimeRegistry: ReplayPremiereRuntimeRegistry,
    private readonly ownedTargets: AssembledPremiereTarget[],
    supervisor: ReplayPremiereRuntimeSupervisor,
    pendingAssemblies: Set<Promise<unknown>>,
  ) {
    this.supervisor = supervisor;
    this.pendingAssemblies = pendingAssemblies;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    await this.supervisor.close();
    await Promise.allSettled([...this.pendingAssemblies]);
    for (const assembled of [...this.ownedTargets].reverse()) {
      this.httpRegistry.unregister(assembled.target);
      this.runtimeRegistry.unregister(assembled.runtime);
    }
    this.ownedTargets.length = 0;
    await this.eventStore.close();
  }

  readActiveTimerCount(): number {
    return this.supervisor.activeTimerCount();
  }

  async waitForRuntimeTimersIdle(): Promise<void> {
    await this.supervisor.waitForIdle();
  }
}

/**
 * Production reconstruction boundary. Catalog corruption is quarantined per
 * target; root/lock/journal corruption aborts startup because it is shared.
 */
export async function startReplayPremiereProduction(
  options: ReplayPremiereProductionStartupOptions,
): Promise<ReplayPremiereProductionStartupResult> {
  const maxStartupMs = boundedStartupDeadline(options.maxStartupMs);
  const startedAt = Date.now();
  const clock = options.clock ?? { now: () => new Date() };
  const publicOrigin = exactPublicOrigin(options.publicOrigin);
  if (options.security.expectedOrigin !== publicOrigin) {
    throw startupIntegrity("startup_security_origin_mismatch");
  }
  if (typeof options.httpRegistry.admitAnonymousWrite !== "function") {
    throw startupIntegrity("startup_http_admission_unavailable");
  }
  const diagnostics: ReplayPremiereStartupDiagnostic[] = [];
  const sanitizeDiagnostic = (
    diagnostic: ReplayPremiereStartupDiagnostic,
  ): ReplayPremiereStartupDiagnostic =>
    Object.freeze({
      ...diagnostic,
      target: startupDiagnosticTarget(diagnostic.target),
    });
  const emitDiagnostic = (
    diagnostic: ReplayPremiereStartupDiagnostic,
  ): void => {
    try {
      options.onDiagnostic?.(diagnostic);
    } catch {
      // Operator diagnostics are non-authoritative.
    }
  };
  const report = (diagnostic: ReplayPremiereStartupDiagnostic): void => {
    const sanitized = sanitizeDiagnostic(diagnostic);
    diagnostics.push(sanitized);
    emitDiagnostic(sanitized);
  };
  const reportRuntime = (diagnostic: ReplayPremiereStartupDiagnostic): void =>
    emitDiagnostic(sanitizeDiagnostic(diagnostic));
  const catalogLimits =
    options.catalogLimits ?? DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS;
  const eventStoreLimits =
    options.eventStoreLimits ?? DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS;
  const catalog = await ReplayPremiereAdmissionCatalog.open({
    privateStateRoot: options.privateStateRoot,
    servedRoots: options.servedRoots,
    limits: catalogLimits,
  });
  let eventStore: ReplayPremiereEventStore | null = null;
  try {
    eventStore = await ReplayPremiereEventStore.open({
      privateStateRoot: options.privateStateRoot,
      servedRoots: options.servedRoots,
      limits: eventStoreLimits,
      now: () => clock.now(),
    });
    const activeEventStore = eventStore;
    const read = await catalog.readAll();
    await catalog.close();
    const supervisor = new ReplayPremiereRuntimeSupervisor(
      clock,
      reportRuntime,
    );
    const pendingAssemblies = new Set<Promise<unknown>>();
    const ownedTargets: AssembledPremiereTarget[] = [];
    const service = new ReplayPremiereProductionService(
      eventStore,
      options.httpRegistry,
      options.runtimeRegistry,
      ownedTargets,
      supervisor,
      pendingAssemblies,
    );
    for (const failure of read.failures) {
      report({
        target: failure.target,
        premiereId: premiereIdFromCatalogTarget(failure.target),
        operatorCode: failure.operatorCode,
      });
    }
    const registered: string[] = [];
    for (let index = 0; index < read.entries.length; index += 1) {
      const record = read.entries[index];
      const remainingMs = maxStartupMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        reportDeadlineForRemainder(read.entries, index, report);
        break;
      }
      const deadline = await assembleBeforeDeadline({
        operation: async (fence) => {
          await options.beforeTargetRecovery?.({
            record,
            signal: fence.signal,
          });
          assertStartupActive(fence.signal);
          return assemblePremiereTarget({
            record,
            privateStateRoot: catalog.privateStateRoot,
            servedRoots: options.servedRoots,
            maxSourceBytes: catalogLimits.maxSourceBytes,
            publicOrigin,
            security: options.security,
            httpRegistry: options.httpRegistry,
            eventStore: activeEventStore,
            eventStoreLimits,
            clock,
            checkpointProjector: options.checkpointProjector,
            interactionLimits: options.interactionLimits,
            fence,
          });
        },
        remainingMs,
        pendingAssemblies,
      });
      if (deadline.status === "timed_out") {
        report({
          target: `${record.premiereId}.admission.json`,
          premiereId: record.premiereId,
          operatorCode: "startup_deadline_exceeded",
        });
        reportDeadlineForRemainder(read.entries, index + 1, report);
        break;
      }
      if (deadline.status === "rejected") {
        report({
          target: `${record.premiereId}.admission.json`,
          premiereId: record.premiereId,
          operatorCode: operatorCode(deadline.error),
        });
        continue;
      }
      const assembled = deadline.value;
      if (Date.now() - startedAt > maxStartupMs) {
        report({
          target: `${record.premiereId}.admission.json`,
          premiereId: record.premiereId,
          operatorCode: "startup_deadline_exceeded",
        });
        reportDeadlineForRemainder(read.entries, index + 1, report);
        break;
      }
      try {
        registerTargetAtomically(
          options.runtimeRegistry,
          options.httpRegistry,
          assembled,
          () => supervisor.add(assembled.runtime),
        );
        ownedTargets.push(assembled);
        registered.push(record.premiereId);
      } catch (error) {
        report({
          target: `${record.premiereId}.admission.json`,
          premiereId: record.premiereId,
          operatorCode: operatorCode(error),
        });
      }
    }
    return {
      service,
      registeredPremiereIds: Object.freeze([...registered]),
      diagnostics: Object.freeze([...diagnostics]),
    };
  } catch (error) {
    await eventStore?.close().catch(() => undefined);
    await catalog.close().catch(() => undefined);
    throw error;
  }
}

async function assemblePremiereTarget(options: {
  record: ReplayPremiereAdmissionRecordV1;
  privateStateRoot: string;
  servedRoots: readonly string[];
  maxSourceBytes: number;
  publicOrigin: string;
  security: ReplayPremiereGuestSecurity;
  httpRegistry: ReplayPremiereHttpRegistry;
  eventStore: ReplayPremiereEventStore;
  eventStoreLimits: ReplayPremiereEventStoreLimits;
  clock: ReplayPremiereRuntimeClock;
  checkpointProjector: ReplayPremiereCheckpointProjector;
  interactionLimits?: Partial<ReplayPremiereInteractionLimits>;
  fence: ReplayPremiereStartupOperationFence;
}): Promise<AssembledPremiereTarget> {
  assertStartupActive(options.fence.signal);
  const assessmentOptions = assessmentOptionsFromAdmission(
    options.record.assessment,
  );
  const receipt = verifyStoredReplayPremiereLeakAuditReceipt({
    material: options.record.leakAuditReceipt,
    assessmentOptions,
  });
  assertProductionLeakAuditOrigin(options.record, options.publicOrigin);
  const verifiedSource = await readAdmissionVerifiedSource({
    record: options.record,
    privateStateRoot: options.privateStateRoot,
    servedRoots: options.servedRoots,
    maxSourceBytes: options.maxSourceBytes,
  });
  assertStartupActive(options.fence.signal);
  const resultBytes = Buffer.from(
    options.record.authoritativeResult.bytes,
    "base64",
  );
  if (
    sha256Hex(resultBytes) !== options.record.authoritativeResult.sha256 ||
    options.record.authoritativeResult.sourceId !==
      options.record.eligibilityRecord.authoritativeResult.sourceId
  ) {
    throw startupIntegrity("startup_authoritative_result_binding_mismatch");
  }
  const imported = importControlledPremiereSourceForPublication({
    sourceBytes: verifiedSource.copyBytes(),
    eligibilityRecord: options.record.eligibilityRecord,
    authoritativeResultBytes: resultBytes,
    replayImportLimits: options.record.replayImportLimits,
  });
  const drafts = buildPremiereChunks({
    premiereId: options.record.premiereId,
    records: imported.records,
    playbackRate: options.record.publicDefinition.playbackRate,
    checkpointSequences: options.record.publicDefinition.checkpoints.map(
      (checkpoint) => checkpoint.sequence,
    ),
    ...options.record.chunkBuildLimits,
  });
  const gate = VerifiedPremiereEligibilityGate.verify({
    premiereId: options.record.premiereId,
    eligibilityRecord: options.record.eligibilityRecord,
    eligibilityOptions: assessmentOptions,
    leakAuditReceipt: receipt,
    verifiedSource,
    authoritativeResultBytes: resultBytes,
    replayImportLimits: options.record.replayImportLimits,
    publicDefinition: options.record.publicDefinition,
    draftChunks: drafts,
    maxPresentationSpanMs:
      options.record.chunkBuildLimits.maxPresentationSpanMs,
  });
  const commitment = gate.publicationCommitment();
  if (
    gate.eligibilityRecordHash !==
      options.record.expectedEligibilityRecordHash ||
    gate.publicationCommitmentHash !==
      options.record.expectedPublicationCommitmentHash ||
    commitment.orderedDraftManifestRoot !==
      options.record.expectedOrderedDraftManifestRoot
  ) {
    throw startupIntegrity("startup_publication_commitment_mismatch");
  }
  if (
    gate.requiredRevealEventBytes > options.eventStoreLimits.maxEventBytes ||
    gate.requiredRevealEventBytes > options.eventStoreLimits.maxSnapshotBytes
  ) {
    throw startupCapacity("startup_reveal_capacity_incompatible");
  }
  assertStartupActive(options.fence.signal);
  const checkpointProjection = await options.checkpointProjector.project({
    gate,
    drafts,
    signal: options.fence.signal,
  });
  assertStartupActive(options.fence.signal);

  const projection = recoveryProjection(
    options.eventStore.recovered.events,
    options.record.premiereId,
  );
  let runtime: ReplayPremiereRuntimeCoordinator | null = null;
  const recoveredInteractions = await loadReplayPremiereInteractions({
    eventStore: options.eventStore,
    interactions: {
      premiereId: options.record.premiereId,
      checkpointDescriptors: options.record.publicDefinition.checkpoints,
      seats: options.record.eligibilityRecord.seats.map((seat) => ({
        seatId: seat.seatId,
        policyIdentity: seat.policyIdentity,
      })),
      getPremiereState: () => runtime?.readLifecycleState() ?? projection.state,
      getReleasedContext: (sequence) =>
        runtime?.readReleasedContext(sequence) ??
        releasedContextFromDrafts(
          drafts,
          projection.releasedThroughSequence,
          sequence,
        ),
      signAttribution: (value) => options.security.signShareAttribution(value),
      canonicalPremiereUrl: `${options.publicOrigin}/premiere/${options.record.premiereId}`,
      now: () => options.clock.now(),
      limits: options.interactionLimits,
      admitAnonymousWrite: options.httpRegistry.admitAnonymousWrite,
    },
  });
  assertStartupActive(options.fence.signal);
  options.fence.enterNonAbortableCommit();
  runtime = await ReplayPremiereRuntimeCoordinator.createOrRecover({
    gate,
    drafts,
    checkpointProjection,
    persistence: options.eventStore,
    clock: options.clock,
    interactions: recoveredInteractions.interactions,
  });
  await runtime.synchronize();
  const journalAnchor = recoveredInteractions.persistence.recoveryAnchor();
  const interactionState = recoveredInteractions.interactions.readState();
  if (
    journalAnchor.eventCursor !==
      options.eventStore.recovered.lastEventSequence ||
    journalAnchor.stateHash !==
      hashReplayPremiereJson(asJson(interactionState)) ||
    hashReplayPremiereCheckpointSchedule(journalAnchor.snapshot.checkpoints) !==
      hashReplayPremiereCheckpointSchedule(interactionState.checkpoints)
  ) {
    throw startupIntegrity("startup_interaction_journal_anchor_mismatch");
  }
  return {
    runtime,
    target: {
      runtime,
      interactions: recoveredInteractions.interactions,
    },
  };
}

function registerTargetAtomically(
  runtimeRegistry: ReplayPremiereRuntimeRegistry,
  httpRegistry: ReplayPremiereHttpRegistry,
  assembled: AssembledPremiereTarget,
  afterRegistration: () => void,
): void {
  let runtimeRegistered = false;
  let httpRegistered = false;
  try {
    runtimeRegistry.register(assembled.runtime);
    runtimeRegistered = true;
    httpRegistry.register(assembled.target);
    httpRegistered = true;
    afterRegistration();
  } catch (error) {
    if (httpRegistered) httpRegistry.unregister(assembled.target);
    if (runtimeRegistered) runtimeRegistry.unregister(assembled.runtime);
    throw error;
  }
}

class ReplayPremiereRuntimeSupervisor {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly failures = new Map<
    string,
    {
      consecutiveFailures: number;
      reportedOperatorCodes: Set<string>;
    }
  >();
  private closed = false;

  constructor(
    private readonly clock: ReplayPremiereRuntimeClock,
    private readonly report: (
      diagnostic: ReplayPremiereStartupDiagnostic,
    ) => void,
  ) {}

  add(runtime: ReplayPremiereRuntimeCoordinator): void {
    if (this.closed) throw startupUnavailable("runtime_supervisor_closed");
    this.arm(runtime, runtime.nextWakeAt());
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.waitForIdle();
    this.failures.clear();
  }

  activeTimerCount(): number {
    return this.timers.size;
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private arm(
    runtime: ReplayPremiereRuntimeCoordinator,
    nextWakeAt: string | null,
  ): void {
    const previous = this.timers.get(runtime.premiereId);
    if (previous !== undefined) clearTimeout(previous);
    this.timers.delete(runtime.premiereId);
    if (this.closed || nextWakeAt === null) return;
    const delay = Math.max(
      0,
      Math.min(
        MAX_TIMER_DELAY_MS,
        Date.parse(nextWakeAt) - this.clock.now().getTime(),
      ),
    );
    const timer = setTimeout(() => {
      this.timers.delete(runtime.premiereId);
      const operation = runtime
        .synchronize()
        .then((advance) => {
          this.failures.delete(runtime.premiereId);
          this.arm(runtime, advance.nextWakeAt);
        })
        .catch((error: unknown) => {
          const failure = this.recordFailure(runtime.premiereId, error);
          if (!this.closed) {
            const retryAt = new Date(
              this.clock.now().getTime() +
                runtimeRetryDelay(failure.consecutiveFailures),
            ).toISOString();
            this.arm(runtime, retryAt);
          }
        })
        .finally(() => this.inFlight.delete(operation));
      this.inFlight.add(operation);
    }, delay);
    timer.unref?.();
    this.timers.set(runtime.premiereId, timer);
  }

  private recordFailure(
    premiereId: string,
    error: unknown,
  ): { consecutiveFailures: number } {
    const failure = this.failures.get(premiereId) ?? {
      consecutiveFailures: 0,
      reportedOperatorCodes: new Set<string>(),
    };
    failure.consecutiveFailures = Math.min(failure.consecutiveFailures + 1, 31);
    const code = operatorCode(error);
    if (
      failure.reportedOperatorCodes.size < MAX_RUNTIME_REPORTS_PER_INCIDENT &&
      !failure.reportedOperatorCodes.has(code)
    ) {
      failure.reportedOperatorCodes.add(code);
      this.report({
        target: `${premiereId}.runtime`,
        premiereId,
        operatorCode: code,
      });
    }
    this.failures.set(premiereId, failure);
    return failure;
  }
}

function runtimeRetryDelay(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 30);
  return Math.min(RUNTIME_RETRY_MAX_MS, RUNTIME_RETRY_BASE_MS * 2 ** exponent);
}

async function assembleBeforeDeadline<T>(options: {
  operation: (fence: ReplayPremiereStartupOperationFence) => Promise<T>;
  remainingMs: number;
  pendingAssemblies: Set<Promise<unknown>>;
}): Promise<
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "timed_out" }
> {
  const controller = new AbortController();
  const deadlineAt = Date.now() + options.remainingMs;
  let nonAbortableCommitStarted = false;
  const fence: ReplayPremiereStartupOperationFence = {
    signal: controller.signal,
    enterNonAbortableCommit: () => {
      if (controller.signal.aborted || Date.now() >= deadlineAt) {
        throw startupUnavailable("startup_recovery_aborted");
      }
      nonAbortableCommitStarted = true;
    },
  };
  const tracked = options.operation(fence).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  options.pendingAssemblies.add(tracked);
  void tracked.finally(() => options.pendingAssemblies.delete(tracked));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: "timed_out" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: "timed_out" });
    }, options.remainingMs);
  });
  try {
    const result = await Promise.race([tracked, timeout]);
    if (result.status === "timed_out" && nonAbortableCommitStarted) {
      // EventStore writes are deliberately non-abortable once entered. Do not
      // return a timeout while an append/snapshot can still become durable.
      await tracked;
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function assertStartupActive(signal: AbortSignal): void {
  if (signal.aborted) throw startupUnavailable("startup_recovery_aborted");
}

function recoveryProjection(
  events: readonly StoredReplayPremiereEvent[],
  premiereId: string,
): RecoveryProjection {
  const latest = events
    .filter((event) => event.aggregateId === premiereId)
    .at(-1);
  if (latest === undefined)
    return { state: "scheduled", releasedThroughSequence: -1 };
  if (!isRecord(latest.payload) || !isRecord(latest.payload.lifecycle)) {
    throw startupIntegrity("startup_runtime_projection_missing_lifecycle");
  }
  const state = latest.payload.lifecycle.state;
  const releasedThroughSequence =
    latest.payload.lifecycle.lastSafeReleasedSequence;
  if (
    !isPremiereState(state) ||
    !Number.isSafeInteger(releasedThroughSequence) ||
    Number(releasedThroughSequence) < -1
  ) {
    throw startupIntegrity("startup_runtime_projection_invalid");
  }
  return { state, releasedThroughSequence: Number(releasedThroughSequence) };
}

function releasedContextFromDrafts(
  drafts: readonly PremiereChunkDraft[],
  releasedThroughSequence: number,
  sequence: number,
): ReplayPremiereReleasedContext | null {
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    sequence > releasedThroughSequence
  ) {
    return null;
  }
  for (const draft of drafts) {
    const record = draft.payload.records.find(
      (candidate) => candidate.sequence === sequence,
    );
    if (record !== undefined) {
      return {
        releasedThroughSequence,
        turn: record.turn,
        eventContext: record.payload,
      };
    }
  }
  throw startupIntegrity("startup_released_sequence_missing_from_drafts");
}

function reportDeadlineForRemainder(
  entries: readonly ReplayPremiereAdmissionRecordV1[],
  startIndex: number,
  report: (diagnostic: ReplayPremiereStartupDiagnostic) => void,
): void {
  for (let index = startIndex; index < entries.length; index += 1) {
    report({
      target: `${entries[index].premiereId}.admission.json`,
      premiereId: entries[index].premiereId,
      operatorCode: "startup_deadline_exceeded",
    });
  }
}

function boundedStartupDeadline(value: number | undefined): number {
  const deadline = value ?? DEFAULT_STARTUP_DEADLINE_MS;
  if (
    !Number.isSafeInteger(deadline) ||
    deadline < 1 ||
    deadline > MAX_STARTUP_DEADLINE_MS
  ) {
    throw startupUnavailable("invalid_startup_deadline");
  }
  return deadline;
}

function exactPublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw startupUnavailable("invalid_startup_public_origin", error);
  }
  if (
    url.origin !== value ||
    (url.protocol !== "http:" && url.protocol !== "https:")
  ) {
    throw startupUnavailable("invalid_startup_public_origin");
  }
  return value;
}

function assertProductionLeakAuditOrigin(
  record: ReplayPremiereAdmissionRecordV1,
  publicOrigin: string,
): void {
  const targetUrls = [
    ...record.leakAuditReceipt.manifest.targets.map((target) => target.target),
    ...record.leakAuditReceipt.evidence.map((evidence) => evidence.target),
    ...record.eligibilityRecord.proxyWarLeakAuditManifest.targets.map(
      (target) => target.target,
    ),
    ...record.eligibilityRecord.proxyWarLeakChecks.map(
      (evidence) => evidence.target,
    ),
  ];
  for (const targetUrl of targetUrls) {
    let target: URL;
    try {
      target = new URL(targetUrl);
    } catch (error) {
      throw startupIntegrity("startup_leak_audit_origin_mismatch", error);
    }
    if (target.origin !== publicOrigin) {
      throw startupIntegrity("startup_leak_audit_origin_mismatch");
    }
  }
}

function startupDiagnosticTarget(target: string): string {
  if (
    Buffer.byteLength(target, "utf8") <= MAX_DIAGNOSTIC_TARGET_BYTES &&
    SAFE_DIAGNOSTIC_TARGET.test(target)
  ) {
    return target;
  }
  return `startup_target_${sha256Hex(Buffer.from(target, "utf8"))}`;
}

function premiereIdFromCatalogTarget(target: string): string | null {
  const suffix = ".admission.json";
  if (!target.endsWith(suffix)) return null;
  const candidate = target.slice(0, -suffix.length);
  return /^prem_[a-z0-9]{16,32}$/.test(candidate) ? candidate : null;
}

function isPremiereState(value: unknown): value is PremiereState {
  return [
    "draft",
    "scheduled",
    "playing",
    "checkpoint",
    "revealed",
    "failed",
    "cancelled",
    "archived",
  ].includes(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asJson(value: unknown): ReplayPremiereJsonValue {
  assertReplayPremiereJsonValue(value, "replay premiere startup JSON");
  return value as ReplayPremiereJsonValue;
}

function operatorCode(error: unknown): string {
  return error instanceof ReplayPremiereError
    ? error.operatorCode
    : "startup_target_recovery_failed";
}

function startupIntegrity(
  operatorCodeValue: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCodeValue,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    "Replay Premiere startup target failed integrity validation",
    cause === undefined ? undefined : { cause },
  );
}

function startupCapacity(operatorCodeValue: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCodeValue,
    "PREMIERE_CAPACITY_EXCEEDED",
    413,
    "Replay Premiere startup capacity is incompatible with the admitted target",
  );
}

function startupUnavailable(
  operatorCodeValue: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCodeValue,
    "PREMIERE_UNAVAILABLE",
    503,
    "Replay Premiere production startup is unavailable",
    cause === undefined ? undefined : { cause },
  );
}
