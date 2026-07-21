/**
 * Replay Premiere clip worker (Phase A spike).
 *
 * Usage: tsx src/scripts/replay-premiere-clip-worker.ts <jobspec.json>
 *
 * Job spec:
 * {
 *   "premiereId": string,
 *   "bundlePath": string,            // admitted premiere bundle (read-only)
 *   "expectedBundleSha256": string,  // must match EXACTLY before anything else
 *   "anchorTurn": number,            // clip covers [anchorTurn-50, anchorTurn+150]
 *   "clipVersion": number,
 *   "outDir": string,                // clip.mp4 + render-manifest.json + frame dumps
 *   "staticDir": string,             // built client (served read-only over loopback)
 *   "captureMode"?: "screencast" | "tick-step"
 * }
 *
 * Pipeline: verify bundle sha256 -> stage embedded gameRecord -> ephemeral
 * loopback static host -> headless Chrome via CDP (pre-injected pause spam,
 * overlay-hiding CSS, per-frame centerAll camera lock) -> park at
 * anchorTurn-50 -> tick-bounded capture to anchorTurn+150 -> ffmpeg assembly
 * (watermark + licensed end slate + silent AAC + faststart) -> atomic
 * clip.mp4 / render-manifest.json writes.
 */

import ejs from "ejs";
import express from "express";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAssetUrl, type AssetManifest } from "../core/AssetUrls";
import {
  buildClipEncodeArgs,
  buildConcatFileContent,
  buildConcatListContent,
  buildFinalMuxArgs,
  buildFrameExtractArgs,
  buildSlateArgs,
  CdpClient,
  CLIP_FPS,
  CLIP_HEIGHT,
  CLIP_WIDTH,
  durationsFromTimestamps,
  FONT_ARIAL,
  FONT_ARIAL_BLACK,
  FONT_ARIAL_BOLD,
  frameFileName,
  launchHeadlessChrome,
  resolveFfmpegBinary,
  runFfmpeg,
  ScreencastCollector,
  sha256OfBuffer,
  sha256OfFile,
  verifyFfmpeg,
  type LaunchedChrome,
} from "./replay-premiere-clip-render-lib";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");

const CAPTURE_LEAD_TICKS = 50;
const CAPTURE_TAIL_TICKS = 150;
const TICK_STEP_ENCODED_FRAMES_PER_TICK = 3;
const WATERMARK_TEXT = "beta.proxywar.xyz/league";
const SLATE_TITLE = "Proxy War";

/** Third-party script hosts referenced by index.html; blocked for hermetic renders. */
const BLOCKED_URL_PATTERNS = [
  "*://sdk.crazygames.com/*",
  "*://challenges.cloudflare.com/*",
  "*://www.googletagmanager.com/*",
  "*://www.google-analytics.com/*",
];

interface ClipJobSpec {
  premiereId: string;
  bundlePath: string;
  expectedBundleSha256: string;
  anchorTurn: number;
  clipVersion: number;
  outDir: string;
  staticDir: string;
  captureMode?: "screencast" | "tick-step";
}

interface Timings {
  ffmpegVerifyMs: number;
  bundleVerifyMs: number;
  serverStartMs: number;
  chromeLaunchMs: number;
  pageLoadToFirstFrameMs: number;
  parkMs: number;
  captureMs: number;
  encodeMs: number;
  totalMs: number;
}

function log(message: string): void {
  console.log(`[clip-worker] ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Job spec + inputs
// ---------------------------------------------------------------------------

async function readJobSpec(specPath: string): Promise<ClipJobSpec> {
  const raw = JSON.parse(await fs.readFile(specPath, "utf8")) as Record<
    string,
    unknown
  >;
  const requireString = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string" || value.trim() === "") {
      fail(`job spec field "${key}" must be a non-empty string`);
    }
    return value;
  };
  const requireNumber = (key: string): number => {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail(`job spec field "${key}" must be a finite number`);
    }
    return value;
  };
  const captureMode = raw["captureMode"];
  if (
    captureMode !== undefined &&
    captureMode !== "screencast" &&
    captureMode !== "tick-step"
  ) {
    fail(`job spec field "captureMode" must be "screencast" or "tick-step"`);
  }
  const anchorTurn = requireNumber("anchorTurn");
  if (anchorTurn <= CAPTURE_LEAD_TICKS) {
    fail(`anchorTurn must be > ${CAPTURE_LEAD_TICKS}`);
  }
  return {
    premiereId: requireString("premiereId"),
    bundlePath: requireString("bundlePath"),
    expectedBundleSha256: requireString("expectedBundleSha256").toLowerCase(),
    anchorTurn,
    clipVersion: requireNumber("clipVersion"),
    outDir: requireString("outDir"),
    staticDir: requireString("staticDir"),
    captureMode: captureMode as ClipJobSpec["captureMode"],
  };
}

async function readLicenseStrings(): Promise<{
  attribution: string;
  noEndorsement: string;
}> {
  const langPath = path.join(REPO_ROOT, "resources/lang/en.json");
  const lang = JSON.parse(await fs.readFile(langPath, "utf8")) as {
    replay_premiere?: Record<string, unknown>;
  };
  const attribution = lang.replay_premiere?.["asset_attribution"];
  const noEndorsement = lang.replay_premiere?.["no_endorsement"];
  if (typeof attribution !== "string" || typeof noEndorsement !== "string") {
    fail(
      "resources/lang/en.json is missing replay_premiere.asset_attribution / replay_premiere.no_endorsement",
    );
  }
  return { attribution, noEndorsement };
}

/**
 * Verify the bundle hash EXACTLY matches the job spec, then extract the
 * embedded gameRecord. The record may be compressed (sparse turns); the client
 * decompresses via decompressGameRecord (src/core/Util.ts), exactly as the
 * /ai-league-replay/<run-id> route does for game-record.json, so it is staged
 * verbatim.
 */
async function verifyAndExtractRecord(spec: ClipJobSpec): Promise<{
  sourceReplaySha256: string;
  recordJson: string;
}> {
  const bundleBytes = await fs.readFile(spec.bundlePath);
  const actualSha = sha256OfBuffer(bundleBytes);
  if (actualSha !== spec.expectedBundleSha256) {
    fail(
      `bundle sha256 mismatch: expected ${spec.expectedBundleSha256}, got ${actualSha} (${spec.bundlePath})`,
    );
  }
  const bundle = JSON.parse(bundleBytes.toString("utf8")) as Record<
    string,
    unknown
  >;
  const record =
    bundle["gameRecord"] ??
    (typeof bundle["info"] === "object" && Array.isArray(bundle["turns"])
      ? bundle
      : null);
  if (record === null || typeof record !== "object") {
    fail(`bundle has no embedded gameRecord: ${spec.bundlePath}`);
  }
  return {
    sourceReplaySha256: actualSha,
    recordJson: JSON.stringify(record),
  };
}

// ---------------------------------------------------------------------------
// Ephemeral loopback static host
// ---------------------------------------------------------------------------

/**
 * Render the built client's EJS index.html the way src/server/RenderHtml.ts
 * does, but against the job's staticDir (its own asset-manifest.json) with a
 * same-origin CDN base, so every asset resolves against the loopback host.
 */
async function renderIndexHtml(staticDir: string): Promise<string> {
  const htmlTemplate = await fs.readFile(
    path.join(staticDir, "index.html"),
    "utf8",
  );
  let assetManifest: AssetManifest = {};
  try {
    assetManifest = JSON.parse(
      await fs.readFile(path.join(staticDir, "asset-manifest.json"), "utf8"),
    ) as AssetManifest;
  } catch {
    // No manifest -> un-fingerprinted asset paths.
  }
  return ejs.render(htmlTemplate, {
    gitCommit: JSON.stringify("premiere-clip-render"),
    assetManifest: JSON.stringify(assetManifest),
    cdnBase: JSON.stringify(""),
    cdnBaseRaw: "",
    // Server config choice is inert for replays (all server configs share
    // turnIntervalMs()=100; game-logic config is baked into the bundle at
    // build time and parameterized by the record's own gameConfig).
    gameEnv: JSON.stringify("prod"),
    manifestHref: buildAssetUrl("manifest.json", assetManifest, ""),
    faviconHref: buildAssetUrl("images/Favicon.svg", assetManifest, ""),
    gameplayScreenshotUrl: buildAssetUrl(
      "images/GameplayScreenshot.png",
      assetManifest,
      "",
    ),
    backgroundImageUrl: buildAssetUrl(
      "images/background.webp",
      assetManifest,
      "",
    ),
    desktopLogoImageUrl: buildAssetUrl(
      "images/OpenFront.png",
      assetManifest,
      "",
    ),
    mobileLogoImageUrl: buildAssetUrl("images/OF.png", assetManifest, ""),
  });
}

interface StaticHost {
  port: number;
  replayUrl: string;
  close(): Promise<void>;
}

async function startStaticHost(options: {
  staticDir: string;
  runId: string;
  stagedRecordPath: string;
}): Promise<StaticHost> {
  const indexHtml = await renderIndexHtml(options.staticDir);
  const recordRoute = `/ai-league-runs/${options.runId}/game-record.json`;
  const app = express();
  app.disable("x-powered-by");
  // Exact-path middleware (no route patterns; express 5 path-to-regexp is
  // stricter and none are needed here).
  app.use((req, res, next) => {
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      req.path === recordRoute
    ) {
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(options.stagedRecordPath);
      return;
    }
    next();
  });
  app.use(
    express.static(options.staticDir, { index: false, fallthrough: true }),
  );
  app.use((req, res, next) => {
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      req.path.startsWith("/ai-league-replay/")
    ) {
      res.setHeader("Cache-Control", "no-store");
      res.type("html").send(indexHtml);
      return;
    }
    next();
  });

  const server: Server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  if (address === null || typeof address !== "object") {
    fail("static host did not report a bound port");
  }
  const port = address.port;
  return {
    port,
    replayUrl: `http://127.0.0.1:${port}/ai-league-replay/${options.runId}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

// ---------------------------------------------------------------------------
// Page scripting
// ---------------------------------------------------------------------------

/**
 * Injected via Page.addScriptToEvaluateOnNewDocument (runs at document start,
 * before any client code):
 *  (a) the client's own promo capture lock (__openFrontPromoCaptureLock) so
 *      the ai-league replay path pauses at join instead of switching to
 *      fastest speed (src/client/Main.ts join-lobby handler) — playback then
 *      stays at the default 1x (~10 ticks/s), plus pause-spam as a fallback
 *      until the first pause intent lands (pause stops interval queueing,
 *      while jump-turn force-queues to an exact turn — LocalServer.ts),
 *  (b) the promo native-spectator flag (__openFrontPromoNativeUi) so the
 *      always-visible top-left leaderboard mounts, plus CSS hiding the replay
 *      overlay, story timeline, social/headline chrome, top-right HUD and the
 *      player panel — KEEPING the leaderboard (licensing requires
 *      recognizable in-game frames; the June-era "Replay mode" banner no
 *      longer exists in the client),
 *  (c) a per-frame centerAll() camera lock (zoom drifts otherwise).
 */
function preInjectSource(): string {
  return `(() => {
  if (window.__pwClip) return;
  window.__openFrontPromoCaptureLock = true;
  window.__openFrontPromoNativeUi = true;
  const state = {
    lastTick: null,
    firstTickAtMs: null,
    pauseSpam: null,
    hashWarnings: 0,
    consoleErrors: 0,
  };
  window.__pwClip = state;
  document.addEventListener("ai-league-replay-frame", (event) => {
    const tick = event && event.detail ? event.detail.tick : null;
    if (typeof tick === "number") {
      state.lastTick = tick;
      if (state.firstTickAtMs === null) state.firstTickAtMs = Date.now();
    }
  });
  state.pauseSpam = setInterval(() => {
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-pause", { detail: { paused: true } }),
    );
  }, 100);
  state.stopPauseSpam = () => {
    if (state.pauseSpam !== null) {
      clearInterval(state.pauseSpam);
      state.pauseSpam = null;
    }
  };
  const patchConsole = (name, isHashSignal) => {
    const original = console[name].bind(console);
    console[name] = (...args) => {
      try {
        const text = args.map((a) => String(a)).join(" ");
        if (isHashSignal(text)) state.hashWarnings += 1;
        if (name === "error") state.consoleErrors += 1;
      } catch (e) {}
      original(...args);
    };
  };
  patchConsole("warn", (t) => t.includes("no archived hash found"));
  patchConsole("error", (t) => t.includes("desync detected"));
  const style = document.createElement("style");
  style.id = "__pw-clip-style";
  style.textContent =
    "#ai-league-replay-overlay, #ai-league-story-timeline, " +
    "#ai-league-social-transcript, #ai-league-headline-event, " +
    "game-right-sidebar, replay-panel, player-panel { display: none !important; }";
  const attach = () => {
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.documentElement) {
    attach();
  } else {
    document.addEventListener("DOMContentLoaded", attach);
  }
  const cameraLock = () => {
    try {
      if (window.__proxywarTransform) window.__proxywarTransform.centerAll();
    } catch (e) {}
    window.requestAnimationFrame(cameraLock);
  };
  window.requestAnimationFrame(cameraLock);
})();`;
}

interface PageDriver {
  evalValue<T>(expression: string): Promise<T>;
  lastTick(): Promise<number | null>;
  dispatchJump(turnNumber: number): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  waitForTick(
    minTick: number,
    timeoutMs: number,
    pollMs: number,
    label: string,
  ): Promise<number>;
}

function makePageDriver(cdp: CdpClient, sessionId: string): PageDriver {
  const evalValue = async <T>(expression: string): Promise<T> => {
    const result = await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      sessionId,
    );
    const remote = result["result"] as { value?: unknown } | undefined;
    return remote?.value as T;
  };
  const lastTick = () =>
    evalValue<number | null>(
      "window.__pwClip ? window.__pwClip.lastTick : null",
    );
  const driver: PageDriver = {
    evalValue,
    lastTick,
    dispatchJump: async (turnNumber: number) => {
      await evalValue(
        `document.dispatchEvent(new CustomEvent("ai-league-replay-jump-turn", { detail: { turnNumber: ${Math.floor(turnNumber)} } })), true`,
      );
    },
    setPaused: async (paused: boolean) => {
      await evalValue(
        `(() => {
          const state = window.__pwClip;
          if (state && !${paused} && state.stopPauseSpam) state.stopPauseSpam();
          document.dispatchEvent(
            new CustomEvent("ai-league-replay-pause", { detail: { paused: ${paused} } }),
          );
          return true;
        })()`,
      );
    },
    waitForTick: async (minTick, timeoutMs, pollMs, label) => {
      const deadline = Date.now() + timeoutMs;
      let lastLoggedAt = Date.now();
      let tick: number | null = null;
      while (Date.now() < deadline) {
        tick = await lastTick();
        if (tick !== null && tick >= minTick) return tick;
        if (Date.now() - lastLoggedAt >= 5000) {
          lastLoggedAt = Date.now();
          log(`${label}: tick ${tick ?? "none"} / ${minTick}`);
        }
        await sleep(pollMs);
      }
      fail(
        `${label}: tick ${minTick} not reached within ${timeoutMs}ms (last=${tick ?? "none"})`,
      );
    },
  };
  return driver;
}

// ---------------------------------------------------------------------------
// Capture modes
// ---------------------------------------------------------------------------

interface CaptureResult {
  tickStart: number;
  tickEnd: number;
  frameDurations: number[];
  frameCount: number;
  captureMs: number;
  frameTimestamps: number[] | null;
}

/** Default mode: real-time Page.startScreencast while the replay plays at 1x. */
async function captureScreencast(
  driver: PageDriver,
  cdp: CdpClient,
  sessionId: string,
  framesDir: string,
  endTick: number,
): Promise<CaptureResult> {
  const collector = new ScreencastCollector(cdp, sessionId, framesDir);
  await collector.start({
    quality: 90,
    maxWidth: CLIP_WIDTH,
    maxHeight: CLIP_HEIGHT,
  });
  const tickStart = (await driver.lastTick()) ?? fail("no tick before capture");
  const captureStartedAt = Date.now();
  await driver.setPaused(false);
  // Tick-bounded (not wall-clock): 100 ms poll keeps the tail overshoot small.
  // Budget: 200 ticks at ~10 ticks/s nominal, with generous headroom.
  const tickEnd = await driver.waitForTick(endTick, 120_000, 100, "capture");
  await driver.setPaused(true);
  const stats = await collector.stop();
  const captureMs = Date.now() - captureStartedAt;
  if (stats.frameCount < 2) {
    fail(`screencast produced only ${stats.frameCount} frames`);
  }
  return {
    tickStart,
    tickEnd,
    frameCount: stats.frameCount,
    frameDurations: durationsFromTimestamps(stats.timestamps),
    captureMs,
    frameTimestamps: stats.timestamps,
  };
}

/**
 * Fallback mode: stay paused, advance one turn at a time via the jump event
 * (which force-queues regardless of pause), Page.captureScreenshot per tick,
 * and assemble at TICK_STEP_ENCODED_FRAMES_PER_TICK encoded frames per tick.
 */
async function captureTickStep(
  driver: PageDriver,
  cdp: CdpClient,
  sessionId: string,
  framesDir: string,
  startTick: number,
  endTick: number,
): Promise<CaptureResult> {
  await fs.mkdir(framesDir, { recursive: true });
  const captureStartedAt = Date.now();
  const tickStart = (await driver.lastTick()) ?? fail("no tick before capture");
  let frameCount = 0;
  for (let target = startTick + 1; target <= endTick; target++) {
    await driver.dispatchJump(target);
    await driver.waitForTick(target, 30_000, 25, `tick-step ${target}`);
    // Let the camera-lock rAF pass repaint the advanced state.
    await sleep(40);
    const shot = await cdp.send(
      "Page.captureScreenshot",
      { format: "jpeg", quality: 90 },
      sessionId,
    );
    const data = shot["data"];
    if (typeof data !== "string") fail("captureScreenshot returned no data");
    await fs.writeFile(
      path.join(framesDir, frameFileName(frameCount)),
      Buffer.from(data, "base64"),
    );
    frameCount++;
  }
  const tickEnd = (await driver.lastTick()) ?? endTick;
  const captureMs = Date.now() - captureStartedAt;
  const perFrameSeconds = TICK_STEP_ENCODED_FRAMES_PER_TICK / CLIP_FPS;
  return {
    tickStart,
    tickEnd,
    frameCount,
    frameDurations: new Array<number>(frameCount).fill(perFrameSeconds),
    captureMs,
    frameTimestamps: null,
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

async function assembleClip(options: {
  ffmpegBinary: string;
  framesDir: string;
  scratchDir: string;
  outDir: string;
  frameDurations: number[];
  licenseStrings: { attribution: string; noEndorsement: string };
}): Promise<{
  outSha256: string;
  outBytes: number;
  encodeMs: number;
  clipPath: string;
}> {
  const encodeStartedAt = Date.now();
  const concatPath = path.join(options.framesDir, "concat.txt");
  await fs.writeFile(
    concatPath,
    buildConcatFileContent(options.frameDurations),
  );
  const bodyPath = path.join(options.scratchDir, "body.mp4");
  const slatePath = path.join(options.scratchDir, "slate.mp4");
  await runFfmpeg(
    options.ffmpegBinary,
    buildClipEncodeArgs({
      concatPath,
      outPath: bodyPath,
      watermarkText: WATERMARK_TEXT,
    }),
  );
  await runFfmpeg(
    options.ffmpegBinary,
    buildSlateArgs({
      outPath: slatePath,
      title: SLATE_TITLE,
      ctaText: WATERMARK_TEXT,
      attributionText: options.licenseStrings.attribution,
      noEndorsementText: options.licenseStrings.noEndorsement,
      seconds: 2,
    }),
  );
  const listPath = path.join(options.scratchDir, "final-list.txt");
  await fs.writeFile(listPath, buildConcatListContent([bodyPath, slatePath]));
  const tmpClipPath = path.join(
    options.outDir,
    `.clip.mp4.tmp-${randomUUID()}`,
  );
  const clipPath = path.join(options.outDir, "clip.mp4");
  await runFfmpeg(
    options.ffmpegBinary,
    buildFinalMuxArgs({ listPath, outPath: tmpClipPath }),
  );

  // Proof frame dumps from the FINAL clip (watermark + slate license lines).
  const bodySeconds = options.frameDurations.reduce((a, b) => a + b, 0);
  await runFfmpeg(
    options.ffmpegBinary,
    buildFrameExtractArgs({
      videoPath: tmpClipPath,
      atSeconds: Math.max(0, bodySeconds / 2),
      outPath: path.join(options.outDir, "frame-body.jpg"),
    }),
  );
  await runFfmpeg(
    options.ffmpegBinary,
    buildFrameExtractArgs({
      videoPath: tmpClipPath,
      atSeconds: bodySeconds + 1,
      outPath: path.join(options.outDir, "frame-slate.jpg"),
    }),
  );

  const outSha256 = await sha256OfFile(tmpClipPath);
  const outBytes = (await fs.stat(tmpClipPath)).size;
  await fs.rename(tmpClipPath, clipPath);
  return {
    outSha256,
    outBytes,
    encodeMs: Date.now() - encodeStartedAt,
    clipPath,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const totalStartedAt = Date.now();
  const specPath = process.argv[2];
  if (specPath === undefined || specPath.trim() === "") {
    fail(
      "usage: tsx src/scripts/replay-premiere-clip-worker.ts <jobspec.json>",
    );
  }
  const spec = await readJobSpec(specPath);
  const captureMode = spec.captureMode ?? "screencast";
  for (const font of [FONT_ARIAL, FONT_ARIAL_BOLD, FONT_ARIAL_BLACK]) {
    await fs.access(font).catch(() => fail(`required font missing: ${font}`));
  }
  const licenseStrings = await readLicenseStrings();

  const ffmpegBinary = resolveFfmpegBinary();
  const ffmpegVerifyStartedAt = Date.now();
  const ffmpegVersion = await verifyFfmpeg(ffmpegBinary);
  const ffmpegVerifyMs = Date.now() - ffmpegVerifyStartedAt;
  log(`ffmpeg ok: ${ffmpegVersion}`);

  const bundleVerifyStartedAt = Date.now();
  const { sourceReplaySha256, recordJson } = await verifyAndExtractRecord(spec);
  const bundleVerifyMs = Date.now() - bundleVerifyStartedAt;
  log(`bundle verified: sha256=${sourceReplaySha256}`);

  await fs.mkdir(spec.outDir, { recursive: true, mode: 0o700 });
  const scratchBase = process.env.PROXYWAR_CLIP_SCRATCH_DIR ?? os.tmpdir();
  await fs.mkdir(scratchBase, { recursive: true });
  const scratchDir = await fs.mkdtemp(path.join(scratchBase, "pw-clip-"));
  const framesDir = path.join(scratchDir, "frames");

  let host: StaticHost | null = null;
  let chrome: LaunchedChrome | null = null;
  let cdp: CdpClient | null = null;
  try {
    const stagedRecordPath = path.join(scratchDir, "game-record.json");
    await fs.writeFile(stagedRecordPath, recordJson);

    const runId = `render_${randomUUID().slice(0, 8)}`;
    const serverStartedAt = Date.now();
    host = await startStaticHost({
      staticDir: spec.staticDir,
      runId,
      stagedRecordPath,
    });
    const serverStartMs = Date.now() - serverStartedAt;
    log(`static host on 127.0.0.1:${host.port} (runId ${runId})`);

    const chromeLaunchStartedAt = Date.now();
    chrome = await launchHeadlessChrome({
      userDataDir: path.join(scratchDir, "chrome-profile"),
    });
    cdp = await CdpClient.connect(chrome.browserWsUrl);
    const chromeLaunchMs = Date.now() - chromeLaunchStartedAt;
    log(`chrome ${chrome.browserVersion} devtools :${chrome.devtoolsPort}`);

    const targets = await cdp.send("Target.getTargets");
    const pageTarget = (
      targets["targetInfos"] as Array<{ targetId: string; type: string }>
    ).find((t) => t.type === "page");
    if (!pageTarget) fail("no page target in headless Chrome");
    const attach = await cdp.send("Target.attachToTarget", {
      targetId: pageTarget.targetId,
      flatten: true,
    });
    const sessionId = attach["sessionId"] as string;

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);
    await cdp.send(
      "Network.setBlockedURLs",
      { urls: BLOCKED_URL_PATTERNS },
      sessionId,
    );
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: CLIP_WIDTH,
        height: CLIP_HEIGHT,
        deviceScaleFactor: 1,
        mobile: false,
      },
      sessionId,
    );
    await cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: preInjectSource() },
      sessionId,
    );

    const driver = makePageDriver(cdp, sessionId);
    const navigateStartedAt = Date.now();
    await cdp.send("Page.navigate", { url: host.replayUrl }, sessionId);
    // First frame implies: shell + bundle loaded, record fetched/validated,
    // worker booted, map initialized, first tick executed.
    await driver.waitForTick(0, 120_000, 200, "first-frame");
    const pageLoadToFirstFrameMs = Date.now() - navigateStartedAt;
    log(`first frame after ${pageLoadToFirstFrameMs}ms`);

    const parkTick = spec.anchorTurn - CAPTURE_LEAD_TICKS;
    const endTick = spec.anchorTurn + CAPTURE_TAIL_TICKS;
    const parkStartedAt = Date.now();
    await driver.dispatchJump(parkTick);
    // Parking drains the force-queued turns as fast as the worker executes;
    // budget scales with depth (measured ~1-2k turns/s on the spike hardware).
    const parkTimeoutMs = Math.max(120_000, parkTick * 50);
    await driver.waitForTick(parkTick - 1, parkTimeoutMs, 250, "park");
    await sleep(700);
    const parkMs = Date.now() - parkStartedAt;
    const parkedAt = await driver.lastTick();
    log(`parked at tick ${parkedAt} (target ${parkTick}) in ${parkMs}ms`);
    if (parkedAt !== null && parkedAt > spec.anchorTurn) {
      fail(
        `park overshot: at tick ${parkedAt}, beyond anchor ${spec.anchorTurn}`,
      );
    }

    const capture =
      captureMode === "screencast"
        ? await captureScreencast(driver, cdp, sessionId, framesDir, endTick)
        : await captureTickStep(
            driver,
            cdp,
            sessionId,
            framesDir,
            parkTick,
            endTick,
          );
    log(
      `captured ${capture.frameCount} frames, ticks ${capture.tickStart}->${capture.tickEnd} in ${capture.captureMs}ms`,
    );

    const integrity = await driver.evalValue<{
      hashWarnings: number;
      consoleErrors: number;
    }>(
      "({ hashWarnings: window.__pwClip.hashWarnings, consoleErrors: window.__pwClip.consoleErrors })",
    );

    // Free Chrome before encoding.
    await cdp.send("Browser.close").catch(() => undefined);
    await cdp.close();
    cdp = null;
    await chrome.dispose();
    const chromeVersion = chrome.browserVersion;
    chrome = null;
    await host.close();
    host = null;

    const assembled = await assembleClip({
      ffmpegBinary,
      framesDir,
      scratchDir,
      outDir: spec.outDir,
      frameDurations: capture.frameDurations,
      licenseStrings,
    });

    const timings: Timings = {
      ffmpegVerifyMs,
      bundleVerifyMs,
      serverStartMs,
      chromeLaunchMs,
      pageLoadToFirstFrameMs,
      parkMs,
      captureMs: capture.captureMs,
      encodeMs: assembled.encodeMs,
      totalMs: Date.now() - totalStartedAt,
    };
    const frameTimestampStats =
      capture.frameTimestamps !== null && capture.frameTimestamps.length > 1
        ? (() => {
            const deltas = capture.frameTimestamps
              .slice(1)
              .map((t, i) => t - capture.frameTimestamps![i])
              .sort((a, b) => a - b);
            const at = (q: number) =>
              deltas[
                Math.min(deltas.length - 1, Math.floor(q * deltas.length))
              ];
            return {
              frameIntervalP50Ms: Math.round(at(0.5) * 1000),
              frameIntervalP95Ms: Math.round(at(0.95) * 1000),
              frameIntervalMaxMs: Math.round(deltas[deltas.length - 1] * 1000),
            };
          })()
        : null;

    const manifest = {
      premiereId: spec.premiereId,
      sourceReplaySha256,
      anchorTurn: spec.anchorTurn,
      clipVersion: spec.clipVersion,
      captureMode,
      tickStart: capture.tickStart,
      tickEnd: capture.tickEnd,
      frameCount: capture.frameCount,
      chromeVersion,
      ffmpegVersion,
      outSha256: assembled.outSha256,
      outBytes: assembled.outBytes,
      timings,
      frameTimestampStats,
      integrity,
      generatedAt: new Date().toISOString(),
    };
    const manifestPath = path.join(spec.outDir, "render-manifest.json");
    const tmpManifestPath = path.join(
      spec.outDir,
      `.render-manifest.json.tmp-${randomUUID()}`,
    );
    await fs.writeFile(tmpManifestPath, JSON.stringify(manifest, null, 2));
    await fs.rename(tmpManifestPath, manifestPath);

    log(`clip: ${assembled.clipPath}`);
    log(`manifest: ${manifestPath}`);
    console.log(JSON.stringify({ ok: true, manifest }, null, 2));
  } finally {
    if (cdp !== null) {
      await cdp.send("Browser.close").catch(() => undefined);
      await cdp.close().catch(() => undefined);
    }
    if (chrome !== null) await chrome.dispose().catch(() => undefined);
    if (host !== null) await host.close().catch(() => undefined);
    // Frames are deleted after every run (disk is in the warning band); the
    // kept outputs are clip.mp4, render-manifest.json and the two frame dumps.
    await fs
      .rm(scratchDir, { recursive: true, force: true })
      .catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(
    `[clip-worker] FAILED: ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exitCode = 1;
});
