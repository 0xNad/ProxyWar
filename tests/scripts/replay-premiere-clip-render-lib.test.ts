import { describe, expect, test } from "vitest";
import { parseReplayRenderFastForwardUntilTurn } from "../../src/client/ReplayRenderFastForward";
import {
  buildClipEncodeArgs,
  buildSlateArgs,
  CLIP_FRAME_PROFILES,
  CLIP_MAX_CAMERA_OVERSCAN,
  CLIP_MAX_DEAD_SPACE_PER_SIDE,
  clipReplayPageUrl,
  computeClipCameraGeometry,
  DEFAULT_CLIP_CAMERA_FIT,
  DEFAULT_CLIP_FRAME_SHAPE,
  isClipCameraFit,
  isClipFrameShape,
  resolveClipCaptureWindow,
  resolveClipFrameProfile,
} from "../../src/scripts/replay-premiere-clip-render-lib";

describe("clipReplayPageUrl", () => {
  test("carries the fast-forward park target, and the client parser accepts it", () => {
    const url = clipReplayPageUrl({
      baseUrl: "http://127.0.0.1:4567/",
      runId: "render_abc123",
      fastForwardUntilTurn: 50_350,
    });
    expect(url).toBe(
      "http://127.0.0.1:4567/ai-league-replay/render_abc123?renderFastForwardUntilTurn=50350",
    );
    // The exact query the worker emits must round-trip through the page-side
    // parser — this pins the two halves of the contract together.
    expect(parseReplayRenderFastForwardUntilTurn(new URL(url).search)).toBe(
      50_350,
    );
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
        finalTurnNumber: 31_600,
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
        finalTurnNumber: 31_600,
      }),
    ).toEqual({ parkTick: 31_400, endTick: 31_600 });
  });

  test("clamps to the record start for very short records", () => {
    expect(
      resolveClipCaptureWindow({
        anchorTurn: 90,
        leadTicks: LEAD,
        tailTicks: TAIL,
        finalTurnNumber: 120,
      }),
    ).toEqual({ parkTick: 1, endTick: 120 });
  });

  test("falls back to the classic window when the record end is unknown", () => {
    expect(
      resolveClipCaptureWindow({
        anchorTurn: 500,
        leadTicks: LEAD,
        tailTicks: TAIL,
        finalTurnNumber: null,
      }),
    ).toEqual({ parkTick: 450, endTick: 650 });
  });
});

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
