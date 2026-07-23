import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isExpectedReplayDocumentReady,
  preInjectSource,
  resolveDiscoveredWinnerReplayPlan,
  resolveInitialReplayRenderPlan,
  validateClipCaptureWindowWithinSource,
  validateDiscoveredWinnerTerminalTick,
  WINNER_TERMINAL_DISCOVERY_PHASE_TIMEOUT_MS,
} from "../../src/scripts/replay-premiere-clip-worker";

describe("replay premiere clip winner-terminal contract", () => {
  it("reserves more than half the six-minute job budget for reload and capture", () => {
    expect(WINNER_TERMINAL_DISCOVERY_PHASE_TIMEOUT_MS).toBe(150_000);
    expect(WINNER_TERMINAL_DISCOVERY_PHASE_TIMEOUT_MS).toBeLessThan(
      (6 * 60 * 1_000) / 2,
    );
  });

  afterEach(() => {
    const clipState = (
      window as unknown as {
        __pwClip?: { stopPauseSpam?: () => void };
      }
    ).__pwClip;
    clipState?.stopPauseSpam?.();
    delete (window as unknown as { __pwClip?: unknown }).__pwClip;
    vi.restoreAllMocks();
  });

  it("records only the terminal tick from the spoiler-neutral replay frame", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    new Function(preInjectSource())();

    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: { tick: 32_250, terminal: false },
      }),
    );
    document.dispatchEvent(
      new CustomEvent("ai-league-replay-frame", {
        detail: {
          tick: 32_251,
          terminal: true,
          winner: ["player", "must-not-be-copied"],
        },
      }),
    );

    const clipState = (
      window as unknown as {
        __pwClip: Record<string, unknown>;
      }
    ).__pwClip;
    expect(clipState.lastTick).toBe(32_251);
    expect(clipState.terminalTick).toBe(32_251);
    expect(clipState).not.toHaveProperty("winner");
  });

  it("cannot accept stale state from the first of two navigations", () => {
    const discoveryUrl =
      "http://127.0.0.1:4321/ai-league-replay/render_test?renderFastForwardUntilTurn=1";
    const captureUrl =
      "http://127.0.0.1:4321/ai-league-replay/render_test?renderFastForwardUntilTurn=1&clipRenderPass=second-document";
    const rewrittenHref = "http://127.0.0.1:4321/ai-league-replay/render_test";
    const firstPassAfterMainRewrite = {
      initialHref: discoveryUrl,
      href: rewrittenHref,
      firstTickAtMs: 1,
      lastTick: 32_251,
    };
    expect(
      isExpectedReplayDocumentReady(firstPassAfterMainRewrite, captureUrl),
    ).toBe(false);
    expect(
      isExpectedReplayDocumentReady(
        { ...firstPassAfterMainRewrite, initialHref: captureUrl, lastTick: 1 },
        captureUrl,
      ),
    ).toBe(true);
  });

  it("discovers winning records first, then recomputes the full window from the explicit Win tick", () => {
    expect(
      resolveInitialReplayRenderPlan({
        anchorTurn: 32_295,
        recordUpperBoundTick: 32_300,
        hasWinnerMetadata: true,
      }),
    ).toEqual({
      requiresTerminalDiscovery: true,
      initialFastForwardTarget: 32_300,
      terminalTick: null,
      captureWindow: null,
    });

    expect(
      resolveDiscoveredWinnerReplayPlan({
        anchorTurn: 32_295,
        declaredUpperBoundTick: 32_300,
        discoveredTerminalTick: 32_251,
      }),
    ).toEqual({
      terminalTick: 32_251,
      captureWindow: { parkTick: 32_051, endTick: 32_251 },
    });
  });

  it("keeps capped no-winner records on the existing single navigation plan", () => {
    expect(
      resolveInitialReplayRenderPlan({
        anchorTurn: 50_395,
        recordUpperBoundTick: 50_400,
        hasWinnerMetadata: false,
      }),
    ).toEqual({
      requiresTerminalDiscovery: false,
      initialFastForwardTarget: 50_200,
      terminalTick: 50_400,
      captureWindow: { parkTick: 50_200, endTick: 50_400 },
    });
  });

  it("fails closed instead of inferring a winner terminal from timeout or last tick", () => {
    expect(() => validateDiscoveredWinnerTerminalTick(null, 32_300)).toThrow(
      "did not emit a valid terminal event",
    );
    expect(() => validateDiscoveredWinnerTerminalTick(32_301, 32_300)).toThrow(
      "exceeds declared upper bound",
    );
    expect(() =>
      resolveInitialReplayRenderPlan({
        anchorTurn: 500,
        recordUpperBoundTick: null,
        hasWinnerMetadata: true,
      }),
    ).toThrow("no valid declared turn upper bound");
  });

  it("defensively fences capture against the admitted immutable source range", () => {
    expect(() =>
      validateClipCaptureWindowWithinSource(
        {
          anchorTurn: 900,
          renderableThroughTurn: 1_000,
          sourceComplete: false,
        },
        1_000,
        { parkTick: 800, endTick: 1_000 },
      ),
    ).toThrow("incomplete source attempted terminal-window backshift");

    expect(() =>
      validateClipCaptureWindowWithinSource(
        {
          anchorTurn: 900,
          renderableThroughTurn: 1_000,
          sourceComplete: true,
        },
        1_000,
        { parkTick: 800, endTick: 1_000 },
      ),
    ).not.toThrow();

    expect(() =>
      validateClipCaptureWindowWithinSource(
        {
          anchorTurn: 1_001,
          renderableThroughTurn: 1_001,
          sourceComplete: true,
        },
        1_000,
        { parkTick: 800, endTick: 1_000 },
      ),
    ).toThrow("clip anchor exceeds the replay terminal turn");

    expect(() =>
      validateClipCaptureWindowWithinSource(
        {
          anchorTurn: 900,
          renderableThroughTurn: 1_000,
          sourceComplete: true,
        },
        1_100,
        { parkTick: 900, endTick: 1_050 },
      ),
    ).toThrow("clip capture window exceeds the retained/released range");
  });
});
