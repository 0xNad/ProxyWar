import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BuildFunnelCounters } from "../../../src/server/agents/BuildFunnelCounters";

let artifactsRoot: string;

afterEach(async () => {
  if (artifactsRoot !== undefined) {
    await rm(artifactsRoot, { recursive: true, force: true });
  }
});

describe("BuildFunnelCounters", () => {
  test("increments a fresh counter on first call", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-build-funnel-"));
    const counters = new BuildFunnelCounters(artifactsRoot);
    await counters.recordStepReached(1, new Date("2026-07-31T12:00:00.000Z"));
    const raw = await readFile(
      path.join(artifactsRoot, "build-funnel-counts.json"),
      "utf8",
    );
    const file = JSON.parse(raw);
    expect(file.byDay["2026-07-31"]["1"]).toBe(1);
  });

  test("accumulates repeated calls for the same step on the same day", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-build-funnel-"));
    const counters = new BuildFunnelCounters(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    await counters.recordStepReached(3, now);
    await counters.recordStepReached(3, now);
    await counters.recordStepReached(3, now);
    const raw = await readFile(
      path.join(artifactsRoot, "build-funnel-counts.json"),
      "utf8",
    );
    const file = JSON.parse(raw);
    expect(file.byDay["2026-07-31"]["3"]).toBe(3);
  });

  test("keeps separate counts per UTC calendar day", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-build-funnel-"));
    const counters = new BuildFunnelCounters(artifactsRoot);
    await counters.recordStepReached(2, new Date("2026-07-30T23:59:00.000Z"));
    await counters.recordStepReached(2, new Date("2026-07-31T00:01:00.000Z"));
    const raw = await readFile(
      path.join(artifactsRoot, "build-funnel-counts.json"),
      "utf8",
    );
    const file = JSON.parse(raw);
    expect(file.byDay["2026-07-30"]["2"]).toBe(1);
    expect(file.byDay["2026-07-31"]["2"]).toBe(1);
  });

  test("silently ignores an out-of-range step instead of throwing or writing", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-build-funnel-"));
    const counters = new BuildFunnelCounters(artifactsRoot);
    await expect(counters.recordStepReached(99)).resolves.toBeUndefined();
    await expect(
      readFile(path.join(artifactsRoot, "build-funnel-counts.json"), "utf8"),
    ).rejects.toThrow();
  });

  test("serializes concurrent writes without losing an increment", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-build-funnel-"));
    const counters = new BuildFunnelCounters(artifactsRoot);
    const now = new Date("2026-07-31T12:00:00.000Z");
    await Promise.all(
      Array.from({ length: 10 }, () => counters.recordStepReached(5, now)),
    );
    const raw = await readFile(
      path.join(artifactsRoot, "build-funnel-counts.json"),
      "utf8",
    );
    const file = JSON.parse(raw);
    expect(file.byDay["2026-07-31"]["5"]).toBe(10);
  });
});
