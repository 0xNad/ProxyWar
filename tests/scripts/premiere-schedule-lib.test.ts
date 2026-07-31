import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MINIMUM_SCHEDULE_SPACING_MINUTES,
  resolveScheduleTarget,
  upsertRecord,
  validateSchedule,
} from "../../src/scripts/premiere-schedule-lib";
import {
  readFeaturedMatchStore,
  writeFeaturedMatchStore,
  type FeaturedMatch,
} from "../../src/server/agents/FeaturedMatch";

const NOW = new Date("2026-08-01T00:00:00.000Z");

function baseMatch(overrides: Partial<FeaturedMatch> = {}): FeaturedMatch {
  return {
    schemaVersion: 1,
    matchId: "feat_00000000000000000001",
    lane: "premiere",
    episodeRequestId: "ereq_abc",
    queueItemName: "20260801T000000Z-run1",
    title: "Test",
    description: "",
    participants: [],
    map: "world",
    format: "16p FFA",
    provenance: {
      source: "premiere-queue",
      sourceRef: "20260801T000000Z-run1",
      capturedAt: NOW.toISOString(),
    },
    state: "candidate",
    category: null,
    scheduledAt: null,
    revealAt: null,
    evidence: {
      dramaScore: null,
      dramaGrade: null,
      entertainmentScore: null,
      storyGrade: null,
      turnCount: 9000,
      decisionCount: null,
      degradedCount: null,
      seatCount: 16,
      replayComplete: true,
      notes: [],
    },
    postMatchSummary: null,
    result: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

async function writeQueueItem(
  queueRoot: string,
  name: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(queueRoot, "ready", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta), "utf8");
  await writeFile(path.join(dir, "bundle.source.json"), "{}", "utf8");
}

function metaFor(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1,
    kind: "real-league",
    runId: "run1",
    sourceFile: "bundle.source.json",
    sha256: "abc",
    turnCount: 9000,
    seatCount: 16,
    map: "world",
    checkpointTurns: [3150, 5850],
    turnIntervalMs: 120,
    coworldId: "cow_x",
    variantId: "v1",
    episodeId: null,
    experienceRequestId: "ereq_abc",
    generatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("resolveScheduleTarget", () => {
  let queueRoot: string;
  let artifactsRoot: string;
  let stateRoot: string;

  beforeEach(async () => {
    queueRoot = await mkdtemp(path.join(os.tmpdir(), "pw-sched-queue-"));
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-sched-artifacts-"));
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "pw-sched-state-"));
  });

  afterEach(async () => {
    await Promise.all(
      [queueRoot, artifactsRoot, stateRoot].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  const roots = () => ({
    queueReadyDir: path.join(queueRoot, "ready"),
    artifactsRoot,
    stateRoot,
    now: () => NOW,
  });

  it("finds an existing store record by matchId", async () => {
    const record = baseMatch({ state: "scheduled", scheduledAt: "2026-08-02T00:00:00.000Z" });
    await writeFeaturedMatchStore(stateRoot, { schemaVersion: 1, matches: [record] });
    const result = await resolveScheduleTarget(record.matchId, roots());
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.existedInStore).toBe(true);
      expect(result.record.matchId).toBe(record.matchId);
    }
  });

  it("finds an existing store record by queueItemName or episodeRequestId", async () => {
    const record = baseMatch();
    await writeFeaturedMatchStore(stateRoot, { schemaVersion: 1, matches: [record] });
    const byQueueItem = await resolveScheduleTarget(record.queueItemName!, roots());
    expect(byQueueItem.found).toBe(true);
    const byEpisode = await resolveScheduleTarget(record.episodeRequestId!, roots());
    expect(byEpisode.found).toBe(true);
  });

  it("falls back to a fresh live-queue candidate when not in the store", async () => {
    await writeQueueItem(queueRoot, "20260801T000000Z-runX", metaFor({ experienceRequestId: "ereq_fresh" }));
    const result = await resolveScheduleTarget("ereq_fresh", roots());
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.existedInStore).toBe(false);
      expect(result.record.state).toBe("candidate");
      expect(result.record.episodeRequestId).toBe("ereq_fresh");
    }
  });

  it("refuses to resolve an id that belongs to an ALREADY-PUBLISHED episode — inherits the named rejection", async () => {
    await writeQueueItem(
      queueRoot,
      "20260801T000000Z-runPub",
      metaFor({ experienceRequestId: "ereq_published" }),
    );
    await mkdir(path.join(artifactsRoot, "ai-league-runs", "league"), { recursive: true });
    await writeFile(
      path.join(artifactsRoot, "ai-league-runs", "league", "data.json"),
      JSON.stringify({ episodes: [{ episodeRequestId: "ereq_published" }] }),
      "utf8",
    );
    const result = await resolveScheduleTarget("ereq_published", roots());
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toContain("already_published_on_league");
    }
  });

  it("reports not found for an unknown id", async () => {
    const result = await resolveScheduleTarget("nonexistent", roots());
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.reason).toBe("not_found_in_queue_or_store");
    }
  });
});

describe("validateSchedule", () => {
  let queueRoot: string;

  beforeEach(async () => {
    queueRoot = await mkdtemp(path.join(os.tmpdir(), "pw-sched-validate-"));
  });

  afterEach(async () => {
    await rm(queueRoot, { recursive: true, force: true });
  });

  const roots = () => ({ queueReadyDir: path.join(queueRoot, "ready"), now: () => NOW });

  it("passes for an empty schedule", async () => {
    const issues = await validateSchedule([], roots());
    expect(issues).toEqual([]);
  });

  it("ignores archive-lane and cancelled/candidate records entirely", async () => {
    const issues = await validateSchedule(
      [
        baseMatch({
          lane: "archive",
          queueItemName: null,
          state: "published",
          scheduledAt: null,
        }),
        baseMatch({ matchId: "feat_00000000000000000002", state: "cancelled" }),
        baseMatch({ matchId: "feat_00000000000000000003", state: "candidate" }),
      ],
      roots(),
    );
    expect(issues).toEqual([]);
  });

  it("flags a scheduled record with no scheduledAt", async () => {
    const issues = await validateSchedule(
      [baseMatch({ state: "scheduled", scheduledAt: null })],
      roots(),
    );
    expect(issues.some((i) => i.reason.includes("missing_scheduled_at"))).toBe(true);
  });

  it("flags a scheduled record whose time is already in the past", async () => {
    const issues = await validateSchedule(
      [baseMatch({ state: "scheduled", scheduledAt: "2026-07-01T00:00:00.000Z" })],
      roots(),
    );
    expect(issues.some((i) => i.reason.includes("scheduled_at_in_past"))).toBe(true);
  });

  it("flags two premieres scheduled too close together (collision)", async () => {
    const issues = await validateSchedule(
      [
        baseMatch({
          matchId: "feat_00000000000000000001",
          queueItemName: "item1",
          state: "scheduled",
          scheduledAt: "2026-08-02T00:00:00.000Z",
        }),
        baseMatch({
          matchId: "feat_00000000000000000002",
          queueItemName: "item2",
          state: "scheduled",
          scheduledAt: "2026-08-02T00:10:00.000Z", // 10 minutes apart < MINIMUM_SCHEDULE_SPACING_MINUTES
        }),
      ],
      roots(),
    );
    expect(issues.filter((i) => i.reason.includes("schedule_collision"))).toHaveLength(2);
  });

  it("does not flag two premieres spaced far enough apart", async () => {
    expect(MINIMUM_SCHEDULE_SPACING_MINUTES).toBeGreaterThan(0);
    const issues = await validateSchedule(
      [
        baseMatch({
          matchId: "feat_00000000000000000001",
          queueItemName: "item1",
          state: "scheduled",
          scheduledAt: "2026-08-02T00:00:00.000Z",
        }),
        baseMatch({
          matchId: "feat_00000000000000000002",
          queueItemName: "item2",
          state: "scheduled",
          scheduledAt: "2026-08-02T01:00:00.000Z",
        }),
      ],
      roots(),
    );
    expect(issues.filter((i) => i.reason.includes("schedule_collision"))).toHaveLength(0);
  });

  it("flags a scheduled record whose queue item no longer exists in ready/", async () => {
    const issues = await validateSchedule(
      [
        baseMatch({
          state: "scheduled",
          scheduledAt: "2026-08-02T00:00:00.000Z",
          queueItemName: "gone-item",
        }),
      ],
      roots(),
    );
    expect(issues.some((i) => i.reason.includes("queue_item_missing"))).toBe(true);
  });

  it("does not flag a scheduled record whose queue item still exists", async () => {
    await writeQueueItem(queueRoot, "present-item", metaFor());
    const issues = await validateSchedule(
      [
        baseMatch({
          state: "scheduled",
          scheduledAt: "2026-08-02T00:00:00.000Z",
          queueItemName: "present-item",
        }),
      ],
      roots(),
    );
    expect(issues.some((i) => i.reason.includes("queue_item_missing"))).toBe(false);
  });
});

describe("upsertRecord", () => {
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "pw-sched-upsert-"));
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("inserts a new record", async () => {
    const record = baseMatch();
    await upsertRecord(stateRoot, record);
    const store = await readFeaturedMatchStore(stateRoot);
    expect(store.matches).toEqual([record]);
  });

  it("replaces an existing record by matchId rather than duplicating it", async () => {
    const record = baseMatch();
    await upsertRecord(stateRoot, record);
    const updated = { ...record, state: "scheduled" as const, scheduledAt: "2026-08-02T00:00:00.000Z" };
    await upsertRecord(stateRoot, updated);
    const store = await readFeaturedMatchStore(stateRoot);
    expect(store.matches).toHaveLength(1);
    expect(store.matches[0]?.state).toBe("scheduled");
  });
});
