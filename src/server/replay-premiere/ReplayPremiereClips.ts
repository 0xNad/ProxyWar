/**
 * Replay Premiere clip service.
 *
 * Renders and caches short, watermarked, licensed mp4 clips of premiere
 * moments for social sharing. Clips are a CACHE, never event-store evidence:
 * the authoritative index is the disk, rebuilt by scanning the clip store at
 * startup; losing the cache loses nothing but render time.
 *
 * Responsibilities:
 *  - 10-turn anchor bucketing and a `(premiereId, bucket, clipVersion)` cache;
 *  - render admission: per-participant / per-premiere-day / global-hour quotas,
 *    a disk-space floor, and a bounded queue with concurrency 1 and
 *    join-existing-job dedupe;
 *  - spawning + reaping the tsx clip worker with a hard timeout;
 *  - LRU eviction under total-byte and per-premiere caps;
 *  - caption + first-reply composition (license text on the post, url on the
 *    reply);
 *  - reveal-time pre-render of the densest `clip_this` buckets.
 *
 * Lifecycle gating is authoritative here AND at the HTTP layer: writes require
 * `revealed` (archived => 410); reads require `revealed | archived` plus an
 * on-disk artifact; anything else is a fail-closed 404 indistinguishable from a
 * nonexistent premiere.
 */

import express, { type Request, type Response, type Router } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs, type StatsFs } from "node:fs";
import path from "node:path";
import { matchProxyWarPublicPremiereReadPath } from "../agents/ProxyWarPublicArtifacts";
import type { PremiereState } from "./ReplayPremiereContracts";
import {
  isPremiereClipBucket,
  isRenderablePremiereClipBucket,
  PREMIERE_CLIP_VERSION,
  premiereClipBucketForTurn,
  premiereClipRepresentativeAnchorTurn,
  type PremiereClipJobSpec,
  type PremiereClipReady,
  type PremiereClipRenderManifest,
  type PremiereClipSocialText,
  type PremiereClipStatusResponse,
} from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";

// ---------------------------------------------------------------------------
// Tuning (all overridable via ReplayPremiereClipsOptions)
// ---------------------------------------------------------------------------

export interface ReplayPremiereClipLimits {
  /** Distinct render triggers one participant may cause within a premiere. */
  maxRendersPerParticipantPerPremiere: number;
  /** Renders per premiere within a rolling 24h window. */
  maxRendersPerPremierePerDay: number;
  /** Renders across all premieres within a rolling 1h window. */
  maxRendersGlobalPerHour: number;
  /** Waiting jobs (excludes the one running). */
  maxQueueDepth: number;
  /** Wall-clock ceiling for a single render before SIGKILL. */
  jobTimeoutMs: number;
  /** Total bytes across all cached clips before global LRU eviction. */
  maxTotalBytes: number;
  /** Cached clips per premiere before per-premiere LRU eviction. */
  maxClipsPerPremiere: number;
  /** Free-space floor on the clip volume before a render is admitted. */
  minFreeBytes: number;
  /** Buckets pre-rendered at reveal from the densest clip_this reactions. */
  prerenderTopBuckets: number;
}

const DEFAULT_LIMITS: ReplayPremiereClipLimits = {
  maxRendersPerParticipantPerPremiere: 3,
  maxRendersPerPremierePerDay: 30,
  maxRendersGlobalPerHour: 12,
  maxQueueDepth: 4,
  jobTimeoutMs: 6 * 60 * 1_000,
  maxTotalBytes: 2 * 1024 ** 3,
  maxClipsPerPremiere: 40,
  minFreeBytes: 16 * 1024 ** 3,
  prerenderTopBuckets: 3,
};

/** Storage-guard severities, ordered; a render is refused at `critical`+. */
const WATERMARK_SEVERITY: Record<string, number> = {
  healthy: 0,
  warning: 1,
  critical: 2,
  hardstop: 3,
  hard_stop: 3,
};

export interface ReplayPremiereClipReactionSample {
  kind: string;
  sequence: number;
  turn: number;
}

export interface ReplayPremiereClipRenderRequest {
  premiereId: string;
  /** Current lifecycle; gating is enforced here as well as at the HTTP layer. */
  lifecycleState: PremiereState;
  anchorTurn: number;
  /** null for system/pre-render jobs (skips the per-participant quota). */
  participantId: string | null;
  sourceReplaySha256: string;
}

export interface ReplayPremiereClipReadRequest {
  premiereId: string;
  lifecycleState: PremiereState;
  bucket: number;
}

export interface ReplayPremiereClipFile {
  filePath: string;
  byteLength: number;
  sha256: string;
}

type SpawnClipWorker = (
  jobSpecPath: string,
  env: NodeJS.ProcessEnv,
) => ChildProcess;

export interface ReplayPremiereClipsOptions {
  /** Root the cache lives under: `<root>/<premiereId>/clip-v1-<bucket>.mp4`. */
  clipsRoot: string;
  /** Root the content-addressed source bundles live under (`sources/...`). */
  sourceBundleRoot: string;
  /** Built client the worker serves over loopback. */
  staticDir: string;
  /** Absolute path to `src/scripts/replay-premiere-clip-worker.ts`. */
  workerModulePath: string;
  publicOrigin: string;
  /** Exact license lines (from resources/lang/en.json), used in captions. */
  licenseStrings: { attribution: string; noEndorsement: string };
  /** Storage-guard state file; the watermark is read from here. */
  storageStatePath: string;
  clipFfmpegBin?: string;
  clipChromeBin?: string;
  scratchDir?: string;
  limits?: Partial<ReplayPremiereClipLimits>;
  now?: () => number;
  statfs?: (path: string) => Promise<StatsFs>;
  spawnWorker?: SpawnClipWorker;
  logger?: (message: string) => void;
}

interface ClipIndexEntry {
  premiereId: string;
  bucket: number;
  clipVersion: number;
  anchorTurn: number;
  filePath: string;
  byteLength: number;
  sha256: string;
  createdMs: number;
  lastAccessMs: number;
}

interface QueuedJob {
  key: string;
  premiereId: string;
  bucket: number;
  anchorTurn: number;
  bundlePath: string;
  expectedBundleSha256: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ReplayPremiereClips {
  private readonly limits: ReplayPremiereClipLimits;
  private readonly now: () => number;
  private readonly statfs: (path: string) => Promise<StatsFs>;
  private readonly spawnWorker: SpawnClipWorker;
  private readonly logger: (message: string) => void;

  private readonly ready = new Map<string, ClipIndexEntry>();
  private readonly queue: QueuedJob[] = [];
  private readonly pending = new Set<string>();
  /** Reserved synchronously in pump() so concurrency stays 1 across awaits. */
  private runningJob: QueuedJob | null = null;
  private runningChild: ChildProcess | null = null;
  private closed = false;

  // Quota accounting (accepted NEW renders only; not cache hits or joins).
  private readonly participantRenders = new Map<string, number>();
  private readonly premiereRenderTimes = new Map<string, number[]>();
  private globalRenderTimes: number[] = [];

  constructor(private readonly options: ReplayPremiereClipsOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
    this.now = options.now ?? (() => Date.now());
    this.statfs = options.statfs ?? ((p) => fs.statfs(p));
    this.spawnWorker =
      options.spawnWorker ?? this.defaultSpawnWorker.bind(this);
    this.logger = options.logger ?? (() => undefined);
  }

  // -- Cache index ---------------------------------------------------------

  /**
   * Rebuild the in-memory index by scanning the clip store. Directory names are
   * premiere ids; files are `clip-v1-<bucket>.mp4` with a
   * `clip-v1-<bucket>.render-manifest.json` sidecar. A clip without a valid
   * sidecar (size/sha mismatch) is ignored (not deleted — the disk is truth,
   * but a partial write must not be served).
   */
  async rebuildIndex(): Promise<void> {
    this.ready.clear();
    let premiereDirs: string[];
    try {
      premiereDirs = await fs.readdir(this.options.clipsRoot);
    } catch {
      return; // No clip store yet.
    }
    for (const premiereId of premiereDirs) {
      const dir = path.join(this.options.clipsRoot, premiereId);
      let files: string[];
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        const bucket = parseClipFileName(file);
        if (bucket === null) continue;
        const filePath = path.join(dir, file);
        const manifestPath = sidecarPath(filePath);
        const entry = await this.loadIndexEntry(
          premiereId,
          bucket,
          filePath,
          manifestPath,
        );
        if (entry !== null) this.ready.set(cacheKey(premiereId, bucket), entry);
      }
    }
    this.logger(`clip index rebuilt: ${this.ready.size} cached`);
  }

  private async loadIndexEntry(
    premiereId: string,
    bucket: number,
    filePath: string,
    manifestPath: string,
  ): Promise<ClipIndexEntry | null> {
    try {
      const [stat, manifestRaw] = await Promise.all([
        fs.stat(filePath),
        fs.readFile(manifestPath, "utf8"),
      ]);
      const manifest = parseRenderManifest(JSON.parse(manifestRaw));
      if (manifest === null) return null;
      if (
        manifest.premiereId !== premiereId ||
        manifest.clipVersion !== PREMIERE_CLIP_VERSION ||
        manifest.outBytes !== stat.size
      ) {
        return null;
      }
      return {
        premiereId,
        bucket,
        clipVersion: PREMIERE_CLIP_VERSION,
        anchorTurn: manifest.anchorTurn,
        filePath,
        byteLength: stat.size,
        sha256: manifest.outSha256,
        createdMs: Date.parse(manifest.generatedAt) || stat.mtimeMs,
        lastAccessMs: stat.mtimeMs,
      };
    } catch {
      return null;
    }
  }

  // -- Reads ---------------------------------------------------------------

  /** Public status for a bucket. Gating: reads require revealed | archived. */
  readStatus(
    request: ReplayPremiereClipReadRequest,
  ): PremiereClipStatusResponse {
    const base: PremiereClipStatusResponse = {
      schemaVersion: 1,
      premiereId: request.premiereId,
      bucket: request.bucket,
      clipVersion: PREMIERE_CLIP_VERSION,
      state: "absent",
      ready: null,
    };
    if (!this.readsAllowed(request.lifecycleState)) return base;
    if (!isPremiereClipBucket(request.bucket)) return base;
    const key = cacheKey(request.premiereId, request.bucket);
    const entry = this.ready.get(key);
    if (entry !== undefined) {
      entry.lastAccessMs = this.now();
      return { ...base, state: "ready", ready: this.toReady(entry) };
    }
    if (this.pending.has(key)) return { ...base, state: "pending" };
    return base;
  }

  /**
   * Resolve the on-disk file for the mp4 route. Returns null (=> 404) unless
   * the premiere is revealed | archived AND a cached artifact exists on disk.
   */
  async resolveReadyClip(
    request: ReplayPremiereClipReadRequest,
  ): Promise<ReplayPremiereClipFile | null> {
    if (!this.readsAllowed(request.lifecycleState)) return null;
    if (!isPremiereClipBucket(request.bucket)) return null;
    const entry = this.ready.get(cacheKey(request.premiereId, request.bucket));
    if (entry === undefined) return null;
    try {
      const stat = await fs.stat(entry.filePath);
      if (stat.size !== entry.byteLength) return null;
    } catch {
      // The index outran the disk (evicted/removed); fail closed.
      this.ready.delete(cacheKey(request.premiereId, request.bucket));
      return null;
    }
    entry.lastAccessMs = this.now();
    return {
      filePath: entry.filePath,
      byteLength: entry.byteLength,
      sha256: entry.sha256,
    };
  }

  // -- Render admission ----------------------------------------------------

  /**
   * Admit a render request. Enforces lifecycle gating, then (for a cache miss)
   * quotas, disk floor, and the bounded queue. Cache hits and joins to an
   * in-flight job never consume quota.
   */
  async requestClip(
    request: ReplayPremiereClipRenderRequest,
  ): Promise<PremiereClipStatusResponse> {
    this.assertWritesAllowed(request.lifecycleState);
    if (!Number.isSafeInteger(request.anchorTurn) || request.anchorTurn < 0) {
      throw invalid("clip_anchor_turn_invalid", 400);
    }
    const bucket = premiereClipBucketForTurn(request.anchorTurn);
    if (!isRenderablePremiereClipBucket(bucket)) {
      throw invalid("clip_anchor_too_early", 400);
    }
    const key = cacheKey(request.premiereId, bucket);

    const existing = this.ready.get(key);
    if (existing !== undefined) {
      existing.lastAccessMs = this.now();
      return this.statusFor(request.premiereId, bucket, "ready", existing);
    }
    if (this.pending.has(key)) {
      // Join the in-flight job; no new quota is consumed.
      return this.statusFor(request.premiereId, bucket, "pending", null);
    }

    this.admitNewRender(request.premiereId, request.participantId);
    await this.assertDiskFloor();
    if (this.queue.length >= this.limits.maxQueueDepth) {
      throw capacity("clip_queue_full", 429);
    }

    this.recordRender(request.premiereId, request.participantId);
    this.pending.add(key);
    this.queue.push({
      key,
      premiereId: request.premiereId,
      bucket,
      anchorTurn: premiereClipRepresentativeAnchorTurn(bucket),
      bundlePath: this.sourceBundlePath(request.sourceReplaySha256),
      expectedBundleSha256: request.sourceReplaySha256.toLowerCase(),
    });
    this.pump();
    return this.statusFor(request.premiereId, bucket, "pending", null);
  }

  /**
   * Reveal-time pre-render: select the densest `clip_this` buckets from a
   * reactions snapshot and enqueue them as system jobs (no participant, so the
   * per-participant quota is skipped; per-premiere/day and global/hour still
   * apply). Best-effort — a refused enqueue is swallowed.
   */
  async prerenderTopReactionBuckets(options: {
    premiereId: string;
    lifecycleState: PremiereState;
    reactions: readonly ReplayPremiereClipReactionSample[];
    sourceReplaySha256: string;
  }): Promise<number[]> {
    const buckets = selectPrerenderBuckets(
      options.reactions,
      this.limits.prerenderTopBuckets,
    );
    const enqueued: number[] = [];
    for (const bucket of buckets) {
      try {
        const status = await this.requestClip({
          premiereId: options.premiereId,
          lifecycleState: options.lifecycleState,
          anchorTurn: premiereClipRepresentativeAnchorTurn(bucket),
          participantId: null,
          sourceReplaySha256: options.sourceReplaySha256,
        });
        if (status.state !== "absent") enqueued.push(bucket);
      } catch {
        // Pre-render is opportunistic; refusal (quota/disk) is expected.
      }
    }
    return enqueued;
  }

  // -- Queue / worker ------------------------------------------------------

  private pump(): void {
    if (this.closed || this.runningJob !== null) return;
    const job = this.queue.shift();
    if (job === undefined) return;
    // Reserve the single slot synchronously (runJob awaits before it spawns).
    this.runningJob = job;
    void this.runJob(job);
  }

  private async runJob(job: QueuedJob): Promise<void> {
    const renderDir = path.join(
      this.options.clipsRoot,
      job.premiereId,
      `.render-${job.bucket}-${randomToken()}`,
    );
    let timedOut = false;
    try {
      await fs.mkdir(renderDir, { recursive: true, mode: 0o700 });
      const specPath = path.join(renderDir, "jobspec.json");
      const spec: PremiereClipJobSpec = {
        premiereId: job.premiereId,
        bundlePath: job.bundlePath,
        expectedBundleSha256: job.expectedBundleSha256,
        anchorTurn: job.anchorTurn,
        clipVersion: PREMIERE_CLIP_VERSION,
        outDir: renderDir,
        staticDir: this.options.staticDir,
        captureMode: "screencast",
        frameShape: "square",
        cameraFit: "fill",
      };
      await fs.writeFile(specPath, JSON.stringify(spec));

      const env: NodeJS.ProcessEnv = { ...process.env };
      if (this.options.scratchDir !== undefined) {
        env.PROXYWAR_CLIP_SCRATCH_DIR = this.options.scratchDir;
      }
      if (this.options.clipFfmpegBin !== undefined) {
        env.PROXYWAR_CLIP_FFMPEG_BIN = this.options.clipFfmpegBin;
      }
      if (this.options.clipChromeBin !== undefined) {
        env.PROXYWAR_CLIP_CHROME_BIN = this.options.clipChromeBin;
      }
      const child = this.spawnWorker(specPath, env);
      this.runningChild = child;

      const exitCode = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, this.limits.jobTimeoutMs);
        timer.unref?.();
        child.once("error", () => {
          clearTimeout(timer);
          resolve(null);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });

      if (timedOut || exitCode !== 0) {
        this.logger(
          `clip render failed premiere=${job.premiereId} bucket=${job.bucket} ` +
            `${timedOut ? "timeout" : `exit=${exitCode}`}`,
        );
      } else {
        await this.promoteRender(job, renderDir);
      }
    } catch (error) {
      this.logger(
        `clip render error premiere=${job.premiereId} bucket=${job.bucket}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      await fs.rm(renderDir, { recursive: true, force: true }).catch(() => {});
      this.pending.delete(job.key);
      this.runningJob = null;
      this.runningChild = null;
      if (!this.closed) this.pump();
    }
  }

  /** Move a completed render into the cache under its canonical name. */
  private async promoteRender(
    job: QueuedJob,
    renderDir: string,
  ): Promise<void> {
    const producedClip = path.join(renderDir, "clip.mp4");
    const producedManifest = path.join(renderDir, "render-manifest.json");
    const stat = await fs.stat(producedClip);
    const manifest = parseRenderManifest(
      JSON.parse(await fs.readFile(producedManifest, "utf8")),
    );
    if (manifest === null || manifest.outBytes !== stat.size) {
      throw new Error("clip render produced an invalid manifest");
    }
    const finalDir = path.join(this.options.clipsRoot, job.premiereId);
    await fs.mkdir(finalDir, { recursive: true, mode: 0o700 });
    const finalClip = path.join(finalDir, clipFileName(job.bucket));
    const finalManifest = sidecarPath(finalClip);
    await fs.rename(producedClip, finalClip);
    await fs.rename(producedManifest, finalManifest);

    const nowMs = this.now();
    this.ready.set(cacheKey(job.premiereId, job.bucket), {
      premiereId: job.premiereId,
      bucket: job.bucket,
      clipVersion: PREMIERE_CLIP_VERSION,
      anchorTurn: manifest.anchorTurn,
      filePath: finalClip,
      byteLength: stat.size,
      sha256: manifest.outSha256,
      createdMs: nowMs,
      lastAccessMs: nowMs,
    });
    await this.evict();
  }

  // -- LRU eviction --------------------------------------------------------

  private async evict(): Promise<void> {
    // Per-premiere cap first (bounded fan-out inside one match).
    const byPremiere = new Map<string, ClipIndexEntry[]>();
    for (const entry of this.ready.values()) {
      const list = byPremiere.get(entry.premiereId) ?? [];
      list.push(entry);
      byPremiere.set(entry.premiereId, list);
    }
    for (const list of byPremiere.values()) {
      if (list.length <= this.limits.maxClipsPerPremiere) continue;
      const ordered = [...list].sort((a, b) => a.lastAccessMs - b.lastAccessMs);
      for (const entry of ordered.slice(
        0,
        list.length - this.limits.maxClipsPerPremiere,
      )) {
        await this.removeEntry(entry);
      }
    }
    // Global byte cap next.
    let total = 0;
    for (const entry of this.ready.values()) total += entry.byteLength;
    if (total <= this.limits.maxTotalBytes) return;
    const ordered = [...this.ready.values()].sort(
      (a, b) => a.lastAccessMs - b.lastAccessMs,
    );
    for (const entry of ordered) {
      if (total <= this.limits.maxTotalBytes) break;
      total -= entry.byteLength;
      await this.removeEntry(entry);
    }
  }

  private async removeEntry(entry: ClipIndexEntry): Promise<void> {
    this.ready.delete(cacheKey(entry.premiereId, entry.bucket));
    await fs.rm(entry.filePath, { force: true }).catch(() => {});
    await fs.rm(sidecarPath(entry.filePath), { force: true }).catch(() => {});
  }

  // -- Quotas / disk -------------------------------------------------------

  private admitNewRender(
    premiereId: string,
    participantId: string | null,
  ): void {
    const nowMs = this.now();
    if (participantId !== null) {
      const count =
        this.participantRenders.get(
          participantKey(premiereId, participantId),
        ) ?? 0;
      if (count >= this.limits.maxRendersPerParticipantPerPremiere) {
        throw capacity("clip_participant_quota_exceeded", 429);
      }
    }
    const perPremiere = prune(
      this.premiereRenderTimes.get(premiereId) ?? [],
      nowMs - 24 * 60 * 60 * 1_000,
    );
    if (perPremiere.length >= this.limits.maxRendersPerPremierePerDay) {
      throw capacity("clip_premiere_daily_quota_exceeded", 429);
    }
    this.globalRenderTimes = prune(
      this.globalRenderTimes,
      nowMs - 60 * 60 * 1_000,
    );
    if (this.globalRenderTimes.length >= this.limits.maxRendersGlobalPerHour) {
      throw capacity("clip_global_hourly_quota_exceeded", 429);
    }
  }

  private recordRender(premiereId: string, participantId: string | null): void {
    const nowMs = this.now();
    if (participantId !== null) {
      const pKey = participantKey(premiereId, participantId);
      this.participantRenders.set(
        pKey,
        (this.participantRenders.get(pKey) ?? 0) + 1,
      );
    }
    const perPremiere = prune(
      this.premiereRenderTimes.get(premiereId) ?? [],
      nowMs - 24 * 60 * 60 * 1_000,
    );
    perPremiere.push(nowMs);
    this.premiereRenderTimes.set(premiereId, perPremiere);
    this.globalRenderTimes = prune(
      this.globalRenderTimes,
      nowMs - 60 * 60 * 1_000,
    );
    this.globalRenderTimes.push(nowMs);
  }

  private async assertDiskFloor(): Promise<void> {
    const watermark = await this.readWatermarkSeverity();
    if (watermark >= WATERMARK_SEVERITY.critical) {
      throw unavailable("clip_storage_watermark_critical", 503);
    }
    try {
      const stats = await this.statfs(this.options.clipsRoot);
      const free = Number(stats.bavail) * Number(stats.bsize);
      if (!Number.isFinite(free) || free < this.limits.minFreeBytes) {
        throw unavailable("clip_disk_floor_not_met", 503);
      }
    } catch (error) {
      if (error instanceof ReplayPremiereError) throw error;
      throw unavailable("clip_disk_floor_unreadable", 503);
    }
  }

  private async readWatermarkSeverity(): Promise<number> {
    try {
      const raw = JSON.parse(
        await fs.readFile(this.options.storageStatePath, "utf8"),
      ) as { watermark?: unknown };
      if (typeof raw.watermark !== "string") return 0;
      return WATERMARK_SEVERITY[raw.watermark] ?? 0;
    } catch {
      // Missing/unreadable state file: rely on the free-space floor only.
      return 0;
    }
  }

  // -- Composition helpers -------------------------------------------------

  private toReady(entry: ClipIndexEntry): PremiereClipReady {
    return {
      clipUrl: clipFileRoute(entry.premiereId, entry.bucket),
      byteLength: entry.byteLength,
      sha256: entry.sha256,
      anchorTurn: entry.anchorTurn,
      social: composePremiereClipSocialText({
        attribution: this.options.licenseStrings.attribution,
        noEndorsement: this.options.licenseStrings.noEndorsement,
        watchUrl: this.premiereWatchUrl(entry.premiereId),
        anchorTurn: entry.anchorTurn,
      }),
    };
  }

  private statusFor(
    premiereId: string,
    bucket: number,
    state: "ready" | "pending",
    entry: ClipIndexEntry | null,
  ): PremiereClipStatusResponse {
    return {
      schemaVersion: 1,
      premiereId,
      bucket,
      clipVersion: PREMIERE_CLIP_VERSION,
      state,
      ready: entry === null ? null : this.toReady(entry),
    };
  }

  private premiereWatchUrl(premiereId: string): string {
    return `${this.options.publicOrigin.replace(/\/$/, "")}/premiere/${premiereId}`;
  }

  private sourceBundlePath(sha256: string): string {
    const hash = sha256.toLowerCase();
    return path.join(
      this.options.sourceBundleRoot,
      "sources",
      "sha256",
      hash.slice(0, 2),
      `${hash}.replay`,
    );
  }

  // -- Gating --------------------------------------------------------------

  private readsAllowed(state: PremiereState): boolean {
    return state === "revealed" || state === "archived";
  }

  private assertWritesAllowed(state: PremiereState): void {
    if (state === "archived") throw invalid("clip_write_archived", 410);
    // Fail closed for every pre-reveal state: a 404 indistinguishable from a
    // nonexistent premiere, so no clip route reveals a premiere before reveal.
    if (state !== "revealed")
      throw unavailable("clip_premiere_unavailable", 404);
  }

  // -- Worker spawn --------------------------------------------------------

  private defaultSpawnWorker(
    jobSpecPath: string,
    env: NodeJS.ProcessEnv,
  ): ChildProcess {
    // Run the .ts worker through the tsx loader on the current Node. Injectable
    // for tests; the live server does not spawn until a real request arrives.
    return spawn(
      process.execPath,
      ["--import", "tsx", this.options.workerModulePath, jobSpecPath],
      { stdio: ["ignore", "ignore", "pipe"], env },
    );
  }

  // -- Shutdown ------------------------------------------------------------

  async close(): Promise<void> {
    this.closed = true;
    this.queue.length = 0;
    const child = this.runningChild;
    if (child !== null && child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Select up to `topN` buckets with the most `clip_this` reactions. Ties break
 * toward the earlier bucket for determinism; buckets too early to render are
 * dropped.
 */
export function selectPrerenderBuckets(
  reactions: readonly ReplayPremiereClipReactionSample[],
  topN: number,
): number[] {
  const density = new Map<number, number>();
  for (const reaction of reactions) {
    if (reaction.kind !== "clip_this") continue;
    if (!Number.isSafeInteger(reaction.turn) || reaction.turn < 0) continue;
    const bucket = premiereClipBucketForTurn(reaction.turn);
    if (!isRenderablePremiereClipBucket(bucket)) continue;
    density.set(bucket, (density.get(bucket) ?? 0) + 1);
  }
  return [...density.entries()]
    .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] - b[0]))
    .slice(0, Math.max(0, topN))
    .map(([bucket]) => bucket);
}

/**
 * Compose the share text. The caption carries BOTH exact license lines and NO
 * url (the CC BY-SA attribution + no-endorsement must ride on the post itself);
 * the watch url lives only in the first reply.
 */
export function composePremiereClipSocialText(options: {
  attribution: string;
  noEndorsement: string;
  watchUrl: string;
  anchorTurn: number;
}): PremiereClipSocialText {
  const caption = [
    "AI agents, no humans — a Proxy War league premiere moment.",
    "",
    options.attribution,
    options.noEndorsement,
  ].join("\n");
  const firstReply = `Watch the full premiere: ${options.watchUrl}`;
  return { caption, firstReply };
}

export function clipFileName(bucket: number): string {
  return `clip-v${PREMIERE_CLIP_VERSION}-${bucket}.mp4`;
}

export function clipFileRoute(premiereId: string, bucket: number): string {
  return `/premiere/${premiereId}/clip-v${PREMIERE_CLIP_VERSION}-${bucket}.mp4`;
}

/** Canonical clip-cache root under a premiere private state root. */
export function replayPremiereClipCacheDir(privateStateRoot: string): string {
  return path.join(privateStateRoot, "clips-v1");
}

/** Exported for the reclamation-time durable-clip promotion. */
export function parsePremiereClipRenderManifest(
  value: unknown,
): PremiereClipRenderManifest | null {
  return parseRenderManifest(value);
}

// ---------------------------------------------------------------------------
// Durable archived clip (survives terminal reclamation)
// ---------------------------------------------------------------------------

/**
 * Directory under the archive root (`archive-v1/`) holding the ONE durable clip
 * a premiere keeps after reclamation deletes its bulk. Unlike `clips-v1` (a
 * pure cache — losing it costs render time), these files are the only clip a
 * reclaimed premiere can ever have: the render source is garbage-collected at
 * the next startup, so an archived clip can never be re-rendered.
 */
export const REPLAY_PREMIERE_ARCHIVE_CLIPS_DIRECTORY = "clips";

export function archivedPremiereClipsDir(archiveRoot: string): string {
  return path.join(archiveRoot, REPLAY_PREMIERE_ARCHIVE_CLIPS_DIRECTORY);
}

export function archivedPremiereClipFileName(premiereId: string): string {
  return `${premiereId}.mp4`;
}

export function archivedPremiereClipManifestFileName(
  premiereId: string,
): string {
  return `${premiereId}.render-manifest.json`;
}

/** Public route the archive router serves the durable clip under. */
export function archivedPremiereClipRoute(premiereId: string): string {
  return `/premiere/${premiereId}/clip.mp4`;
}

// ---------------------------------------------------------------------------
// Reveal-time automatic default clip
// ---------------------------------------------------------------------------

/** Minimal structural view of a registered premiere runtime (no import cycle). */
export interface ReplayPremiereAutoClipRuntimeReader {
  readLifecycleState(): PremiereState;
  readReveal(): {
    sourceReplaySha256: string;
    finalSequence: number;
  } | null;
  readReleasedContext(sequence: number): { turn: number } | null;
}

export interface ReplayPremiereRevealAutoClipOptions {
  clips: ReplayPremiereClips;
  /** null => the premiere is no longer registered (renders are impossible). */
  resolveRuntime: (
    premiereId: string,
  ) => ReplayPremiereAutoClipRuntimeReader | null;
  /** Delay between the render request and its outcome verification. */
  verifyDelayMs?: number;
  /** Bounded verification polls while the render is still in flight. */
  maxVerifyPolls?: number;
  logger?: (message: string) => void;
}

const DEFAULT_AUTO_CLIP_VERIFY_DELAY_MS = 60_000;
const DEFAULT_AUTO_CLIP_MAX_VERIFY_POLLS = 10;

/**
 * Schedules the DEFAULT social clip automatically when a premiere reveals, so
 * the durable clip exists without anyone clicking render inside the short
 * revealed window. Bounded and best-effort by design:
 *
 *  - exactly ONE render request per premiere per process, plus ONE retry if
 *    that render is later observed absent (refused or failed);
 *  - system job (`participantId: null`) — the per-premiere-day and global-hour
 *    quotas still apply, so a hostile stream of reveals cannot melt the host;
 *  - the anchor is the final released moment (what is on screen at reveal),
 *    i.e. the same clip the manual button makes at the reveal payoff;
 *  - failures are logged and abandoned. This class never throws into the
 *    reveal path and never blocks reveal or reclamation.
 */
export class ReplayPremiereRevealAutoClip {
  private readonly requestedRenders = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly verifyDelayMs: number;
  private readonly maxVerifyPolls: number;
  private readonly logger: (message: string) => void;
  private closed = false;

  constructor(private readonly options: ReplayPremiereRevealAutoClipOptions) {
    this.verifyDelayMs =
      options.verifyDelayMs ?? DEFAULT_AUTO_CLIP_VERIFY_DELAY_MS;
    this.maxVerifyPolls =
      options.maxVerifyPolls ?? DEFAULT_AUTO_CLIP_MAX_VERIFY_POLLS;
    this.logger = options.logger ?? (() => undefined);
  }

  /**
   * Observer entry point. Safe to call repeatedly (registration-time and
   * transition-time observations both funnel here); only the first call for a
   * premiere that resolves a render anchor schedules work. A spurious call
   * (not registered / not revealed) never latches the dedupe, so a later real
   * reveal observation still works.
   */
  onPremiereRevealed(premiereId: string): void {
    if (this.closed || this.requestedRenders.has(premiereId)) return;
    // Resolve synchronously so two rapid observations cannot double-schedule.
    const anchor = this.resolveDefaultAnchor(premiereId);
    if (anchor === null) return;
    this.requestedRenders.set(premiereId, 0);
    void this.attemptRender(premiereId, 1).catch((error: unknown) => {
      this.log(premiereId, `auto clip attempt crashed: ${message(error)}`);
    });
  }

  /** Renders requested for a premiere (test/diagnostic surface). */
  requestedRenderCount(premiereId: string): number {
    return this.requestedRenders.get(premiereId) ?? 0;
  }

  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private async attemptRender(
    premiereId: string,
    attempt: 1 | 2,
  ): Promise<void> {
    if (this.closed) return;
    const anchor = this.resolveDefaultAnchor(premiereId);
    if (anchor === null) return;
    this.requestedRenders.set(
      premiereId,
      (this.requestedRenders.get(premiereId) ?? 0) + 1,
    );
    let state: PremiereClipStatusResponse["state"] | "refused" = "refused";
    try {
      const status = await this.options.clips.requestClip({
        premiereId,
        lifecycleState: "revealed",
        anchorTurn: anchor.turn,
        participantId: null,
        sourceReplaySha256: anchor.sourceReplaySha256,
      });
      state = status.state;
    } catch (error) {
      this.log(
        premiereId,
        `auto clip render request refused (attempt ${attempt}): ${message(error)}`,
      );
    }
    if (state === "ready") {
      this.log(premiereId, "auto clip already cached");
      return;
    }
    // Verify the outcome later; a first attempt that was refused outright also
    // goes through verification so transient refusals (queue full, disk floor
    // probe) get the single retry. The retry gets one more verification pass
    // purely for the definitive outcome log — it can never render again (the
    // per-premiere render count is already at the cap).
    if (attempt === 1) {
      this.scheduleVerify(premiereId, anchor.turn, this.maxVerifyPolls);
    } else if (state === "pending") {
      this.log(premiereId, "auto clip retry enqueued");
      this.scheduleVerify(premiereId, anchor.turn, this.maxVerifyPolls);
    } else {
      this.log(premiereId, "auto clip retry refused; giving up");
    }
  }

  private scheduleVerify(
    premiereId: string,
    anchorTurn: number,
    pollsLeft: number,
  ): void {
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.timers.delete(premiereId);
      try {
        this.verify(premiereId, anchorTurn, pollsLeft - 1);
      } catch (error) {
        this.log(premiereId, `auto clip verify crashed: ${message(error)}`);
      }
    }, this.verifyDelayMs);
    timer.unref?.();
    this.timers.set(premiereId, timer);
  }

  private verify(
    premiereId: string,
    anchorTurn: number,
    pollsLeft: number,
  ): void {
    if (this.closed) return;
    const runtime = this.options.resolveRuntime(premiereId);
    if (runtime === null) {
      // De-registered (reclaimed) before the render settled; nothing to do.
      this.log(premiereId, "auto clip verify: premiere de-registered");
      return;
    }
    const status = this.options.clips.readStatus({
      premiereId,
      lifecycleState: runtime.readLifecycleState(),
      bucket: premiereClipBucketForTurn(anchorTurn),
    });
    if (status.state === "ready") {
      this.log(premiereId, "auto clip ready");
      return;
    }
    if (status.state === "pending") {
      if (pollsLeft > 0) {
        this.scheduleVerify(premiereId, anchorTurn, pollsLeft);
      } else {
        this.log(premiereId, "auto clip verification budget exhausted");
      }
      return;
    }
    // Absent: the render was refused or failed. Exactly one retry.
    if ((this.requestedRenders.get(premiereId) ?? 0) >= 2) {
      this.log(premiereId, "auto clip absent after retry; giving up");
      return;
    }
    this.log(premiereId, "auto clip absent; retrying once");
    void this.attemptRender(premiereId, 2).catch((error: unknown) => {
      this.log(premiereId, `auto clip retry crashed: ${message(error)}`);
    });
  }

  private resolveDefaultAnchor(
    premiereId: string,
  ): { turn: number; sourceReplaySha256: string } | null {
    const runtime = this.options.resolveRuntime(premiereId);
    if (runtime === null) return null;
    if (runtime.readLifecycleState() !== "revealed") return null;
    const reveal = runtime.readReveal();
    if (reveal === null) return null;
    const context = runtime.readReleasedContext(reveal.finalSequence);
    if (context === null) {
      this.log(premiereId, "auto clip anchor unavailable (final context)");
      return null;
    }
    return {
      turn: context.turn,
      sourceReplaySha256: reveal.sourceReplaySha256,
    };
  }

  private log(premiereId: string, text: string): void {
    this.logger(`${premiereId}: ${text}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// mp4 document router (mounted alongside the public page router)
// ---------------------------------------------------------------------------

export interface ReplayPremiereClipLifecycleReader {
  readLifecycleState(): PremiereState;
}

export interface ReplayPremiereClipDocumentRouterOptions {
  clips: ReplayPremiereClips;
  /** null => the premiere id is unregistered (indistinguishable 404). */
  resolveLifecycle: (
    premiereId: string,
  ) => ReplayPremiereClipLifecycleReader | null;
  onOperatorError?: (error: unknown) => void;
}

/**
 * Serves `GET|HEAD /premiere/<id>/clip-v1-<bucket>.mp4`. Fails closed with a
 * bare 404 for unknown ids, pre-reveal premieres, and revealed|archived
 * premieres with no cached artifact — never distinguishing them. Passes every
 * other path through with `next()`.
 */
export function createReplayPremiereClipDocumentRouter(
  options: ReplayPremiereClipDocumentRouterOptions,
): Router {
  const router = express.Router();
  router.use((request, response, next) => {
    const route = matchProxyWarPublicPremiereReadPath(request.path);
    if (route?.kind !== "clip_file") {
      next();
      return;
    }
    void handleClipFileRequest(request, response, route, options).catch(
      (error: unknown) => {
        try {
          options.onOperatorError?.(error);
        } catch {
          // Operator diagnostics never replace the fixed public response.
        }
        if (!response.headersSent) {
          sendClipDocumentFailure(response, 404);
        } else {
          response.destroy();
        }
      },
    );
  });
  return router;
}

async function handleClipFileRequest(
  request: Request,
  response: Response,
  route: { premiereId: string; bucket: number },
  options: ReplayPremiereClipDocumentRouterOptions,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendClipDocumentFailure(response, 405);
    return;
  }
  if (request.headers.range !== undefined) {
    sendClipDocumentFailure(response, 416);
    return;
  }
  const reader = options.resolveLifecycle(route.premiereId);
  // Unregistered id and pre-reveal state must be an identical bare 404.
  if (reader === null) {
    sendClipDocumentFailure(response, 404);
    return;
  }
  const file = await options.clips.resolveReadyClip({
    premiereId: route.premiereId,
    lifecycleState: reader.readLifecycleState(),
    bucket: route.bucket,
  });
  if (file === null) {
    sendClipDocumentFailure(response, 404);
    return;
  }
  setClipDocumentHeaders(response);
  response.status(200);
  response.setHeader("Content-Type", "video/mp4");
  response.setHeader("Content-Length", file.byteLength);
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${clipFileName(route.bucket)}"`,
  );
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(file.filePath);
  stream.on("error", () => {
    if (!response.headersSent) sendClipDocumentFailure(response, 404);
    else response.destroy();
  });
  stream.pipe(response);
}

function setClipDocumentHeaders(response: Response): void {
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("CDN-Cache-Control", "no-store");
  response.setHeader("Surrogate-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Expires", "0");
  response.setHeader("Vary", "Origin, Cookie");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox",
  );
  response.removeHeader("ETag");
}

function sendClipDocumentFailure(response: Response, status: number): void {
  setClipDocumentHeaders(response);
  const body = JSON.stringify({ error: { code: "PREMIERE_UNAVAILABLE" } });
  response.status(status);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(response.req.method === "HEAD" ? undefined : body);
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function cacheKey(premiereId: string, bucket: number): string {
  return `${premiereId}\x00${bucket}\x00${PREMIERE_CLIP_VERSION}`;
}

function participantKey(premiereId: string, participantId: string): string {
  return `${premiereId}\x00${participantId}`;
}

function sidecarPath(clipPath: string): string {
  return clipPath.replace(/\.mp4$/, ".render-manifest.json");
}

function parseClipFileName(file: string): number | null {
  const match = new RegExp(
    `^clip-v${PREMIERE_CLIP_VERSION}-(0|[1-9][0-9]{0,8})\\.mp4$`,
  ).exec(file);
  if (match === null) return null;
  const bucket = Number(match[1]);
  return isPremiereClipBucket(bucket) ? bucket : null;
}

function parseRenderManifest(
  value: unknown,
): PremiereClipRenderManifest | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const str = (key: string): string | null =>
    typeof record[key] === "string" && (record[key] as string).length > 0
      ? (record[key] as string)
      : null;
  const int = (key: string): number | null =>
    Number.isSafeInteger(record[key]) ? (record[key] as number) : null;
  const premiereId = str("premiereId");
  const sourceReplaySha256 = str("sourceReplaySha256");
  const outSha256 = str("outSha256");
  const frameShape = str("frameShape");
  const generatedAt = str("generatedAt");
  const anchorTurn = int("anchorTurn");
  const clipVersion = int("clipVersion");
  const frameWidth = int("frameWidth");
  const frameHeight = int("frameHeight");
  const outBytes = int("outBytes");
  if (
    premiereId === null ||
    sourceReplaySha256 === null ||
    outSha256 === null ||
    frameShape === null ||
    generatedAt === null ||
    anchorTurn === null ||
    clipVersion === null ||
    frameWidth === null ||
    frameHeight === null ||
    outBytes === null
  ) {
    return null;
  }
  return {
    premiereId,
    sourceReplaySha256,
    anchorTurn,
    clipVersion,
    frameShape,
    frameWidth,
    frameHeight,
    outSha256,
    outBytes,
    generatedAt,
  };
}

function prune(times: number[], cutoffMs: number): number[] {
  return times.filter((t) => t >= cutoffMs);
}

function randomToken(): string {
  return createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 12);
}

function invalid(operatorCode: string, status: number): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    status,
    `Replay Premiere clip rejected: ${operatorCode}`,
  );
}

function capacity(operatorCode: string, status: number): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_CAPACITY_EXCEEDED",
    status,
    `Replay Premiere clip capacity: ${operatorCode}`,
  );
}

function unavailable(
  operatorCode: string,
  status: number,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_UNAVAILABLE",
    status,
    `Replay Premiere clip unavailable: ${operatorCode}`,
  );
}
