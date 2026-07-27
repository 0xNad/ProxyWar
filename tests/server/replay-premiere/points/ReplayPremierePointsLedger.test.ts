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

    await ledger.setDisplayName(guestC, "Newcomer");
    const withName = await ledger.readLeaderboard({
      viewerParticipantId: guestC,
    });
    expect(withName.viewer).toEqual(
      expect.objectContaining({
        participantId: guestC,
        displayName: "Newcomer",
        premieresTraded: 0,
        rank: null,
      }),
    );
    // An untraded entry never shows up on the board itself.
    expect(withName.entries.some((entry) => entry.participantId === guestC)).toBe(
      false,
    );
  });

  test("sanitizes display names: strips control/format characters, collapses whitespace, caps length, clears on blank", async () => {
    const ledger = await ReplayPremierePointsLedger.open(root);
    const entry = await ledger.setDisplayName(
      guestA,
      "  Da\u0000veey\u200b   the\tGreat  ",
    );
    // Control char and zero-width space stripped outright; the tab
    // collapses to a single space (not deleted — deleting it would mash
    // "the" and "Great" together); edges trimmed.
    expect(entry.displayName).toBe("Daveey the Great");

    const long = await ledger.setDisplayName(guestA, "x".repeat(100));
    expect(long.displayName).toHaveLength(32);

    const cleared = await ledger.setDisplayName(guestA, "   \u0000  ");
    expect(cleared.displayName).toBeNull();
  });

  test("survives a fresh ledger instance pointed at the same root — durable across a process restart", async () => {
    const first = await ReplayPremierePointsLedger.open(root);
    await first.recordPremiereSettlement(premiereOne, [
      { participantId: guestA, granted: 1_000, balance: 1_250 },
    ]);
    await first.setDisplayName(guestA, "Daveey");

    const second = await ReplayPremierePointsLedger.open(root);
    const board = await second.readLeaderboard({ viewerParticipantId: guestA });
    expect(board.viewer).toEqual(
      expect.objectContaining({
        participantId: guestA,
        displayName: "Daveey",
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
});
