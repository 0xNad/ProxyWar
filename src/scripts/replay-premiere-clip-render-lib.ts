/**
 * Replay Premiere clip render library (Phase A spike).
 *
 * Unit-testable building blocks for the premiere clip worker:
 *  - a minimal Chrome DevTools Protocol client over the repo's existing `ws`
 *    dependency (no puppeteer/playwright),
 *  - a headless Chrome launcher that discovers the DevTools endpoint via the
 *    profile's DevToolsActivePort file,
 *  - a Page.startScreencast frame collector,
 *  - ffmpeg invocation builders ported from outputs/promo/assemble.py
 *    (concat demuxer -> fps/scale/setsar -> drawtext watermark -> end slate ->
 *    libx264 High / crf 21 / yuv420p / +faststart / silent AAC).
 *
 * This module deliberately has no repo-server imports; it only uses node
 * builtins plus `ws`.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync, { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_CHROME_BINARY =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const DEFAULT_FFMPEG_BINARY =
  "/Users/claude/Library/Python/3.9/lib/python/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1";

export const FFMPEG_BIN_ENV = "PROXYWAR_CLIP_FFMPEG_BIN";

export const FONT_ARIAL = "/System/Library/Fonts/Supplemental/Arial.ttf";
export const FONT_ARIAL_BOLD =
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf";
export const FONT_ARIAL_BLACK =
  "/System/Library/Fonts/Supplemental/Arial Black.ttf";

/** Slate background color, ported from assemble.py's endcard (0x0e0e12). */
export const SLATE_BACKGROUND = "0x0e0e12";
/** Gold accent, ported from assemble.py's endcard line color. */
export const SLATE_ACCENT = "0xF8D530";

export const CLIP_FPS = 30;
export const CLIP_CRF = 21;
/** Shared mp4 track timescale so the slate concat (-c copy) stays clean. */
export const CLIP_TIMESCALE = 15360;

// ---------------------------------------------------------------------------
// Frame shape
// ---------------------------------------------------------------------------

/**
 * Output geometry. `square` is the default: X/mobile-optimal, and the near
 * square maps the league actually plays (Pangaea is exactly 1000x1000) fill it
 * without letterboxing. `landscape` keeps the 16:9 geometry for embeds.
 */
export type ClipFrameShape = "square" | "landscape";

/**
 * Camera policy. `fill` zooms past whole-map fit (cropping the map's long axis)
 * until the empty-canvas margin is within budget; `whole-map` is the plain
 * `centerAll(1)` contain fit, which letterboxes whenever the map aspect does
 * not match the frame aspect.
 */
export type ClipCameraFit = "fill" | "whole-map";

export interface ClipFrameProfile {
  shape: ClipFrameShape;
  width: number;
  height: number;
}

export const CLIP_FRAME_PROFILES: Readonly<
  Record<ClipFrameShape, ClipFrameProfile>
> = {
  // The native spectator leaderboard keeps its client-set 360px width at both
  // shapes; at 1080 that is a legible ~1/3 of the frame (verified in renders),
  // so no clip-side rescale is applied.
  square: {
    shape: "square",
    width: 1080,
    height: 1080,
  },
  landscape: {
    shape: "landscape",
    width: 1280,
    height: 720,
  },
};

export const DEFAULT_CLIP_FRAME_SHAPE: ClipFrameShape = "square";
export const DEFAULT_CLIP_CAMERA_FIT: ClipCameraFit = "fill";

/** Empty-canvas budget per side, as a fraction of the frame's own dimension. */
export const CLIP_MAX_DEAD_SPACE_PER_SIDE = 0.12;
/**
 * Hard cap on how far the camera may zoom past whole-map fit. 1.6 covers every
 * map up to ~2.1:1 (which includes world/oceania/mars at 2.0); ribbon maps such
 * as `amazonriver` (20:1) cannot be framed without discarding almost the whole
 * board, so they fail the dead-space check loudly instead of shipping a clip
 * that is mostly empty canvas.
 */
export const CLIP_MAX_CAMERA_OVERSCAN = 1.6;

export function isClipFrameShape(value: unknown): value is ClipFrameShape {
  return value === "square" || value === "landscape";
}

export function isClipCameraFit(value: unknown): value is ClipCameraFit {
  return value === "fill" || value === "whole-map";
}

export function resolveClipFrameProfile(
  shape: ClipFrameShape = DEFAULT_CLIP_FRAME_SHAPE,
): ClipFrameProfile {
  return CLIP_FRAME_PROFILES[shape];
}

export interface ClipCameraGeometry {
  /** Argument for the client's `centerAll(fit)`; 1 is plain whole-map fit. */
  fit: number;
  scale: number;
  mapScreenWidth: number;
  mapScreenHeight: number;
  /** Empty canvas on each side in device pixels (left === right, top === bottom). */
  deadSpaceHorizontalPx: number;
  deadSpaceVerticalPx: number;
  /** Worst per-side empty-canvas margin as a fraction of that frame dimension. */
  deadSpacePerSideFraction: number;
  /** True when the overscan cap, not the map, prevented reaching the budget. */
  overscanCapped: boolean;
}

/**
 * Resolve the camera zoom for one frame/map pair.
 *
 * `centerAll(fit)` scales by `min(vpW/mapW, vpH/mapH) * fit` and centers the
 * map, so the empty margin per side is `(vp - map * scale) / 2` on whichever
 * axis is loose. For a square map in a square frame the loose axis does not
 * exist and `fit` stays exactly 1 (identical framing to a plain `centerAll()`).
 */
export function computeClipCameraGeometry(options: {
  viewportWidth: number;
  viewportHeight: number;
  mapWidth: number;
  mapHeight: number;
  cameraFit?: ClipCameraFit;
  maxDeadSpacePerSide?: number;
  maxOverscan?: number;
}): ClipCameraGeometry {
  const viewportWidth = positiveFinite(options.viewportWidth, "viewportWidth");
  const viewportHeight = positiveFinite(
    options.viewportHeight,
    "viewportHeight",
  );
  const mapWidth = positiveFinite(options.mapWidth, "mapWidth");
  const mapHeight = positiveFinite(options.mapHeight, "mapHeight");
  const cameraFit = options.cameraFit ?? DEFAULT_CLIP_CAMERA_FIT;
  const maxDeadSpacePerSide =
    options.maxDeadSpacePerSide ?? CLIP_MAX_DEAD_SPACE_PER_SIDE;
  const maxOverscan = options.maxOverscan ?? CLIP_MAX_CAMERA_OVERSCAN;
  if (maxDeadSpacePerSide < 0 || maxDeadSpacePerSide >= 0.5) {
    throw new Error(
      `maxDeadSpacePerSide must be in [0, 0.5): ${maxDeadSpacePerSide}`,
    );
  }
  if (!(maxOverscan >= 1)) {
    throw new Error(`maxOverscan must be >= 1: ${maxOverscan}`);
  }

  const containScale = Math.min(
    viewportWidth / mapWidth,
    viewportHeight / mapHeight,
  );
  const coverScale = Math.max(
    viewportWidth / mapWidth,
    viewportHeight / mapHeight,
  );
  const coverRatio = coverScale / containScale;

  let fit = 1;
  let overscanCapped = false;
  if (cameraFit === "fill" && coverRatio > 1) {
    const needed = (1 - 2 * maxDeadSpacePerSide) * coverRatio;
    const cap = Math.min(coverRatio, maxOverscan);
    fit = Math.min(Math.max(1, needed), cap);
    overscanCapped = needed > cap + 1e-9;
  }

  const scale = containScale * fit;
  const mapScreenWidth = mapWidth * scale;
  const mapScreenHeight = mapHeight * scale;
  const deadSpaceHorizontalPx = Math.max(
    0,
    (viewportWidth - mapScreenWidth) / 2,
  );
  const deadSpaceVerticalPx = Math.max(
    0,
    (viewportHeight - mapScreenHeight) / 2,
  );
  return {
    fit,
    scale,
    mapScreenWidth,
    mapScreenHeight,
    deadSpaceHorizontalPx,
    deadSpaceVerticalPx,
    deadSpacePerSideFraction: Math.max(
      deadSpaceHorizontalPx / viewportWidth,
      deadSpaceVerticalPx / viewportHeight,
    ),
    overscanCapped,
  };
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number: ${value}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function sha256OfBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function sha256OfFile(filePath: string): Promise<string> {
  return sha256OfBuffer(await fs.readFile(filePath));
}

export function resolveFfmpegBinary(env: NodeJS.ProcessEnv = process.env) {
  const fromEnv = env[FFMPEG_BIN_ENV];
  return fromEnv !== undefined && fromEnv.trim() !== ""
    ? fromEnv
    : DEFAULT_FFMPEG_BINARY;
}

/** Run ffmpeg, failing loud with the stderr tail on a non-zero exit. */
export async function runFfmpeg(
  ffmpegBinary: string,
  args: string[],
): Promise<{ stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFile(
      ffmpegBinary,
      args,
      { maxBuffer: 64 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `ffmpeg failed (${error.message.split("\n")[0]}):\n${stderr.slice(-2000)}`,
            ),
          );
          return;
        }
        resolve({ stderr });
      },
    );
  });
}

/** Verify the ffmpeg binary responds to -version; return the version line. */
export async function verifyFfmpeg(ffmpegBinary: string): Promise<string> {
  const result = await new Promise<string>((resolve, reject) => {
    execFile(ffmpegBinary, ["-version"], (error, stdout) => {
      if (error) {
        reject(
          new Error(`ffmpeg binary is not runnable: ${ffmpegBinary}`, {
            cause: error,
          }),
        );
        return;
      }
      resolve(stdout);
    });
  });
  const firstLine = result.split("\n")[0]?.trim() ?? "";
  if (!firstLine.startsWith("ffmpeg version")) {
    throw new Error(
      `unexpected ffmpeg -version output from ${ffmpegBinary}: ${firstLine}`,
    );
  }
  return firstLine;
}

// ---------------------------------------------------------------------------
// ffmpeg invocation builders (ported from outputs/promo/assemble.py)
// ---------------------------------------------------------------------------

/**
 * Escape drawtext text for the filtergraph. Port of assemble.py `_dt_escape`:
 * backslash first, then the filtergraph/drawtext specials : ' , ; [ ] %.
 * Field-proven with this exact ffmpeg binary; the fixed strings we render
 * contain no apostrophes (the escaper matches assemble.py's behavior and is
 * not exercised against `'` beyond parity with the source implementation).
 */
export function drawtextEscape(text: string): string {
  let out = text.replaceAll("\\", "\\\\");
  for (const ch of [":", "'", ",", ";", "[", "]", "%"]) {
    out = out.replaceAll(ch, "\\" + ch);
  }
  return out;
}

function drawtext(options: {
  fontFile: string;
  text: string;
  fontColor: string;
  fontSize: number;
  x: string;
  y: string;
  box?: boolean;
}): string {
  const parts = [
    `drawtext=fontfile='${options.fontFile}'`,
    "expansion=none",
    `text='${drawtextEscape(options.text)}'`,
    `fontcolor=${options.fontColor}`,
    `fontsize=${options.fontSize}`,
    `x=${options.x}`,
    `y=${options.y}`,
  ];
  if (options.box === true) {
    parts.push("box=1", "boxcolor=black@0.35", "boxborderw=6");
  }
  return parts.join(":");
}

/**
 * Build the concat-demuxer list content for captured frames. Frame i must be
 * named `f${i.padStart(5)}.jpg` (see frameFileName). `durations[i]` is the
 * display seconds for frame i; assemble.py derives them from screencast
 * timestamp deltas and skips the duration line for the final frame (the
 * demuxer holds the last frame for one filter step).
 */
export function buildConcatFileContent(durations: number[]): string {
  const lines: string[] = [];
  for (let i = 0; i < durations.length; i++) {
    lines.push(`file '${frameFileName(i)}'`);
    if (i < durations.length - 1) {
      lines.push(`duration ${Math.max(0.001, durations[i]).toFixed(4)}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function frameFileName(index: number): string {
  return `f${String(index).padStart(5, "0")}.jpg`;
}

/** Screencast timestamps (seconds) -> per-frame display durations. */
export function durationsFromTimestamps(
  timestamps: number[],
  fallbackSeconds: number = 1 / CLIP_FPS,
): number[] {
  return timestamps.map((ts, i) =>
    i < timestamps.length - 1
      ? Math.max(0.001, timestamps[i + 1] - ts)
      : fallbackSeconds,
  );
}

/**
 * Encode the captured frames into the watermarked clip body:
 * concat demuxer -> fps=30,scale=1280:720,setsar=1 -> persistent lower-right
 * drawtext watermark -> libx264 High, crf 21, yuv420p.
 */
export function buildClipEncodeArgs(options: {
  concatPath: string;
  outPath: string;
  watermarkText: string;
  width?: number;
  height?: number;
}): string[] {
  const { width, height } = frameSize(options);
  const watermark = drawtext({
    fontFile: FONT_ARIAL_BOLD,
    // Scales with the frame: 20 at 720p tall, 30 at 1080 square.
    text: options.watermarkText,
    fontColor: "white@0.85",
    fontSize: Math.round(height * 0.0278),
    x: `w-text_w-${Math.round(width * 0.011)}`,
    y: `h-text_h-${Math.round(height * 0.0139)}`,
    box: true,
  });
  // in_range=jpeg/out_range=mpeg: screencast JPEG frames are full range;
  // convert to limited range so the output is plain yuv420p (tv), matching
  // the slate and the "h264 High yuv420p" contract.
  const vf = `fps=${CLIP_FPS},scale=${width}:${height}:in_range=jpeg:out_range=mpeg,setsar=1,${watermark}`;
  return [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    options.concatPath,
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-profile:v",
    "high",
    "-crf",
    String(CLIP_CRF),
    "-pix_fmt",
    "yuv420p",
    "-video_track_timescale",
    String(CLIP_TIMESCALE),
    options.outPath,
  ];
}

/**
 * Build the 2s end slate: dark background, "Proxy War" wordmark, CTA, and the
 * exact `replay_premiere.asset_attribution` / `replay_premiere.no_endorsement`
 * strings (passed in verbatim from resources/lang/en.json). The layout is
 * re-derived from the target dimensions so both license lines stay fully inside
 * the frame at 1080x1080 (square) and 1280x720 (landscape).
 */
export function buildSlateArgs(options: {
  outPath: string;
  title: string;
  ctaText: string;
  attributionText: string;
  noEndorsementText: string;
  seconds?: number;
  width?: number;
  height?: number;
}): string[] {
  const seconds = options.seconds ?? 2;
  const { width, height } = frameSize(options);
  // Title/CTA sit above vertical center; the two license lines are pinned to
  // the bottom margin (measured up from the frame bottom, not down from the
  // top) so they never overflow whatever the frame height is. The license font
  // is capped so the longer attribution line fits within the frame width with a
  // safe margin at either aspect.
  const titleSize = Math.round(height * 0.089);
  const ctaSize = Math.round(height * 0.055);
  const licenseSize = Math.min(
    Math.round(height * 0.024),
    // ~0.9 px per character for Arial at the widths we use; keep the longest
    // license line inside 92% of the frame width.
    Math.floor((width * 0.92) / (longestLicenseChars(options) * 0.52)),
  );
  const licenseLineGap = Math.round(licenseSize * 1.7);
  const drawtexts = [
    drawtext({
      fontFile: FONT_ARIAL_BLACK,
      text: options.title,
      fontColor: "white",
      fontSize: titleSize,
      x: "(w-text_w)/2",
      y: `${(height * 0.5 - titleSize - height * 0.03).toFixed(0)}`,
    }),
    drawtext({
      fontFile: FONT_ARIAL_BOLD,
      text: options.ctaText,
      fontColor: SLATE_ACCENT,
      fontSize: ctaSize,
      x: "(w-text_w)/2",
      y: `${(height * 0.5 + height * 0.02).toFixed(0)}`,
    }),
    drawtext({
      fontFile: FONT_ARIAL,
      text: options.attributionText,
      fontColor: "white@0.85",
      fontSize: licenseSize,
      x: "(w-text_w)/2",
      y: `h-${(height * 0.07 + licenseLineGap).toFixed(0)}`,
    }),
    drawtext({
      fontFile: FONT_ARIAL,
      text: options.noEndorsementText,
      fontColor: "white@0.85",
      fontSize: licenseSize,
      x: "(w-text_w)/2",
      y: `h-${(height * 0.07).toFixed(0)}`,
    }),
  ];
  return [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${SLATE_BACKGROUND}:s=${width}x${height}:d=${seconds}`,
    "-vf",
    drawtexts.join(","),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-profile:v",
    "high",
    "-crf",
    String(CLIP_CRF),
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(CLIP_FPS),
    "-video_track_timescale",
    String(CLIP_TIMESCALE),
    options.outPath,
  ];
}

function longestLicenseChars(options: {
  attributionText: string;
  noEndorsementText: string;
}): number {
  return Math.max(
    1,
    options.attributionText.length,
    options.noEndorsementText.length,
  );
}

function frameSize(options: { width?: number; height?: number }): {
  width: number;
  height: number;
} {
  const profile = CLIP_FRAME_PROFILES[DEFAULT_CLIP_FRAME_SHAPE];
  const width = options.width ?? profile.width;
  const height = options.height ?? profile.height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 16 ||
    height < 16 ||
    width % 2 !== 0 ||
    height % 2 !== 0
  ) {
    throw new Error(`invalid clip frame size ${width}x${height}`);
  }
  return { width, height };
}

/** Concat list (absolute paths) for the final body+slate mux. */
export function buildConcatListContent(absolutePaths: string[]): string {
  return (
    absolutePaths
      .map((p) => `file '${p.replaceAll("'", "'\\''")}'`)
      .join("\n") + "\n"
  );
}

/**
 * Final mux: concat body+slate (-c copy), add a silent stereo AAC track, and
 * set +faststart (moov before mdat).
 */
export function buildFinalMuxArgs(options: {
  listPath: string;
  outPath: string;
}): string[] {
  return [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    options.listPath,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-shortest",
    "-movflags",
    "+faststart",
    // The atomic-write temp name carries no .mp4 suffix, so name the muxer.
    "-f",
    "mp4",
    options.outPath,
  ];
}

/** Extract one still (for the visual watermark/slate proof dumps). */
export function buildFrameExtractArgs(options: {
  videoPath: string;
  atSeconds: number;
  outPath: string;
}): string[] {
  return [
    "-y",
    "-ss",
    options.atSeconds.toFixed(3),
    "-i",
    options.videoPath,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    options.outPath,
  ];
}

// ---------------------------------------------------------------------------
// Minimal CDP client over `ws`
// ---------------------------------------------------------------------------

export type CdpEventHandler = (
  params: Record<string, unknown>,
  sessionId: string | undefined,
) => void;

interface PendingCommand {
  method: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/**
 * Minimal flat-session DevTools protocol client: JSON commands with
 * incrementing ids, per-method event subscription, optional sessionId routing
 * (Target.attachToTarget with flatten: true).
 */
export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly handlers = new Map<string, Set<CdpEventHandler>>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("close", () => this.failAllPending(new Error("CDP socket closed")));
    ws.on("error", (error) =>
      this.failAllPending(
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
  }

  static async connect(wsUrl: string): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (error) =>
        reject(new Error(`CDP connect failed: ${String(error)}`)),
      );
    });
    return new CdpClient(ws);
  }

  private onMessage(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: Record<string, unknown>;
      error?: { message?: string; code?: number };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `CDP ${pending.method} failed: ${message.error.message ?? "unknown"} (code ${message.error.code ?? "?"})`,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method !== undefined) {
      const set = this.handlers.get(message.method);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(message.params ?? {}, message.sessionId);
        } catch {
          // Event handlers must not break the message pump.
        }
      }
    }
  }

  private failAllPending(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new Error(`CDP ${method} failed: socket already closed`);
    }
    const id = this.nextId++;
    const payload = JSON.stringify(
      sessionId === undefined
        ? { id, method, params }
        : { id, method, params, sessionId },
    );
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.ws.send(payload, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  /** Subscribe to a CDP event; returns an unsubscribe function. */
  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 2000);
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.close();
    });
  }
}

// ---------------------------------------------------------------------------
// Headless Chrome launcher
// ---------------------------------------------------------------------------

export interface LaunchedChrome {
  process: ChildProcess;
  userDataDir: string;
  devtoolsPort: number;
  browserWsUrl: string;
  /** e.g. "HeadlessChrome/138.0.7204.94" from /json/version. */
  browserVersion: string;
  /** SIGKILL + wait for exit; safe to call after Browser.close as well. */
  dispose(): Promise<void>;
}

function httpGetJson(url: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(5000, () => {
      request.destroy(new Error(`timeout fetching ${url}`));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn headless Chrome with an isolated profile and discover the DevTools
 * endpoint via the profile's DevToolsActivePort file (NOT a fixed-port
 * assumption): read the port from the file, then GET /json/version on that
 * port for the browser websocket URL and version. The port file can appear
 * before the port actually listens, so connection refusals are retried until
 * the deadline.
 */
export async function launchHeadlessChrome(options: {
  userDataDir: string;
  chromeBinary?: string;
  windowWidth?: number;
  windowHeight?: number;
  timeoutMs?: number;
}): Promise<LaunchedChrome> {
  const chromeBinary = options.chromeBinary ?? DEFAULT_CHROME_BINARY;
  const width = options.windowWidth ?? CLIP_FRAME_PROFILES.landscape.width;
  const height = options.windowHeight ?? CLIP_FRAME_PROFILES.landscape.height;
  const timeoutMs = options.timeoutMs ?? 30_000;
  await fs.mkdir(options.userDataDir, { recursive: true, mode: 0o700 });
  const portFile = path.join(options.userDataDir, "DevToolsActivePort");
  await fs.rm(portFile, { force: true });

  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${options.userDataDir}`,
    `--window-size=${width},${height}`,
    "--mute-audio",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  const child = spawn(chromeBinary, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
  });
  let exited = false;
  const exitPromise = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });

  const deadline = Date.now() + timeoutMs;
  let devtoolsPort: number | null = null;
  let versionInfo: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `Chrome exited before DevTools became ready. stderr tail:\n${stderrTail}`,
      );
    }
    if (devtoolsPort === null) {
      try {
        const contents = await fs.readFile(portFile, "utf8");
        const parsed = Number.parseInt(contents.split("\n")[0] ?? "", 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          devtoolsPort = parsed;
        }
      } catch {
        // Port file not written yet.
      }
    }
    if (devtoolsPort !== null) {
      try {
        versionInfo = await httpGetJson(
          `http://127.0.0.1:${devtoolsPort}/json/version`,
        );
        break;
      } catch {
        // The port file can exist before the endpoint listens; keep polling.
      }
    }
    await sleep(100);
  }
  if (devtoolsPort === null || versionInfo === null) {
    child.kill("SIGKILL");
    throw new Error(
      `DevTools endpoint not ready within ${timeoutMs}ms (port=${devtoolsPort ?? "unknown"}). stderr tail:\n${stderrTail}`,
    );
  }
  const browserWsUrl = versionInfo["webSocketDebuggerUrl"];
  if (typeof browserWsUrl !== "string" || browserWsUrl === "") {
    child.kill("SIGKILL");
    throw new Error("Chrome /json/version returned no webSocketDebuggerUrl");
  }
  const browserVersion =
    typeof versionInfo["Browser"] === "string"
      ? (versionInfo["Browser"] as string)
      : "unknown";

  return {
    process: child,
    userDataDir: options.userDataDir,
    devtoolsPort,
    browserWsUrl,
    browserVersion,
    dispose: async () => {
      if (!exited) {
        child.kill("SIGKILL");
      }
      await Promise.race([exitPromise, sleep(5000)]);
    },
  };
}

// ---------------------------------------------------------------------------
// Screencast frame collector
// ---------------------------------------------------------------------------

export interface ScreencastStats {
  frameCount: number;
  /** Chrome capture timestamps (epoch seconds) per frame. */
  timestamps: number[];
}

/**
 * Collect Page.screencastFrame events for one flat CDP session into a frames
 * directory (fNNNNN.jpg), acking every frame with Page.screencastFrameAck and
 * recording the capture timestamps for the concat demuxer.
 */
export class ScreencastCollector {
  private unsubscribe: (() => void) | null = null;
  private frameCount = 0;
  private readonly timestamps: number[] = [];

  constructor(
    private readonly cdp: CdpClient,
    private readonly sessionId: string,
    private readonly framesDir: string,
  ) {}

  async start(
    options: { quality?: number; maxWidth?: number; maxHeight?: number } = {},
  ): Promise<void> {
    if (this.unsubscribe !== null) {
      throw new Error("screencast already started");
    }
    await fs.mkdir(this.framesDir, { recursive: true });
    this.unsubscribe = this.cdp.on(
      "Page.screencastFrame",
      (params, sessionId) => {
        if (sessionId !== this.sessionId) return;
        const data = params["data"];
        const metadata = params["metadata"] as
          | { timestamp?: number }
          | undefined;
        const ackId = params["sessionId"];
        if (typeof data === "string") {
          const index = this.frameCount++;
          this.timestamps.push(
            typeof metadata?.timestamp === "number"
              ? metadata.timestamp
              : Date.now() / 1000,
          );
          // Synchronous write keeps ordering trivial; frames are ~100 KB and
          // the spike measures whether this keeps up (it did).
          fsSync.writeFileSync(
            path.join(this.framesDir, frameFileName(index)),
            Buffer.from(data, "base64"),
          );
        }
        if (typeof ackId === "number") {
          void this.cdp
            .send(
              "Page.screencastFrameAck",
              { sessionId: ackId },
              this.sessionId,
            )
            .catch(() => {
              // Ack failures after stopScreencast are benign.
            });
        }
      },
    );
    await this.cdp.send(
      "Page.startScreencast",
      {
        format: "jpeg",
        quality: options.quality ?? 90,
        maxWidth: options.maxWidth ?? CLIP_FRAME_PROFILES.landscape.width,
        maxHeight: options.maxHeight ?? CLIP_FRAME_PROFILES.landscape.height,
        everyNthFrame: 1,
      },
      this.sessionId,
    );
  }

  async stop(): Promise<ScreencastStats> {
    await this.cdp.send("Page.stopScreencast", {}, this.sessionId).catch(() => {
      // Stopping after the page/session is gone is fine.
    });
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    return { frameCount: this.frameCount, timestamps: [...this.timestamps] };
  }
}
