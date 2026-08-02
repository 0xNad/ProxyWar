import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { REPLAY_PREMIERE_MAX_CHUNK_COUNT } from "../../../src/server/replay-premiere/ReplayPremiereChunks";
import {
  REQUIRED_PREMIERE_LEAK_SURFACES,
  type PremiereChunkPayload,
  type PremiereEligibility,
  type PremiereLeakAuditManifest,
  type PremiereLeakCheckEvidence,
  type PremiereReleasedRecord,
  type PremiereSeatIdentity,
} from "../../../src/server/replay-premiere/ReplayPremiereContracts";
import { computeEligibilityRecordCommitment } from "../../../src/server/replay-premiere/ReplayPremiereEligibility";
import {
  ReplayPremiereEventStore,
  type ReplayPremiereEventInput,
} from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
import {
  assertReplayPremiereJsonValue,
  canonicalReplayPremiereJson,
  hashReplayPremiereJson,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import type { ReplayPremiereInteractionCheckpoint } from "../../../src/server/replay-premiere/ReplayPremiereInteractions";
import type {
  PremiereFrozenDraftDescriptor,
  PremierePublicationCommitment,
} from "../../../src/server/replay-premiere/ReplayPremierePublication";
import {
  REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
  REPLAY_PREMIERE_MAX_OUTAGE_EVENTS_PER_LIFECYCLE_VERSION,
  REPLAY_PREMIERE_MAX_RECOVERABLE_OUTAGE_MS,
} from "../../../src/server/replay-premiere/ReplayPremiereRuntimeCoordinator";
import { DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS } from "../../../src/server/replay-premiere/ReplayPremiereStartup";
import {
  assertValidPremiereLifecycleSnapshot,
  recordSafeReleasedSequence,
  transitionPremiereLifecycle,
  type PremiereLifecycleSnapshot,
  type PremiereTransitionAuditEvent,
} from "../../../src/server/replay-premiere/ReplayPremiereStateMachine";
import type {
  PremierePublicCheckpoint,
  PremierePublicChunkDescriptor,
  PremierePublicChunkResponse,
  PremierePublicProvenance,
  PremiereRevealResponse,
} from "../../../src/server/replay-premiere/ReplayPremiereWire";

const MIB = 1024 * 1024;
const REQUIRED_AGGREGATE_RESERVE_BYTES = 32 * MIB;
const MAX_CHUNK_PAYLOAD_BYTES = 1 * MIB;
const MAX_TURN_INTERVAL_MS = 60_000;
const MAX_TIMESTAMP_EPOCH_MS = Date.parse("+100000-01-01T00:00:00.000Z");
const PREMIERE_ID = `prem_${"p".repeat(32)}`;
const SOURCE_RUN_ID = maxIdentifier("run", "r");
const AUTHORITATIVE_SOURCE_ID = maxIdentifier("result", "u");
const GAME_ID = maxIdentifier("game", "g");
const CHECKPOINT_IDS = [
  `cp_${"c".repeat(32)}`,
  `cp_${"d".repeat(32)}`,
] as const;
const CHECKPOINT_SEQUENCES = [1, 2] as const;
const FINAL_CHUNK_INDEX = REPLAY_PREMIERE_MAX_CHUNK_COUNT - 1;
const NON_TERMINAL_CHUNK_COUNT = FINAL_CHUNK_INDEX;
const FINAL_SEQUENCE = REPLAY_PREMIERE_MAX_CHUNK_COUNT;
const MAX_PRESENTATION_OFFSET_MS = FINAL_SEQUENCE * MAX_TURN_INTERVAL_MS;
const EXPECTED_OUTAGE_VERSIONS =
  1 + 1 + NON_TERMINAL_CHUNK_COUNT + CHECKPOINT_IDS.length;
const EXPECTED_COMMON_EVENT_COUNT =
  1 +
  1 +
  NON_TERMINAL_CHUNK_COUNT +
  CHECKPOINT_IDS.length +
  EXPECTED_OUTAGE_VERSIONS *
    REPLAY_PREMIERE_MAX_OUTAGE_EVENTS_PER_LIFECYCLE_VERSION;
const EXPECTED_TERMINAL_EVENT_COUNT = EXPECTED_COMMON_EVENT_COUNT + 2;

const SEAT_IDS = Array.from({ length: 64 }, (_, index) =>
  maxIdentifier(`s${index.toString(36).padStart(2, "0")}`, "s"),
);
const SEATS = SEAT_IDS.map(
  (seatId, index): PremiereSeatIdentity => ({
    seatId,
    displayName: maxDisplayText(`Player ${index.toString().padStart(2, "0")}`),
    policyIdentity: {
      namespace: "local_manifest",
      manifestName: maxDisplayText(
        `Manifest ${index.toString().padStart(2, "0")}`,
      ),
      declaredVersion: maxIdentifier(`version${index}`, "v"),
      manifestSha256: sha256Hex(`manifest-${index}`),
      contentSha256: sha256Hex(`content-${index}`),
    },
  }),
);
const TERMINAL_CHUNK_PAYLOAD = buildMaxTerminalChunkPayload();
const DRAFT_DESCRIPTORS = buildDraftDescriptors();

interface RuntimeSnapshotModel {
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

interface RevealCommitPayloadModel {
  schemaVersion: 1;
  commitKind: "terminal_chunk_and_reveal";
  publicationCommitmentHash: string;
  lifecycle: PremiereLifecycleSnapshot;
  transitionAuditEvent: PremiereTransitionAuditEvent;
  releasedPrefixChunkCount: number;
  releasedPrefixLastChunkHash: string | null;
  terminalChunk: PremierePublicChunkResponse;
  reveal: PremiereRevealResponse;
}

interface BindingMaterial {
  eligibilityRecord: PremiereEligibility;
  eligibilityRecordHash: string;
  publicationCommitment: PremierePublicationCommitment;
  publicationCommitmentHash: string;
  provenance: PremierePublicProvenance;
  authoritativeResult: {
    encoding: "canonical_json_utf8_base64";
    bytes: string;
    sha256: string;
  };
  eligibilityCommitmentNonce: string;
}

interface CapturedLine {
  aggregateId: string;
  eventType: string;
  bytes: number;
}

interface StoreHarness {
  root: string;
  store: ReplayPremiereEventStore;
  writes: number[];
  lines: CapturedLine[];
}

interface HistoryResult {
  totalBytes: number;
  reserveBytes: number;
  eventLogBytes: number;
  eventCount: number;
  maxLineBytes: number;
  eventTypeCounts: Map<string, number>;
}

/**
 * This fixture intentionally mirrors the persisted field sets in
 * ReplayPremiereRuntimeSnapshotV1, RevealCommitPayload and
 * ReplayPremiereArchivePayloadV1. Every event goes through the production
 * ReplayPremiereEventStore.append path, which adds the UUID, global sequence,
 * aggregate/type/time fields, idempotency binding, previous hash, event hash,
 * canonical JSON ordering and trailing newline. The injected writer skips only
 * physical I/O; its Buffer length is therefore the exact production JSONL
 * contribution enforced by all three event-store byte ceilings.
 */
describe("ReplayPremiere main-aggregate journal budget", () => {
  test("keeps every cap-128 terminal history below 64 MiB with 32 MiB reserved", async () => {
    expect(REPLAY_PREMIERE_MAX_CHUNK_COUNT).toBe(128);
    expect(REPLAY_PREMIERE_MAX_OUTAGE_EVENTS_PER_LIFECYCLE_VERSION).toBe(2);
    expect(PREMIERE_ID).toHaveLength(37);
    expect(SOURCE_RUN_ID).toHaveLength(128);
    expect(CHECKPOINT_IDS.every((id) => id.length === 35)).toBe(true);
    expect(SEAT_IDS).toHaveLength(64);
    expect(SEAT_IDS.every((id) => id.length === 128)).toBe(true);
    expect(new Date(MAX_TIMESTAMP_EPOCH_MS).toISOString()).toHaveLength(27);
    expect(DRAFT_DESCRIPTORS).toHaveLength(128);
    expect(DRAFT_DESCRIPTORS.at(-1)).toMatchObject({
      index: FINAL_CHUNK_INDEX,
      endSequence: FINAL_SEQUENCE,
      endTurn: FINAL_SEQUENCE,
      presentationOffsetMs: MAX_PRESENTATION_OFFSET_MS,
      byteLength: MAX_CHUNK_PAYLOAD_BYTES,
      terminal: true,
    });

    const revealPaddingBytes = await calibrateRevealPaddingBytes();
    expect(revealPaddingBytes).toBeGreaterThan(0);
    const binding = buildBindingMaterial(revealPaddingBytes);

    const success = await measureHistory("revealed", binding);
    const failed = await measureHistory("failed", binding);
    const worst = success.totalBytes >= failed.totalBytes ? success : failed;

    expect(success.eventTypeCounts).toEqual(
      new Map([
        ["premiere_runtime_initialized", 1],
        ["premiere_runtime_outage_started", EXPECTED_OUTAGE_VERSIONS],
        ["premiere_runtime_outage_recovered", EXPECTED_OUTAGE_VERSIONS],
        ["premiere_runtime_started", 1],
        ["premiere_runtime_chunk_released", NON_TERMINAL_CHUNK_COUNT],
        ["premiere_runtime_checkpoint_resumed", CHECKPOINT_IDS.length],
        ["premiere_reveal_committed", 1],
        ["premiere_runtime_archived", 1],
      ]),
    );
    expect(failed.eventTypeCounts).toEqual(
      new Map([
        ["premiere_runtime_initialized", 1],
        ["premiere_runtime_outage_started", EXPECTED_OUTAGE_VERSIONS],
        ["premiere_runtime_outage_recovered", EXPECTED_OUTAGE_VERSIONS],
        ["premiere_runtime_started", 1],
        ["premiere_runtime_chunk_released", NON_TERMINAL_CHUNK_COUNT],
        ["premiere_runtime_checkpoint_resumed", CHECKPOINT_IDS.length],
        ["premiere_runtime_failed", 1],
        ["premiere_runtime_terminal_archived", 1],
      ]),
    );
    expect(success.eventCount).toBe(EXPECTED_TERMINAL_EVENT_COUNT);
    expect(failed.eventCount).toBe(EXPECTED_TERMINAL_EVENT_COUNT);
    expect(success.maxLineBytes).toBe(
      DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS.maxEventBytes,
    );
    expect(failed.maxLineBytes).toBeLessThanOrEqual(
      DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS.maxEventBytes,
    );
    expect(success.totalBytes).toBeLessThan(
      DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS.maxAggregateEventBytes,
    );
    expect(failed.totalBytes).toBeLessThan(
      DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS.maxAggregateEventBytes,
    );
    expect(worst.reserveBytes).toBeGreaterThanOrEqual(
      REQUIRED_AGGREGATE_RESERVE_BYTES,
    );
    expect(success.eventLogBytes).toBe(success.totalBytes);
    expect(failed.eventLogBytes).toBe(failed.totalBytes);
    expect(success.eventLogBytes).toBeLessThanOrEqual(
      DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS.maxEventLogBytes,
    );
    expect(failed.eventLogBytes).toBeLessThanOrEqual(
      DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS.maxEventLogBytes,
    );
  }, 120_000);
});

async function measureHistory(
  terminal: "revealed" | "failed",
  binding: BindingMaterial,
): Promise<HistoryResult> {
  const harness = await openHarness(`premiere-journal-${terminal}-`);
  try {
    const { state, clock, outageVersions } = await appendCommonHistory(
      harness,
      binding,
    );
    expect(outageVersions).toHaveLength(EXPECTED_OUTAGE_VERSIONS);
    expect(new Set(outageVersions).size).toBe(outageVersions.length);

    if (terminal === "revealed") {
      await appendRevealAndArchive(harness, state, clock, binding);
    } else {
      await appendFailureAndArchive(harness, state, clock, binding);
    }

    const recovered = harness.store.recovered;
    const totalBytes = recovered.aggregateBytes.get(PREMIERE_ID) ?? Number.NaN;
    const capturedAggregateBytes = harness.lines
      .filter((line) => line.aggregateId === PREMIERE_ID)
      .reduce((sum, line) => sum + line.bytes, 0);
    expect(totalBytes).toBe(capturedAggregateBytes);
    expect(
      harness.lines.every(
        (line) =>
          line.bytes <=
          DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS.maxEventBytes,
      ),
    ).toBe(true);
    return {
      totalBytes,
      reserveBytes:
        DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS.maxAggregateEventBytes -
        totalBytes,
      eventLogBytes: recovered.eventLogBytes,
      eventCount: harness.lines.length,
      maxLineBytes: Math.max(...harness.lines.map((line) => line.bytes)),
      eventTypeCounts: countEventTypes(harness.lines),
    };
  } finally {
    await closeHarness(harness);
  }
}

async function appendCommonHistory(
  harness: StoreHarness,
  binding: BindingMaterial,
): Promise<{
  state: RuntimeSnapshotModel;
  clock: MaxLengthIsoClock;
  outageVersions: number[];
}> {
  const clock = new MaxLengthIsoClock(MAX_TIMESTAMP_EPOCH_MS);
  const createdAt = clock.current();
  const scheduledLifecycle: PremiereLifecycleSnapshot = {
    schemaVersion: 1,
    premiereId: PREMIERE_ID,
    state: "scheduled",
    eligibilityRecordHash: binding.eligibilityRecordHash,
    publicationCommitmentHash: binding.publicationCommitmentHash,
    sourceRunId: SOURCE_RUN_ID,
    sourceReplaySha256: binding.eligibilityRecord.sourceReplaySha256,
    lastSafeReleasedSequence: -1,
    terminalReasonCode: null,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  assertValidPremiereLifecycleSnapshot(scheduledLifecycle);
  let state: RuntimeSnapshotModel = {
    schemaVersion: 1,
    runtimeKind: "replay_premiere_runtime_v1",
    premiereId: PREMIERE_ID,
    publicationCommitmentHash: binding.publicationCommitmentHash,
    lifecycle: scheduledLifecycle,
    actualStartAt: null,
    scheduleShiftMs: 0,
    accumulatedPauseMs: 0,
    activeCheckpoint: null,
    completedCheckpointIds: [],
    outageStartedAt: null,
    lastObservedAt: createdAt,
    nextDraftIndex: 0,
    releasedChunks: [],
    interactionCheckpoints: initialInteractionCheckpoints(),
  };
  const outageVersions: number[] = [];

  await appendRuntimeEvent(
    harness,
    state,
    "premiere_runtime_initialized",
    `runtime:init:${binding.publicationCommitmentHash}`,
  );
  ({ state } = await appendOutagePair(harness, state, clock, binding));
  outageVersions.push(state.lifecycle.version);

  const startedAt = clock.next();
  const startedLifecycle = transitionPremiereLifecycle(state.lifecycle, {
    action: "start",
    actor: "service",
    occurredAt: startedAt,
    serviceReady: true,
  }).snapshot;
  state = {
    ...state,
    lifecycle: startedLifecycle,
    actualStartAt: startedAt,
    lastObservedAt: startedAt,
  };
  await appendRuntimeEvent(
    harness,
    state,
    "premiere_runtime_started",
    `runtime:start:${binding.publicationCommitmentHash}`,
  );
  ({ state } = await appendOutagePair(harness, state, clock, binding));
  outageVersions.push(state.lifecycle.version);

  for (let index = 0; index < NON_TERMINAL_CHUNK_COUNT; index += 1) {
    const releasedAt = clock.next();
    const draft = DRAFT_DESCRIPTORS[index];
    let lifecycle = state.lifecycle;
    for (
      let sequence = draft.startSequence;
      sequence <= draft.endSequence;
      sequence += 1
    ) {
      lifecycle = recordSafeReleasedSequence(lifecycle, sequence, releasedAt);
    }
    const released = buildReleasedDescriptor(
      draft,
      releasedAt,
      state.releasedChunks.at(-1)?.chunkHash ?? null,
    ) as PremierePublicChunkDescriptor;
    let activeCheckpoint: PremierePublicCheckpoint | null = null;
    let interactionCheckpoints = state.interactionCheckpoints;
    const checkpointIndex = CHECKPOINT_SEQUENCES.indexOf(
      draft.endSequence as (typeof CHECKPOINT_SEQUENCES)[number],
    );
    if (checkpointIndex !== -1) {
      lifecycle = transitionPremiereLifecycle(lifecycle, {
        action: "open_checkpoint",
        actor: "service",
        occurredAt: releasedAt,
      }).snapshot;
      const closesAt = new Date(
        Date.parse(releasedAt) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
      ).toISOString();
      activeCheckpoint = {
        id: CHECKPOINT_IDS[checkpointIndex],
        sequence: CHECKPOINT_SEQUENCES[checkpointIndex],
        opensAt: releasedAt,
        closesAt,
        questionKind: "winner_from_here",
        optionSeatIds: [...SEAT_IDS],
        state: "open",
      };
      interactionCheckpoints = interactionCheckpoints.map(
        (checkpoint, interactionIndex) =>
          interactionIndex === checkpointIndex
            ? {
                ...checkpoint,
                opensAt: releasedAt,
                closesAt,
                outageShiftMs: 0,
                optionSeatIds: [...SEAT_IDS],
                state: "open" as const,
              }
            : checkpoint,
      );
    }
    state = {
      ...state,
      lifecycle,
      activeCheckpoint,
      lastObservedAt: releasedAt,
      nextDraftIndex: index + 1,
      releasedChunks: [...state.releasedChunks, released],
      interactionCheckpoints,
    };
    await appendRuntimeEvent(
      harness,
      state,
      "premiere_runtime_chunk_released",
      `runtime:release:${binding.publicationCommitmentHash}:${index}`,
    );
    ({ state } = await appendOutagePair(harness, state, clock, binding));
    outageVersions.push(state.lifecycle.version);

    if (state.activeCheckpoint !== null) {
      const active = state.activeCheckpoint;
      const resumedAt = clock.atLeast(Date.parse(active.closesAt));
      const resumedLifecycle = transitionPremiereLifecycle(state.lifecycle, {
        action: "resume",
        actor: "service",
        occurredAt: resumedAt,
      }).snapshot;
      state = {
        ...state,
        lifecycle: resumedLifecycle,
        accumulatedPauseMs:
          state.accumulatedPauseMs +
          (Date.parse(active.closesAt) - Date.parse(active.opensAt)),
        activeCheckpoint: null,
        completedCheckpointIds: [...state.completedCheckpointIds, active.id],
        lastObservedAt: resumedAt,
        interactionCheckpoints: state.interactionCheckpoints.map(
          (checkpoint) =>
            checkpoint.id === active.id
              ? { ...checkpoint, state: "closed" as const }
              : checkpoint,
        ),
      };
      await appendRuntimeEvent(
        harness,
        state,
        "premiere_runtime_checkpoint_resumed",
        `runtime:checkpoint:${active.id}:resume`,
      );
      ({ state } = await appendOutagePair(harness, state, clock, binding));
      outageVersions.push(state.lifecycle.version);
    }
  }

  expect(state.releasedChunks).toHaveLength(NON_TERMINAL_CHUNK_COUNT);
  expect(state.interactionCheckpoints).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ optionSeatIds: SEAT_IDS, state: "closed" }),
      expect.objectContaining({ optionSeatIds: SEAT_IDS, state: "closed" }),
    ]),
  );
  return { state, clock, outageVersions };
}

async function appendOutagePair(
  harness: StoreHarness,
  current: RuntimeSnapshotModel,
  clock: MaxLengthIsoClock,
  binding: BindingMaterial,
): Promise<{ state: RuntimeSnapshotModel }> {
  const beganAt = clock.next();
  const began: RuntimeSnapshotModel = {
    ...current,
    outageStartedAt: beganAt,
    lastObservedAt: beganAt,
  };
  await appendRuntimeEvent(
    harness,
    began,
    "premiere_runtime_outage_started",
    // Longest production reason suffix: the hard event/journal byte proof must
    // cover the controlled drill, not only the shorter legacy key.
    `runtime:outage:${binding.publicationCommitmentHash}:begin:${began.lifecycle.version}:controlled_outage_drill`,
  );

  const recoveredAt = clock.next(REPLAY_PREMIERE_MAX_RECOVERABLE_OUTAGE_MS);
  let scheduleShiftMs = began.scheduleShiftMs;
  let accumulatedPauseMs = began.accumulatedPauseMs;
  let activeCheckpoint = began.activeCheckpoint;
  let interactionCheckpoints = began.interactionCheckpoints;
  if (began.lifecycle.state === "scheduled") {
    scheduleShiftMs += REPLAY_PREMIERE_MAX_RECOVERABLE_OUTAGE_MS;
  } else if (activeCheckpoint !== null) {
    const closesAt = new Date(
      Date.parse(activeCheckpoint.closesAt) +
        REPLAY_PREMIERE_MAX_RECOVERABLE_OUTAGE_MS,
    ).toISOString();
    const activeId = activeCheckpoint.id;
    activeCheckpoint = { ...activeCheckpoint, closesAt };
    interactionCheckpoints = interactionCheckpoints.map((checkpoint) =>
      checkpoint.id === activeId
        ? {
            ...checkpoint,
            closesAt,
            outageShiftMs:
              checkpoint.outageShiftMs +
              REPLAY_PREMIERE_MAX_RECOVERABLE_OUTAGE_MS,
          }
        : checkpoint,
    );
  } else {
    accumulatedPauseMs += REPLAY_PREMIERE_MAX_RECOVERABLE_OUTAGE_MS;
  }
  const recovered: RuntimeSnapshotModel = {
    ...began,
    scheduleShiftMs,
    accumulatedPauseMs,
    activeCheckpoint,
    outageStartedAt: null,
    lastObservedAt: recoveredAt,
    interactionCheckpoints,
  };
  await appendRuntimeEvent(
    harness,
    recovered,
    "premiere_runtime_outage_recovered",
    `runtime:outage:${binding.publicationCommitmentHash}:recover:${recovered.lifecycle.version}:${Date.parse(beganAt)}`,
  );
  return { state: recovered };
}

async function appendRevealAndArchive(
  harness: StoreHarness,
  current: RuntimeSnapshotModel,
  clock: MaxLengthIsoClock,
  binding: BindingMaterial,
): Promise<void> {
  const revealedAt = clock.next();
  const revealedLifecycle: PremiereLifecycleSnapshot = {
    ...current.lifecycle,
    state: "revealed",
    lastSafeReleasedSequence: FINAL_SEQUENCE,
    version: current.lifecycle.version + 1,
    updatedAt: revealedAt,
  };
  assertValidPremiereLifecycleSnapshot(revealedLifecycle);
  const payload = buildRevealCommitPayload(
    binding,
    current,
    revealedLifecycle,
    revealedAt,
  );
  const revealLineBytes = await appendEvent(harness, {
    aggregateId: PREMIERE_ID,
    eventType: "premiere_reveal_committed",
    occurredAt: revealedAt,
    payload: asJson(payload),
    idempotencyKey: `reveal:${binding.publicationCommitmentHash}`,
    idempotencyStateHash: hashReplayPremiereJson(asJson(payload)),
  });
  expect(revealLineBytes).toBe(
    DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS.maxEventBytes,
  );

  const archivedAt = clock.next();
  const archivedLifecycle = transitionPremiereLifecycle(revealedLifecycle, {
    action: "archive",
    actor: "operator",
    occurredAt: archivedAt,
  }).snapshot;
  const archivePayload = {
    schemaVersion: 1,
    runtimeKind: "replay_premiere_archive_v1",
    premiereId: PREMIERE_ID,
    publicationCommitmentHash: binding.publicationCommitmentHash,
    revealCommitHash: payload.reveal.revealCommitHash,
    lifecycle: archivedLifecycle,
  };
  await appendEvent(harness, {
    aggregateId: PREMIERE_ID,
    eventType: "premiere_runtime_archived",
    occurredAt: archivedAt,
    payload: asJson(archivePayload),
    idempotencyKey: `runtime:archive:${binding.publicationCommitmentHash}`,
    idempotencyStateHash: hashReplayPremiereJson(asJson(archivePayload)),
  });
}

async function appendFailureAndArchive(
  harness: StoreHarness,
  current: RuntimeSnapshotModel,
  clock: MaxLengthIsoClock,
  binding: BindingMaterial,
): Promise<void> {
  const failedAt = clock.next();
  const failedLifecycle: PremiereLifecycleSnapshot = {
    ...current.lifecycle,
    state: "failed",
    terminalReasonCode: "runtime_failure",
    version: current.lifecycle.version + 1,
    updatedAt: failedAt,
  };
  assertValidPremiereLifecycleSnapshot(failedLifecycle);
  let state: RuntimeSnapshotModel = {
    ...current,
    lifecycle: failedLifecycle,
    outageStartedAt: null,
    lastObservedAt: failedAt,
  };
  await appendRuntimeEvent(
    harness,
    state,
    "premiere_runtime_failed",
    `runtime:fail:${binding.publicationCommitmentHash}:${failedLifecycle.version}`,
  );

  const archivedAt = clock.next();
  const archivedLifecycle = transitionPremiereLifecycle(failedLifecycle, {
    action: "archive",
    actor: "operator",
    occurredAt: archivedAt,
  }).snapshot;
  state = {
    ...state,
    lifecycle: archivedLifecycle,
    lastObservedAt: archivedAt,
  };
  await appendRuntimeEvent(
    harness,
    state,
    "premiere_runtime_terminal_archived",
    `runtime:archive:${binding.publicationCommitmentHash}`,
  );
}

function buildRevealCommitPayload(
  binding: BindingMaterial,
  current: RuntimeSnapshotModel,
  lifecycle: PremiereLifecycleSnapshot,
  revealedAt: string,
): RevealCommitPayloadModel {
  const terminalDraft = DRAFT_DESCRIPTORS[FINAL_CHUNK_INDEX];
  const terminalDescriptor = buildReleasedDescriptor(
    terminalDraft,
    revealedAt,
    current.releasedChunks.at(-1)?.chunkHash ?? null,
  );
  const terminalChunk: PremierePublicChunkResponse = {
    schemaVersion: 1,
    ...terminalDescriptor,
    provenance: binding.provenance,
    records: TERMINAL_CHUNK_PAYLOAD.records,
  };
  const transitionAuditEvent: PremiereTransitionAuditEvent = {
    schemaVersion: 1,
    eventKind: "premiere_transition",
    premiereId: PREMIERE_ID,
    action: "reveal",
    fromState: "playing",
    toState: "revealed",
    actor: "service",
    occurredAt: revealedAt,
    lifecycleVersion: lifecycle.version,
    eligibilityRecordHash: binding.eligibilityRecordHash,
    publicationCommitmentHash: binding.publicationCommitmentHash,
    sourceRunId: SOURCE_RUN_ID,
    sourceReplaySha256: binding.eligibilityRecord.sourceReplaySha256,
    terminalReasonCode: null,
    lastSafeReleasedSequence: FINAL_SEQUENCE,
  };
  const revealCommitInput = {
    schemaVersion: 1 as const,
    premiereId: PREMIERE_ID,
    eligibilityRecordHash: binding.eligibilityRecordHash,
    publicationCommitmentHash: binding.publicationCommitmentHash,
    publicationCommitment: binding.publicationCommitment,
    sourceReplaySha256: binding.eligibilityRecord.sourceReplaySha256,
    resultHash: binding.authoritativeResult.sha256,
    authoritativeResult: binding.authoritativeResult,
    publicationDraftManifest: DRAFT_DESCRIPTORS,
    finalSequence: FINAL_SEQUENCE,
    finalChunkIndex: FINAL_CHUNK_INDEX,
    finalChunkHash: terminalChunk.chunkHash,
    revealedAt,
  };
  const reveal: PremiereRevealResponse = {
    ...revealCommitInput,
    state: "revealed",
    eligibilityRecord: binding.eligibilityRecord,
    eligibilityCommitmentNonce: binding.eligibilityCommitmentNonce,
    revealCommitHash: hashReplayPremiereJson(asJson(revealCommitInput)),
    provenance: binding.provenance,
    integrityScope: {
      publicationCommitment: "reveal_verifiable",
      sourceReplay: "declared_hash_only",
      authoritativeResult: "included_hash_verifiable",
    },
  };
  return {
    schemaVersion: 1,
    commitKind: "terminal_chunk_and_reveal",
    publicationCommitmentHash: binding.publicationCommitmentHash,
    lifecycle,
    transitionAuditEvent,
    releasedPrefixChunkCount: NON_TERMINAL_CHUNK_COUNT,
    releasedPrefixLastChunkHash:
      current.releasedChunks.at(-1)?.chunkHash ?? null,
    terminalChunk,
    reveal,
  };
}

function buildBindingMaterial(revealPaddingBytes: number): BindingMaterial {
  const authoritativeResultValue = {
    schemaVersion: 1,
    sourceKind: "coworld_result",
    sourceRunId: SOURCE_RUN_ID,
    sourceId: AUTHORITATIVE_SOURCE_ID,
    gameId: GAME_ID,
    completedAt: maxLengthTimestamp(0),
    turnCount: FINAL_SEQUENCE + 1,
    winner: ["player", ...SEAT_IDS],
    seats: SEATS.map((seat) => ({
      seatId: seat.seatId,
      displayName: seat.displayName,
      won: true,
    })),
  };
  const authoritativeResultBytes = Buffer.from(
    canonicalReplayPremiereJson(asJson(authoritativeResultValue)),
    "utf8",
  );
  const authoritativeResult = {
    encoding: "canonical_json_utf8_base64" as const,
    bytes: authoritativeResultBytes.toString("base64"),
    sha256: sha256Hex(authoritativeResultBytes),
  };
  const eligibilityRecord = buildEligibilityRecord(
    revealPaddingBytes,
    authoritativeResult.sha256,
  );
  const nonce = Buffer.alloc(64, 0xff);
  const eligibilityRecordHash = computeEligibilityRecordCommitment(
    eligibilityRecord,
    nonce,
  );
  const baseProvenance = {
    sourceKind: eligibilityRecord.sourceKind,
    sourceRunId: SOURCE_RUN_ID,
    coworld: eligibilityRecord.coworld,
    sourceReplaySha256: eligibilityRecord.sourceReplaySha256,
    seats: SEATS,
    publicLabel: eligibilityRecord.publicLabel,
    eligibilityRecordHash,
  };
  const publicDefinitionHash = hashReplayPremiereJson(
    asJson({
      title: maxDisplayText("Replay premiere"),
      spoilerNeutralDescription: maxDisplayText("Spoiler neutral"),
      map: {
        id: maxIdentifier("map", "m"),
        label: maxDisplayText("Map"),
      },
      matchFormat: {
        id: maxIdentifier("format", "f"),
        label: maxDisplayText("Format"),
        seatCount: SEATS.length,
      },
      scheduledAt: maxLengthTimestamp(0),
      playbackRate: 4,
      checkpoints: CHECKPOINT_IDS.map((id, index) => ({
        id,
        sequence: CHECKPOINT_SEQUENCES[index],
      })),
      provenance: baseProvenance,
    }),
  );
  const commitmentPreimage = {
    schemaVersion: 1 as const,
    commitmentKind: "replay_premiere_publication_v1" as const,
    premiereId: PREMIERE_ID,
    eligibilityRecordHash,
    sourceRunId: SOURCE_RUN_ID,
    sourceReplaySha256: eligibilityRecord.sourceReplaySha256,
    gameStartInfoHash: hashReplayPremiereJson(
      asJson({ schemaVersion: 1, players: SEAT_IDS }),
    ),
    publicDefinitionHash,
    playbackRate: 4 as const,
    checkpoints: [
      { id: CHECKPOINT_IDS[0], sequence: CHECKPOINT_SEQUENCES[0] },
      { id: CHECKPOINT_IDS[1], sequence: CHECKPOINT_SEQUENCES[1] },
    ] as [{ id: string; sequence: number }, { id: string; sequence: number }],
    maxPresentationSpanMs: 1_000,
    finalSequence: FINAL_SEQUENCE,
    chunkCount: REPLAY_PREMIERE_MAX_CHUNK_COUNT,
    terminalPrepublicationRoot:
      DRAFT_DESCRIPTORS[FINAL_CHUNK_INDEX].prepublicationHash,
    orderedDraftManifestRoot: hashReplayPremiereJson(
      asJson({
        schemaVersion: 1,
        premiereId: PREMIERE_ID,
        chunks: DRAFT_DESCRIPTORS,
      }),
    ),
  };
  const publicationCommitmentHash = hashReplayPremiereJson(
    asJson(commitmentPreimage),
  );
  const publicationCommitment: PremierePublicationCommitment = {
    ...commitmentPreimage,
    publicationCommitmentHash,
  };
  return {
    eligibilityRecord,
    eligibilityRecordHash,
    publicationCommitment,
    publicationCommitmentHash,
    provenance: {
      ...baseProvenance,
      publicationCommitmentHash,
    },
    authoritativeResult,
    eligibilityCommitmentNonce: nonce.toString("base64url"),
  };
}

function buildEligibilityRecord(
  revealPaddingBytes: number,
  resultHash: string,
): PremiereEligibility {
  const createdAt = maxLengthTimestamp(0);
  const targets = REQUIRED_PREMIERE_LEAK_SURFACES.map((surface, index) => ({
    checkId: maxIdentifier(`check${index.toString(36)}`, "k"),
    surface,
    target: maxTargetUrl(index),
    method: "GET" as const,
    expectation: {
      kind: "status" as const,
      allowedHttpStatuses: [404, 410],
      forbiddenText: ["y".repeat(512), "z".repeat(512)],
    },
  }));
  const manifestPreimage = {
    schemaVersion: 1 as const,
    sourceRunId: SOURCE_RUN_ID,
    createdAt,
    targets,
  };
  const proxyWarLeakAuditManifest: PremiereLeakAuditManifest = {
    ...manifestPreimage,
    manifestId: `leak_${hashReplayPremiereJson(asJson(manifestPreimage)).slice(0, 24)}`,
  };
  const proxyWarLeakChecks: PremiereLeakCheckEvidence[] = targets.map(
    (target, index) => {
      const observedBodyText =
        index === 0 ? "x".repeat(revealPaddingBytes) : "";
      return {
        checkId: target.checkId,
        target: target.target,
        method: target.method,
        observedHttpStatus: 404,
        observedContentHash: sha256Hex(observedBodyText),
        observedBodyText,
        observedHeaders: {
          age: "0",
          cacheControl: "c".repeat(256),
          cdnCacheStatus: "MISS",
        },
        checkedAt: createdAt,
        checkerVersion: maxIdentifier(`checker${index}`, "v"),
      };
    },
  );
  return {
    schemaVersion: 1,
    eligibilityCheckVersion: maxIdentifier("eligibility", "e"),
    createdAt,
    sourceKind: "rated_coworld",
    sourceRunId: SOURCE_RUN_ID,
    coworld: {
      episodeId: maxIdentifier("episode", "e"),
      leagueId: maxIdentifier("league", "l"),
      divisionId: maxIdentifier("division", "d"),
      roundId: maxIdentifier("round", "r"),
    },
    sourceReplaySha256: sha256Hex("source replay"),
    sourceBundleOutsideServedRoots: true,
    proxyWarLeakAuditManifest,
    proxyWarLeakChecks,
    externalEmbargoEvidence: [
      {
        source: maxDisplayText("External source"),
        scope: maxDisplayText("External scope"),
        observedAt: createdAt,
        verifier: maxDisplayText("External verifier"),
        embargoConfirmed: true,
      },
    ],
    externalOutcomeMayBePublic: false,
    seats: SEATS,
    authoritativeResult: {
      sourceKind: "coworld_result",
      sourceId: AUTHORITATIVE_SOURCE_ID,
      resultHash,
    },
    publicLabel: "spoiler_resistant_premiere",
  };
}

function buildDraftDescriptors(): PremiereFrozenDraftDescriptor[] {
  const descriptors: PremiereFrozenDraftDescriptor[] = [];
  let previousPrepublicationHash: string | null = null;
  for (let index = 0; index < REPLAY_PREMIERE_MAX_CHUNK_COUNT; index += 1) {
    const endSequence = index + 1;
    const withoutHash = {
      premiereId: PREMIERE_ID,
      index,
      startSequence: index === 0 ? 0 : endSequence,
      endSequence,
      startTurn: index === 0 ? 0 : endSequence,
      endTurn: endSequence,
      presentationOffsetMs: endSequence * MAX_TURN_INTERVAL_MS,
      previousPrepublicationHash,
      payloadHash:
        index === FINAL_CHUNK_INDEX
          ? sha256Hex(
              Buffer.from(
                canonicalReplayPremiereJson(asJson(TERMINAL_CHUNK_PAYLOAD)),
                "utf8",
              ),
            )
          : sha256Hex(`max-chunk-payload-${index}`),
      byteLength: MAX_CHUNK_PAYLOAD_BYTES,
      terminal: index === FINAL_CHUNK_INDEX,
    };
    const prepublicationHash = hashReplayPremiereJson(asJson(withoutHash));
    descriptors.push({
      ...withoutHash,
      prepublicationHash,
      releasedAt: null,
    });
    previousPrepublicationHash = prepublicationHash;
  }
  return descriptors;
}

function buildReleasedDescriptor(
  draft: PremiereFrozenDraftDescriptor,
  releasedAt: string,
  previousChunkHash: string | null,
):
  | PremierePublicChunkDescriptor
  | Omit<
      PremierePublicChunkResponse,
      "schemaVersion" | "provenance" | "records"
    > {
  const withoutHash = {
    premiereId: draft.premiereId,
    index: draft.index,
    startSequence: draft.startSequence,
    endSequence: draft.endSequence,
    startTurn: draft.startTurn,
    endTurn: draft.endTurn,
    presentationOffsetMs: draft.presentationOffsetMs,
    previousChunkHash,
    payloadHash: draft.payloadHash,
    byteLength: draft.byteLength,
    terminal: draft.terminal,
    releasedAt,
  };
  return {
    ...withoutHash,
    chunkHash: hashReplayPremiereJson(asJson(withoutHash)),
  };
}

function buildMaxTerminalChunkPayload(): PremiereChunkPayload {
  const record = (padding: string): PremiereReleasedRecord => ({
    sequence: FINAL_SEQUENCE,
    turn: FINAL_SEQUENCE,
    presentationOffsetMs: MAX_PRESENTATION_OFFSET_MS,
    payload: { padding },
  });
  const empty: PremiereChunkPayload = {
    schemaVersion: 1,
    records: [record("")],
  };
  const overheadBytes = Buffer.byteLength(
    canonicalReplayPremiereJson(asJson(empty)),
    "utf8",
  );
  const payload: PremiereChunkPayload = {
    schemaVersion: 1,
    records: [record("t".repeat(MAX_CHUNK_PAYLOAD_BYTES - overheadBytes))],
  };
  if (
    Buffer.byteLength(canonicalReplayPremiereJson(asJson(payload)), "utf8") !==
    MAX_CHUNK_PAYLOAD_BYTES
  ) {
    throw new Error("terminal chunk payload sizing drifted");
  }
  return payload;
}

function initialInteractionCheckpoints(): ReplayPremiereInteractionCheckpoint[] {
  return CHECKPOINT_IDS.map((id, index) => ({
    id,
    sequence: CHECKPOINT_SEQUENCES[index],
    opensAt: null,
    closesAt: null,
    outageShiftMs: 0,
    optionSeatIds: [],
    state: "upcoming",
    resolution: null,
  }));
}

async function calibrateRevealPaddingBytes(): Promise<number> {
  const binding = buildBindingMaterial(0);
  const clock = new MaxLengthIsoClock(MAX_TIMESTAMP_EPOCH_MS);
  const revealedAt = clock.current();
  const lifecycle: PremiereLifecycleSnapshot = {
    schemaVersion: 1,
    premiereId: PREMIERE_ID,
    state: "revealed",
    eligibilityRecordHash: binding.eligibilityRecordHash,
    publicationCommitmentHash: binding.publicationCommitmentHash,
    sourceRunId: SOURCE_RUN_ID,
    sourceReplaySha256: binding.eligibilityRecord.sourceReplaySha256,
    lastSafeReleasedSequence: FINAL_SEQUENCE,
    terminalReasonCode: null,
    version: 135,
    createdAt: revealedAt,
    updatedAt: revealedAt,
  };
  const releasedChunks: PremierePublicChunkDescriptor[] = [];
  for (const draft of DRAFT_DESCRIPTORS.slice(0, NON_TERMINAL_CHUNK_COUNT)) {
    releasedChunks.push(
      buildReleasedDescriptor(
        draft,
        revealedAt,
        releasedChunks.at(-1)?.chunkHash ?? null,
      ) as PremierePublicChunkDescriptor,
    );
  }
  const state: RuntimeSnapshotModel = {
    schemaVersion: 1,
    runtimeKind: "replay_premiere_runtime_v1",
    premiereId: PREMIERE_ID,
    publicationCommitmentHash: binding.publicationCommitmentHash,
    lifecycle: {
      ...lifecycle,
      state: "playing",
      lastSafeReleasedSequence: FINAL_SEQUENCE - 1,
      version: 134,
    },
    actualStartAt: revealedAt,
    scheduleShiftMs: REPLAY_PREMIERE_MAX_RECOVERABLE_OUTAGE_MS,
    accumulatedPauseMs: 10_000_000,
    activeCheckpoint: null,
    completedCheckpointIds: [...CHECKPOINT_IDS],
    outageStartedAt: null,
    lastObservedAt: revealedAt,
    nextDraftIndex: NON_TERMINAL_CHUNK_COUNT,
    releasedChunks,
    interactionCheckpoints: CHECKPOINT_IDS.map((id, index) => ({
      id,
      sequence: CHECKPOINT_SEQUENCES[index],
      opensAt: revealedAt,
      closesAt: new Date(
        Date.parse(revealedAt) + REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
      ).toISOString(),
      outageShiftMs: REPLAY_PREMIERE_MAX_RECOVERABLE_OUTAGE_MS,
      optionSeatIds: [...SEAT_IDS],
      state: "closed",
      resolution: null,
    })),
  };
  const payload = buildRevealCommitPayload(
    binding,
    state,
    lifecycle,
    revealedAt,
  );
  const harness = await openHarness("premiere-reveal-calibration-");
  try {
    for (
      let sequence = 0;
      sequence < EXPECTED_COMMON_EVENT_COUNT;
      sequence += 1
    ) {
      const fillerPayload = asJson({ sequence });
      await appendEvent(harness, {
        aggregateId: PREMIERE_ID,
        eventType: "budget_filler",
        occurredAt: revealedAt,
        payload: fillerPayload,
        idempotencyKey: `filler:${sequence}`,
        idempotencyStateHash: hashReplayPremiereJson(fillerPayload),
      });
    }
    const minimalLineBytes = await appendEvent(harness, {
      aggregateId: PREMIERE_ID,
      eventType: "premiere_reveal_committed",
      occurredAt: revealedAt,
      payload: asJson(payload),
      idempotencyKey: `reveal:${binding.publicationCommitmentHash}`,
      idempotencyStateHash: hashReplayPremiereJson(asJson(payload)),
    });
    return (
      DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS.maxEventBytes -
      minimalLineBytes
    );
  } finally {
    await closeHarness(harness);
  }
}

async function appendRuntimeEvent(
  harness: StoreHarness,
  state: RuntimeSnapshotModel,
  eventType: string,
  idempotencyKey: string,
): Promise<number> {
  const payload = asJson(state);
  return appendEvent(harness, {
    aggregateId: PREMIERE_ID,
    eventType,
    occurredAt: state.lastObservedAt,
    payload,
    idempotencyKey,
    idempotencyStateHash: hashReplayPremiereJson(payload),
  });
}

async function appendEvent(
  harness: StoreHarness,
  event: ReplayPremiereEventInput,
): Promise<number> {
  const writesBefore = harness.writes.length;
  await harness.store.append(event);
  if (harness.writes.length !== writesBefore + 1) {
    throw new Error(
      "event-store writer did not receive exactly one JSONL line",
    );
  }
  const bytes = harness.writes[writesBefore];
  harness.lines.push({
    aggregateId: event.aggregateId,
    eventType: event.eventType,
    bytes,
  });
  return bytes;
}

async function openHarness(prefix: string): Promise<StoreHarness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const servedRoot = path.join(root, "served");
  await fs.mkdir(servedRoot);
  const writes: number[] = [];
  const store = await ReplayPremiereEventStore.open({
    privateStateRoot: path.join(root, "private"),
    servedRoots: [servedRoot],
    limits: DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS,
    statfs: (async () => ({
      bavail: 1024 ** 3,
      bsize: 1024,
    })) as unknown as typeof fs.statfs,
    eventWrite: async (_handle, _buffer, offset, length) => {
      if (offset !== 0) throw new Error("unexpected short event write retry");
      writes.push(length);
      return { bytesWritten: length };
    },
    eventSync: async () => undefined,
  });
  return { root, store, writes, lines: [] };
}

async function closeHarness(harness: StoreHarness): Promise<void> {
  await harness.store.close();
  await fs.rm(harness.root, { recursive: true, force: true });
}

function countEventTypes(lines: readonly CapturedLine[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line.eventType, (counts.get(line.eventType) ?? 0) + 1);
  }
  return counts;
}

function maxIdentifier(prefix: string, fill: string): string {
  return `${prefix}${fill.repeat(128 - prefix.length)}`;
}

function maxDisplayText(prefix: string): string {
  return `${prefix}${"x".repeat(256 - prefix.length)}`;
}

function maxTargetUrl(index: number): string {
  const prefix = `https://example.invalid/${index}/`;
  return `${prefix}${"t".repeat(2_048 - prefix.length)}`;
}

function maxLengthTimestamp(offsetMs: number): string {
  const value = new Date(MAX_TIMESTAMP_EPOCH_MS + offsetMs).toISOString();
  if (
    value.length !== 27 ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new Error("expected a maximum-length canonical ISO timestamp");
  }
  return value;
}

class MaxLengthIsoClock {
  constructor(private valueMs: number) {}

  current(): string {
    return maxLengthTimestamp(this.valueMs - MAX_TIMESTAMP_EPOCH_MS);
  }

  next(deltaMs = 1): string {
    this.valueMs += deltaMs;
    return this.current();
  }

  atLeast(valueMs: number): string {
    this.valueMs = Math.max(this.valueMs + 1, valueMs);
    return this.current();
  }
}

function asJson(value: unknown): ReplayPremiereJsonValue {
  assertReplayPremiereJsonValue(
    value,
    "replay premiere journal budget fixture",
  );
  return value;
}
