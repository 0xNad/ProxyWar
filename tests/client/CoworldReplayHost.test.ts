import { afterEach, describe, expect, it, vi } from "vitest";
import { postToReplayHost } from "../../src/client/CoworldReplayHost";

describe("CoworldReplayHost", () => {
  afterEach(() => {
    Object.defineProperty(window, "parent", {
      value: window,
      configurable: true,
      writable: true,
    });
  });

  it("stays silent when the viewer is the top-level document", () => {
    const postMessage = vi.spyOn(window, "postMessage");
    postToReplayHost({ type: "loading" });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("stamps the channel name and targets any embedder origin", () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, "parent", {
      value: { postMessage },
      configurable: true,
      writable: true,
    });

    postToReplayHost({ type: "error", message: "boom" });

    expect(postMessage).toHaveBeenCalledWith(
      { src: "coworld-replay", type: "error", message: "boom" },
      "*",
    );
  });
});
