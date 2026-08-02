import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { AnalyticsAggregateStore, totalEventCount } from "../../../src/server/analytics/AnalyticsAggregateStore";
import { AnalyticsRecentRing } from "../../../src/server/analytics/AnalyticsRecentRing";
import { emitServerAnalyticsEvent } from "../../../src/server/analytics/AnalyticsServerEmit";

let artifactsRoot: string;

afterEach(async () => {
  if (artifactsRoot !== undefined) {
    await rm(artifactsRoot, { recursive: true, force: true });
  }
});

describe("emitServerAnalyticsEvent", () => {
  test("records the event to both the aggregate store and the recent ring under a /server/<name> route", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-server-emit-"));
    const now = new Date("2026-08-01T12:00:00.000Z");
    await emitServerAnalyticsEvent(artifactsRoot, "claim_verified", { claimId: "claim_00001" }, now);

    const aggregateStore = new AnalyticsAggregateStore(artifactsRoot);
    const file = await aggregateStore.readAll();
    expect(totalEventCount(file, "claim_verified")).toBe(1);
    expect(file.byDay["2026-08-01"].events.claim_verified.byRoute["/server/claim_verified"]).toBe(1);
    expect(file.byDay["2026-08-01"].events.claim_verified.byDimension.claimId["claim_00001"]).toBe(1);

    const ring = new AnalyticsRecentRing(artifactsRoot);
    const entries = await ring.readAll();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("claim_verified");
    expect(entries[0].route).toBe("/server/claim_verified");
  });

  test("never throws even when context violates a schema bound (silently best-effort)", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-server-emit-"));
    // AnalyticsAggregateStore trusts caller-supplied TS types rather than
    // re-validating with zod (only the HTTP ingest route does that) — this
    // proves a malformed call site still can't take down the operator
    // action it's attached to, whatever the underlying cause.
    await expect(
      emitServerAnalyticsEvent(artifactsRoot, "version_release_created", {
        versionLabel: "v1",
      }),
    ).resolves.toBeUndefined();
  });

  test("supports version_release_created and version_observed with versionLabel context", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-server-emit-"));
    const now = new Date("2026-08-01T12:00:00.000Z");
    await emitServerAnalyticsEvent(artifactsRoot, "version_release_created", { versionLabel: "v2" }, now);
    await emitServerAnalyticsEvent(artifactsRoot, "version_observed", { versionLabel: "v2" }, now);
    const file = await new AnalyticsAggregateStore(artifactsRoot).readAll();
    expect(totalEventCount(file, "version_release_created")).toBe(1);
    expect(totalEventCount(file, "version_observed")).toBe(1);
  });
});

describe("cross-process write safety", () => {
  test("two AnalyticsAggregateStore instances (simulating separate processes) writing concurrently never lose an increment", async () => {
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-analytics-crossproc-"));
    const now = new Date("2026-08-01T12:00:00.000Z");
    const storeA = new AnalyticsAggregateStore(artifactsRoot);
    const storeB = new AnalyticsAggregateStore(artifactsRoot);
    const event = { name: "page_viewed" as const, occurredAt: now.toISOString(), route: "/" };
    await Promise.all([
      ...Array.from({ length: 10 }, () => storeA.recordEvents([event], now)),
      ...Array.from({ length: 10 }, () => storeB.recordEvents([event], now)),
    ]);
    const file = await storeA.readAll();
    expect(totalEventCount(file, "page_viewed")).toBe(20);
  });
});
