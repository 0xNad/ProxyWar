/**
 * Durable, cross-premiere settlement record — "who won, and what did the
 * market close at" for one premiere, retained after `cycle-premiere.sh`
 * `rm -rf`s the private state root (registry, live market, and the
 * archive-v1 summary — see `ReplayPremiereArchiveIndex.ts`) on every cycle
 * transition. See the module doc on {@link ReplayPremiereSettlementLedger}
 * for the storage/scope reasoning.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

const PREMIERE_ID_PATTERN = /^prem_[a-z0-9]{16,32}$/;
const SEAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EPISODE_REQUEST_ID_PATTERN = /^ereq_[A-Za-z0-9_-]+$/;
const SETTLEMENT_LEDGER_FILE_NAME = "settlement-ledger-v1.json";
const SCHEMA_VERSION = 1 as const;
/** Defensive cap on the placements array — real rosters top out around a dozen seats; this only guards against a corrupt/oversized caller. */
const MAX_PLACEMENTS = 64;

export type ReplayPremiereSettlementMatchKind = "real-league" | "exhibition";
export type ReplayPremiereSettlementOutcome = "winner" | "refunded";

export interface ReplayPremiereSettlementPlacement {
  readonly seatId: string;
  readonly displayName: string;
  /**
   * 1 for the confirmed winner; `null` for every other seat. The
   * authoritative result only ever carries a per-seat `won` boolean (see
   * `PremiereCanonicalAuthoritativeResult.seats`), never a full ordered
   * finish — fabricating placements 2..n from that would assert a tie the
   * data never actually establishes. Same honesty convention already used
   * for `inMatchRank` in `ReplayPremiereArchiveView.ts` and `placements` in
   * `FeaturedMatchReconcile.ts`.
   */
  readonly placement: 1 | null;
}

export interface ReplayPremiereMarketFinalPrice {
  readonly seatId: string;
  /** LMSR display price at settlement, 0..100. */
  readonly price: number;
}

export interface ReplayPremiereSettlementRecord {
  readonly premiereId: string;
  /** Coworld `ereq_...` id for a real-league match; `null` for a house exhibition (no episode behind it). */
  readonly episodeRequestId: string | null;
  readonly matchKind: ReplayPremiereSettlementMatchKind;
  readonly outcome: ReplayPremiereSettlementOutcome;
  /** `null` iff `outcome === "refunded"`. */
  readonly winnerSeatId: string | null;
  readonly winnerDisplayName: string | null;
  readonly placements: readonly ReplayPremiereSettlementPlacement[];
  readonly settledAt: string;
  readonly marketFinalPrices: readonly ReplayPremiereMarketFinalPrice[];
  readonly totalParticipants: number;
  /** When this ledger durably accepted the record — distinct from `settledAt`, which is the market's own settlement timestamp. */
  readonly recordedAt: string;
}

const placementSchema = z.object({
  seatId: z.string().regex(SEAT_ID_PATTERN),
  displayName: z.string().min(1).max(200),
  placement: z.literal(1).nullable(),
});

const marketFinalPriceSchema = z.object({
  seatId: z.string().regex(SEAT_ID_PATTERN),
  price: z.number().finite().min(0).max(100),
});

const storedRecordSchema = z.object({
  premiereId: z.string().regex(PREMIERE_ID_PATTERN),
  episodeRequestId: z.string().regex(EPISODE_REQUEST_ID_PATTERN).nullable(),
  matchKind: z.enum(["real-league", "exhibition"]),
  outcome: z.enum(["winner", "refunded"]),
  winnerSeatId: z.string().regex(SEAT_ID_PATTERN).nullable(),
  winnerDisplayName: z.string().min(1).max(200).nullable(),
  placements: z.array(placementSchema).max(MAX_PLACEMENTS),
  settledAt: z.string(),
  marketFinalPrices: z.array(marketFinalPriceSchema).max(MAX_PLACEMENTS),
  totalParticipants: z.number().int().nonnegative(),
  recordedAt: z.string(),
});
type StoredRecord = z.infer<typeof storedRecordSchema>;

interface LedgerFile {
  schemaVersion: typeof SCHEMA_VERSION;
  records: Record<string, StoredRecord>;
}

/**
 * Durable settlement ledger backing "who won?" and "why did my position
 * settle at -N?" after a market goes off the live registry.
 *
 * Rooted BESIDE `ReplayPremierePointsLedger` — same directory, same
 * atomic write-temp-then-rename convention, its own file — exactly the
 * precedent `BettingPlatformAccountLinkStore` already set for a second
 * durable store sharing that root (see its own doc: "Beside the points
 * ledger: same root, same atomic write-temp-then-rename convention, its
 * own file"). That root is deliberately outside the premiere private
 * state root `cycle-premiere.sh` `rm -rf`s every ~25 minutes, which is
 * what lets a settlement record survive a cycle, an origin restart, and
 * the archive-v1 summary being wiped alongside it.
 *
 * Append-only and idempotent per `premiereId`: {@link recordSettlement}
 * is a safe no-op for a premiere id already recorded (a retried resolution
 * call, or the same settlement observed by more than one concurrent
 * process during startup recovery, never overwrites or double-appends).
 * Records are never deleted or mutated after being written — there is no
 * "amend a settlement" operation, only the one durable write at
 * resolution time.
 *
 * Growth is bounded and self-evidently small: one record is a handful of
 * short strings, a placements array capped at a few dozen seats, and a
 * matching price array — a few hundred bytes. At the observed autocycle
 * cadence (roughly two premieres/hour), that is under 20 KB/day and well
 * under 10 MB/year of plain JSON, an amount this store's flat-file,
 * read-whole-file-on-every-mutation design (identical to
 * `ReplayPremierePointsLedger`'s) comfortably tolerates forever. No
 * compaction is implemented for the same reason `ReplayPremierePointsLedger`
 * documents for its own uncapped growth: a record is small, and storing
 * all of them is cheaper than being subtly wrong about which ones to drop.
 */
export class ReplayPremiereSettlementLedger {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly root: string) {
    this.filePath = path.join(root, SETTLEMENT_LEDGER_FILE_NAME);
  }

  static async open(root: string): Promise<ReplayPremiereSettlementLedger> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return new ReplayPremiereSettlementLedger(root);
  }

  /**
   * Durably records one premiere's settlement, once. Idempotent per
   * `premiereId` — an already-recorded premiere is a safe no-op, so a
   * retried resolution call (crash recovery, a concurrently-observed
   * settlement) can never double-write or overwrite the first record.
   */
  async recordSettlement(
    record: Omit<ReplayPremiereSettlementRecord, "recordedAt">,
  ): Promise<void> {
    if (!PREMIERE_ID_PATTERN.test(record.premiereId)) {
      throw new Error(`invalid_premiere_id: ${record.premiereId}`);
    }
    const candidate: StoredRecord = storedRecordSchema.parse({
      ...record,
      recordedAt: new Date().toISOString(),
    });
    await this.mutate((file) => {
      if (candidate.premiereId in file.records) return;
      file.records[candidate.premiereId] = candidate;
    });
  }

  async readSettlement(
    premiereId: string,
  ): Promise<ReplayPremiereSettlementRecord | null> {
    if (!PREMIERE_ID_PATTERN.test(premiereId)) {
      throw new Error(`invalid_premiere_id: ${premiereId}`);
    }
    const file = await this.load();
    return file.records[premiereId] ?? null;
  }

  private async mutate(mutator: (file: LedgerFile) => void): Promise<void> {
    const run = this.writeQueue.then(async () => {
      const file = await this.load();
      mutator(file);
      await this.save(file);
    });
    // A failed mutation must never wedge the queue for later callers.
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<LedgerFile> {
    let raw: unknown;
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      raw = JSON.parse(text);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      return { schemaVersion: SCHEMA_VERSION, records: {} };
    }
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("schemaVersion" in raw) ||
      raw.schemaVersion !== SCHEMA_VERSION ||
      !("records" in raw) ||
      typeof raw.records !== "object" ||
      raw.records === null
    ) {
      return { schemaVersion: SCHEMA_VERSION, records: {} };
    }
    const records: Record<string, StoredRecord> = {};
    for (const [premiereId, rawRecord] of Object.entries(raw.records)) {
      if (!PREMIERE_ID_PATTERN.test(premiereId)) continue;
      const parsed = storedRecordSchema.safeParse(rawRecord);
      // Drop a single malformed record rather than discarding the whole
      // ledger file — same discipline as `ReplayPremierePointsLedger`.
      if (parsed.success) records[premiereId] = parsed.data;
    }
    return { schemaVersion: SCHEMA_VERSION, records };
  }

  private async save(file: LedgerFile): Promise<void> {
    const temporaryPath = path.join(
      this.root,
      `.${SETTLEMENT_LEDGER_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    await fs.writeFile(temporaryPath, JSON.stringify(file), { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
  }
}
