import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postToReplayHost } from "../../src/client/CoworldReplayHost";

describe("CoworldReplayHost", () => {
  afterEach(() => {
    delete window.__PROXYWAR_COWORLD_REPLAY_BOOT_ERRORS__;
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

  it("reports an early bundle failure once after announcing loading", () => {
    const html = readFileSync(
      path.resolve(__dirname, "../../index.html"),
      "utf8",
    );
    const start = html.indexOf(
      "if (window.__PROXYWAR_STATIC_REPLAY__ && window.parent !== window)",
    );
    const end = html.indexOf("window.GIT_COMMIT", start);
    const postMessage = vi.fn();
    const bootWindow = Object.assign(new EventTarget(), {
      __PROXYWAR_STATIC_REPLAY__: true,
      parent: { postMessage },
    });
    new Function("window", "ErrorEvent", html.slice(start, end))(
      bootWindow,
      ErrorEvent,
    );

    expect(postMessage).toHaveBeenCalledWith(
      { src: "coworld-replay", type: "loading" },
      "*",
    );
    bootWindow.dispatchEvent(
      new ErrorEvent("error", { message: "bundle evaluation failed" }),
    );

    expect(postMessage).toHaveBeenLastCalledWith(
      {
        src: "coworld-replay",
        type: "error",
        message: "bundle evaluation failed",
      },
      "*",
    );
    expect(postMessage).toHaveBeenCalledTimes(2);
    bootWindow.dispatchEvent(new ErrorEvent("error", { message: "again" }));
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it.each(["ready", "error"] as const)(
    "stops forwarding boot failures after %s",
    (type) => {
      const bootErrors = new AbortController();
      window.__PROXYWAR_COWORLD_REPLAY_BOOT_ERRORS__ = bootErrors;
      Object.defineProperty(window, "parent", {
        value: { postMessage: vi.fn() },
        configurable: true,
        writable: true,
      });

      postToReplayHost(
        type === "ready"
          ? { type }
          : { type, message: "Replay bytes were corrupt" },
      );

      expect(bootErrors.signal.aborted).toBe(true);
      expect(window.__PROXYWAR_COWORLD_REPLAY_BOOT_ERRORS__).toBeUndefined();
    },
  );
});
