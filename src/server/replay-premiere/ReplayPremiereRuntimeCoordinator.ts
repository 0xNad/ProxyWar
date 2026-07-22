import {
  assertReplayPremiereCheckpointProjection,
  type ReplayPremiereCheckpointProjection,
} from "./ReplayPremiereCheckpointProjection";
import type {
  PremiereChunkDraft,
  PremiereState,
  ReleasedPremiereChunk,
} from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import {
  readAuthenticReplayPremiereEventRecoveryEvents,
  type ReplayPremiereEventRecovery,
  type ReplayPremiereSnapshot,
  type StoredReplayPremiereEvent,
} from "./ReplayPremiereEventStore";
import {
  assertReplayPremiereJsonValue,
  cloneAndFreezeReplayPremiereValue,
  hashReplayPremiereJson,
  isSha256Hex,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import { hashReplayPremiereCheckpointSchedule } from "./ReplayPremiereInteractionRecovery";
import {
  ReplayPremiereInteractions,
  type ReplayPremiereInteractionCheckpoint,
  type ReplayPremierePreparedInteractionTransition,
  type ReplayPremiereReleasedContext,
} from "./ReplayPremiereInteractions";
import {
  cloneAndFreezePremiereDraftChunks,
  VerifiedPremiereEligibilityGate,
  type VerifiedPremiereTerminalChunk,
} from "./ReplayPremierePublication";
import {
  recoverCommittedReveal,
  ReplayPremiereAtomicPublication,
  type PremiereRevealPersistence,
} from "./ReplayPremiereRevealCommit";
import {
  assertValidPremiereLifecycleSnapshot,
  createDraftPremiereLifecycle,
  recordSafeReleasedSequence,
  transitionPremiereLifecycle,
  type PremiereLifecycleSnapshot,
} from "./ReplayPremiereStateMachine";
import {
  createPremierePublicBootstrap,
  createPremierePublicProvenance,
  toPremierePublicChunkResponse,
  type PremiereManifestResponse,
  type PremierePreRevealManifestResponse,
  type PremierePublicBootstrapResponse,
  type PremierePublicCheckpoint,
  type PremierePublicChunkDescriptor,
  type PremierePublicChunkResponse,
  type PremiereRevealPointerResponse,
  type PremiereRevealResponse,
} from "./ReplayPremiereWire";

// Defined in ReplayPremiereContracts (shared with the interactions store,
// which the coordinator imports — a local definition would create a cycle).
// Re-exported here for the existing import sites.
import { REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS } from "./ReplayPremiereContracts";

export { REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS };
export const REPLAY_PREMIERE_MAX_RECOVERABLE_OUTAGE_MS = 60_000;
export const REPLAY_PREMIERE_MAX_OUTAGE_EVENTS_PER_LIFECYCLE_VERSION = 2;

const runtimeEventTypes = new Set([
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

export interface ReplayPremiereRuntimeClock {
  now(): Date;
}

export interface ReplayPremiereRuntimePersistence extends PremiereRevealPersistence {
  readonly recovered: ReplayPremiereEventRecovery;
  readSnapshot(aggregateId: string): Promise<ReplayPremiereSnapshot | null>;
}

export interface ReplayPremiereRuntimeAdvance {
  state: PremiereState;
  operations: Array<
    | "started"
    | "chunk_released"
    | "checkpoint_opened"
    | "checkpoint_resumed"
    | "revealed"
    | "failed"
  >;
  nextWakeAt: string | null;
}

interface ReplayPremiereRuntimeSnapshotV1 {
  schemaVersion: 1;
  runtimeKind: "replay_premiere_runtime_v1";
  premiereId: string;
  publicationCommitmentHash: string;
  lifecycle: PremiereLifecycleSnapshot;
  actualStartAt: string | null;
  scheduleShiftMs: number;
  accumulatedPauseMs: number;
  activeCheckpoint: PremierePublicCheckpoint | null;
  completedCheckpointIds: string[];
  outageStartedAt: string | null;
  lastObservedAt: string;
  nextDraftIndex: number;
  releasedChunks: PremierePublicChunkDescriptor[];
  interactionCheckpoints: ReplayPremiereInteractionCheckpoint[];
}

interface ReplayPremiereArchivePayloadV1 {
  schemaVersion: 1;
  runtimeKind: "replay_premiere_archive_v1";
  premiereId: string;
  publicationCommitmentHash: string;
  revealCommitHash: string;
  lifecycle: PremiereLifecycleSnapshot;
}

interface RecoveredRevealView {
  lifecycle: PremiereLifecycleSnapshot;
  pointer: PremiereRevealPointerResponse;
  reveal: PremiereRevealResponse;
  chunks: ReadonlyMap<number, PremierePublicChunkResponse>;
}

export class ReplayPremiereRuntimeCoordinator {
  readonly premiereId: string;
  private readonly gate: VerifiedPremiereEligibilityGate;
  private readonly drafts: readonly PremiereChunkDraft[];
  private readonly checkpointProjection: ReplayPremiereCheckpointProjection;
  private readonly persistence: ReplayPremiereRuntimePersistence;
  private readonly clock: ReplayPremiereRuntimeClock;
  private readonly interactions: ReplayPremiereInteractions;
  private state: ReplayPremiereRuntimeSnapshotV1;
  private publication: ReplayPremiereAtomicPublication | null;
  private recoveredReveal: RecoveredRevealView | null;
  private readonly outageEventsByLifecycleVersion: Map<number, number>;
  private lastClockObservedAtMs: number;
  private operationQueue: Promise<void> = Promise.resolve();

  private constructor(options: {
    gate: VerifiedPremiereEligibilityGate;
    drafts: readonly PremiereChunkDraft[];
    checkpointProjection: ReplayPremiereCheckpointProjection;
    persistence: ReplayPremiereRuntimePersistence;
    clock: ReplayPremiereRuntimeClock;
    interactions: ReplayPremiereInteractions;
    state: ReplayPremiereRuntimeSnapshotV1;
    publication: ReplayPremiereAtomicPublication | null;
    recoveredReveal: RecoveredRevealView | null;
    outageEventsByLifecycleVersion: ReadonlyMap<number, number>;
  }) {
    this.gate = options.gate;
    this.drafts = cloneAndFreezePremiereDraftChunks(options.drafts);
    this.checkpointProjection = options.checkpointProjection;
    this.persistence = options.persistence;
    this.clock = options.clock;
    this.interactions = options.interactions;
    this.state = immutable(options.state, "premiere runtime state");
    this.publication = options.publication;
    this.recoveredReveal = options.recoveredReveal;
    this.outageEventsByLifecycleVersion = new Map(
      options.outageEventsByLifecycleVersion,
    );
    this.lastClockObservedAtMs = Date.parse(options.state.lastObservedAt);
    this.premiereId = options.gate.premiereId;
  }

  static async createOrRecover(options: {
    gate: VerifiedPremiereEligibilityGate;
    drafts: readonly PremiereChunkDraft[];
    checkpointProjection: ReplayPremiereCheckpointProjection;
    persistence: ReplayPremiereRuntimePersistence;
    clock: ReplayPremiereRuntimeClock;
    interactions: ReplayPremiereInteractions;
  }): Promise<ReplayPremiereRuntimeCoordinator> {
    assertRuntimeInputs(
      options.gate,
      options.drafts,
      options.checkpointProjection,
    );
    const recovered = options.persistence.recovered;
    const authenticEvents =
      readAuthenticReplayPremiereEventRecoveryEvents(recovered);
    const events =
      authenticEvents ?? snapshotUntrustedStoredEvents(recovered.events);
    if (authenticEvents === null) {
      assertStoredEventHashChain(events);
    }
    const aggregateEvents = events.filter(
      (event) => event.aggregateId === options.gate.premiereId,
    );
    if (aggregateEvents.length === 0) {
      return this.create(options);
    }
    return this.recover(options, aggregateEvents);
  }

  readBootstrap(): PremierePublicBootstrapResponse {
    return createPremierePublicBootstrap({ gate: this.gate });
  }

  async readManifest(): Promise<PremiereManifestResponse> {
    // A transition publishes its in-memory state only after the journal append.
    // Queue the clock projection with that transition so a reader cannot
    // observe a later playing clock followed by an earlier checkpoint clock.
    return this.runExclusive(async () => {
      if (this.recoveredReveal !== null) {
        return immutable(
          {
            ...this.recoveredReveal.pointer,
            state:
              this.recoveredReveal.lifecycle.state === "archived"
                ? "archived"
                : "revealed",
          },
          "premiere runtime reveal pointer",
        );
      }
      if (this.publication === null) {
        throw runtimeIntegrity("missing_publication_view");
      }
      const now = this.clockTimestamp();
      return manifestFromRuntimeState(
        immutable(
          { ...this.state, lastObservedAt: now },
          "current premiere manifest projection",
        ),
        this.gate,
        { projectExpiredCheckpoint: true },
      );
    });
  }

  readChunk(index: number): PremierePublicChunkResponse | null {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw runtimeRequest("invalid_chunk_index");
    }
    if (this.recoveredReveal !== null) {
      const chunk = this.recoveredReveal.chunks.get(index);
      return chunk === undefined
        ? null
        : immutable(chunk, "premiere recovered chunk read");
    }
    if (this.publication === null) return null;
    return this.publication.readChunk(index);
  }

  readReveal(): PremiereRevealResponse | null {
    if (this.recoveredReveal !== null) {
      return immutable(
        this.recoveredReveal.reveal,
        "premiere recovered reveal read",
      );
    }
    return this.publication?.readReveal() ?? null;
  }

  readActiveCheckpoint(): PremierePublicCheckpoint | null {
    return this.state.activeCheckpoint === null
      ? null
      : immutable(
          this.state.activeCheckpoint,
          "premiere active checkpoint read",
        );
  }

  readLifecycleState(): PremiereState {
    return this.currentLifecycle().state;
  }

  readReleasedContext(sequence: number): ReplayPremiereReleasedContext | null {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
    const releasedThroughSequence =
      this.currentLifecycle().lastSafeReleasedSequence;
    if (sequence > releasedThroughSequence) return null;
    for (const draft of this.drafts) {
      const record = draft.payload.records.find(
        (candidate) => candidate.sequence === sequence,
      );
      if (record !== undefined) {
        return immutable(
          {
            releasedThroughSequence,
            turn: record.turn,
            eventContext: record.payload,
          },
          "premiere released interaction context",
        );
      }
    }
    throw runtimeIntegrity("released_sequence_missing_from_frozen_drafts");
  }

  nextWakeAt(): string | null {
    if (this.recoveredReveal !== null) return null;
    return nextRuntimeWakeAt(this.state, this.gate, this.drafts);
  }

  async synchronize(): Promise<ReplayPremiereRuntimeAdvance> {
    return this.runExclusive(async () => this.synchronizeUnlocked());
  }

  async beginOutage(): Promise<void> {
    return this.runExclusive(async () => {
      const now = this.clockTimestamp();
      if (
        this.recoveredReveal !== null ||
        this.state.lifecycle.state === "failed" ||
        this.state.lifecycle.state === "cancelled" ||
        this.state.lifecycle.state === "archived" ||
        this.state.outageStartedAt !== null
      ) {
        throw runtimeRequest("outage_cannot_start_in_current_state");
      }
      // Reserve both durable slots for the explicit begin/recovery pair.
      if (this.currentOutageEventCount() !== 0) {
        throw runtimeRequest("outage_transition_limit_exceeded");
      }
      const next = immutable(
        { ...this.state, outageStartedAt: now, lastObservedAt: now },
        "premiere outage started state",
      );
      await this.persistRuntimeState(
        next,
        "premiere_runtime_outage_started",
        `runtime:outage:${this.gate.publicationCommitmentHash}:begin:${this.state.lifecycle.version}`,
        now,
      );
    });
  }

  async endOutage(): Promise<void> {
    return this.runExclusive(async () => {
      const now = this.clockTimestamp();
      if (this.state.outageStartedAt === null) {
        throw runtimeRequest("no_active_outage");
      }
      await this.recoverOutageUnlocked(this.state.outageStartedAt, now);
    });
  }

  async cancel(): Promise<void> {
    return this.runExclusive(async () => {
      const now = this.clockTimestamp();
      const transition = transitionPremiereLifecycle(this.state.lifecycle, {
        action: "cancel",
        actor: "operator",
        occurredAt: now,
        reasonCode: "cancelled_by_operator",
      });
      const next = immutable<ReplayPremiereRuntimeSnapshotV1>(
        {
          ...this.state,
          lifecycle: transition.snapshot,
          outageStartedAt: null,
          lastObservedAt: now,
        },
        "premiere cancelled runtime state",
      );
      await this.persistRuntimeState(
        next,
        "premiere_runtime_cancelled",
        `runtime:cancel:${this.gate.publicationCommitmentHash}`,
        now,
      );
    });
  }

  async archive(): Promise<void> {
    return this.runExclusive(async () => {
      if (
        this.recoveredReveal === null &&
        (this.state.lifecycle.state === "failed" ||
          this.state.lifecycle.state === "cancelled")
      ) {
        const now = this.clockTimestamp();
        const transition = transitionPremiereLifecycle(this.state.lifecycle, {
          action: "archive",
          actor: "operator",
          occurredAt: now,
        });
        const next = immutable<ReplayPremiereRuntimeSnapshotV1>(
          {
            ...this.state,
            lifecycle: transition.snapshot,
            outageStartedAt: null,
            lastObservedAt: now,
          },
          "premiere terminal archive runtime state",
        );
        await this.persistRuntimeState(
          next,
          "premiere_runtime_terminal_archived",
          `runtime:archive:${this.gate.publicationCommitmentHash}`,
          now,
        );
        return;
      }
      if (
        this.recoveredReveal === null ||
        this.recoveredReveal.lifecycle.state !== "revealed"
      ) {
        throw runtimeRequest("archive_requires_revealed_state");
      }
      const now = this.clockTimestamp();
      const transition = transitionPremiereLifecycle(
        this.recoveredReveal.lifecycle,
        { action: "archive", actor: "operator", occurredAt: now },
      );
      const payload = immutable<ReplayPremiereArchivePayloadV1>(
        {
          schemaVersion: 1,
          runtimeKind: "replay_premiere_archive_v1",
          premiereId: this.premiereId,
          publicationCommitmentHash: this.gate.publicationCommitmentHash,
          revealCommitHash: this.recoveredReveal.reveal.revealCommitHash,
          lifecycle: transition.snapshot,
        },
        "premiere archive payload",
      );
      await this.persistence.appendAndSnapshot({
        event: {
          aggregateId: this.premiereId,
          eventType: "premiere_runtime_archived",
          occurredAt: now,
          payload: asJson(payload),
        },
        state: asJson(payload),
        idempotencyKey: `runtime:archive:${this.gate.publicationCommitmentHash}`,
      });
      this.recoveredReveal = {
        ...this.recoveredReveal,
        lifecycle: immutable(transition.snapshot, "archived lifecycle"),
      };
    });
  }

  private static async create(options: {
    gate: VerifiedPremiereEligibilityGate;
    drafts: readonly PremiereChunkDraft[];
    checkpointProjection: ReplayPremiereCheckpointProjection;
    persistence: ReplayPremiereRuntimePersistence;
    clock: ReplayPremiereRuntimeClock;
    interactions: ReplayPremiereInteractions;
  }): Promise<ReplayPremiereRuntimeCoordinator> {
    const now = canonicalTimestamp(options.clock.now(), null);
    let lifecycle = createDraftPremiereLifecycle({
      premiereId: options.gate.premiereId,
      createdAt: now,
    });
    lifecycle = transitionPremiereLifecycle(lifecycle, {
      action: "publish",
      actor: "operator",
      occurredAt: now,
      gate: options.gate,
    }).snapshot;
    const state = immutable<ReplayPremiereRuntimeSnapshotV1>(
      {
        schemaVersion: 1,
        runtimeKind: "replay_premiere_runtime_v1",
        premiereId: options.gate.premiereId,
        publicationCommitmentHash: options.gate.publicationCommitmentHash,
        lifecycle,
        actualStartAt: null,
        scheduleShiftMs: 0,
        accumulatedPauseMs: 0,
        activeCheckpoint: null,
        completedCheckpointIds: [],
        outageStartedAt: null,
        lastObservedAt: now,
        nextDraftIndex: 0,
        releasedChunks: [],
        interactionCheckpoints: options.interactions.readState().checkpoints,
      },
      "initial premiere runtime state",
    );
    validateRuntimeSnapshot(
      state,
      options.gate,
      options.drafts,
      options.checkpointProjection,
    );
    await options.persistence.appendAndSnapshot({
      event: {
        aggregateId: options.gate.premiereId,
        eventType: "premiere_runtime_initialized",
        occurredAt: now,
        payload: asJson(state),
      },
      state: asJson(state),
      idempotencyKey: `runtime:init:${options.gate.publicationCommitmentHash}`,
    });
    const publication = publicationFromRuntimeState(
      options.gate,
      state,
      options.drafts,
    );
    return new ReplayPremiereRuntimeCoordinator({
      ...options,
      state,
      publication,
      recoveredReveal: null,
      outageEventsByLifecycleVersion: new Map(),
    });
  }

  private static async recover(
    options: {
      gate: VerifiedPremiereEligibilityGate;
      drafts: readonly PremiereChunkDraft[];
      checkpointProjection: ReplayPremiereCheckpointProjection;
      persistence: ReplayPremiereRuntimePersistence;
      clock: ReplayPremiereRuntimeClock;
      interactions: ReplayPremiereInteractions;
    },
    aggregateEvents: readonly StoredReplayPremiereEvent[],
  ): Promise<ReplayPremiereRuntimeCoordinator> {
    const latestAggregateEvent = aggregateEvents.at(-1);
    if (latestAggregateEvent === undefined) {
      throw runtimeIntegrity("missing_runtime_recovery_event");
    }
    const snapshot = await options.persistence.readSnapshot(
      options.gate.premiereId,
    );
    validateRecoverySnapshot(snapshot, aggregateEvents);
    const runtimeEvents = aggregateEvents.filter((event) =>
      runtimeEventTypes.has(event.eventType),
    );
    validateAggregateEventOrder(aggregateEvents);
    if (runtimeEvents.length === 0) {
      throw runtimeIntegrity("runtime_initialization_event_missing");
    }
    let previous: ReplayPremiereRuntimeSnapshotV1 | null = null;
    for (const [index, event] of runtimeEvents.entries()) {
      const recovered = parseRuntimeSnapshot(event.payload);
      validateRuntimeSnapshot(
        recovered,
        options.gate,
        options.drafts,
        options.checkpointProjection,
        { recoverReleasedPrefix: false },
      );
      validateRuntimeEventEnvelope(event, recovered);
      validateRuntimeEventSemantics(
        event,
        previous,
        recovered,
        index,
        options.gate,
        options.drafts,
      );
      if (previous !== null) validateRuntimeProgression(previous, recovered);
      previous = recovered;
    }
    if (previous === null) throw runtimeIntegrity("runtime_state_missing");
    const outageEventsByLifecycleVersion =
      recoverOutageEventsByLifecycleVersion(runtimeEvents);
    if (
      hashReplayPremiereCheckpointSchedule(
        options.interactions.readState().checkpoints,
      ) !==
      hashReplayPremiereCheckpointSchedule(previous.interactionCheckpoints)
    ) {
      throw runtimeIntegrity("interaction_checkpoint_recovery_mismatch");
    }
    const reveal = recoverCommittedReveal(
      aggregateEvents,
      options.gate.premiereId,
      options.gate,
      previous.lifecycle,
      previous.releasedChunks,
      options.drafts,
    );
    if (reveal !== null) {
      const archiveEvents = aggregateEvents.filter(
        (event) => event.eventType === "premiere_runtime_archived",
      );
      if (archiveEvents.length > 1) {
        throw runtimeIntegrity("duplicate_archive_events");
      }
      let lifecycle = reveal.lifecycle;
      if (archiveEvents.length === 1) {
        lifecycle = validateRecoveredArchive(
          archiveEvents[0],
          reveal.lifecycle,
          reveal.reveal,
          options.gate,
        );
      }
      if (
        latestAggregateEvent.eventType !==
        (archiveEvents.length === 1
          ? "premiere_runtime_archived"
          : "premiere_reveal_committed")
      ) {
        throw runtimeIntegrity("reveal_not_latest_runtime_operation");
      }
      const coordinator = new ReplayPremiereRuntimeCoordinator({
        ...options,
        state: previous,
        publication: null,
        recoveredReveal: {
          lifecycle,
          pointer: reveal.pointer,
          reveal: reveal.reveal,
          chunks: new Map(
            reveal.releasedChunks.map((chunk) => [chunk.index, chunk]),
          ),
        },
        outageEventsByLifecycleVersion,
      });
      await repairRecoverySnapshotIfStale(
        snapshot,
        latestAggregateEvent,
        options.persistence,
      );
      coordinator.clockTimestamp();
      return coordinator;
    }
    if (latestAggregateEvent !== runtimeEvents.at(-1)) {
      throw runtimeIntegrity("unknown_latest_runtime_event");
    }
    const coordinator = new ReplayPremiereRuntimeCoordinator({
      ...options,
      state: previous,
      publication: publicationFromRuntimeState(
        options.gate,
        previous,
        options.drafts,
      ),
      recoveredReveal: null,
      outageEventsByLifecycleVersion,
    });
    await repairRecoverySnapshotIfStale(
      snapshot,
      latestAggregateEvent,
      options.persistence,
    );
    await coordinator.recoverAvailabilityGap();
    return coordinator;
  }

  private async synchronizeUnlocked(): Promise<ReplayPremiereRuntimeAdvance> {
    const operations: ReplayPremiereRuntimeAdvance["operations"] = [];
    if (
      this.recoveredReveal !== null ||
      this.state.lifecycle.state === "failed" ||
      this.state.lifecycle.state === "cancelled" ||
      this.state.lifecycle.state === "archived"
    ) {
      this.clockTimestamp();
      return this.advanceResult(operations);
    }
    const now = this.clockTimestamp();
    if (this.state.outageStartedAt !== null) {
      if (
        this.state.lifecycle.state !== "scheduled" &&
        Date.parse(now) - Date.parse(this.state.outageStartedAt) >
          REPLAY_PREMIERE_MAX_RECOVERABLE_OUTAGE_MS
      ) {
        await this.failRuntime(now, "outage_exceeded");
        operations.push("failed");
      }
      return this.advanceResult(operations);
    }
    const operationCeiling = this.drafts.length + 8;
    for (let operation = 0; operation < operationCeiling; operation += 1) {
      if (this.state.lifecycle.state === "scheduled") {
        if (Date.parse(now) < this.effectiveScheduledAtMs()) break;
        const lifecycle = transitionPremiereLifecycle(this.state.lifecycle, {
          action: "start",
          actor: "service",
          occurredAt: now,
          serviceReady: true,
        }).snapshot;
        const next = immutable(
          { ...this.state, lifecycle, actualStartAt: now, lastObservedAt: now },
          "premiere runtime started state",
        );
        await this.persistRuntimeState(
          next,
          "premiere_runtime_started",
          `runtime:start:${this.gate.publicationCommitmentHash}`,
          now,
        );
        operations.push("started");
        continue;
      }
      if (this.state.lifecycle.state === "checkpoint") {
        const active = this.state.activeCheckpoint;
        if (active === null) throw runtimeIntegrity("checkpoint_state_missing");
        if (Date.parse(now) < Date.parse(active.closesAt)) break;
        const lifecycle = transitionPremiereLifecycle(this.state.lifecycle, {
          action: "resume",
          actor: "service",
          occurredAt: now,
        }).snapshot;
        const preparedInteraction = this.interactions.prepareCloseCheckpoint(
          active.id,
          now,
        );
        const next = immutable<ReplayPremiereRuntimeSnapshotV1>(
          {
            ...this.state,
            lifecycle,
            accumulatedPauseMs:
              this.state.accumulatedPauseMs +
              (Date.parse(active.closesAt) - Date.parse(active.opensAt)),
            activeCheckpoint: null,
            completedCheckpointIds: [
              ...this.state.completedCheckpointIds,
              active.id,
            ],
            lastObservedAt: now,
            interactionCheckpoints: preparedInteraction.nextState.checkpoints,
          },
          "premiere checkpoint resumed state",
        );
        await this.persistRuntimeState(
          next,
          "premiere_runtime_checkpoint_resumed",
          `runtime:checkpoint:${active.id}:resume`,
          now,
          preparedInteraction,
        );
        operations.push("checkpoint_resumed");
        continue;
      }
      if (this.state.lifecycle.state !== "playing") break;
      const draft = this.drafts[this.state.nextDraftIndex];
      if (draft === undefined) {
        throw runtimeIntegrity("playing_without_remaining_draft");
      }
      const elapsed = authoritativeElapsedAt(this.state, now);
      if (draft.descriptor.presentationOffsetMs > elapsed) break;
      const previous = this.lastReleasedChunk();
      if (draft.descriptor.terminal) {
        await this.commitTerminalReveal(draft, previous, elapsed, now);
        operations.push("revealed");
        break;
      }
      const released = this.gate.releaseNonTerminalChunk({
        draft,
        releasedAt: now,
        previousChunk: previous,
        authoritativeElapsedMs: elapsed,
      });
      const publicChunk = toPremierePublicChunkResponse(released, this.gate);
      let lifecycle = this.state.lifecycle;
      for (
        let sequence = released.descriptor.startSequence;
        sequence <= released.descriptor.endSequence;
        sequence += 1
      ) {
        lifecycle = recordSafeReleasedSequence(lifecycle, sequence, now);
      }
      let activeCheckpoint: PremierePublicCheckpoint | null = null;
      let preparedInteraction:
        | ReplayPremierePreparedInteractionTransition<unknown>
        | undefined;
      const checkpoint = this.nextCheckpoint();
      let eventType = "premiere_runtime_chunk_released";
      if (
        checkpoint !== null &&
        checkpoint.sequence === released.descriptor.endSequence
      ) {
        const projectedCheckpoint = this.checkpointProjection.checkpoints.find(
          (candidate) =>
            candidate.id === checkpoint.id &&
            candidate.sequence === checkpoint.sequence,
        );
        if (projectedCheckpoint === undefined) {
          throw runtimeIntegrity("checkpoint_option_projection_missing");
        }
        lifecycle = transitionPremiereLifecycle(lifecycle, {
          action: "open_checkpoint",
          actor: "service",
          occurredAt: now,
        }).snapshot;
        activeCheckpoint = {
          id: checkpoint.id,
          sequence: checkpoint.sequence,
          opensAt: now,
          closesAt: new Date(
            Date.parse(now) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
          ).toISOString(),
          questionKind: "winner_from_here",
          optionSeatIds: [...projectedCheckpoint.optionSeatIds],
          state: "open",
        };
        preparedInteraction = this.interactions.prepareOpenCheckpoint({
          checkpointId: activeCheckpoint.id,
          opensAt: activeCheckpoint.opensAt,
          closesAt: activeCheckpoint.closesAt,
          optionSeatIds: activeCheckpoint.optionSeatIds,
        });
        eventType = "premiere_runtime_chunk_released";
      }
      const next = immutable<ReplayPremiereRuntimeSnapshotV1>(
        {
          ...this.state,
          lifecycle,
          activeCheckpoint,
          lastObservedAt: now,
          nextDraftIndex: this.state.nextDraftIndex + 1,
          releasedChunks: [
            ...this.state.releasedChunks,
            descriptorFromPublic(publicChunk),
          ],
          interactionCheckpoints:
            preparedInteraction?.nextState.checkpoints ??
            this.interactions.readState().checkpoints,
        },
        "premiere chunk released state",
      );
      await this.persistRuntimeState(
        next,
        eventType,
        `runtime:release:${this.gate.publicationCommitmentHash}:${publicChunk.index}`,
        now,
        preparedInteraction,
        publicChunk,
      );
      operations.push("chunk_released");
      if (activeCheckpoint !== null) {
        operations.push("checkpoint_opened");
        break;
      }
    }
    return this.advanceResult(operations);
  }

  private async commitTerminalReveal(
    draft: PremiereChunkDraft,
    previous: ReleasedPremiereChunk | null,
    elapsed: number,
    now: string,
  ): Promise<void> {
    if (this.publication === null) {
      throw runtimeIntegrity("missing_atomic_publication_for_reveal");
    }
    const terminal: VerifiedPremiereTerminalChunk =
      this.gate.prepareTerminalChunk({
        draft,
        releasedAt: now,
        previousChunk: previous,
        authoritativeElapsedMs: elapsed,
      });
    const result = await this.publication.commitReveal(this.persistence, {
      lockedLifecycle: this.state.lifecycle,
      terminal,
    });
    const chunks = new Map<number, PremierePublicChunkResponse>();
    for (const descriptor of this.state.releasedChunks) {
      const chunk = this.publication.readChunk(descriptor.index);
      if (chunk === null) {
        throw runtimeIntegrity("revealed_publication_prefix_missing");
      }
      chunks.set(chunk.index, chunk);
    }
    chunks.set(result.terminalChunk.index, result.terminalChunk);
    this.recoveredReveal = {
      lifecycle: result.lifecycle,
      pointer: result.pointer,
      reveal: result.reveal,
      chunks,
    };
  }

  private async recoverAvailabilityGap(): Promise<void> {
    const now = this.clockTimestamp();
    if (this.state.outageStartedAt !== null) {
      await this.recoverOutageUnlocked(this.state.outageStartedAt, now);
      return;
    }
    const wakeAt = nextRuntimeWakeAt(this.state, this.gate, this.drafts);
    if (wakeAt === null || Date.parse(now) <= Date.parse(wakeAt)) return;
    // A late scheduled runtime starts at the readiness-time synchronize call
    // performed by startup. Persisting schedule-shift recoveries here would
    // allow unbounded same-version events across repeated prestart crashes.
    if (this.state.lifecycle.state === "scheduled") return;
    await this.applyRecoveredDowntime(wakeAt, now);
  }

  private async recoverOutageUnlocked(
    outageStartedAt: string,
    recoveredAt: string,
  ): Promise<void> {
    if (Date.parse(recoveredAt) < Date.parse(outageStartedAt)) {
      throw runtimeIntegrity("outage_recovery_clock_rollback");
    }
    await this.applyRecoveredDowntime(outageStartedAt, recoveredAt);
  }

  private async applyRecoveredDowntime(
    outageStartedAt: string,
    recoveredAt: string,
  ): Promise<void> {
    if (
      this.currentOutageEventCount() >=
      REPLAY_PREMIERE_MAX_OUTAGE_EVENTS_PER_LIFECYCLE_VERSION
    ) {
      if (
        this.state.lifecycle.state === "playing" ||
        this.state.lifecycle.state === "checkpoint"
      ) {
        await this.failRuntime(recoveredAt, "runtime_failure");
        return;
      }
      throw runtimeIntegrity("outage_transition_limit_exceeded");
    }
    const durationMs = Date.parse(recoveredAt) - Date.parse(outageStartedAt);
    if (
      this.state.lifecycle.state !== "scheduled" &&
      durationMs > REPLAY_PREMIERE_MAX_RECOVERABLE_OUTAGE_MS
    ) {
      await this.failRuntime(recoveredAt, "outage_exceeded");
      return;
    }
    let activeCheckpoint = this.state.activeCheckpoint;
    let scheduleShiftMs = this.state.scheduleShiftMs;
    let accumulatedPauseMs = this.state.accumulatedPauseMs;
    let preparedInteraction:
      | ReplayPremierePreparedInteractionTransition<unknown>
      | undefined;
    if (this.state.lifecycle.state === "scheduled") {
      scheduleShiftMs += durationMs;
    } else {
      if (activeCheckpoint !== null) {
        const interactionCheckpoint = this.interactions
          .readState()
          .checkpoints.find(
            (checkpoint) => checkpoint.id === activeCheckpoint?.id,
          );
        if (
          interactionCheckpoint === undefined ||
          interactionCheckpoint.outageShiftMs + durationMs >
            REPLAY_PREMIERE_MAX_RECOVERABLE_OUTAGE_MS
        ) {
          await this.failRuntime(recoveredAt, "outage_exceeded");
          return;
        }
        preparedInteraction =
          this.interactions.prepareShiftOpenCheckpointForOutage({
            checkpointId: activeCheckpoint.id,
            outageMs: durationMs,
            occurredAt: recoveredAt,
          });
        activeCheckpoint = {
          ...activeCheckpoint,
          closesAt: new Date(
            Date.parse(activeCheckpoint.closesAt) + durationMs,
          ).toISOString(),
        };
      } else {
        accumulatedPauseMs += durationMs;
      }
    }
    const next = immutable<ReplayPremiereRuntimeSnapshotV1>(
      {
        ...this.state,
        scheduleShiftMs,
        accumulatedPauseMs,
        activeCheckpoint,
        outageStartedAt: null,
        lastObservedAt: recoveredAt,
        interactionCheckpoints:
          preparedInteraction?.nextState.checkpoints ??
          this.interactions.readState().checkpoints,
      },
      "premiere recovered outage state",
    );
    await this.persistRuntimeState(
      next,
      "premiere_runtime_outage_recovered",
      `runtime:outage:${this.gate.publicationCommitmentHash}:recover:${this.state.lifecycle.version}:${Date.parse(outageStartedAt)}`,
      recoveredAt,
      preparedInteraction,
    );
  }

  private async failRuntime(
    occurredAt: string,
    reasonCode: "outage_exceeded" | "runtime_failure" | "integrity_failure",
  ): Promise<void> {
    if (
      this.state.lifecycle.state !== "playing" &&
      this.state.lifecycle.state !== "checkpoint"
    ) {
      throw runtimeIntegrity("runtime_failure_outside_failable_state");
    }
    const lifecycle = transitionPremiereLifecycle(this.state.lifecycle, {
      action: "fail",
      actor: "service",
      occurredAt,
      reasonCode,
    }).snapshot;
    const preparedInteraction =
      this.state.activeCheckpoint === null
        ? undefined
        : this.interactions.prepareCloseCheckpoint(
            this.state.activeCheckpoint.id,
            occurredAt,
          );
    const next = immutable<ReplayPremiereRuntimeSnapshotV1>(
      {
        ...this.state,
        lifecycle,
        activeCheckpoint: null,
        completedCheckpointIds:
          this.state.activeCheckpoint === null
            ? this.state.completedCheckpointIds
            : [
                ...this.state.completedCheckpointIds,
                this.state.activeCheckpoint.id,
              ],
        outageStartedAt: null,
        lastObservedAt: occurredAt,
        interactionCheckpoints:
          preparedInteraction?.nextState.checkpoints ??
          this.interactions.readState().checkpoints,
      },
      "premiere failed runtime state",
    );
    await this.persistRuntimeState(
      next,
      "premiere_runtime_failed",
      `runtime:fail:${this.gate.publicationCommitmentHash}:${lifecycle.version}`,
      occurredAt,
      preparedInteraction,
    );
  }

  private async persistRuntimeState(
    next: ReplayPremiereRuntimeSnapshotV1,
    eventType: string,
    idempotencyKey: string,
    occurredAt: string,
    preparedInteraction?: ReplayPremierePreparedInteractionTransition<unknown>,
    releasedChunk?: PremierePublicChunkResponse,
  ): Promise<void> {
    validateRuntimeSnapshot(
      next,
      this.gate,
      this.drafts,
      this.checkpointProjection,
      { recoverReleasedPrefix: false },
    );
    if (this.publication === null) {
      throw runtimeIntegrity("missing_atomic_publication_for_advance");
    }
    const preparedPublication = this.publication.preparePreRevealAdvance({
      lifecycle: publicationLifecycleFromRuntimeState(next),
      manifest: manifestFromRuntimeState(next, this.gate),
      ...(releasedChunk === undefined ? {} : { releasedChunk }),
    });
    const outageEventCount =
      eventType === "premiere_runtime_outage_started" ||
      eventType === "premiere_runtime_outage_recovered"
        ? {
            version: next.lifecycle.version,
            count:
              (this.outageEventsByLifecycleVersion.get(
                next.lifecycle.version,
              ) ?? 0) + 1,
          }
        : null;
    if (
      outageEventCount !== null &&
      outageEventCount.count >
        REPLAY_PREMIERE_MAX_OUTAGE_EVENTS_PER_LIFECYCLE_VERSION
    ) {
      throw runtimeIntegrity("outage_transition_limit_exceeded");
    }
    try {
      await this.persistence.appendAndSnapshot({
        event: {
          aggregateId: this.premiereId,
          eventType,
          occurredAt,
          payload: asJson(next),
        },
        state: asJson(next),
        idempotencyKey,
      });
      preparedInteraction?.commit();
      preparedPublication.commit();
    } catch (error) {
      preparedInteraction?.abort();
      preparedPublication.abort();
      throw error;
    }
    if (outageEventCount !== null) {
      this.outageEventsByLifecycleVersion.set(
        outageEventCount.version,
        outageEventCount.count,
      );
    }
    this.state = immutable(next, "durable premiere runtime state");
  }

  private nextCheckpoint(): { id: string; sequence: number } | null {
    const definition = this.gate.publicDefinition();
    return (
      definition.checkpoints.find(
        (checkpoint) =>
          !this.state.completedCheckpointIds.includes(checkpoint.id) &&
          this.state.activeCheckpoint?.id !== checkpoint.id,
      ) ?? null
    );
  }

  private lastReleasedChunk(): ReleasedPremiereChunk | null {
    const last = this.state.releasedChunks.at(-1);
    if (last === undefined) return null;
    const response = this.publication?.readChunk(last.index) ?? null;
    if (response === null || response.chunkHash !== last.chunkHash) {
      throw runtimeIntegrity("last_released_chunk_missing");
    }
    return releasedChunkFromPublic(response);
  }

  private effectiveScheduledAtMs(): number {
    return (
      Date.parse(this.gate.publicDefinition().scheduledAt) +
      this.state.scheduleShiftMs
    );
  }

  private currentOutageEventCount(): number {
    return (
      this.outageEventsByLifecycleVersion.get(this.state.lifecycle.version) ?? 0
    );
  }

  private currentLifecycle(): PremiereLifecycleSnapshot {
    return this.recoveredReveal?.lifecycle ?? this.state.lifecycle;
  }

  private clockTimestamp(): string {
    const timestamp = canonicalTimestamp(this.clock.now(), null);
    if (
      Date.parse(timestamp) < Date.parse(this.currentLifecycle().updatedAt) ||
      Date.parse(timestamp) < Date.parse(this.state.lastObservedAt) ||
      Date.parse(timestamp) < this.lastClockObservedAtMs
    ) {
      throw runtimeIntegrity("authoritative_clock_rollback");
    }
    this.lastClockObservedAtMs = Date.parse(timestamp);
    return timestamp;
  }

  private advanceResult(
    operations: ReplayPremiereRuntimeAdvance["operations"],
  ): ReplayPremiereRuntimeAdvance {
    return immutable(
      {
        state: this.readLifecycleState(),
        operations,
        nextWakeAt: this.nextWakeAt(),
      },
      "premiere runtime advance result",
    );
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: (() => void) | undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

export class ReplayPremiereRuntimeRegistry {
  private readonly runtimes = new Map<
    string,
    ReplayPremiereRuntimeCoordinator
  >();

  register(runtime: ReplayPremiereRuntimeCoordinator): void {
    const existing = this.runtimes.get(runtime.premiereId);
    if (existing !== undefined && existing !== runtime) {
      throw runtimeRequest("premiere_runtime_already_registered");
    }
    this.runtimes.set(runtime.premiereId, runtime);
  }

  unregister(runtime: ReplayPremiereRuntimeCoordinator): void {
    if (this.runtimes.get(runtime.premiereId) === runtime) {
      this.runtimes.delete(runtime.premiereId);
    }
  }

  get(premiereId: string): ReplayPremiereRuntimeCoordinator | null {
    return this.runtimes.get(premiereId) ?? null;
  }

  async synchronizeAll(): Promise<ReplayPremiereRuntimeAdvance[]> {
    const ordered = [...this.runtimes.values()].sort((left, right) =>
      left.premiereId.localeCompare(right.premiereId),
    );
    const results: ReplayPremiereRuntimeAdvance[] = [];
    for (const runtime of ordered) results.push(await runtime.synchronize());
    return results;
  }
}

function publicationFromRuntimeState(
  gate: VerifiedPremiereEligibilityGate,
  state: ReplayPremiereRuntimeSnapshotV1,
  drafts: readonly PremiereChunkDraft[],
): ReplayPremiereAtomicPublication {
  const releasedChunks = releasedPrefixFromRuntimeState(state, drafts);
  return ReplayPremiereAtomicPublication.recover({
    gate,
    lifecycle: publicationLifecycleFromRuntimeState(state),
    manifest: manifestFromRuntimeState(state, gate),
    releasedChunks,
  });
}

function manifestFromRuntimeState(
  state: ReplayPremiereRuntimeSnapshotV1,
  gate: VerifiedPremiereEligibilityGate,
  options: { projectExpiredCheckpoint?: boolean } = {},
): PremierePreRevealManifestResponse {
  const last = state.releasedChunks.at(-1) ?? null;
  const activeCheckpoint = projectedActiveCheckpoint(
    state,
    state.lastObservedAt,
  );
  const durableState = preRevealStateFromRuntimeState(state);
  const checkpointExpired =
    options.projectExpiredCheckpoint === true &&
    durableState === "checkpoint" &&
    activeCheckpoint !== null &&
    Date.parse(state.lastObservedAt) >= Date.parse(activeCheckpoint.closesAt);
  return immutable(
    {
      schemaVersion: 1,
      premiereId: state.premiereId,
      state: checkpointExpired ? "playing" : durableState,
      serverNow: state.lastObservedAt,
      scheduledAt: gate.publicDefinition().scheduledAt,
      actualStartAt: state.actualStartAt,
      playbackRate: gate.publicDefinition().playbackRate,
      authoritativeElapsedMs: authoritativeElapsedAt(
        state,
        state.lastObservedAt,
      ),
      accumulatedPauseMs: totalPausedAt(state, state.lastObservedAt),
      releasedThroughSequence: last?.endSequence ?? -1,
      lastReleasedChunkIndex: last?.index ?? -1,
      activeCheckpoint: checkpointExpired ? null : activeCheckpoint,
      provenance: createPremierePublicProvenance(gate),
      releasedChunks: state.releasedChunks,
    },
    "premiere runtime manifest",
  );
}

function preRevealStateFromRuntimeState(
  state: ReplayPremiereRuntimeSnapshotV1,
): PremierePreRevealManifestResponse["state"] {
  if (state.lifecycle.state !== "archived") {
    return state.lifecycle.state as PremierePreRevealManifestResponse["state"];
  }
  return state.lifecycle.terminalReasonCode === "cancelled_by_operator" ||
    state.lifecycle.terminalReasonCode === "source_ineligible"
    ? "cancelled"
    : "failed";
}

function publicationLifecycleFromRuntimeState(
  state: ReplayPremiereRuntimeSnapshotV1,
): PremiereLifecycleSnapshot {
  const publicState = preRevealStateFromRuntimeState(state);
  return state.lifecycle.state === publicState
    ? state.lifecycle
    : immutable(
        { ...state.lifecycle, state: publicState },
        "premiere archived publication lifecycle",
      );
}

function authoritativeElapsedAt(
  state: ReplayPremiereRuntimeSnapshotV1,
  timestamp: string,
): number {
  if (state.actualStartAt === null) return 0;
  return Math.max(
    0,
    Date.parse(timestamp) -
      Date.parse(state.actualStartAt) -
      totalPausedAt(state, timestamp),
  );
}

function totalPausedAt(
  state: ReplayPremiereRuntimeSnapshotV1,
  timestamp: string,
): number {
  const nowMs = Date.parse(timestamp);
  let total = state.accumulatedPauseMs;
  if (state.activeCheckpoint !== null) {
    const effectiveCloseMs =
      Date.parse(state.activeCheckpoint.closesAt) +
      (state.outageStartedAt === null
        ? 0
        : Math.max(0, nowMs - Date.parse(state.outageStartedAt)));
    total += Math.max(
      0,
      Math.min(nowMs, effectiveCloseMs) -
        Date.parse(state.activeCheckpoint.opensAt),
    );
  }
  if (state.outageStartedAt !== null && state.activeCheckpoint === null) {
    total += Math.max(0, nowMs - Date.parse(state.outageStartedAt));
  }
  return total;
}

function projectedActiveCheckpoint(
  state: ReplayPremiereRuntimeSnapshotV1,
  timestamp: string,
): PremierePublicCheckpoint | null {
  if (state.activeCheckpoint === null) return null;
  if (state.outageStartedAt === null) return state.activeCheckpoint;
  const outageDuration = Math.max(
    0,
    Date.parse(timestamp) - Date.parse(state.outageStartedAt),
  );
  return immutable(
    {
      ...state.activeCheckpoint,
      closesAt: new Date(
        Date.parse(state.activeCheckpoint.closesAt) + outageDuration,
      ).toISOString(),
    },
    "projected active checkpoint",
  );
}

function nextRuntimeWakeAt(
  state: ReplayPremiereRuntimeSnapshotV1,
  gate: VerifiedPremiereEligibilityGate,
  drafts: readonly PremiereChunkDraft[],
): string | null {
  if (state.outageStartedAt !== null) {
    if (state.lifecycle.state === "scheduled") return null;
    return new Date(
      Date.parse(state.outageStartedAt) +
        REPLAY_PREMIERE_MAX_RECOVERABLE_OUTAGE_MS +
        1,
    ).toISOString();
  }
  if (state.lifecycle.state === "scheduled") {
    return new Date(
      Date.parse(gate.publicDefinition().scheduledAt) + state.scheduleShiftMs,
    ).toISOString();
  }
  if (state.lifecycle.state === "checkpoint") {
    return state.activeCheckpoint?.closesAt ?? null;
  }
  if (state.lifecycle.state !== "playing" || state.actualStartAt === null) {
    return null;
  }
  const draft = drafts[state.nextDraftIndex];
  if (draft === undefined) return null;
  return new Date(
    Date.parse(state.actualStartAt) +
      state.accumulatedPauseMs +
      draft.descriptor.presentationOffsetMs,
  ).toISOString();
}

function validateRuntimeSnapshot(
  state: ReplayPremiereRuntimeSnapshotV1,
  gate: VerifiedPremiereEligibilityGate,
  drafts: readonly PremiereChunkDraft[],
  checkpointProjection: ReplayPremiereCheckpointProjection,
  options: { recoverReleasedPrefix?: boolean } = {},
): void {
  assertReplayPremiereCheckpointProjection({
    projection: checkpointProjection,
    gate,
  });
  assertExactKeys(state as unknown as Record<string, unknown>, [
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
  ]);
  assertValidPremiereLifecycleSnapshot(state.lifecycle);
  if (
    state.schemaVersion !== 1 ||
    state.runtimeKind !== "replay_premiere_runtime_v1" ||
    state.premiereId !== gate.premiereId ||
    state.publicationCommitmentHash !== gate.publicationCommitmentHash ||
    !gate.matchesLifecycleBinding(state.lifecycle) ||
    !isNonNegativeInteger(state.scheduleShiftMs) ||
    !isNonNegativeInteger(state.accumulatedPauseMs) ||
    !isNonNegativeInteger(state.nextDraftIndex) ||
    state.nextDraftIndex !== state.releasedChunks.length ||
    state.nextDraftIndex >= drafts.length ||
    canonicalTimestamp(state.lastObservedAt, null) !== state.lastObservedAt ||
    (state.actualStartAt !== null &&
      canonicalTimestamp(state.actualStartAt, null) !== state.actualStartAt) ||
    (state.outageStartedAt !== null &&
      canonicalTimestamp(state.outageStartedAt, null) !==
        state.outageStartedAt) ||
    !Array.isArray(state.completedCheckpointIds) ||
    new Set(state.completedCheckpointIds).size !==
      state.completedCheckpointIds.length ||
    !Array.isArray(state.releasedChunks) ||
    state.releasedChunks.some((chunk) => chunk.terminal) ||
    !Array.isArray(state.interactionCheckpoints)
  ) {
    throw runtimeIntegrity("invalid_runtime_snapshot");
  }
  const checkpoints = gate.publicDefinition().checkpoints;
  const interactionCheckpoints = state.interactionCheckpoints;
  const authoritativeElapsedMs = authoritativeElapsedAt(
    state,
    state.lastObservedAt,
  );
  if (
    state.completedCheckpointIds.some(
      (id, index) => id !== checkpoints[index]?.id,
    ) ||
    (state.lifecycle.state === "scheduled" && state.actualStartAt !== null) ||
    ((state.lifecycle.state === "playing" ||
      state.lifecycle.state === "checkpoint") &&
      state.actualStartAt === null) ||
    (state.lifecycle.state === "checkpoint") !==
      (state.activeCheckpoint !== null) ||
    interactionCheckpoints.length !== checkpoints.length ||
    interactionCheckpoints.some(
      (checkpoint, index) =>
        checkpoint.id !== checkpoints[index]?.id ||
        checkpoint.sequence !== checkpoints[index]?.sequence,
    )
  ) {
    throw runtimeIntegrity("invalid_runtime_state_specific_fields");
  }
  if (state.activeCheckpoint !== null) {
    const expected = checkpoints[state.completedCheckpointIds.length];
    const projected =
      checkpointProjection.checkpoints[state.completedCheckpointIds.length];
    const interaction =
      interactionCheckpoints[state.completedCheckpointIds.length];
    if (
      expected === undefined ||
      projected === undefined ||
      state.activeCheckpoint.id !== expected.id ||
      state.activeCheckpoint.sequence !== expected.sequence ||
      !sameStringArray(
        state.activeCheckpoint.optionSeatIds,
        projected.optionSeatIds,
      ) ||
      Date.parse(state.activeCheckpoint.closesAt) -
        Date.parse(state.activeCheckpoint.opensAt) !==
        REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS +
          (interaction?.outageShiftMs ?? -1) ||
      state.releasedChunks.at(-1)?.endSequence !== expected.sequence ||
      state.activeCheckpoint.state !== "open" ||
      interaction?.state !== "open" ||
      interaction.opensAt !== state.activeCheckpoint.opensAt ||
      interaction.closesAt !== state.activeCheckpoint.closesAt ||
      !sameStringArray(interaction.optionSeatIds, projected.optionSeatIds)
    ) {
      throw runtimeIntegrity("invalid_active_checkpoint");
    }
  }
  for (const [index, checkpoint] of interactionCheckpoints.entries()) {
    const expectedState =
      index < state.completedCheckpointIds.length
        ? "closed"
        : index === state.completedCheckpointIds.length &&
            state.activeCheckpoint !== null
          ? "open"
          : "upcoming";
    const projected = checkpointProjection.checkpoints[index];
    const expectedOptions =
      expectedState === "upcoming" ? [] : projected?.optionSeatIds;
    if (
      checkpoint.state !== expectedState ||
      expectedOptions === undefined ||
      !sameStringArray(checkpoint.optionSeatIds, expectedOptions)
    ) {
      throw runtimeIntegrity("runtime_interaction_checkpoint_mismatch");
    }
  }
  if (options.recoverReleasedPrefix !== false) {
    recoverReleasedPrefixFromRuntimeState(state, gate, drafts);
  }
  const lastSequence = state.releasedChunks.at(-1)?.endSequence ?? -1;
  if (state.lifecycle.lastSafeReleasedSequence !== lastSequence) {
    throw runtimeIntegrity("runtime_lifecycle_prefix_mismatch");
  }
  for (const [index, chunk] of state.releasedChunks.entries()) {
    const draft = drafts[index];
    if (
      draft === undefined ||
      chunk.index !== index ||
      chunk.startSequence !== draft.descriptor.startSequence ||
      chunk.endSequence !== draft.descriptor.endSequence ||
      chunk.presentationOffsetMs !== draft.descriptor.presentationOffsetMs ||
      chunk.presentationOffsetMs > authoritativeElapsedMs
    ) {
      throw runtimeIntegrity("runtime_released_prefix_mismatch");
    }
  }
}

function validateRuntimeProgression(
  previous: ReplayPremiereRuntimeSnapshotV1,
  next: ReplayPremiereRuntimeSnapshotV1,
): void {
  if (
    next.lifecycle.version < previous.lifecycle.version ||
    Date.parse(next.lastObservedAt) < Date.parse(previous.lastObservedAt) ||
    next.nextDraftIndex < previous.nextDraftIndex ||
    next.nextDraftIndex > previous.nextDraftIndex + 1 ||
    next.releasedChunks
      .slice(0, previous.releasedChunks.length)
      .some(
        (chunk, index) =>
          hashReplayPremiereJson(asJson(chunk)) !==
          hashReplayPremiereJson(asJson(previous.releasedChunks[index])),
      )
  ) {
    throw runtimeIntegrity("invalid_runtime_recovery_progression");
  }
}

function validateRuntimeEventEnvelope(
  event: StoredReplayPremiereEvent,
  state: ReplayPremiereRuntimeSnapshotV1,
): void {
  if (
    event.occurredAt !== state.lastObservedAt ||
    event.idempotencyKey === null ||
    event.idempotencyStateHash !== hashReplayPremiereJson(event.payload)
  ) {
    throw runtimeIntegrity("runtime_event_envelope_mismatch");
  }
}

function validateRuntimeEventSemantics(
  event: StoredReplayPremiereEvent,
  previous: ReplayPremiereRuntimeSnapshotV1 | null,
  state: ReplayPremiereRuntimeSnapshotV1,
  runtimeEventIndex: number,
  gate: VerifiedPremiereEligibilityGate,
  drafts: readonly PremiereChunkDraft[],
): void {
  const commitmentHash = state.publicationCommitmentHash;
  let expectedIdempotencyKey: string;
  let expectedLifecycleVersion: number;
  let expectedLifecycleState: PremiereState;
  let expectedNextDraftIndex: number;
  let lifecycleMustAdvance = true;

  switch (event.eventType) {
    case "premiere_runtime_initialized":
      if (previous !== null || runtimeEventIndex !== 0) {
        throw runtimeIntegrity("initialization_event_out_of_order");
      }
      expectedIdempotencyKey = `runtime:init:${commitmentHash}`;
      expectedLifecycleVersion = 1;
      expectedLifecycleState = "scheduled";
      expectedNextDraftIndex = 0;
      break;
    case "premiere_runtime_started":
      if (previous?.lifecycle.state !== "scheduled") {
        throw runtimeIntegrity("started_event_transition_mismatch");
      }
      expectedIdempotencyKey = `runtime:start:${commitmentHash}`;
      expectedLifecycleVersion = previous.lifecycle.version + 1;
      expectedLifecycleState = "playing";
      expectedNextDraftIndex = previous.nextDraftIndex;
      break;
    case "premiere_runtime_chunk_released": {
      if (previous?.lifecycle.state !== "playing") {
        throw runtimeIntegrity("release_event_transition_mismatch");
      }
      const released = state.releasedChunks.at(-1);
      if (
        released === undefined ||
        state.nextDraftIndex !== previous.nextDraftIndex + 1
      ) {
        throw runtimeIntegrity("release_event_prefix_mismatch");
      }
      expectedIdempotencyKey = `runtime:release:${commitmentHash}:${released.index}`;
      expectedLifecycleVersion =
        previous.lifecycle.version +
        (released.endSequence - released.startSequence + 1) +
        (state.lifecycle.state === "checkpoint" ? 1 : 0);
      expectedLifecycleState =
        state.lifecycle.state === "checkpoint" ? "checkpoint" : "playing";
      expectedNextDraftIndex = previous.nextDraftIndex + 1;
      break;
    }
    case "premiere_runtime_checkpoint_resumed": {
      const checkpoint = previous?.activeCheckpoint;
      if (
        previous?.lifecycle.state !== "checkpoint" ||
        checkpoint === null ||
        checkpoint === undefined
      ) {
        throw runtimeIntegrity("resume_event_transition_mismatch");
      }
      expectedIdempotencyKey = `runtime:checkpoint:${checkpoint.id}:resume`;
      expectedLifecycleVersion = previous.lifecycle.version + 1;
      expectedLifecycleState = "playing";
      expectedNextDraftIndex = previous.nextDraftIndex;
      break;
    }
    case "premiere_runtime_outage_started":
      if (previous === null || previous.outageStartedAt !== null) {
        throw runtimeIntegrity("outage_start_event_transition_mismatch");
      }
      expectedIdempotencyKey = `runtime:outage:${commitmentHash}:begin:${previous.lifecycle.version}`;
      expectedLifecycleVersion = previous.lifecycle.version;
      expectedLifecycleState = previous.lifecycle.state;
      expectedNextDraftIndex = previous.nextDraftIndex;
      lifecycleMustAdvance = false;
      if (state.outageStartedAt !== event.occurredAt) {
        throw runtimeIntegrity("outage_start_timestamp_mismatch");
      }
      break;
    case "premiere_runtime_outage_recovered": {
      if (previous === null) {
        throw runtimeIntegrity("outage_recovery_event_transition_mismatch");
      }
      const recoveryBasis =
        previous.outageStartedAt ?? nextRuntimeWakeAt(previous, gate, drafts);
      if (recoveryBasis === null) {
        throw runtimeIntegrity("outage_recovery_event_transition_mismatch");
      }
      expectedIdempotencyKey =
        `runtime:outage:${commitmentHash}:recover:${previous.lifecycle.version}:` +
        `${Date.parse(recoveryBasis)}`;
      expectedLifecycleVersion = previous.lifecycle.version;
      expectedLifecycleState = previous.lifecycle.state;
      expectedNextDraftIndex = previous.nextDraftIndex;
      lifecycleMustAdvance = false;
      if (state.outageStartedAt !== null) {
        throw runtimeIntegrity("outage_recovery_timestamp_mismatch");
      }
      break;
    }
    case "premiere_runtime_failed":
      if (
        previous?.lifecycle.state !== "playing" &&
        previous?.lifecycle.state !== "checkpoint"
      ) {
        throw runtimeIntegrity("failure_event_transition_mismatch");
      }
      expectedLifecycleVersion = previous.lifecycle.version + 1;
      expectedIdempotencyKey = `runtime:fail:${commitmentHash}:${expectedLifecycleVersion}`;
      expectedLifecycleState = "failed";
      expectedNextDraftIndex = previous.nextDraftIndex;
      break;
    case "premiere_runtime_cancelled":
      if (previous?.lifecycle.state !== "scheduled") {
        throw runtimeIntegrity("cancel_event_transition_mismatch");
      }
      expectedIdempotencyKey = `runtime:cancel:${commitmentHash}`;
      expectedLifecycleVersion = previous.lifecycle.version + 1;
      expectedLifecycleState = "cancelled";
      expectedNextDraftIndex = previous.nextDraftIndex;
      break;
    case "premiere_runtime_terminal_archived":
      if (
        previous?.lifecycle.state !== "failed" &&
        previous?.lifecycle.state !== "cancelled"
      ) {
        throw runtimeIntegrity("archive_event_transition_mismatch");
      }
      expectedIdempotencyKey = `runtime:archive:${commitmentHash}`;
      expectedLifecycleVersion = previous.lifecycle.version + 1;
      expectedLifecycleState = "archived";
      expectedNextDraftIndex = previous.nextDraftIndex;
      break;
    default:
      throw runtimeIntegrity("unknown_event_type");
  }

  if (
    event.idempotencyKey !== expectedIdempotencyKey ||
    state.lifecycle.version !== expectedLifecycleVersion ||
    state.lifecycle.state !== expectedLifecycleState ||
    state.nextDraftIndex !== expectedNextDraftIndex ||
    (lifecycleMustAdvance && state.lifecycle.updatedAt !== event.occurredAt)
  ) {
    throw runtimeIntegrity("event_semantics_mismatch");
  }
}

function recoverOutageEventsByLifecycleVersion(
  events: readonly StoredReplayPremiereEvent[],
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const event of events) {
    if (
      event.eventType !== "premiere_runtime_outage_started" &&
      event.eventType !== "premiere_runtime_outage_recovered"
    ) {
      continue;
    }
    const state = event.payload as unknown as ReplayPremiereRuntimeSnapshotV1;
    const version = state.lifecycle.version;
    const count = (counts.get(version) ?? 0) + 1;
    if (count > REPLAY_PREMIERE_MAX_OUTAGE_EVENTS_PER_LIFECYCLE_VERSION) {
      throw runtimeIntegrity("outage_transition_limit_exceeded");
    }
    counts.set(version, count);
  }
  return counts;
}

function validateRecoveredArchive(
  event: StoredReplayPremiereEvent,
  revealedLifecycle: PremiereLifecycleSnapshot,
  reveal: PremiereRevealResponse,
  gate: VerifiedPremiereEligibilityGate,
): PremiereLifecycleSnapshot {
  if (!isRecord(event.payload)) throw runtimeIntegrity("archive_not_object");
  const payload = event.payload as unknown as ReplayPremiereArchivePayloadV1;
  assertExactKeys(payload as unknown as Record<string, unknown>, [
    "schemaVersion",
    "runtimeKind",
    "premiereId",
    "publicationCommitmentHash",
    "revealCommitHash",
    "lifecycle",
  ]);
  assertValidPremiereLifecycleSnapshot(payload.lifecycle);
  if (
    payload.schemaVersion !== 1 ||
    payload.runtimeKind !== "replay_premiere_archive_v1" ||
    payload.premiereId !== gate.premiereId ||
    payload.publicationCommitmentHash !== gate.publicationCommitmentHash ||
    payload.revealCommitHash !== reveal.revealCommitHash ||
    payload.lifecycle.state !== "archived" ||
    payload.lifecycle.version !== revealedLifecycle.version + 1 ||
    payload.lifecycle.updatedAt !== event.occurredAt ||
    event.idempotencyKey !==
      `runtime:archive:${gate.publicationCommitmentHash}` ||
    event.idempotencyStateHash !== hashReplayPremiereJson(event.payload) ||
    !gate.matchesLifecycleBinding(payload.lifecycle)
  ) {
    throw runtimeIntegrity("invalid_recovered_archive");
  }
  return immutable(payload.lifecycle, "recovered archived lifecycle");
}

function parseRuntimeSnapshot(
  value: ReplayPremiereJsonValue,
): ReplayPremiereRuntimeSnapshotV1 {
  if (!isRecord(value)) throw runtimeIntegrity("runtime_snapshot_not_object");
  return immutable(
    value as unknown as ReplayPremiereRuntimeSnapshotV1,
    "recovered premiere runtime snapshot",
  );
}

function validateRecoverySnapshot(
  snapshot: ReplayPremiereSnapshot | null,
  aggregateEvents: readonly StoredReplayPremiereEvent[],
): void {
  if (snapshot === null) return;
  const anchor = aggregateEvents.find(
    (event) =>
      event.eventSequence === snapshot.lastEventSequence &&
      event.eventHash === snapshot.lastEventHash,
  );
  if (
    anchor === undefined ||
    anchor.idempotencyStateHash === null ||
    snapshot.stateHash !== hashReplayPremiereJson(snapshot.state) ||
    snapshot.stateHash !== anchor.idempotencyStateHash ||
    snapshot.stateHash !== hashReplayPremiereJson(anchor.payload)
  ) {
    throw runtimeIntegrity("snapshot_anchor_mismatch");
  }
}

function validateAggregateEventOrder(
  events: readonly StoredReplayPremiereEvent[],
): void {
  const revealIndexes: number[] = [];
  const archiveIndexes: number[] = [];
  for (const [index, event] of events.entries()) {
    if (runtimeEventTypes.has(event.eventType)) continue;
    if (event.eventType === "premiere_reveal_committed") {
      revealIndexes.push(index);
      continue;
    }
    if (event.eventType === "premiere_runtime_archived") {
      archiveIndexes.push(index);
      continue;
    }
    throw runtimeIntegrity("unknown_aggregate_event_type");
  }
  if (revealIndexes.length > 1 || archiveIndexes.length > 1) {
    throw runtimeIntegrity("duplicate_terminal_event");
  }
  const revealIndex = revealIndexes[0];
  const archiveIndex = archiveIndexes[0];
  if (
    (archiveIndex !== undefined && revealIndex === undefined) ||
    (revealIndex !== undefined &&
      revealIndex !== events.length - (archiveIndex === undefined ? 1 : 2)) ||
    (archiveIndex !== undefined && archiveIndex !== events.length - 1)
  ) {
    throw runtimeIntegrity("terminal_event_order_mismatch");
  }
}

async function repairRecoverySnapshotIfStale(
  snapshot: ReplayPremiereSnapshot | null,
  latest: StoredReplayPremiereEvent,
  persistence: ReplayPremiereRuntimePersistence,
): Promise<void> {
  if (
    snapshot?.lastEventSequence === latest.eventSequence &&
    snapshot.lastEventHash === latest.eventHash
  ) {
    return;
  }
  if (
    latest.idempotencyKey === null ||
    latest.idempotencyStateHash !== hashReplayPremiereJson(latest.payload)
  ) {
    throw runtimeIntegrity("snapshot_repair_event_mismatch");
  }
  const repaired = await persistence.appendAndSnapshot({
    event: {
      aggregateId: latest.aggregateId,
      eventType: latest.eventType,
      occurredAt: latest.occurredAt,
      payload: latest.payload,
    },
    state: latest.payload,
    idempotencyKey: latest.idempotencyKey,
  });
  if (
    repaired.event.eventHash !== latest.eventHash ||
    repaired.snapshot.lastEventHash !== latest.eventHash ||
    repaired.snapshot.lastEventSequence !== latest.eventSequence ||
    repaired.snapshot.stateHash !== latest.idempotencyStateHash
  ) {
    throw runtimeIntegrity("snapshot_repair_result_mismatch");
  }
}

function assertStoredEventHashChain(
  events: readonly StoredReplayPremiereEvent[],
): void {
  let previousHash: string | null = null;
  for (const [index, event] of events.entries()) {
    const { eventHash, ...preimage } = event;
    const value = asJson(preimage);
    if (
      preimage.schemaVersion !== 1 ||
      preimage.eventSequence !== index ||
      preimage.previousEventHash !== previousHash ||
      !isSha256Hex(eventHash) ||
      hashReplayPremiereJson(value) !== eventHash
    ) {
      throw runtimeIntegrity("runtime_event_hash_chain_mismatch");
    }
    previousHash = eventHash;
  }
}

function snapshotUntrustedStoredEvents(
  source: readonly StoredReplayPremiereEvent[],
): readonly StoredReplayPremiereEvent[] {
  const events = [...source].map((event, index) =>
    cloneAndFreezeReplayPremiereValue(
      event,
      `untrusted premiere recovery event ${index}`,
    ),
  );
  return Object.freeze(events);
}

function releasedChunkFromPublic(
  chunk: PremierePublicChunkResponse,
): ReleasedPremiereChunk {
  return immutable(
    {
      descriptor: {
        premiereId: chunk.premiereId,
        index: chunk.index,
        startSequence: chunk.startSequence,
        endSequence: chunk.endSequence,
        startTurn: chunk.startTurn,
        endTurn: chunk.endTurn,
        presentationOffsetMs: chunk.presentationOffsetMs,
        previousChunkHash: chunk.previousChunkHash,
        payloadHash: chunk.payloadHash,
        chunkHash: chunk.chunkHash,
        byteLength: chunk.byteLength,
        terminal: chunk.terminal,
        releasedAt: chunk.releasedAt,
      },
      payload: { schemaVersion: 1, records: chunk.records },
    },
    "premiere runtime released chunk",
  );
}

function recoverReleasedPrefixFromRuntimeState(
  state: ReplayPremiereRuntimeSnapshotV1,
  gate: VerifiedPremiereEligibilityGate,
  drafts: readonly PremiereChunkDraft[],
): ReleasedPremiereChunk[] {
  const released = releasedPrefixFromRuntimeState(state, drafts);
  gate.recoverReleasedPrefix(
    released,
    authoritativeElapsedAt(state, state.lastObservedAt),
  );
  return released;
}

function releasedPrefixFromRuntimeState(
  state: ReplayPremiereRuntimeSnapshotV1,
  drafts: readonly PremiereChunkDraft[],
): ReleasedPremiereChunk[] {
  const released = state.releasedChunks.map((descriptor, index) => {
    assertExactKeys(descriptor as unknown as Record<string, unknown>, [
      "premiereId",
      "index",
      "startSequence",
      "endSequence",
      "startTurn",
      "endTurn",
      "presentationOffsetMs",
      "previousChunkHash",
      "payloadHash",
      "chunkHash",
      "byteLength",
      "terminal",
      "releasedAt",
    ]);
    const draft = drafts[index];
    if (draft === undefined || descriptor.index !== index) {
      throw runtimeIntegrity("runtime_released_prefix_mismatch");
    }
    return {
      descriptor: {
        premiereId: descriptor.premiereId,
        index: descriptor.index,
        startSequence: descriptor.startSequence,
        endSequence: descriptor.endSequence,
        startTurn: descriptor.startTurn,
        endTurn: descriptor.endTurn,
        presentationOffsetMs: descriptor.presentationOffsetMs,
        previousChunkHash: descriptor.previousChunkHash,
        payloadHash: descriptor.payloadHash,
        chunkHash: descriptor.chunkHash,
        byteLength: descriptor.byteLength,
        terminal: descriptor.terminal,
        releasedAt: descriptor.releasedAt,
      },
      payload: draft.payload,
    } satisfies ReleasedPremiereChunk;
  });
  return released;
}

function descriptorFromPublic(
  chunk: PremierePublicChunkResponse,
): PremierePublicChunkDescriptor {
  if (chunk.terminal) throw runtimeIntegrity("terminal_in_prereveal_manifest");
  return {
    premiereId: chunk.premiereId,
    index: chunk.index,
    startSequence: chunk.startSequence,
    endSequence: chunk.endSequence,
    startTurn: chunk.startTurn,
    endTurn: chunk.endTurn,
    presentationOffsetMs: chunk.presentationOffsetMs,
    previousChunkHash: chunk.previousChunkHash,
    payloadHash: chunk.payloadHash,
    chunkHash: chunk.chunkHash,
    byteLength: chunk.byteLength,
    terminal: false,
    releasedAt: chunk.releasedAt,
  };
}

function assertRuntimeInputs(
  gate: VerifiedPremiereEligibilityGate,
  drafts: readonly PremiereChunkDraft[],
  checkpointProjection: ReplayPremiereCheckpointProjection,
): void {
  if (
    !VerifiedPremiereEligibilityGate.isAuthentic(gate) ||
    !Array.isArray(drafts) ||
    drafts.length !== gate.chunkCount ||
    drafts.some(
      (draft, index) =>
        draft.descriptor.index !== index ||
        draft.descriptor.premiereId !== gate.premiereId,
    )
  ) {
    throw runtimeIntegrity("invalid_runtime_publication_inputs");
  }
  assertReplayPremiereCheckpointProjection({
    projection: checkpointProjection,
    gate,
  });
}

function canonicalTimestamp(
  value: Date | string,
  field: string | null,
): string {
  if (value instanceof Date && !Number.isFinite(value.getTime())) {
    throw runtimeRequest(`invalid_${field ?? "clock"}_timestamp`);
  }
  const timestamp = value instanceof Date ? value.toISOString() : value;
  const parsed = Date.parse(timestamp);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== timestamp
  ) {
    throw runtimeRequest(`invalid_${field ?? "clock"}_timestamp`);
  }
  return timestamp;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function sameStringArray(
  left: unknown,
  right: readonly string[],
): left is readonly string[] {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every(
      (value, index) => typeof value === "string" && value === right[index],
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw runtimeIntegrity("runtime_unknown_or_missing_field");
  }
}

function asJson(value: unknown): ReplayPremiereJsonValue {
  const accepted = immutable(value, "premiere runtime JSON");
  assertReplayPremiereJsonValue(accepted, "premiere runtime JSON");
  return accepted;
}

function immutable<T>(value: T, source: string): T {
  return cloneAndFreezeReplayPremiereValue(value, source);
}

function runtimeRequest(reason: string): ReplayPremiereError {
  return new ReplayPremiereError(
    `premiere_runtime_${reason}`,
    "PREMIERE_INVALID_REQUEST",
    400,
    "Replay premiere runtime request is invalid",
  );
}

function runtimeIntegrity(
  reason: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    `premiere_runtime_${reason}`,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    "Replay premiere runtime integrity verification failed",
    cause === undefined ? undefined : { cause },
  );
}
