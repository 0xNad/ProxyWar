import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  disposeReplayFrameCache,
  frameCoverage,
  installReplayFrameCapture,
} from "../../src/client/ReplayFrameCache";

describe("ReplayFrameCache match isolation", () => {
  let sourceCanvas: HTMLCanvasElement;
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    history.replaceState(null, "", "/ai-league-replay/run-a");
    disposeReplayFrameCache();
    rafCallbacks = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        rafCallbacks.push(callback);
        return rafCallbacks.length;
      }),
    );
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as never);

    sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = 300;
    sourceCanvas.height = 150;
    document.body.appendChild(sourceCanvas);
  });

  afterEach(() => {
    disposeReplayFrameCache();
    sourceCanvas.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retains frames for an in-place rewind but closes them for a different run", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 10, height: 5, close }) as ImageBitmap),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => callback(new Blob(["frame"])),
    );

    installReplayFrameCapture("run-a");
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { turnNumber: 100 },
      }),
    );
    expect(rafCallbacks).toHaveLength(1);
    rafCallbacks.shift()!(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(frameCoverage().count).toBe(1);
    installReplayFrameCapture("run-a");
    expect(frameCoverage().count).toBe(1);

    installReplayFrameCapture("run-b");
    expect(frameCoverage().count).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an old async decode that completes after the next match starts", async () => {
    let finishDecode!: (bitmap: ImageBitmap) => void;
    const decoded = new Promise<ImageBitmap>((resolve) => {
      finishDecode = resolve;
    });
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => decoded),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => callback(new Blob(["frame"])),
    );

    installReplayFrameCapture("run-a");
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { turnNumber: 100 },
      }),
    );
    rafCallbacks.shift()!(0);
    await Promise.resolve();

    installReplayFrameCapture("run-b");
    finishDecode({ width: 10, height: 5, close } as ImageBitmap);
    await Promise.resolve();
    await Promise.resolve();

    expect(frameCoverage().count).toBe(0);
    expect(close).toHaveBeenCalledOnce();
  });
});
