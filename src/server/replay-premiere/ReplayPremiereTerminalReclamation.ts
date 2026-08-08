import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIP_BYTES,
  DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIPS,
  ReplayPremiereArchivedClipPromoter,
} from "./ReplayPremiereArchivedClipPromoter";
import type { PremiereArchivePointerV1 } from "./ReplayPremiereArchiveIndex";
import { ReplayPremiereArchiveStore } from "./ReplayPremiereArchiveIndex";
import { verifyPremiereAuthoritativeResultBytes } from "./ReplayPremiereAuthoritativeResult";
import type { ReplayPremiereAdmissionRecordV1 } from "./ReplayPremiereCatalog";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import type { ReplayPremiereHttpTarget } from "./ReplayPremiereHttp";
import {
  replayPremiereInteractionAggregateId,
  resolveReplayPremiereTerminalPredictionsFromAuthoritativeResult,
  type ReplayPremiereInteractionEventStore,
} from "./ReplayPremiereInteractionRecovery";
import {
  createReplayPremiereInitialInteractionsSnapshot,
  hasCompleteReplayPremierePredictionResolution,
  type ReplayPremiereInteractionLimits,
} from "./ReplayPremiereInteractions";
import {
  buildPremiereResultSummaryFromDurableEvidence,
  buildPremiereResultSummaryFromTarget,
  type PremiereResultTerminalState,
} from "./ReplayPremiereResultSummary";

/** Live viewers finish before bulk is deleted: default 30 minutes post-reveal. */
export const DEFAULT_REPLAY_PREMIERE_RECLAMATION_GRACE_MS = 30 * 60 * 1000;

/** Comma-separated premiere ids that must never be reclaimed. */
export const REPLAY_PREMIERE_RECLAIM_EXCLUDE_ENV =
  "PROXYWAR_PREMIERE_RECLAIM_EXCLUDE";
/** Operator pin file under the private state root (one premiere id per line). */
export const REPLAY_PREMIERE_RECLAIM_EXCLUDE_FILE = "reclaim-exclude.txt";

const PREMIERE_ID_PATTERN = /^prem_[a-z0-9]{16,32}$/;
const ADMISSION_SUFFIX = ".admission.json";

/**
 * Durable archived-clip storage bounds. Archive summaries live forever, but the
 * clips beside them are MB-scale mp4s, so the clips directory is bounded by
 * BOTH a retained-count cap and a byte cap with oldest-first (by promotion
 * mtime) eviction, applied at promotion time. Evicting a durable clip only
 * removes the archived page's download section — the page itself never breaks.
 */
export {
  DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIP_BYTES,
  DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIPS,
} from "./ReplayPremiereArchivedClipPromoter";

export interface ReplayPremiereReclamationEligibility {
  eligible: boolean;
  terminal: boolean;
  terminalState: PremiereResultTerminalState | null;
  revealedAt: string | null;
  reason:
    | "eligible"
    | "excluded"
    | "not_terminal"
    | "prediction_resolution_pending"
    | "within_grace"
    | "revealed_time_unavailable";
}

export interface ReplayPremiereReclamationResult {
  premiereId: string;
  reclaimed: boolean;
  reason:
    | "reclaimed"
    | "already_reclaimed"
    | "excluded"
    | "not_terminal"
    | "prediction_resolution_pending"
    | "within_grace"
    | "revealed_time_unavailable";
  pointer: PremiereArchivePointerV1 | null;
  deletedBulk: boolean;
}

/**
 * A terminal premiere with durable evidence but NO live registered runtime
 * (2026-07-22 orphan class: a premiere that reveals and then spans a beta
 * restart inside its reclamation grace is never re-registered — fresh rounds
 * own the critical startup slot — so the live-target sweep can never reach
 * it and its page 404s forever). The candidate carries everything the
 * durable-evidence reclamation path needs; the terminal state and reveal
 * instant come from the event store's recovered evidence, the rest from the
 * hash-covered admission record.
 */
export interface ReplayPremiereOrphanCandidate {
  premiereId: string;
  record: ReplayPremiereAdmissionRecordV1;
  terminalState: PremiereResultTerminalState;
  /** From the reveal event; null only for failed/cancelled orphans. */
  revealedAt: string | null;
  /** Sweep-side bounded retry counter (mutated by the sweep, not here). */
  attempts: number;
}

/**
 * Deletes a terminal premiere's storage bulk after a grace window, but only
 * after a tiny durable result summary and archive pointer are committed. This
 * runs inside the premiere lifecycle (never the storage guard), is journaled by
 * the pointer append (write-then-delete), and never deletes the summary.
 */
export class ReplayPremiereTerminalReclaimer {
  private readonly privateStateRoot: string;
  private readonly store: ReplayPremiereArchiveStore;
  private readonly graceMs: number;
  private readonly now: () => Date;
  private readonly catalogEntriesDir: string;
  private readonly snapshotsDir: string;
  private readonly excluded: ReadonlySet<string>;
  private readonly archivedClipPromoter: ReplayPremiereArchivedClipPromoter;
  private readonly logger: (message: string) => void;
  private readonly interactionEventStore: ReplayPremiereInteractionEventStore | null;
  private readonly interactionLimits:
    | Partial<ReplayPremiereInteractionLimits>
    | undefined;
  private readonly fenceClipWritesAndDrain:
    | ((premiereId: string) => Promise<void>)
    | null;

  constructor(options: {
    privateStateRoot: string;
    store: ReplayPremiereArchiveStore;
    graceMs?: number;
    now?: () => Date;
    /** Premiere ids that must never be reclaimed (e.g. release-proof premieres). */
    excludedPremiereIds?: Iterable<string>;
    /** Durable archived-clip retention bounds (count / total bytes). */
    maxArchivedClips?: number;
    maxArchivedClipBytes?: number;
    /** Operator diagnostics; durable promotion failures propagate before deletion. */
    logger?: (message: string) => void;
    /** Shared durable promoter used by post-archive league render callbacks. */
    archivedClipPromoter?: ReplayPremiereArchivedClipPromoter;
    /** Active writer used for one atomic, hash-chained orphan interaction read. */
    interactionEventStore?: ReplayPremiereInteractionEventStore;
    interactionLimits?: Partial<ReplayPremiereInteractionLimits>;
    /** Permanently fences and drains queued/running clip work for a live target. */
    fenceClipWritesAndDrain?: (premiereId: string) => Promise<void>;
  }) {
    const graceMs =
      options.graceMs ?? DEFAULT_REPLAY_PREMIERE_RECLAMATION_GRACE_MS;
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
      throw reclamationRequest("invalid_reclamation_grace");
    }
    this.privateStateRoot = path.resolve(options.privateStateRoot);
    this.store = options.store;
    this.graceMs = graceMs;
    this.now = options.now ?? (() => new Date());
    this.excluded = new Set(options.excludedPremiereIds ?? []);
    this.catalogEntriesDir = path.join(
      this.privateStateRoot,
      "catalog-v1",
      "entries",
    );
    this.snapshotsDir = path.join(
      this.privateStateRoot,
      "event-store-v1",
      "snapshots",
    );
    this.logger = options.logger ?? (() => undefined);
    this.archivedClipPromoter =
      options.archivedClipPromoter ??
      new ReplayPremiereArchivedClipPromoter({
        privateStateRoot: this.privateStateRoot,
        archiveStore: this.store,
        maxArchivedClips:
          options.maxArchivedClips ??
          DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIPS,
        maxArchivedClipBytes:
          options.maxArchivedClipBytes ??
          DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIP_BYTES,
        logger: this.logger,
      });
    this.interactionEventStore = options.interactionEventStore ?? null;
    this.interactionLimits = options.interactionLimits;
    this.fenceClipWritesAndDrain = options.fenceClipWritesAndDrain ?? null;
  }

  /** Pure eligibility check: terminal AND (post-grace for revealed/archived). */
  eligibility(
    target: ReplayPremiereHttpTarget,
  ): ReplayPremiereReclamationEligibility {
    if (this.excluded.has(target.runtime.premiereId)) {
      // Never reclaim an excluded premiere — it stays a fully-served live
      // premiere (source, chunks, and replay intact), not a summary-only pointer.
      return {
        eligible: false,
        terminal: false,
        terminalState: null,
        revealedAt: null,
        reason: "excluded",
      };
    }
    const state = target.runtime.readLifecycleState();
    const reveal = target.runtime.readReveal();
    if (reveal !== null && (state === "revealed" || state === "archived")) {
      const revealedAtMs = Date.parse(reveal.revealedAt);
      if (!Number.isFinite(revealedAtMs)) {
        return {
          eligible: false,
          terminal: true,
          terminalState: state,
          revealedAt: null,
          reason: "revealed_time_unavailable",
        };
      }
      const elapsed = this.now().getTime() - revealedAtMs;
      if (!target.interactions.hasCompletePredictionResolution()) {
        return {
          eligible: false,
          terminal: true,
          terminalState: state,
          revealedAt: reveal.revealedAt,
          reason: "prediction_resolution_pending",
        };
      }
      return {
        eligible: elapsed >= this.graceMs,
        terminal: true,
        terminalState: state,
        revealedAt: reveal.revealedAt,
        reason: elapsed >= this.graceMs ? "eligible" : "within_grace",
      };
    }
    if (state === "failed" || state === "cancelled") {
      // No reveal ever occurred, so there are no live viewers to protect.
      return {
        eligible: true,
        terminal: true,
        terminalState: state,
        revealedAt: null,
        reason: "eligible",
      };
    }
    return {
      eligible: false,
      terminal: false,
      terminalState: null,
      revealedAt: null,
      reason: "not_terminal",
    };
  }

  /**
   * Reclaims one target if eligible. Idempotent: an already-summarized premiere
   * re-runs only the (idempotent) bulk deletion. The summary is built exactly
   * once — the first successful reclamation — so retries never mutate it.
   */
  async reclaimIfEligible(
    target: ReplayPremiereHttpTarget,
  ): Promise<ReplayPremiereReclamationResult> {
    const premiereId = target.runtime.premiereId;
    if (this.excluded.has(premiereId)) {
      // Hard exclusion: never write a pointer, delete bulk, or de-register.
      return {
        premiereId,
        reclaimed: false,
        reason: "excluded",
        pointer: this.store.lookup(premiereId),
        deletedBulk: false,
      };
    }
    const already = this.store.lookup(premiereId);
    const eligibility = this.eligibility(target);
    if (
      eligibility.reason === "prediction_resolution_pending" ||
      (already === null && !eligibility.eligible)
    ) {
      return {
        premiereId,
        reclaimed: false,
        reason:
          eligibility.reason === "eligible"
            ? "not_terminal"
            : eligibility.reason === "not_terminal"
              ? "not_terminal"
              : eligibility.reason,
        pointer: already,
        deletedBulk: false,
      };
    }
    let pointer = already;
    // Close mutation admission before either building the one authoritative
    // terminal snapshot or finishing an already-recorded reclamation. The
    // latter matters after a crash between pointer commit and bulk deletion:
    // startup can temporarily reconstruct a writable target from the surviving
    // admission, and its retry must not race new writes while deleting bulk.
    const interactionDrain = target.interactions.fenceWritesAndDrain();
    const clipDrain =
      this.fenceClipWritesAndDrain?.(premiereId) ?? Promise.resolve();
    await Promise.all([interactionDrain, clipDrain]);
    if (pointer === null) {
      if (eligibility.terminalState === null) {
        throw reclamationIntegrity("reclamation_terminal_state_missing");
      }
      const summary = buildPremiereResultSummaryFromTarget({
        target,
        terminalState: eligibility.terminalState,
        reclaimedAt: this.now().toISOString(),
      });
      // The content-addressed source hash rides on the pointer so the shared
      // source bundle can be reclaimed at startup (no live writer) instead of in
      // this concurrent sweep.
      const sourceReplaySha256 =
        target.runtime.readBootstrap().provenance.sourceReplaySha256;
      pointer = await this.store.recordReclaimed(summary, sourceReplaySha256);
    } else {
      // A restart can recover the admission after the immutable archive pointer
      // was committed but before bulk deletion. Defense in depth: after the
      // write fence drains, prove the recovered aggregate is still exactly the
      // one the pointer names. Any accepted post-pointer reaction changes this
      // hash, so deletion fails closed and preserves its durable evidence.
      const recoveredSummary = buildPremiereResultSummaryFromTarget({
        target,
        terminalState: pointer.terminalState,
        reclaimedAt: pointer.reclaimedAt,
      });
      if (recoveredSummary.summaryHash !== pointer.summaryHash) {
        throw reclamationIntegrity(
          "reclamation_archived_summary_state_diverged",
        );
      }
    }
    // Promote the premiere's default clip into the durable archive BEFORE the
    // bulk is deleted (the clip cache is not bulk, but the render SOURCE is
    // startup-GC'd once the pointer exists, so post-reclamation the cached clip
    // is the last renderable copy). Missing/invalid candidates are a normal
    // no-op, but a real durability error aborts before bulk deletion so the
    // admission and snapshots remain a deterministic retry anchor.
    await this.promoteDurableClip(premiereId, pointer);
    await this.deleteBulk(premiereId);
    return {
      premiereId,
      reclaimed: true,
      reason: already === null ? "reclaimed" : "already_reclaimed",
      pointer,
      deletedBulk: true,
    };
  }

  /**
   * Reclaims one ORPHANED terminal premiere from durable evidence — the same
   * summary→pointer→clip→bulk sequence as {@link reclaimIfEligible}, with the
   * summary built from the admission record + event-store reveal evidence
   * instead of a live runtime. Idempotent exactly like the live path (an
   * existing pointer short-circuits to clip promotion + bulk deletion).
   *
   * Spoiler safety: an outcome is only derived for revealed/archived states
   * with a proven reveal instant; failed/cancelled orphans get the neutral
   * null-outcome summary; a revealed/archived candidate WITHOUT a reveal
   * instant is refused (`revealed_time_unavailable`) — a stale non-revealed
   * admission can never become publishable through this path.
   */
  async reclaimOrphanIfEligible(
    candidate: ReplayPremiereOrphanCandidate,
  ): Promise<ReplayPremiereReclamationResult> {
    const premiereId = candidate.premiereId;
    if (
      premiereId !== candidate.record.premiereId ||
      !PREMIERE_ID_PATTERN.test(premiereId)
    ) {
      throw reclamationRequest("reclamation_invalid_premiere_id");
    }
    if (this.excluded.has(premiereId)) {
      // Hard exclusion: never write a pointer, delete bulk, or de-register.
      return {
        premiereId,
        reclaimed: false,
        reason: "excluded",
        pointer: this.store.lookup(premiereId),
        deletedBulk: false,
      };
    }
    const already = this.store.lookup(premiereId);
    if (already === null) {
      if (
        candidate.terminalState === "revealed" ||
        candidate.terminalState === "archived"
      ) {
        if (candidate.revealedAt === null) {
          return {
            premiereId,
            reclaimed: false,
            reason: "revealed_time_unavailable",
            pointer: null,
            deletedBulk: false,
          };
        }
        const revealedAtMs = Date.parse(candidate.revealedAt);
        if (!Number.isFinite(revealedAtMs)) {
          return {
            premiereId,
            reclaimed: false,
            reason: "revealed_time_unavailable",
            pointer: null,
            deletedBulk: false,
          };
        }
        if (this.now().getTime() - revealedAtMs < this.graceMs) {
          return {
            premiereId,
            reclaimed: false,
            reason: "within_grace",
            pointer: null,
            deletedBulk: false,
          };
        }
      }
      // failed/cancelled orphans: no reveal ever occurred, so there are no
      // live viewers to protect — immediately eligible, like the live path.
    }
    let pointer = already;
    const record = candidate.record;
    const interactionRecovery =
      (candidate.terminalState === "revealed" ||
        candidate.terminalState === "archived") &&
      this.interactionEventStore !== null &&
      candidate.revealedAt !== null
        ? await resolveReplayPremiereTerminalPredictionsFromAuthoritativeResult(
            {
              eventStore: this.interactionEventStore,
              validationOptions: {
                premiereId,
                checkpointDescriptors: record.publicDefinition.checkpoints,
                seats: record.eligibilityRecord.seats.map((seat) => ({
                  seatId: seat.seatId,
                  policyIdentity: seat.policyIdentity,
                })),
                getPremiereState: () => candidate.terminalState,
                limits: this.interactionLimits,
              },
              result: verifyPremiereAuthoritativeResultBytes({
                eligibilityRecord: record.eligibilityRecord,
                resultBytes: Buffer.from(
                  record.authoritativeResult.bytes,
                  "base64",
                ),
              }),
              resolvedAt: candidate.revealedAt,
            },
          )
        : null;
    if (
      (candidate.terminalState === "revealed" ||
        candidate.terminalState === "archived") &&
      (interactionRecovery === null ||
        !hasCompleteReplayPremierePredictionResolution(
          interactionRecovery.snapshot,
        ))
    ) {
      return {
        premiereId,
        reclaimed: false,
        reason: "prediction_resolution_pending",
        pointer: already,
        deletedBulk: false,
      };
    }
    if (pointer === null) {
      const summary = buildPremiereResultSummaryFromDurableEvidence({
        premiereId,
        sourceRunId: record.eligibilityRecord.sourceRunId,
        sourceKind:
          record.eligibilityRecord.sourceKind ?? "controlled_exhibition",
        publicationCommitmentHash: record.expectedPublicationCommitmentHash,
        terminalState: candidate.terminalState,
        revealedAt: candidate.revealedAt,
        reclaimedAt: this.now().toISOString(),
        eligibilityRecord: record.eligibilityRecord,
        authoritativeResultBase64: record.authoritativeResult.bytes,
        interactionState: interactionRecovery?.snapshot ?? null,
        mapLabel: record.publicDefinition.map.label,
        formatLabel: record.publicDefinition.matchFormat.label,
      });
      pointer = await this.store.recordReclaimed(
        summary,
        record.stagedSource.sourceReplaySha256,
      );
    } else {
      const archivedSummary = await this.store.loadSummary(premiereId);
      if (archivedSummary === null) {
        throw reclamationIntegrity("reclamation_archived_summary_missing");
      }
      // A premiere with zero audience writes may have no interaction aggregate
      // at all. The live summary still records both zero-vote checkpoints, so
      // reproduce their terminal option sets for existing-pointer comparison;
      // `null` would incorrectly mean "no checkpoint aggregates available",
      // while the raw initial state still has pre-open empty option arrays.
      const terminalEmptyInteractionState = () => {
        const empty = createReplayPremiereInitialInteractionsSnapshot({
          premiereId,
          checkpointDescriptors: record.publicDefinition.checkpoints,
          seats: record.eligibilityRecord.seats.map((seat) => ({
            seatId: seat.seatId,
            policyIdentity: seat.policyIdentity,
          })),
          getPremiereState: () => candidate.terminalState,
          getReleasedContext: () => null,
          limits: this.interactionLimits,
        });
        const optionSeatIds = record.eligibilityRecord.seats.map(
          (seat) => seat.seatId,
        );
        for (const checkpoint of empty.checkpoints) {
          checkpoint.optionSeatIds = [...optionSeatIds];
          checkpoint.state = "closed";
        }
        return empty;
      };
      const comparisonInteractionState =
        interactionRecovery?.snapshot ??
        ((candidate.terminalState === "revealed" ||
          candidate.terminalState === "archived") &&
        archivedSummary.predictions.length > 0
          ? terminalEmptyInteractionState()
          : null);
      const recoveredSummary = buildPremiereResultSummaryFromDurableEvidence({
        premiereId,
        sourceRunId: record.eligibilityRecord.sourceRunId,
        sourceKind:
          record.eligibilityRecord.sourceKind ?? "controlled_exhibition",
        publicationCommitmentHash: record.expectedPublicationCommitmentHash,
        terminalState: candidate.terminalState,
        revealedAt: candidate.revealedAt,
        reclaimedAt: pointer.reclaimedAt,
        eligibilityRecord: record.eligibilityRecord,
        authoritativeResultBase64: record.authoritativeResult.bytes,
        interactionState: comparisonInteractionState,
        // Optional labels were added after the v1 aggregate shipped. Compare
        // against the archived artifact's schema shape so a legacy pointer
        // without them remains byte-for-byte reproducible, while a newer
        // pointer still validates the current admission labels.
        mapLabel:
          archivedSummary.mapLabel === undefined
            ? undefined
            : record.publicDefinition.map.label,
        formatLabel:
          archivedSummary.formatLabel === undefined
            ? undefined
            : record.publicDefinition.matchFormat.label,
      });
      if (recoveredSummary.summaryHash !== pointer.summaryHash) {
        throw reclamationIntegrity(
          "reclamation_archived_summary_state_diverged",
        );
      }
    }
    await this.promoteDurableClip(premiereId, pointer);
    await this.deleteBulk(premiereId);
    return {
      premiereId,
      reclaimed: true,
      reason: already === null ? "reclaimed" : "already_reclaimed",
      pointer,
      deletedBulk: true,
    };
  }

  /**
   * Deletes the per-premiere-private bulk in the live sweep: the admission entry
   * and both per-premiere event-store snapshots. Every deletion tolerates a
   * prior partial run (ENOENT is a no-op).
   *
   * The SHARED, content-addressed source `.replay` bundle is deliberately NOT
   * deleted here: the loop admits new premieres concurrently with this sweep, so
   * a lock-free reference check could race a concurrent admission that reuses the
   * same-sha source. It is instead reclaimed at startup — under the no-active-
   * writer guarantee, after re-checking it is unreferenced by any surviving
   * admission (see reclaimUnreferencedPremiereSources in
   * ReplayPremiereJournalCompaction). The shared event-journal events for this
   * premiere are compacted in that same startup window.
   */
  private async deleteBulk(premiereId: string): Promise<void> {
    if (!PREMIERE_ID_PATTERN.test(premiereId)) {
      throw reclamationRequest("reclamation_invalid_premiere_id");
    }
    await unlinkIfPresent(
      path.join(this.catalogEntriesDir, `${premiereId}${ADMISSION_SUFFIX}`),
    );
    await unlinkIfPresent(
      path.join(this.snapshotsDir, `${premiereId}.snapshot.json`),
    );
    await unlinkIfPresent(
      path.join(
        this.snapshotsDir,
        `${replayPremiereInteractionAggregateId(premiereId)}.snapshot.json`,
      ),
    );
  }
  /** Promote through the canonical durable archive boundary. */
  private async promoteDurableClip(
    premiereId: string,
    pointer: PremiereArchivePointerV1,
  ): Promise<void> {
    await this.archivedClipPromoter.promotePremiereCache(premiereId, pointer);
  }
}

/**
 * Loads the premiere-reclamation exclusion set from BOTH the
 * `PROXYWAR_PREMIERE_RECLAIM_EXCLUDE` env (comma-separated premiere ids) and an
 * operator pin file `<privateStateRoot>/reclaim-exclude.txt` (one id per line,
 * `#` comments and blank lines ignored). Malformed ids are dropped; a missing
 * pin file is not an error. Excluded premieres are never reclaimed, and their
 * events/source survive startup compaction.
 */
export async function loadReplayPremiereReclamationExclusions(options: {
  privateStateRoot: string;
  env?: Record<string, string | undefined>;
}): Promise<string[]> {
  const excluded = new Set<string>();
  const envValue = (options.env ?? process.env)[
    REPLAY_PREMIERE_RECLAIM_EXCLUDE_ENV
  ];
  if (typeof envValue === "string") {
    for (const raw of envValue.split(",")) {
      const id = raw.trim();
      if (PREMIERE_ID_PATTERN.test(id)) excluded.add(id);
    }
  }
  const pinPath = path.join(
    path.resolve(options.privateStateRoot),
    REPLAY_PREMIERE_RECLAIM_EXCLUDE_FILE,
  );
  try {
    const raw = await fs.readFile(pinPath, "utf8");
    for (const line of raw.split("\n")) {
      const id = line.trim();
      if (id.length === 0 || id.startsWith("#")) continue;
      if (PREMIERE_ID_PATTERN.test(id)) excluded.add(id);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  return [...excluded].sort();
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function reclamationRequest(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    400,
    `Replay premiere reclamation request rejected: ${operatorCode}`,
  );
}

function reclamationIntegrity(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    `Replay premiere reclamation failed integrity validation: ${operatorCode}`,
  );
}
