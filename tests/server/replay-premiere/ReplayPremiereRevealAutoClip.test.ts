import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs, type StatsFs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  ReplayPremiereClips,
  ReplayPremiereRevealAutoClip,
  type ReplayPremiereAutoClipRuntimeReader,
  type ReplayPremiereClipsOptions,
} from "../../../src/server/replay-premiere/ReplayPremiereClips";
import type { PremiereState } from "../../../src/server/replay-premiere/ReplayPremiereContracts";

const ATTRIBUTION = "Game art from OpenFront (openfront.io), CC BY-SA 4.0.";
const NO_ENDORSEMENT = "Proxy War is an independent fork.";
const SHA = "b".repeat(64);
const PREMIERE = "prem_autoclip00000001";
const FINAL_SEQUENCE = 41;
const FINAL_TURN = 987;

type FakeChild = EventEmitter & {
  kill(signal?: string): boolean;
  exitCode: number | null;
};

/** Worker whose per-job success/failure is scripted through `outcomes`. */
function scriptedSpawn(
  outcomes: Array<"ok" | "fail">,
): ReplayPremiereClipsOptions["spawnWorker"] {
  let jobIndex = 0;
  return (jobSpecPath) => {
    const child = new EventEmitter() as FakeChild;
    child.exitCode = null;
    child.kill = () => true;
    const outcome = outcomes[Math.min(jobIndex, outcomes.length - 1)];
    jobIndex += 1;
    setImmediate(() => {
      void (async () => {
        try {
          if (outcome === "fail") {
            child.exitCode = 1;
            child.emit("exit", 1);
            return;
          }
          const spec = JSON.parse(await fs.readFile(jobSpecPath, "utf8"));
          const bytes = Buffer.alloc(64, 7);
          await fs.writeFile(path.join(spec.outDir, "clip.mp4"), bytes);
          await fs.writeFile(
            path.join(spec.outDir, "render-manifest.json"),
            JSON.stringify({
              premiereId: spec.premiereId,
              sourceReplaySha256: spec.expectedBundleSha256,
              anchorTurn: spec.anchorTurn,
              clipVersion: spec.clipVersion,
              frameShape: "square",
              frameWidth: 1080,
              frameHeight: 1080,
              outSha256: createHash("sha256").update(bytes).digest("hex"),
              outBytes: bytes.length,
              generatedAt: new Date().toISOString(),
            }),
          );
          child.exitCode = 0;
          child.emit("exit", 0);
        } catch (error) {
          child.emit("error", error);
        }
      })();
    });
    return child as never;
  };
}

function runtimeReader(
  state: PremiereState = "revealed",
): ReplayPremiereAutoClipRuntimeReader {
  return {
    readLifecycleState: () => state,
    readReveal: () =>
      state === "revealed" || state === "archived"
        ? { sourceReplaySha256: SHA, finalSequence: FINAL_SEQUENCE }
        : null,
    readReleasedContext: (sequence) =>
      sequence === FINAL_SEQUENCE ? { turn: FINAL_TURN } : null,
  };
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pw-auto-clip-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

function makeClips(
  overrides: Partial<ReplayPremiereClipsOptions> = {},
): ReplayPremiereClips {
  return new ReplayPremiereClips({
    clipsRoot: path.join(root, "clips-v1"),
    sourceBundleRoot: root,
    staticDir: path.join(root, "static"),
    workerModulePath: path.join(root, "worker.ts"),
    publicOrigin: "https://beta.proxywar.xyz",
    licenseStrings: { attribution: ATTRIBUTION, noEndorsement: NO_ENDORSEMENT },
    storageStatePath: path.join(root, "state.json"),
    statfs: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }) as StatsFs,
    spawnWorker: scriptedSpawn(["ok"]),
    ...overrides,
  });
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  attempts = 400,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("ReplayPremiereRevealAutoClip", () => {
  test("schedules exactly one default render on reveal, anchored on the final released moment", async () => {
    const clips = makeClips();
    const auto = new ReplayPremiereRevealAutoClip({
      clips,
      resolveRuntime: (premiereId) =>
        premiereId === PREMIERE ? runtimeReader() : null,
      verifyDelayMs: 10,
    });

    auto.onPremiereRevealed(PREMIERE);
    // Registration + transition observations both funnel here: duplicates are
    // deduped and never schedule a second render.
    auto.onPremiereRevealed(PREMIERE);
    auto.onPremiereRevealed(PREMIERE);

    await waitFor(
      () =>
        clips.readStatus({
          premiereId: PREMIERE,
          lifecycleState: "revealed",
          bucket: Math.floor(FINAL_TURN / 10),
        }).state === "ready",
      "auto clip ready",
    );
    expect(auto.requestedRenderCount(PREMIERE)).toBe(1);

    const status = clips.readStatus({
      premiereId: PREMIERE,
      lifecycleState: "revealed",
      bucket: Math.floor(FINAL_TURN / 10),
    });
    expect(status.state).toBe("ready");
    expect(status.ready?.anchorTurn).toBeGreaterThanOrEqual(
      Math.floor(FINAL_TURN / 10) * 10,
    );
    auto.close();
    await clips.close();
  });

  test("retries exactly once after a failed render, then succeeds", async () => {
    const clips = makeClips({ spawnWorker: scriptedSpawn(["fail", "ok"]) });
    const auto = new ReplayPremiereRevealAutoClip({
      clips,
      resolveRuntime: () => runtimeReader(),
      verifyDelayMs: 10,
    });

    auto.onPremiereRevealed(PREMIERE);
    await waitFor(
      () =>
        clips.readStatus({
          premiereId: PREMIERE,
          lifecycleState: "revealed",
          bucket: Math.floor(FINAL_TURN / 10),
        }).state === "ready",
      "retried auto clip ready",
    );
    expect(auto.requestedRenderCount(PREMIERE)).toBe(2);
    auto.close();
    await clips.close();
  });

  test("gives up after the single retry also fails (never a third render)", async () => {
    const logLines: string[] = [];
    const clips = makeClips({ spawnWorker: scriptedSpawn(["fail", "fail"]) });
    const auto = new ReplayPremiereRevealAutoClip({
      clips,
      resolveRuntime: () => runtimeReader(),
      verifyDelayMs: 5,
      logger: (line) => logLines.push(line),
    });

    auto.onPremiereRevealed(PREMIERE);
    await waitFor(
      () => logLines.some((line) => line.includes("giving up")),
      "auto clip gave up",
    );
    // Allow any stray timers to fire, then confirm the render count is capped.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(auto.requestedRenderCount(PREMIERE)).toBe(2);
    expect(
      clips.readStatus({
        premiereId: PREMIERE,
        lifecycleState: "revealed",
        bucket: Math.floor(FINAL_TURN / 10),
      }).state,
    ).toBe("absent");
    auto.close();
    await clips.close();
  });

  test("a spurious observation (not revealed / unregistered) neither renders nor latches", async () => {
    const clips = makeClips();
    let state: PremiereState = "playing";
    const auto = new ReplayPremiereRevealAutoClip({
      clips,
      resolveRuntime: () => runtimeReader(state),
      verifyDelayMs: 10,
    });

    // Pre-reveal observation: no render may ever be scheduled for a
    // non-revealed premiere (spoiler-critical), and it must not poison the
    // dedupe for the real reveal later.
    auto.onPremiereRevealed(PREMIERE);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(auto.requestedRenderCount(PREMIERE)).toBe(0);
    expect(
      clips.readStatus({
        premiereId: PREMIERE,
        lifecycleState: "revealed",
        bucket: Math.floor(FINAL_TURN / 10),
      }).state,
    ).toBe("absent");

    state = "revealed";
    auto.onPremiereRevealed(PREMIERE);
    await waitFor(
      () =>
        clips.readStatus({
          premiereId: PREMIERE,
          lifecycleState: "revealed",
          bucket: Math.floor(FINAL_TURN / 10),
        }).state === "ready",
      "post-reveal auto clip ready",
    );
    expect(auto.requestedRenderCount(PREMIERE)).toBe(1);
    auto.close();
    await clips.close();
  });

  test("close() cancels pending verification timers", async () => {
    const clips = makeClips({ spawnWorker: scriptedSpawn(["fail"]) });
    const auto = new ReplayPremiereRevealAutoClip({
      clips,
      resolveRuntime: () => runtimeReader(),
      verifyDelayMs: 5_000,
    });
    auto.onPremiereRevealed(PREMIERE);
    await new Promise((resolve) => setTimeout(resolve, 20));
    auto.close();
    expect(auto.requestedRenderCount(PREMIERE)).toBe(1);
    await clips.close();
  });
});
