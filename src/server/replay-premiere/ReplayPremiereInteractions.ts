import type { PremiereCanonicalAuthoritativeResult } from "./ReplayPremiereAuthoritativeResult";
import {
  REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS,
  REPLAY_PREMIERE_LEGACY_CHECKPOINT_PAUSE_MS,
  type PolicyIdentity,
  type PremiereState,
} from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import type { ReplayPremiereShareAttribution } from "./ReplayPremiereGuestSecurity";
import {
  assertReplayPremiereJsonValue,
  canonicalReplayPremiereJson,
  hashReplayPremiereJson,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import {
  applyBuy,
  applySell,
  computeMarketPrices,
  liquidityForOutcomeCount,
  maxSharesForBudget,
  positionsFor,
  quoteBuy,
  quoteSell,
  ReplayPremiereLedger,
  settleMarket,
  sharesHeld,
  STARTING_BANKROLL,
  validateBuyStake,
  type ReplayPremiereMarket,
  type ReplayPremiereMarketParticipantKind,
  type ReplayPremiereMarketStateView,
  type ReplayPremiereMarketTrade,
} from "./wagering";

export const REPLAY_PREMIERE_REACTION_KINDS = [
  "turning_point",
  "smart",
  "mistake",
  "betrayal",
  "clip_this",
] as const;

const DEFAULT_INTERACTION_LIMITS: ReplayPremiereInteractionLimits = {
  maxTotalRecords: 25_000,
  maxSessionsPerPremiere: 5_000,
  maxSessionsPerParticipant: 8,
  maxSessionCreatesPerParticipantPerMinute: 3,
  maxHeartbeatWritesPerSessionPerMinute: 30,
  maxSharesPerPremiere: 10_000,
  maxSharesPerParticipant: 30,
  maxSharesPerSession: 10,
  maxShareCreatesPerParticipantPerMinute: 5,
};
const MAX_EVENT_CONTEXT_BYTES = 8_192;
const OPAQUE_SEAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const REQUESTER_BUCKET_ID_PATTERN = /^ip_[a-f0-9]{32,64}$/;
const HEARTBEAT_RECEIPT_LIMIT = 128;

export type ReplayPremiereReactionKind =
  (typeof REPLAY_PREMIERE_REACTION_KINDS)[number];

export interface ReplayPremierePrediction {
  premiereId: string;
  checkpointId: string;
  participantId: string;
  selectedSeatId: string;
  submittedAt: string;
  lockedAt: string;
}

export interface ReplayPremiereReaction {
  id: string;
  premiereId: string;
  participantId: string;
  sequence: number;
  turn: number;
  kind: ReplayPremiereReactionKind;
  policyIdentity: PolicyIdentity | null;
  eventContext: ReplayPremiereJsonValue | null;
  createdAt: string;
}

export interface ReplayPremiereShareMoment {
  id: string;
  premiereId: string;
  sourceReactionId: string | null;
  sequence: number;
  turn: number;
  createdByParticipantId: string;
  cardVersion: 1;
  createdAt: string;
  idempotencyKey: string;
}

export interface ReplayPremiereViewerSession {
  id: string;
  premiereId: string;
  participantId: string;
  startedAt: string;
  lastHeartbeatAt: string;
  endedAt: string | null;
  connectedDurationMs: number;
  visibleDurationMs: number;
  currentlyVisible: boolean;
  firstReleasedSequenceObserved: number;
  lastReleasedSequenceObserved: number;
  predictionCount: number;
  reactionCount: number;
  shareCount: number;
  incomingAttribution: ReplayPremiereShareAttribution | null;
  excludedAsOperator: boolean;
  excludedAsBot: boolean;
  qualifiedAt: string | null;
  idempotencyKey: string;
  creationRequestHash: string;
  heartbeatReceipts: Array<{
    idempotencyKey: string;
    requestHash: string;
    acceptedAt: string;
  }>;
}

export interface ReplayPremiereInteractionCheckpoint {
  id: string;
  sequence: number;
  opensAt: string | null;
  closesAt: string | null;
  outageShiftMs: number;
  optionSeatIds: string[];
  state: "upcoming" | "open" | "closed";
  resolution: ReplayPremierePredictionResolution | null;
}

export type ReplayPremierePredictionVoidReason =
  | "no_winner"
  | "ambiguous_winner"
  | "invalid_result";

export type ReplayPremierePredictionOutcome =
  | { kind: "winner"; winnerSeatId: string }
  | { kind: "void"; reason: ReplayPremierePredictionVoidReason };

export type ReplayPremierePredictionResolution =
  | {
      kind: "winner";
      winnerSeatId: string;
      resolvedAt: string;
    }
  | {
      kind: "void";
      reason: ReplayPremierePredictionVoidReason;
      resolvedAt: string;
    };

export interface ReplayPremiereCrowdAccuracy {
  correctPredictions: number;
  totalPredictions: number;
}

export interface ReplayPremiereCheckpointView {
  id: string;
  sequence: number;
  opensAt: string | null;
  closesAt: string | null;
  outageShiftMs: number;
  optionSeatIds: string[];
  state: "upcoming" | "open" | "closed";
  participantPrediction: ReplayPremierePrediction | null;
  distribution: Record<string, number> | null;
  totalPredictions: number | null;
  resolution: ReplayPremierePredictionResolution | null;
  crowdAccuracy: ReplayPremiereCrowdAccuracy | null;
}

export interface ReplayPremiereInteractionsSnapshot {
  schemaVersion: 1;
  premiereId: string;
  checkpoints: ReplayPremiereInteractionCheckpoint[];
  predictions: ReplayPremierePrediction[];
  market: ReplayPremiereMarket | null;
  trades: ReplayPremiereMarketTrade[];
  reactions: ReplayPremiereReaction[];
  shares: ReplayPremiereShareMoment[];
  sessions: ReplayPremiereViewerSession[];
  lastNonDirectAttributionByParticipant: Array<{
    participantId: string;
    attribution: ReplayPremiereShareAttribution;
    touchedAt: string;
  }>;
}

export function hasCompleteReplayPremierePredictionResolution(
  state: Pick<ReplayPremiereInteractionsSnapshot, "checkpoints">,
): boolean {
  return (
    state.checkpoints.length > 0 &&
    state.checkpoints.every((checkpoint) => checkpoint.resolution !== null)
  );
}

export interface ReplayPremiereReleasedContext {
  releasedThroughSequence: number;
  turn: number;
  eventContext: ReplayPremiereJsonValue | null;
}

export interface ReplayPremiereInteractionPersistence {
  persist(options: {
    eventType: string;
    occurredAt: string;
    eventPayload: ReplayPremiereJsonValue;
    nextState: ReplayPremiereInteractionsSnapshot;
    idempotencyKey?: string;
  }): Promise<void>;
}

export interface ReplayPremiereInteractionLimits {
  maxTotalRecords: number;
  maxSessionsPerPremiere: number;
  maxSessionsPerParticipant: number;
  maxSessionCreatesPerParticipantPerMinute: number;
  maxHeartbeatWritesPerSessionPerMinute: number;
  maxSharesPerPremiere: number;
  maxSharesPerParticipant: number;
  maxSharesPerSession: number;
  maxShareCreatesPerParticipantPerMinute: number;
}

export interface ReplayPremiereAnonymousWriteAdmissionRequest {
  route: "session" | "heartbeat" | "prediction" | "reaction" | "share" | "clip" | "market_order";
  premiereId: string;
  participantId: string;
  sessionId: string | null;
  requesterBucketId: string;
  idempotencyKey: string;
  occurredAt: string;
  currentPremiereRecordCount: number;
}

/**
 * Must synchronously and atomically enforce the caller's HMAC-derived IP
 * bucket plus service-wide quotas. Throwing rejects the write before storage.
 */
export type ReplayPremiereAnonymousWriteAdmission = (
  request: ReplayPremiereAnonymousWriteAdmissionRequest,
) => void;

export interface ReplayPremiereInteractionsOptions {
  premiereId: string;
  checkpointDescriptors: readonly [
    { id: string; sequence: number },
    { id: string; sequence: number },
  ];
  seats: readonly {
    seatId: string;
    policyIdentity: PolicyIdentity;
  }[];
  getPremiereState: () => PremiereState;
  getReleasedContext: (
    sequence: number,
  ) => ReplayPremiereReleasedContext | null;
  /**
   * Highest sequence currently live-visible, independent of chunk-release
   * batching — see `ReplayPremiereRuntimeCoordinator.readLiveVisibleSequence`.
   * `submitMarketOrder` binds every order to this, never to the coarser
   * `getReleasedContext`, so wagering freshness never depends on chunk size.
   */
  getLiveVisibleSequence: () => number;
  persistence: ReplayPremiereInteractionPersistence;
  signAttribution: (options: {
    attributionId: string;
    shareId: string;
    premiereId: string;
  }) => string;
  canonicalPremiereUrl: string;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  initialState?: ReplayPremiereInteractionsSnapshot;
  maxHeartbeatGapMs?: number;
  minHeartbeatIntervalMs?: number;
  limits?: Partial<ReplayPremiereInteractionLimits>;
  admitAnonymousWrite: ReplayPremiereAnonymousWriteAdmission;
  /** Server-side LMSR prediction market, continuous from match start to reveal. Off by default — an existing premiere behaves byte-identically with this unset. */
  wageringEnabled?: boolean;
}

export type ReplayPremiereInteractionSnapshotValidationOptions = Pick<
  ReplayPremiereInteractionsOptions,
  | "premiereId"
  | "checkpointDescriptors"
  | "seats"
  | "getPremiereState"
  | "getReleasedContext"
  | "getLiveVisibleSequence"
  | "maxHeartbeatGapMs"
  | "minHeartbeatIntervalMs"
  | "limits"
  | "wageringEnabled"
>;

export interface ReplayPremiereInteractionMetrics {
  qualifiedParticipants: number;
  interactingQualifiedParticipants: number;
  markerToShareParticipants: number;
  attributedQualifiedParticipants: number;
}

/**
 * Public, release-gated crowd signal. No reaction ids, viewer ids, turns, or
 * event context cross this boundary. `ownByKind` is present only for the
 * authenticated participant requesting the view.
 */
export interface ReplayPremiereReactionSummary {
  totalReactions: number;
  distinctParticipants: number;
  byKind: Record<ReplayPremiereReactionKind, number>;
  ownByKind: Record<ReplayPremiereReactionKind, number> | null;
}

/**
 * Participant-private durable anchor for restoring the latest accepted mark.
 * Policy identity, event context, timestamps, and participant ids never cross
 * this projection boundary.
 */
export interface ReplayPremiereLatestOwnReaction {
  id: string;
  kind: ReplayPremiereReactionKind;
  sequence: number;
  turn: number;
}

interface ReplayPremiereReactionIndex {
  totalReactions: number;
  byKind: Record<ReplayPremiereReactionKind, number>;
  byParticipantKind: Map<string, Record<ReplayPremiereReactionKind, number>>;
  byParticipantTotal: Map<string, number>;
  latestByParticipant: Map<string, ReplayPremiereLatestOwnReaction>;
  ids: Set<string>;
  dedupeKeys: Set<string>;
  createdAtMsByParticipant: Map<string, number[]>;
  lastReactionId: string | null;
}

interface ReplayPremiereValidatedReactionAppend {
  reaction: ReplayPremiereReaction;
  releasedContext: ReplayPremiereReleasedContext;
}

interface ReplayPremiereAppendOnlyReactionValidation {
  index: ReplayPremiereReactionIndex;
  appended: ReplayPremiereValidatedReactionAppend | null;
}

interface ReplayPremiereReactionIndexCapture {
  value: ReplayPremiereReactionIndex | null;
}

export interface ReplayPremierePreparedInteractionTransition<T> {
  /** Immutable-by-contract snapshot the coordinator includes in its write. */
  nextState: ReplayPremiereInteractionsSnapshot;
  /** Hashes bind the runtime event to the exact prepared state transition. */
  baseStateHash: string;
  nextStateHash: string;
  checkpointStateHash: string;
  result: T;
  /** Call exactly once, and only after the coordinator's durable commit. */
  commit(): void;
  /** Releases the reservation after a failed durable commit. */
  abort(): void;
}

export function createReplayPremiereInitialInteractionsSnapshot(
  options: ReplayPremiereInteractionSnapshotValidationOptions,
): ReplayPremiereInteractionsSnapshot {
  assertPremiereId(options.premiereId);
  return clone(createInitialSnapshot(options));
}

export function validateReplayPremiereInteractionsSnapshot(
  snapshot: unknown,
  options: ReplayPremiereInteractionSnapshotValidationOptions,
): ReplayPremiereInteractionsSnapshot {
  return clone(
    validateSnapshot(
      clone(snapshot as ReplayPremiereInteractionsSnapshot),
      options,
    ),
  );
}

export const REPLAY_PREMIERE_REPEAT_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Counts browser-level guest participants that qualified in at least two
 * distinct premieres during the rolling 30-day window ending at `asOf`.
 * Repeated snapshots for one premiere never inflate the result.
 */
export function countRepeatQualifiedPremiereParticipants(
  snapshots: readonly ReplayPremiereInteractionsSnapshot[],
  asOf: string,
): number {
  const asOfMs = timestamp(asOf, "repeat_metric_as_of");
  const windowStartMs = asOfMs - REPLAY_PREMIERE_REPEAT_WINDOW_MS;
  const premiereIdsByParticipant = new Map<string, Set<string>>();

  for (const snapshot of snapshots) {
    assertPremiereId(snapshot.premiereId);
    const qualifiedInPremiere = new Set<string>();
    for (const session of snapshot.sessions) {
      if (
        session.premiereId !== snapshot.premiereId ||
        session.qualifiedAt === null ||
        session.excludedAsBot ||
        session.excludedAsOperator
      ) {
        continue;
      }
      assertParticipantId(session.participantId);
      const qualifiedAtMs = timestamp(
        session.qualifiedAt,
        "repeat_metric_qualified_at",
      );
      if (qualifiedAtMs < windowStartMs || qualifiedAtMs > asOfMs) continue;
      qualifiedInPremiere.add(session.participantId);
    }
    for (const participantId of qualifiedInPremiere) {
      const premiereIds = premiereIdsByParticipant.get(participantId);
      if (premiereIds === undefined) {
        premiereIdsByParticipant.set(
          participantId,
          new Set([snapshot.premiereId]),
        );
      } else {
        premiereIds.add(snapshot.premiereId);
      }
    }
  }

  let repeatParticipants = 0;
  for (const premiereIds of premiereIdsByParticipant.values()) {
    if (premiereIds.size >= 2) repeatParticipants += 1;
  }
  return repeatParticipants;
}

/**
 * Resolves prediction semantics exclusively from the authoritative winner
 * tuple. Seat score/order fields are deliberately outside this function.
 */
export function deriveReplayPremierePredictionOutcome(
  result: PremiereCanonicalAuthoritativeResult,
  eligibleSeatIds: ReadonlySet<string>,
): ReplayPremierePredictionOutcome {
  const winner = result?.winner;
  if (winner === null) return { kind: "void", reason: "no_winner" };
  if (!Array.isArray(winner)) {
    return { kind: "void", reason: "invalid_result" };
  }
  const kind = winner[0];
  const winnerSeatValues =
    kind === "player"
      ? winner.slice(1)
      : kind === "team" || kind === "nation"
        ? winner.slice(2)
        : null;
  if (
    winnerSeatValues === null ||
    winnerSeatValues.length === 0 ||
    winner.some((value) => typeof value !== "string") ||
    ((kind === "team" || kind === "nation") &&
      (typeof winner[1] !== "string" || winner[1].length === 0)) ||
    new Set(winnerSeatValues).size !== winnerSeatValues.length ||
    winnerSeatValues.some((seatId) => !eligibleSeatIds.has(String(seatId)))
  ) {
    return { kind: "void", reason: "invalid_result" };
  }
  if (winnerSeatValues.length !== 1) {
    return { kind: "void", reason: "ambiguous_winner" };
  }
  return { kind: "winner", winnerSeatId: String(winnerSeatValues[0]) };
}

export interface ReplayPremierePredictionResolutionTransition {
  result: {
    resolutions: ReplayPremierePredictionResolution[];
    idempotent: boolean;
  };
  eventPayload: ReplayPremiereJsonValue;
  persist: boolean;
  persistenceIdempotencyKey?: string;
}

/**
 * Applies the one canonical prediction-resolution transition to a caller-owned
 * snapshot clone. Both the live runtime and terminal orphan recovery use this
 * function so outcome derivation, conflict handling, event payload, and the
 * durable idempotency key cannot drift between paths.
 */
export function applyReplayPremierePredictionResolutionTransition(options: {
  state: ReplayPremiereInteractionsSnapshot;
  premiereState: PremiereState;
  eligibleSeatIds: ReadonlySet<string>;
  result: PremiereCanonicalAuthoritativeResult;
  resolvedAt: string;
  wageringEnabled?: boolean;
}): ReplayPremierePredictionResolutionTransition {
  const resolvedAtMs = timestamp(options.resolvedAt, "prediction_resolved_at");
  if (
    options.premiereState !== "revealed" &&
    options.premiereState !== "archived"
  ) {
    throw conflict("predictions_not_revealable");
  }
  if (
    options.state.checkpoints.some(
      (checkpoint) =>
        checkpoint.state !== "closed" ||
        checkpoint.closesAt === null ||
        Date.parse(checkpoint.closesAt) > resolvedAtMs,
    )
  ) {
    throw conflict("prediction_checkpoint_not_closed");
  }
  const eligibleAtEveryCheckpoint = new Set(
    [...options.eligibleSeatIds].filter((seatId) =>
      options.state.checkpoints.every((checkpoint) =>
        checkpoint.optionSeatIds.includes(seatId),
      ),
    ),
  );
  const outcome = deriveReplayPremierePredictionOutcome(
    options.result,
    eligibleAtEveryCheckpoint,
  );
  const existing = options.state.checkpoints.map(
    (checkpoint) => checkpoint.resolution,
  );
  if (existing.every((resolution) => resolution !== null)) {
    if (
      !existing.every(
        (resolution) =>
          resolution !== null && samePredictionOutcome(resolution, outcome),
      )
    ) {
      throw conflict("prediction_resolution_conflict");
    }
    return {
      result: {
        resolutions: clone(existing as ReplayPremierePredictionResolution[]),
        idempotent: true,
      },
      eventPayload: json({ idempotent: true }),
      persist: false,
    };
  }
  if (existing.some((resolution) => resolution !== null)) {
    throw conflict("partial_prediction_resolution");
  }
  const resolution: ReplayPremierePredictionResolution =
    outcome.kind === "winner"
      ? {
          kind: "winner",
          winnerSeatId: outcome.winnerSeatId,
          resolvedAt: options.resolvedAt,
        }
      : {
          kind: "void",
          reason: outcome.reason,
          resolvedAt: options.resolvedAt,
        };
  for (const checkpoint of options.state.checkpoints) {
    checkpoint.resolution = clone(resolution);
  }
  if (
    options.wageringEnabled &&
    options.state.market !== null &&
    options.state.market.status === "open"
  ) {
    const marketLedger = ReplayPremiereLedger.restore({
      balances: options.state.market.ledgerBalances,
      granted: options.state.market.ledgerGranted,
    });
    const settled = settleMarket({
      market: options.state.market,
      ledger: marketLedger,
      winnerSeatId: outcome.kind === "winner" ? outcome.winnerSeatId : null,
    });
    const marketLedgerSnapshot = marketLedger.snapshot();
    options.state.market = {
      ...settled,
      ledgerBalances: marketLedgerSnapshot.balances,
      ledgerGranted: marketLedgerSnapshot.granted,
    };
  }
  return {
    result: {
      resolutions: options.state.checkpoints.map((checkpoint) =>
        clone(checkpoint.resolution as ReplayPremierePredictionResolution),
      ),
      idempotent: false,
    },
    eventPayload: json({
      checkpointIds: options.state.checkpoints.map(
        (checkpoint) => checkpoint.id,
      ),
      resolution,
    }),
    persist: true,
    persistenceIdempotencyKey: `interaction:prediction_resolution:${options.state.premiereId}`,
  };
}

function samePredictionOutcome(
  resolution: ReplayPremierePredictionResolution,
  outcome: ReplayPremierePredictionOutcome,
): boolean {
  return resolution.kind === "winner" && outcome.kind === "winner"
    ? resolution.winnerSeatId === outcome.winnerSeatId
    : resolution.kind === "void" && outcome.kind === "void"
      ? resolution.reason === outcome.reason
      : false;
}

/**
 * Concurrency-safe prediction, marker, share, and viewer instrumentation for
 * one premiere. Each mutation is prepared on a clone, durably persisted, and
 * only then made visible.
 */
export class ReplayPremiereInteractions {
  readonly premiereId: string;

  private state: ReplayPremiereInteractionsSnapshot;
  private readonly seats: Map<string, PolicyIdentity>;
  private readonly getPremiereState: () => PremiereState;
  private readonly getReleasedContext: (
    sequence: number,
  ) => ReplayPremiereReleasedContext | null;
  private readonly getLiveVisibleSequence: () => number;
  private readonly persistence: ReplayPremiereInteractionPersistence;
  private readonly signAttribution: ReplayPremiereInteractionsOptions["signAttribution"];
  private readonly canonicalPremiereUrl: string;
  private readonly now: () => Date;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly maxHeartbeatGapMs: number;
  private readonly minHeartbeatIntervalMs: number;
  private readonly limits: ReplayPremiereInteractionLimits;
  private readonly admitAnonymousWrite: ReplayPremiereAnonymousWriteAdmission;
  private readonly wageringEnabled: boolean;
  private readonly snapshotValidationOptions: ReplayPremiereInteractionsOptions;
  private mutationQueue: Promise<void> = Promise.resolve();
  private pendingMutations = 0;
  private stateEpoch = 0;
  private preparedTransitionToken: object | null = null;
  private reactionIndex: ReplayPremiereReactionIndex;
  private writesFenced = false;
  private writeFenceDrain: Promise<void> | null = null;

  constructor(options: ReplayPremiereInteractionsOptions) {
    assertPremiereId(options.premiereId);
    this.premiereId = options.premiereId;
    this.seats = new Map(
      options.seats.map((seat) => [seat.seatId, clone(seat.policyIdentity)]),
    );
    if (this.seats.size < 2 || this.seats.size !== options.seats.length) {
      throw invalidInteraction("invalid_or_duplicate_seats");
    }
    for (const seat of options.seats) {
      assertSeatId(seat.seatId);
      identityKey(seat.policyIdentity);
    }
    this.getPremiereState = options.getPremiereState;
    this.getReleasedContext = options.getReleasedContext;
    this.getLiveVisibleSequence = options.getLiveVisibleSequence;
    this.persistence = options.persistence;
    this.signAttribution = options.signAttribution;
    this.canonicalPremiereUrl = canonicalUrl(options.canonicalPremiereUrl);
    this.now = options.now ?? (() => new Date());
    this.randomBytes =
      options.randomBytes ??
      ((size: number): Uint8Array => {
        const bytes = new Uint8Array(size);
        globalThis.crypto.getRandomValues(bytes);
        return bytes;
      });
    this.maxHeartbeatGapMs = validatePositiveInteger(
      options.maxHeartbeatGapMs ?? 60_000,
      "max_heartbeat_gap",
    );
    this.minHeartbeatIntervalMs = validatePositiveInteger(
      options.minHeartbeatIntervalMs ?? 1_000,
      "min_heartbeat_interval",
    );
    if (this.minHeartbeatIntervalMs > this.maxHeartbeatGapMs) {
      throw invalidInteraction("heartbeat_interval_exceeds_gap");
    }
    this.limits = resolveInteractionLimits(options.limits);
    if (typeof options.admitAnonymousWrite !== "function") {
      throw invalidInteraction("anonymous_write_admission_required");
    }
    this.admitAnonymousWrite = options.admitAnonymousWrite;
    this.wageringEnabled = options.wageringEnabled ?? false;
    this.snapshotValidationOptions = {
      ...options,
      limits: this.limits,
      initialState: undefined,
    };
    if (options.initialState === undefined) {
      this.state = createInitialSnapshot(options);
      this.reactionIndex = createReactionIndex();
    } else {
      const recovered = validateSnapshotAndCreateReactionIndex(
        clone(options.initialState),
        options,
      );
      this.state = recovered.snapshot;
      this.reactionIndex = recovered.reactionIndex;
    }
    freezeReactionEvidence(this.state.reactions);
  }

  readState(): ReplayPremiereInteractionsSnapshot {
    return clone(this.state);
  }

  hasCompletePredictionResolution(): boolean {
    return hasCompleteReplayPremierePredictionResolution(this.state);
  }

  /**
   * Whether this premiere runs the LMSR wagering market. The runtime
   * coordinator reads this to decide whether a checkpoint boundary should
   * pause the release clock (legacy prediction-checkpoint behavior,
   * unchanged) or pass straight through with no window (see
   * `prepareMarkCheckpointPassed`) — single source of truth, never
   * duplicated as a second constructor flag on the coordinator.
   */
  isWageringEnabled(): boolean {
    return this.wageringEnabled;
  }

  restoreState(snapshot: ReplayPremiereInteractionsSnapshot): void {
    this.assertWritesOpen();
    if (this.preparedTransitionToken !== null || this.pendingMutations !== 0) {
      throw conflict("interaction_restore_while_busy");
    }
    const restored = validateSnapshotAndCreateReactionIndex(
      clone(snapshot),
      this.snapshotValidationOptions,
    );
    this.reactionIndex = restored.reactionIndex;
    freezeReactionEvidence(restored.snapshot.reactions);
    this.state = restored.snapshot;
    this.stateEpoch += 1;
  }

  /**
   * Irreversibly closes write admission for terminal reclamation. Mutations
   * admitted before the fence retain their queue position and are allowed to
   * settle; later callers fail before entering the queue.
   */
  fenceWritesAndDrain(): Promise<void> {
    if (this.writeFenceDrain !== null) return this.writeFenceDrain;
    this.writesFenced = true;
    const admittedQueue = this.mutationQueue;
    this.writeFenceDrain = admittedQueue.then(() => {
      if (this.pendingMutations !== 0) {
        throw conflict("interaction_write_drain_incomplete");
      }
      if (this.preparedTransitionToken !== null) {
        throw conflict("interaction_prepared_transition_during_write_drain");
      }
    });
    return this.writeFenceDrain;
  }

  usesAnonymousWriteAdmission(
    admission: ReplayPremiereAnonymousWriteAdmission,
  ): boolean {
    return this.admitAnonymousWrite === admission;
  }

  readCheckpoints(
    participantId: string | null,
  ): ReplayPremiereCheckpointView[] {
    return this.state.checkpoints.map((checkpoint) =>
      this.readCheckpoint(checkpoint.id, participantId),
    );
  }

  readReactionSummary(
    participantId: string | null,
  ): ReplayPremiereReactionSummary {
    if (participantId !== null) assertParticipantId(participantId);
    this.assertReactionIndexSynchronized();
    const ownCounts =
      participantId === null
        ? null
        : this.reactionIndex.byParticipantKind.get(participantId);
    return {
      totalReactions: this.reactionIndex.totalReactions,
      distinctParticipants: this.reactionIndex.byParticipantKind.size,
      byKind: cloneReactionCounts(this.reactionIndex.byKind),
      ownByKind:
        participantId === null
          ? null
          : cloneReactionCounts(ownCounts ?? emptyReactionCounts()),
    };
  }

  readLatestOwnReaction(
    participantId: string | null,
  ): ReplayPremiereLatestOwnReaction | null {
    this.assertReactionIndexSynchronized();
    if (participantId === null) return null;
    assertParticipantId(participantId);
    return clone(
      this.reactionIndex.latestByParticipant.get(participantId) ?? null,
    );
  }

  readShareMoment(shareId: string): ReplayPremiereShareMoment | null {
    assertShareId(shareId);
    const share = this.state.shares.find(
      (candidate) => candidate.id === shareId,
    );
    return share === undefined ? null : clone(share);
  }

  /**
   * Live, poll-friendly market state — one continuous market spans the
   * whole premiere and trades continuously from match start to reveal, not
   * gated to checkpoints. Visible to every caller at any time: the whole
   * point of a live market is that the crowd sees prices move as trades
   * land, and exposing current `q`/prices never leaks anything about the
   * eventual outcome, only current trading activity. `submitMarketOrder`
   * alone enforces when orders may execute — this is a pure read.
   */
  readMarketState(
    participantId: string | null,
  ): ReplayPremiereMarketStateView | null {
    if (participantId !== null) assertParticipantId(participantId);
    if (!this.wageringEnabled || this.state.market === null) return null;
    const market = this.state.market;
    return {
      outcomeSeatIds: [...market.outcomeSeatIds],
      b: market.b,
      q: [...market.q],
      prices: computeMarketPrices(market),
      status: market.status,
      winnerSeatId: market.winnerSeatId,
      liveVisibleSequence: this.getLiveVisibleSequence(),
      positions:
        participantId === null ? null : positionsFor(market, participantId),
      // Authoritative available balance for the calling participant — the
      // ONLY money number the client may trust across a reload/new tab.
      // Mirrors submitMarketOrder's own lazy-grant semantics (a
      // never-before-traded participant reads as STARTING_BANKROLL, the
      // exact amount their first order would actually be granted and
      // charged against) without granting anything on this read — a pure
      // read never mutates the ledger.
      balance:
        participantId === null
          ? null
          : (market.ledgerGranted[participantId] ?? 0) > 0
            ? (market.ledgerBalances[participantId] ?? 0)
            : STARTING_BANKROLL,
    };
  }

  readCheckpoint(
    checkpointId: string,
    participantId: string | null,
  ): ReplayPremiereCheckpointView {
    assertCheckpointId(checkpointId);
    if (participantId !== null) assertParticipantId(participantId);
    const checkpoint = this.state.checkpoints.find(
      (candidate) => candidate.id === checkpointId,
    );
    if (checkpoint === undefined) throw notFound("checkpoint_not_found");
    const participantPrediction =
      participantId === null
        ? null
        : (this.state.predictions.find(
            (prediction) =>
              prediction.checkpointId === checkpointId &&
              prediction.participantId === participantId,
          ) ?? null);
    const nowMs = this.nowChecked().getTime();
    const isClosed =
      checkpoint.state === "closed" ||
      (checkpoint.closesAt !== null &&
        nowMs >= Date.parse(checkpoint.closesAt));
    const maySeeDistribution = participantPrediction !== null || isClosed;
    const distribution = maySeeDistribution
      ? Object.fromEntries(
          checkpoint.optionSeatIds.map((seatId) => [seatId, 0]),
        )
      : null;
    let total = 0;
    if (distribution !== null) {
      for (const prediction of this.state.predictions) {
        if (prediction.checkpointId === checkpointId) {
          distribution[prediction.selectedSeatId] =
            (distribution[prediction.selectedSeatId] ?? 0) + 1;
          total += 1;
        }
      }
    }
    const premiereState = this.getPremiereState();
    const resolution =
      premiereState === "revealed" || premiereState === "archived"
        ? clone(checkpoint.resolution)
        : null;
    let crowdAccuracy: ReplayPremiereCrowdAccuracy | null = null;
    if (resolution?.kind === "winner") {
      const predictions = this.state.predictions.filter(
        (prediction) => prediction.checkpointId === checkpointId,
      );
      crowdAccuracy = {
        correctPredictions: predictions.filter(
          (prediction) => prediction.selectedSeatId === resolution.winnerSeatId,
        ).length,
        totalPredictions: predictions.length,
      };
    }
    return {
      ...clone(checkpoint),
      state: isClosed ? "closed" : checkpoint.state,
      participantPrediction: clone(participantPrediction),
      distribution,
      totalPredictions: distribution === null ? null : total,
      resolution,
      crowdAccuracy,
    };
  }

  async openCheckpoint(options: {
    checkpointId: string;
    opensAt: string;
    closesAt: string;
    optionSeatIds: readonly string[];
  }): Promise<ReplayPremiereInteractionCheckpoint> {
    const prepared = this.prepareOpenCheckpoint(options);
    try {
      await this.persistence.persist({
        eventType: "checkpoint_opened",
        occurredAt: options.opensAt,
        eventPayload: json({ checkpoint: prepared.result }),
        nextState: prepared.nextState,
        idempotencyKey: `interaction:checkpoint_open:${prepared.result.id}`,
      });
      prepared.commit();
      return prepared.result;
    } catch (error) {
      prepared.abort();
      throw error;
    }
  }

  prepareOpenCheckpoint(options: {
    checkpointId: string;
    opensAt: string;
    closesAt: string;
    optionSeatIds: readonly string[];
  }): ReplayPremierePreparedInteractionTransition<ReplayPremiereInteractionCheckpoint> {
    return this.prepareCheckpointTransition((next) => {
      const checkpoint = findCheckpoint(next, options.checkpointId);
      if (checkpoint.state !== "upcoming") {
        throw conflict("checkpoint_already_opened");
      }
      const opensAtMs = timestamp(options.opensAt, "checkpoint_opens_at");
      const closesAtMs = timestamp(options.closesAt, "checkpoint_closes_at");
      // The window must exactly equal the release pause: predictions close
      // before any post-checkpoint content is released, and the pause covers
      // the viewer's presentation trail plus a real 15 s voting window.
      if (closesAtMs - opensAtMs !== REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS) {
        throw invalidInteraction("checkpoint_duration_invalid");
      }
      const optionSeatIds = [...options.optionSeatIds];
      if (
        optionSeatIds.length < 2 ||
        new Set(optionSeatIds).size !== optionSeatIds.length ||
        optionSeatIds.some((seatId) => !this.seats.has(seatId))
      ) {
        throw invalidInteraction("invalid_checkpoint_options");
      }
      checkpoint.opensAt = options.opensAt;
      checkpoint.closesAt = options.closesAt;
      checkpoint.outageShiftMs = 0;
      checkpoint.optionSeatIds = optionSeatIds;
      checkpoint.state = "open";
      return clone(checkpoint);
    });
  }

  /**
   * Wagering-only sibling of `prepareOpenCheckpoint` + `prepareCloseCheckpoint`:
   * passes a checkpoint straight from "upcoming" to "closed" in one durable
   * step, at the instant the coordinator releases its content, with no open
   * window and no `REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS` pause — the replay
   * clock never halts for a wagering premiere. `optionSeatIds` is still
   * recorded (from the same checkpoint projection the legacy path uses) so
   * post-reveal prediction-resolution eligibility derivation stays correct;
   * only the pause and the open voting window are gone, per operator
   * direction that /premiere/<id> (non-wagering) is untouched. Callers must
   * keep the runtime's own `completedCheckpointIds` in lockstep with this in
   * the same persisted step — the coordinator's `validateRuntimeSnapshot`
   * requires every interaction checkpoint past the completed prefix to
   * still read "upcoming".
   */
  prepareMarkCheckpointPassed(options: {
    checkpointId: string;
    occurredAt: string;
    optionSeatIds: readonly string[];
  }): ReplayPremierePreparedInteractionTransition<ReplayPremiereInteractionCheckpoint> {
    if (!this.wageringEnabled) throw invalidInteraction("wagering_disabled");
    return this.prepareCheckpointTransition((next) => {
      const checkpoint = findCheckpoint(next, options.checkpointId);
      if (checkpoint.state !== "upcoming") {
        throw conflict("checkpoint_already_opened");
      }
      timestamp(options.occurredAt, "checkpoint_passed_at");
      const optionSeatIds = [...options.optionSeatIds];
      if (
        optionSeatIds.length < 2 ||
        new Set(optionSeatIds).size !== optionSeatIds.length ||
        optionSeatIds.some((seatId) => !this.seats.has(seatId))
      ) {
        throw invalidInteraction("invalid_checkpoint_options");
      }
      checkpoint.opensAt = options.occurredAt;
      checkpoint.closesAt = options.occurredAt;
      checkpoint.outageShiftMs = 0;
      checkpoint.optionSeatIds = optionSeatIds;
      checkpoint.state = "closed";
      return clone(checkpoint);
    });
  }

  async shiftOpenCheckpointForOutage(options: {
    checkpointId: string;
    outageMs: number;
    occurredAt: string;
  }): Promise<ReplayPremiereInteractionCheckpoint> {
    const prepared = this.prepareShiftOpenCheckpointForOutage(options);
    try {
      await this.persistence.persist({
        eventType: "checkpoint_outage_shifted",
        occurredAt: options.occurredAt,
        eventPayload: json({
          checkpointId: prepared.result.id,
          outageMs: options.outageMs,
          closesAt: prepared.result.closesAt,
        }),
        nextState: prepared.nextState,
      });
      prepared.commit();
      return prepared.result;
    } catch (error) {
      prepared.abort();
      throw error;
    }
  }

  prepareShiftOpenCheckpointForOutage(options: {
    checkpointId: string;
    outageMs: number;
    occurredAt: string;
  }): ReplayPremierePreparedInteractionTransition<ReplayPremiereInteractionCheckpoint> {
    timestamp(options.occurredAt, "checkpoint_outage_occurred_at");
    return this.prepareCheckpointTransition((next) => {
      const checkpoint = findCheckpoint(next, options.checkpointId);
      if (
        checkpoint.state !== "open" ||
        checkpoint.opensAt === null ||
        checkpoint.closesAt === null ||
        !Number.isSafeInteger(options.outageMs) ||
        options.outageMs < 0 ||
        options.outageMs > 60_000 ||
        checkpoint.outageShiftMs + options.outageMs > 60_000
      ) {
        throw invalidInteraction("invalid_checkpoint_outage_shift");
      }
      checkpoint.closesAt = new Date(
        Date.parse(checkpoint.closesAt) + options.outageMs,
      ).toISOString();
      checkpoint.outageShiftMs += options.outageMs;
      return clone(checkpoint);
    });
  }

  async closeCheckpoint(
    checkpointId: string,
    closedAt: string,
  ): Promise<ReplayPremiereInteractionCheckpoint> {
    const prepared = this.prepareCloseCheckpoint(checkpointId, closedAt);
    try {
      await this.persistence.persist({
        eventType: "checkpoint_closed",
        occurredAt: closedAt,
        eventPayload: json({ checkpointId, closedAt }),
        nextState: prepared.nextState,
        idempotencyKey: `interaction:checkpoint_close:${prepared.result.id}`,
      });
      prepared.commit();
      return prepared.result;
    } catch (error) {
      prepared.abort();
      throw error;
    }
  }

  prepareCloseCheckpoint(
    checkpointId: string,
    closedAt: string,
  ): ReplayPremierePreparedInteractionTransition<ReplayPremiereInteractionCheckpoint> {
    return this.prepareCheckpointTransition((next) => {
      const checkpoint = findCheckpoint(next, checkpointId);
      if (
        checkpoint.state !== "open" ||
        checkpoint.closesAt === null ||
        timestamp(closedAt, "checkpoint_closed_at") <
          Date.parse(checkpoint.closesAt)
      ) {
        throw conflict("checkpoint_not_closeable");
      }
      checkpoint.state = "closed";
      return clone(checkpoint);
    });
  }

  async resolvePredictionsFromAuthoritativeResult(options: {
    result: PremiereCanonicalAuthoritativeResult;
    resolvedAt: string;
  }): Promise<{
    resolutions: ReplayPremierePredictionResolution[];
    idempotent: boolean;
  }> {
    return this.mutate<{
      resolutions: ReplayPremierePredictionResolution[];
      idempotent: boolean;
    }>("predictions_resolved", options.resolvedAt, (next) => {
      const transition = applyReplayPremierePredictionResolutionTransition({
        state: next,
        premiereState: this.getPremiereState(),
        eligibleSeatIds: new Set(this.seats.keys()),
        result: options.result,
        resolvedAt: options.resolvedAt,
        wageringEnabled: this.wageringEnabled,
      });
      return {
        result: transition.result,
        payload: transition.eventPayload,
        persist: transition.persist,
        persistenceIdempotencyKey: transition.persistenceIdempotencyKey,
      };
    });
  }

  async submitPrediction(options: {
    participantId: string;
    sessionId: string;
    idempotencyKey: string;
    requesterBucketId: string;
    checkpointId: string;
    selectedSeatId: string;
  }): Promise<{ prediction: ReplayPremierePrediction; idempotent: boolean }> {
    this.assertWritesOpen();
    const occurredAt = this.nowChecked().toISOString();
    assertParticipantId(options.participantId);
    assertSessionId(options.sessionId);
    assertIdempotencyKey(options.idempotencyKey);
    assertRequesterBucketId(options.requesterBucketId);
    assertCheckpointId(options.checkpointId);
    assertSeatId(options.selectedSeatId);
    this.admitAnonymousWrite({
      route: "prediction",
      premiereId: this.premiereId,
      participantId: options.participantId,
      sessionId: options.sessionId,
      requesterBucketId: options.requesterBucketId,
      idempotencyKey: options.idempotencyKey,
      occurredAt,
      currentPremiereRecordCount: premiereRecordCount(this.state),
    });
    ownedSession(this.state, options.sessionId, options.participantId);
    return this.mutate<{
      prediction: ReplayPremierePrediction;
      idempotent: boolean;
    }>("prediction_submitted", occurredAt, (next) => {
      assertParticipantId(options.participantId);
      assertSessionId(options.sessionId);
      assertCheckpointId(options.checkpointId);
      assertSeatId(options.selectedSeatId);
      const existing = next.predictions.find(
        (prediction) =>
          prediction.checkpointId === options.checkpointId &&
          prediction.participantId === options.participantId,
      );
      const session = ownedSession(
        next,
        options.sessionId,
        options.participantId,
      );
      if (existing !== undefined) {
        if (existing.selectedSeatId !== options.selectedSeatId) {
          throw conflict("prediction_conflict");
        }
        return {
          result: { prediction: clone(existing), idempotent: true },
          payload: json({
            checkpointId: options.checkpointId,
            participantId: options.participantId,
            idempotent: true,
          }),
          persist: false,
        };
      }
      const checkpoint = findCheckpoint(next, options.checkpointId);
      const nowMs = Date.parse(occurredAt);
      if (
        checkpoint.state !== "open" ||
        checkpoint.opensAt === null ||
        checkpoint.closesAt === null ||
        nowMs < Date.parse(checkpoint.opensAt) ||
        nowMs >= Date.parse(checkpoint.closesAt)
      ) {
        throw gone("prediction_window_closed");
      }
      if (!checkpoint.optionSeatIds.includes(options.selectedSeatId)) {
        throw invalidInteraction("prediction_option_not_eligible");
      }
      const prediction: ReplayPremierePrediction = {
        premiereId: this.premiereId,
        checkpointId: options.checkpointId,
        participantId: options.participantId,
        selectedSeatId: options.selectedSeatId,
        submittedAt: occurredAt,
        lockedAt: occurredAt,
      };
      assertPremiereRecordCapacity(next, this.limits, 1);
      next.predictions.push(prediction);
      recordSessionAction(session, "prediction", occurredAt);
      return {
        result: { prediction: clone(prediction), idempotent: false },
        payload: json({ prediction }),
        persistenceIdempotencyKey: `interaction:prediction:${options.checkpointId}:${options.participantId}`,
      };
    });
  }
  async submitMarketOrder(options: {
    participantId: string;
    participantKind: ReplayPremiereMarketParticipantKind;
    sessionId: string;
    idempotencyKey: string;
    requesterBucketId: string;
    seatId: string;
    side: "buy" | "sell";
    /**
     * The highest sequence the caller currently observes as live-visible
     * (`readMarketState(...).liveVisibleSequence`). Never trusted as an
     * upper bound by itself — validated against this server's own
     * `getLiveVisibleSequence()` at accept time, so a client cannot trade
     * on any sequence the server itself has not yet independently
     * surfaced, regardless of how the client obtained it.
     */
    sequence: number;
    /** Buy: credit budget to spend. Sell: exact share count (send the full held amount to sell all). */
    amount: number;
    /** 0..100. Ceiling for a buy, floor for a sell — the whole order is rejected if the execution price would be worse, never silently filled worse. */
    limitPrice: number;
  }): Promise<{ trade: ReplayPremiereMarketTrade; idempotent: boolean }> {
    if (!this.wageringEnabled) throw invalidInteraction("wagering_disabled");
    this.assertWritesOpen();
    const occurredAt = this.nowChecked().toISOString();
    assertParticipantId(options.participantId);
    assertSessionId(options.sessionId);
    assertIdempotencyKey(options.idempotencyKey);
    assertRequesterBucketId(options.requesterBucketId);
    assertSeatId(options.seatId);
    assertSequence(options.sequence);
    if (options.side !== "buy" && options.side !== "sell") {
      throw invalidInteraction("invalid_order_side");
    }
    if (
      options.participantKind !== "real" &&
      options.participantKind !== "synthetic"
    ) {
      throw invalidInteraction("invalid_participant_kind");
    }
    if (!Number.isSafeInteger(options.amount) || options.amount <= 0) {
      throw invalidInteraction("invalid_order_amount");
    }
    if (
      !Number.isFinite(options.limitPrice) ||
      options.limitPrice < 0 ||
      options.limitPrice > 100
    ) {
      throw invalidInteraction("invalid_limit_price");
    }
    this.admitAnonymousWrite({
      route: "market_order",
      premiereId: this.premiereId,
      participantId: options.participantId,
      sessionId: options.sessionId,
      requesterBucketId: options.requesterBucketId,
      idempotencyKey: options.idempotencyKey,
      occurredAt,
      currentPremiereRecordCount: premiereRecordCount(this.state),
    });
    ownedSession(this.state, options.sessionId, options.participantId);
    return this.mutate<{
      trade: ReplayPremiereMarketTrade;
      idempotent: boolean;
    }>("market_order_submitted", occurredAt, (next) => {
      assertParticipantId(options.participantId);
      assertSessionId(options.sessionId);
      assertSeatId(options.seatId);
      ownedSession(next, options.sessionId, options.participantId);
      const existingTrade = next.trades.find(
        (trade) =>
          trade.participantId === options.participantId &&
          trade.idempotencyKey === options.idempotencyKey,
      );
      if (existingTrade !== undefined) {
        return {
          result: { trade: clone(existingTrade), idempotent: true },
          payload: json({ tradeId: existingTrade.id, idempotent: true }),
          persist: false,
        };
      }
      if (next.market === null) {
        throw invalidInteraction("market_not_initialized");
      }
      if (!next.market.outcomeSeatIds.includes(options.seatId)) {
        throw invalidInteraction("order_seat_not_eligible");
      }
      // Continuous market, no checkpoint gate: trading is live whenever the
      // match itself is live. Server-authoritative — `this.getPremiereState()`
      // is never client-supplied, unlike an `observedSequence` heartbeat
      // marker, which is client-reported and is never a trust boundary here.
      const premiereState = this.getPremiereState();
      if (premiereState !== "playing" && premiereState !== "checkpoint") {
        throw gone("market_not_live");
      }
      // The real anti-read-ahead property: bind the order to the server's
      // own fine-grained release clock (independent of chunk-release
      // batching — see `ReplayPremiereRuntimeCoordinator.
      // readLiveVisibleSequence`), not to `getPremiereState()` alone. Even a
      // client that somehow obtained future game state through some other
      // channel cannot trade on it: the server refuses any order claiming a
      // sequence beyond what it itself currently reveals.
      if (options.sequence > this.getLiveVisibleSequence()) {
        throw gone("order_sequence_unreleased");
      }
      // Server-authoritative, never client-trusted: the pre-trade `q` this
      // order prices off of is whatever `next.market` holds at the moment
      // this callback runs — the single ordered mutation queue below
      // (`mutate()`) is what guarantees two concurrent orders never price
      // off the same `q`, and that the `q` update and the ledger
      // debit/credit commit atomically in the same durable transaction.
      const ledger = ReplayPremiereLedger.restore({
        balances: next.market.ledgerBalances,
        granted: next.market.ledgerGranted,
      });
      if (ledger.grantedTo(options.participantId) === 0) {
        ledger.grant(options.participantId, STARTING_BANKROLL);
      }
      let shares: number;
      if (options.side === "buy") {
        const bankroll = ledger.balanceOf(options.participantId);
        const validation = validateBuyStake(options.amount, bankroll);
        if (!validation.ok) {
          throw invalidInteraction(`order_rejected_${validation.reason}`);
        }
        shares = maxSharesForBudget(next.market, options.seatId, options.amount);
        if (shares <= 0) throw invalidInteraction("order_rejected_zero_shares");
        const fill = quoteBuy(next.market, options.seatId, shares);
        if (fill.avgPrice > options.limitPrice) {
          throw invalidInteraction("order_rejected_slippage_exceeded");
        }
      } else {
        const held = sharesHeld(next.market, options.participantId, options.seatId);
        if (held <= 0) {
          throw invalidInteraction("order_rejected_no_shares_to_sell");
        }
        shares = Math.min(options.amount, held);
        if (shares <= 0) throw invalidInteraction("order_rejected_zero_shares");
        const fill = quoteSell(next.market, options.seatId, shares);
        if (fill.avgPrice < options.limitPrice) {
          throw invalidInteraction("order_rejected_slippage_exceeded");
        }
      }
      const applied =
        options.side === "buy"
          ? applyBuy({
              market: next.market,
              ledger,
              participantId: options.participantId,
              seatId: options.seatId,
              shares,
            })
          : applySell({
              market: next.market,
              ledger,
              participantId: options.participantId,
              seatId: options.seatId,
              shares,
            });
      const avgPrice = shares > 0 ? applied.chips / shares : 0;
      const ledgerSnapshot = ledger.snapshot();
      next.market = {
        ...applied.market,
        ledgerBalances: ledgerSnapshot.balances,
        ledgerGranted: ledgerSnapshot.granted,
      };
      const trade: ReplayPremiereMarketTrade = {
        id: `trade_${this.randomHex(16)}`,
        premiereId: this.premiereId,
        participantId: options.participantId,
        participantKind: options.participantKind,
        seatId: options.seatId,
        side: options.side,
        shares,
        chips: applied.chips,
        avgPrice,
        executedAt: occurredAt,
        sequence: options.sequence,
        idempotencyKey: options.idempotencyKey,
      };
      assertPremiereRecordCapacity(next, this.limits, 1);
      next.trades.push(trade);
      return {
        result: { trade: clone(trade), idempotent: false },
        payload: json({ trade }),
        persistenceIdempotencyKey: `interaction:market_order:${options.participantId}:${options.idempotencyKey}`,
      };
    });
  }

  async submitReaction(options: {
    participantId: string;
    sessionId: string;
    idempotencyKey: string;
    requesterBucketId: string;
    sequence: number;
    kind: ReplayPremiereReactionKind;
    policySeatId?: string | null;
  }): Promise<{ reaction: ReplayPremiereReaction; idempotent: boolean }> {
    this.assertWritesOpen();
    const occurredAt = this.nowChecked().toISOString();
    assertParticipantId(options.participantId);
    assertSessionId(options.sessionId);
    assertIdempotencyKey(options.idempotencyKey);
    assertRequesterBucketId(options.requesterBucketId);
    assertSequence(options.sequence);
    if (!isReactionKind(options.kind)) {
      throw invalidInteraction("invalid_reaction_kind");
    }
    this.admitAnonymousWrite({
      route: "reaction",
      premiereId: this.premiereId,
      participantId: options.participantId,
      sessionId: options.sessionId,
      requesterBucketId: options.requesterBucketId,
      idempotencyKey: options.idempotencyKey,
      occurredAt,
      currentPremiereRecordCount: premiereRecordCount(this.state),
    });
    ownedSession(this.state, options.sessionId, options.participantId);
    return this.mutate<{
      reaction: ReplayPremiereReaction;
      idempotent: boolean;
    }>("reaction_submitted", occurredAt, (next) => {
      assertParticipantId(options.participantId);
      assertSessionId(options.sessionId);
      assertSequence(options.sequence);
      if (!isReactionKind(options.kind)) {
        throw invalidInteraction("invalid_reaction_kind");
      }
      if (this.getPremiereState() === "archived") {
        throw gone("reactions_archived");
      }
      const context = this.getReleasedContext(options.sequence);
      if (
        context === null ||
        options.sequence > context.releasedThroughSequence
      ) {
        throw gone("reaction_sequence_unreleased");
      }
      const policyIdentity =
        options.policySeatId === null || options.policySeatId === undefined
          ? null
          : this.seats.get(options.policySeatId);
      if (options.policySeatId !== undefined && options.policySeatId !== null) {
        assertSeatId(options.policySeatId);
        if (policyIdentity === undefined) {
          throw invalidInteraction("reaction_policy_not_in_premiere");
        }
      }
      const existing = next.reactions.find(
        (reaction) =>
          reaction.participantId === options.participantId &&
          reaction.sequence === options.sequence &&
          reaction.kind === options.kind,
      );
      if (existing !== undefined) {
        return {
          result: { reaction: clone(existing), idempotent: true },
          payload: json({ reactionId: existing.id, idempotent: true }),
          persist: false,
        };
      }
      const participantReactions = next.reactions.filter(
        (reaction) => reaction.participantId === options.participantId,
      );
      if (participantReactions.length >= 30) {
        throw rateLimited("reaction_total_limit_exceeded");
      }
      const rollingStart = Date.parse(occurredAt) - 60_000;
      if (
        participantReactions.filter(
          (reaction) => Date.parse(reaction.createdAt) > rollingStart,
        ).length >= 5
      ) {
        throw rateLimited("reaction_rate_limit_exceeded");
      }
      const session = ownedSession(
        next,
        options.sessionId,
        options.participantId,
      );
      const reaction: ReplayPremiereReaction = {
        id: `react_${this.randomHex(16)}`,
        premiereId: this.premiereId,
        participantId: options.participantId,
        sequence: options.sequence,
        turn: context.turn,
        kind: options.kind,
        policyIdentity:
          policyIdentity === undefined ? null : clone(policyIdentity),
        eventContext: clone(context.eventContext),
        createdAt: occurredAt,
      };
      assertPremiereRecordCapacity(next, this.limits, 1);
      recordSessionAction(session, "reaction", occurredAt);
      return {
        result: { reaction: clone(reaction), idempotent: false },
        payload: json({ reaction }),
        persistenceIdempotencyKey: `interaction:reaction:${options.participantId}:${options.sequence}:${options.kind}`,
        appendedReaction: {
          reaction,
          releasedContext: clone(context),
        },
      };
    });
  }

  async createShare(options: {
    participantId: string;
    sessionId: string;
    idempotencyKey: string;
    requesterBucketId: string;
    sourceReactionId?: string | null;
    sequence?: number | null;
  }): Promise<{
    share: ReplayPremiereShareMoment;
    attributionToken: string;
    url: string;
    idempotent: boolean;
  }> {
    this.assertWritesOpen();
    const occurredAt = this.nowChecked().toISOString();
    assertParticipantId(options.participantId);
    assertSessionId(options.sessionId);
    assertIdempotencyKey(options.idempotencyKey);
    assertRequesterBucketId(options.requesterBucketId);
    this.admitAnonymousWrite({
      route: "share",
      premiereId: this.premiereId,
      participantId: options.participantId,
      sessionId: options.sessionId,
      requesterBucketId: options.requesterBucketId,
      idempotencyKey: options.idempotencyKey,
      occurredAt,
      currentPremiereRecordCount: premiereRecordCount(this.state),
    });
    ownedSession(this.state, options.sessionId, options.participantId);
    return this.mutate<{
      share: ReplayPremiereShareMoment;
      attributionToken: string;
      url: string;
      idempotent: boolean;
    }>("share_created", occurredAt, (next) => {
      assertParticipantId(options.participantId);
      assertSessionId(options.sessionId);
      assertIdempotencyKey(options.idempotencyKey);
      assertRequesterBucketId(options.requesterBucketId);
      const session = ownedSession(
        next,
        options.sessionId,
        options.participantId,
      );
      const sourceReaction =
        options.sourceReactionId === null ||
        options.sourceReactionId === undefined
          ? null
          : next.reactions.find(
              (reaction) => reaction.id === options.sourceReactionId,
            );
      if (
        options.sourceReactionId !== undefined &&
        options.sourceReactionId !== null
      ) {
        assertReactionId(options.sourceReactionId);
        if (sourceReaction === undefined) throw notFound("reaction_not_found");
      }
      const sequence = sourceReaction?.sequence ?? options.sequence;
      if (sequence === null || sequence === undefined) {
        throw invalidInteraction("share_sequence_required");
      }
      assertSequence(sequence);
      const sourceReactionId = sourceReaction?.id ?? null;
      const existing = next.shares.find(
        (share) =>
          share.createdByParticipantId === options.participantId &&
          share.idempotencyKey === options.idempotencyKey,
      );
      if (existing !== undefined) {
        if (
          existing.sourceReactionId !== sourceReactionId ||
          existing.sequence !== sequence
        ) {
          throw conflict("share_idempotency_conflict");
        }
        const attributionToken = this.signAttribution({
          attributionId: options.participantId,
          shareId: existing.id,
          premiereId: this.premiereId,
        });
        const url = shareUrl(
          this.canonicalPremiereUrl,
          existing.id,
          attributionToken,
        );
        return {
          result: {
            share: clone(existing),
            attributionToken,
            url,
            idempotent: true,
          },
          payload: json({ shareId: existing.id, idempotent: true }),
          persist: false,
        };
      }
      const context = this.getReleasedContext(sequence);
      if (context === null || sequence > context.releasedThroughSequence) {
        throw gone("share_sequence_unreleased");
      }
      const participantShares = next.shares.filter(
        (share) => share.createdByParticipantId === options.participantId,
      );
      if (
        next.shares.length >= this.limits.maxSharesPerPremiere ||
        participantShares.length >= this.limits.maxSharesPerParticipant ||
        session.shareCount >= this.limits.maxSharesPerSession
      ) {
        throw rateLimited("share_record_limit_exceeded");
      }
      const rollingStart = Date.parse(occurredAt) - 60_000;
      if (
        participantShares.filter(
          (share) => Date.parse(share.createdAt) > rollingStart,
        ).length >= this.limits.maxShareCreatesPerParticipantPerMinute
      ) {
        throw rateLimited("share_rate_limit_exceeded");
      }
      assertPremiereRecordCapacity(next, this.limits, 1);
      const share: ReplayPremiereShareMoment = {
        id: `share_${this.randomHex(16)}`,
        premiereId: this.premiereId,
        sourceReactionId,
        sequence,
        turn: context.turn,
        createdByParticipantId: options.participantId,
        cardVersion: 1,
        createdAt: occurredAt,
        idempotencyKey: options.idempotencyKey,
      };
      next.shares.push(share);
      recordSessionAction(session, "share", occurredAt);
      const attributionToken = this.signAttribution({
        attributionId: options.participantId,
        shareId: share.id,
        premiereId: this.premiereId,
      });
      const url = shareUrl(
        this.canonicalPremiereUrl,
        share.id,
        attributionToken,
      );
      return {
        result: {
          share: clone(share),
          attributionToken,
          url,
          idempotent: false,
        },
        payload: json({ share }),
        persistenceIdempotencyKey: `interaction:share:${options.participantId}:${options.idempotencyKey}`,
      };
    });
  }

  async createViewerSession(options: {
    participantId: string;
    idempotencyKey: string;
    requesterBucketId: string;
    visible: boolean;
    observedSequence: number;
    excludedAsOperator: boolean;
    excludedAsBot: boolean;
    incomingAttribution?: ReplayPremiereShareAttribution | null;
  }): Promise<ReplayPremiereViewerSession> {
    this.assertWritesOpen();
    const occurredAt = this.nowChecked().toISOString();
    assertParticipantId(options.participantId);
    assertIdempotencyKey(options.idempotencyKey);
    assertRequesterBucketId(options.requesterBucketId);
    this.admitAnonymousWrite({
      route: "session",
      premiereId: this.premiereId,
      participantId: options.participantId,
      sessionId: null,
      requesterBucketId: options.requesterBucketId,
      idempotencyKey: options.idempotencyKey,
      occurredAt,
      currentPremiereRecordCount: premiereRecordCount(this.state),
    });
    return this.mutate("viewer_session_started", occurredAt, (next) => {
      assertParticipantId(options.participantId);
      assertIdempotencyKey(options.idempotencyKey);
      assertRequesterBucketId(options.requesterBucketId);
      this.assertAuthoritativeObservedSequence(options.observedSequence);
      const incomingAttribution = options.incomingAttribution ?? null;
      if (
        incomingAttribution !== null &&
        incomingAttribution.premiereId !== this.premiereId
      ) {
        throw invalidInteraction("attribution_premiere_mismatch");
      }
      if (incomingAttribution !== null) {
        validateAttribution(incomingAttribution, this.premiereId);
      }
      const creationRequestHash = hashReplayPremiereJson(
        json({
          participantId: options.participantId,
          visible: options.visible,
          observedSequence: options.observedSequence,
          excludedAsOperator: options.excludedAsOperator,
          excludedAsBot: options.excludedAsBot,
          incomingAttribution,
        }),
      );
      const existingSession = next.sessions.find(
        (session) =>
          session.participantId === options.participantId &&
          session.idempotencyKey === options.idempotencyKey,
      );
      if (existingSession !== undefined) {
        if (existingSession.creationRequestHash !== creationRequestHash) {
          throw conflict("session_idempotency_conflict");
        }
        return {
          result: clone(existingSession),
          payload: json({ sessionId: existingSession.id, idempotent: true }),
          persist: false,
        };
      }
      const participantSessions = next.sessions.filter(
        (session) => session.participantId === options.participantId,
      );
      if (
        next.sessions.length >= this.limits.maxSessionsPerPremiere ||
        participantSessions.length >= this.limits.maxSessionsPerParticipant
      ) {
        throw rateLimited("session_record_limit_exceeded");
      }
      const rollingStart = Date.parse(occurredAt) - 60_000;
      if (
        participantSessions.filter(
          (session) => Date.parse(session.startedAt) > rollingStart,
        ).length >= this.limits.maxSessionCreatesPerParticipantPerMinute
      ) {
        throw rateLimited("session_rate_limit_exceeded");
      }
      const existingAttributionTouch =
        next.lastNonDirectAttributionByParticipant.find(
          (entry) => entry.participantId === options.participantId,
        );
      if (incomingAttribution !== null) {
        const attributedShare = next.shares.find(
          (share) => share.id === incomingAttribution.shareId,
        );
        if (
          attributedShare === undefined ||
          attributedShare.createdByParticipantId !==
            incomingAttribution.attributionId ||
          Date.parse(incomingAttribution.expiresAt) <= Date.parse(occurredAt)
        ) {
          throw invalidInteraction("attribution_share_mismatch");
        }
      }
      assertPremiereRecordCapacity(
        next,
        this.limits,
        1 +
          (incomingAttribution !== null &&
          existingAttributionTouch === undefined
            ? 1
            : 0),
      );
      if (incomingAttribution !== null) {
        const replacement = {
          participantId: options.participantId,
          attribution: clone(incomingAttribution),
          touchedAt: occurredAt,
        };
        if (existingAttributionTouch === undefined) {
          next.lastNonDirectAttributionByParticipant.push(replacement);
        } else {
          Object.assign(existingAttributionTouch, replacement);
        }
      }
      const lastTouch = next.lastNonDirectAttributionByParticipant.find(
        (entry) => entry.participantId === options.participantId,
      );
      const attribution =
        lastTouch !== undefined &&
        Date.parse(lastTouch.attribution.expiresAt) > Date.parse(occurredAt)
          ? clone(lastTouch.attribution)
          : null;
      const session: ReplayPremiereViewerSession = {
        id: `sess_${this.randomHex(16)}`,
        premiereId: this.premiereId,
        participantId: options.participantId,
        startedAt: occurredAt,
        lastHeartbeatAt: occurredAt,
        endedAt: null,
        connectedDurationMs: 0,
        visibleDurationMs: 0,
        currentlyVisible: options.visible,
        firstReleasedSequenceObserved: options.observedSequence,
        lastReleasedSequenceObserved: options.observedSequence,
        predictionCount: 0,
        reactionCount: 0,
        shareCount: 0,
        incomingAttribution: attribution,
        excludedAsOperator: options.excludedAsOperator,
        excludedAsBot: options.excludedAsBot,
        qualifiedAt: null,
        idempotencyKey: options.idempotencyKey,
        creationRequestHash,
        heartbeatReceipts: [],
      };
      next.sessions.push(session);
      return {
        result: clone(session),
        payload: json({ session }),
        persistenceIdempotencyKey: `interaction:session:${options.participantId}:${options.idempotencyKey}`,
      };
    });
  }

  async heartbeat(options: {
    participantId: string;
    sessionId: string;
    idempotencyKey: string;
    requesterBucketId: string;
    visible: boolean;
    observedSequence: number;
  }): Promise<{
    session: ReplayPremiereViewerSession;
    idempotent: boolean;
    persisted: boolean;
  }> {
    this.assertWritesOpen();
    const occurredAt = this.nowChecked().toISOString();
    assertParticipantId(options.participantId);
    assertSessionId(options.sessionId);
    assertIdempotencyKey(options.idempotencyKey);
    assertRequesterBucketId(options.requesterBucketId);
    this.assertAuthoritativeObservedSequence(options.observedSequence);
    this.admitAnonymousWrite({
      route: "heartbeat",
      premiereId: this.premiereId,
      participantId: options.participantId,
      sessionId: options.sessionId,
      requesterBucketId: options.requesterBucketId,
      idempotencyKey: options.idempotencyKey,
      occurredAt,
      currentPremiereRecordCount: premiereRecordCount(this.state),
    });
    const currentSession = ownedSession(
      this.state,
      options.sessionId,
      options.participantId,
    );
    if (currentSession.endedAt !== null) throw gone("viewer_session_ended");
    const requestHash = hashReplayPremiereJson(
      json({
        participantId: options.participantId,
        sessionId: options.sessionId,
        visible: options.visible,
        observedSequence: options.observedSequence,
      }),
    );
    const currentReceipt = currentSession.heartbeatReceipts.find(
      (candidate) => candidate.idempotencyKey === options.idempotencyKey,
    );
    if (currentReceipt !== undefined) {
      if (currentReceipt.requestHash !== requestHash) {
        throw conflict("heartbeat_idempotency_conflict");
      }
      return {
        session: clone(currentSession),
        idempotent: true,
        persisted: false,
      };
    }
    const currentRawGap =
      Date.parse(occurredAt) - Date.parse(currentSession.lastHeartbeatAt);
    if (currentRawGap < 0) throw invalidInteraction("non_monotonic_heartbeat");
    if (currentRawGap < this.minHeartbeatIntervalMs) {
      return {
        session: clone(currentSession),
        idempotent: false,
        persisted: false,
      };
    }
    const currentRollingStart = Date.parse(occurredAt) - 60_000;
    if (
      currentSession.heartbeatReceipts.filter(
        (candidate) => Date.parse(candidate.acceptedAt) > currentRollingStart,
      ).length >= this.limits.maxHeartbeatWritesPerSessionPerMinute
    ) {
      throw rateLimited("heartbeat_rate_limit_exceeded");
    }
    return this.mutate<{
      session: ReplayPremiereViewerSession;
      idempotent: boolean;
      persisted: boolean;
    }>("viewer_session_heartbeat", occurredAt, (next) => {
      assertIdempotencyKey(options.idempotencyKey);
      assertRequesterBucketId(options.requesterBucketId);
      this.assertAuthoritativeObservedSequence(options.observedSequence);
      const session = ownedSession(
        next,
        options.sessionId,
        options.participantId,
      );
      if (session.endedAt !== null) throw gone("viewer_session_ended");
      const receipt = session.heartbeatReceipts.find(
        (candidate) => candidate.idempotencyKey === options.idempotencyKey,
      );
      if (receipt !== undefined) {
        if (receipt.requestHash !== requestHash) {
          throw conflict("heartbeat_idempotency_conflict");
        }
        return {
          result: {
            session: clone(session),
            idempotent: true,
            persisted: false,
          },
          payload: json({ sessionId: session.id, idempotent: true }),
          persist: false,
        };
      }
      const rawGap =
        Date.parse(occurredAt) - Date.parse(session.lastHeartbeatAt);
      if (rawGap < 0) throw invalidInteraction("non_monotonic_heartbeat");
      if (rawGap < this.minHeartbeatIntervalMs) {
        return {
          result: {
            session: clone(session),
            idempotent: false,
            persisted: false,
          },
          payload: json({
            sessionId: session.id,
            suppressed: "minimum_interval",
          }),
          persist: false,
        };
      }
      const rollingStart = Date.parse(occurredAt) - 60_000;
      const heartbeatWritesInWindow = session.heartbeatReceipts.filter(
        (candidate) => Date.parse(candidate.acceptedAt) > rollingStart,
      ).length;
      if (
        heartbeatWritesInWindow >=
        this.limits.maxHeartbeatWritesPerSessionPerMinute
      ) {
        throw rateLimited("heartbeat_rate_limit_exceeded");
      }
      const creditedGap = Math.min(rawGap, this.maxHeartbeatGapMs);
      session.connectedDurationMs += creditedGap;
      if (session.currentlyVisible) session.visibleDurationMs += creditedGap;
      session.currentlyVisible = options.visible;
      session.lastHeartbeatAt = occurredAt;
      session.lastReleasedSequenceObserved = Math.max(
        session.lastReleasedSequenceObserved,
        options.observedSequence,
      );
      session.heartbeatReceipts.push({
        idempotencyKey: options.idempotencyKey,
        requestHash,
        acceptedAt: occurredAt,
      });
      if (session.heartbeatReceipts.length > HEARTBEAT_RECEIPT_LIMIT) {
        session.heartbeatReceipts.splice(
          0,
          session.heartbeatReceipts.length - HEARTBEAT_RECEIPT_LIMIT,
        );
      }
      qualifySession(session, occurredAt);
      return {
        result: {
          session: clone(session),
          idempotent: false,
          persisted: true,
        },
        payload: json({
          sessionId: session.id,
          connectedDurationMs: session.connectedDurationMs,
          visibleDurationMs: session.visibleDurationMs,
          lastReleasedSequenceObserved: session.lastReleasedSequenceObserved,
          qualifiedAt: session.qualifiedAt,
        }),
        persistenceIdempotencyKey: `interaction:heartbeat:${session.id}:${options.idempotencyKey}`,
      };
    });
  }

  readMetrics(): ReplayPremiereInteractionMetrics {
    const qualifiedByParticipant = bestQualifiedSessions(this.state.sessions);
    let interacting = 0;
    let markerToShare = 0;
    let attributed = 0;
    for (const session of qualifiedByParticipant.values()) {
      if (
        session.predictionCount + session.reactionCount + session.shareCount >
        0
      ) {
        interacting += 1;
      }
      if (session.reactionCount > 0 && session.shareCount > 0)
        markerToShare += 1;
      if (session.incomingAttribution !== null) attributed += 1;
    }
    return {
      qualifiedParticipants: qualifiedByParticipant.size,
      interactingQualifiedParticipants: interacting,
      markerToShareParticipants: markerToShare,
      attributedQualifiedParticipants: attributed,
    };
  }

  private async mutate<T>(
    eventType: string,
    occurredAt: string,
    operation: (next: ReplayPremiereInteractionsSnapshot) => {
      result: T;
      payload: ReplayPremiereJsonValue;
      persist?: boolean;
      persistenceIdempotencyKey?: string;
      appendedReaction?: ReplayPremiereValidatedReactionAppend;
    },
  ): Promise<T> {
    this.assertWritesOpen();
    this.assertReactionIndexSynchronized();
    this.pendingMutations += 1;
    const run = async (): Promise<T> => {
      if (this.preparedTransitionToken !== null) {
        throw conflict("checkpoint_transition_in_flight");
      }
      this.assertReactionIndexSynchronized();
      const next = cloneSnapshotPreservingReactionEvidence(this.state);
      const mutation = operation(next);
      const appendedReaction = mutation.appendedReaction ?? null;
      if (mutation.persist === false) {
        if (
          appendedReaction !== null ||
          next.reactions !== this.state.reactions
        ) {
          throw invalidInteraction("non_persisted_reaction_state_changed");
        }
        return mutation.result;
      }
      if (appendedReaction === null) {
        if (next.reactions !== this.state.reactions) {
          throw invalidInteraction("reaction_evidence_not_append_only");
        }
      } else {
        if (
          eventType !== "reaction_submitted" ||
          next.reactions !== this.state.reactions
        ) {
          throw invalidInteraction("reaction_evidence_not_append_only");
        }
        next.reactions = [...this.state.reactions, appendedReaction.reaction];
      }
      validateSnapshot(next, this.snapshotValidationOptions, {
        index: this.reactionIndex,
        appended: appendedReaction,
      });
      freezeReactionEvidence(next.reactions);
      await this.persistence.persist({
        eventType,
        occurredAt,
        eventPayload: mutation.payload,
        nextState: next,
        idempotencyKey: mutation.persistenceIdempotencyKey,
      });
      if (appendedReaction !== null) {
        appendValidatedReactionToIndex(
          this.reactionIndex,
          appendedReaction.reaction,
        );
      }
      this.state = next;
      this.stateEpoch += 1;
      return mutation.result;
    };
    const result = this.mutationQueue.then(run, run);
    const tracked = result.finally(() => {
      this.pendingMutations -= 1;
    });
    this.mutationQueue = tracked.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  }

  private prepareCheckpointTransition<T>(
    operation: (next: ReplayPremiereInteractionsSnapshot) => T,
  ): ReplayPremierePreparedInteractionTransition<T> {
    this.assertWritesOpen();
    this.assertReactionIndexSynchronized();
    if (this.preparedTransitionToken !== null || this.pendingMutations !== 0) {
      throw conflict("interaction_transition_already_in_flight");
    }
    const baseEpoch = this.stateEpoch;
    const baseStateHash = hashReplayPremiereJson(json(this.state));
    const next = cloneSnapshotPreservingReactionEvidence(this.state);
    const result = operation(next);
    if (next.reactions !== this.state.reactions) {
      throw invalidInteraction("reaction_evidence_not_append_only");
    }
    validateSnapshot(next, this.snapshotValidationOptions, {
      index: this.reactionIndex,
      appended: null,
    });
    const committedState = cloneSnapshotPreservingReactionEvidence(next);
    const token = Object.freeze({});
    this.preparedTransitionToken = token;
    let finished = false;
    const assertActive = (): void => {
      if (
        finished ||
        this.preparedTransitionToken !== token ||
        this.stateEpoch !== baseEpoch
      ) {
        throw conflict("stale_interaction_transition");
      }
    };
    return {
      nextState: clone(committedState),
      baseStateHash,
      nextStateHash: hashReplayPremiereJson(json(committedState)),
      checkpointStateHash: hashReplayPremiereJson(
        json(committedState.checkpoints),
      ),
      result: clone(result),
      commit: () => {
        assertActive();
        this.state = committedState;
        this.stateEpoch += 1;
        this.preparedTransitionToken = null;
        finished = true;
      },
      abort: () => {
        assertActive();
        this.preparedTransitionToken = null;
        finished = true;
      },
    };
  }

  private assertReactionIndexSynchronized(): void {
    const reactions = this.state.reactions;
    if (
      reactions.length !== this.reactionIndex.totalReactions ||
      (reactions.length === 0
        ? this.reactionIndex.lastReactionId !== null
        : reactions[reactions.length - 1].id !==
          this.reactionIndex.lastReactionId)
    ) {
      throw invalidInteraction("reaction_index_state_mismatch");
    }
  }

  private assertWritesOpen(): void {
    if (this.writesFenced) throw gone("interaction_writes_fenced");
  }

  private randomHex(size: number): string {
    const bytes = this.randomBytes(size);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
      throw invalidInteraction("invalid_random_source");
    }
    return Buffer.from(bytes).toString("hex");
  }

  private assertAuthoritativeObservedSequence(sequence: number): void {
    assertObservedSequence(sequence);
    if (sequence === -1) return;
    // `getReleasedContext`'s `lastSafeReleasedSequence` is a coarse,
    // chunk-release-action counter — correct for `contentSource: "chunks"`
    // clients, whose own observed sequence advances at the same coarse
    // granularity. A `contentSource: "tap"` client (the betting page)
    // legitimately reports a fine-grained per-turn sequence instead
    // (`latestFrame.sequence`, the same numbering `readLiveVisibleSequence()`
    // exposes and market orders already trust as their own authoritative
    // freshness bound — see `submitMarketOrder`'s `getLiveVisibleSequence()`
    // check above). Accept either bound: this only WIDENS what a coarse
    // claim can satisfy, it never lets a claim through that exceeds both
    // the chunk-release counter AND the server's own live-visible frontier.
    if (sequence <= this.getLiveVisibleSequence()) return;
    const context = this.getReleasedContext(sequence);
    if (context === null || sequence > context.releasedThroughSequence) {
      throw invalidInteraction("observed_sequence_unreleased");
    }
  }

  private nowChecked(): Date {
    const now = this.now();
    if (!Number.isFinite(now.getTime()))
      throw invalidInteraction("invalid_clock");
    return now;
  }
}

function emptyReactionCounts(): Record<ReplayPremiereReactionKind, number> {
  return {
    turning_point: 0,
    smart: 0,
    mistake: 0,
    betrayal: 0,
    clip_this: 0,
  };
}

function cloneReactionCounts(
  counts: Readonly<Record<ReplayPremiereReactionKind, number>>,
): Record<ReplayPremiereReactionKind, number> {
  return {
    turning_point: counts.turning_point,
    smart: counts.smart,
    mistake: counts.mistake,
    betrayal: counts.betrayal,
    clip_this: counts.clip_this,
  };
}

function createReactionIndex(): ReplayPremiereReactionIndex {
  return {
    totalReactions: 0,
    byKind: emptyReactionCounts(),
    byParticipantKind: new Map(),
    byParticipantTotal: new Map(),
    latestByParticipant: new Map(),
    ids: new Set(),
    dedupeKeys: new Set(),
    createdAtMsByParticipant: new Map(),
    lastReactionId: null,
  };
}

function appendValidatedReactionToIndex(
  index: ReplayPremiereReactionIndex,
  reaction: ReplayPremiereReaction,
): void {
  const participantCounts =
    index.byParticipantKind.get(reaction.participantId) ??
    emptyReactionCounts();
  participantCounts[reaction.kind] += 1;
  index.byParticipantKind.set(reaction.participantId, participantCounts);
  index.byParticipantTotal.set(
    reaction.participantId,
    (index.byParticipantTotal.get(reaction.participantId) ?? 0) + 1,
  );
  index.latestByParticipant.set(reaction.participantId, {
    id: reaction.id,
    kind: reaction.kind,
    sequence: reaction.sequence,
    turn: reaction.turn,
  });
  const createdAtMs = index.createdAtMsByParticipant.get(
    reaction.participantId,
  );
  if (createdAtMs === undefined) {
    index.createdAtMsByParticipant.set(reaction.participantId, [
      Date.parse(reaction.createdAt),
    ]);
  } else {
    createdAtMs.push(Date.parse(reaction.createdAt));
  }
  index.totalReactions += 1;
  index.byKind[reaction.kind] += 1;
  index.ids.add(reaction.id);
  index.dedupeKeys.add(reactionDedupeKey(reaction));
  index.lastReactionId = reaction.id;
}

function reactionDedupeKey(reaction: ReplayPremiereReaction): string {
  return `${reaction.participantId}\u0000${reaction.sequence}\u0000${reaction.kind}`;
}

function cloneSnapshotPreservingReactionEvidence(
  snapshot: ReplayPremiereInteractionsSnapshot,
): ReplayPremiereInteractionsSnapshot {
  const reactionEvidence = snapshot.reactions;
  const withoutReactionEvidence: ReplayPremiereInteractionsSnapshot = {
    ...snapshot,
    reactions: [],
  };
  const cloned = clone(withoutReactionEvidence);
  cloned.reactions = reactionEvidence;
  return cloned;
}

function freezeReactionEvidence(reactions: ReplayPremiereReaction[]): void {
  for (const reaction of reactions) deepFreeze(reaction);
  Object.freeze(reactions);
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

function createInitialSnapshot(
  options: ReplayPremiereInteractionSnapshotValidationOptions,
): ReplayPremiereInteractionsSnapshot {
  const [first, second] = options.checkpointDescriptors;
  if (
    first.sequence < 0 ||
    !Number.isSafeInteger(first.sequence) ||
    !Number.isSafeInteger(second.sequence) ||
    second.sequence <= first.sequence ||
    first.id === second.id
  ) {
    throw invalidInteraction("invalid_checkpoint_descriptors");
  }
  assertCheckpointId(first.id);
  assertCheckpointId(second.id);
  return {
    schemaVersion: 1,
    premiereId: options.premiereId,
    checkpoints: [first, second].map((checkpoint) => ({
      id: checkpoint.id,
      sequence: checkpoint.sequence,
      opensAt: null,
      closesAt: null,
      outageShiftMs: 0,
      optionSeatIds: [],
      state: "upcoming",
      resolution: null,
    })),
    predictions: [],
    market: options.wageringEnabled
      ? {
          premiereId: options.premiereId,
          outcomeSeatIds: options.seats.map((seat) => seat.seatId),
          b: liquidityForOutcomeCount(options.seats.length),
          q: options.seats.map(() => 0),
          status: "open",
          winnerSeatId: null,
          holdings: {},
          costBasis: {},
          ledgerBalances: {},
          ledgerGranted: {},
        }
      : null,
    trades: [],
    reactions: [],
    shares: [],
    sessions: [],
    lastNonDirectAttributionByParticipant: [],
  };
}

function validateSnapshot(
  snapshot: ReplayPremiereInteractionsSnapshot,
  options: ReplayPremiereInteractionSnapshotValidationOptions,
  appendOnlyReactions?: ReplayPremiereAppendOnlyReactionValidation,
  reactionIndexCapture?: ReplayPremiereReactionIndexCapture,
): ReplayPremiereInteractionsSnapshot {
  const limits = resolveInteractionLimits(options.limits);
  if (!isRecord(snapshot)) {
    throw invalidInteraction("interaction_snapshot_not_object");
  }
  assertExactKeys(snapshot, [
    "schemaVersion",
    "premiereId",
    "checkpoints",
    "predictions",
    "market",
    "trades",
    "reactions",
    "shares",
    "sessions",
    "lastNonDirectAttributionByParticipant",
  ]);
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.premiereId !== options.premiereId ||
    !Array.isArray(snapshot.checkpoints) ||
    snapshot.checkpoints.length !== 2 ||
    !Array.isArray(snapshot.predictions) ||
    !Array.isArray(snapshot.trades) ||
    !Array.isArray(snapshot.reactions) ||
    !Array.isArray(snapshot.shares) ||
    !Array.isArray(snapshot.sessions) ||
    !Array.isArray(snapshot.lastNonDirectAttributionByParticipant) ||
    snapshot.checkpoints.some(
      (checkpoint, index) =>
        !isRecord(checkpoint) ||
        checkpoint.id !== options.checkpointDescriptors[index].id ||
        checkpoint.sequence !== options.checkpointDescriptors[index].sequence,
    ) ||
    snapshot.shares.length > limits.maxSharesPerPremiere ||
    snapshot.sessions.length > limits.maxSessionsPerPremiere ||
    premiereRecordCount(snapshot) > limits.maxTotalRecords
  ) {
    throw invalidInteraction("invalid_interaction_snapshot_identity");
  }
  json(snapshot);

  const seatIdentityById = new Map(
    options.seats.map((seat) => [
      seat.seatId,
      identityKey(seat.policyIdentity),
    ]),
  );
  validateSnapshotCheckpoints(snapshot, options, seatIdentityById);
  validateSnapshotPredictions(snapshot);
  validateSnapshotMarket(snapshot, options);
  validateSnapshotTrades(snapshot);
  let validatedReactionIndex: ReplayPremiereReactionIndex | null = null;
  if (appendOnlyReactions === undefined) {
    validatedReactionIndex = validateSnapshotReactions(
      snapshot,
      options.getReleasedContext,
      seatIdentityById,
    );
  } else {
    validateAppendOnlySnapshotReactions(
      snapshot,
      seatIdentityById,
      appendOnlyReactions,
    );
  }
  validateSnapshotShares(snapshot, options);
  validateSnapshotSessions(snapshot, options);
  validateSnapshotAttributions(snapshot);
  validateSnapshotSessionActionTotals(snapshot, appendOnlyReactions);
  validateSnapshotInteractionLimits(snapshot, limits);
  if (reactionIndexCapture !== undefined) {
    if (validatedReactionIndex === null) {
      throw invalidInteraction(
        "reaction_index_capture_without_full_validation",
      );
    }
    reactionIndexCapture.value = validatedReactionIndex;
  }
  return snapshot;
}

function validateSnapshotAndCreateReactionIndex(
  snapshot: ReplayPremiereInteractionsSnapshot,
  options: ReplayPremiereInteractionSnapshotValidationOptions,
): {
  snapshot: ReplayPremiereInteractionsSnapshot;
  reactionIndex: ReplayPremiereReactionIndex;
} {
  const capture: ReplayPremiereReactionIndexCapture = { value: null };
  const validated = validateSnapshot(snapshot, options, undefined, capture);
  if (capture.value === null) {
    throw invalidInteraction("reaction_index_initialization_failed");
  }
  return { snapshot: validated, reactionIndex: capture.value };
}

function validateSnapshotCheckpoints(
  snapshot: ReplayPremiereInteractionsSnapshot,
  options: ReplayPremiereInteractionSnapshotValidationOptions,
  seatIdentityById: ReadonlyMap<string, string>,
): void {
  let openCount = 0;
  for (const [index, checkpoint] of snapshot.checkpoints.entries()) {
    assertExactKeys(checkpoint, [
      "id",
      "sequence",
      "opensAt",
      "closesAt",
      "outageShiftMs",
      "optionSeatIds",
      "state",
      "resolution",
    ]);
    assertCheckpointId(checkpoint.id);
    assertSequence(checkpoint.sequence);
    if (
      checkpoint.id !== options.checkpointDescriptors[index].id ||
      checkpoint.sequence !== options.checkpointDescriptors[index].sequence ||
      !Array.isArray(checkpoint.optionSeatIds) ||
      !Number.isSafeInteger(checkpoint.outageShiftMs) ||
      checkpoint.outageShiftMs < 0 ||
      checkpoint.outageShiftMs > 60_000 ||
      !["upcoming", "open", "closed"].includes(checkpoint.state)
    ) {
      throw invalidInteraction("invalid_snapshot_checkpoint");
    }
    if (checkpoint.state === "upcoming") {
      if (
        checkpoint.opensAt !== null ||
        checkpoint.closesAt !== null ||
        checkpoint.outageShiftMs !== 0 ||
        checkpoint.optionSeatIds.length !== 0 ||
        checkpoint.resolution !== null
      ) {
        throw invalidInteraction("invalid_upcoming_checkpoint_state");
      }
      continue;
    }
    if (checkpoint.state === "open") openCount += 1;
    if (
      typeof checkpoint.opensAt !== "string" ||
      typeof checkpoint.closesAt !== "string"
    ) {
      throw invalidInteraction("checkpoint_timestamps_missing");
    }
    const duration =
      timestamp(checkpoint.closesAt, "snapshot_checkpoint_closes_at") -
      timestamp(checkpoint.opensAt, "snapshot_checkpoint_opens_at");
    if (
      // Durable snapshots recorded before the real-speed retune carry 15 s
      // windows; both canonical durations stay valid so archived journals
      // keep validating. Wagering premieres never open a real window —
      // `prepareMarkCheckpointPassed` records a zero-duration "passed"
      // marker instead, honestly reflecting that no pause ever happened.
      (duration !==
        REPLAY_PREMIERE_CHECKPOINT_PAUSE_MS + checkpoint.outageShiftMs &&
        duration !==
          REPLAY_PREMIERE_LEGACY_CHECKPOINT_PAUSE_MS +
            checkpoint.outageShiftMs &&
        !(options.wageringEnabled && duration === 0)) ||
      checkpoint.optionSeatIds.length < 2 ||
      checkpoint.optionSeatIds.length > 64 ||
      new Set(checkpoint.optionSeatIds).size !== checkpoint.optionSeatIds.length
    ) {
      throw invalidInteraction("invalid_snapshot_checkpoint_window");
    }
    for (const seatId of checkpoint.optionSeatIds) {
      assertSeatId(seatId);
      if (!seatIdentityById.has(seatId)) {
        throw invalidInteraction("snapshot_checkpoint_unknown_seat");
      }
    }
    validatePredictionResolution(checkpoint, options, seatIdentityById);
  }
  if (openCount > 1) throw invalidInteraction("multiple_open_checkpoints");
  const [first, second] = snapshot.checkpoints;
  if (
    (second.state === "open" && first.state !== "closed") ||
    (second.state === "closed" && first.state !== "closed")
  ) {
    throw invalidInteraction("checkpoint_progression_invalid");
  }
  const resolutions = snapshot.checkpoints.map(
    (checkpoint) => checkpoint.resolution,
  );
  if (
    resolutions.some((resolution) => resolution !== null) &&
    (!resolutions.every((resolution) => resolution !== null) ||
      !sameStoredPredictionResolution(
        resolutions[0] as ReplayPremierePredictionResolution,
        resolutions[1] as ReplayPremierePredictionResolution,
      ))
  ) {
    throw invalidInteraction("checkpoint_resolution_inconsistent");
  }
}

function validatePredictionResolution(
  checkpoint: ReplayPremiereInteractionCheckpoint,
  options: ReplayPremiereInteractionSnapshotValidationOptions,
  seatIdentityById: ReadonlyMap<string, string>,
): void {
  const resolution = checkpoint.resolution;
  if (resolution === null) return;
  if (
    checkpoint.state !== "closed" ||
    checkpoint.closesAt === null ||
    (options.getPremiereState() !== "revealed" &&
      options.getPremiereState() !== "archived") ||
    !isRecord(resolution)
  ) {
    throw invalidInteraction("invalid_checkpoint_resolution_state");
  }
  if (resolution.kind === "winner") {
    assertExactKeys(resolution, ["kind", "winnerSeatId", "resolvedAt"]);
    assertSeatId(resolution.winnerSeatId);
    if (
      !seatIdentityById.has(resolution.winnerSeatId) ||
      !checkpoint.optionSeatIds.includes(resolution.winnerSeatId)
    ) {
      throw invalidInteraction("invalid_checkpoint_winner_resolution");
    }
  } else if (resolution.kind === "void") {
    assertExactKeys(resolution, ["kind", "reason", "resolvedAt"]);
    if (
      !["no_winner", "ambiguous_winner", "invalid_result"].includes(
        resolution.reason,
      )
    ) {
      throw invalidInteraction("invalid_checkpoint_void_resolution");
    }
  } else {
    throw invalidInteraction("invalid_checkpoint_resolution_kind");
  }
  if (
    timestamp(resolution.resolvedAt, "snapshot_prediction_resolved_at") <
    Date.parse(checkpoint.closesAt)
  ) {
    throw invalidInteraction("checkpoint_resolution_before_close");
  }
}

function sameStoredPredictionResolution(
  left: ReplayPremierePredictionResolution,
  right: ReplayPremierePredictionResolution,
): boolean {
  return (
    left.resolvedAt === right.resolvedAt && samePredictionOutcome(right, left)
  );
}

function validateSnapshotPredictions(
  snapshot: ReplayPremiereInteractionsSnapshot,
): void {
  const keys = new Set<string>();
  for (const prediction of snapshot.predictions) {
    if (!isRecord(prediction))
      throw invalidInteraction("prediction_not_object");
    assertExactKeys(prediction, [
      "premiereId",
      "checkpointId",
      "participantId",
      "selectedSeatId",
      "submittedAt",
      "lockedAt",
    ]);
    assertParticipantId(prediction.participantId);
    assertCheckpointId(prediction.checkpointId);
    assertSeatId(prediction.selectedSeatId);
    const checkpoint = snapshot.checkpoints.find(
      (candidate) => candidate.id === prediction.checkpointId,
    );
    const submittedAt = timestamp(
      prediction.submittedAt,
      "snapshot_prediction_submitted_at",
    );
    if (
      prediction.premiereId !== snapshot.premiereId ||
      prediction.lockedAt !== prediction.submittedAt ||
      checkpoint === undefined ||
      checkpoint.state === "upcoming" ||
      checkpoint.opensAt === null ||
      checkpoint.closesAt === null ||
      submittedAt < Date.parse(checkpoint.opensAt) ||
      submittedAt >= Date.parse(checkpoint.closesAt) ||
      !checkpoint.optionSeatIds.includes(prediction.selectedSeatId)
    ) {
      throw invalidInteraction("invalid_snapshot_prediction");
    }
    const key = `${prediction.checkpointId}\u0000${prediction.participantId}`;
    if (keys.has(key))
      throw invalidInteraction("duplicate_snapshot_prediction");
    keys.add(key);
  }
}

function validateSnapshotMarket(
  snapshot: ReplayPremiereInteractionsSnapshot,
  options: ReplayPremiereInteractionSnapshotValidationOptions,
): void {
  const market = snapshot.market;
  if (!options.wageringEnabled) {
    if (market !== null) throw invalidInteraction("market_present_while_disabled");
    return;
  }
  if (market === null) throw invalidInteraction("market_missing_while_enabled");
  if (!isRecord(market)) throw invalidInteraction("market_not_object");
  assertExactKeys(market, [
    "premiereId",
    "outcomeSeatIds",
    "b",
    "q",
    "status",
    "winnerSeatId",
    "holdings",
    "costBasis",
    "ledgerBalances",
    "ledgerGranted",
  ]);
  const expectedSeatIds = options.seats.map((seat) => seat.seatId);
  if (
    market.premiereId !== snapshot.premiereId ||
    !Array.isArray(market.outcomeSeatIds) ||
    market.outcomeSeatIds.length !== expectedSeatIds.length ||
    market.outcomeSeatIds.some((seatId, index) => seatId !== expectedSeatIds[index]) ||
    market.b !== liquidityForOutcomeCount(expectedSeatIds.length) ||
    !Array.isArray(market.q) ||
    market.q.length !== expectedSeatIds.length ||
    market.q.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    (market.status !== "open" && market.status !== "settled") ||
    (market.winnerSeatId !== null && !expectedSeatIds.includes(market.winnerSeatId)) ||
    (market.status === "open" && market.winnerSeatId !== null)
  ) {
    throw invalidInteraction("invalid_snapshot_market");
  }
  const totals = expectedSeatIds.map(() => 0);
  for (const [participantId, holdings] of Object.entries(market.holdings)) {
    assertParticipantId(participantId);
    if (
      !Array.isArray(holdings) ||
      holdings.length !== expectedSeatIds.length ||
      holdings.some((value) => !Number.isSafeInteger(value) || value < 0)
    ) {
      throw invalidInteraction("invalid_snapshot_market_holdings");
    }
    holdings.forEach((value, index) => {
      totals[index] += value;
    });
    const basis = market.costBasis[participantId];
    if (
      !Array.isArray(basis) ||
      basis.length !== expectedSeatIds.length ||
      basis.some((value) => !Number.isSafeInteger(value) || value < 0)
    ) {
      throw invalidInteraction("invalid_snapshot_market_cost_basis");
    }
  }
  if (totals.some((value, index) => value !== market.q[index])) {
    throw invalidInteraction("market_holdings_q_mismatch");
  }
  for (const balance of Object.values(market.ledgerBalances)) {
    if (!Number.isSafeInteger(balance)) {
      throw invalidInteraction("invalid_snapshot_ledger_balance");
    }
  }
  if (Object.values(market.ledgerBalances).reduce((a, b) => a + b, 0) !== 0) {
    throw invalidInteraction("ledger_does_not_balance");
  }
  for (const granted of Object.values(market.ledgerGranted)) {
    if (!Number.isSafeInteger(granted) || granted < 0) {
      throw invalidInteraction("invalid_snapshot_ledger_granted");
    }
  }
}

function validateSnapshotTrades(snapshot: ReplayPremiereInteractionsSnapshot): void {
  const ids = new Set<string>();
  const dedupe = new Set<string>();
  for (const trade of snapshot.trades) {
    if (!isRecord(trade)) throw invalidInteraction("trade_not_object");
    assertExactKeys(trade, [
      "id",
      "premiereId",
      "participantId",
      "participantKind",
      "seatId",
      "side",
      "shares",
      "chips",
      "avgPrice",
      "executedAt",
      "sequence",
      "idempotencyKey",
    ]);
    assertTradeId(trade.id);
    assertParticipantId(trade.participantId);
    assertSeatId(trade.seatId);
    assertIdempotencyKey(trade.idempotencyKey);
    if (trade.participantKind !== "real" && trade.participantKind !== "synthetic") {
      throw invalidInteraction("invalid_trade_participant_kind");
    }
    if (trade.side !== "buy" && trade.side !== "sell") {
      throw invalidInteraction("invalid_trade_side");
    }
    if (!Number.isSafeInteger(trade.shares) || trade.shares <= 0) {
      throw invalidInteraction("invalid_trade_shares");
    }
    if (!Number.isSafeInteger(trade.chips) || trade.chips < 0) {
      throw invalidInteraction("invalid_trade_chips");
    }
    if (
      typeof trade.avgPrice !== "number" ||
      !Number.isFinite(trade.avgPrice) ||
      trade.avgPrice < 0
    ) {
      throw invalidInteraction("invalid_trade_avg_price");
    }
    timestamp(trade.executedAt, "snapshot_trade_executed_at");
    // Structural only (safe non-negative integer): a strict upper-bound
    // check against the live clock is deliberately NOT re-applied here.
    // Unlike reactions/shares (whose `turn`/`eventContext` must be
    // re-derived from frozen drafts for content integrity), a trade's
    // `sequence` is purely an audit/staleness marker already enforced once,
    // authoritatively, at accept time in `submitMarketOrder` — re-checking
    // it against a *recovery-time* clock would be unsound: the coarse
    // `getReleasedContext` fallback available pre-runtime can lag behind
    // where the fine-grained live clock legitimately was at accept time.
    if (!Number.isSafeInteger(trade.sequence) || trade.sequence < 0) {
      throw invalidInteraction("invalid_trade_sequence");
    }
    if (trade.premiereId !== snapshot.premiereId) {
      throw invalidInteraction("invalid_snapshot_trade");
    }
    if (ids.has(trade.id)) throw invalidInteraction("duplicate_trade_id");
    ids.add(trade.id);
    const key = `${trade.participantId}\u0000${trade.idempotencyKey}`;
    if (dedupe.has(key)) throw invalidInteraction("duplicate_snapshot_trade");
    dedupe.add(key);
  }
}

function validateSnapshotReactions(
  snapshot: ReplayPremiereInteractionsSnapshot,
  getReleasedContext: ReplayPremiereInteractionSnapshotValidationOptions["getReleasedContext"],
  seatIdentityById: ReadonlyMap<string, string>,
): ReplayPremiereReactionIndex {
  const index = createReactionIndex();
  const ids = new Set<string>();
  const dedupe = new Set<string>();
  const byParticipant = new Map<string, ReplayPremiereReaction[]>();
  const validIdentityKeys = new Set(seatIdentityById.values());
  for (const reaction of snapshot.reactions) {
    if (!isRecord(reaction)) throw invalidInteraction("reaction_not_object");
    assertExactKeys(reaction, [
      "id",
      "premiereId",
      "participantId",
      "sequence",
      "turn",
      "kind",
      "policyIdentity",
      "eventContext",
      "createdAt",
    ]);
    assertReactionId(reaction.id);
    assertParticipantId(reaction.participantId);
    assertSequence(reaction.sequence);
    assertSequence(reaction.turn);
    if (!isReactionKind(reaction.kind)) {
      throw invalidInteraction("invalid_snapshot_reaction_kind");
    }
    timestamp(reaction.createdAt, "snapshot_reaction_created_at");
    const context = getReleasedContext(reaction.sequence);
    if (
      reaction.premiereId !== snapshot.premiereId ||
      context === null ||
      reaction.sequence > context.releasedThroughSequence ||
      reaction.turn !== context.turn ||
      identityKeyOrNull(reaction.eventContext) !==
        identityKeyOrNull(context.eventContext)
    ) {
      throw invalidInteraction("invalid_snapshot_reaction_context");
    }
    if (
      reaction.policyIdentity !== null &&
      !validIdentityKeys.has(identityKey(reaction.policyIdentity))
    ) {
      throw invalidInteraction("invalid_snapshot_reaction_policy");
    }
    if (reaction.eventContext !== null) {
      const contextJson = json(reaction.eventContext);
      if (
        Buffer.byteLength(canonicalReplayPremiereJson(contextJson), "utf8") >
        MAX_EVENT_CONTEXT_BYTES
      ) {
        throw invalidInteraction("snapshot_event_context_too_large");
      }
    }
    if (ids.has(reaction.id)) throw invalidInteraction("duplicate_reaction_id");
    ids.add(reaction.id);
    const dedupeKey = `${reaction.participantId}\u0000${reaction.sequence}\u0000${reaction.kind}`;
    if (dedupe.has(dedupeKey)) {
      throw invalidInteraction("duplicate_snapshot_reaction");
    }
    dedupe.add(dedupeKey);
    const participantRecords = byParticipant.get(reaction.participantId) ?? [];
    participantRecords.push(reaction);
    byParticipant.set(reaction.participantId, participantRecords);
    appendValidatedReactionToIndex(index, reaction);
  }
  for (const reactions of byParticipant.values()) {
    if (reactions.length > 30) {
      throw invalidInteraction("snapshot_reaction_total_exceeded");
    }
    const times = reactions
      .map((reaction) => Date.parse(reaction.createdAt))
      .sort((left, right) => left - right);
    for (let index = 0; index < times.length; index += 1) {
      const windowStart = times[index] - 60_000;
      if (
        times.filter((time) => time > windowStart && time <= times[index])
          .length > 5
      ) {
        throw invalidInteraction("snapshot_reaction_rate_exceeded");
      }
    }
  }
  return index;
}

function validateAppendOnlySnapshotReactions(
  snapshot: ReplayPremiereInteractionsSnapshot,
  seatIdentityById: ReadonlyMap<string, string>,
  validation: ReplayPremiereAppendOnlyReactionValidation,
): void {
  const { index, appended } = validation;
  const expectedLength = index.totalReactions + (appended === null ? 0 : 1);
  const priorTail = snapshot.reactions[index.totalReactions - 1];
  if (
    snapshot.reactions.length !== expectedLength ||
    (index.totalReactions === 0
      ? index.lastReactionId !== null
      : priorTail?.id !== index.lastReactionId)
  ) {
    throw invalidInteraction("reaction_evidence_not_append_only");
  }
  if (appended === null) return;
  if (snapshot.reactions[expectedLength - 1] !== appended.reaction) {
    throw invalidInteraction("reaction_append_identity_mismatch");
  }

  // The release callback was consulted when the reaction entered the private
  // mutation queue. Reuse that exact evidence here so a committed reaction is
  // checked once, while recovered/external snapshots still take the full
  // validation path above.
  validateSnapshotReactions(
    { ...snapshot, reactions: [appended.reaction] },
    () => appended.releasedContext,
    seatIdentityById,
  );

  const reaction = appended.reaction;
  const dedupeKey = reactionDedupeKey(reaction);
  if (index.ids.has(reaction.id)) {
    throw invalidInteraction("duplicate_reaction_id");
  }
  if (index.dedupeKeys.has(dedupeKey)) {
    throw invalidInteraction("duplicate_snapshot_reaction");
  }
  const participantTimes = [
    ...(index.createdAtMsByParticipant.get(reaction.participantId) ?? []),
    Date.parse(reaction.createdAt),
  ];
  assertReactionParticipantLimits(participantTimes);
}

function assertReactionParticipantLimits(times: readonly number[]): void {
  if (times.length > 30) {
    throw invalidInteraction("snapshot_reaction_total_exceeded");
  }
  const ordered = [...times].sort((left, right) => left - right);
  for (let index = 0; index < ordered.length; index += 1) {
    const windowStart = ordered[index] - 60_000;
    if (
      ordered.filter((time) => time > windowStart && time <= ordered[index])
        .length > 5
    ) {
      throw invalidInteraction("snapshot_reaction_rate_exceeded");
    }
  }
}

function validateSnapshotShares(
  snapshot: ReplayPremiereInteractionsSnapshot,
  options: ReplayPremiereInteractionSnapshotValidationOptions,
): void {
  const ids = new Set<string>();
  for (const share of snapshot.shares) {
    if (!isRecord(share)) throw invalidInteraction("share_not_object");
    assertExactKeys(share, [
      "id",
      "premiereId",
      "sourceReactionId",
      "sequence",
      "turn",
      "createdByParticipantId",
      "cardVersion",
      "createdAt",
      "idempotencyKey",
    ]);
    assertShareId(share.id);
    assertParticipantId(share.createdByParticipantId);
    assertSequence(share.sequence);
    assertSequence(share.turn);
    timestamp(share.createdAt, "snapshot_share_created_at");
    assertIdempotencyKey(share.idempotencyKey);
    const context = options.getReleasedContext(share.sequence);
    const sourceReaction =
      share.sourceReactionId === null
        ? null
        : snapshot.reactions.find(
            (reaction) => reaction.id === share.sourceReactionId,
          );
    if (share.sourceReactionId !== null)
      assertReactionId(share.sourceReactionId);
    if (
      share.premiereId !== snapshot.premiereId ||
      share.cardVersion !== 1 ||
      context === null ||
      share.sequence > context.releasedThroughSequence ||
      share.turn !== context.turn ||
      (share.sourceReactionId !== null &&
        (sourceReaction === null ||
          sourceReaction === undefined ||
          sourceReaction.sequence !== share.sequence ||
          sourceReaction.turn !== share.turn))
    ) {
      throw invalidInteraction("invalid_snapshot_share");
    }
    const idempotencyIdentity = `${share.createdByParticipantId}\u0000${share.idempotencyKey}`;
    if (ids.has(share.id) || ids.has(idempotencyIdentity)) {
      throw invalidInteraction("duplicate_share_identity");
    }
    ids.add(share.id);
    ids.add(idempotencyIdentity);
  }
}

function validateSnapshotSessions(
  snapshot: ReplayPremiereInteractionsSnapshot,
  options: ReplayPremiereInteractionSnapshotValidationOptions,
): void {
  const ids = new Set<string>();
  for (const session of snapshot.sessions) {
    if (!isRecord(session)) throw invalidInteraction("session_not_object");
    assertExactKeys(session, [
      "id",
      "premiereId",
      "participantId",
      "startedAt",
      "lastHeartbeatAt",
      "endedAt",
      "connectedDurationMs",
      "visibleDurationMs",
      "currentlyVisible",
      "firstReleasedSequenceObserved",
      "lastReleasedSequenceObserved",
      "predictionCount",
      "reactionCount",
      "shareCount",
      "incomingAttribution",
      "excludedAsOperator",
      "excludedAsBot",
      "qualifiedAt",
      "idempotencyKey",
      "creationRequestHash",
      "heartbeatReceipts",
    ]);
    assertSessionId(session.id);
    assertParticipantId(session.participantId);
    assertIdempotencyKey(session.idempotencyKey);
    if (!/^[a-f0-9]{64}$/.test(session.creationRequestHash)) {
      throw invalidInteraction("invalid_session_creation_request_hash");
    }
    if (
      !Array.isArray(session.heartbeatReceipts) ||
      session.heartbeatReceipts.length > HEARTBEAT_RECEIPT_LIMIT
    ) {
      throw invalidInteraction("invalid_session_heartbeat_receipts");
    }
    const startedAt = timestamp(
      session.startedAt,
      "snapshot_session_started_at",
    );
    const lastHeartbeatAt = timestamp(
      session.lastHeartbeatAt,
      "snapshot_session_heartbeat_at",
    );
    const endedAt =
      session.endedAt === null
        ? null
        : timestamp(session.endedAt, "snapshot_session_ended_at");
    assertSnapshotObservedSequence(
      session.firstReleasedSequenceObserved,
      options,
    );
    assertSnapshotObservedSequence(
      session.lastReleasedSequenceObserved,
      options,
    );
    const counters = [
      session.connectedDurationMs,
      session.visibleDurationMs,
      session.predictionCount,
      session.reactionCount,
      session.shareCount,
    ];
    if (
      session.premiereId !== snapshot.premiereId ||
      counters.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      session.visibleDurationMs > session.connectedDurationMs ||
      session.connectedDurationMs > lastHeartbeatAt - startedAt ||
      lastHeartbeatAt < startedAt ||
      (endedAt !== null && endedAt < lastHeartbeatAt) ||
      session.lastReleasedSequenceObserved <
        session.firstReleasedSequenceObserved ||
      typeof session.currentlyVisible !== "boolean" ||
      typeof session.excludedAsOperator !== "boolean" ||
      typeof session.excludedAsBot !== "boolean"
    ) {
      throw invalidInteraction("invalid_snapshot_session");
    }
    validateHeartbeatReceipts(session, options, startedAt, lastHeartbeatAt);
    if (session.incomingAttribution !== null) {
      validateAttribution(session.incomingAttribution, snapshot.premiereId);
      const attributedShare = snapshot.shares.find(
        (share) => share.id === session.incomingAttribution?.shareId,
      );
      if (
        attributedShare === undefined ||
        attributedShare.createdByParticipantId !==
          session.incomingAttribution.attributionId
      ) {
        throw invalidInteraction("snapshot_session_attribution_mismatch");
      }
    }
    const qualifies =
      !session.excludedAsOperator &&
      !session.excludedAsBot &&
      (session.visibleDurationMs >= 5 * 60_000 ||
        session.predictionCount + session.reactionCount + session.shareCount >
          0);
    if (session.qualifiedAt === null ? qualifies : !qualifies) {
      throw invalidInteraction("snapshot_session_qualification_mismatch");
    }
    if (session.qualifiedAt !== null) {
      const qualifiedAt = timestamp(
        session.qualifiedAt,
        "snapshot_session_qualified_at",
      );
      if (
        qualifiedAt < startedAt ||
        (endedAt !== null && qualifiedAt > endedAt)
      ) {
        throw invalidInteraction("invalid_snapshot_qualification_time");
      }
    }
    const idempotencyIdentity = `${session.participantId}\u0000${session.idempotencyKey}`;
    if (ids.has(session.id) || ids.has(idempotencyIdentity)) {
      throw invalidInteraction("duplicate_session_identity");
    }
    ids.add(session.id);
    ids.add(idempotencyIdentity);
  }
}

function validateHeartbeatReceipts(
  session: ReplayPremiereViewerSession,
  options: ReplayPremiereInteractionSnapshotValidationOptions,
  startedAt: number,
  lastHeartbeatAt: number,
): void {
  const idempotencyKeys = new Set<string>();
  let previousAcceptedAt = startedAt;
  for (const receipt of session.heartbeatReceipts) {
    if (!isRecord(receipt)) {
      throw invalidInteraction("heartbeat_receipt_not_object");
    }
    assertExactKeys(receipt, ["idempotencyKey", "requestHash", "acceptedAt"]);
    assertIdempotencyKey(receipt.idempotencyKey);
    const acceptedAt = timestamp(
      receipt.acceptedAt,
      "snapshot_heartbeat_accepted_at",
    );
    if (
      !/^[a-f0-9]{64}$/.test(receipt.requestHash) ||
      idempotencyKeys.has(receipt.idempotencyKey) ||
      acceptedAt - previousAcceptedAt <
        (options.minHeartbeatIntervalMs ?? 1_000) ||
      acceptedAt > lastHeartbeatAt
    ) {
      throw invalidInteraction("invalid_heartbeat_receipt");
    }
    idempotencyKeys.add(receipt.idempotencyKey);
    previousAcceptedAt = acceptedAt;
  }
  if (
    session.heartbeatReceipts.length === 0
      ? lastHeartbeatAt !== startedAt
      : previousAcceptedAt !== lastHeartbeatAt
  ) {
    throw invalidInteraction("heartbeat_receipt_anchor_mismatch");
  }
}

function validateSnapshotAttributions(
  snapshot: ReplayPremiereInteractionsSnapshot,
): void {
  const participants = new Set<string>();
  for (const entry of snapshot.lastNonDirectAttributionByParticipant) {
    if (!isRecord(entry))
      throw invalidInteraction("attribution_touch_not_object");
    assertExactKeys(entry, ["participantId", "attribution", "touchedAt"]);
    assertParticipantId(entry.participantId);
    validateAttribution(entry.attribution, snapshot.premiereId);
    const attributedShare = snapshot.shares.find(
      (share) => share.id === entry.attribution.shareId,
    );
    const touchedAt = timestamp(
      entry.touchedAt,
      "snapshot_attribution_touched_at",
    );
    if (
      touchedAt < Date.parse(entry.attribution.issuedAt) ||
      touchedAt > Date.parse(entry.attribution.expiresAt) ||
      attributedShare === undefined ||
      attributedShare.createdByParticipantId !==
        entry.attribution.attributionId ||
      participants.has(entry.participantId)
    ) {
      throw invalidInteraction("invalid_snapshot_attribution_touch");
    }
    participants.add(entry.participantId);
  }
}

function validateSnapshotSessionActionTotals(
  snapshot: ReplayPremiereInteractionsSnapshot,
  appendOnlyReactions?: ReplayPremiereAppendOnlyReactionValidation,
): void {
  const expectedPredictions = countBy(
    snapshot.predictions.map((record) => record.participantId),
  );
  const expectedReactions =
    appendOnlyReactions === undefined
      ? countBy(snapshot.reactions.map((record) => record.participantId))
      : appendOnlyReactions.index.byParticipantTotal;
  const appendedReactionParticipantId =
    appendOnlyReactions?.appended?.reaction.participantId ?? null;
  const expectedShares = countBy(
    snapshot.shares.map((record) => record.createdByParticipantId),
  );
  const actualPredictions = sumSessionField(
    snapshot.sessions,
    "predictionCount",
  );
  const actualReactions = sumSessionField(snapshot.sessions, "reactionCount");
  const actualShares = sumSessionField(snapshot.sessions, "shareCount");
  const participants = new Set([
    ...expectedPredictions.keys(),
    ...expectedReactions.keys(),
    ...expectedShares.keys(),
    ...(appendedReactionParticipantId === null
      ? []
      : [appendedReactionParticipantId]),
    ...actualPredictions.keys(),
    ...actualReactions.keys(),
    ...actualShares.keys(),
  ]);
  for (const participantId of participants) {
    if (
      (actualPredictions.get(participantId) ?? 0) !==
        (expectedPredictions.get(participantId) ?? 0) ||
      (actualReactions.get(participantId) ?? 0) !==
        (expectedReactions.get(participantId) ?? 0) +
          (participantId === appendedReactionParticipantId ? 1 : 0) ||
      (actualShares.get(participantId) ?? 0) !==
        (expectedShares.get(participantId) ?? 0)
    ) {
      throw invalidInteraction("snapshot_session_action_totals_mismatch");
    }
  }
}

function countBy(values: readonly string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function sumSessionField(
  sessions: readonly ReplayPremiereViewerSession[],
  field: "predictionCount" | "reactionCount" | "shareCount",
): Map<string, number> {
  const result = new Map<string, number>();
  for (const session of sessions) {
    result.set(
      session.participantId,
      (result.get(session.participantId) ?? 0) + session[field],
    );
  }
  return result;
}

function validateSnapshotInteractionLimits(
  snapshot: ReplayPremiereInteractionsSnapshot,
  limits: ReplayPremiereInteractionLimits,
): void {
  if (
    snapshot.sessions.length > limits.maxSessionsPerPremiere ||
    snapshot.shares.length > limits.maxSharesPerPremiere ||
    premiereRecordCount(snapshot) > limits.maxTotalRecords
  ) {
    throw invalidInteraction("snapshot_premiere_record_limit_exceeded");
  }
  const sessionsByParticipant = groupByParticipant(
    snapshot.sessions,
    (session) => session.participantId,
  );
  for (const sessions of sessionsByParticipant.values()) {
    if (
      sessions.length > limits.maxSessionsPerParticipant ||
      sessions.some(
        (session) => session.shareCount > limits.maxSharesPerSession,
      )
    ) {
      throw invalidInteraction("snapshot_session_limit_exceeded");
    }
    assertRollingLimit(
      sessions.map((session) => Date.parse(session.startedAt)),
      limits.maxSessionCreatesPerParticipantPerMinute,
      "snapshot_session_rate_exceeded",
    );
    for (const session of sessions) {
      assertRollingLimit(
        session.heartbeatReceipts.map((receipt) =>
          Date.parse(receipt.acceptedAt),
        ),
        limits.maxHeartbeatWritesPerSessionPerMinute,
        "snapshot_heartbeat_rate_exceeded",
      );
    }
  }
  const sharesByParticipant = groupByParticipant(
    snapshot.shares,
    (share) => share.createdByParticipantId,
  );
  for (const shares of sharesByParticipant.values()) {
    if (shares.length > limits.maxSharesPerParticipant) {
      throw invalidInteraction("snapshot_share_limit_exceeded");
    }
    assertRollingLimit(
      shares.map((share) => Date.parse(share.createdAt)),
      limits.maxShareCreatesPerParticipantPerMinute,
      "snapshot_share_rate_exceeded",
    );
  }
}

function groupByParticipant<T>(
  records: readonly T[],
  participantId: (record: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const key = participantId(record);
    const values = grouped.get(key) ?? [];
    values.push(record);
    grouped.set(key, values);
  }
  return grouped;
}

function assertRollingLimit(
  rawTimes: readonly number[],
  limit: number,
  operatorCode: string,
): void {
  const times = [...rawTimes].sort((left, right) => left - right);
  let windowStart = 0;
  for (let index = 0; index < times.length; index += 1) {
    while (times[windowStart] <= times[index] - 60_000) windowStart += 1;
    if (index - windowStart + 1 > limit) {
      throw invalidInteraction(operatorCode);
    }
  }
}

function premiereRecordCount(
  snapshot: ReplayPremiereInteractionsSnapshot,
): number {
  return (
    snapshot.checkpoints.length +
    snapshot.predictions.length +
    snapshot.trades.length +
    snapshot.reactions.length +
    snapshot.shares.length +
    snapshot.sessions.length +
    snapshot.lastNonDirectAttributionByParticipant.length
  );
}

function assertPremiereRecordCapacity(
  snapshot: ReplayPremiereInteractionsSnapshot,
  limits: ReplayPremiereInteractionLimits,
  additionalRecords: number,
): void {
  if (
    premiereRecordCount(snapshot) + additionalRecords >
    limits.maxTotalRecords
  ) {
    throw rateLimited("premiere_record_capacity_exceeded");
  }
}

function resolveInteractionLimits(
  overrides: Partial<ReplayPremiereInteractionLimits> | undefined,
): ReplayPremiereInteractionLimits {
  if (overrides !== undefined && !isRecord(overrides)) {
    throw invalidInteraction("invalid_interaction_limits");
  }
  const allowedKeys = new Set(Object.keys(DEFAULT_INTERACTION_LIMITS));
  if (
    overrides !== undefined &&
    Object.keys(overrides).some((key) => !allowedKeys.has(key))
  ) {
    throw invalidInteraction("unknown_interaction_limit");
  }
  const limits = { ...DEFAULT_INTERACTION_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    validatePositiveInteger(value, `interaction_limit_${key}`);
  }
  if (
    limits.maxSessionsPerParticipant > limits.maxSessionsPerPremiere ||
    limits.maxSessionCreatesPerParticipantPerMinute >
      limits.maxSessionsPerParticipant ||
    limits.maxSharesPerParticipant > limits.maxSharesPerPremiere ||
    limits.maxSharesPerSession > limits.maxSharesPerParticipant ||
    limits.maxShareCreatesPerParticipantPerMinute >
      limits.maxSharesPerParticipant ||
    limits.maxSessionsPerPremiere > limits.maxTotalRecords ||
    limits.maxSharesPerPremiere > limits.maxTotalRecords
  ) {
    throw invalidInteraction("incoherent_interaction_limits");
  }
  return limits;
}

function shareUrl(
  canonicalPremiereUrl: string,
  shareId: string,
  attributionToken: string,
): string {
  const url = new URL(canonicalPremiereUrl);
  url.searchParams.set("moment", shareId);
  url.searchParams.set("attribution", attributionToken);
  return url.toString();
}

function validateAttribution(
  attribution: ReplayPremiereShareAttribution,
  premiereId: string,
): void {
  if (!isRecord(attribution))
    throw invalidInteraction("attribution_not_object");
  assertExactKeys(attribution, [
    "attributionId",
    "shareId",
    "premiereId",
    "issuedAt",
    "expiresAt",
  ]);
  assertParticipantId(attribution.attributionId);
  assertShareId(attribution.shareId);
  const issuedAt = timestamp(
    attribution.issuedAt,
    "snapshot_attribution_issued_at",
  );
  const expiresAt = timestamp(
    attribution.expiresAt,
    "snapshot_attribution_expires_at",
  );
  if (
    attribution.premiereId !== premiereId ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 7 * 24 * 60 * 60 * 1_000
  ) {
    throw invalidInteraction("invalid_snapshot_attribution");
  }
}

function assertSnapshotObservedSequence(
  sequence: number,
  options: ReplayPremiereInteractionSnapshotValidationOptions,
): void {
  assertObservedSequence(sequence);
  if (sequence === -1) return;
  // Mirrors `assertAuthoritativeObservedSequence`'s live-path widening
  // exactly: a `contentSource: "tap"` (wagering) client legitimately
  // reports a fine-grained observedSequence that can be ahead of the
  // coarse chunk-release marker `getReleasedContext` exposes. A session
  // accepted live at that fine-grained bound must still validate at
  // recovery/restart — re-checking ONLY the coarse bound here would
  // reject exactly the sessions the live-path widening was meant to
  // unblock, the moment the server next restarts.
  if (sequence <= options.getLiveVisibleSequence()) return;
  const context = options.getReleasedContext(sequence);
  if (context === null || sequence > context.releasedThroughSequence) {
    throw invalidInteraction("snapshot_observed_sequence_unreleased");
  }
}

function identityKey(identity: PolicyIdentity): string {
  return canonicalReplayPremiereJson(json(identity));
}

function identityKeyOrNull(value: ReplayPremiereJsonValue | null): string {
  return value === null ? "null" : canonicalReplayPremiereJson(json(value));
}

function assertExactKeys(value: object, expectedKeys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw invalidInteraction("snapshot_contains_unknown_or_missing_fields");
  }
}

function findCheckpoint(
  snapshot: ReplayPremiereInteractionsSnapshot,
  checkpointId: string,
): ReplayPremiereInteractionCheckpoint {
  assertCheckpointId(checkpointId);
  const checkpoint = snapshot.checkpoints.find(
    (candidate) => candidate.id === checkpointId,
  );
  if (checkpoint === undefined) throw notFound("checkpoint_not_found");
  return checkpoint;
}

function ownedSession(
  snapshot: ReplayPremiereInteractionsSnapshot,
  sessionId: string,
  participantId: string,
): ReplayPremiereViewerSession {
  assertSessionId(sessionId);
  assertParticipantId(participantId);
  const session = snapshot.sessions.find(
    (candidate) => candidate.id === sessionId,
  );
  if (session === undefined || session.participantId !== participantId) {
    throw notFound("viewer_session_not_found");
  }
  return session;
}

function recordSessionAction(
  session: ReplayPremiereViewerSession,
  kind: "prediction" | "reaction" | "share",
  occurredAt: string,
): void {
  if (kind === "prediction") session.predictionCount += 1;
  if (kind === "reaction") session.reactionCount += 1;
  if (kind === "share") session.shareCount += 1;
  qualifySession(session, occurredAt);
}

function qualifySession(
  session: ReplayPremiereViewerSession,
  occurredAt: string,
): void {
  if (
    session.qualifiedAt === null &&
    !session.excludedAsBot &&
    !session.excludedAsOperator &&
    (session.visibleDurationMs >= 5 * 60_000 ||
      session.predictionCount + session.reactionCount + session.shareCount > 0)
  ) {
    session.qualifiedAt = occurredAt;
  }
}

function bestQualifiedSessions(
  sessions: readonly ReplayPremiereViewerSession[],
): Map<string, ReplayPremiereViewerSession> {
  const result = new Map<string, ReplayPremiereViewerSession>();
  for (const session of sessions) {
    if (session.qualifiedAt === null) continue;
    const existing = result.get(session.participantId);
    if (
      existing === undefined ||
      Date.parse(session.qualifiedAt) < Date.parse(existing.qualifiedAt ?? "")
    ) {
      result.set(session.participantId, session);
    }
  }
  return result;
}

function canonicalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw invalidInteraction("invalid_canonical_premiere_url", error);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    value.length > 2_048
  ) {
    throw invalidInteraction("invalid_canonical_premiere_url");
  }
  return url.toString();
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw invalidInteraction(`invalid_${field}`);
  }
  return parsed;
}

function validatePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidInteraction(`invalid_${field}`);
  }
  return value;
}

function assertPremiereId(value: string): void {
  if (!/^prem_[a-z0-9]{16,32}$/.test(value)) {
    throw invalidInteraction("invalid_premiere_id");
  }
}

function assertParticipantId(value: string): void {
  // guest_* = real anonymous participants; sim_* = the synthetic crowd,
  // deliberately in an equally locked, visibly distinct namespace so the
  // two can never be confused. Both go through the exact same session
  // ownership, idempotency, and market-order path — no bypass.
  if (!/^(guest|sim)_[a-f0-9]{32}$/.test(value)) {
    throw invalidInteraction("invalid_participant_id");
  }
}

function assertSessionId(value: string): void {
  if (!/^sess_[a-f0-9]{32}$/.test(value)) {
    throw invalidInteraction("invalid_session_id");
  }
}

function assertCheckpointId(value: string): void {
  if (!/^cp_[a-z0-9]{8,32}$/.test(value)) {
    throw invalidInteraction("invalid_checkpoint_id");
  }
}

function assertSeatId(value: string): void {
  if (!OPAQUE_SEAT_ID_PATTERN.test(value) || value.includes("..")) {
    throw invalidInteraction("invalid_seat_id");
  }
}

function assertReactionId(value: string): void {
  if (!/^react_[a-f0-9]{32}$/.test(value)) {
    throw invalidInteraction("invalid_reaction_id");
  }
}

function assertShareId(value: string): void {
  if (!/^share_[a-f0-9]{32}$/.test(value)) {
    throw invalidInteraction("invalid_share_id");
  }
}

function assertTradeId(value: string): void {
  if (!/^trade_[a-f0-9]{32}$/.test(value)) {
    throw invalidInteraction("invalid_trade_id");
  }
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value) || value.includes("..")) {
    throw invalidInteraction("invalid_idempotency_key");
  }
}

function assertRequesterBucketId(value: string): void {
  if (!REQUESTER_BUCKET_ID_PATTERN.test(value)) {
    throw invalidInteraction("invalid_requester_bucket_id");
  }
}

function assertSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
    throw invalidInteraction("invalid_sequence");
  }
}

function assertObservedSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < -1 || value > 10_000_000) {
    throw invalidInteraction("invalid_observed_sequence");
  }
}

function isReactionKind(value: unknown): value is ReplayPremiereReactionKind {
  return (
    typeof value === "string" &&
    (REPLAY_PREMIERE_REACTION_KINDS as readonly string[]).includes(value)
  );
}

function clone<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return structuredClone(value);
}

function json(value: unknown): ReplayPremiereJsonValue {
  const serialized: unknown = JSON.parse(JSON.stringify(value));
  assertReplayPremiereJsonValue(
    serialized,
    "replay premiere interaction state",
  );
  return serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidInteraction(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    400,
    `Replay premiere interaction request rejected: ${operatorCode}`,
    cause === undefined ? undefined : { cause },
  );
}

function conflict(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    409,
    `Replay premiere interaction conflicts with accepted state: ${operatorCode}`,
  );
}

function gone(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    410,
    `Replay premiere interaction window is closed: ${operatorCode}`,
  );
}

function notFound(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    404,
    `Replay premiere interaction resource was not found: ${operatorCode}`,
  );
}

function rateLimited(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_CAPACITY_EXCEEDED",
    429,
    `Replay premiere interaction rate was rejected: ${operatorCode}`,
  );
}
