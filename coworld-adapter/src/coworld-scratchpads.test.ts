import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoworldScratchpads } from "./coworld-scratchpads.ts";

const a = `sha256:${"a".repeat(64)}`;
const b = `sha256:${"b".repeat(64)}`;
const snapshot = {
  protocol: "append-v1" as const,
  namespace: "league",
  policies: {
    [a]: { summary: "private A", notes: [] },
    [b]: { summary: "private B", notes: [] },
  },
  seat_policy_hashes: [a, b],
};
afterEach(() => vi.useRealTimers());

describe("private policy scratchpads", () => {
  it("omits all memory work when platform paths are absent", async () => {
    expect(await CoworldScratchpads.load(2, {})).toBeNull();
  });
  it("sends each authenticated seat only its own snapshot and rejects cross-seat replies", async () => {
    vi.useFakeTimers();
    const pads = new CoworldScratchpads(snapshot, "/unused");
    const frames: Record<string, unknown>[] = [];
    let finished = false;
    const phase = pads
      .runPhase("read", (slot, frame) => {
        frames[slot] = frame;
      })
      .then(() => {
        finished = true;
      });
    expect(JSON.stringify(frames[0])).toContain("private A");
    expect(JSON.stringify(frames[0])).not.toContain("private B");
    pads.respond(1, { requestID: frames[0].requestID });
    pads.respond(0, { requestID: frames[0].requestID });
    await Promise.resolve();
    expect(finished).toBe(false);
    pads.respond(1, { requestID: frames[1].requestID });
    await phase;
    expect(finished).toBe(true);
  });
  it("bounds unresponsive policies and ignores late contributions", async () => {
    vi.useFakeTimers();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pw-memory-"));
    try {
      const output = path.join(dir, "output.json");
      const pads = new CoworldScratchpads(snapshot, output);
      const frames: Record<string, unknown>[] = [];
      const phase = pads.runPhase("write", (slot, frame) => {
        frames[slot] = frame;
      });
      pads.respond(0, {
        requestID: frames[0].requestID,
        note: "é".repeat(8193),
      });
      await vi.advanceTimersByTimeAsync(30000);
      await phase;
      pads.respond(1, { requestID: frames[1].requestID, note: "late" });
      await pads.save();
      expect(JSON.parse(await fs.readFile(output, "utf8"))).toEqual({
        protocol: "append-v1",
        notes: {},
      });
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
  it("stages private output with deterministic bounded contributions from duplicate policy seats", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pw-memory-"));
    try {
      const input = path.join(dir, "input.json");
      const output = path.join(dir, "output.json");
      await fs.writeFile(
        input,
        JSON.stringify({ ...snapshot, seat_policy_hashes: [a, a, null] }),
      );
      const pads = (await CoworldScratchpads.load(3, {
        COGAME_MEMORY_INPUT_URI: pathToFileURL(input).href,
        COGAME_MEMORY_OUTPUT_URI: pathToFileURL(output).href,
      }))!;
      await pads.runPhase("write", (slot, frame) => {
        expect(frame.maxNoteBytes).toBe(8191);
        pads.respond(slot, {
          requestID: frame.requestID,
          note: `${slot}:lesson`,
        });
      });
      await pads.save();
      expect(JSON.parse(await fs.readFile(output, "utf8"))).toEqual({
        protocol: "append-v1",
        notes: { [a]: "0:lesson\n1:lesson" },
      });
    } finally {
      await fs.rm(dir, { recursive: true });
    }
  });
});
