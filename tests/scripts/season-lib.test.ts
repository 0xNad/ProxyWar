import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderSeasonStatus,
  runSeasonActivate,
  runSeasonAddEvent,
  runSeasonAddStandingsSnapshot,
  runSeasonComplete,
  runSeasonCreate,
  runSeasonStatus,
} from "../../src/scripts/season-lib";
import type { SeasonRegistryFile } from "../../src/server/agents/season/SeasonSchemas";

const NOW = () => new Date("2026-08-01T00:00:00.000Z");
const FEAT_ID = `feat_${"a".repeat(20)}`;

describe("season CLI lib", () => {
  let dir: string;
  let registryPath: string;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("season:create then season:status round-trips a fresh draft season", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "season-cli-"));
    registryPath = path.join(dir, "seasons.json");
    const created = await runSeasonCreate(
      { slug: "zero", title: "Season Zero", description: "desc", startDate: "2026-08-01", endDate: "2026-09-26" },
      registryPath,
      NOW,
    );
    expect(created.ok).toBe(true);
    const status = await runSeasonStatus(undefined, registryPath);
    expect(status).toContain("season_zero");
    expect(status).toContain("[draft]");
  });

  it("season:activate then season:complete walk the lifecycle", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "season-cli-"));
    registryPath = path.join(dir, "seasons.json");
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
    dir = await mkdtemp(path.join(os.tmpdir(), "season-cli-"));
    registryPath = path.join(dir, "seasons.json");
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
    dir = await mkdtemp(path.join(os.tmpdir(), "season-cli-"));
    registryPath = path.join(dir, "seasons.json");
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
    const status = await runSeasonStatus("season_zero", registryPath);
    expect(status).toContain(FEAT_ID);
    expect(status).toContain("event slots: 1");
  });

  it("season:add-event --archive folds a match into archive refs instead of a scheduled slot", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "season-cli-"));
    registryPath = path.join(dir, "seasons.json");
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
    dir = await mkdtemp(path.join(os.tmpdir(), "season-cli-"));
    registryPath = path.join(dir, "seasons.json");
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
    dir = await mkdtemp(path.join(os.tmpdir(), "season-cli-"));
    registryPath = path.join(dir, "seasons.json");
    const status = await runSeasonStatus("season_missing", registryPath);
    expect(status).toContain("season_not_found");
  });
});

describe("renderSeasonStatus", () => {
  it("reports '(no seasons registered)' for an empty registry", () => {
    const empty: SeasonRegistryFile = { schemaVersion: 1, seasons: [] };
    expect(renderSeasonStatus(empty)).toBe("(no seasons registered)");
  });
});
