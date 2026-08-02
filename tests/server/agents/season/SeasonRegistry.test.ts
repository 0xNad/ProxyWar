import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SeasonSchema, seasonIdFromSlug, type Season } from "../../../../src/server/agents/season/SeasonSchemas";
import {
  activateSeason,
  addArchiveMatch,
  addEventSlot,
  addStandingsSnapshotRef,
  completeSeason,
  createSeason,
  isEventCurrentlyLive,
  loadSeasonRegistry,
  removeEventSlot,
  resolveSeasonRegistryDir,
  saveSeasonRegistry,
  withSeason,
  SEASON_REGISTRY_DIR_ENV,
} from "../../../../src/server/agents/season/SeasonRegistry";
import type { SeasonRegistryFile, SeasonEventSlot } from "../../../../src/server/agents/season/SeasonSchemas";
import type { FeaturedMatch } from "../../../../src/server/agents/FeaturedMatch";

const NOW = "2026-08-01T00:00:00.000Z";

function baseSeason(overrides: Partial<Season> = {}): Season {
  return {
    schemaVersion: 1,
    id: "season_zero",
    slug: "zero",
    title: "Season Zero",
    description: "",
    startDate: "2026-08-01",
    endDate: "2026-09-26",
    state: "draft",
    eventSlots: [],
    archiveFeaturedMatchIds: [],
    standingsSnapshotRefs: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function registryOf(...seasons: Season[]): SeasonRegistryFile {
  return { schemaVersion: 1, seasons };
}

describe("SeasonSchema", () => {
  it("accepts a valid draft season", () => {
    expect(() => SeasonSchema.parse(baseSeason())).not.toThrow();
  });

  it("rejects startDate >= endDate", () => {
    expect(() => SeasonSchema.parse(baseSeason({ startDate: "2026-09-26", endDate: "2026-08-01" }))).toThrow();
  });

  it("rejects an id that doesn't match season_<slug>", () => {
    expect(() => SeasonSchema.parse(baseSeason({ id: "season_mismatch", slug: "zero" }))).toThrow();
  });

  it("rejects duplicate featuredMatchIds across eventSlots", () => {
    const dupe = "feat_" + "a".repeat(20);
    expect(() =>
      SeasonSchema.parse(
        baseSeason({
          eventSlots: [
            { featuredMatchId: dupe, scheduledAt: null, addedAt: NOW },
            { featuredMatchId: dupe, scheduledAt: null, addedAt: NOW },
          ],
        }),
      ),
    ).toThrow();
  });

  it("seasonIdFromSlug derives the deterministic id", () => {
    expect(seasonIdFromSlug("zero")).toBe("season_zero");
  });
});

describe("resolveSeasonRegistryDir", () => {
  it("defaults to resources/season under cwd", () => {
    expect(resolveSeasonRegistryDir({}, "/repo")).toBe(path.join("/repo", "resources", "season"));
  });

  it("honors the override env var", () => {
    expect(resolveSeasonRegistryDir({ [SEASON_REGISTRY_DIR_ENV]: "custom-dir" }, "/repo")).toBe(
      path.resolve("/repo", "custom-dir"),
    );
  });
});

describe("Season registry file (load/save)", () => {
  let dir: string;
  let filePath: string;

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty registry on a cold start (no file yet)", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "season-registry-"));
    filePath = path.join(dir, "seasons.json");
    const registry = await loadSeasonRegistry(filePath);
    expect(registry).toEqual({ schemaVersion: 1, seasons: [] });
  });

  it("round-trips a saved season", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "season-registry-"));
    filePath = path.join(dir, "seasons.json");
    await saveSeasonRegistry(registryOf(baseSeason()), filePath);
    const reloaded = await loadSeasonRegistry(filePath);
    expect(reloaded.seasons).toHaveLength(1);
    expect(reloaded.seasons[0]!.id).toBe("season_zero");
  });

  it("throws loudly on a corrupt file rather than silently resetting", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "season-registry-"));
    filePath = path.join(dir, "seasons.json");
    await writeFile(filePath, "{not json", "utf8");
    await expect(loadSeasonRegistry(filePath)).rejects.toThrow();
  });
});

describe("createSeason", () => {
  it("creates a fresh draft season", () => {
    const result = createSeason(registryOf(), {
      slug: "zero",
      title: "Season Zero",
      description: "",
      startDate: "2026-08-01",
      endDate: "2026-09-26",
    }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.season.state).toBe("draft");
      expect(result.season.id).toBe("season_zero");
    }
  });

  it("refuses to create a season whose id already exists", () => {
    const registry = registryOf(baseSeason());
    const result = createSeason(registry, {
      slug: "zero",
      title: "Season Zero Redux",
      description: "",
      startDate: "2026-08-01",
      endDate: "2026-09-26",
    }, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("season_already_exists");
  });
});

describe("activateSeason / completeSeason", () => {
  it("walks draft -> active -> completed", () => {
    const registry = registryOf(baseSeason());
    const activated = activateSeason(registry, "season_zero", NOW);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    const afterActivate = withSeason(registry, activated.season);
    const completed = completeSeason(afterActivate, "season_zero", NOW);
    expect(completed.ok).toBe(true);
    if (completed.ok) expect(completed.season.state).toBe("completed");
  });

  it("refuses to activate a season that is already active/completed", () => {
    const registry = registryOf(baseSeason({ state: "active" }));
    const result = activateSeason(registry, "season_zero", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid_transition");
  });

  it("refuses to complete a draft season (must be active first)", () => {
    const registry = registryOf(baseSeason());
    const result = completeSeason(registry, "season_zero", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid_transition");
  });

  it("refuses to activate a second season while one is already active", () => {
    const registry = registryOf(
      baseSeason({ state: "active" }),
      baseSeason({ id: "season_one", slug: "one" }),
    );
    const result = activateSeason(registry, "season_one", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("another_season_active");
  });

  it("reports season_not_found for an unknown id", () => {
    const result = activateSeason(registryOf(), "season_missing", NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("season_not_found");
  });
});

describe("addEventSlot", () => {
  const feat = `feat_${"a".repeat(20)}`;

  it("adds a new event slot", () => {
    const result = addEventSlot(registryOf(baseSeason()), "season_zero", { featuredMatchId: feat, scheduledAt: NOW }, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.season.eventSlots).toHaveLength(1);
  });

  it("re-adding the same featuredMatchId updates it in place rather than duplicating", () => {
    const withSlot = addEventSlot(registryOf(baseSeason()), "season_zero", { featuredMatchId: feat, scheduledAt: null }, NOW);
    expect(withSlot.ok).toBe(true);
    if (!withSlot.ok) return;
    const registryWithSlot = withSeason(registryOf(baseSeason()), withSlot.season);
    const retimed = addEventSlot(registryWithSlot, "season_zero", { featuredMatchId: feat, scheduledAt: "2026-08-10T00:00:00.000Z" }, NOW);
    expect(retimed.ok).toBe(true);
    if (retimed.ok) {
      expect(retimed.season.eventSlots).toHaveLength(1);
      expect(retimed.season.eventSlots[0]!.scheduledAt).toBe("2026-08-10T00:00:00.000Z");
    }
  });

  it("refuses to add an event slot to a completed season", () => {
    const result = addEventSlot(registryOf(baseSeason({ state: "completed" })), "season_zero", { featuredMatchId: feat, scheduledAt: null }, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("season_completed");
  });
});

describe("addArchiveMatch", () => {
  const feat = `feat_${"b".repeat(20)}`;

  it("adds and dedupes archive references", () => {
    const first = addArchiveMatch(registryOf(baseSeason()), "season_zero", feat, NOW);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const registryAfter = withSeason(registryOf(baseSeason()), first.season);
    const second = addArchiveMatch(registryAfter, "season_zero", feat, NOW);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.season.archiveFeaturedMatchIds).toEqual([feat]);
  });
});

describe("addStandingsSnapshotRef", () => {
  it("appends a snapshot reference", () => {
    const result = addStandingsSnapshotRef(
      registryOf(baseSeason()),
      "season_zero",
      { snapshotGeneratedAt: "2026-08-01T00:00:00.000Z", label: "season open" },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.season.standingsSnapshotRefs).toHaveLength(1);
  });

  it("refuses a duplicate snapshot reference", () => {
    const withRef = addStandingsSnapshotRef(
      registryOf(baseSeason()),
      "season_zero",
      { snapshotGeneratedAt: "2026-08-01T00:00:00.000Z", label: "season open" },
      NOW,
    );
    expect(withRef.ok).toBe(true);
    if (!withRef.ok) return;
    const registryAfter = withSeason(registryOf(baseSeason()), withRef.season);
    const dupe = addStandingsSnapshotRef(
      registryAfter,
      "season_zero",
      { snapshotGeneratedAt: "2026-08-01T00:00:00.000Z", label: "again" },
      NOW,
    );
    expect(dupe.ok).toBe(false);
    if (!dupe.ok) expect(dupe.reason).toContain("snapshot_already_referenced");
  });
});

function baseFeaturedMatch(overrides: Partial<FeaturedMatch> = {}): FeaturedMatch {
  return {
    schemaVersion: 1,
    matchId: `feat_${"a".repeat(20)}`,
    lane: "premiere",
    episodeRequestId: "ereq_x",
    queueItemName: "20260801T000000Z-run1",
    title: "Test",
    description: "",
    participants: [],
    map: "world",
    format: "16p FFA",
    provenance: { source: "premiere-queue", sourceRef: "20260801T000000Z-run1", capturedAt: NOW },
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function baseSlot(overrides: Partial<SeasonEventSlot> = {}): SeasonEventSlot {
  return {
    featuredMatchId: `feat_${"a".repeat(20)}`,
    scheduledAt: "2026-08-08T18:00:00.000Z",
    addedAt: NOW,
    ...overrides,
  };
}

describe("removeEventSlot", () => {
  const feat = `feat_${"a".repeat(20)}`;

  it("removes a present slot", () => {
    const withSlot = addEventSlot(registryOf(baseSeason()), "season_zero", { featuredMatchId: feat, scheduledAt: NOW }, NOW);
    expect(withSlot.ok).toBe(true);
    if (!withSlot.ok) return;
    const result = removeEventSlot(registryOf(withSlot.season), "season_zero", feat, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.season.eventSlots).toEqual([]);
  });

  it("is idempotent: removing an already-absent slot succeeds as a no-op", () => {
    const result = removeEventSlot(registryOf(baseSeason()), "season_zero", feat, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.season.eventSlots).toEqual([]);
    // Calling it again produces the identical result — true idempotency.
    const again = removeEventSlot(registryOf(baseSeason()), "season_zero", feat, NOW);
    expect(again).toEqual(result);
  });

  it("refuses to remove an event slot from a completed season", () => {
    const withSlot = addEventSlot(registryOf(baseSeason()), "season_zero", { featuredMatchId: feat, scheduledAt: NOW }, NOW);
    expect(withSlot.ok).toBe(true);
    if (!withSlot.ok) return;
    const completedSeason = { ...withSlot.season, state: "completed" as const };
    const result = removeEventSlot(registryOf(completedSeason), "season_zero", feat, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("season_completed");
  });

  it("reports season_not_found for an unknown season id", () => {
    const result = removeEventSlot(registryOf(baseSeason()), "season_missing", feat, NOW);
    expect(result.ok).toBe(false);
  });
});

describe("isEventCurrentlyLive", () => {
  it("is false for an archive-lane match regardless of state", () => {
    const match = baseFeaturedMatch({ lane: "archive", state: "published", queueItemName: null, scheduledAt: null });
    const slot = baseSlot();
    expect(isEventCurrentlyLive(match, slot, new Date("2026-08-08T18:30:00.000Z"))).toBe(false);
  });

  it("is false for a premiere-lane match not yet published (scheduled)", () => {
    const match = baseFeaturedMatch({ state: "scheduled" });
    const slot = baseSlot();
    expect(isEventCurrentlyLive(match, slot, new Date("2026-08-08T18:30:00.000Z"))).toBe(false);
  });

  it("is true for a published premiere-lane match inside its live window", () => {
    const match = baseFeaturedMatch({ state: "published", scheduledAt: "2026-08-08T18:00:00.000Z" });
    const slot = baseSlot({ scheduledAt: "2026-08-08T18:00:00.000Z" });
    // 30 minutes after scheduledAt — well inside PREMIERE_LOOP_HOLD_WINDOW_MS (75min).
    expect(isEventCurrentlyLive(match, slot, new Date("2026-08-08T18:30:00.000Z"))).toBe(true);
  });

  it("is false once the live window has elapsed", () => {
    const match = baseFeaturedMatch({ state: "published", scheduledAt: "2026-08-08T18:00:00.000Z" });
    const slot = baseSlot({ scheduledAt: "2026-08-08T18:00:00.000Z" });
    // 2 hours later — past the 75-minute hold window.
    expect(isEventCurrentlyLive(match, slot, new Date("2026-08-08T20:00:00.000Z"))).toBe(false);
  });

  it("is false before the scheduled time even if published", () => {
    const match = baseFeaturedMatch({ state: "published", scheduledAt: "2026-08-08T18:00:00.000Z" });
    const slot = baseSlot({ scheduledAt: "2026-08-08T18:00:00.000Z" });
    expect(isEventCurrentlyLive(match, slot, new Date("2026-08-08T17:00:00.000Z"))).toBe(false);
  });

  it("falls back to the slot's own scheduledAt when the match has none", () => {
    const match = baseFeaturedMatch({ state: "published", scheduledAt: null });
    const slot = baseSlot({ scheduledAt: "2026-08-08T18:00:00.000Z" });
    expect(isEventCurrentlyLive(match, slot, new Date("2026-08-08T18:30:00.000Z"))).toBe(true);
  });
});
