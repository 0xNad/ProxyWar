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

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const PREMIERE_ID_PATTERN = /^prem_[a-z0-9]{16,32}$/;
const ADMISSION_SUFFIX = ".admission.json";

export interface ReplayPremiereReclamationEligibility {
  eligible: boolean;
  terminal: boolean;
  terminalState: PremiereResultTerminalState | null;
  revealedAt: string | null;
  reason:
    | "eligible"
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
  private readonly sourcesRoot: string;

  constructor(options: {
    privateStateRoot: string;
    store: ReplayPremiereArchiveStore;
    graceMs?: number;
    now?: () => Date;
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
    this.sourcesRoot = path.join(this.privateStateRoot, "sources", "sha256");
  }

  /** Pure eligibility check: terminal AND (post-grace for revealed/archived). */
  eligibility(
    target: ReplayPremiereHttpTarget,
  ): ReplayPremiereReclamationEligibility {
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
      pointer = await this.store.recordReclaimed(summary);
    }
    const sourceReplaySha256 =
      target.runtime.readBootstrap().provenance.sourceReplaySha256;
    await this.deleteBulk(premiereId, sourceReplaySha256);
    return {
      premiereId,
      reclaimed: true,
      reason: already === null ? "reclaimed" : "already_reclaimed",
      pointer,
      deletedBulk: true,
    };
  }

  /**
   * Deletes the admission entry, the staged source bundle (only when no other
   * live admission still references it), and both per-premiere event-store
   * snapshots. Every deletion tolerates a prior partial run (ENOENT is a no-op).
   * The shared event-journal events for this premiere are compacted at the next
   * startup, once the admission is gone — see ReplayPremiereJournalCompaction.
   */
  private async deleteBulk(
    premiereId: string,
    sourceReplaySha256: string,
  ): Promise<void> {
    if (!PREMIERE_ID_PATTERN.test(premiereId)) {
      throw reclamationRequest("reclamation_invalid_premiere_id");
    }
    await unlinkIfPresent(
      path.join(this.catalogEntriesDir, `${premiereId}${ADMISSION_SUFFIX}`),
    );
    if (
      SHA256_HEX_PATTERN.test(sourceReplaySha256) &&
      !(await this.sourceStillReferenced(sourceReplaySha256))
    ) {
      await unlinkIfPresent(
        path.join(
          this.sourcesRoot,
          sourceReplaySha256.slice(0, 2),
          `${sourceReplaySha256}.replay`,
        ),
      );
    }
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

  /**
   * Whether any remaining admission entry references the content-addressed
   * source. The reclaimed premiere's own admission is deleted first, so it is
   * never counted here.
   */
  private async sourceStillReferenced(
    sourceReplaySha256: string,
  ): Promise<boolean> {
    let names: string[];
    try {
      names = await fs.readdir(this.catalogEntriesDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(ADMISSION_SUFFIX)) continue;
      let raw: string;
      try {
        raw = await fs.readFile(
          path.join(this.catalogEntriesDir, name),
          "utf8",
        );
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        // A malformed entry is treated as still referencing nothing here; the
        // catalog reader rejects it separately. Fail closed toward retention.
        return true;
      }
      if (
        isRecord(value) &&
        isRecord(value.stagedSource) &&
        value.stagedSource.sourceReplaySha256 === sourceReplaySha256
      ) {
        return true;
      }
    }
    return false;
  }
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
