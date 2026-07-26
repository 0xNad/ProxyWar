import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import {
  parseReplayRenderFastForwardUntilTurn,
  parseReplayRenderSpeed,
} from "../../src/client/ReplayRenderFastForward";
import {
  buildClipEncodeArgs,
  buildSlateArgs,
  CdpClient,
  CLIP_FRAME_PROFILES,
  CLIP_MAX_CAMERA_OVERSCAN,
  CLIP_MAX_DEAD_SPACE_PER_SIDE,
  clipReplayPageUrl,
  computeClipCameraGeometry,
  DEFAULT_CLIP_CAMERA_FIT,
  DEFAULT_CLIP_FRAME_SHAPE,
  isClipCameraFit,
  isClipFrameShape,
  launchHeadlessChrome,
  resolveClipCaptureWindow,
  resolveClipFrameProfile,
  resolveReplayRecordUpperBoundTick,
  runFfmpeg,
} from "../../src/scripts/replay-premiere-clip-render-lib";

describe("clipReplayPageUrl", () => {
  test("carries the fast-forward park target, and the client parser accepts it", () => {
    const url = clipReplayPageUrl({
      baseUrl: "http://127.0.0.1:4567/",
      runId: "render_abc123",
      fastForwardUntilTurn: 50_350,
    });
    expect(url).toBe(
      "http://127.0.0.1:4567/ai-league-replay/render_abc123?renderFastForwardUntilTurn=50350&renderReplaySpeed=fast",
    );
    // The exact query the worker emits must round-trip through BOTH page-side
    // parsers — this pins the halves of the contract together.
    expect(parseReplayRenderFastForwardUntilTurn(new URL(url).search)).toBe(
      50_350,
    );
    // "fast" is the bounded 2x rate (delay multiplier 0.5), paired with the
    // doubled capture window so clip length stays put while covering twice the
    // match. "fastest" is deliberately not accepted: unbounded rate makes clip
    // duration pipeline-dependent.
    expect(parseReplayRenderSpeed(new URL(url).search)).toBe(0.5);
    expect(parseReplayRenderSpeed("?renderReplaySpeed=fastest")).toBeNull();
    expect(parseReplayRenderSpeed("?renderReplaySpeed=bogus")).toBeNull();
  });

  test("omits the parameter for non-positive or invalid targets", () => {
    for (const target of [0, -50, Number.NaN, 1.5]) {
      expect(
        clipReplayPageUrl({
          baseUrl: "http://127.0.0.1:4567",
          runId: "render_abc123",
          fastForwardUntilTurn: target,
        }),
      ).toBe("http://127.0.0.1:4567/ai-league-replay/render_abc123");
    }
  });
});

describe("resolveClipCaptureWindow", () => {
  const LEAD = 50;
  const TAIL = 150;

  test("keeps the classic window when the record extends past the tail", () => {
    expect(
      resolveClipCaptureWindow({
        anchorTurn: 2_005,
        leadTicks: LEAD,
        tailTicks: TAIL,
        terminalTick: 31_600,
      }),
    ).toEqual({ parkTick: 1_955, endTick: 2_155 });
  });

  test("shifts an end-of-record anchor back so the payoff clip keeps its full span", () => {
    // The production auto-clip case: the anchor IS the final released moment,
    // so anchor+tail overruns the record and the old window could never
    // finish capturing (2026-07-22 second failure mode).
    expect(
      resolveClipCaptureWindow({
        anchorTurn: 31_550,
        leadTicks: LEAD,
        tailTicks: TAIL,
        terminalTick: 31_600,
      }),
    ).toEqual({ parkTick: 31_400, endTick: 31_600 });
  });

  test("clamps to the record start for very short records", () => {
    expect(
      resolveClipCaptureWindow({
        anchorTurn: 90,
        leadTicks: LEAD,
        tailTicks: TAIL,
        terminalTick: 120,
      }),
    ).toEqual({ parkTick: 1, endTick: 120 });
  });

  test("falls back to the classic window when the record end is unknown", () => {
    expect(
      resolveClipCaptureWindow({
        anchorTurn: 500,
        leadTicks: LEAD,
        tailTicks: TAIL,
        terminalTick: null,
      }),
    ).toEqual({ parkTick: 450, endTick: 650 });
  });

  test("uses the canonical turn-count upper bound for a compressed sparse record", () => {
    const record = {
      info: { num_turns: 50_400 },
      turns: [{ turnNumber: 0 }, { turnNumber: 50_300 }],
    };
    const recordUpperBoundTick = resolveReplayRecordUpperBoundTick(record);
    expect(recordUpperBoundTick).toBe(50_400);
    expect(
      resolveClipCaptureWindow({
        anchorTurn: 50_395,
        leadTicks: LEAD,
        tailTicks: TAIL,
        // Capped/no-winner records use their validated upper bound as the
        // capture clamp; winner records discover an explicit terminal event.
        terminalTick: recordUpperBoundTick,
      }),
    ).toEqual({ parkTick: 50_200, endTick: 50_400 });
  });

  test("falls back to one past the last stored turn only when metadata is invalid", () => {
    expect(
      resolveReplayRecordUpperBoundTick({
        info: { num_turns: "invalid" },
        turns: [{ turnNumber: 123 }],
      }),
    ).toBe(124);
  });

  test("never produces an unsafe sparse fallback upper bound", () => {
    expect(
      resolveReplayRecordUpperBoundTick({
        turns: [{ turnNumber: Number.MAX_SAFE_INTEGER }],
      }),
    ).toBeNull();
  });
});

describe("bounded external commands", () => {
  test("a CDP command times out while the socket remains usable, then close rejects and clears another pending command", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const command = JSON.parse(String(raw)) as {
          id: number;
          method: string;
        };
        if (command.method === "Runtime.echo") {
          socket.send(JSON.stringify({ id: command.id, result: { ok: true } }));
        }
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("websocket fixture did not bind a TCP port");
    }

    const client = await CdpClient.connect(`ws://127.0.0.1:${address.port}`, {
      commandTimeoutMs: 75,
    });
    await expect(client.send("Runtime.neverResponds")).rejects.toThrow(
      "CDP Runtime.neverResponds timed out after 75ms",
    );
    await expect(client.send("Runtime.echo")).resolves.toEqual({ ok: true });

    const pendingAtClose = client.send("Runtime.pendingAtClose");
    const closeRejection =
      expect(pendingAtClose).rejects.toThrow("CDP socket closed");
    await client.close();
    await closeRejection;
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
  });

  test("a TCP peer that accepts but never upgrades is terminated at the CDP connect deadline", async () => {
    const acceptedSockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      acceptedSockets.add(socket);
      socket.once("close", () => acceptedSockets.delete(socket));
      // Intentionally accept the HTTP Upgrade request without responding.
      socket.on("data", () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
      server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("raw TCP fixture did not bind a port");
    }

    const startedAt = Date.now();
    await expect(
      CdpClient.connect(`ws://127.0.0.1:${address.port}`, {
        connectTimeoutMs: 75,
      }),
    ).rejects.toThrow("CDP connect timed out after 75ms");
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(acceptedSockets.size).toBe(0);
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      );
    });
  });

  test("a launcher readiness failure reaps the spawned Chrome descendant before rejecting", async () => {
    const userDataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "proxywar-fake-chrome-"),
    );
    const fixtureBinary = path.resolve(
      "tests/scripts/fixtures/fake-chrome-readiness-failure.mjs",
    );
    try {
      await expect(
        launchHeadlessChrome({
          userDataDir,
          chromeBinary: fixtureBinary,
          timeoutMs: 2_000,
        }),
      ).rejects.toThrow(
        "Chrome /json/version returned no webSocketDebuggerUrl",
      );

      const rootPid = Number.parseInt(
        await fs.readFile(path.join(userDataDir, "fixture-root.pid"), "utf8"),
        10,
      );
      const descendantPid = Number.parseInt(
        await fs.readFile(
          path.join(userDataDir, "fixture-descendant.pid"),
          "utf8",
        ),
        10,
      );
      expect(processExists(rootPid)).toBe(false);
      expect(processExists(descendantPid)).toBe(false);
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("a detached worker reaps a reparented Chrome grandchild after the Chrome root exits", async () => {
    const userDataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "proxywar-reparented-chrome-"),
    );
    const fixtureBinary = path.resolve(
      "tests/scripts/fixtures/fake-chrome-reparented-grandchild.mjs",
    );
    const harness = path.resolve(
      "tests/scripts/fixtures/launch-headless-chrome-harness.ts",
    );
    const resultPath = path.join(userDataDir, "harness-result.json");
    try {
      const startedAt = Date.now();
      const worker = spawn(
        process.execPath,
        ["--import", "tsx", harness, userDataDir, fixtureBinary, resultPath],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      const stderrChunks: Buffer[] = [];
      worker.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      const exit = await waitForChildExit(worker, 10_000);
      expect(exit.code, Buffer.concat(stderrChunks).toString("utf8")).toBe(0);

      const result = JSON.parse(await fs.readFile(resultPath, "utf8")) as {
        ok: boolean;
        error?: string;
      };
      expect(result.ok).toBe(true);
      expect(result.error).toContain(
        "Chrome exited before DevTools became ready",
      );
      expect(Date.now() - startedAt, result.error).toBeLessThan(2_000);
      const grandchildPid = Number.parseInt(
        await fs.readFile(
          path.join(userDataDir, "fixture-grandchild.pid"),
          "utf8",
        ),
        10,
      );
      await expect(processIsLive(grandchildPid)).resolves.toBe(false);
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  });

  test("ffmpeg execution is SIGKILL-bounded", async () => {
    const startedAt = Date.now();
    await expect(
      runFfmpeg(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        timeoutMs: 75,
      }),
    ).rejects.toThrow("ffmpeg timed out after 75ms");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function processIsLive(pid: number): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-o", "stat=", "-p", String(pid)],
      { timeout: 2_000, killSignal: "SIGKILL" },
      (error, stdout) => {
        const status = stdout.trim();
        if (error !== null && status === "") {
          resolve(false);
          return;
        }
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(status !== "" && !status.startsWith("Z"));
      },
    );
  });
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            reject(error);
            return;
          }
        }
      }
      reject(
        new Error(`detached launcher harness timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

const ATTRIBUTION =
  "Game art from OpenFront (openfront.io), CC BY-SA 4.0; footage shared under the same license.";
const NO_ENDORSEMENT =
  "Proxy War is an independent fork — not affiliated with or endorsed by OpenFront.";

describe("clip frame profiles", () => {
  test("square is the default and is X/mobile-optimal 1080x1080", () => {
    expect(DEFAULT_CLIP_FRAME_SHAPE).toBe("square");
    expect(DEFAULT_CLIP_CAMERA_FIT).toBe("fill");
    expect(resolveClipFrameProfile()).toMatchObject({
      shape: "square",
      width: 1080,
      height: 1080,
    });
    expect(resolveClipFrameProfile("landscape")).toMatchObject({
      shape: "landscape",
      width: 1280,
      height: 720,
    });
  });

  test("both profiles have even, encodable dimensions", () => {
    for (const profile of Object.values(CLIP_FRAME_PROFILES)) {
      expect(profile.width % 2).toBe(0);
      expect(profile.height % 2).toBe(0);
    }
  });

  test("shape/fit type guards reject junk", () => {
    expect(isClipFrameShape("square")).toBe(true);
    expect(isClipFrameShape("landscape")).toBe(true);
    expect(isClipFrameShape("portrait")).toBe(false);
    expect(isClipFrameShape(1080)).toBe(false);
    expect(isClipCameraFit("fill")).toBe(true);
    expect(isClipCameraFit("whole-map")).toBe(true);
    expect(isClipCameraFit("cover")).toBe(false);
  });
});

describe("computeClipCameraGeometry", () => {
  const square = CLIP_FRAME_PROFILES.square;

  test("a square map in a square frame fills exactly with no dead space", () => {
    const g = computeClipCameraGeometry({
      viewportWidth: square.width,
      viewportHeight: square.height,
      mapWidth: 1000,
      mapHeight: 1000,
      cameraFit: "fill",
    });
    expect(g.fit).toBeCloseTo(1, 6);
    expect(g.deadSpacePerSideFraction).toBeCloseTo(0, 6);
    expect(g.deadSpaceHorizontalPx).toBeCloseTo(0, 6);
    expect(g.deadSpaceVerticalPx).toBeCloseTo(0, 6);
    expect(g.overscanCapped).toBe(false);
  });

  test("wide maps fill to the dead-space budget, not beyond", () => {
    // Europe is the widest map the league pool realistically reaches (~1.74:1).
    const g = computeClipCameraGeometry({
      viewportWidth: square.width,
      viewportHeight: square.height,
      mapWidth: 2904,
      mapHeight: 1672,
      cameraFit: "fill",
    });
    expect(g.fit).toBeGreaterThan(1);
    // Fills to (not past) the budget on the loose axis.
    expect(g.deadSpacePerSideFraction).toBeLessThanOrEqual(
      CLIP_MAX_DEAD_SPACE_PER_SIDE + 1e-9,
    );
    expect(g.deadSpacePerSideFraction).toBeCloseTo(
      CLIP_MAX_DEAD_SPACE_PER_SIDE,
      3,
    );
    expect(g.overscanCapped).toBe(false);
  });

  test("whole-map mode letterboxes a wide map (no fill zoom)", () => {
    const g = computeClipCameraGeometry({
      viewportWidth: square.width,
      viewportHeight: square.height,
      mapWidth: 2000,
      mapHeight: 1000,
      cameraFit: "whole-map",
    });
    expect(g.fit).toBe(1);
    expect(g.deadSpacePerSideFraction).toBeGreaterThan(
      CLIP_MAX_DEAD_SPACE_PER_SIDE,
    );
  });

  test("ribbon maps hit the overscan cap and stay over budget (fail-loud signal)", () => {
    const g = computeClipCameraGeometry({
      viewportWidth: square.width,
      viewportHeight: square.height,
      mapWidth: 5536,
      mapHeight: 276, // amazonriver, ~20:1
      cameraFit: "fill",
    });
    expect(g.fit).toBeCloseTo(CLIP_MAX_CAMERA_OVERSCAN, 6);
    expect(g.overscanCapped).toBe(true);
    expect(g.deadSpacePerSideFraction).toBeGreaterThan(
      CLIP_MAX_DEAD_SPACE_PER_SIDE,
    );
  });

  test("landscape fill also reduces dead space for a square map", () => {
    const landscape = CLIP_FRAME_PROFILES.landscape;
    const g = computeClipCameraGeometry({
      viewportWidth: landscape.width,
      viewportHeight: landscape.height,
      mapWidth: 1000,
      mapHeight: 1000,
      cameraFit: "fill",
    });
    // 44% dead per side under the old whole-map behavior; fill brings it down.
    expect(g.deadSpacePerSideFraction).toBeLessThanOrEqual(
      CLIP_MAX_DEAD_SPACE_PER_SIDE + 1e-9,
    );
  });

  test("rejects non-positive dimensions", () => {
    expect(() =>
      computeClipCameraGeometry({
        viewportWidth: 0,
        viewportHeight: 1080,
        mapWidth: 1000,
        mapHeight: 1000,
      }),
    ).toThrow();
    expect(() =>
      computeClipCameraGeometry({
        viewportWidth: 1080,
        viewportHeight: 1080,
        mapWidth: -1,
        mapHeight: 1000,
      }),
    ).toThrow();
  });
});

describe("ffmpeg builders honor the target dimensions and licensing", () => {
  test("clip encode scales to the requested frame and carries the watermark", () => {
    const args = buildClipEncodeArgs({
      concatPath: "/tmp/concat.txt",
      outPath: "/tmp/body.mp4",
      watermarkText: "proxywar.xyz",
      width: 1080,
      height: 1080,
    });
    const vf = args[args.indexOf("-vf") + 1];
    expect(vf).toContain("scale=1080:1080");
    expect(vf).toContain("proxywar.xyz");
    expect(args).toContain("yuv420p");
    expect(args).toContain("high");
  });

  test("slate renders at the frame size with BOTH exact license strings", () => {
    for (const shape of ["square", "landscape"] as const) {
      const profile = CLIP_FRAME_PROFILES[shape];
      const args = buildSlateArgs({
        outPath: "/tmp/slate.mp4",
        taglineText: "Autonomous agents. No humans at the controls.",
      title: "Proxy War",
        ctaText: "proxywar.xyz",
        attributionText: ATTRIBUTION,
        noEndorsementText: NO_ENDORSEMENT,
        width: profile.width,
        height: profile.height,
      });
      const joined = args.join("\x00");
      expect(joined).toContain(`s=${profile.width}x${profile.height}`);
      // The exact strings survive drawtext escaping (only ':' and a few
      // specials are escaped; these two lines contain none of them except the
      // attribution comma/colon, so assert on the distinctive substrings).
      expect(joined).toContain("CC BY-SA 4.0");
      expect(joined).toContain("footage shared under the same license");
      expect(joined).toContain("not affiliated with or endorsed by OpenFront");
    }
  });

  test("slate rejects odd/degenerate dimensions", () => {
    expect(() =>
      buildSlateArgs({
        outPath: "/tmp/s.mp4",
        taglineText: "Autonomous agents. No humans at the controls.",
      title: "Proxy War",
        ctaText: "x",
        attributionText: ATTRIBUTION,
        noEndorsementText: NO_ENDORSEMENT,
        width: 1081,
        height: 1080,
      }),
    ).toThrow();
  });
});
