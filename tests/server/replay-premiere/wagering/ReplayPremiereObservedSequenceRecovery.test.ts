/**
 * A `contentSource: "tap"` (wagering/betting page) client legitimately
 * reports a fine-grained `observedSequence` (`latestFrame.sequence`, the
 * same numbering `readLiveVisibleSequence()` exposes and `submitMarketOrder`
 * already trusts as its own authoritative freshness bound) — which can be
 * ahead of the coarse, chunk-release-action counter `getReleasedContext`
 * exposes by up to a full chunk span. `assertAuthoritativeObservedSequence`
 * (the live write-time check) accepts either bound. This file proves the
 * SEPARATE recovery-time snapshot validator (`assertSnapshotObservedSequence`,
 * exercised by `validateSnapshot` on every construction with `initialState`
 * — i.e. every real server restart) accepts the exact same widened bound,
 * not just the live path: a session accepted live at a fine-grained
 * observedSequence must still validate cleanly when the interactions layer
 * is reconstructed from its persisted snapshot, or every such session would
 * break recovery the moment the server restarted.
 */
import { describe, expect, it } from "vitest";
import {
  ReplayPremiereInteractions,
  type ReplayPremiereInteractionsSnapshot,
} from "../../../../src/server/replay-premiere/ReplayPremiereInteractions";

const premiereId = "prem_abcdefghijklmnop";
const guestA = `guest_${"a".repeat(32)}`;

function buildInteractions(options: {
  coarseReleasedThroughSequence: number;
  liveVisibleSequence: number;
  initialState?: ReplayPremiereInteractionsSnapshot;
  clock?: { nowMs: number };
}): ReplayPremiereInteractions {
  let randomValue = 1;
  const clock = options.clock ?? { nowMs: Date.parse("2026-07-20T12:00:00.000Z") };
  return new ReplayPremiereInteractions({
    premiereId,
    checkpointDescriptors: [
      { id: "cp_first0001", sequence: 35 },
      { id: "cp_second001", sequence: 65 },
    ],
    seats: [
      {
        seatId: "seat-1",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "alpha",
          declaredVersion: "1",
          manifestSha256: "1".repeat(64),
          contentSha256: "2".repeat(64),
        },
      },
      {
        seatId: "SEAT0001",
        policyIdentity: {
          namespace: "local_manifest",
          manifestName: "beta",
          declaredVersion: "1",
          manifestSha256: "3".repeat(64),
          contentSha256: "4".repeat(64),
        },
      },
    ],
    getPremiereState: () => "playing",
    getReleasedContext: (sequence) =>
      sequence <= options.coarseReleasedThroughSequence
        ? {
            releasedThroughSequence: options.coarseReleasedThroughSequence,
            turn: sequence,
            eventContext: null,
          }
        : null,
    getLiveVisibleSequence: () => options.liveVisibleSequence,
    persistence: { async persist() {} },
    signAttribution: ({ shareId }) => `signed-${shareId}`,
    canonicalPremiereUrl: `https://beta.proxywar.xyz/premiere/${premiereId}`,
    now: () => new Date(clock.nowMs),
    randomBytes: (size) => {
      const bytes = new Uint8Array(size).fill(randomValue);
      randomValue += 1;
      return bytes;
    },
    wageringEnabled: true,
    admitAnonymousWrite: () => undefined,
    initialState: options.initialState,
  });
}

describe("observedSequence recovery: the live-path widening survives a server restart", () => {
  it("a session created with a fine-grained observedSequence (ahead of the coarse chunk marker) reconstructs cleanly from its persisted snapshot", async () => {
    // Coarse chunk-release marker is only at 20; the fine live-visible tap
    // frontier is at 100 — a real, wide gap (the exact shape a wagering
    // premiere produces: chunks batch up to ~60s behind the live clock).
    const clock = { nowMs: Date.parse("2026-07-20T12:00:00.000Z") };
    const live = buildInteractions({
      coarseReleasedThroughSequence: 20,
      liveVisibleSequence: 100,
      clock,
    });
    const { session } = await live.createViewerSession({
      participantId: guestA,
      idempotencyKey: "idem_session_0000000000000001",
      requesterBucketId: `ip_${"1".repeat(32)}`,
      visible: true,
      observedSequence: 50, // beyond the coarse marker, within the live one
      excludedAsOperator: false,
      excludedAsBot: false,
    });
    expect(session.firstReleasedSequenceObserved).toBe(50);
    clock.nowMs += 2_000; // past minHeartbeatIntervalMs, so the heartbeat isn't suppressed
    await live.heartbeat({
      participantId: guestA,
      sessionId: session.id,
      idempotencyKey: "idem_heartbeat_000000000001",
      requesterBucketId: `ip_${"1".repeat(32)}`,
      visible: true,
      observedSequence: 90, // even further ahead of the coarse marker
    });
    const persistedSnapshot = live.readState();
    expect(persistedSnapshot.sessions[0].lastReleasedSequenceObserved).toBe(90);

    // "Restart": a brand-new ReplayPremiereInteractions reconstructed
    // purely from that persisted snapshot. Before the recovery-path fix,
    // this constructor call would throw
    // "snapshot_observed_sequence_unreleased" for this exact session,
    // because the coarse chunk store (still capped at 20) had not caught
    // up — even though the live tap frontier (100) had always covered it.
    expect(() =>
      buildInteractions({
        coarseReleasedThroughSequence: 20,
        liveVisibleSequence: 100,
        initialState: persistedSnapshot,
      }),
    ).not.toThrow();
  });

  it("still genuinely bounded: a session whose observedSequence exceeds BOTH the coarse marker and the live-visible frontier at recovery time fails validation, not a vacuous pass-through", async () => {
    const live = buildInteractions({
      coarseReleasedThroughSequence: 20,
      liveVisibleSequence: 100,
    });
    const { session } = await live.createViewerSession({
      participantId: guestA,
      idempotencyKey: "idem_session_0000000000000002",
      requesterBucketId: `ip_${"1".repeat(32)}`,
      visible: true,
      observedSequence: 50,
      excludedAsOperator: false,
      excludedAsBot: false,
    });
    expect(session.firstReleasedSequenceObserved).toBe(50);
    const persistedSnapshot = live.readState();

    // A hypothetical recovery where BOTH the coarse store and the live
    // frontier have regressed well below what was legitimately observed
    // live (not a realistic production scenario — the live-visible clock
    // only ever advances — but proves the check still rejects when
    // neither bound covers the claim, rather than always passing once
    // wageringEnabled is true).
    expect(() =>
      buildInteractions({
        coarseReleasedThroughSequence: 5,
        liveVisibleSequence: 10,
        initialState: persistedSnapshot,
      }),
    ).toThrow(/snapshot_observed_sequence_unreleased/);
  });
});
