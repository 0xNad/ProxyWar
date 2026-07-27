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
const MAX_DISPLAY_NAME_CODEPOINTS = 32;
/** Bounded per-participant history — only the count/sum matter long-term; this just bounds file growth. */
const MAX_SETTLED_PREMIERE_HISTORY = 500;

export interface ReplayPremierePointsEntry {
  readonly participantId: string;
  readonly displayName: string | null;
  /** Lifetime realized net P&L (credits), summed only across premieres actually traded. See class doc. */
  readonly lifetimePoints: number;
  readonly premieresTraded: number;
  readonly premieresWon: number;
  readonly updatedAt: string;
}

export interface ReplayPremiereLeaderboardEntry extends ReplayPremierePointsEntry {
  readonly rank: number;
}

export interface ReplayPremiereLeaderboardView {
  readonly entries: readonly ReplayPremiereLeaderboardEntry[];
  readonly totalRankedParticipants: number;
  /** The requesting viewer's own row, `rank: null` when they have never traded a premiere to completion (so are not board-eligible). `null` when no viewer identity was supplied. */
  readonly viewer: (ReplayPremierePointsEntry & { readonly rank: number | null }) | null;
}

/** One real participant's final settlement figures for one premiere's market. */
export interface ReplayPremiereSettlementLedgerEntry {
  readonly participantId: string;
  /** Total ever granted to this participant's market account this premiere — their starting bankroll. */
  readonly granted: number;
  /** Final ledger balance for this participant once the market settled. */
  readonly balance: number;
}

const storedEntrySchema = z.object({
  displayName: z.string().nullable(),
  lifetimePoints: z.number().finite(),
  premieresTraded: z.number().int().nonnegative(),
  premieresWon: z.number().int().nonnegative(),
  updatedAt: z.string(),
  settledPremiereIds: z.array(z.string()),
});
type StoredEntry = z.infer<typeof storedEntrySchema>;

const ledgerFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  entries: z.record(z.string().regex(PARTICIPANT_ID_PATTERN), storedEntrySchema),
});
type LedgerFile = z.infer<typeof ledgerFileSchema>;

export function resolveReplayPremierePointsLedgerRoot(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configured = environment[REPLAY_PREMIERE_POINTS_LEDGER_ROOT_ENV]?.trim();
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
 * placed at least one order in. A participant who never traded a given
 * premiere contributes nothing for it — critically, a participant who
 * NEVER trades at all has no ledger entry from settlement whatsoever, so
 * they never appear on the leaderboard outranking someone who took real
 * risk. Carrying raw bankroll forward was rejected for exactly this
 * failure mode: it parks a non-trader at a permanent 1,000 that outranks
 * a trader who finished at 900 after real risk. Net realized P&L instead
 * rewards being profitable, not merely present — a losing trader still
 * nets a negative score (correctly below a non-participant), but an
 * idle bankroll can never masquerade as a result. `premieresTraded` and
 * `premieresWon` (net P&L > 0) are carried alongside as a hit-rate
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
    return new ReplayPremierePointsLedger(root);
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
        if (entry.settledPremiereIds.includes(premiereId)) continue;
        const net = Math.round(settlement.balance - settlement.granted);
        entry.lifetimePoints += net;
        entry.premieresTraded += 1;
        if (net > 0) entry.premieresWon += 1;
        entry.settledPremiereIds.push(premiereId);
        if (entry.settledPremiereIds.length > MAX_SETTLED_PREMIERE_HISTORY) {
          entry.settledPremiereIds.splice(
            0,
            entry.settledPremiereIds.length - MAX_SETTLED_PREMIERE_HISTORY,
          );
        }
        entry.updatedAt = nowIso;
        file.entries[settlement.participantId] = entry;
      }
    });
  }

  /** Sets (or clears, with an empty/whitespace-only name) a participant's leaderboard display name. Sanitized for display — see {@link sanitizeDisplayName}. */
  async setDisplayName(
    participantId: string,
    rawName: string,
  ): Promise<ReplayPremierePointsEntry> {
    if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
      throw new Error(`invalid_participant_id: ${participantId}`);
    }
    const displayName = sanitizeDisplayName(rawName);
    return this.mutate((file) => {
      const entry = file.entries[participantId] ?? emptyEntry();
      entry.displayName = displayName;
      entry.updatedAt = new Date().toISOString();
      file.entries[participantId] = entry;
      return toPublicEntry(participantId, entry);
    });
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
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const result = ledgerFileSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    return { schemaVersion: SCHEMA_VERSION, entries: {} };
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

function emptyEntry(): StoredEntry {
  return {
    displayName: null,
    lifetimePoints: 0,
    premieresTraded: 0,
    premieresWon: 0,
    updatedAt: new Date(0).toISOString(),
    settledPremiereIds: [],
  };
}

function toPublicEntry(
  participantId: string,
  entry: StoredEntry,
): ReplayPremierePointsEntry {
  return {
    participantId,
    displayName: entry.displayName,
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
  if (b.lifetimePoints !== a.lifetimePoints) return b.lifetimePoints - a.lifetimePoints;
  if (b.premieresWon !== a.premieresWon) return b.premieresWon - a.premieresWon;
  if (b.premieresTraded !== a.premieresTraded) return b.premieresTraded - a.premieresTraded;
  return a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0;
}

function boundedLimit(value: number): number {
  if (!Number.isFinite(value)) return 25;
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

/**
 * Collapses whitespace (including tabs/newlines, which become a single
 * space rather than vanishing) FIRST, then strips remaining control/format
 * Unicode categories (invisible non-whitespace characters like NUL or a
 * zero-width space, which could otherwise visually spoof another name or
 * silently mash two words together) — order matters: stripping control
 * characters before collapsing whitespace would delete a tab/newline
 * outright and glue the words on either side of it together. Trims, then
 * caps length at {@link MAX_DISPLAY_NAME_CODEPOINTS} code points (not
 * UTF-16 units, so a name made of astral-plane characters isn't silently
 * split mid-character). An empty result after sanitizing clears the
 * display name (`null`) rather than storing an empty string.
 */
function sanitizeDisplayName(raw: string): string | null {
  if (typeof raw !== "string") {
    throw new Error("invalid_display_name");
  }
  const stripped = raw
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  if (stripped.length === 0) return null;
  const codePoints = Array.from(stripped);
  return codePoints.length > MAX_DISPLAY_NAME_CODEPOINTS
    ? codePoints.slice(0, MAX_DISPLAY_NAME_CODEPOINTS).join("")
    : stripped;
}
