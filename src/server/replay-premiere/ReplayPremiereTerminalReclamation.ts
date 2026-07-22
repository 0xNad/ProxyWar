import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { PremiereArchivePointerV1 } from "./ReplayPremiereArchiveIndex";
import { ReplayPremiereArchiveStore } from "./ReplayPremiereArchiveIndex";
import type { ReplayPremiereAdmissionRecordV1 } from "./ReplayPremiereCatalog";
import {
  archivedPremiereClipFileName,
  archivedPremiereClipManifestFileName,
  archivedPremiereClipsDir,
  parsePremiereClipRenderManifest,
  replayPremiereClipCacheDir,
} from "./ReplayPremiereClips";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import type { ReplayPremiereHttpTarget } from "./ReplayPremiereHttp";
import { replayPremiereInteractionAggregateId } from "./ReplayPremiereInteractionRecovery";
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
export const DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIPS = 200;
export const DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIP_BYTES = 1024 ** 3;
const CACHED_CLIP_FILE_PATTERN = /^clip-v[0-9]{1,4}-(0|[1-9][0-9]{0,8})\.mp4$/;

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
  private readonly clipCacheDir: string;
  private readonly archivedClipsDir: string;
  private readonly maxArchivedClips: number;
  private readonly maxArchivedClipBytes: number;
  private readonly logger: (message: string) => void;

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
    /** Operator diagnostics for best-effort clip promotion; never throws out. */
    logger?: (message: string) => void;
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
    this.clipCacheDir = replayPremiereClipCacheDir(this.privateStateRoot);
    this.archivedClipsDir = archivedPremiereClipsDir(this.store.archiveRoot);
    this.maxArchivedClips =
      options.maxArchivedClips ?? DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIPS;
    this.maxArchivedClipBytes =
      options.maxArchivedClipBytes ??
      DEFAULT_REPLAY_PREMIERE_MAX_ARCHIVED_CLIP_BYTES;
    if (
      !Number.isSafeInteger(this.maxArchivedClips) ||
      this.maxArchivedClips < 1 ||
      !Number.isSafeInteger(this.maxArchivedClipBytes) ||
      this.maxArchivedClipBytes < 1
    ) {
      throw reclamationRequest("invalid_archived_clip_bounds");
    }
    this.logger = options.logger ?? (() => undefined);
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
    // Promote the premiere's default clip into the durable archive BEFORE the
    // bulk is deleted (the clip cache is not bulk, but the render SOURCE is
    // startup-GC'd once the pointer exists, so post-reclamation the cached clip
    // is the last renderable copy). Best-effort: promotion failure is logged
    // and never blocks reclamation; the idempotent already-reclaimed retry
    // re-attempts it while the cache copy still exists.
    await this.promoteDurableClip(premiereId, pointer).catch(
      (error: unknown) => {
        this.logger(
          `archived_clip_promotion_failed ${premiereId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
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
    if (pointer === null) {
      const record = candidate.record;
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
        mapLabel: record.publicDefinition.map.label,
        formatLabel: record.publicDefinition.matchFormat.label,
      });
      pointer = await this.store.recordReclaimed(
        summary,
        record.stagedSource.sourceReplaySha256,
      );
    }
    await this.promoteDurableClip(premiereId, pointer).catch(
      (error: unknown) => {
        this.logger(
          `archived_clip_promotion_failed ${premiereId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
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

  /**
   * Copies the premiere's best cached clip (highest anchor turn — the reveal
   * payoff the automatic default render targets) into
   * `archive-v1/clips/<premiereId>.mp4` (+ manifest sidecar), so the durable
   * archived page keeps a downloadable clip after the cache and source are
   * gone.
   *
   * SPOILER GATE: only reveal-public premieres are promoted (`revealedAt`
   * non-null AND terminal revealed|archived) — exactly the condition under
   * which the summary may carry an outcome. Failed/cancelled premieres can
   * never have cached clips (writes are reveal-gated) and are skipped anyway.
   *
   * Idempotent: an existing durable clip is adopted verbatim (first write
   * wins, matching summary adoption). Missing cache is a silent no-op.
   */
  private async promoteDurableClip(
    premiereId: string,
    pointer: PremiereArchivePointerV1,
  ): Promise<void> {
    if (!PREMIERE_ID_PATTERN.test(premiereId)) return;
    if (
      pointer.revealedAt === null ||
      (pointer.terminalState !== "revealed" &&
        pointer.terminalState !== "archived")
    ) {
      return;
    }
    const durableClipPath = path.join(
      this.archivedClipsDir,
      archivedPremiereClipFileName(premiereId),
    );
    if (await fileExists(durableClipPath)) return;
    const candidate = await this.selectBestCachedClip(
      premiereId,
      pointer.sourceReplaySha256,
    );
    if (candidate === null) return;
    await fs.mkdir(this.archivedClipsDir, { recursive: true, mode: 0o700 });
    const durableManifestPath = path.join(
      this.archivedClipsDir,
      archivedPremiereClipManifestFileName(premiereId),
    );
    // Manifest first, mp4 last, both atomic renames: a crash can leave a
    // manifest without an mp4 (harmless — availability is stat(mp4)-based),
    // never a served mp4 without its provenance sidecar.
    await copyFileAtomicVerified(
      candidate.clipPath,
      durableClipPath,
      {
        byteLength: candidate.byteLength,
        sha256: candidate.outSha256,
      },
      () => writeFileAtomic(candidate.manifestRaw, durableManifestPath),
    );
    this.logger(
      `archived_clip_promoted ${premiereId} anchorTurn=${candidate.anchorTurn} bytes=${candidate.byteLength}`,
    );
    await this.evictArchivedClipsOverBounds(premiereId);
  }

  private async selectBestCachedClip(
    premiereId: string,
    expectedSourceReplaySha256: string,
  ): Promise<{
    clipPath: string;
    manifestRaw: string;
    anchorTurn: number;
    byteLength: number;
    outSha256: string;
  } | null> {
    const cacheDir = path.join(this.clipCacheDir, premiereId);
    let files: string[];
    try {
      files = await fs.readdir(cacheDir);
    } catch {
      return null; // No clip cache for this premiere.
    }
    let best: {
      clipPath: string;
      manifestRaw: string;
      anchorTurn: number;
      byteLength: number;
      outSha256: string;
    } | null = null;
    for (const file of files) {
      if (!CACHED_CLIP_FILE_PATTERN.test(file)) continue;
      const clipPath = path.join(cacheDir, file);
      const manifestPath = clipPath.replace(/\.mp4$/, ".render-manifest.json");
      try {
        const [stat, manifestRaw] = await Promise.all([
          fs.stat(clipPath),
          fs.readFile(manifestPath, "utf8"),
        ]);
        const manifest = parsePremiereClipRenderManifest(
          JSON.parse(manifestRaw),
        );
        if (
          manifest === null ||
          manifest.premiereId !== premiereId ||
          manifest.sourceReplaySha256 !== expectedSourceReplaySha256 ||
          !stat.isFile() ||
          manifest.outBytes !== stat.size
        ) {
          continue; // Partial/foreign artifact; never promote it.
        }
        if ((await sha256File(clipPath)) !== manifest.outSha256) {
          continue; // Same-size corruption or swapped content; fail closed.
        }
        if (best === null || manifest.anchorTurn > best.anchorTurn) {
          best = {
            clipPath,
            manifestRaw,
            anchorTurn: manifest.anchorTurn,
            byteLength: stat.size,
            outSha256: manifest.outSha256,
          };
        }
      } catch {
        continue;
      }
    }
    return best;
  }

  /**
   * Applies the archived-clip retention bounds (count and total bytes) with
   * oldest-first eviction by file mtime. The just-promoted premiere's clip is
   * never evicted in its own promotion pass.
   */
  private async evictArchivedClipsOverBounds(
    justPromotedPremiereId: string,
  ): Promise<void> {
    let files: string[];
    try {
      files = await fs.readdir(this.archivedClipsDir);
    } catch {
      return;
    }
    const entries: Array<{
      premiereId: string;
      clipPath: string;
      bytes: number;
      mtimeMs: number;
    }> = [];
    for (const file of files) {
      if (!file.endsWith(".mp4")) continue;
      const premiereId = file.slice(0, -".mp4".length);
      if (!PREMIERE_ID_PATTERN.test(premiereId)) continue;
      const clipPath = path.join(this.archivedClipsDir, file);
      try {
        const stat = await fs.stat(clipPath);
        entries.push({
          premiereId,
          clipPath,
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        continue;
      }
    }
    let count = entries.length;
    let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    if (
      count <= this.maxArchivedClips &&
      totalBytes <= this.maxArchivedClipBytes
    ) {
      return;
    }
    const oldestFirst = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of oldestFirst) {
      if (
        count <= this.maxArchivedClips &&
        totalBytes <= this.maxArchivedClipBytes
      ) {
        break;
      }
      if (entry.premiereId === justPromotedPremiereId) continue;
      await unlinkIfPresent(entry.clipPath).catch(() => undefined);
      await unlinkIfPresent(
        path.join(
          this.archivedClipsDir,
          archivedPremiereClipManifestFileName(entry.premiereId),
        ),
      ).catch(() => undefined);
      count -= 1;
      totalBytes -= entry.bytes;
      this.logger(`archived_clip_evicted ${entry.premiereId} retention`);
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Copies and re-validates a file through a same-directory temp path before the
 * final rename. The validation closes the race between candidate selection and
 * promotion: a cache file swapped after selection can never become durable.
 */
async function copyFileAtomicVerified(
  sourcePath: string,
  destinationPath: string,
  expected: { byteLength: number; sha256: string },
  beforeCommit: () => Promise<void>,
): Promise<void> {
  const temporary = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.copyFile(sourcePath, temporary);
    const stat = await fs.stat(temporary);
    if (
      !stat.isFile() ||
      stat.size !== expected.byteLength ||
      (await sha256File(temporary)) !== expected.sha256
    ) {
      throw reclamationIntegrity("archived_clip_copy_integrity_mismatch");
    }
    await beforeCommit();
    await fs.rename(temporary, destinationPath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Writes a validated manifest snapshot atomically beside the durable clip. */
async function writeFileAtomic(
  contents: string,
  destinationPath: string,
): Promise<void> {
  const temporary = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, contents, { mode: 0o600 });
    await fs.rename(temporary, destinationPath);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
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
