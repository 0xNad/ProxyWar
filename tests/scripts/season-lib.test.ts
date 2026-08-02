import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeSlotHealth,
  renderSeasonStatus,
  runSeasonActivate,
  runSeasonAddEvent,
  runSeasonAddStandingsSnapshot,
  runSeasonComplete,
  runSeasonCreate,
  runSeasonRemoveEvent,
  runSeasonStatus,
} from "../../src/scripts/season-lib";
import { writeFeaturedMatchStore, type FeaturedMatch } from "../../src/server/agents/FeaturedMatch";
import type { SeasonEventSlot, SeasonRegistryFile } from "../../src/server/agents/season/SeasonSchemas";

const NOW = () => new Date("2026-08-01T00:00:00.000Z");
const FEAT_ID = `feat_${"a".repeat(20)}`;

function baseFeaturedMatch(overrides: Partial<FeaturedMatch> = {}): FeaturedMatch {
  return {
    schemaVersion: 1,
    matchId: FEAT_ID,
    lane: "premiere",
    episodeRequestId: "ereq_x",
    queueItemName: "20260801T000000Z-run1",
    title: "Test",
    description: "",
    participants: [],
    map: "world",
    format: "16p FFA",
    provenance: { source: "premiere-queue", sourceRef: "20260801T000000Z-run1", capturedAt: NOW().toISOString() },
    state: "published",
    category: null,
    scheduledAt: "2026-08-08T18:00:00.000Z",
    revealAt: null,
    evidence: {
      dramaScore: null,
      dramaGrade: null,
      entertainmentScore: null,
      storyGrade: null,
      turnCount: 9000,
      decisionCount: null,
      degradedCount: null,
      seatCount: 2,
      replayComplete: true,
      notes: [],
    },
    postMatchSummary: null,
    result: null,
    createdAt: NOW().toISOString(),
    updatedAt: NOW().toISOString(),
    ...overrides,
  };
}

describe("season CLI lib", () => {
  let dir: string;
  let registryPath: string;
  let stateDir: string;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    if (stateDir !== undefined) await rm(stateDir, { recursive: true, force: true });
  });

  async function freshRoots(): Promise<void> {
    dir = await mkdtemp(path.join(os.tmpdir(), "season-cli-"));
    registryPath = path.join(dir, "seasons.json");
    stateDir = await mkdtemp(path.join(os.tmpdir(), "season-cli-state-"));
  }

  it("season:create then season:status round-trips a fresh draft season", async () => {
    await freshRoots();
    const created = await runSeasonCreate(
      { slug: "zero", title: "Season Zero", description: "desc", startDate: "2026-08-01", endDate: "2026-09-26" },
      registryPath,
      NOW,
    );
    expect(created.ok).toBe(true);
    const status = await runSeasonStatus(undefined, registryPath, stateDir, stateDir, NOW);
    expect(status).toContain("season_zero");
    expect(status).toContain("[draft]");
  });

  it("season:activate then season:complete walk the lifecycle", async () => {
    await freshRoots();
    await runSeasonCreate(
      { slug: "zero", title: "Season Zero", description: "", startDate: "2026-08-01", endDate: "2026-09-26" },
      registryPath,
      NOW,
    );
    const activated = await runSeasonActivate("season_zero", registryPath, NOW);
    expect(activated.ok).toBe(true);
    expect(activated.season?.state).toBe("active");
    const completed = await runSeasonComplete("season_zero", registryPath, NOW);
    expect(completed.ok).toBe(true);
    expect(completed.season?.state).toBe("completed");
  });

  it("refuses to complete a season still in draft", async () => {
    await freshRoots();
    await runSeasonCreate(
      { slug: "zero", title: "Season Zero", description: "", startDate: "2026-08-01", endDate: "2026-09-26" },
      registryPath,
      NOW,
    );
    const completed = await runSeasonComplete("season_zero", registryPath, NOW);
    expect(completed.ok).toBe(false);
    expect(completed.message).toContain("invalid_transition");
  });

  it("season:add-event adds a scheduled event slot, visible in season:status", async () => {
    await freshRoots();
    await runSeasonCreate(
      { slug: "zero", title: "Season Zero", description: "", startDate: "2026-08-01", endDate: "2026-09-26" },
      registryPath,
      NOW,
    );
    const added = await runSeasonAddEvent(
      { seasonId: "season_zero", featuredMatchId: FEAT_ID, scheduledAt: "2026-08-08T18:00:00.000Z" },
      registryPath,
      NOW,
    );
    expect(added.ok).toBe(true);
    const status = await runSeasonStatus("season_zero", registryPath, stateDir, stateDir, NOW);
    expect(status).toContain(FEAT_ID);
    expect(status).toContain("event slots: 1");
    // No FeaturedMatch record was ever written to stateDir for this id.
    expect(status).toContain("featured match not found");
  });

  it("season:add-event --archive folds a match into archive refs instead of a scheduled slot", async () => {
    await freshRoots();
    await runSeasonCreate(
      { slug: "zero", title: "Season Zero", description: "", startDate: "2026-08-01", endDate: "2026-09-26" },
      registryPath,
      NOW,
    );
    const added = await runSeasonAddEvent(
      { seasonId: "season_zero", featuredMatchId: FEAT_ID, scheduledAt: null, archive: true },
      registryPath,
      NOW,
    );
    expect(added.ok).toBe(true);
    expect(added.season?.archiveFeaturedMatchIds).toEqual([FEAT_ID]);
    expect(added.season?.eventSlots).toEqual([]);
  });

  it("season:add-event appends a standings snapshot reference", async () => {
    await freshRoots();
    await runSeasonCreate(
      { slug: "zero", title: "Season Zero", description: "", startDate: "2026-08-01", endDate: "2026-09-26" },
      registryPath,
      NOW,
    );
    const result = await runSeasonAddStandingsSnapshot(
      "season_zero",
      "2026-08-01T00:00:00.000Z",
      "season open",
      registryPath,
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(result.season?.standingsSnapshotRefs).toHaveLength(1);
  });

  it("season:status reports a clear not-found message for an unknown season", async () => {
    await freshRoots();
    const status = await runSeasonStatus("season_missing", registryPath, stateDir, stateDir, NOW);
    expect(status).toContain("season_not_found");
  });

  it("season:status reports promotable: true once the FeaturedMatch/EventPackage evidence is complete", async () => {
    await freshRoots();
    await runSeasonCreate(
      { slug: "zero", title: "Season Zero", description: "", startDate: "2026-08-01", endDate: "2026-09-26" },
      registryPath,
      NOW,
    );
    await runSeasonAddEvent(
      { seasonId: "season_zero", featuredMatchId: FEAT_ID, scheduledAt: "2026-08-08T18:00:00.000Z" },
      registryPath,
      NOW,
    );
    await writeFeaturedMatchStore(stateDir, { schemaVersion: 1, matches: [baseFeaturedMatch({ state: "candidate" })] });
    const status = await runSeasonStatus("season_zero", registryPath, stateDir, stateDir, NOW);
    // A "candidate" state record with no participants/package can never
    // pass the gate — health must say so honestly, never silently omit it.
    expect(status).toContain("promotable: false");
  });

  describe("runSeasonRemoveEvent", () => {
    it("removes a present slot", async () => {
      await freshRoots();
      await runSeasonCreate(
        { slug: "zero", title: "Season Zero", description: "", startDate: "2026-08-01", endDate: "2026-09-26" },
        registryPath,
        NOW,
      );
      await runSeasonAddEvent(
        { seasonId: "season_zero", featuredMatchId: FEAT_ID, scheduledAt: "2026-08-08T18:00:00.000Z" },
        registryPath,
        NOW,
      );
      const removed = await runSeasonRemoveEvent({ seasonId: "season_zero", featuredMatchId: FEAT_ID }, registryPath, stateDir, NOW);
      expect(removed.ok).toBe(true);
      expect(removed.season?.eventSlots).toEqual([]);
    });

    it("is idempotent: removing an already-absent slot still reports ok", async () => {
      await freshRoots();
      await runSeasonCreate(
        { slug: "zero", title: "Season Zero", description: "", startDate: "2026-08-01", endDate: "2026-09-26" },
        registryPath,
        NOW,
      );
      const removed = await runSeasonRemoveEvent({ seasonId: "season_zero", featuredMatchId: FEAT_ID }, registryPath, stateDir, NOW);
      expect(removed.ok).toBe(true);
    });

    it("reports season_not_found for an unknown season", async () => {
      await freshRoots();
      const removed = await runSeasonRemoveEvent({ seasonId: "season_missing", featuredMatchId: FEAT_ID }, registryPath, stateDir, NOW);
      expect(removed.ok).toBe(false);
      expect(removed.message).toContain("season_not_found");
    });

    it("refuses to remove a slot whose event is currently live/airing", async () => {
      await freshRoots();
      await runSeasonCreate(
        { slug: "zero", title: "Season Zero", description: "", startDate: "2026-08-01", endDate: "2026-09-26" },
        registryPath,
        NOW,
      );
      await runSeasonAddEvent(
        { seasonId: "season_zero", featuredMatchId: FEAT_ID, scheduledAt: "2026-08-01T00:10:00.000Z" },
        registryPath,
        NOW,
      );
      // Published, scheduled 10 minutes before "now" — inside the live window.
      await writeFeaturedMatchStore(stateDir, {
        schemaVersion: 1,
        matches: [baseFeaturedMatch({ state: "published", scheduledAt: "2026-08-01T00:10:00.000Z" })],
      });
      const removed = await runSeasonRemoveEvent(
        { seasonId: "season_zero", featuredMatchId: FEAT_ID },
        registryPath,
        stateDir,
        () => new Date("2026-08-01T00:30:00.000Z"),
      );
      expect(removed.ok).toBe(false);
      expect(removed.message).toContain("event_currently_live");
      // The registry must be untouched — a refusal never partially writes.
      const status = await runSeasonStatus("season_zero", registryPath, stateDir, stateDir, () => new Date("2026-08-01T00:30:00.000Z"));
      expect(status).toContain(FEAT_ID);
    });

    it("allows removal once the live window has elapsed", async () => {
      await freshRoots();
      await runSeasonCreate(
        { slug: "zero", title: "Season Zero", description: "", startDate: "2026-08-01", endDate: "2026-09-26" },
        registryPath,
        NOW,
      );
      await runSeasonAddEvent(
        { seasonId: "season_zero", featuredMatchId: FEAT_ID, scheduledAt: "2026-08-01T00:10:00.000Z" },
        registryPath,
        NOW,
      );
      await writeFeaturedMatchStore(stateDir, {
        schemaVersion: 1,
        matches: [baseFeaturedMatch({ state: "published", scheduledAt: "2026-08-01T00:10:00.000Z" })],
      });
      const removed = await runSeasonRemoveEvent(
        { seasonId: "season_zero", featuredMatchId: FEAT_ID },
        registryPath,
        stateDir,
        () => new Date("2026-08-01T03:00:00.000Z"),
      );
      expect(removed.ok).toBe(true);
      expect(removed.season?.eventSlots).toEqual([]);
    });

    it("allows removal of a revealed (no longer airing) premiere-lane event", async () => {
      await freshRoots();
      await runSeasonCreate(
        { slug: "zero", title: "Season Zero", description: "", startDate: "2026-08-01", endDate: "2026-09-26" },
        registryPath,
        NOW,
      );
      await runSeasonAddEvent(
        { seasonId: "season_zero", featuredMatchId: FEAT_ID, scheduledAt: "2026-08-01T00:10:00.000Z" },
        registryPath,
        NOW,
      );
      await writeFeaturedMatchStore(stateDir, {
        schemaVersion: 1,
        matches: [baseFeaturedMatch({ state: "revealed", scheduledAt: "2026-08-01T00:10:00.000Z" })],
      });
      const removed = await runSeasonRemoveEvent(
        { seasonId: "season_zero", featuredMatchId: FEAT_ID },
        registryPath,
        stateDir,
        () => new Date("2026-08-01T00:30:00.000Z"),
      );
      expect(removed.ok).toBe(true);
    });
  });
});

describe("renderSeasonStatus", () => {
  it("reports '(no seasons registered)' for an empty registry", () => {
    const empty: SeasonRegistryFile = { schemaVersion: 1, seasons: [] };
    expect(renderSeasonStatus(empty)).toBe("(no seasons registered)");
  });
});

describe("computeSlotHealth", () => {
  const NOW_DATE = NOW();

  function slot(overrides: Partial<SeasonEventSlot> = {}): SeasonEventSlot {
    return { featuredMatchId: FEAT_ID, scheduledAt: "2026-08-08T18:00:00.000Z", addedAt: NOW_DATE.toISOString(), ...overrides };
  }

  it("reports matchFound: false for a dangling reference", () => {
    const health = computeSlotHealth(slot(), [], [], NOW_DATE);
    expect(health).toEqual({ matchFound: false, promotable: false, aired: false, agedOut: false });
  });

  it("reports agedOut: true for a slot whose time has passed with no reveal/promotion", () => {
    const match = baseFeaturedMatch({ state: "candidate", participants: [] });
    const health = computeSlotHealth(slot({ scheduledAt: "2026-07-01T00:00:00.000Z" }), [match], [], NOW_DATE);
    expect(health.matchFound).toBe(true);
    expect(health.aired).toBe(false);
    expect(health.promotable).toBe(false);
    expect(health.agedOut).toBe(true);
  });

  it("is never agedOut for a future-dated slot even if incomplete", () => {
    const match = baseFeaturedMatch({ state: "candidate", participants: [] });
    const health = computeSlotHealth(slot({ scheduledAt: "2026-12-01T00:00:00.000Z" }), [match], [], NOW_DATE);
    expect(health.agedOut).toBe(false);
  });

  it("reports aired: true for an already-revealed premiere-lane match", () => {
    const match = baseFeaturedMatch({ state: "revealed" });
    const health = computeSlotHealth(slot(), [match], [], NOW_DATE);
    expect(health.aired).toBe(true);
    expect(health.agedOut).toBe(false);
  });

  it("reports aired: true unconditionally for an archive-lane match", () => {
    const match = baseFeaturedMatch({ lane: "archive", queueItemName: null, scheduledAt: null, episodeRequestId: "ereq_x" });
    const health = computeSlotHealth(slot(), [match], [], NOW_DATE);
    expect(health.aired).toBe(true);
  });
});
