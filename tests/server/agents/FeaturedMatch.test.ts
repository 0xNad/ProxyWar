import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FeaturedMatchSchema,
  mutateFeaturedMatchStore,
  newFeaturedMatchId,
  readFeaturedMatchStore,
  resolveFeaturedMatchStateRoot,
  writeFeaturedMatchStore,
  type FeaturedMatch,
} from "../../../src/server/agents/FeaturedMatch";

function baseRecord(overrides: Partial<FeaturedMatch> = {}): FeaturedMatch {
  return {
    schemaVersion: 1,
    matchId: newFeaturedMatchId(),
    lane: "premiere",
    episodeRequestId: null,
    queueItemName: "20260731T000000Z-run1",
    title: "Test Match",
    description: "",
    participants: [],
    map: "world",
    format: "16p FFA",
    provenance: {
      source: "premiere-queue",
      sourceRef: "20260731T000000Z-run1",
      capturedAt: "2026-07-31T00:00:00.000Z",
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
      turnCount: 10000,
      decisionCount: null,
      degradedCount: 0,
      seatCount: 16,
      replayComplete: true,
      notes: [],
    },
    postMatchSummary: null,
    result: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("FeaturedMatchSchema", () => {
  it("accepts a valid premiere-lane candidate", () => {
    expect(() => FeaturedMatchSchema.parse(baseRecord())).not.toThrow();
  });

  it("accepts a valid archive-lane record", () => {
    const record = baseRecord({
      lane: "archive",
      queueItemName: null,
      episodeRequestId: "ereq_abc123",
      state: "published",
      provenance: {
        source: "league-archive",
        sourceRef: "ereq_abc123",
        capturedAt: "2026-07-31T00:00:00.000Z",
      },
      result: { winnerAgentId: "agt_daveey", placements: [] },
    });
    expect(() => FeaturedMatchSchema.parse(record)).not.toThrow();
  });

  it("rejects a premiere-lane record with no queue item name", () => {
    expect(() =>
      FeaturedMatchSchema.parse(baseRecord({ queueItemName: null })),
    ).toThrow(/queue item name/);
  });

  it("rejects an archive-lane record that carries a queue item name — the two lanes are never mixed", () => {
    const record = baseRecord({
      lane: "archive",
      episodeRequestId: "ereq_abc123",
      state: "published",
    });
    expect(() => FeaturedMatchSchema.parse(record)).toThrow(
      /never mixed/,
    );
  });

  it("rejects an archive-lane record with no episode request id", () => {
    const record = baseRecord({
      lane: "archive",
      queueItemName: null,
      state: "published",
    });
    expect(() => FeaturedMatchSchema.parse(record)).toThrow(
      /episode it was published from/,
    );
  });

  it("rejects an archive-lane record that is scheduled — archive matches are never premiered", () => {
    const record = baseRecord({
      lane: "archive",
      queueItemName: null,
      episodeRequestId: "ereq_abc123",
      state: "published",
      scheduledAt: "2026-08-01T00:00:00.000Z",
    });
    expect(() => FeaturedMatchSchema.parse(record)).toThrow(
      /never scheduled or embargoed/,
    );
  });

  it("EMBARGO: rejects an unrevealed premiere-lane candidate that carries a result", () => {
    const record = baseRecord({
      state: "candidate",
      result: { winnerAgentId: "agt_daveey", placements: [] },
    });
    expect(() => FeaturedMatchSchema.parse(record)).toThrow(
      /embargo violation/,
    );
  });

  it("EMBARGO: rejects a scheduled-but-not-revealed premiere-lane record that carries a result", () => {
    const record = baseRecord({
      state: "scheduled",
      scheduledAt: "2026-08-01T00:00:00.000Z",
      result: { winnerAgentId: "agt_daveey", placements: [] },
    });
    expect(() => FeaturedMatchSchema.parse(record)).toThrow(
      /embargo violation/,
    );
  });

  it("allows a result once a premiere-lane record reaches revealed/archived", () => {
    const revealed = baseRecord({
      state: "revealed",
      scheduledAt: "2026-08-01T00:00:00.000Z",
      revealAt: "2026-08-01T01:00:00.000Z",
      result: { winnerAgentId: "agt_daveey", placements: [] },
    });
    expect(() => FeaturedMatchSchema.parse(revealed)).not.toThrow();
  });

  it("newFeaturedMatchId produces the feat_<20 hex> shape the schema requires", () => {
    const id = newFeaturedMatchId();
    expect(id).toMatch(/^feat_[a-f0-9]{20}$/);
    expect(() =>
      FeaturedMatchSchema.parse(baseRecord({ matchId: id })),
    ).not.toThrow();
  });
});

describe("resolveFeaturedMatchStateRoot", () => {
  it("defaults under Application Support when unconfigured", () => {
    const root = resolveFeaturedMatchStateRoot({}, "/Users/tester");
    expect(root).toBe(
      "/Users/tester/Library/Application Support/ProxyWar/storage/featured-matches",
    );
  });

  it("honors an explicit override", () => {
    const root = resolveFeaturedMatchStateRoot(
      { PROXYWAR_FEATURED_MATCH_STATE_ROOT: "/tmp/pw-featured-test" },
      "/Users/tester",
    );
    expect(root).toBe("/tmp/pw-featured-test");
  });

  it("rejects a relative override", () => {
    expect(() =>
      resolveFeaturedMatchStateRoot(
        { PROXYWAR_FEATURED_MATCH_STATE_ROOT: "relative/path" },
        "/Users/tester",
      ),
    ).toThrow(/invalid_featured_match_state_root/);
  });

  it("rejects the home directory itself", () => {
    expect(() =>
      resolveFeaturedMatchStateRoot(
        { PROXYWAR_FEATURED_MATCH_STATE_ROOT: "/Users/tester" },
        "/Users/tester",
      ),
    ).toThrow(/invalid_featured_match_state_root/);
  });
});

describe("FeaturedMatch store (atomic read/write)", () => {
  let stateRoot: string;

  afterEach(async () => {
    if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
  });

  it("reads an empty, schema-valid store on a cold start", async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "pw-featured-"));
    const store = await readFeaturedMatchStore(stateRoot);
    expect(store).toEqual({ schemaVersion: 1, matches: [] });
  });

  it("round-trips a written record", async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "pw-featured-"));
    const record = baseRecord();
    await writeFeaturedMatchStore(stateRoot, {
      schemaVersion: 1,
      matches: [record],
    });
    const reread = await readFeaturedMatchStore(stateRoot);
    expect(reread.matches).toEqual([record]);
  });

  it("mutateFeaturedMatchStore applies a mutation and persists it", async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "pw-featured-"));
    const record = baseRecord();
    await mutateFeaturedMatchStore(stateRoot, (file) => ({
      ...file,
      matches: [...file.matches, record],
    }));
    const reread = await readFeaturedMatchStore(stateRoot);
    expect(reread.matches).toHaveLength(1);
    expect(reread.matches[0]?.matchId).toBe(record.matchId);
  });

  it("throws rather than silently writing an invalid store (a schema bug in a caller must fail loudly)", async () => {
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "pw-featured-"));
    const invalid = baseRecord({
      lane: "archive",
      queueItemName: "should-not-be-set",
      episodeRequestId: "ereq_x",
      state: "published",
    });
    await expect(
      writeFeaturedMatchStore(stateRoot, {
        schemaVersion: 1,
        matches: [invalid],
      }),
    ).rejects.toThrow();
  });
});
