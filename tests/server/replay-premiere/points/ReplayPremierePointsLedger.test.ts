import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ReplayPremierePointsLedger,
  resolveReplayPremierePointsLedgerRoot,
} from "../../../../src/server/replay-premiere/points/ReplayPremierePointsLedger";

const guestA = `guest_${"a".repeat(32)}`;
const guestB = `guest_${"b".repeat(32)}`;
const guestC = `guest_${"c".repeat(32)}`;
const simBot = `sim_${"d".repeat(32)}`;
const premiereOne = "prem_aaaaaaaaaaaaaaaa";
const premiereTwo = "prem_bbbbbbbbbbbbbbbb";

describe("ReplayPremierePointsLedger", () => {
  let root: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(realTemporaryRoot, "points-ledger-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("resolves the durable default and an explicit absolute override, distinct from the premiere state root default", () => {
    expect(resolveReplayPremierePointsLedgerRoot({}, "/Users/tester")).toBe(
      "/Users/tester/Library/Application Support/ProxyWar/storage/points-ledger",
    );
    expect(
      resolveReplayPremierePointsLedgerRoot(
        { PROXYWAR_POINTS_LEDGER_ROOT: "/private/points" },
        "/Users/tester",
      ),
    ).toBe("/private/points");
    expect(() =>
      resolveReplayPremierePointsLedgerRoot(
        { PROXYWAR_POINTS_LEDGER_ROOT: "/" },
        "/Users/tester",
      ),
    ).toThrow();
  });

  test("records realized net P&L per participant, folds a winner and a loser correctly, and never rewards a non-trader", async () => {
    const ledger = await ReplayPremierePointsLedger.open(root);
    await ledger.recordPremiereSettlement(premiereOne, [
      // Started with 1,000, ended with 1,300 — net +300.
      { participantId: guestA, granted: 1_000, balance: 1_300 },
      // Started with 1,000, ended with 400 — net -600.
      { participantId: guestB, granted: 1_000, balance: 400 },
      // Never placed an order this premiere (granted 0) — must be ignored
      // entirely, not recorded as a 0-point participation.
      { participantId: guestC, granted: 0, balance: 1_000 },
    ]);
    const board = await ledger.readLeaderboard();
    expect(board.entries).toEqual([
      expect.objectContaining({
        participantId: guestA,
        lifetimePoints: 300,
        premieresTraded: 1,
        premieresWon: 1,
        rank: 1,
      }),
      expect.objectContaining({
        participantId: guestB,
        lifetimePoints: -600,
        premieresTraded: 1,
        premieresWon: 0,
        rank: 2,
      }),
    ]);
    expect(board.entries.some((entry) => entry.participantId === guestC)).toBe(
      false,
    );
    expect(board.totalRankedParticipants).toBe(2);
  });

  test("is idempotent per (participantId, premiereId): a retried or concurrently-observed settlement never double-counts", async () => {
    const ledger = await ReplayPremierePointsLedger.open(root);
    const settlement = [{ participantId: guestA, granted: 1_000, balance: 1_200 }];
    // Simulate ten tabs (or a retried recovery path) all observing and
    // recording the same settlement concurrently.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        ledger.recordPremiereSettlement(premiereOne, settlement),
      ),
    );
    const board = await ledger.readLeaderboard();
    expect(board.entries).toEqual([
      expect.objectContaining({
        participantId: guestA,
        lifetimePoints: 200,
        premieresTraded: 1,
      }),
    ]);
  });

  test("sums lifetime points across multiple settled premieres, never resets", async () => {
    const ledger = await ReplayPremierePointsLedger.open(root);
    await ledger.recordPremiereSettlement(premiereOne, [
      { participantId: guestA, granted: 1_000, balance: 1_100 },
    ]);
    await ledger.recordPremiereSettlement(premiereTwo, [
      { participantId: guestA, granted: 1_000, balance: 950 },
    ]);
    const board = await ledger.readLeaderboard();
    expect(board.entries[0]).toEqual(
      expect.objectContaining({
        lifetimePoints: 50,
        premieresTraded: 2,
        premieresWon: 1,
      }),
    );
  });

  test("never records a synthetic (sim_*) participant, even if handed one", async () => {
    const ledger = await ReplayPremierePointsLedger.open(root);
    await ledger.recordPremiereSettlement(premiereOne, [
      { participantId: guestA, granted: 1_000, balance: 1_050 },
      { participantId: simBot, granted: 1_000, balance: 5_000 },
    ]);
    const board = await ledger.readLeaderboard();
    expect(board.entries).toHaveLength(1);
    expect(board.entries[0].participantId).toBe(guestA);
  });

  test("locates the viewer even below the leaderboard cutoff, and reports rank null for a real participant who has never traded", async () => {
    const ledger = await ReplayPremierePointsLedger.open(root);
    for (let i = 0; i < 5; i += 1) {
      await ledger.recordPremiereSettlement(`prem_${"x".repeat(15)}${i}`, [
        {
          participantId: `guest_${i.toString(16).padStart(32, "0")}`,
          granted: 1_000,
          balance: 1_000 + (5 - i) * 100,
        },
      ]);
    }
    const outsideCutoff = `guest_${(4).toString(16).padStart(32, "0")}`;
    const board = await ledger.readLeaderboard({
      limit: 2,
      viewerParticipantId: outsideCutoff,
    });
    expect(board.entries).toHaveLength(2);
    expect(board.viewer).toEqual(
      expect.objectContaining({ participantId: outsideCutoff, rank: 5 }),
    );

    const untraded = await ledger.readLeaderboard({
      viewerParticipantId: guestC,
    });
    expect(untraded.viewer).toBeNull();
  });

  test("survives a fresh ledger instance pointed at the same root — durable across a process restart", async () => {
    const first = await ReplayPremierePointsLedger.open(root);
    await first.recordPremiereSettlement(premiereOne, [
      { participantId: guestA, granted: 1_000, balance: 1_250 },
    ]);

    const second = await ReplayPremierePointsLedger.open(root);
    const board = await second.readLeaderboard({ viewerParticipantId: guestA });
    expect(board.viewer).toEqual(
      expect.objectContaining({
        participantId: guestA,
        lifetimePoints: 250,
        rank: 1,
      }),
    );
  });

  test("wiping a separate premiere state root never touches the points ledger root", async () => {
    const premiereStateRoot = path.join(root, "premiere-state-root");
    const pointsRoot = path.join(root, "points-ledger-root");
    const ledger = await ReplayPremierePointsLedger.open(pointsRoot);
    await ledger.recordPremiereSettlement(premiereOne, [
      { participantId: guestA, granted: 1_000, balance: 1_400 },
    ]);
    await fs.mkdir(premiereStateRoot, { recursive: true });
    await fs.writeFile(
      path.join(premiereStateRoot, "some-premiere-event-log.json"),
      "{}",
    );
    // This is exactly what cycle-premiere.sh does to the PREMIERE state
    // root every cycle — `rm -rf "$STATE_PARENT"`.
    await fs.rm(premiereStateRoot, { recursive: true, force: true });

    const reopened = await ReplayPremierePointsLedger.open(pointsRoot);
    const board = await reopened.readLeaderboard({
      viewerParticipantId: guestA,
    });
    expect(board.viewer?.lifetimePoints).toBe(400);
  });

  test("migrates a legacy on-disk file (settledPremiereIds, no per-premiere net) forward to premiereResults, preserving lifetime totals", async () => {
    await fs.writeFile(
      path.join(root, "points-ledger-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          [guestA]: {
            lifetimePoints: 250,
            premieresTraded: 2,
            premieresWon: 1,
            updatedAt: "2026-01-01T00:00:00.000Z",
            settledPremiereIds: [premiereOne, premiereTwo],
          },
        },
      }),
    );
    const ledger = await ReplayPremierePointsLedger.open(root);
    const board = await ledger.readLeaderboard({ viewerParticipantId: guestA });
    // Lifetime totals survive the migration exactly; per-premiere granularity
    // for already-settled premieres is inherently unrecoverable from the old
    // shape (documented tradeoff), but re-settling either premiere id must
    // still be a no-op (idempotency is preserved through the migration).
    expect(board.viewer).toEqual(
      expect.objectContaining({
        participantId: guestA,
        lifetimePoints: 250,
        premieresTraded: 2,
        premieresWon: 1,
      }),
    );
    await ledger.recordPremiereSettlement(premiereOne, [
      { participantId: guestA, granted: 1_000, balance: 9_999 },
    ]);
    const afterRetry = await ledger.readLeaderboard({ viewerParticipantId: guestA });
    expect(afterRetry.viewer?.lifetimePoints).toBe(250);
    expect(afterRetry.viewer?.premieresTraded).toBe(2);

    // The migration is physically persisted to disk (not just in-memory) —
    // a fresh instance over the same file never re-parses the legacy shape.
    const onDisk = JSON.parse(
      await fs.readFile(path.join(root, "points-ledger-v1.json"), "utf8"),
    );
    expect(onDisk.entries[guestA].premiereResults).toEqual({
      [premiereOne]: 0,
      [premiereTwo]: 0,
    });
    expect(onDisk.entries[guestA].settledPremiereIds).toBeUndefined();
  });

  test("mergeParticipant sums both identities' per-premiere contribution and counts the premiere once — including the adversarial win/loss case", async () => {
    const ledger = await ReplayPremierePointsLedger.open(root);
    // Disjoint premieres: guestB's whole history simply folds into guestA.
    await ledger.recordPremiereSettlement(premiereOne, [
      { participantId: guestA, granted: 1_000, balance: 1_200 },
    ]);
    await ledger.recordPremiereSettlement(premiereTwo, [
      { participantId: guestB, granted: 1_000, balance: 900 },
    ]);
    await ledger.mergeParticipant(guestB, guestA);
    const disjoint = await ledger.readLeaderboard({ viewerParticipantId: guestA });
    expect(disjoint.viewer).toEqual(
      expect.objectContaining({
        lifetimePoints: 100, // +200 - 100
        premieresTraded: 2,
        premieresWon: 1,
      }),
    );
    expect(disjoint.entries.some((entry) => entry.participantId === guestB)).toBe(
      false,
    );

    // Adversarial case: guestA WON a shared premiere alone, then guestC
    // (linking to the same GitHub id) is discovered to have LOST that exact
    // same premiere. The tempting "keep the winner's contribution" rule is a
    // free option; the correct rule sums and re-derives the win/loss flag
    // from the combined net, so a merged loss always comes along with a win.
    const premiereShared = "prem_cccccccccccccccc";
    await ledger.recordPremiereSettlement(premiereShared, [
      { participantId: guestA, granted: 1_000, balance: 1_100 }, // +100, a win
    ]);
    await ledger.recordPremiereSettlement(premiereShared, [
      { participantId: guestC, granted: 1_000, balance: 850 }, // -150, a loss
    ]);
    const beforeMerge = await ledger.readLeaderboard({ viewerParticipantId: guestA });
    expect(beforeMerge.viewer?.premieresWon).toBe(2); // premiereOne + premiereShared

    await ledger.mergeParticipant(guestC, guestA);
    const merged = await ledger.readLeaderboard({ viewerParticipantId: guestA });
    expect(merged.viewer).toEqual(
      expect.objectContaining({
        // 200 (premiereOne) + -100 (disjoint B loss already folded) + (100-150)=-50 (shared, net)
        lifetimePoints: 200 + -100 + -50,
        premieresTraded: 3, // shared premiere counted ONCE, not twice
        premieresWon: 1, // the shared premiere is no longer a win once netted
      }),
    );
    expect(merged.entries.some((entry) => entry.participantId === guestC)).toBe(
      false,
    );
  });

  test("mergeParticipant is idempotent — merging an already-empty (or nonexistent) source is a safe no-op", async () => {
    const ledger = await ReplayPremierePointsLedger.open(root);
    await ledger.recordPremiereSettlement(premiereOne, [
      { participantId: guestA, granted: 1_000, balance: 1_300 },
    ]);
    // Never traded, never had an entry at all.
    await ledger.mergeParticipant(guestC, guestA);
    // Merge again after guestC has nothing left (simulates a retried merge
    // after a crash between the ledger merge and the identity-link write).
    await ledger.mergeParticipant(guestC, guestA);
    const board = await ledger.readLeaderboard({ viewerParticipantId: guestA });
    expect(board.viewer?.lifetimePoints).toBe(300);
    expect(board.viewer?.premieresTraded).toBe(1);
  });
});
