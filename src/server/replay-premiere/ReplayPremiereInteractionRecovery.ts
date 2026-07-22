import { ReplayPremiereError } from "./ReplayPremiereErrors";
import type {
  ReplayPremiereEventInput,
  ReplayPremiereEventRecovery,
  ReplayPremiereEventRecoveryView,
  ReplayPremiereSnapshot,
  StoredReplayPremiereEvent,
} from "./ReplayPremiereEventStore";
import {
  assertReplayPremiereJsonValue,
  hashReplayPremiereJson,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import {
  createReplayPremiereInitialInteractionsSnapshot,
  ReplayPremiereInteractions,
  validateReplayPremiereInteractionsSnapshot,
  type ReplayPremiereInteractionCheckpoint,
  type ReplayPremiereInteractionPersistence,
  type ReplayPremiereInteractionsOptions,
  type ReplayPremiereInteractionsSnapshot,
} from "./ReplayPremiereInteractions";

const INTERACTION_AGGREGATE_PREFIX = "interaction:";
const INTERACTION_TRANSITION_KIND =
  "replay_premiere_interaction_transition_v1" as const;
const RUNTIME_CHECKPOINT_EVENT_TYPES = new Set([
  "premiere_runtime_initialized",
  "premiere_runtime_chunk_released",
  "premiere_runtime_checkpoint_resumed",
  "premiere_runtime_outage_recovered",
  "premiere_runtime_failed",
]);

const MUTABLE_COLLECTIONS = [
  "checkpoint_resolutions",
  "predictions",
  "reactions",
  "shares",
  "sessions",
  "last_non_direct_attributions",
] as const;

type MutableCollection = (typeof MUTABLE_COLLECTIONS)[number];

interface InteractionCollectionDeltaV1 {
  collection: MutableCollection;
  removedKeys: string[];
  upserts: ReplayPremiereJsonValue[];
  nextOrder: string[];
}

interface InteractionTransitionPayloadV1 {
  schemaVersion: 1;
  transitionKind: typeof INTERACTION_TRANSITION_KIND;
  premiereId: string;
  sourceEventType: string;
  sourceEventPayload: ReplayPremiereJsonValue;
  baseMutableStateHash: string;
  nextMutableStateHash: string;
  deltas: InteractionCollectionDeltaV1[];
}

export interface ReplayPremiereInteractionEventStore {
  readonly recovered: ReplayPremiereEventRecovery;
  readRecoveryView(
    aggregateId: string,
  ): Promise<ReplayPremiereEventRecoveryView>;
  appendAndSnapshot(options: {
    event: ReplayPremiereEventInput;
    state: ReplayPremiereJsonValue;
    idempotencyKey?: string;
  }): Promise<{
    event: StoredReplayPremiereEvent;
    snapshot: ReplayPremiereSnapshot;
  }>;
}

export interface ReplayPremiereInteractionRecovery {
  snapshot: ReplayPremiereInteractionsSnapshot;
  /** Last globally inspected EventStore sequence, not an aggregate-local index. */
  eventCursor: number;
  stateHash: string;
}

export type ReplayPremiereRecoveredInteractionsOptions = Omit<
  ReplayPremiereInteractionsOptions,
  "persistence" | "initialState"
>;

export interface RecoveredReplayPremiereInteractions {
  interactions: ReplayPremiereInteractions;
  persistence: ReplayPremiereInteractionEventPersistence;
  recovery: ReplayPremiereInteractionRecovery;
}

/**
 * Production factory for one premiere's audience state. The EventStore's
 * global sequence is the serialization boundary: normal audience deltas live
 * under `interaction:${premiereId}`, while checkpoint timing is replayed from
 * the already-atomic runtime events under `${premiereId}`.
 */
export async function loadReplayPremiereInteractions(options: {
  eventStore: ReplayPremiereInteractionEventStore;
  interactions: ReplayPremiereRecoveredInteractionsOptions;
}): Promise<RecoveredReplayPremiereInteractions> {
  const initialState = createReplayPremiereInitialInteractionsSnapshot(
    options.interactions,
  );
  const recovery = await recoverReplayPremiereInteractionState({
    eventStore: options.eventStore,
    initialState,
    validationOptions: options.interactions,
  });
  const persistence = new ReplayPremiereInteractionEventPersistence({
    premiereId: options.interactions.premiereId,
    eventStore: options.eventStore,
    recovery,
  });
  const interactions = new ReplayPremiereInteractions({
    ...options.interactions,
    persistence,
    initialState: recovery.snapshot,
  });
  return { interactions, persistence, recovery };
}

export async function recoverReplayPremiereInteractionState(options: {
  eventStore: ReplayPremiereInteractionEventStore;
  initialState: ReplayPremiereInteractionsSnapshot;
  validationOptions: ReplayPremiereRecoveredInteractionsOptions;
}): Promise<ReplayPremiereInteractionRecovery> {
  const premiereId = options.validationOptions.premiereId;
  if (options.initialState.premiereId !== premiereId) {
    throw recoveryIntegrity("interaction_initial_state_premiere_mismatch");
  }
  const aggregateId = replayPremiereInteractionAggregateId(premiereId);
  const recoveryView = await options.eventStore.readRecoveryView(aggregateId);
  const recovered = recoveryView.recovery;
  assertGlobalEventOrder(recovered.events, recovered.lastEventSequence);
  const durableSnapshot = recoveryView.snapshot;
  let snapshotCursor = -1;
  let state = validateReplayPremiereInteractionsSnapshot(
    options.initialState,
    options.validationOptions,
  );
  if (durableSnapshot !== null) {
    state = validateReplayPremiereInteractionsSnapshot(
      durableSnapshot.state,
      options.validationOptions,
    );
    if (
      durableSnapshot.stateHash !== stateHash(state) ||
      durableSnapshot.aggregateId !== aggregateId
    ) {
      throw recoveryIntegrity("interaction_snapshot_hash_mismatch");
    }
    const snapshotAnchor = recovered.events.find(
      (event) =>
        event.aggregateId === aggregateId &&
        event.eventSequence === durableSnapshot.lastEventSequence &&
        event.eventHash === durableSnapshot.lastEventHash,
    );
    if (
      snapshotAnchor === undefined ||
      snapshotAnchor.idempotencyStateHash === null ||
      snapshotAnchor.idempotencyStateHash !== durableSnapshot.stateHash
    ) {
      throw recoveryIntegrity("interaction_snapshot_commitment_mismatch");
    }
    snapshotCursor = durableSnapshot.lastEventSequence;
    assertSnapshotRuntimeCheckpointAnchor(
      state,
      recovered.events,
      premiereId,
      snapshotCursor,
    );
  }

  for (const event of recovered.events) {
    if (event.eventSequence <= snapshotCursor) continue;
    if (event.aggregateId === aggregateId) {
      state = applyInteractionTransition(state, event, premiereId);
      continue;
    }
    const checkpointProjection = runtimeCheckpointProjection(event, premiereId);
    if (checkpointProjection !== null) {
      state = applyRuntimeCheckpointProjection(state, checkpointProjection);
    }
  }
  state = validateReplayPremiereInteractionsSnapshot(
    state,
    options.validationOptions,
  );
  return immutableRecovery({
    snapshot: state,
    eventCursor: recovered.lastEventSequence,
    stateHash: stateHash(state),
  });
}

export class ReplayPremiereInteractionEventPersistence implements ReplayPremiereInteractionPersistence {
  readonly aggregateId: string;
  private readonly premiereId: string;
  private readonly eventStore: ReplayPremiereInteractionEventStore;
  private persistedState: ReplayPremiereInteractionsSnapshot;
  private eventCursor: number;

  constructor(options: {
    premiereId: string;
    eventStore: ReplayPremiereInteractionEventStore;
    recovery: ReplayPremiereInteractionRecovery;
  }) {
    if (options.recovery.snapshot.premiereId !== options.premiereId) {
      throw recoveryIntegrity("interaction_recovery_premiere_mismatch");
    }
    this.premiereId = options.premiereId;
    this.aggregateId = replayPremiereInteractionAggregateId(options.premiereId);
    this.eventStore = options.eventStore;
    this.persistedState = clone(options.recovery.snapshot);
    this.eventCursor = options.recovery.eventCursor;
  }

  recoveryAnchor(): ReplayPremiereInteractionRecovery {
    this.synchronizeAnchorToCurrentTip();
    return immutableRecovery({
      snapshot: this.persistedState,
      eventCursor: this.eventCursor,
      stateHash: stateHash(this.persistedState),
    });
  }

  async persist(options: {
    eventType: string;
    occurredAt: string;
    eventPayload: ReplayPremiereJsonValue;
    nextState: ReplayPremiereInteractionsSnapshot;
    idempotencyKey?: string;
  }): Promise<void> {
    if (options.nextState.premiereId !== this.premiereId) {
      throw recoveryIntegrity("interaction_persist_premiere_mismatch");
    }
    const payload = createTransitionPayload(
      this.persistedState,
      options.nextState,
      options.eventType,
      options.eventPayload,
    );
    const idempotencyKey =
      options.idempotencyKey ??
      `interaction:auto:${hashReplayPremiereJson(
        asJson({
          eventType: options.eventType,
          occurredAt: options.occurredAt,
          payload,
        }),
      )}`;
    const accepted = await this.eventStore.appendAndSnapshot({
      event: {
        aggregateId: this.aggregateId,
        eventType: options.eventType,
        occurredAt: options.occurredAt,
        payload: asJson(payload),
      },
      state: asJson(options.nextState),
      idempotencyKey,
    });
    this.persistedState = clone(options.nextState);
    this.eventCursor = accepted.event.eventSequence;
    this.synchronizeAnchorToCurrentTip();
  }

  private synchronizeAnchorToCurrentTip(): void {
    const recovered = this.eventStore.recovered;
    assertGlobalEventOrder(recovered.events, recovered.lastEventSequence);
    if (this.eventCursor > recovered.lastEventSequence) {
      throw recoveryIntegrity("interaction_anchor_ahead_of_event_store");
    }
    let synchronized = clone(this.persistedState);
    for (const event of recovered.events) {
      if (event.eventSequence <= this.eventCursor) continue;
      if (event.aggregateId === this.aggregateId) {
        synchronized = applyInteractionTransition(
          synchronized,
          event,
          this.premiereId,
        );
        continue;
      }
      const checkpointProjection = runtimeCheckpointProjection(
        event,
        this.premiereId,
      );
      if (checkpointProjection !== null) {
        synchronized = applyRuntimeCheckpointProjection(
          synchronized,
          checkpointProjection,
        );
      }
    }
    this.persistedState = synchronized;
    this.eventCursor = recovered.lastEventSequence;
  }
}

export function replayPremiereInteractionAggregateId(
  premiereId: string,
): string {
  if (!/^prem_[a-z0-9]{16,32}$/.test(premiereId)) {
    throw recoveryIntegrity("invalid_interaction_aggregate_premiere_id");
  }
  return `${INTERACTION_AGGREGATE_PREFIX}${premiereId}`;
}

/** Scheduling-only projection. Prediction resolution remains interaction-owned. */
export function hashReplayPremiereCheckpointSchedule(
  checkpoints: readonly ReplayPremiereInteractionCheckpoint[],
): string {
  return hashReplayPremiereJson(
    asJson(
      checkpoints.map(({ resolution: _resolution, ...checkpoint }) =>
        clone(checkpoint),
      ),
    ),
  );
}

function createTransitionPayload(
  previous: ReplayPremiereInteractionsSnapshot,
  next: ReplayPremiereInteractionsSnapshot,
  sourceEventType: string,
  sourceEventPayload: ReplayPremiereJsonValue,
): InteractionTransitionPayloadV1 {
  if (previous.premiereId !== next.premiereId) {
    throw recoveryIntegrity("interaction_transition_premiere_mismatch");
  }
  const deltas = MUTABLE_COLLECTIONS.map((collection) =>
    collectionDelta(collection, previous, next),
  ).filter((delta) => delta !== null);
  const payload: InteractionTransitionPayloadV1 = {
    schemaVersion: 1,
    transitionKind: INTERACTION_TRANSITION_KIND,
    premiereId: next.premiereId,
    sourceEventType,
    sourceEventPayload: clone(sourceEventPayload),
    baseMutableStateHash: mutableStateHash(previous),
    nextMutableStateHash: mutableStateHash(next),
    deltas,
  };
  asJson(payload);
  return payload;
}

function collectionDelta(
  collection: MutableCollection,
  previous: ReplayPremiereInteractionsSnapshot,
  next: ReplayPremiereInteractionsSnapshot,
): InteractionCollectionDeltaV1 | null {
  const beforeValues = collectionValues(previous, collection);
  const nextValues = collectionValues(next, collection);
  const before = keyedValues(collection, beforeValues);
  const after = keyedValues(collection, nextValues);
  const removedKeys = [...before.keys()].filter((key) => !after.has(key));
  const upserts = nextValues.filter((value) => {
    const key = collectionKey(collection, value);
    const prior = before.get(key);
    return prior === undefined || jsonHash(prior) !== jsonHash(value);
  });
  const beforeOrder = [...before.keys()];
  const nextOrder = [...after.keys()];
  if (
    removedKeys.length === 0 &&
    upserts.length === 0 &&
    beforeOrder.join("\u0000") === nextOrder.join("\u0000")
  ) {
    return null;
  }
  return {
    collection,
    removedKeys,
    upserts: upserts.map(asJson),
    nextOrder,
  };
}

function applyInteractionTransition(
  current: ReplayPremiereInteractionsSnapshot,
  event: StoredReplayPremiereEvent,
  premiereId: string,
): ReplayPremiereInteractionsSnapshot {
  const payload = parseTransitionPayload(event.payload);
  if (
    payload.premiereId !== premiereId ||
    payload.sourceEventType !== event.eventType ||
    payload.baseMutableStateHash !== mutableStateHash(current)
  ) {
    throw recoveryIntegrity("interaction_transition_base_mismatch");
  }
  const next = clone(current);
  for (const delta of payload.deltas) applyCollectionDelta(next, delta);
  if (payload.nextMutableStateHash !== mutableStateHash(next)) {
    throw recoveryIntegrity("interaction_transition_result_mismatch");
  }
  return next;
}

function applyCollectionDelta(
  state: ReplayPremiereInteractionsSnapshot,
  delta: InteractionCollectionDeltaV1,
): void {
  const current = keyedValues(
    delta.collection,
    collectionValues(state, delta.collection),
  );
  for (const key of delta.removedKeys) {
    if (!current.delete(key)) {
      throw recoveryIntegrity("interaction_delta_remove_missing");
    }
  }
  for (const value of delta.upserts) {
    current.set(collectionKey(delta.collection, value), clone(value));
  }
  if (
    delta.nextOrder.length !== current.size ||
    new Set(delta.nextOrder).size !== delta.nextOrder.length ||
    delta.nextOrder.some((key) => !current.has(key))
  ) {
    throw recoveryIntegrity("interaction_delta_order_mismatch");
  }
  assignCollection(
    state,
    delta.collection,
    delta.nextOrder.map((key) => clone(current.get(key)!)),
  );
}

function runtimeCheckpointProjection(
  event: StoredReplayPremiereEvent,
  premiereId: string,
): ReplayPremiereInteractionCheckpoint[] | null {
  if (
    event.aggregateId !== premiereId ||
    !RUNTIME_CHECKPOINT_EVENT_TYPES.has(event.eventType)
  ) {
    return null;
  }
  const payload = record(event.payload, "runtime checkpoint event payload");
  if (
    payload.premiereId !== premiereId ||
    !Array.isArray(payload.interactionCheckpoints)
  ) {
    throw recoveryIntegrity("runtime_checkpoint_projection_missing");
  }
  return clone(
    payload.interactionCheckpoints as unknown as ReplayPremiereInteractionCheckpoint[],
  );
}

function applyRuntimeCheckpointProjection(
  current: ReplayPremiereInteractionsSnapshot,
  projection: readonly ReplayPremiereInteractionCheckpoint[],
): ReplayPremiereInteractionsSnapshot {
  if (
    projection.length !== current.checkpoints.length ||
    projection.some(
      (checkpoint, index) => checkpoint.id !== current.checkpoints[index]?.id,
    )
  ) {
    throw recoveryIntegrity("runtime_checkpoint_projection_identity_mismatch");
  }
  const next = clone(current);
  next.checkpoints = projection.map((checkpoint, index) => ({
    ...clone(checkpoint),
    resolution: clone(current.checkpoints[index].resolution),
  }));
  return next;
}

function assertSnapshotRuntimeCheckpointAnchor(
  snapshot: ReplayPremiereInteractionsSnapshot,
  events: readonly StoredReplayPremiereEvent[],
  premiereId: string,
  snapshotCursor: number,
): void {
  let latest: ReplayPremiereInteractionCheckpoint[] | null = null;
  for (const event of events) {
    if (event.eventSequence > snapshotCursor) break;
    const candidate = runtimeCheckpointProjection(event, premiereId);
    if (candidate !== null) latest = candidate;
  }
  if (
    latest !== null &&
    hashReplayPremiereCheckpointSchedule(snapshot.checkpoints) !==
      hashReplayPremiereCheckpointSchedule(latest)
  ) {
    throw recoveryIntegrity("interaction_snapshot_runtime_anchor_mismatch");
  }
}

function mutableStateHash(
  snapshot: ReplayPremiereInteractionsSnapshot,
): string {
  return hashReplayPremiereJson(
    asJson(
      Object.fromEntries(
        MUTABLE_COLLECTIONS.map((collection) => [
          collection,
          collectionValues(snapshot, collection),
        ]),
      ),
    ),
  );
}

function collectionValues(
  snapshot: ReplayPremiereInteractionsSnapshot,
  collection: MutableCollection,
): ReplayPremiereJsonValue[] {
  switch (collection) {
    case "checkpoint_resolutions":
      return snapshot.checkpoints.map((checkpoint) =>
        asJson({
          checkpointId: checkpoint.id,
          resolution: checkpoint.resolution,
        }),
      );
    case "predictions":
      return snapshot.predictions.map(asJson);
    case "reactions":
      return snapshot.reactions.map(asJson);
    case "shares":
      return snapshot.shares.map(asJson);
    case "sessions":
      return snapshot.sessions.map(asJson);
    case "last_non_direct_attributions":
      return snapshot.lastNonDirectAttributionByParticipant.map(asJson);
  }
}

function assignCollection(
  snapshot: ReplayPremiereInteractionsSnapshot,
  collection: MutableCollection,
  values: ReplayPremiereJsonValue[],
): void {
  switch (collection) {
    case "checkpoint_resolutions": {
      if (values.length !== snapshot.checkpoints.length) {
        throw recoveryIntegrity("checkpoint_resolution_count_mismatch");
      }
      for (const [index, value] of values.entries()) {
        const item = record(value, "checkpoint resolution delta");
        if (item.checkpointId !== snapshot.checkpoints[index]?.id) {
          throw recoveryIntegrity("checkpoint_resolution_identity_mismatch");
        }
        snapshot.checkpoints[index].resolution = clone(
          item.resolution as ReplayPremiereInteractionCheckpoint["resolution"],
        );
      }
      return;
    }
    case "predictions":
      snapshot.predictions = clone(
        values as unknown as ReplayPremiereInteractionsSnapshot["predictions"],
      );
      return;
    case "reactions":
      snapshot.reactions = clone(
        values as unknown as ReplayPremiereInteractionsSnapshot["reactions"],
      );
      return;
    case "shares":
      snapshot.shares = clone(
        values as unknown as ReplayPremiereInteractionsSnapshot["shares"],
      );
      return;
    case "sessions":
      snapshot.sessions = clone(
        values as unknown as ReplayPremiereInteractionsSnapshot["sessions"],
      );
      return;
    case "last_non_direct_attributions":
      snapshot.lastNonDirectAttributionByParticipant = clone(
        values as unknown as ReplayPremiereInteractionsSnapshot["lastNonDirectAttributionByParticipant"],
      );
  }
}

function collectionKey(
  collection: MutableCollection,
  value: ReplayPremiereJsonValue,
): string {
  const item = record(value, `${collection} interaction record`);
  switch (collection) {
    case "checkpoint_resolutions":
      return requiredString(item.checkpointId, "checkpoint resolution id");
    case "predictions":
      return `${requiredString(item.checkpointId, "prediction checkpoint")}::${requiredString(item.participantId, "prediction participant")}`;
    case "reactions":
    case "shares":
    case "sessions":
      return requiredString(item.id, `${collection} id`);
    case "last_non_direct_attributions":
      return requiredString(item.participantId, "attribution participant");
  }
}

function keyedValues(
  collection: MutableCollection,
  values: readonly ReplayPremiereJsonValue[],
): Map<string, ReplayPremiereJsonValue> {
  const result = new Map<string, ReplayPremiereJsonValue>();
  for (const value of values) {
    const key = collectionKey(collection, value);
    if (result.has(key)) {
      throw recoveryIntegrity("interaction_collection_duplicate_key");
    }
    result.set(key, clone(value));
  }
  return result;
}

function parseTransitionPayload(
  value: ReplayPremiereJsonValue,
): InteractionTransitionPayloadV1 {
  const payload = record(value, "interaction transition payload");
  exactKeys(payload, [
    "schemaVersion",
    "transitionKind",
    "premiereId",
    "sourceEventType",
    "sourceEventPayload",
    "baseMutableStateHash",
    "nextMutableStateHash",
    "deltas",
  ]);
  if (
    payload.schemaVersion !== 1 ||
    payload.transitionKind !== INTERACTION_TRANSITION_KIND ||
    typeof payload.premiereId !== "string" ||
    typeof payload.sourceEventType !== "string" ||
    typeof payload.baseMutableStateHash !== "string" ||
    typeof payload.nextMutableStateHash !== "string" ||
    !Array.isArray(payload.deltas)
  ) {
    throw recoveryIntegrity("invalid_interaction_transition_envelope");
  }
  const seen = new Set<MutableCollection>();
  const deltas = payload.deltas.map((candidate) => {
    const delta = record(candidate, "interaction collection delta");
    exactKeys(delta, ["collection", "removedKeys", "upserts", "nextOrder"]);
    if (
      !isMutableCollection(delta.collection) ||
      seen.has(delta.collection) ||
      !stringArray(delta.removedKeys) ||
      !Array.isArray(delta.upserts) ||
      !stringArray(delta.nextOrder)
    ) {
      throw recoveryIntegrity("invalid_interaction_collection_delta");
    }
    seen.add(delta.collection);
    for (const upsert of delta.upserts) {
      assertReplayPremiereJsonValue(upsert, "interaction delta upsert");
    }
    return {
      collection: delta.collection,
      removedKeys: [...delta.removedKeys],
      upserts: clone(delta.upserts),
      nextOrder: [...delta.nextOrder],
    };
  });
  assertReplayPremiereJsonValue(
    payload.sourceEventPayload,
    "interaction source event payload",
  );
  return {
    schemaVersion: 1,
    transitionKind: INTERACTION_TRANSITION_KIND,
    premiereId: payload.premiereId,
    sourceEventType: payload.sourceEventType,
    sourceEventPayload: clone(payload.sourceEventPayload),
    baseMutableStateHash: payload.baseMutableStateHash,
    nextMutableStateHash: payload.nextMutableStateHash,
    deltas,
  };
}

function assertGlobalEventOrder(
  events: readonly StoredReplayPremiereEvent[],
  lastEventSequence: number,
): void {
  for (const [index, event] of events.entries()) {
    if (event.eventSequence !== index) {
      throw recoveryIntegrity("interaction_recovery_event_order_invalid");
    }
  }
  if (lastEventSequence !== events.length - 1) {
    throw recoveryIntegrity("interaction_recovery_cursor_invalid");
  }
}

function immutableRecovery(
  recovery: ReplayPremiereInteractionRecovery,
): ReplayPremiereInteractionRecovery {
  return Object.freeze({
    snapshot: clone(recovery.snapshot),
    eventCursor: recovery.eventCursor,
    stateHash: recovery.stateHash,
  });
}

function stateHash(snapshot: ReplayPremiereInteractionsSnapshot): string {
  return hashReplayPremiereJson(asJson(snapshot));
}

function jsonHash(value: ReplayPremiereJsonValue): string {
  return hashReplayPremiereJson(value);
}

function asJson(value: unknown): ReplayPremiereJsonValue {
  const json: unknown = JSON.parse(JSON.stringify(value));
  assertReplayPremiereJsonValue(json, "replay premiere interaction recovery");
  return json;
}

function record(
  value: unknown,
  label: string,
): Record<string, ReplayPremiereJsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw recoveryIntegrity(`invalid_${label.replaceAll(" ", "_")}`);
  }
  return value as Record<string, ReplayPremiereJsonValue>;
}

function exactKeys(
  value: Record<string, ReplayPremiereJsonValue>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    keys.length !== wanted.length ||
    keys.some((key, index) => key !== wanted[index])
  ) {
    throw recoveryIntegrity("interaction_recovery_unexpected_keys");
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw recoveryIntegrity(`invalid_${label.replaceAll(" ", "_")}`);
  }
  return value;
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isMutableCollection(value: unknown): value is MutableCollection {
  return (
    typeof value === "string" &&
    (MUTABLE_COLLECTIONS as readonly string[]).includes(value)
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function recoveryIntegrity(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    500,
    `Replay Premiere interaction recovery rejected: ${operatorCode}`,
  );
}
