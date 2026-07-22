import { promises as fs } from "node:fs";
import path from "node:path";
import type { PremiereArchivePointerV1 } from "./ReplayPremiereArchiveIndex";
import { ReplayPremiereArchiveStore } from "./ReplayPremiereArchiveIndex";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import type { ReplayPremiereHttpTarget } from "./ReplayPremiereHttp";
import { replayPremiereInteractionAggregateId } from "./ReplayPremiereInteractionRecovery";
import {
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

export interface ReplayPremiereReclamationEligibility {
  eligible: boolean;
  terminal: boolean;
  terminalState: PremiereResultTerminalState | null;
  revealedAt: string | null;
  reason:
    | "eligible"
    | "excluded"
    | "not_terminal"
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
    | "within_grace"
    | "revealed_time_unavailable";
  pointer: PremiereArchivePointerV1 | null;
  deletedBulk: boolean;
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

  constructor(options: {
    privateStateRoot: string;
    store: ReplayPremiereArchiveStore;
    graceMs?: number;
    now?: () => Date;
    /** Premiere ids that must never be reclaimed (e.g. release-proof premieres). */
    excludedPremiereIds?: Iterable<string>;
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
    if (already === null && !eligibility.eligible) {
      return {
        premiereId,
        reclaimed: false,
        reason:
          eligibility.reason === "eligible"
            ? "not_terminal"
            : eligibility.reason === "not_terminal"
              ? "not_terminal"
              : eligibility.reason,
        pointer: null,
        deletedBulk: false,
      };
    }
    let pointer = already;
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
    }
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
