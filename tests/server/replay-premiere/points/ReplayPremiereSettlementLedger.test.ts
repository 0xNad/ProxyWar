import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReplayPremiereSettlementLedger } from "../../../../src/server/replay-premiere/points/ReplayPremiereSettlementLedger";

const premiereOne = "prem_aaaaaaaaaaaaaaaa";
const premiereTwo = "prem_bbbbbbbbbbbbbbbb";

function winnerRecord(
  overrides: Partial<
    Parameters<ReplayPremiereSettlementLedger["recordSettlement"]>[0]
  > = {},
) {
  return {
    premiereId: premiereOne,
    episodeRequestId: "ereq_abc123",
    matchKind: "real-league" as const,
    outcome: "winner" as const,
    winnerSeatId: "seat_1",
    winnerDisplayName: "Aggressive Expander",
    placements: [
      {
        seatId: "seat_1",
        displayName: "Aggressive Expander",
        placement: 1 as const,
      },
      { seatId: "seat_2", displayName: "Defensive Builder", placement: null },
      { seatId: "seat_3", displayName: "Turtle", placement: null },
    ],
    settledAt: "2026-08-02T00:00:00.000Z",
    marketFinalPrices: [
      { seatId: "seat_1", price: 61.2 },
      { seatId: "seat_2", price: 25.4 },
      { seatId: "seat_3", price: 13.4 },
    ],
    totalParticipants: 7,
    ...overrides,
  };
}

describe("ReplayPremiereSettlementLedger", () => {
  let root: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(realTemporaryRoot, "settlement-ledger-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("records a winner settlement and reads it back with recordedAt stamped", async () => {
    const ledger = await ReplayPremiereSettlementLedger.open(root);
    await ledger.recordSettlement(winnerRecord());
    const read = await ledger.readSettlement(premiereOne);
    expect(read).not.toBeNull();
    expect(read).toEqual(
      expect.objectContaining({
        premiereId: premiereOne,
        episodeRequestId: "ereq_abc123",
        matchKind: "real-league",
        outcome: "winner",
        winnerSeatId: "seat_1",
        winnerDisplayName: "Aggressive Expander",
        totalParticipants: 7,
      }),
    );
    expect(read?.placements).toHaveLength(3);
    expect(typeof read?.recordedAt).toBe("string");
    expect(Number.isFinite(Date.parse(read!.recordedAt))).toBe(true);
  });

  test("records an honest refunded outcome with no winner", async () => {
    const ledger = await ReplayPremiereSettlementLedger.open(root);
    await ledger.recordSettlement(
      winnerRecord({
        outcome: "refunded",
        winnerSeatId: null,
        winnerDisplayName: null,
        placements: [
          {
            seatId: "seat_1",
            displayName: "Aggressive Expander",
            placement: null,
          },
          {
            seatId: "seat_2",
            displayName: "Defensive Builder",
            placement: null,
          },
        ],
      }),
    );
    const read = await ledger.readSettlement(premiereOne);
    expect(read?.outcome).toBe("refunded");
    expect(read?.winnerSeatId).toBeNull();
    expect(read?.winnerDisplayName).toBeNull();
    expect(read?.placements.every((p) => p.placement === null)).toBe(true);
  });

  test("returns null for a premiere id with no recorded settlement", async () => {
    const ledger = await ReplayPremiereSettlementLedger.open(root);
    expect(await ledger.readSettlement(premiereTwo)).toBeNull();
  });

  test("is idempotent per premiereId: a retried write never overwrites the first record", async () => {
    const ledger = await ReplayPremiereSettlementLedger.open(root);
    await ledger.recordSettlement(winnerRecord());
    // A retried resolution call reporting a DIFFERENT (wrong) winner must
    // never clobber the first, authoritative record.
    await ledger.recordSettlement(
      winnerRecord({
        winnerSeatId: "seat_2",
        winnerDisplayName: "Defensive Builder",
      }),
    );
    const read = await ledger.readSettlement(premiereOne);
    expect(read?.winnerSeatId).toBe("seat_1");
    expect(read?.winnerDisplayName).toBe("Aggressive Expander");
  });

  test("keeps distinct premieres independent", async () => {
    const ledger = await ReplayPremiereSettlementLedger.open(root);
    await ledger.recordSettlement(winnerRecord());
    await ledger.recordSettlement(
      winnerRecord({
        premiereId: premiereTwo,
        matchKind: "exhibition",
        episodeRequestId: null,
        winnerSeatId: "seat_9",
        winnerDisplayName: "House Bot",
      }),
    );
    const first = await ledger.readSettlement(premiereOne);
    const second = await ledger.readSettlement(premiereTwo);
    expect(first?.winnerDisplayName).toBe("Aggressive Expander");
    expect(second?.winnerDisplayName).toBe("House Bot");
    expect(second?.matchKind).toBe("exhibition");
    expect(second?.episodeRequestId).toBeNull();
  });

  test("survives a fresh ledger instance pointed at the same root — durable across a process restart", async () => {
    const first = await ReplayPremiereSettlementLedger.open(root);
    await first.recordSettlement(winnerRecord());

    const second = await ReplayPremiereSettlementLedger.open(root);
    const read = await second.readSettlement(premiereOne);
    expect(read?.winnerDisplayName).toBe("Aggressive Expander");
  });

  test("survives a simulated cycle-premiere.sh wipe: the premiere state root can be rm -rf'd while the settlement ledger, rooted outside it, keeps the record", async () => {
    const premiereStateRoot = path.join(root, "premiere-state-root-simulated");
    const settlementLedgerRoot = path.join(root, "settlement-ledger-root");
    await fs.mkdir(premiereStateRoot, { recursive: true });
    // Something a real premiere state root would hold, to prove the wipe is real.
    await fs.writeFile(path.join(premiereStateRoot, "registry.json"), "{}");

    const ledger =
      await ReplayPremiereSettlementLedger.open(settlementLedgerRoot);
    await ledger.recordSettlement(winnerRecord());

    // Exactly what cycle-premiere.sh does to the premiere private state root.
    await fs.rm(premiereStateRoot, { recursive: true, force: true });
    expect(await fs.readdir(root).catch(() => [])).not.toContain(
      "premiere-state-root-simulated",
    );

    const reopened =
      await ReplayPremiereSettlementLedger.open(settlementLedgerRoot);
    const read = await reopened.readSettlement(premiereOne);
    expect(read?.winnerDisplayName).toBe("Aggressive Expander");
    expect(read?.outcome).toBe("winner");
  });

  test("drops a single malformed record on read rather than discarding the whole ledger file", async () => {
    const ledger = await ReplayPremiereSettlementLedger.open(root);
    await ledger.recordSettlement(winnerRecord());
    const filePath = path.join(root, "settlement-ledger-v1.json");
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    raw.records[premiereTwo] = { garbage: true };
    await fs.writeFile(filePath, JSON.stringify(raw));

    const reopened = await ReplayPremiereSettlementLedger.open(root);
    expect(await reopened.readSettlement(premiereOne)).not.toBeNull();
    expect(await reopened.readSettlement(premiereTwo)).toBeNull();
  });

  test("rejects an invalid premiere id", async () => {
    const ledger = await ReplayPremiereSettlementLedger.open(root);
    await expect(
      ledger.recordSettlement(
        winnerRecord({ premiereId: "not-a-premiere-id" }),
      ),
    ).rejects.toThrow(/invalid_premiere_id/);
    await expect(ledger.readSettlement("not-a-premiere-id")).rejects.toThrow(
      /invalid_premiere_id/,
    );
  });

  test("accepts the real Coworld episodeRequestId shape: a bare UUID, never 'ereq_'-prefixed", async () => {
    // 2026-08-02 production incident: `EPISODE_REQUEST_ID_PATTERN` used to
    // require an `ereq_` prefix, but the value actually threaded through
    // from `PremiereWageringSourceBundle.ts` (Coworld's `get_episode_request()`
    // `.episode_id` attribute) is a bare UUID — confirmed live against the
    // real Coworld API. Every real-league settlement's write threw a
    // ZodError on this exact field until the pattern was fixed.
    const ledger = await ReplayPremiereSettlementLedger.open(root);
    await ledger.recordSettlement(
      winnerRecord({
        episodeRequestId: "749516f2-4ab4-4fe0-a6ef-1bbc956c5e14",
      }),
    );
    const read = await ledger.readSettlement(premiereOne);
    expect(read?.episodeRequestId).toBe("749516f2-4ab4-4fe0-a6ef-1bbc956c5e14");
  });
});
