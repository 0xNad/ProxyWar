import type { ReplayPremiereArchiveStore } from "./ReplayPremiereArchiveIndex";
import {
  DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS,
  ReplayPremiereAdmissionCatalog,
  type ReplayPremiereAdmissionRecordV1,
  type ReplayPremiereCatalogLimits,
  type ReplayPremiereCatalogReadResult,
} from "./ReplayPremiereCatalog";
import type { ReplayPremiereCheckpointProjector } from "./ReplayPremiereCheckpointProjection";
import { rebuildReplayPremiereProjectionInput } from "./ReplayPremiereCheckpointProjectionStore";
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
  isSha256Hex,
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
import {
  compactReplayPremiereEventJournal,
  reclaimUnreferencedPremiereSources,
} from "./ReplayPremiereJournalCompaction";
import { REPLAY_PREMIERE_V1_MAX_REVEAL_STORED_EVENT_BYTES } from "./ReplayPremiereRevealEnvelopeCapacity";
import {
  isReplayPremiereOutageStartIdempotencyKey,
  ReplayPremiereRuntimeCoordinator,
  ReplayPremiereRuntimeRegistry,
  type ReplayPremiereOutageReason,
  type ReplayPremiereRuntimeClock,
} from "./ReplayPremiereRuntimeCoordinator";
import {
  assertValidPremiereLifecycleSnapshot,
  type PremiereLifecycleSnapshot,
} from "./ReplayPremiereStateMachine";
import {
  DEFAULT_REPLAY_PREMIERE_RECLAMATION_GRACE_MS,
  ReplayPremiereTerminalReclaimer,
  type ReplayPremiereOrphanCandidate,
} from "./ReplayPremiereTerminalReclamation";

const DEFAULT_RECLAMATION_SWEEP_MS = 60_000;
const MAX_RECLAMATION_SWEEP_MS = 3_600_000;
/** Per-orphan bounded retry budget for transient reclamation failures. */
const MAX_ORPHAN_RECLAMATION_ATTEMPTS = 3;

const DEFAULT_STARTUP_DEADLINE_MS = 10_000;
const MAX_STARTUP_DEADLINE_MS = 10_000;
/**
 * DEFERRED FRESH-ADMISSION ASSEMBLY (2026-07-22 activation zombie, rounds
 * 644/646): the shared `maxStartupMs` boot budget (8s in production) cannot
 * assemble every legitimate premiere — a 32,300-turn World target measurably
 * exceeds it — and a fresh admission that misses the budget was previously
 * unreachable forever in that process (`startup_deadline_exceeded` at every
 * boot) while the premiere loop zombie-tracked it. A deadline-missed critical
 * plan whose admission is FRESH (hash-covered `admittedAt` within the window
 * below) now gets exactly ONE bounded background assembly after startup
 * returns; on success it registers through the normal atomic path.
 *
 * This deliberately does NOT resurrect the rejected "startDeferredHydration"
 * design: stale/terminal backlog (e.g. prem_live20260721aaan) is never
 * hydrated — freshness is keyed exclusively on the admission record's own
 * `admittedAt`, so a stale premiere can never self-activate after a restart —
 * and the boot path itself stays bounded exactly as before. The default
 * budget stays under the premiere loop's 120s activation-verify window so the
 * loop observes the registration (or its absence) before firing its single
 * re-activation restart.
 */
export const DEFAULT_DEFERRED_FRESH_ASSEMBLY_BUDGET_MS = 90_000;
const MAX_DEFERRED_FRESH_ASSEMBLY_BUDGET_MS = 300_000;
const DEFAULT_FRESH_ADMISSION_WINDOW_MS = 600_000;
const MAX_FRESH_ADMISSION_WINDOW_MS = 3_600_000;
/** Tolerated forward clock skew between the admitting process and this one. */
const MAX_FUTURE_ADMISSION_SKEW_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RUNTIME_RETRY_BASE_MS = 1_000;
const RUNTIME_RETRY_MAX_MS = 60_000;
const MAX_RUNTIME_REPORTS_PER_INCIDENT = 4;
const MAX_DIAGNOSTIC_TARGET_BYTES = 160;
const SAFE_DIAGNOSTIC_TARGET = /^[A-Za-z0-9._:-]+$/;
/**
 * A controlled drill must remain externally unavailable past the observed
 * ~45.1s runtime wake cadence. Holding for 46s after every durable outage
 * begin leaves roughly 6s for clean exit plus the production startup budget
 * before the coordinator's strict 60s recoverable-outage ceiling.
 */
export const REPLAY_PREMIERE_CONTROLLED_OUTAGE_DRILL_HOLD_MS = 46_000;
const RUNTIME_PROJECTION_EVENT_TYPES = new Set([
  "premiere_runtime_initialized",
  "premiere_runtime_started",
  "premiere_runtime_chunk_released",
  "premiere_runtime_checkpoint_resumed",
  "premiere_runtime_outage_started",
  "premiere_runtime_outage_recovered",
  "premiere_runtime_failed",
  "premiere_runtime_cancelled",
  "premiere_runtime_terminal_archived",
]);
const RUNTIME_PROJECTION_KEYS = [
  "schemaVersion",
  "runtimeKind",
  "premiereId",
  "publicationCommitmentHash",
  "lifecycle",
  "actualStartAt",
  "scheduleShiftMs",
  "accumulatedPauseMs",
  "activeCheckpoint",
  "completedCheckpointIds",
  "outageStartedAt",
  "lastObservedAt",
  "nextDraftIndex",
  "releasedChunks",
  "interactionCheckpoints",
] as const;
const REVEAL_PROJECTION_KEYS = [
  "schemaVersion",
  "commitKind",
  "publicationCommitmentHash",
  "lifecycle",
  "transitionAuditEvent",
  "releasedPrefixChunkCount",
  "releasedPrefixLastChunkHash",
  "terminalChunk",
  "reveal",
] as const;
const ARCHIVE_PROJECTION_KEYS = [
  "schemaVersion",
  "runtimeKind",
  "premiereId",
  "publicationCommitmentHash",
  "revealCommitHash",
  "lifecycle",
] as const;

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
  /**
   * Wall-clock budget for the single deferred background assembly a
   * deadline-missed FRESH admission receives after startup returns. `0`
   * disables deferral entirely. Defaults to 90s — deliberately below the
   * premiere loop's 120s activation-verify window.
   */
  deferredFreshAssemblyBudgetMs?: number;
  /** How recent a record's `admittedAt` must be to qualify for deferral. */
  freshAdmissionWindowMs?: number;
  /**
   * When provided, terminal premieres are reclaimed (durable summary + pointer,
   * then bulk deletion) after a grace window, and fully-reclaimed premieres are
   * compacted out of the shared event journal at startup. Omit to disable the
   * terminal-premiere lifecycle entirely.
   */
  archiveStore?: ReplayPremiereArchiveStore;
  reclamationGraceMs?: number;
  reclamationSweepMs?: number;
  /** Permanently fences and drains queued/running clip work before live reclaim. */
  fenceClipWritesAndDrain?: (premiereId: string) => Promise<void>;
  /** Premiere ids that must never be reclaimed nor compacted out at startup. */
  reclamationExcludedPremiereIds?: readonly string[];
  /**
   * Beta-side observer invoked when a premiere is OBSERVED in the revealed
   * state: at registration (a runtime recovered already revealed) and after a
   * supervised synchronize whose advance committed the reveal. May fire more
   * than once per premiere — subscribers dedupe. Exceptions are swallowed; the
   * reveal/registration path never depends on it.
   */
  onPremiereRevealed?: (premiereId: string) => void;
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
  latestEventSequence: number;
}

interface ReplayPremiereStartupPlan {
  record: ReplayPremiereAdmissionRecordV1;
  projection: RecoveryProjection;
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
export interface ReplayPremiereReclamationConfig {
  reclaimer: ReplayPremiereTerminalReclaimer;
  sweepMs: number;
  report: (diagnostic: ReplayPremiereStartupDiagnostic) => void;
  /**
   * Terminal premieres with durable evidence but no live runtime (the
   * 2026-07-22 orphan class), derived once at startup from the admission
   * catalog + recovered events. Every sweep retries the survivors (bounded
   * per-candidate) until each is reclaimed, refused, or dropped; a candidate
   * that becomes a live registered runtime is handed back to the live path.
   */
  orphanCandidates: ReplayPremiereOrphanCandidate[];
}

export class ReplayPremiereProductionService {
  private readonly supervisor: ReplayPremiereRuntimeSupervisor;
  private readonly pendingAssemblies: Set<Promise<unknown>>;
  private readonly reclamation: ReplayPremiereReclamationConfig | null;
  private closePromise: Promise<void> | null = null;
  private closing = false;
  private reclamationTimer: ReturnType<typeof setTimeout> | null = null;
  private reclamationInFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly eventStore: ReplayPremiereEventStore,
    private readonly httpRegistry: ReplayPremiereHttpRegistry,
    private readonly runtimeRegistry: ReplayPremiereRuntimeRegistry,
    private readonly ownedTargets: AssembledPremiereTarget[],
    supervisor: ReplayPremiereRuntimeSupervisor,
    pendingAssemblies: Set<Promise<unknown>>,
    reclamation: ReplayPremiereReclamationConfig | null = null,
  ) {
    this.supervisor = supervisor;
    this.pendingAssemblies = pendingAssemblies;
    this.reclamation = reclamation;
    if (this.reclamation !== null && this.reclamation.sweepMs > 0) {
      this.scheduleReclamationSweep(this.reclamation.sweepMs);
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce(null);
    return this.closePromise;
  }

  /**
   * Idempotently quiesces timers, durably marks every active premiere as
   * entering a real planned-restart outage, then closes retained resources.
   * The caller must stop external HTTP admission before invoking this method.
   */
  closeForPlannedRestart(): Promise<void> {
    this.closePromise ??= this.closeOnce("planned_restart");
    return this.closePromise;
  }

  /**
   * The explicit controlled-outage drill path. It records the drill reason in
   * each outage-start event, holds the service down across one observed runtime
   * wake cadence, then closes cleanly. The caller must stop external HTTP
   * admission before invoking this method.
   */
  closeForControlledOutageDrill(): Promise<void> {
    this.closePromise ??= this.closeOnce("controlled_outage_drill");
    return this.closePromise;
  }

  private async closeOnce(
    outageReason: ReplayPremiereOutageReason | null,
  ): Promise<void> {
    this.closing = true;
    const failures: unknown[] = [];
    try {
      if (this.reclamationTimer !== null) {
        clearTimeout(this.reclamationTimer);
        this.reclamationTimer = null;
      }
      await this.reclamationInFlight.catch(() => undefined);
      await this.supervisor.close();
      if (outageReason !== null) {
        let outagesStarted = 0;
        const orderedTargets = [...this.ownedTargets].sort((left, right) =>
          left.runtime.premiereId.localeCompare(right.runtime.premiereId),
        );
        for (const assembled of orderedTargets) {
          const state = assembled.runtime.readLifecycleState();
          if (
            state !== "scheduled" &&
            state !== "playing" &&
            state !== "checkpoint"
          ) {
            continue;
          }
          try {
            await assembled.runtime.beginOutage(outageReason);
            outagesStarted += 1;
          } catch (error) {
            failures.push(error);
          }
        }
        if (outageReason === "controlled_outage_drill") {
          if (outagesStarted === 0) {
            failures.push(
              startupUnavailable(
                "controlled_outage_drill_requires_durable_outage",
              ),
            );
          } else {
            // Once any drill-labelled begin is durable, preserve the full
            // external dwell even if another target refused its begin. A
            // short drill-labelled outage would be misleading evidence.
            await new Promise<void>((resolve) =>
              setTimeout(
                resolve,
                REPLAY_PREMIERE_CONTROLLED_OUTAGE_DRILL_HOLD_MS,
              ),
            );
          }
        }
      }
      // Deferred assembly can retain its own 90s budget. Closing already
      // fences registration, so outage begins must become durable first; the
      // pending work is then allowed to finish before the event store closes.
      await Promise.allSettled([...this.pendingAssemblies]);
    } catch (error) {
      failures.push(error);
    } finally {
      for (const assembled of [...this.ownedTargets].reverse()) {
        try {
          this.httpRegistry.unregister(assembled.target);
        } catch (error) {
          failures.push(error);
        }
        try {
          this.runtimeRegistry.unregister(assembled.runtime);
        } catch (error) {
          failures.push(error);
        }
      }
      this.ownedTargets.length = 0;
      try {
        await this.eventStore.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Replay Premiere production shutdown failed",
      );
    }
  }

  /**
   * Atomically register a target assembled AFTER startup (the deferred
   * fresh-admission lane). Refused once close() has begun so a late assembly
   * can never leak a registration into a torn-down service.
   */
  registerDeferredTarget(assembled: AssembledPremiereTarget): boolean {
    if (this.closing || this.closePromise !== null) return false;
    registerTargetAtomically(
      this.runtimeRegistry,
      this.httpRegistry,
      assembled,
      () => this.supervisor.add(assembled.runtime),
    );
    this.ownedTargets.push(assembled);
    return true;
  }

  /**
   * Reclaims every currently-eligible terminal premiere: writes its durable
   * summary + pointer, deletes its bulk, and de-registers it so the archive
   * router takes over `/premiere/<id>`. Exposed for direct invocation in tests;
   * the production service also runs it on a self-rescheduling timer.
   */
  async runReclamationSweepOnce(): Promise<void> {
    const reclamation = this.reclamation;
    if (reclamation === null) return;
    for (const assembled of [...this.ownedTargets]) {
      const result = await reclamation.reclaimer
        .reclaimIfEligible(assembled.target)
        .catch((error: unknown) => {
          reclamation.report({
            target: `${assembled.runtime.premiereId}.reclamation`,
            premiereId: assembled.runtime.premiereId,
            operatorCode: operatorCode(error),
          });
          return null;
        });
      if (result === null || !result.reclaimed) continue;
      this.httpRegistry.unregister(assembled.target);
      this.runtimeRegistry.unregister(assembled.runtime);
      const index = this.ownedTargets.indexOf(assembled);
      if (index !== -1) this.ownedTargets.splice(index, 1);
    }
    await this.sweepOrphanCandidates(reclamation);
  }

  /**
   * ORPHAN sweep (2026-07-22): reclaim terminal premieres that have durable
   * evidence but no live runtime, so a reveal whose reclamation grace spans a
   * beta restart still ends up archived instead of 404ing forever. Bounded and
   * fail-closed per candidate: a within-grace orphan is retried next sweep, a
   * refused or repeatedly-failing one is dropped with a report, and a
   * candidate that meanwhile registered live is left to the live path above.
   */
  private async sweepOrphanCandidates(
    reclamation: ReplayPremiereReclamationConfig,
  ): Promise<void> {
    if (reclamation.orphanCandidates.length === 0) return;
    const drop = (candidate: ReplayPremiereOrphanCandidate): void => {
      const index = reclamation.orphanCandidates.indexOf(candidate);
      if (index !== -1) reclamation.orphanCandidates.splice(index, 1);
    };
    for (const candidate of [...reclamation.orphanCandidates]) {
      if (this.closing) return;
      if (this.runtimeRegistry.get(candidate.premiereId) !== null) {
        // Registered after candidacy (e.g. the deferred assembly lane): the
        // live-target sweep owns it now.
        drop(candidate);
        continue;
      }
      try {
        const result =
          await reclamation.reclaimer.reclaimOrphanIfEligible(candidate);
        if (result.reclaimed) {
          drop(candidate);
          reclamation.report({
            target: `${candidate.premiereId}.orphan`,
            premiereId: candidate.premiereId,
            operatorCode: "orphan_reclaimed",
          });
          continue;
        }
        if (result.reason === "within_grace") continue; // retry next sweep
        drop(candidate);
        if (result.reason !== "excluded") {
          reclamation.report({
            target: `${candidate.premiereId}.orphan`,
            premiereId: candidate.premiereId,
            operatorCode: `orphan_not_reclaimed:${result.reason}`,
          });
        }
      } catch (error) {
        candidate.attempts += 1;
        reclamation.report({
          target: `${candidate.premiereId}.orphan`,
          premiereId: candidate.premiereId,
          operatorCode: `orphan_reclamation_failed:${operatorCode(error)}`,
        });
        if (candidate.attempts >= MAX_ORPHAN_RECLAMATION_ATTEMPTS) {
          drop(candidate);
        }
      }
    }
  }

  private scheduleReclamationSweep(sweepMs: number): void {
    if (this.closing || this.reclamation === null) return;
    const timer = setTimeout(() => {
      this.reclamationInFlight = this.runReclamationSweepOnce()
        .catch(() => undefined)
        .then(() => {
          this.scheduleReclamationSweep(sweepMs);
        });
    }, sweepMs);
    timer.unref?.();
    this.reclamationTimer = timer;
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
  const deferredBudgetMs = boundedDeferredFreshAssemblyBudget(
    options.deferredFreshAssemblyBudgetMs,
  );
  const freshWindowMs = boundedFreshAdmissionWindow(
    options.freshAdmissionWindowMs,
  );
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
    writerWaitMs: Math.min(1_000, maxStartupMs),
  });
  const privateStateRoot = catalog.privateStateRoot;
  let read: ReplayPremiereCatalogReadResult;
  try {
    read = await catalog.readAll();
  } finally {
    // The catalog lock is only held while startup snapshots the admission set,
    // so operators can admit the next target while runtimes stay live.
    await catalog.close().catch(() => undefined);
  }
  // Compact fully-reclaimed premieres out of the shared, hash-chained event
  // journal before any writer opens it, and garbage-collect their shared,
  // content-addressed source bundles. Both run in this no-active-writer window
  // (the terminal-reclamation sweep deliberately defers the shared source here
  // to avoid racing a concurrent admission). This keeps the event-store byte
  // ceiling unreachable across an unbounded premiere stream. Fail-closed: a
  // failure just leaves the journal/source intact for this cycle. Note the
  // present sets are drawn from successfully-parsed admissions only.
  if (options.archiveStore !== undefined) {
    const archiveStore = options.archiveStore;
    try {
      await compactReplayPremiereEventJournal({
        privateStateRoot,
        reclaimedPremiereIds: archiveStore.reclaimedPremiereIds(),
        presentPremiereIds: read.entries.map((entry) => entry.premiereId),
        excludedPremiereIds: options.reclamationExcludedPremiereIds,
        limits: eventStoreLimits,
      });
    } catch (error) {
      report({
        target: "event_store_journal",
        premiereId: null,
        operatorCode: operatorCode(error),
      });
    }
    try {
      await reclaimUnreferencedPremiereSources({
        privateStateRoot,
        reclaimedSources: archiveStore.reclaimedSources(),
        presentSourceShas: read.entries.map(
          (entry) => entry.stagedSource.sourceReplaySha256,
        ),
        excludedPremiereIds: options.reclamationExcludedPremiereIds,
      });
    } catch (error) {
      report({
        target: "premiere_source_gc",
        premiereId: null,
        operatorCode: operatorCode(error),
      });
    }
  }
  let eventStore: ReplayPremiereEventStore | null = null;
  try {
    eventStore = await ReplayPremiereEventStore.open({
      privateStateRoot: options.privateStateRoot,
      servedRoots: options.servedRoots,
      limits: eventStoreLimits,
      now: () => clock.now(),
    });
    const activeEventStore = eventStore;
    const recoveredAtStartup = activeEventStore.recovered;
    const latestEventsByAggregate = indexLatestEventsByAggregate(
      recoveredAtStartup.events,
    );
    const supervisor = new ReplayPremiereRuntimeSupervisor(
      clock,
      reportRuntime,
      options.onPremiereRevealed,
    );
    const pendingAssemblies = new Set<Promise<unknown>>();
    const ownedTargets: AssembledPremiereTarget[] = [];
    const reclamation: ReplayPremiereReclamationConfig | null =
      options.archiveStore === undefined
        ? null
        : {
            reclaimer: new ReplayPremiereTerminalReclaimer({
              privateStateRoot,
              store: options.archiveStore,
              graceMs:
                options.reclamationGraceMs ??
                DEFAULT_REPLAY_PREMIERE_RECLAMATION_GRACE_MS,
              now: () => clock.now(),
              excludedPremiereIds: options.reclamationExcludedPremiereIds,
              interactionEventStore: activeEventStore,
              interactionLimits: options.interactionLimits,
              fenceClipWritesAndDrain: options.fenceClipWritesAndDrain,
              // Durable-clip promotion telemetry rides the runtime diagnostic
              // channel (operator-visible, never authoritative).
              logger: (message) =>
                reportRuntime({
                  target: "premiere_archived_clips",
                  premiereId: null,
                  operatorCode: message,
                }),
            }),
            sweepMs: boundedReclamationSweepMs(options.reclamationSweepMs),
            report: reportRuntime,
            orphanCandidates: [],
          };
    const service = new ReplayPremiereProductionService(
      eventStore,
      options.httpRegistry,
      options.runtimeRegistry,
      ownedTargets,
      supervisor,
      pendingAssemblies,
      reclamation,
    );
    for (const failure of read.failures) {
      report({
        target: failure.target,
        premiereId: premiereIdFromCatalogTarget(failure.target),
        operatorCode: failure.operatorCode,
      });
    }
    const startupPlans: ReplayPremiereStartupPlan[] = [];
    for (const record of read.entries) {
      try {
        startupPlans.push({
          record,
          projection: recoveryProjection(
            latestEventsByAggregate.get(record.premiereId),
            record,
          ),
        });
      } catch (error) {
        report({
          target: `${record.premiereId}.admission.json`,
          premiereId: record.premiereId,
          operatorCode: operatorCode(error),
        });
      }
    }
    const startupOrderingNowMs = clock.now().getTime();
    // A durable archive pointer is an irreversible write-admission fence. A
    // crash may leave the old catalog admission behind after pointer commit;
    // never reconstruct or register that target, even briefly, because its
    // immutable summary can no longer absorb new reactions. The admission
    // remains in startupPlans so the orphan/existing-pointer cleanup path can
    // verify evidence and finish clip promotion + bulk deletion.
    const alreadyArchivedPremiereIds = new Set(
      options.archiveStore?.reclaimedPremiereIds() ?? [],
    );
    const liveStartupPlans = startupPlans.filter(
      (plan) => !alreadyArchivedPremiereIds.has(plan.record.premiereId),
    );
    // Belt-and-suspenders (2026-07-22 round-649 outage class): ordering and
    // selection are pure and should never throw, but no admission may crash
    // the process — a failure here registers nothing this boot and reports,
    // instead of rejecting the whole startup.
    let criticalPlans: ReplayPremiereStartupPlan[];
    try {
      liveStartupPlans.sort((left, right) =>
        compareStartupPlans(left, right, startupOrderingNowMs),
      );
      criticalPlans = selectCriticalStartupPlans(
        liveStartupPlans,
        options.reclamationExcludedPremiereIds ?? [],
      );
    } catch (error) {
      report({
        target: "startup_plan_selection",
        premiereId: null,
        operatorCode: operatorCode(error),
      });
      criticalPlans = [];
    }
    const registered: string[] = [];
    // Plans the shared boot budget could not fit: reported (unchanged) AND
    // collected so a FRESH admission among them can get its single deferred
    // background assembly after startup returns.
    const deadlineMissedPlans: ReplayPremiereStartupPlan[] = [];
    const deadlineMiss = (startIndex: number): void => {
      for (let i = startIndex; i < criticalPlans.length; i += 1) {
        deadlineMissedPlans.push(criticalPlans[i]);
      }
      reportDeadlineForRemainder(criticalPlans, startIndex, report);
    };
    for (let index = 0; index < criticalPlans.length; index += 1) {
      const plan = criticalPlans[index];
      const record = plan.record;
      const remainingMs = maxStartupMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        deadlineMiss(index);
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
            checkpointProjectionCatalog: catalog,
            interactionLimits: options.interactionLimits,
            recoveryProjection: plan.projection,
            fence,
          });
        },
        remainingMs,
        pendingAssemblies,
      });
      if (deadline.status === "timed_out") {
        deadlineMiss(index);
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
        deadlineMiss(index);
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
    // DEFERRED FRESH-ADMISSION ASSEMBLY (2026-07-22 activation zombie): give
    // each deadline-missed plan whose admission is provably fresh exactly ONE
    // bounded background assembly. Startup returns immediately (the boot path
    // stays bounded exactly as before); on success the target registers
    // through the same atomic path, guarded against a closing service. Stale
    // admissions (e.g. prem_live20260721aaan) never qualify: freshness is
    // keyed exclusively on the hash-covered `admittedAt`, so a stale premiere
    // can never self-activate after a restart.
    const deferredPremiereIds = new Set<string>();
    if (deferredBudgetMs > 0) {
      const freshNowMs = clock.now().getTime();
      for (const plan of deadlineMissedPlans) {
        const record = plan.record;
        if (!isFreshAdmission(record.admittedAt, freshNowMs, freshWindowMs)) {
          continue;
        }
        deferredPremiereIds.add(record.premiereId);
        report({
          target: `${record.premiereId}.admission.json`,
          premiereId: record.premiereId,
          operatorCode: "deferred_assembly_scheduled",
        });
        const deferred = (async () => {
          try {
            const outcome = await assembleBeforeDeadline({
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
                  checkpointProjectionCatalog: catalog,
                  interactionLimits: options.interactionLimits,
                  recoveryProjection: plan.projection,
                  fence,
                });
              },
              remainingMs: deferredBudgetMs,
              pendingAssemblies,
            });
            if (outcome.status === "fulfilled") {
              const accepted = service.registerDeferredTarget(outcome.value);
              reportRuntime({
                target: `${record.premiereId}.admission.json`,
                premiereId: record.premiereId,
                operatorCode: accepted
                  ? "deferred_assembly_registered"
                  : "deferred_assembly_abandoned_closing",
              });
              return;
            }
            reportRuntime({
              target: `${record.premiereId}.admission.json`,
              premiereId: record.premiereId,
              operatorCode:
                outcome.status === "timed_out"
                  ? "deferred_assembly_deadline_exceeded"
                  : `deferred_assembly_rejected:${operatorCode(outcome.error)}`,
            });
          } catch (error) {
            reportRuntime({
              target: `${record.premiereId}.admission.json`,
              premiereId: record.premiereId,
              operatorCode: `deferred_assembly_failed:${operatorCode(error)}`,
            });
          }
        })();
        pendingAssemblies.add(deferred);
        void deferred.finally(() => pendingAssemblies.delete(deferred));
      }
    }
    // ORPHAN CANDIDATES (2026-07-22): terminal premieres with durable
    // evidence but no live runtime — a reveal whose reclamation grace spans a
    // beta restart is never re-registered (fresh rounds own the critical
    // slot), so without this the live-target sweep can never archive it and
    // its /premiere page 404s forever. Derivation is pure in-memory filtering
    // of state startup already loaded (no extra I/O on the boot path); the
    // bounded reclamation work runs on the background sweep.
    if (reclamation !== null) {
      reclamation.orphanCandidates.push(
        ...deriveOrphanCandidates({
          plans: startupPlans,
          registeredPremiereIds: new Set(registered),
          deferredPremiereIds,
          excludedPremiereIds: new Set(
            options.reclamationExcludedPremiereIds ?? [],
          ),
          latestEventsByAggregate,
          recoveredEvents: recoveredAtStartup.events,
          report: reportRuntime,
        }),
      );
      if (reclamation.orphanCandidates.length > 0) {
        // One immediate background sweep so a past-grace orphan archives
        // within seconds of boot instead of waiting for the first timer tick.
        const kick = service.runReclamationSweepOnce().catch(() => undefined);
        pendingAssemblies.add(kick);
        void kick.finally(() => pendingAssemblies.delete(kick));
      }
    }
    return {
      service,
      registeredPremiereIds: Object.freeze([...registered]),
      diagnostics: Object.freeze([...diagnostics]),
    };
  } catch (error) {
    await eventStore?.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Derives the orphan-reclamation candidates from state startup already holds.
 * Only PROVEN terminal states qualify: revealed/archived need a canonical
 * reveal instant recovered from the event store (fail-closed with a report
 * when absent — a stale non-revealed admission can never become publishable
 * through the orphan path); failed/cancelled orphans carry the neutral
 * null-outcome evidence. Registered, deferred, and reclaim-excluded premieres
 * never become candidates.
 */
function deriveOrphanCandidates(options: {
  plans: readonly ReplayPremiereStartupPlan[];
  registeredPremiereIds: ReadonlySet<string>;
  deferredPremiereIds: ReadonlySet<string>;
  excludedPremiereIds: ReadonlySet<string>;
  latestEventsByAggregate: Map<string, StoredReplayPremiereEvent>;
  recoveredEvents: readonly StoredReplayPremiereEvent[];
  report: (diagnostic: ReplayPremiereStartupDiagnostic) => void;
}): ReplayPremiereOrphanCandidate[] {
  const candidates: ReplayPremiereOrphanCandidate[] = [];
  let revealInstants: Map<string, string> | null = null;
  for (const plan of options.plans) {
    const premiereId = plan.record.premiereId;
    if (
      options.registeredPremiereIds.has(premiereId) ||
      options.deferredPremiereIds.has(premiereId) ||
      options.excludedPremiereIds.has(premiereId)
    ) {
      continue;
    }
    const state = plan.projection.state;
    if (state === "failed" || state === "cancelled") {
      candidates.push({
        premiereId,
        record: plan.record,
        terminalState: state,
        revealedAt: null,
        attempts: 0,
      });
      continue;
    }
    if (state !== "revealed" && state !== "archived") {
      // scheduled/draft stay untouchable (never publishable via this path);
      // playing/checkpoint plans are critical and re-register live.
      continue;
    }
    let revealedAt: string | null;
    const latest = options.latestEventsByAggregate.get(premiereId);
    if (
      latest !== undefined &&
      latest.eventType === "premiere_reveal_committed"
    ) {
      revealedAt = revealInstantFromEventPayload(latest.payload);
    } else {
      // Archived premieres' latest event lacks the reveal payload; find the
      // aggregate's reveal event among the recovered events (latest wins).
      revealInstants ??= indexRevealInstants(options.recoveredEvents);
      revealedAt = revealInstants.get(premiereId) ?? null;
    }
    if (revealedAt === null) {
      options.report({
        target: `${premiereId}.orphan`,
        premiereId,
        operatorCode: "orphan_evidence_incomplete",
      });
      continue;
    }
    candidates.push({
      premiereId,
      record: plan.record,
      terminalState: state,
      revealedAt,
      attempts: 0,
    });
  }
  return candidates;
}

function revealInstantFromEventPayload(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.reveal)) return null;
  const revealedAt = payload.reveal.revealedAt;
  if (typeof revealedAt !== "string") return null;
  const parsedMs = Date.parse(revealedAt);
  return Number.isFinite(parsedMs) &&
    new Date(parsedMs).toISOString() === revealedAt
    ? revealedAt
    : null;
}

function indexRevealInstants(
  events: readonly StoredReplayPremiereEvent[],
): Map<string, string> {
  const instants = new Map<string, string>();
  for (const event of events) {
    if (event.eventType !== "premiere_reveal_committed") continue;
    const instant = revealInstantFromEventPayload(event.payload);
    if (instant !== null) instants.set(event.aggregateId, instant);
  }
  return instants;
}

function boundedReclamationSweepMs(value: number | undefined): number {
  const sweepMs = value ?? DEFAULT_RECLAMATION_SWEEP_MS;
  if (
    !Number.isSafeInteger(sweepMs) ||
    sweepMs < 0 ||
    sweepMs > MAX_RECLAMATION_SWEEP_MS
  ) {
    throw startupUnavailable("invalid_reclamation_sweep_interval");
  }
  return sweepMs;
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
  checkpointProjectionCatalog: ReplayPremiereAdmissionCatalog;
  interactionLimits?: Partial<ReplayPremiereInteractionLimits>;
  recoveryProjection: RecoveryProjection;
  fence: ReplayPremiereStartupOperationFence;
}): Promise<AssembledPremiereTarget> {
  assertStartupActive(options.fence.signal);
  const rebuilt = await rebuildReplayPremiereProjectionInput({
    record: options.record,
    privateStateRoot: options.privateStateRoot,
    servedRoots: options.servedRoots,
    maxSourceBytes: options.maxSourceBytes,
    publicOrigin: options.publicOrigin,
  });
  assertStartupActive(options.fence.signal);
  const { gate, drafts } = rebuilt;
  if (
    gate.requiredRevealEventBytes > options.eventStoreLimits.maxEventBytes ||
    gate.requiredRevealEventBytes > options.eventStoreLimits.maxSnapshotBytes
  ) {
    throw startupCapacity("startup_reveal_capacity_incompatible");
  }
  assertStartupActive(options.fence.signal);
  const storedArtifact =
    await options.checkpointProjectionCatalog.loadCheckpointProjection({
      record: options.record,
      gate,
    });
  const checkpointProjection =
    storedArtifact?.projection ??
    (await options.checkpointProjector.project({
      gate,
      drafts,
      signal: options.fence.signal,
    }));
  if (storedArtifact === null) {
    await options.checkpointProjectionCatalog.publishCheckpointProjection({
      record: options.record,
      gate,
      projection: checkpointProjection,
    });
  }
  assertStartupActive(options.fence.signal);

  const projection = options.recoveryProjection;
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
    private readonly onPremiereRevealed?: (premiereId: string) => void,
  ) {}

  add(runtime: ReplayPremiereRuntimeCoordinator): void {
    if (this.closed) throw startupUnavailable("runtime_supervisor_closed");
    // A runtime recovered/registered ALREADY revealed never re-fires a
    // "revealed" advance operation, so the registration itself is the
    // observation point for it.
    if (runtime.readLifecycleState() === "revealed") {
      this.notifyRevealed(runtime.premiereId);
    }
    this.arm(runtime, runtime.nextWakeAt());
  }

  private notifyRevealed(premiereId: string): void {
    try {
      this.onPremiereRevealed?.(premiereId);
    } catch {
      // Observers are non-authoritative; reveal handling never depends on them.
    }
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
          if (advance.operations.includes("revealed")) {
            this.notifyRevealed(runtime.premiereId);
          }
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

function indexLatestEventsByAggregate(
  events: readonly StoredReplayPremiereEvent[],
): Map<string, StoredReplayPremiereEvent> {
  const latest = new Map<string, StoredReplayPremiereEvent>();
  for (const event of events) latest.set(event.aggregateId, event);
  return latest;
}

function recoveryProjection(
  latest: StoredReplayPremiereEvent | undefined,
  record: ReplayPremiereAdmissionRecordV1,
): RecoveryProjection {
  if (latest === undefined)
    return {
      state: "scheduled",
      releasedThroughSequence: -1,
      latestEventSequence: -1,
    };
  if (!isRecord(latest.payload) || !isRecord(latest.payload.lifecycle)) {
    throw startupIntegrity("startup_runtime_projection_missing_lifecycle");
  }
  const payload = latest.payload;
  const lifecycle = payload.lifecycle as unknown as PremiereLifecycleSnapshot;
  try {
    assertValidPremiereLifecycleSnapshot(lifecycle);
  } catch (error) {
    throw startupIntegrity("startup_runtime_projection_invalid", error);
  }
  if (
    latest.schemaVersion !== 1 ||
    latest.aggregateId !== record.premiereId ||
    latest.idempotencyKey === null ||
    latest.idempotencyStateHash === null ||
    latest.idempotencyStateHash !== hashReplayPremiereJson(latest.payload) ||
    lifecycle.premiereId !== record.premiereId ||
    lifecycle.eligibilityRecordHash !== record.expectedEligibilityRecordHash ||
    lifecycle.publicationCommitmentHash !==
      record.expectedPublicationCommitmentHash ||
    lifecycle.sourceRunId !== record.eligibilityRecord.sourceRunId ||
    lifecycle.sourceReplaySha256 !== record.eligibilityRecord.sourceReplaySha256
  ) {
    throw startupIntegrity("startup_runtime_projection_envelope_invalid");
  }
  if (RUNTIME_PROJECTION_EVENT_TYPES.has(latest.eventType)) {
    assertRuntimeProjectionEnvelope(latest, payload, lifecycle, record);
  } else if (latest.eventType === "premiere_reveal_committed") {
    assertRevealProjectionEnvelope(latest, payload, lifecycle, record);
  } else if (latest.eventType === "premiere_runtime_archived") {
    assertArchiveProjectionEnvelope(latest, payload, lifecycle, record);
  } else {
    throw startupIntegrity("startup_runtime_projection_envelope_invalid");
  }
  const state = lifecycle.state;
  const releasedThroughSequence = lifecycle.lastSafeReleasedSequence;
  if (
    !isPremiereState(state) ||
    !Number.isSafeInteger(releasedThroughSequence) ||
    Number(releasedThroughSequence) < -1
  ) {
    throw startupIntegrity("startup_runtime_projection_invalid");
  }
  return {
    state,
    releasedThroughSequence: Number(releasedThroughSequence),
    latestEventSequence: latest.eventSequence,
  };
}

function assertRuntimeProjectionEnvelope(
  event: StoredReplayPremiereEvent,
  payload: Record<string, unknown>,
  lifecycle: PremiereLifecycleSnapshot,
  record: ReplayPremiereAdmissionRecordV1,
): void {
  if (
    !hasExactKeys(payload, RUNTIME_PROJECTION_KEYS) ||
    payload.schemaVersion !== 1 ||
    payload.runtimeKind !== "replay_premiere_runtime_v1" ||
    payload.premiereId !== record.premiereId ||
    payload.publicationCommitmentHash !==
      record.expectedPublicationCommitmentHash ||
    payload.lastObservedAt !== event.occurredAt ||
    (!isRuntimeOutageEvent(event.eventType) &&
      lifecycle.updatedAt !== event.occurredAt) ||
    !runtimeProjectionStateMatches(event.eventType, lifecycle.state) ||
    !runtimeProjectionIdempotencyMatches(event, payload, lifecycle)
  ) {
    throw startupIntegrity("startup_runtime_projection_envelope_invalid");
  }
}

function isRuntimeOutageEvent(eventType: string): boolean {
  return (
    eventType === "premiere_runtime_outage_started" ||
    eventType === "premiere_runtime_outage_recovered"
  );
}

function assertRevealProjectionEnvelope(
  event: StoredReplayPremiereEvent,
  payload: Record<string, unknown>,
  lifecycle: PremiereLifecycleSnapshot,
  record: ReplayPremiereAdmissionRecordV1,
): void {
  const transition = payload.transitionAuditEvent;
  const terminalChunk = payload.terminalChunk;
  const reveal = payload.reveal;
  if (
    !hasExactKeys(payload, REVEAL_PROJECTION_KEYS) ||
    payload.schemaVersion !== 1 ||
    payload.commitKind !== "terminal_chunk_and_reveal" ||
    payload.publicationCommitmentHash !==
      record.expectedPublicationCommitmentHash ||
    lifecycle.state !== "revealed" ||
    lifecycle.updatedAt !== event.occurredAt ||
    event.idempotencyKey !==
      `reveal:${record.expectedPublicationCommitmentHash}` ||
    !isRecord(transition) ||
    transition.premiereId !== record.premiereId ||
    transition.toState !== "revealed" ||
    transition.occurredAt !== event.occurredAt ||
    !isRecord(terminalChunk) ||
    terminalChunk.premiereId !== record.premiereId ||
    terminalChunk.terminal !== true ||
    terminalChunk.releasedAt !== event.occurredAt ||
    !isRecord(reveal) ||
    reveal.premiereId !== record.premiereId ||
    reveal.state !== "revealed" ||
    reveal.publicationCommitmentHash !==
      record.expectedPublicationCommitmentHash ||
    reveal.revealedAt !== event.occurredAt
  ) {
    throw startupIntegrity("startup_runtime_projection_envelope_invalid");
  }
}

function assertArchiveProjectionEnvelope(
  event: StoredReplayPremiereEvent,
  payload: Record<string, unknown>,
  lifecycle: PremiereLifecycleSnapshot,
  record: ReplayPremiereAdmissionRecordV1,
): void {
  if (
    !hasExactKeys(payload, ARCHIVE_PROJECTION_KEYS) ||
    payload.schemaVersion !== 1 ||
    payload.runtimeKind !== "replay_premiere_archive_v1" ||
    payload.premiereId !== record.premiereId ||
    payload.publicationCommitmentHash !==
      record.expectedPublicationCommitmentHash ||
    !isSha256Hex(payload.revealCommitHash) ||
    lifecycle.state !== "archived" ||
    lifecycle.updatedAt !== event.occurredAt ||
    event.idempotencyKey !==
      `runtime:archive:${record.expectedPublicationCommitmentHash}`
  ) {
    throw startupIntegrity("startup_runtime_projection_envelope_invalid");
  }
}

function runtimeProjectionStateMatches(
  eventType: string,
  state: PremiereState,
): boolean {
  switch (eventType) {
    case "premiere_runtime_initialized":
      return state === "scheduled";
    case "premiere_runtime_started":
    case "premiere_runtime_checkpoint_resumed":
      return state === "playing";
    case "premiere_runtime_chunk_released":
      return state === "playing" || state === "checkpoint";
    case "premiere_runtime_outage_started":
    case "premiere_runtime_outage_recovered":
      return (
        state === "scheduled" || state === "playing" || state === "checkpoint"
      );
    case "premiere_runtime_failed":
      return state === "failed";
    case "premiere_runtime_cancelled":
      return state === "cancelled";
    case "premiere_runtime_terminal_archived":
      return state === "archived";
    default:
      return false;
  }
}

function runtimeProjectionIdempotencyMatches(
  event: StoredReplayPremiereEvent,
  payload: Record<string, unknown>,
  lifecycle: PremiereLifecycleSnapshot,
): boolean {
  const key = event.idempotencyKey;
  if (key === null) return false;
  const commitment = String(payload.publicationCommitmentHash);
  switch (event.eventType) {
    case "premiere_runtime_initialized":
      return key === `runtime:init:${commitment}`;
    case "premiere_runtime_started":
      return key === `runtime:start:${commitment}`;
    case "premiere_runtime_chunk_released":
      return (
        Number.isSafeInteger(payload.nextDraftIndex) &&
        Number(payload.nextDraftIndex) > 0 &&
        key ===
          `runtime:release:${commitment}:${Number(payload.nextDraftIndex) - 1}`
      );
    case "premiere_runtime_checkpoint_resumed": {
      const checkpointIds = payload.completedCheckpointIds;
      const checkpointId = Array.isArray(checkpointIds)
        ? checkpointIds.at(-1)
        : undefined;
      return (
        typeof checkpointId === "string" &&
        key === `runtime:checkpoint:${checkpointId}:resume`
      );
    }
    case "premiere_runtime_outage_started":
      return (
        payload.outageStartedAt === event.occurredAt &&
        isReplayPremiereOutageStartIdempotencyKey(
          key,
          commitment,
          lifecycle.version,
        )
      );
    case "premiere_runtime_outage_recovered": {
      const prefix = `runtime:outage:${commitment}:recover:${lifecycle.version}:`;
      return (
        payload.outageStartedAt === null &&
        key.startsWith(prefix) &&
        /^-?\d+$/.test(key.slice(prefix.length))
      );
    }
    case "premiere_runtime_failed":
      return key === `runtime:fail:${commitment}:${lifecycle.version}`;
    case "premiere_runtime_cancelled":
      return key === `runtime:cancel:${commitment}`;
    case "premiere_runtime_terminal_archived":
      return key === `runtime:archive:${commitment}`;
    default:
      return false;
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function compareStartupPlans(
  left: ReplayPremiereStartupPlan,
  right: ReplayPremiereStartupPlan,
  nowMs: number,
): number {
  const leftPriority = startupStatePriority(left.projection.state);
  const rightPriority = startupStatePriority(right.projection.state);
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;

  if (leftPriority === 1) {
    const leftDistance = scheduledDistanceMs(
      left.record.publicDefinition.scheduledAt,
      nowMs,
    );
    const rightDistance = scheduledDistanceMs(
      right.record.publicDefinition.scheduledAt,
      nowMs,
    );
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
  } else if (
    left.projection.latestEventSequence !== right.projection.latestEventSequence
  ) {
    return (
      right.projection.latestEventSequence - left.projection.latestEventSequence
    );
  }

  return left.record.premiereId.localeCompare(right.record.premiereId);
}

function selectCriticalStartupPlans(
  plans: readonly ReplayPremiereStartupPlan[],
  reclamationExcludedPremiereIds: readonly string[],
): ReplayPremiereStartupPlan[] {
  const activePlans = plans.filter(
    (plan) =>
      plan.projection.state === "playing" ||
      plan.projection.state === "checkpoint",
  );
  if (activePlans.length > 0) return activePlans;
  const nearestScheduled = plans.find(
    (plan) =>
      plan.projection.state === "scheduled" ||
      plan.projection.state === "draft",
  );
  if (nearestScheduled !== undefined) return [nearestScheduled];
  // Terminal-only fallback. Reclaim-EXCLUDED terminal plans are skipped: they
  // are retained forever, their assembly re-simulates the entire game and
  // measurably burns the whole boot budget at every quiet boot
  // (prem_live20260721aaan: sim churn + startup_deadline_exceeded at every
  // selection since 2026-07-21), and skipping cannot regress availability —
  // a plan that always exceeds the budget never registered anyway.
  const excluded = new Set(reclamationExcludedPremiereIds);
  const fallback = plans.find((plan) => !excluded.has(plan.record.premiereId));
  return fallback === undefined ? [] : [fallback];
}

function startupStatePriority(state: PremiereState): number {
  if (state === "playing" || state === "checkpoint") return 0;
  if (state === "draft" || state === "scheduled") return 1;
  return 2;
}

function scheduledDistanceMs(scheduledAt: string, nowMs: number): number {
  const scheduledAtMs = Date.parse(scheduledAt);
  return Number.isFinite(scheduledAtMs) && Number.isFinite(nowMs)
    ? Math.abs(scheduledAtMs - nowMs)
    : Number.MAX_SAFE_INTEGER;
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
  plans: readonly ReplayPremiereStartupPlan[],
  startIndex: number,
  report: (diagnostic: ReplayPremiereStartupDiagnostic) => void,
): void {
  for (let index = startIndex; index < plans.length; index += 1) {
    const record = plans[index].record;
    report({
      target: `${record.premiereId}.admission.json`,
      premiereId: record.premiereId,
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

function boundedDeferredFreshAssemblyBudget(value: number | undefined): number {
  const budget = value ?? DEFAULT_DEFERRED_FRESH_ASSEMBLY_BUDGET_MS;
  if (
    !Number.isSafeInteger(budget) ||
    budget < 0 ||
    budget > MAX_DEFERRED_FRESH_ASSEMBLY_BUDGET_MS
  ) {
    throw startupUnavailable("invalid_deferred_assembly_budget");
  }
  return budget;
}

function boundedFreshAdmissionWindow(value: number | undefined): number {
  const window = value ?? DEFAULT_FRESH_ADMISSION_WINDOW_MS;
  if (
    !Number.isSafeInteger(window) ||
    window < 1 ||
    window > MAX_FRESH_ADMISSION_WINDOW_MS
  ) {
    throw startupUnavailable("invalid_fresh_admission_window");
  }
  return window;
}

/**
 * Whether an admission is fresh enough for the deferred assembly lane. Fail
 * closed: an unparseable `admittedAt` or one outside [now - window, now +
 * skew] never defers — the stale-premiere protection the startup deadline
 * exists for is preserved exactly.
 */
function isFreshAdmission(
  admittedAt: string,
  nowMs: number,
  windowMs: number,
): boolean {
  const admittedAtMs = Date.parse(admittedAt);
  if (!Number.isFinite(admittedAtMs)) return false;
  const ageMs = nowMs - admittedAtMs;
  return ageMs <= windowMs && -ageMs <= MAX_FUTURE_ADMISSION_SKEW_MS;
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
