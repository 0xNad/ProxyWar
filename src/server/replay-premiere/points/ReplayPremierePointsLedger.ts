/**
 * Durable, cross-premiere points ledger and leaderboard, keyed by the
 * existing signed guest participant id (`guest_<hmac>`) — no account
 * system. See the module doc on {@link ReplayPremierePointsLedger} for the
 * storage/points-formula reasoning.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const REPLAY_PREMIERE_POINTS_LEDGER_ROOT_ENV =
  "PROXYWAR_POINTS_LEDGER_ROOT" as const;

const PARTICIPANT_ID_PATTERN = /^guest_[a-f0-9]{32}$/;
const PREMIERE_ID_PATTERN = /^prem_[a-z0-9]{16,32}$/;
const LEDGER_FILE_NAME = "points-ledger-v1.json";
const SCHEMA_VERSION = 1 as const;
export interface ReplayPremierePointsEntry {
  readonly participantId: string;
  /** Lifetime realized net P&L (credits), summed only across premieres actually traded. See class doc. */
  readonly lifetimePoints: number;
  readonly premieresTraded: number;
  readonly premieresWon: number;
  readonly updatedAt: string;
}

/**
 * `ReplayPremierePointsEntry` plus the per-premiere net history — never
 * exposed on the leaderboard (rank hides it deliberately: per-match detail
 * is a "how am I doing" account-page fact, not a competitive leaderboard
 * one), only via {@link ReplayPremierePointsLedger.readParticipant} for
 * the viewer's own account read.
 */
export interface ReplayPremierePointsEntryDetail
  extends ReplayPremierePointsEntry {
  /** premiereId -> net for every settled premiere this participant traded. Entries migrated from the pre-`premiereResults` era read as net `0` — see the module doc on `legacyStoredEntrySchema`; that `0` is a placeholder, not a recorded flat result. */
  readonly premiereResults: Readonly<Record<string, number>>;
}

export interface ReplayPremiereLeaderboardEntry extends ReplayPremierePointsEntry {
  readonly rank: number;
}

export interface ReplayPremiereLeaderboardView {
  readonly entries: readonly ReplayPremiereLeaderboardEntry[];
  readonly totalRankedParticipants: number;
  /** The requesting viewer's own row, `rank: null` when they have never traded a premiere to completion (so are not board-eligible). `null` when no viewer identity was supplied. */
  readonly viewer:
    | (ReplayPremierePointsEntry & { readonly rank: number | null })
    | null;
}

/** One real participant's final settlement figures for one premiere's market. */
export interface ReplayPremiereSettlementLedgerEntry {
  readonly participantId: string;
  /** Total ever granted to this participant's market account this premiere — their starting bankroll. */
  readonly granted: number;
  /** Final ledger balance for this participant once the market settled. */
  readonly balance: number;
}

/**
 * Per-premiere realized net P&L, keyed by premiere id — the prerequisite
 * for a correct identity-link merge (see {@link ReplayPremierePointsLedger.mergeParticipant}):
 * a lifetime *total* alone cannot tell you what to do when two identities
 * both traded the SAME premiere and need folding into one row.
 */
const storedEntrySchema = z.object({
  lifetimePoints: z.number().finite(),
  premieresTraded: z.number().int().nonnegative(),
  premieresWon: z.number().int().nonnegative(),
  updatedAt: z.string(),
  premiereResults: z.record(
    z.string().regex(PREMIERE_ID_PATTERN),
    z.number().finite(),
  ),
});
type StoredEntry = z.infer<typeof storedEntrySchema>;

/**
 * Pre-2026-07-27 on-disk shape: a bare list of settled premiere ids with no
 * per-premiere net figure, only the running lifetime total. Accepted on
 * read and migrated forward (see {@link ReplayPremierePointsLedger.open})
 * into `premiereResults` — each historical id is backfilled at net `0`
 * (the true historical split is unrecoverable from this shape; only
 * `lifetimePoints`/`premieresTraded`/`premieresWon` survive intact). This
 * is a one-time, inherent, and documented loss of granularity for
 * ALREADY-settled premieres, not an ongoing one: every settlement recorded
 * from this migration onward carries its real per-premiere net.
 */
const legacyStoredEntrySchema = z.object({
  lifetimePoints: z.number().finite(),
  premieresTraded: z.number().int().nonnegative(),
  premieresWon: z.number().int().nonnegative(),
  updatedAt: z.string(),
  settledPremiereIds: z.array(z.string()),
});

export function resolveReplayPremierePointsLedgerRoot(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configured =
    environment[REPLAY_PREMIERE_POINTS_LEDGER_ROOT_ENV]?.trim();
  const selected =
    configured === undefined || configured === ""
      ? path.join(
          homeDirectory,
          "Library",
          "Application Support",
          "ProxyWar",
          "storage",
          "points-ledger",
        )
      : configured;
  const resolved = path.resolve(selected);
  if (
    !path.isAbsolute(selected) ||
    resolved === path.parse(resolved).root ||
    resolved === path.resolve(homeDirectory)
  ) {
    throw new Error(`invalid_points_ledger_root: ${selected}`);
  }
  return resolved;
}

/**
 * Durable points ledger backing the cross-premiere leaderboard.
 *
 * MUST live outside the premiere private state root: `cycle-premiere.sh`
 * `rm -rf`s that whole root every ~25 minutes by design (see its header
 * comment — "a root accumulates unusable admissions... any in-flight
 * session, position, or bankroll on the previous premiere is destroyed
 * with it"). This ledger resolves to a distinct root
 * (`resolveReplayPremierePointsLedgerRoot`, default
 * `~/Library/Application Support/ProxyWar/storage/points-ledger`,
 * overridable via `PROXYWAR_POINTS_LEDGER_ROOT`), which is what makes a
 * player's score and name survive a cycle, an origin restart, and a wiped
 * state root. Storage is a flat JSON map with an atomic
 * write-temp-then-rename on every mutation — not the event-sourced
 * machinery `ReplayPremiereEventStore` uses for premiere state, because
 * there is no replay/audit requirement here, only "the current tally
 * survives a crash mid-write."
 *
 * Points formula — lifetime realized net P&L, gated to premieres traded:
 * at settlement, each real participant's contribution is
 * `finalBalance - startingGrant` for that one premiere: exactly what they
 * walked away with beyond the bankroll they started with, positive or
 * negative. This is summed across every settled premiere the participant
 * placed at least one order in, and now also retained PER premiere (see
 * `premiereResults` on the stored shape) — required for a correct
 * identity-link merge, see {@link mergeParticipant}. A participant who
 * never traded a given premiere contributes nothing for it — critically, a
 * participant who NEVER trades at all has no ledger entry from settlement
 * whatsoever, so they never appear on the leaderboard outranking someone
 * who took real risk. Carrying raw bankroll forward was rejected for
 * exactly this failure mode: it parks a non-trader at a permanent 1,000
 * that outranks a trader who finished at 900 after real risk. Net realized
 * P&L instead rewards being profitable, not merely present — a losing
 * trader still nets a negative score (correctly below a non-participant),
 * but an idle bankroll can never masquerade as a result. `premieresTraded`
 * and `premieresWon` (net P&L > 0) are carried alongside as a hit-rate
 * context, not folded into the ranking score itself, to keep the primary
 * ranking unambiguous (real credits won or lost) rather than an
 * arbitrarily-weighted composite.
 *
 * Multi-tab robustness is inherited, not reimplemented: every tab in one
 * browser profile shares the same signed guest cookie, hence the same
 * `participantId`, hence the same market ledger account and the same
 * entry here — there is no way to open ten tabs and accumulate ten
 * identities or ten settlements for one premiere (also independently
 * enforced by this class's own per-`(participantId, premiereId)`
 * idempotency below).
 */
export class ReplayPremierePointsLedger {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly root: string) {
    this.filePath = path.join(root, LEDGER_FILE_NAME);
  }

  static async open(
    root: string = resolveReplayPremierePointsLedgerRoot(),
  ): Promise<ReplayPremierePointsLedger> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const instance = new ReplayPremierePointsLedger(root);
    // Forward-migrate a legacy on-disk file (settledPremiereIds -> per-
    // premiere premiereResults) once, deterministically, before the
    // instance is ever handed to a request handler — see
    // `legacyStoredEntrySchema` doc. A no-op for an already-current file.
    const { file, migrated } = await instance.loadDetailed();
    if (migrated) await instance.save(file);
    return instance;
  }

  /**
   * Folds one settled premiere's final market ledger into every listed
   * participant's lifetime tally. Idempotent per `(participantId,
   * premiereId)` — safe to call repeatedly for the same premiere (a
   * retried caller, or the same settlement observed from more than one
   * concurrent tab) without double-counting; entries already carrying
   * this `premiereId` are skipped.
   */
  async recordPremiereSettlement(
    premiereId: string,
    settlements: readonly ReplayPremiereSettlementLedgerEntry[],
  ): Promise<void> {
    if (!PREMIERE_ID_PATTERN.test(premiereId)) {
      throw new Error(`invalid_premiere_id: ${premiereId}`);
    }
    const real = settlements.filter(
      (settlement) =>
        PARTICIPANT_ID_PATTERN.test(settlement.participantId) &&
        Number.isFinite(settlement.granted) &&
        Number.isFinite(settlement.balance) &&
        settlement.granted > 0,
    );
    if (real.length === 0) return;
    await this.mutate((file) => {
      const nowIso = new Date().toISOString();
      for (const settlement of real) {
        const entry = file.entries[settlement.participantId] ?? emptyEntry();
        if (premiereId in entry.premiereResults) continue;
        const net = Math.round(settlement.balance - settlement.granted);
        entry.premiereResults[premiereId] = net;
        entry.lifetimePoints += net;
        entry.premieresTraded += 1;
        if (net > 0) entry.premieresWon += 1;
        trimPremiereResults(entry);
        entry.updatedAt = nowIso;
        file.entries[settlement.participantId] = entry;
      }
    });
  }

  /**
   * Consolidates `fromParticipantId`'s entire history into
   * `intoParticipantId` (a GitHub-link-resolved canonical identity) and
   * removes the source row so it never independently reappears on the
   * board. Per premiere BOTH identities traded: **sums both contributions
   * and counts the premiere once** toward `premieresTraded` — the
   * adversarial-safe rule. The tempting alternative (keep the canonical
   * side's contribution, drop the other's) is a free option: trade both
   * sides of one match from two browsers, wait for settlement, link the
   * winner first, erase the loser. Summing means a merged loss always
   * comes along with a merged win.
   *
   * Idempotent: an absent or already-empty `fromParticipantId` (e.g. a
   * retried merge after a crash mid-flow — see
   * `ReplayPremiereIdentityLinkStore`) is a safe no-op beyond removing any
   * stray empty row. Never invoked from the settlement/trading path — this
   * only runs from the identity-link flow, so a GitHub outage can never
   * block or delay a trade.
   */
  async mergeParticipant(
    fromParticipantId: string,
    intoParticipantId: string,
  ): Promise<void> {
    if (
      !PARTICIPANT_ID_PATTERN.test(fromParticipantId) ||
      !PARTICIPANT_ID_PATTERN.test(intoParticipantId)
    ) {
      throw new Error("invalid_participant_id");
    }
    if (fromParticipantId === intoParticipantId) return;
    await this.mutate((file) => {
      const source = file.entries[fromParticipantId];
      delete file.entries[fromParticipantId];
      if (
        source === undefined ||
        Object.keys(source.premiereResults).length === 0
      ) {
        return;
      }
      const target = file.entries[intoParticipantId] ?? emptyEntry();
      for (const [premiereId, net] of Object.entries(source.premiereResults)) {
        const existingNet = target.premiereResults[premiereId];
        if (existingNet === undefined) {
          target.premiereResults[premiereId] = net;
          target.lifetimePoints += net;
          target.premieresTraded += 1;
          if (net > 0) target.premieresWon += 1;
        } else {
          if (existingNet > 0) target.premieresWon -= 1;
          const combined = existingNet + net;
          target.premiereResults[premiereId] = combined;
          target.lifetimePoints += net;
          if (combined > 0) target.premieresWon += 1;
        }
      }
      trimPremiereResults(target);
      target.updatedAt = new Date().toISOString();
      file.entries[intoParticipantId] = target;
    });
  }


  /**
   * The viewer's own full record, including per-premiere history — never
   * called for anyone but the requesting participant themselves (see
   * {@link ReplayPremierePointsEntryDetail}'s doc: this is account-page
   * data, not a public read). `null` for a participant with no ledger
   * entry at all (never traded, never set a display name).
   */
  async readParticipant(
    participantId: string,
  ): Promise<ReplayPremierePointsEntryDetail | null> {
    if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
      throw new Error(`invalid_participant_id: ${participantId}`);
    }
    const file = await this.load();
    const entry = file.entries[participantId];
    if (entry === undefined) return null;
    return {
      ...toPublicEntry(participantId, entry),
      premiereResults: { ...entry.premiereResults },
    };
  }

  /**
   * Top `limit` board entries (only participants with `premieresTraded >
   * 0` — an untraded entry, e.g. someone who only ever set a display
   * name, never clutters the board) plus the requesting viewer's own row
   * so they can always find themselves, even below the cutoff or with no
   * qualifying trades at all.
   */
  async readLeaderboard(
    options: { limit?: number; viewerParticipantId?: string | null } = {},
  ): Promise<ReplayPremiereLeaderboardView> {
    const limit = boundedLimit(options.limit ?? 25);
    const file = await this.load();
    const ranked = Object.entries(file.entries)
      .filter(([, entry]) => entry.premieresTraded > 0)
      .map(([participantId, entry]) => toPublicEntry(participantId, entry))
      .sort(compareEntries);
    const entries: ReplayPremiereLeaderboardEntry[] = ranked
      .slice(0, limit)
      .map((entry, index) => ({ ...entry, rank: index + 1 }));
    const viewerParticipantId = options.viewerParticipantId ?? null;
    let viewer: ReplayPremiereLeaderboardView["viewer"] = null;
    if (viewerParticipantId !== null) {
      const rankIndex = ranked.findIndex(
        (entry) => entry.participantId === viewerParticipantId,
      );
      if (rankIndex >= 0) {
        viewer = { ...ranked[rankIndex], rank: rankIndex + 1 };
      } else {
        const stored = file.entries[viewerParticipantId] ?? null;
        viewer =
          stored === null
            ? null
            : { ...toPublicEntry(viewerParticipantId, stored), rank: null };
      }
    }
    return { entries, totalRankedParticipants: ranked.length, viewer };
  }

  private async mutate<T>(mutator: (file: LedgerFile) => T): Promise<T> {
    const run = this.writeQueue.then(async () => {
      const file = await this.load();
      const result = mutator(file);
      await this.save(file);
      return result;
    });
    // A failed mutation must never wedge the queue for later callers.
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<LedgerFile> {
    return (await this.loadDetailed()).file;
  }

  /**
   * Parses the on-disk file, accepting either the current shape or the
   * legacy pre-migration shape per entry (a mixed file — some entries
   * already current, some still legacy — is expected mid-rollout and
   * handled transparently). `migrated` is true iff at least one entry
   * needed the legacy conversion, so the caller can decide whether to
   * persist the migrated form back to disk.
   */
  private async loadDetailed(): Promise<{
    file: LedgerFile;
    migrated: boolean;
  }> {
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
      return {
        file: { schemaVersion: SCHEMA_VERSION, entries: {} },
        migrated: false,
      };
    }
    if (typeof raw !== "object" || raw === null) {
      return {
        file: { schemaVersion: SCHEMA_VERSION, entries: {} },
        migrated: false,
      };
    }
    if (!("schemaVersion" in raw) || raw.schemaVersion !== SCHEMA_VERSION) {
      return {
        file: { schemaVersion: SCHEMA_VERSION, entries: {} },
        migrated: false,
      };
    }
    if (
      !("entries" in raw) ||
      typeof raw.entries !== "object" ||
      raw.entries === null
    ) {
      return {
        file: { schemaVersion: SCHEMA_VERSION, entries: {} },
        migrated: false,
      };
    }
    const rawEntries = raw.entries;
    const entries: Record<string, StoredEntry> = {};
    let migrated = false;
    for (const [participantId, rawEntry] of Object.entries(rawEntries)) {
      if (!PARTICIPANT_ID_PATTERN.test(participantId)) continue;
      const fresh = storedEntrySchema.safeParse(rawEntry);
      if (fresh.success) {
        entries[participantId] = fresh.data;
        continue;
      }
      const legacy = legacyStoredEntrySchema.safeParse(rawEntry);
      if (legacy.success) {
        const premiereResults: Record<string, number> = {};
        for (const premiereId of legacy.data.settledPremiereIds) {
          if (PREMIERE_ID_PATTERN.test(premiereId))
            premiereResults[premiereId] = 0;
        }
        entries[participantId] = {
          lifetimePoints: legacy.data.lifetimePoints,
          premieresTraded: legacy.data.premieresTraded,
          premieresWon: legacy.data.premieresWon,
          updatedAt: legacy.data.updatedAt,
          premiereResults,
        };
        migrated = true;
      }
      // Neither shape parses: drop the single malformed entry rather than
      // discarding the whole ledger file.
    }
    return { file: { schemaVersion: SCHEMA_VERSION, entries }, migrated };
  }

  private async save(file: LedgerFile): Promise<void> {
    const temporaryPath = path.join(
      this.root,
      `.${LEDGER_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    await fs.writeFile(temporaryPath, JSON.stringify(file), { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
  }
}

interface LedgerFile {
  schemaVersion: typeof SCHEMA_VERSION;
  entries: Record<string, StoredEntry>;
}

function emptyEntry(): StoredEntry {
  return {
    lifetimePoints: 0,
    premieresTraded: 0,
    premieresWon: 0,
    updatedAt: new Date(0).toISOString(),
    premiereResults: {},
  };
}

/**
 * Deliberately a no-op, kept as the single place to reintroduce compaction if
 * it ever earns its keep.
 *
 * There used to be a 500-premiere cap here, and it was silently destructive:
 * `mergeParticipant` transfers only the retained `premiereResults`, so linking
 * an identity with more than 500 settled premieres dropped every result past
 * the cap — score and history gone, with no error. At roughly two premieres an
 * hour that is about ten days of play.
 *
 * Compaction could be done correctly by folding trimmed results into a running
 * net plus count and summing those on merge, but then two identities that both
 * traded the same compacted premiere can no longer be de-duplicated, which is
 * exactly the correctness the merge rule depends on. A result is a premiere id
 * and a number; a decade of play is a few hundred kilobytes. Storing all of
 * them is cheaper than being subtly wrong.
 */
function trimPremiereResults(_entry: StoredEntry): void {
  return;
}

function toPublicEntry(
  participantId: string,
  entry: StoredEntry,
): ReplayPremierePointsEntry {
  return {
    participantId,
    lifetimePoints: entry.lifetimePoints,
    premieresTraded: entry.premieresTraded,
    premieresWon: entry.premieresWon,
    updatedAt: entry.updatedAt,
  };
}

function compareEntries(
  a: ReplayPremierePointsEntry,
  b: ReplayPremierePointsEntry,
): number {
  if (b.lifetimePoints !== a.lifetimePoints)
    return b.lifetimePoints - a.lifetimePoints;
  if (b.premieresWon !== a.premieresWon) return b.premieresWon - a.premieresWon;
  if (b.premieresTraded !== a.premieresTraded)
    return b.premieresTraded - a.premieresTraded;
  return a.participantId < b.participantId
    ? -1
    : a.participantId > b.participantId
      ? 1
      : 0;
}

function boundedLimit(value: number): number {
  if (!Number.isFinite(value)) return 25;
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

