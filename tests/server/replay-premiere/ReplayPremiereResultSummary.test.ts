import { describe, expect, it } from "vitest";
import { encodePremiereAuthoritativeResult } from "../../../src/server/replay-premiere/ReplayPremiereAuthoritativeResult";
import type { ReplayPremiereHttpTarget } from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import {
  isSha256Hex,
  sha256Hex,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import {
  assertPremiereResultSummaryAggregateOnly,
  buildPremiereResultSummary,
  buildPremiereResultSummaryFromTarget,
  parsePremiereResultSummary,
  REPLAY_PREMIERE_RESULT_SUMMARY_KIND,
  type PremiereResultSummaryInput,
} from "../../../src/server/replay-premiere/ReplayPremiereResultSummary";
import {
  authoritativeResultBytes,
  eligibilityFixture,
  NOW,
  PREMIERE_ID,
  seatFixtures,
} from "./ReplayPremiereFixtures";

const COMMITMENT = sha256Hex("commitment");
const RECLAIMED_AT = "2026-07-20T18:45:00.000Z";
const REVEALED_AT = "2026-07-20T18:00:01.000Z";

function checkpointView(options: {
  id: string;
  sequence: number;
  distribution: Record<string, number>;
  total: number;
  correct: number | null;
}): unknown {
  return {
    id: options.id,
    sequence: options.sequence,
    opensAt: null,
    closesAt: null,
    outageShiftMs: 0,
    optionSeatIds: ["SEAT0001", "SEAT0002"],
    state: "closed",
    participantPrediction: null,
    distribution: options.distribution,
    totalPredictions: options.total,
    resolution:
      options.correct === null
        ? { kind: "void", reason: "no_winner", resolvedAt: REVEALED_AT }
        : { kind: "winner", winnerSeatId: "SEAT0001", resolvedAt: REVEALED_AT },
    crowdAccuracy:
      options.correct === null
        ? null
        : {
            correctPredictions: options.correct,
            totalPredictions: options.total,
          },
  };
}

function reaction(options: {
  participantId: string;
  sequence: number;
  turn: number;
  kind: string;
}): unknown {
  return {
    id: `react_${options.participantId}_${options.sequence}_${options.kind}`,
    premiereId: PREMIERE_ID,
    participantId: options.participantId,
    sequence: options.sequence,
    turn: options.turn,
    kind: options.kind,
    policyIdentity: null,
    eventContext: null,
    createdAt: REVEALED_AT,
  };
}

function revealedTarget(): ReplayPremiereHttpTarget {
  return {
    runtime: {
      premiereId: PREMIERE_ID,
      readLifecycleState: () => "revealed",
      readBootstrap: () => ({
        premiereId: PREMIERE_ID,
        publicationCommitmentHash: COMMITMENT,
        publicDefinition: {
          title: "Controlled exhibition",
          spoilerNeutralDescription: "A completed match.",
          map: { id: "pangaea", label: "Pangaea" },
          matchFormat: { id: "ffa-2p", label: "2-player FFA", seatCount: 2 },
        },
        provenance: {
          sourceKind: "controlled_exhibition",
          sourceRunId: "controlled-run-001",
          sourceReplaySha256: sha256Hex("source"),
          seats: seatFixtures(),
        },
      }),
      readReveal: () => ({
        premiereId: PREMIERE_ID,
        revealedAt: REVEALED_AT,
        eligibilityRecord: eligibilityFixture(),
        authoritativeResult: encodePremiereAuthoritativeResult(
          authoritativeResultBytes(),
        ),
      }),
    },
    interactions: {
      readCheckpoints: () => [
        checkpointView({
          id: "cp_first00000001",
          sequence: 35,
          distribution: { SEAT0001: 3, SEAT0002: 1 },
          total: 4,
          correct: 3,
        }),
        checkpointView({
          id: "cp_second0000001",
          sequence: 65,
          distribution: { SEAT0001: 2, SEAT0002: 2 },
          total: 4,
          correct: 2,
        }),
      ],
      readState: () => ({
        reactions: [
          reaction({
            participantId: `guest_${"a".repeat(32)}`,
            sequence: 300,
            turn: 3,
            kind: "betrayal",
          }),
          reaction({
            participantId: `guest_${"b".repeat(32)}`,
            sequence: 300,
            turn: 3,
            kind: "betrayal",
          }),
          reaction({
            participantId: `guest_${"c".repeat(32)}`,
            sequence: 500,
            turn: 5,
            kind: "smart",
          }),
        ],
      }),
    },
  } as unknown as ReplayPremiereHttpTarget;
}

describe("buildPremiereResultSummaryFromTarget", () => {
  it("builds an aggregate outcome, predictions, and deduped markers", () => {
    const summary = buildPremiereResultSummaryFromTarget({
      target: revealedTarget(),
      terminalState: "revealed",
      reclaimedAt: RECLAIMED_AT,
    });

    expect(summary.summaryKind).toBe(REPLAY_PREMIERE_RESULT_SUMMARY_KIND);
    expect(summary.premiereId).toBe(PREMIERE_ID);
    expect(summary.sourceRunId).toBe("controlled-run-001");
    expect(summary.terminalState).toBe("revealed");
    expect(summary.revealedAt).toBe(REVEALED_AT);
    expect(summary.reclaimedAt).toBe(RECLAIMED_AT);
    // Public map/format labels are pulled from the target's public definition.
    expect(summary.mapLabel).toBe("Pangaea");
    expect(summary.formatLabel).toBe("2-player FFA");

    expect(summary.outcome).not.toBeNull();
    expect(summary.outcome?.winner).toEqual({
      category: "player",
      groupLabel: null,
      seatIds: ["SEAT0001"],
    });
    expect(summary.outcome?.turnCount).toBe(6);
    expect(summary.outcome?.standings).toEqual([
      { seatId: "SEAT0001", displayName: "Alpha", won: true },
      { seatId: "SEAT0002", displayName: "Beta", won: false },
    ]);

    expect(summary.predictions).toHaveLength(2);
    expect(summary.predictions[0]).toEqual({
      checkpointId: "cp_first00000001",
      sequence: 35,
      totalPredictions: 4,
      options: [
        { seatId: "SEAT0001", count: 3 },
        { seatId: "SEAT0002", count: 1 },
      ],
      correctPredictions: 3,
    });

    // Markers are aggregated by (kind, turn), sorted by count desc.
    expect(summary.markers).toEqual([
      { kind: "betrayal", turn: 3, count: 2 },
      { kind: "smart", turn: 5, count: 1 },
    ]);
    expect(isSha256Hex(summary.summaryHash)).toBe(true);
  });

  it("contains no per-viewer identifiers anywhere in the summary", () => {
    const summary = buildPremiereResultSummaryFromTarget({
      target: revealedTarget(),
      terminalState: "revealed",
      reclaimedAt: RECLAIMED_AT,
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("participantId");
    expect(serialized).not.toContain("guest_");
    expect(serialized).not.toContain("sess_");
    expect(serialized).not.toContain("ip_");
    // The defensive scan agrees.
    expect(() =>
      assertPremiereResultSummaryAggregateOnly(summary),
    ).not.toThrow();
  });
});

describe("aggregate-only enforcement", () => {
  const baseInput = (): PremiereResultSummaryInput => ({
    premiereId: PREMIERE_ID,
    sourceRunId: "controlled-run-001",
    sourceKind: "controlled_exhibition",
    publicationCommitmentHash: COMMITMENT,
    terminalState: "revealed",
    revealedAt: REVEALED_AT,
    reclaimedAt: RECLAIMED_AT,
    outcome: {
      winner: { category: "player", groupLabel: null, seatIds: ["SEAT0001"] },
      turnCount: 6,
      completedAt: NOW.toISOString(),
      standings: [{ seatId: "SEAT0001", displayName: "Alpha", won: true }],
    },
    predictions: [],
    markers: [],
  });

  it("rejects a summary that smuggles a per-viewer field", () => {
    const summary = buildPremiereResultSummary(baseInput());
    const tampered = {
      ...summary,
      markers: [{ kind: "smart", turn: 4, count: 1, participantId: "guest_x" }],
    } as unknown as ReturnType<typeof buildPremiereResultSummary>;
    expect(() => assertPremiereResultSummaryAggregateOnly(tampered)).toThrow(
      /per_viewer/,
    );
  });

  it("rejects a per-viewer id value even under an innocuous key", () => {
    const summary = buildPremiereResultSummary(baseInput());
    const tampered = {
      ...summary,
      sourceRunId: `guest_${"z".repeat(20)}`,
    } as unknown as ReturnType<typeof buildPremiereResultSummary>;
    expect(() => assertPremiereResultSummaryAggregateOnly(tampered)).toThrow(
      /per_viewer_identifier/,
    );
  });

  it("carries optional public labels through hash, parse, and the scan", () => {
    const summary = buildPremiereResultSummary({
      ...baseInput(),
      mapLabel: "World",
      formatLabel: "12-player FFA",
    });
    expect(summary.mapLabel).toBe("World");
    expect(summary.formatLabel).toBe("12-player FFA");
    // Labels are aggregate public metadata, not per-viewer data.
    expect(() =>
      assertPremiereResultSummaryAggregateOnly(summary),
    ).not.toThrow();
    // The hash covers the labels: a clean round-trip validates, but mutating a
    // label breaks the hash.
    const bytes = Buffer.from(JSON.stringify(summary), "utf8");
    expect(parsePremiereResultSummary(bytes)).toEqual(summary);
    const tampered = { ...summary, mapLabel: "Pangaea" };
    expect(() =>
      parsePremiereResultSummary(Buffer.from(JSON.stringify(tampered), "utf8")),
    ).toThrow(/summary_hash_mismatch/);
  });

  it("still builds and parses a legacy summary with no public labels", () => {
    const summary = buildPremiereResultSummary(baseInput());
    expect(summary.mapLabel).toBeUndefined();
    expect(summary.formatLabel).toBeUndefined();
    // A labels-less summary hashes and round-trips exactly like before, so old
    // archived summaries stay valid.
    const bytes = Buffer.from(JSON.stringify(summary), "utf8");
    expect(parsePremiereResultSummary(bytes)).toEqual(summary);
  });
});

describe("summary serialization", () => {
  it("round-trips through parse and rejects a mutated hash", () => {
    const summary = buildPremiereResultSummaryFromTarget({
      target: revealedTarget(),
      terminalState: "revealed",
      reclaimedAt: RECLAIMED_AT,
    });
    const bytes = Buffer.from(`${JSON.stringify(summary)}\n`, "utf8");
    const parsed = parsePremiereResultSummary(bytes);
    expect(parsed).toEqual(summary);

    const mutated = { ...summary, reclaimedAt: "2026-07-20T19:00:00.000Z" };
    expect(() =>
      parsePremiereResultSummary(Buffer.from(JSON.stringify(mutated), "utf8")),
    ).toThrow(/summary_hash_mismatch/);
  });

  it("refuses an outcome on a failed terminal (spoiler safety)", () => {
    const input = {
      ...(() => {
        const base = {
          premiereId: PREMIERE_ID,
          sourceRunId: "controlled-run-001",
          sourceKind: "controlled_exhibition" as const,
          publicationCommitmentHash: COMMITMENT,
          terminalState: "failed" as const,
          revealedAt: null,
          reclaimedAt: RECLAIMED_AT,
          predictions: [],
          markers: [],
        };
        return base;
      })(),
      outcome: {
        winner: null,
        turnCount: 6,
        completedAt: NOW.toISOString(),
        standings: [],
      },
    } satisfies PremiereResultSummaryInput;
    expect(() => buildPremiereResultSummary(input)).toThrow(
      /outcome_without_reveal/,
    );
  });
});
