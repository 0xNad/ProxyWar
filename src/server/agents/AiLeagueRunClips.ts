/**
 * League-run social clips: the premiere clip pipeline generalized to EVERY
 * published match, not just premieres.
 *
 * A run clip is rendered from the run's published replay bundle
 * (`<runsRoot>/<runKey>/game-record.json` — the same record the
 * `/ai-league-replay/<runKey>` viewer plays) through the identical watermarked
 * worker, cache, quota, and eviction machinery as premiere clips. Availability
 * is therefore retention-bounded by design: any run whose replay bundle still
 * exists on disk can render or read a clip; a run aged off by retention 404s
 * cleanly. Durable Premiere promotion is the separate long-lived download
 * path after its ordinary replay source is reclaimed.
 *
 * Namespacing: this wrapper owns its OWN ReplayPremiereClips instance rooted
 * at a SEPARATE cache tree (`league-clips-v1`), so premiere and run clips can
 * never collide in cache keys, directories, byte budgets, or eviction — even
 * for identical id strings.
 */

import express, { type Request, type Response, type Router } from "express";
import { createHash } from "node:crypto";
import { promises as fs, type StatsFs } from "node:fs";
import path from "node:path";
import { GameRecordSchema } from "../../core/Schemas";
import {
  ReplayPremiereClips,
  type ReplayPremiereClipFile,
  type ReplayPremiereClipReadyArtifact,
  type ReplayPremiereClipsOptions,
} from "../replay-premiere/ReplayPremiereClips";
import type { PremiereClipStatusResponse } from "../replay-premiere/ReplayPremiereContracts";
import { premiereClipBucketForTurn } from "../replay-premiere/ReplayPremiereContracts";
import { ReplayPremiereError } from "../replay-premiere/ReplayPremiereErrors";
import {
  isSafeProxyWarArtifactSegment,
  matchProxyWarLeagueClipReadPath,
} from "./ProxyWarPublicArtifacts";

/** Sanity ceiling for a requested anchor turn (no record parse required). */
const MAX_RUN_CLIP_ANCHOR_TURN = 1_000_000;
/** Bounded sha memo (records are MB-scale; avoid rehashing per request). */
const MAX_SHA_MEMO_ENTRIES = 256;

export function aiLeagueRunClipFileRoute(
  runKey: string,
  bucket: number,
): string {
  return `/ai-league-runs/${runKey}/clip-v1-${bucket}.mp4`;
}

export function aiLeagueRunClipStatusRoute(
  runKey: string,
  bucket: number,
): string {
  return `/api/league-runs/${runKey}/clips/${bucket}`;
}

export interface AiLeagueRunClipsOptions {
  /** Root holding published run directories (`<runsRoot>/<runKey>/...`). */
  runsRootDir: string;
  /** Cache root — MUST be distinct from the premiere `clips-v1` tree. */
  clipsRoot: string;
  staticDir: string;
  workerModulePath: string;
  publicOrigin: string;
  licenseStrings: { attribution: string; noEndorsement: string };
  storageStatePath: string;
  clipFfmpegBin?: string;
  clipChromeBin?: string;
  scratchDir?: string;
  limits?: ReplayPremiereClipsOptions["limits"];
  now?: () => number;
  statfs?: (path: string) => Promise<StatsFs>;
  spawnWorker?: ReplayPremiereClipsOptions["spawnWorker"];
  logger?: (message: string) => void;
  /** Ready/cache-repair callback for durable archived-Premiere promotion. */
  onRunClipReady?: (ready: AiLeagueRunClipReady) => Promise<void> | void;
  /**
   * Cheap server-composition filter for archived run ids needing crash repair.
   * Omit to avoid rebuild callbacks for unrelated league-cache history.
   */
  shouldRepairRunClipOnIndexRebuild?: (runKey: string) => boolean;
  /** One-shot startup canary: every request/read/callback is exact-target only. */
  canaryScope?: {
    runKey: string;
    bucket: number;
    sourceReplaySha256: string;
    expiresAt: string;
    /** False while armed; true only after durable claim or on claimed restart. */
    isAuthorized: () => boolean;
  };
}

export interface AiLeagueRunClipReady {
  runKey: string;
  bucket: number;
  sourceReplaySha256: string;
  sourceFilePath: string;
}

export interface RetainedAiLeagueReplaySource {
  runKey: string;
  filePath: string;
  sourceReplaySha256: string;
  renderableThroughTurn: number;
  sourceComplete: true;
}

export class AiLeagueRunClips {
  private readonly clips: ReplayPremiereClips;
  private readonly runsRootDir: string;
  private readonly onRunClipReady:
    | ((ready: AiLeagueRunClipReady) => Promise<void> | void)
    | undefined;
  private readonly shouldRepairRunClipOnIndexRebuild:
    | ((runKey: string) => boolean)
    | undefined;
  private readonly canaryScope: AiLeagueRunClipsOptions["canaryScope"];
  private readonly now: () => number;
  private readonly shaMemo = new Map<
    string,
    {
      dev: number;
      ino: number;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
      source: RetainedAiLeagueReplaySource;
    }
  >();

  constructor(options: AiLeagueRunClipsOptions) {
    this.runsRootDir = path.resolve(options.runsRootDir);
    this.onRunClipReady = options.onRunClipReady;
    this.shouldRepairRunClipOnIndexRebuild =
      options.shouldRepairRunClipOnIndexRebuild;
    this.canaryScope = options.canaryScope;
    this.now = options.now ?? (() => Date.now());
    const publicOrigin = options.publicOrigin.replace(/\/$/, "");
    this.clips = new ReplayPremiereClips({
      clipsRoot: options.clipsRoot,
      // Unused (a resolver is injected below) but required by the service.
      sourceBundleRoot: this.runsRootDir,
      staticDir: options.staticDir,
      workerModulePath: options.workerModulePath,
      publicOrigin: options.publicOrigin,
      licenseStrings: options.licenseStrings,
      storageStatePath: options.storageStatePath,
      clipFfmpegBin: options.clipFfmpegBin,
      clipChromeBin: options.clipChromeBin,
      scratchDir: options.scratchDir,
      limits: options.limits,
      now: options.now,
      statfs: options.statfs,
      spawnWorker: options.spawnWorker,
      logger: options.logger,
      resolveSourceBundlePath: (request) =>
        this.recordPathFor(request.premiereId),
      watchUrlForId: (runKey) => `${publicOrigin}/ai-league-replay/${runKey}`,
      clipUrlFor: aiLeagueRunClipFileRoute,
      onClipReady: (artifact) => this.handleReadyArtifact(artifact),
      shouldRepairClipOnIndexRebuild: (artifact) =>
        this.shouldRepairReadyArtifact(artifact),
    });
  }

  private async shouldRepairReadyArtifact(
    artifact: ReplayPremiereClipReadyArtifact,
  ): Promise<boolean> {
    if (
      this.shouldRepairRunClipOnIndexRebuild === undefined ||
      !isServableRunKey(artifact.premiereId) ||
      !this.shouldRepairRunClipOnIndexRebuild(artifact.premiereId) ||
      !this.canaryActionAllows(
        artifact.premiereId,
        artifact.bucket,
        artifact.sourceReplaySha256,
      )
    ) {
      return false;
    }
    // Select the best cache entry only after binding it to the retained source.
    // Otherwise a higher stale-source bucket can suppress a lower valid repair.
    const source = await this.resolveRetainedRunSource(artifact.premiereId);
    return source?.sourceReplaySha256 === artifact.sourceReplaySha256;
  }

  private async handleReadyArtifact(
    artifact: ReplayPremiereClipReadyArtifact,
  ): Promise<void> {
    if (this.onRunClipReady === undefined) return;
    if (
      !this.canaryActionAllows(
        artifact.premiereId,
        artifact.bucket,
        artifact.sourceReplaySha256,
      )
    ) {
      return;
    }
    if (!isServableRunKey(artifact.premiereId)) return;
    const source = await this.resolveRetainedRunSource(artifact.premiereId);
    if (
      source === null ||
      source.sourceReplaySha256 !== artifact.sourceReplaySha256
    ) {
      return;
    }
    await this.onRunClipReady({
      runKey: artifact.premiereId,
      bucket: artifact.bucket,
      sourceReplaySha256: source.sourceReplaySha256,
      sourceFilePath: source.filePath,
    });
  }

  /** Rebuild the disk-scan cache index (mirrors the premiere service). */
  async rebuildIndex(): Promise<void> {
    await this.clips.rebuildIndex();
  }

  async close(): Promise<void> {
    await this.clips.close();
  }

  /**
   * Request a render for a published run. Public callers pass a stable opaque
   * requester bucket for the per-participant quota; system jobs may pass null.
   * Per-run/day and global/hour quotas, queue depth, and disk floor also bound
   * the work; callers add request rate limiting at the route.
   */
  async requestRunClip(request: {
    runKey: string;
    anchorTurn: number;
    /** Stable opaque requester bucket; null is reserved for system jobs. */
    participantId?: string | null;
  }): Promise<PremiereClipStatusResponse> {
    const runKey = this.validateRunKey(request.runKey);
    if (
      !Number.isSafeInteger(request.anchorTurn) ||
      request.anchorTurn < 0 ||
      request.anchorTurn > MAX_RUN_CLIP_ANCHOR_TURN
    ) {
      throw new ReplayPremiereError(
        "league_clip_anchor_invalid",
        "PREMIERE_INVALID_REQUEST",
        400,
        "League clip anchor turn is invalid",
      );
    }
    const bucket = premiereClipBucketForTurn(request.anchorTurn);
    this.requireCanaryActionScope(runKey, bucket);
    const source = await this.requireRetainedRunSource(runKey);
    this.requireCanaryActionScope(runKey, bucket, source.sourceReplaySha256);
    return this.clips.requestClip({
      premiereId: runKey,
      anchorTurn: request.anchorTurn,
      participantId: request.participantId ?? null,
      sourceReplaySha256: source.sourceReplaySha256,
      renderableThroughTurn: source.renderableThroughTurn,
      sourceComplete: source.sourceComplete,
    });
  }

  /** Render status for a bucket (absent | pending | ready). */
  async readRunClipStatus(request: {
    runKey: string;
    bucket: number;
    /** Opt-in exact FIFO progress; omitted preserves legacy schema-v1 JSON. */
    includeProgress?: boolean;
  }): Promise<PremiereClipStatusResponse> {
    const runKey = this.validateRunKey(request.runKey);
    this.requireCanaryActionScope(runKey, request.bucket);
    const source = await this.requireRetainedRunSource(runKey);
    this.requireCanaryActionScope(
      runKey,
      request.bucket,
      source.sourceReplaySha256,
    );
    return this.clips.readStatus(
      {
        premiereId: runKey,
        bucket: request.bucket,
        sourceReplaySha256: source.sourceReplaySha256,
      },
      { includeProgress: request.includeProgress === true },
    );
  }

  /** On-disk cached mp4 for the document route, or null (=> 404). */
  async resolveRunClipFile(request: {
    runKey: string;
    bucket: number;
  }): Promise<ReplayPremiereClipFile | null> {
    if (!isServableRunKey(request.runKey)) return null;
    if (!this.canaryActionAllows(request.runKey, request.bucket)) return null;
    const source = await this.resolveRetainedRunSource(request.runKey);
    if (source === null) return null;
    if (
      !this.canaryActionAllows(
        request.runKey,
        request.bucket,
        source.sourceReplaySha256,
      )
    ) {
      return null;
    }
    return this.clips.resolveReadyClip({
      premiereId: request.runKey,
      bucket: request.bucket,
      sourceReplaySha256: source.sourceReplaySha256,
    });
  }

  /**
   * Resolve the immutable bytes and supported range for a retained replay.
   * Missing, compacted, malformed, symlinked, or range-less records are not
   * clip targets. This is also the archive page's single canonical resolver.
   */
  async resolveRetainedRunSource(
    runKey: string,
  ): Promise<RetainedAiLeagueReplaySource | null> {
    const validated = this.validateRunKey(runKey);
    if (!this.canaryAllowsRun(validated)) return null;
    const recordPath = this.recordPathFor(validated);
    let stat;
    try {
      stat = await fs.lstat(recordPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
    } catch {
      return null;
    }
    const memo = this.shaMemo.get(recordPath);
    if (
      memo !== undefined &&
      memo.dev === stat.dev &&
      memo.ino === stat.ino &&
      memo.size === stat.size &&
      memo.mtimeMs === stat.mtimeMs &&
      memo.ctimeMs === stat.ctimeMs
    ) {
      return memo.source;
    }

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(recordPath);
    } catch {
      return null;
    }
    try {
      const after = await fs.lstat(recordPath);
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      ) {
        return null;
      }
    } catch {
      return null;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(bytes.toString("utf8"));
    } catch {
      return null;
    }
    // Reuse the ordinary replay client's canonical full-record validation. A
    // top-level turns array alone is not enough: malformed config, players, or
    // turns must never become clip-eligible merely because bytes are retained.
    const parsedRecord = GameRecordSchema.safeParse(parsedJson);
    if (!parsedRecord.success) return null;
    const renderableThroughTurn = parsedRecord.data.info.num_turns;
    if (
      !Number.isSafeInteger(renderableThroughTurn) ||
      renderableThroughTurn <= 0
    ) {
      return null;
    }
    const source: RetainedAiLeagueReplaySource = {
      runKey: validated,
      filePath: recordPath,
      sourceReplaySha256: createHash("sha256").update(bytes).digest("hex"),
      renderableThroughTurn,
      sourceComplete: true,
    };
    if (
      this.canaryScope !== undefined &&
      source.sourceReplaySha256 !== this.canaryScope.sourceReplaySha256
    ) {
      return null;
    }
    if (this.shaMemo.size >= MAX_SHA_MEMO_ENTRIES) {
      const oldest = this.shaMemo.keys().next().value;
      if (oldest !== undefined) this.shaMemo.delete(oldest);
    }
    this.shaMemo.set(recordPath, {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      source,
    });
    return source;
  }

  /** Absolute record path for a validated run key (containment-checked). */
  private recordPathFor(runKey: string): string {
    const validated = this.validateRunKey(runKey);
    const recordPath = path.resolve(
      this.runsRootDir,
      validated,
      "game-record.json",
    );
    if (
      recordPath !== path.join(this.runsRootDir, validated, "game-record.json")
    ) {
      throw runInvalid("league_clip_run_path_escape");
    }
    return recordPath;
  }

  /**
   * Hash the run's replay bundle so the worker verifies EXACTLY the bytes we
   * admitted (mtime+size-keyed memo; a changed file re-hashes). An absent
   * bundle — the run aged off retention, or never published a record — is a
   * clean 404 BEFORE any quota is consumed.
   */
  private async requireRetainedRunSource(
    runKey: string,
  ): Promise<RetainedAiLeagueReplaySource> {
    const source = await this.resolveRetainedRunSource(runKey);
    if (source === null) {
      throw new ReplayPremiereError(
        "league_clip_replay_absent",
        "PREMIERE_UNAVAILABLE",
        404,
        "League clip source replay is not available",
      );
    }
    return source;
  }

  private validateRunKey(runKey: string): string {
    if (!isServableRunKey(runKey)) {
      throw runInvalid("league_clip_run_key_invalid");
    }
    return runKey;
  }

  /** True only for the process-lifetime, exact-target canary service. */
  isCanaryScoped(): boolean {
    return this.canaryScope !== undefined;
  }

  allowsCanaryRead(runKey: string, bucket: number): boolean {
    return (
      this.canaryScope !== undefined && this.canaryActionAllows(runKey, bucket)
    );
  }

  private canaryAllowsRun(runKey: string): boolean {
    return (
      this.canaryScope === undefined ||
      (this.now() < Date.parse(this.canaryScope.expiresAt) &&
        runKey === this.canaryScope.runKey)
    );
  }

  private canaryAllows(
    runKey: string,
    bucket: number,
    sourceReplaySha256?: string,
  ): boolean {
    return (
      this.canaryScope === undefined ||
      (this.canaryAllowsRun(runKey) &&
        bucket === this.canaryScope.bucket &&
        (sourceReplaySha256 === undefined ||
          sourceReplaySha256 === this.canaryScope.sourceReplaySha256))
    );
  }

  private canaryActionAllows(
    runKey: string,
    bucket: number,
    sourceReplaySha256?: string,
  ): boolean {
    return (
      this.canaryAllows(runKey, bucket, sourceReplaySha256) &&
      (this.canaryScope === undefined || this.canaryScope.isAuthorized())
    );
  }

  private requireCanaryActionScope(
    runKey: string,
    bucket: number,
    sourceReplaySha256?: string,
  ): void {
    if (!this.canaryActionAllows(runKey, bucket, sourceReplaySha256)) {
      throw new ReplayPremiereError(
        "league_clip_canary_scope_refused",
        "PREMIERE_UNAVAILABLE",
        404,
        "League clip lacks active claimed canary authorization",
      );
    }
  }
}

/** Strict single-segment run key (no traversal, no separators, bounded). */
export function isServableRunKey(runKey: string): boolean {
  return isSafeProxyWarArtifactSegment(runKey);
}

function runInvalid(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    400,
    `League clip request rejected: ${operatorCode}`,
  );
}

// ---------------------------------------------------------------------------
// mp4 document router (mounted before the run-artifact handlers)
// ---------------------------------------------------------------------------

export interface AiLeagueRunClipDocumentRouterOptions {
  runClips: AiLeagueRunClips;
  onOperatorError?: (error: unknown) => void;
}

/**
 * Serves `GET|HEAD /ai-league-runs/<runKey>/clip-v1-<bucket>.mp4` from the
 * league clip cache. A missing artifact is a bare 404; every other run
 * artifact path passes through untouched. Published clips are public: the
 * response is cacheable (noindex stays).
 */
export function createAiLeagueRunClipDocumentRouter(
  options: AiLeagueRunClipDocumentRouterOptions,
): Router {
  const router = express.Router();
  router.use((request, response, next) => {
    const route = matchProxyWarLeagueClipReadPath(request.path);
    if (route?.kind !== "clip_file") {
      next();
      return;
    }
    void handleRunClipFileRequest(request, response, route, options).catch(
      (error: unknown) => {
        try {
          options.onOperatorError?.(error);
        } catch {
          // Operator diagnostics never replace the fixed public response.
        }
        if (!response.headersSent) {
          sendRunClipFailure(response, 404);
        } else {
          response.destroy();
        }
      },
    );
  });
  return router;
}

async function handleRunClipFileRequest(
  request: Request,
  response: Response,
  route: { runKey: string; bucket: number },
  options: AiLeagueRunClipDocumentRouterOptions,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    sendRunClipFailure(response, 405);
    return;
  }
  if (request.headers.range !== undefined) {
    sendRunClipFailure(response, 416);
    return;
  }
  const file = await options.runClips.resolveRunClipFile({
    runKey: route.runKey,
    bucket: route.bucket,
  });
  if (file === null) {
    sendRunClipFailure(response, 404);
    return;
  }
  try {
    setRunClipHeaders(response);
    response.status(200);
    response.setHeader(
      "Cache-Control",
      options.runClips.isCanaryScoped()
        ? "no-store, max-age=0"
        : "public, max-age=3600",
    );
    response.setHeader("Content-Type", "video/mp4");
    response.setHeader("Content-Length", file.byteLength);
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${route.runKey}-clip-${route.bucket}.mp4"`,
    );
    if (request.method === "HEAD") {
      await closeRunClipFile(file);
      response.end();
      return;
    }
    pipePinnedRunClip(file, response, () => {
      if (!response.headersSent) sendRunClipFailure(response, 404);
      else response.destroy();
    });
  } catch (error) {
    await closeRunClipFile(file);
    throw error;
  }
}

/** Stream the validated inode held by resolveReadyClip, never its pathname. */
function pipePinnedRunClip(
  file: ReplayPremiereClipFile,
  response: Response,
  onStreamError: () => void,
): void {
  const stream = file.fileHandle.createReadStream({
    autoClose: true,
    start: 0,
  });
  const close = (): void => {
    stream.destroy();
  };
  response.once("finish", close);
  response.once("close", close);
  stream.once("error", () => {
    onStreamError();
  });
  stream.pipe(response);
}

async function closeRunClipFile(file: ReplayPremiereClipFile): Promise<void> {
  await file.fileHandle.close().catch(() => undefined);
}

function setRunClipHeaders(response: Response): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox",
  );
}

function sendRunClipFailure(response: Response, status: number): void {
  setRunClipHeaders(response);
  response.setHeader("Cache-Control", "no-store, max-age=0");
  const body = JSON.stringify({ error: { code: "LEAGUE_CLIP_UNAVAILABLE" } });
  response.status(status);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(response.req.method === "HEAD" ? undefined : body);
}

/** Public JSON error shape for the league clip API routes. */
export function aiLeagueRunClipErrorBody(error: unknown): {
  status: number;
  body: { error: { code: string } };
} {
  if (error instanceof ReplayPremiereError) {
    const code =
      error.publicCode === "PREMIERE_CAPACITY_EXCEEDED"
        ? "LEAGUE_CLIP_CAPACITY_EXCEEDED"
        : error.publicCode === "PREMIERE_INVALID_REQUEST"
          ? "LEAGUE_CLIP_INVALID_REQUEST"
          : "LEAGUE_CLIP_UNAVAILABLE";
    return { status: error.httpStatus, body: { error: { code } } };
  }
  return { status: 503, body: { error: { code: "LEAGUE_CLIP_UNAVAILABLE" } } };
}
