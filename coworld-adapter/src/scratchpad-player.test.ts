import { describe, expect, it, vi } from "vitest";

const modulePath = "./scratchpad-player.mjs";
const { createScratchpadPlayer } = await import(modulePath);
const request = (phase: string) => ({
  phase,
  requestID: "r",
  deadline: new Date(Date.now() + 30000).toISOString(),
  maxNoteBytes: 10,
});

describe("scratchpad policy helper", () => {
  it("makes no scratchpad model calls until the game requests them", async () => {
    const complete = vi.fn().mockResolvedValue("decision");
    const player = createScratchpadPlayer(complete);
    expect(complete).not.toHaveBeenCalled();
    await player.complete("game prompt");
    expect(complete).toHaveBeenCalledWith("game prompt");
  });
  it("consults private notes and bounds Unicode contributions", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce("watch the west")
      .mockResolvedValueOnce("action")
      .mockResolvedValueOnce("🦊🦊🦊");
    const player = createScratchpadPlayer(complete);
    await player.respond({
      ...request("read"),
      scratchpad: { summary: "past", notes: [] },
    });
    await player.complete("choose");
    expect(complete.mock.calls[1][0]).toContain("watch the west");
    const response = await player.respond({
      ...request("write"),
      result: { scores: [1, 0] },
    });
    expect(response).toEqual({
      type: "scratchpad_response",
      requestID: "r",
      note: "🦊🦊",
    });
  });
  it("releases gameplay when a scratchpad model call hangs", async () => {
    vi.useFakeTimers();
    try {
      const player = createScratchpadPlayer(() => new Promise(() => {}));
      const phase = player.respond(request("read"));
      const assertion = expect(phase).rejects.toThrow("deadline");
      await vi.advanceTimersByTimeAsync(30000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
