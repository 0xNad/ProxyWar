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
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_CHROME_BINARY =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const DEFAULT_FFMPEG_BINARY = path.join(
  os.homedir(),
  "Library/Python/3.9/lib/python/site-packages/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1",
);

export const FFMPEG_BIN_ENV = "PROXYWAR_CLIP_FFMPEG_BIN";

export const FONT_ARIAL = "/System/Library/Fonts/Supplemental/Arial.ttf";
export const FONT_ARIAL_BOLD =
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf";
export const FONT_ARIAL_BLACK =
  "/System/Library/Fonts/Supplemental/Arial Black.ttf";

/** Slate background color, ported from assemble.py's endcard (0x0e0e12). */
export const SLATE_BACKGROUND = "0x0e0e12";
/** Gold accent, ported from assemble.py's endcard line color. */
// The broadcast's amber (#ffc24a, set on body.ai-league-native-spectator-ui,
// which beats the :root token). ffmpeg wants 0xRRGGBB. This read 0xF4A64A and
// called it canonical, so a clip's end slate came out a different amber from
// the broadcast it was cut from — see ReplayShareImage's ACCENT for the
// measurement.
export const SLATE_ACCENT = "0xFFC24A";

export const CLIP_FPS = 30;
export const CLIP_CRF = 21;
/** Shared mp4 track timescale so the slate concat (-c copy) stays clean. */
export const CLIP_TIMESCALE = 15360;

/** One ffmpeg phase must fail before it can consume the parent 6-minute cap. */
export const DEFAULT_FFMPEG_TIMEOUT_MS = 120_000;

/** A wedged page/main thread must fail one CDP command, not the whole job. */
export const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 30_000;

/** A TCP peer that never completes the WebSocket upgrade must fail promptly. */
export const DEFAULT_CDP_CONNECT_TIMEOUT_MS = 10_000;

/** Launcher failures must reap Chrome and its descendants before returning. */
const CHROME_PROCESS_TREE_CLEANUP_TIMEOUT_MS = 5_000;

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

/**
 * Replay-page URL for a render, carrying the render fast-forward target so
 * the page coalesces presentation below the park turn instead of running the
 * full per-turn pipeline for tens of thousands of skipped turns (the
 * 2026-07-22 end-anchor render timeout). Pacing-only: the parameter cannot
 * expose content a plain replay page does not already hold.
 */
export function clipReplayPageUrl(options: {
  baseUrl: string;
  runId: string;
  fastForwardUntilTurn: number;
}): string {
  const base = `${options.baseUrl.replace(/\/$/, "")}/ai-league-replay/${options.runId}`;
  if (
    !Number.isSafeInteger(options.fastForwardUntilTurn) ||
    options.fastForwardUntilTurn <= 0
  ) {
    return base;
  }
  // "fastest" drops the inter-turn delay entirely so the capture advances as
  // fast as the sim + presentation pipeline sustains (LocalServer still caps the
  // un-executed backlog, so this is bounded). The window is sized for that rate
  // and the encoder pins the final body length, so a pipeline-dependent capture
  // time cannot produce a wildly long or short clip.
  return `${base}?renderFastForwardUntilTurn=${options.fastForwardUntilTurn}&renderReplaySpeed=fastest`;
}

/**
 * Resolves the capture window for an anchor against the record's terminal tick.
 *
 * Auto-clips anchor on the FINAL released moment, so the naive
 * `[anchor - lead, anchor + tail]` window always overruns the record end —
 * the capture then waits for a tick that can never arrive and the render
 * dies on its own timeout (2026-07-22 incident, second failure mode). The
 * window is clamped to the post-execution terminal tick and shifted BACK so the payoff clip
 * keeps its full span whenever the record allows.
 */
export function resolveClipCaptureWindow(options: {
  anchorTurn: number;
  leadTicks: number;
  tailTicks: number;
  /** Final visible page tick after all record turns execute, or null when unknown. */
  terminalTick: number | null;
}): { parkTick: number; endTick: number } {
  const span = options.leadTicks + options.tailTicks;
  let endTick = options.anchorTurn + options.tailTicks;
  if (
    options.terminalTick !== null &&
    Number.isSafeInteger(options.terminalTick) &&
    options.terminalTick > 0
  ) {
    endTick = Math.min(endTick, options.terminalTick);
  }
  return { parkTick: Math.max(1, endTick - span), endTick };
}

/**
 * Resolve the validated replay turn upper bound without mistaking sparse
 * storage for record length. This is NOT necessarily a winner's terminal tick:
 * core execution can emit Win below `info.num_turns`, so winner-bearing records
 * must discover that terminal event in-page. A record with
 * `info.num_turns === 50_400` can execute at most through visible tick 50,400;
 * stopping at 50,399 would omit replay turn 50,399.
 *
 * The stored-turn fallback is intentionally used only when canonical metadata
 * is absent or invalid, so a compressed record can never lower its bound merely
 * because an empty tail was omitted. Stored turn numbers are zero-based input
 * indexes, so the fallback upper-bound tick is `last + 1`.
 */
export function resolveReplayRecordUpperBoundTick(
  record: unknown,
): number | null {
  if (record === null || typeof record !== "object") return null;
  const candidate = record as {
    info?: { num_turns?: unknown } | null;
    turns?: unknown;
  };
  const declaredTurnCount = candidate.info?.num_turns;
  if (
    typeof declaredTurnCount === "number" &&
    Number.isSafeInteger(declaredTurnCount) &&
    declaredTurnCount > 0
  ) {
    return declaredTurnCount;
  }

  if (!Array.isArray(candidate.turns)) return null;
  const lastTurn = candidate.turns.at(-1) as
    | { turnNumber?: unknown }
    | undefined;
  return lastTurn !== undefined &&
    typeof lastTurn.turnNumber === "number" &&
    Number.isSafeInteger(lastTurn.turnNumber) &&
    lastTurn.turnNumber >= 0 &&
    lastTurn.turnNumber < Number.MAX_SAFE_INTEGER
    ? lastTurn.turnNumber + 1
    : null;
}

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
  options: { timeoutMs?: number } = {},
): Promise<{ stderr: string }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`ffmpeg timeout must be a positive integer: ${timeoutMs}`);
  }
  return await new Promise((resolve, reject) => {
    execFile(
      ffmpegBinary,
      args,
      {
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
      (error, _stdout, stderr) => {
        if (error) {
          const timedOut =
            "killed" in error &&
            (error as { killed?: unknown }).killed === true;
          reject(
            new Error(
              `${timedOut ? `ffmpeg timed out after ${timeoutMs}ms` : `ffmpeg failed (${error.message.split("\n")[0]})`}:\n${stderr.slice(-2000)}`,
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
    execFile(
      ffmpegBinary,
      ["-version"],
      { timeout: DEFAULT_FFMPEG_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(`ffmpeg binary is not runnable: ${ffmpegBinary}`, {
              cause: error,
            }),
          );
          return;
        }
        resolve(stdout);
      },
    );
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
  /** Per-frame alpha expression (`t` is the input timestamp). */
  alpha?: string;
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
  if (options.alpha !== undefined) {
    parts.push(`alpha='${options.alpha}'`);
  }
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

/** Target body length for a social clip. */
export const CLIP_TARGET_BODY_SECONDS = 20;

/**
 * Never stretch so far that the captured frames can no longer carry the motion.
 * Below this effective rate the body reads as a slideshow rather than playback.
 */
export const CLIP_MIN_EFFECTIVE_FPS = 20;

/**
 * Pin the body length independently of how fast the capture actually ran.
 *
 * Capture rate is pipeline-dependent — emphatically so at `renderReplaySpeed=fastest`,
 * where the inter-turn delay is zero and the rate settles wherever the sim and
 * presentation pipeline land. Leaving body duration equal to capture wall-time
 * therefore makes clip length a function of host load. Scaling every frame
 * duration by one factor pins the total while preserving relative pacing, so a
 * pause in the match still reads as a pause.
 *
 * Only two things bound the scale factor:
 *  - a capture SHORTER than the target is never stretched past
 *    CLIP_MIN_EFFECTIVE_FPS, so a sparse capture yields a shorter honest clip
 *    rather than a slideshow;
 *  - a capture longer than the target is compressed freely (that is the
 *    speed-up that lets one clip cover far more of the match).
 */
export function clampClipDurationsToBudget(
  durations: number[],
  targetSeconds: number = CLIP_TARGET_BODY_SECONDS,
  minEffectiveFps: number = CLIP_MIN_EFFECTIVE_FPS,
): number[] {
  if (durations.length === 0) return durations;
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
    throw new Error(`invalid clip target duration: ${targetSeconds}`);
  }
  if (!Number.isFinite(minEffectiveFps) || minEffectiveFps <= 0) {
    throw new Error(`invalid clip minimum effective fps: ${minEffectiveFps}`);
  }
  const total = durations.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return durations;
  // The longest duration these frames can carry without dropping below the
  // legibility floor. A capture that already exceeds the target is unaffected.
  const maxSupportedSeconds = durations.length / minEffectiveFps;
  const effectiveTarget = Math.min(targetSeconds, maxSupportedSeconds);
  if (effectiveTarget >= total) return durations;
  const scale = effectiveTarget / total;
  return durations.map((value) => Math.max(0.001, value * scale));
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

/** Slate default length. Long enough to read the CTA without stalling the clip. */
export const SLATE_SECONDS = 3;

/**
 * Staggered reveal alpha for one slate element: hard 0 before `startSeconds`,
 * then a linear ramp to opaque over `rampSeconds`.
 *
 * drawtext evaluates `alpha` per frame with `t` bound to the slate-local
 * timestamp, so this needs no separate overlay pass.
 */
function revealAlpha(
  startSeconds: number,
  peak: number,
  rampSeconds = 0.32,
): string {
  return `if(lt(t,${startSeconds.toFixed(2)}),0,min(${peak},(t-${startSeconds.toFixed(2)})*${(peak / rampSeconds).toFixed(3)}))`;
}

/**
 * Build the end slate: a dark vignetted card that the gameplay settles into,
 * with the wordmark, an accent rule that wipes out from center, the tagline and
 * the CTA revealed in sequence, then a clean fade to black.
 *
 * NO LICENSE TEXT IS BURNED INTO THE FRAME. CC BY-SA 4.0 §3(a)(2) allows
 * attribution "in any reasonable manner based on the medium", and the repo's own
 * asset audit resolves that as once per post in a reasonable place. The
 * attribution and no-endorsement strings instead travel with the file in the mp4
 * container metadata (see buildFinalMuxArgs) and in the share caption the clip
 * service already returns, which reaches the reader far more reliably than a
 * 20px line held for two seconds.
 */
export function buildSlateArgs(options: {
  outPath: string;
  title: string;
  taglineText: string;
  ctaText: string;
  /** Embedded in mp4 metadata by buildFinalMuxArgs, never drawn on the frame. */
  attributionText: string;
  /** Embedded in mp4 metadata by buildFinalMuxArgs, never drawn on the frame. */
  noEndorsementText: string;
  seconds?: number;
  width?: number;
  height?: number;
}): string[] {
  const seconds = options.seconds ?? SLATE_SECONDS;
  const { width, height } = frameSize(options);
  // With the license block gone the composition is optically centered instead
  // of pinned above a footer, so the wordmark carries the frame.
  const titleSize = Math.round(height * 0.115);
  const taglineSize = Math.round(height * 0.034);
  const ctaSize = Math.round(height * 0.046);
  const titleY = height * 0.5 - titleSize - height * 0.045;
  const ruleY = Math.round(height * 0.5 + height * 0.012);
  const ruleHeight = Math.max(2, Math.round(height * 0.004));
  const ruleWidth = Math.round(width * 0.16);
  // Center-out wipe: half-width per side grows over ~0.26s from `ruleStart`.
  const ruleStart = 0.5;
  const ruleGrowthPxPerSecond = (ruleWidth / 0.26).toFixed(0);
  const ruleCurrentWidth = `min(${ruleWidth},max(0,(t-${ruleStart})*${ruleGrowthPxPerSecond}))`;

  const drawtexts = [
    drawtext({
      fontFile: FONT_ARIAL_BLACK,
      text: options.title,
      fontColor: "white",
      fontSize: titleSize,
      x: "(w-text_w)/2",
      y: `${titleY.toFixed(0)}`,
      alpha: revealAlpha(0.22, 1),
    }),
    // Accent rule under the wordmark, wiping outward from the center.
    `drawbox=x='(iw-${ruleCurrentWidth})/2':y=${ruleY}:w='${ruleCurrentWidth}':h=${ruleHeight}:color=${SLATE_ACCENT}@0.95:t=fill`,
    drawtext({
      fontFile: FONT_ARIAL,
      text: options.taglineText,
      fontColor: "white",
      fontSize: taglineSize,
      x: "(w-text_w)/2",
      y: `${(height * 0.5 + height * 0.045).toFixed(0)}`,
      alpha: revealAlpha(0.68, 0.74),
    }),
    drawtext({
      fontFile: FONT_ARIAL_BOLD,
      text: options.ctaText,
      fontColor: SLATE_ACCENT,
      fontSize: ctaSize,
      x: "(w-text_w)/2",
      y: `${(height * 0.5 + height * 0.115).toFixed(0)}`,
      alpha: revealAlpha(0.92, 1),
    }),
  ];
  const fadeOutStart = Math.max(0, seconds - 0.45).toFixed(2);
  const filters = [
    // Radial falloff gives the flat card depth without a second input.
    "vignette=angle=PI/5",
    ...drawtexts,
    // Fade in absorbs the cut from gameplay; fade out ends the clip cleanly
    // instead of snapping to the next loop.
    "fade=t=in:st=0:d=0.38",
    `fade=t=out:st=${fadeOutStart}:d=0.45`,
  ];
  return [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${SLATE_BACKGROUND}:s=${width}x${height}:d=${seconds}`,
    "-vf",
    filters.join(","),
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
 * Final mux: concat body+slate (-c copy), add a silent stereo AAC track, carry
 * the CC BY-SA attribution in container metadata, and set +faststart (moov
 * before mdat).
 *
 * The attribution lives here rather than burned into the slate. CC BY-SA 4.0
 * §3(a)(2) permits attribution "in any reasonable manner based on the medium",
 * and metadata satisfies it in a way that survives re-hosting and download —
 * unlike on-frame text, which is lost the moment anyone re-encodes or crops.
 * The clip service's share caption carries the same strings for the reader.
 */
export function buildFinalMuxArgs(options: {
  listPath: string;
  outPath: string;
  attributionText?: string;
  noEndorsementText?: string;
}): string[] {
  const credit = [options.attributionText, options.noEndorsementText]
    .filter((line): line is string => line !== undefined && line.trim() !== "")
    .join(" ");
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
    ...(credit === ""
      ? []
      : ["-metadata", `comment=${credit}`, "-metadata", `copyright=${credit}`]),
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
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export interface CdpClientConnectOptions {
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
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

  private constructor(
    private readonly ws: WebSocket,
    private readonly commandTimeoutMs: number,
  ) {
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("close", () => this.failAllPending(new Error("CDP socket closed")));
    ws.on("error", (error) =>
      this.failAllPending(
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
  }

  static async connect(
    wsUrl: string,
    options: CdpClientConnectOptions = {},
  ): Promise<CdpClient> {
    const commandTimeoutMs =
      options.commandTimeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS;
    const connectTimeoutMs =
      options.connectTimeoutMs ?? DEFAULT_CDP_CONNECT_TIMEOUT_MS;
    if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs <= 0) {
      throw new Error(
        `CDP command timeout must be a positive integer: ${commandTimeoutMs}`,
      );
    }
    if (!Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs <= 0) {
      throw new Error(
        `CDP connect timeout must be a positive integer: ${connectTimeoutMs}`,
      );
    }
    const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
    return await new Promise<CdpClient>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearHandshakeListeners();
        // `terminate()` while CONNECTING emits an error; retain a listener so
        // the deliberately aborted socket cannot surface an unhandled event.
        ws.once("error", () => undefined);
        ws.terminate();
        reject(new Error(`CDP connect timed out after ${connectTimeoutMs}ms`));
      }, connectTimeoutMs);
      timer.unref?.();

      const clearHandshakeListeners = (): void => {
        clearTimeout(timer);
        ws.off("open", handleOpen);
        ws.off("error", handleError);
        ws.off("close", handleClose);
      };
      const handleOpen = (): void => {
        if (settled) return;
        settled = true;
        clearHandshakeListeners();
        // Install the long-lived listeners synchronously in the open handler,
        // leaving no gap in which an immediate close could go unobserved.
        resolve(new CdpClient(ws, commandTimeoutMs));
      };
      const handleError = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearHandshakeListeners();
        reject(new Error(`CDP connect failed: ${String(error)}`));
      };
      const handleClose = (): void => {
        if (settled) return;
        settled = true;
        clearHandshakeListeners();
        reject(new Error("CDP connect failed: socket closed before open"));
      };
      ws.once("open", handleOpen);
      ws.once("error", handleError);
      ws.once("close", handleClose);
    });
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
      clearTimeout(pending.timeout);
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
      clearTimeout(pending.timeout);
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
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        pending.reject(
          new Error(`CDP ${method} timed out after ${this.commandTimeoutMs}ms`),
        );
      }, this.commandTimeoutMs);
      timeout.unref?.();
      this.pending.set(id, { method, timeout, resolve, reject });
      const rejectSend = (error: unknown): void => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(
          new Error(`CDP ${method} send failed: ${String(error)}`),
        );
      };
      try {
        this.ws.send(payload, (error) => {
          if (error) rejectSend(error);
        });
      } catch (error) {
        rejectSend(error);
      }
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

async function waitForResolutionOrTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  if (timeoutMs <= 0) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    void promise.then(finish, finish);
  });
}

interface ProcessTableRow {
  pid: number;
  parentPid: number;
  processGroupId: number;
  status: string;
}

interface ProcessTableSnapshot {
  rows: ProcessTableRow[];
  inspectorPid: number | null;
}

async function readProcessTable(): Promise<ProcessTableSnapshot> {
  let inspectorPid: number | null = null;
  const stdout = await new Promise<string>((resolve, reject) => {
    const inspector = execFile(
      "/bin/ps",
      ["-axo", "pid=,ppid=,pgid=,stat="],
      { timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 },
      (error, output) => {
        if (error) {
          reject(
            new Error(
              `could not inspect Chrome process tree: ${error.message}`,
            ),
          );
          return;
        }
        resolve(output);
      },
    );
    inspectorPid = inspector.pid ?? null;
  });
  const rows: ProcessTableRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (match === null) continue;
    const pid = Number.parseInt(match[1], 10);
    const parentPid = Number.parseInt(match[2], 10);
    const processGroupId = Number.parseInt(match[3], 10);
    const status = match[4];
    if (pid > 0 && parentPid >= 0 && processGroupId > 0) {
      rows.push({ pid, parentPid, processGroupId, status });
    }
  }
  return { rows, inspectorPid };
}

async function currentProcessGroupId(): Promise<number> {
  const current = (await readProcessTable()).rows.find(
    (row) => row.pid === process.pid,
  );
  if (current === undefined) {
    throw new Error(
      `could not resolve clip worker process group for PID ${process.pid}`,
    );
  }
  return current.processGroupId;
}

function descendantsOf(
  rootPid: number,
  rows: readonly ProcessTableRow[],
): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.parentPid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.parentPid, children);
  }
  const descendants = new Set<number>();
  const pending = [...(childrenByParent.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop();
    if (pid === undefined || descendants.has(pid)) continue;
    descendants.add(pid);
    pending.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function signalProcessIfPresent(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * Reap one spawned Chrome subtree without killing the worker that owns it.
 *
 * Chrome intentionally inherits the detached clip worker's process group so
 * the server's outer timeout can kill that whole group. From inside the worker
 * we cannot signal the negative PGID: that would kill the worker before it can
 * report a launch error. Instead, use that dedicated PGID as the ownership
 * boundary (excluding the worker and exact `ps` inspector), repeatedly stop
 * every member until the group is stable, then SIGKILL and confirm every
 * captured PID has disappeared. Non-detached callers fall back to a rooted
 * subtree so a shared shell/test PGID is never signalled.
 */
async function terminateChromeProcessTree(
  child: ChildProcess,
  closePromise: Promise<void>,
  workerProcessGroupId: number,
): Promise<void> {
  const rootPid = child.pid;
  const deadline = Date.now() + CHROME_PROCESS_TREE_CLEANUP_TIMEOUT_MS;
  const capturedPids = new Set<number>();
  // ReplayPremiereClips spawns the worker detached, so its PID is also its
  // PGID. That dedicated group is the durable ownership boundary even after a
  // Chrome root/helper exits and its surviving children are reparented. In a
  // non-detached test or ad-hoc caller, never touch the caller's shared group;
  // use only the still-rooted Chrome subtree.
  const ownsDedicatedWorkerGroup = workerProcessGroupId === process.pid;
  const rootedChromeIsRunning =
    rootPid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null;
  if (!ownsDedicatedWorkerGroup && rootedChromeIsRunning) {
    capturedPids.add(rootPid);
  }
  let inspectionError: Error | null = null;
  try {
    if (!ownsDedicatedWorkerGroup && rootedChromeIsRunning) {
      signalProcessIfPresent(rootPid, "SIGSTOP");
    }
    let stableSnapshots = 0;
    while (Date.now() < deadline && stableSnapshots < 2) {
      const before = capturedPids.size;
      const snapshot = await readProcessTable();
      const rows = snapshot.rows;
      const ownedPids = ownsDedicatedWorkerGroup
        ? rows
            .filter(
              (row) =>
                row.processGroupId === workerProcessGroupId &&
                row.pid !== process.pid &&
                row.pid !== snapshot.inspectorPid,
            )
            .map((row) => row.pid)
        : rootPid === undefined
          ? []
          : [...descendantsOf(rootPid, rows)];
      for (const pid of ownedPids) {
        capturedPids.add(pid);
        signalProcessIfPresent(pid, "SIGSTOP");
      }
      stableSnapshots = capturedPids.size === before ? stableSnapshots + 1 : 0;
      if (stableSnapshots < 2) await sleep(10);
    }
  } catch (error) {
    inspectionError = error instanceof Error ? error : new Error(String(error));
  } finally {
    // Descendants first is mostly documentary because every captured process
    // is stopped, but it also prevents a child from briefly outliving the root.
    for (const pid of [...capturedPids].reverse()) {
      signalProcessIfPresent(pid, "SIGKILL");
    }
  }

  const closeRemainingMs = Math.max(0, deadline - Date.now());
  await waitForResolutionOrTimeout(closePromise, closeRemainingMs);
  let survivors = await liveCapturedProcessIds(
    capturedPids,
    ownsDedicatedWorkerGroup ? workerProcessGroupId : null,
  );
  while (survivors.length > 0 && Date.now() < deadline) {
    await sleep(25);
    survivors = await liveCapturedProcessIds(
      new Set(survivors),
      ownsDedicatedWorkerGroup ? workerProcessGroupId : null,
    );
  }
  if (inspectionError !== null) throw inspectionError;
  if (survivors.length > 0) {
    throw new Error(
      `Chrome process-tree cleanup timed out; surviving PIDs: ${survivors.join(",")}`,
    );
  }
}

async function liveCapturedProcessIds(
  capturedPids: ReadonlySet<number>,
  ownedProcessGroupId: number | null,
): Promise<number[]> {
  if (capturedPids.size === 0) return [];
  const rowsByPid = new Map(
    (await readProcessTable()).rows.map((row) => [row.pid, row]),
  );
  return [...capturedPids].filter((pid) => {
    const row = rowsByPid.get(pid);
    if (row === undefined || row.status.startsWith("Z")) return false;
    // If a captured PID was already reaped and reused, never treat a process
    // outside the dedicated worker group as owned Chrome state.
    return (
      ownedProcessGroupId === null || row.processGroupId === ownedProcessGroupId
    );
  });
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
  // Resolve the boundary before spawning. If ownership cannot be proven, fail
  // before Chrome exists rather than creating a process we cannot safely reap.
  const workerProcessGroupId = await currentProcessGroupId();
  const child = spawn(chromeBinary, args, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
  });
  let exited = false;
  const launchState: { spawnError: Error | null } = { spawnError: null };
  child.once("error", (error) => {
    launchState.spawnError = error;
  });
  const closePromise = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
    });
    child.once("close", () => {
      exited = true;
      resolve();
    });
  });

  try {
    const deadline = Date.now() + timeoutMs;
    let devtoolsPort: number | null = null;
    let versionInfo: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      if (exited) {
        const spawnErrorSuffix =
          launchState.spawnError === null
            ? ""
            : ` (${launchState.spawnError.message})`;
        throw new Error(
          `Chrome exited before DevTools became ready${spawnErrorSuffix}. stderr tail:\n${stderrTail}`,
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
      throw new Error(
        `DevTools endpoint not ready within ${timeoutMs}ms (port=${devtoolsPort ?? "unknown"}). stderr tail:\n${stderrTail}`,
      );
    }
    const browserWsUrl = versionInfo["webSocketDebuggerUrl"];
    if (typeof browserWsUrl !== "string" || browserWsUrl === "") {
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
        await terminateChromeProcessTree(
          child,
          closePromise,
          workerProcessGroupId,
        );
      },
    };
  } catch (launchError) {
    try {
      await terminateChromeProcessTree(
        child,
        closePromise,
        workerProcessGroupId,
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [launchError, cleanupError],
        `Chrome launch failed and process-tree cleanup did not complete: ${String(launchError)}`,
        { cause: cleanupError },
      );
    }
    throw launchError;
  }
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
