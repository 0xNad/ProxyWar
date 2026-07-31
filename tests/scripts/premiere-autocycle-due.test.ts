import { describe, expect, it } from "vitest";
import { findDueQueueItemName } from "../../src/scripts/premiere-autocycle-due";
import type { FeaturedMatch } from "../../src/server/agents/FeaturedMatch";

function record(overrides: Partial<FeaturedMatch> = {}): FeaturedMatch {
  return {
    schemaVersion: 1,
    matchId: `feat_${"a".repeat(20)}`,
    lane: "premiere",
    episodeRequestId: "ereq_x",
    queueItemName: "20260731T000000Z-run1",
    title: "Title",
    description: "",
    participants: [],
    map: "map",
    format: "1v1",
    provenance: {
      source: "premiere-queue",
      sourceRef: "20260731T000000Z-run1",
      capturedAt: "2026-07-31T00:00:00.000Z",
    },
    state: "published",
    category: null,
    scheduledAt: "2026-07-31T12:00:00.000Z",
    revealAt: null,
    evidence: {
      dramaScore: null,
      dramaGrade: null,
      entertainmentScore: null,
      storyGrade: null,
      turnCount: null,
      decisionCount: null,
      degradedCount: null,
      seatCount: null,
      replayComplete: false,
      notes: [],
    },
    postMatchSummary: null,
    result: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-07-31T11:57:00.000Z"); // 3 min before the fixture's scheduledAt

describe("findDueQueueItemName", () => {
  it("claims a published record once inside the lead window", () => {
    const match = findDueQueueItemName([record()], {
      leadMinutes: 4,
      readyItemNames: new Set(["20260731T000000Z-run1"]),
      now: NOW,
    });
    expect(match).toBe("20260731T000000Z-run1");
  });

  it("returns null when still outside the lead window", () => {
    const match = findDueQueueItemName([record()], {
      leadMinutes: 2, // needs to be within 2 min of 12:00; now is 11:57 (3 min out)
      readyItemNames: new Set(["20260731T000000Z-run1"]),
      now: NOW,
    });
    expect(match).toBeNull();
  });

  it("ignores a record still in 'scheduled' (not yet 'published')", () => {
    const match = findDueQueueItemName([record({ state: "scheduled" })], {
      leadMinutes: 4,
      readyItemNames: new Set(["20260731T000000Z-run1"]),
      now: NOW,
    });
    expect(match).toBeNull();
  });

  it("ignores an archive-lane record", () => {
    const match = findDueQueueItemName(
      [
        record({
          lane: "archive",
          queueItemName: null,
          episodeRequestId: "ereq_x",
          scheduledAt: null,
          revealAt: null,
        }),
      ],
      { leadMinutes: 4, readyItemNames: new Set(["20260731T000000Z-run1"]), now: NOW },
    );
    expect(match).toBeNull();
  });

  it("ignores a due record whose queue item no longer exists in ready/", () => {
    const match = findDueQueueItemName([record()], {
      leadMinutes: 4,
      readyItemNames: new Set(["some-other-item"]),
      now: NOW,
    });
    expect(match).toBeNull();
  });

  it("stays due arbitrarily far past scheduledAt — no upper bound", () => {
    const match = findDueQueueItemName(
      [record({ scheduledAt: "2020-01-01T00:00:00.000Z" })],
      { leadMinutes: 4, readyItemNames: new Set(["20260731T000000Z-run1"]), now: NOW },
    );
    expect(match).toBe("20260731T000000Z-run1");
  });

  it("picks the EARLIEST scheduledAt among several due, eligible records", () => {
    const later = record({
      queueItemName: "20260731T000100Z-run2",
      scheduledAt: "2026-07-31T11:58:00.000Z",
    });
    const earlier = record({
      queueItemName: "20260731T000200Z-run3",
      scheduledAt: "2026-07-31T11:55:00.000Z",
    });
    const match = findDueQueueItemName([later, earlier], {
      leadMinutes: 10,
      readyItemNames: new Set(["20260731T000100Z-run2", "20260731T000200Z-run3"]),
      now: NOW,
    });
    expect(match).toBe("20260731T000200Z-run3");
  });

  it("returns null against an empty schedule", () => {
    const match = findDueQueueItemName([], {
      leadMinutes: 4,
      readyItemNames: new Set(),
      now: NOW,
    });
    expect(match).toBeNull();
  });
});
