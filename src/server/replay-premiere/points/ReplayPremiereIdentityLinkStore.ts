/**
 * Durable GitHub-identity link store: GitHub's immutable numeric user id
 * mapped to a canonical guest `participantId`, plus an alias map from any
 * merged-away `participantId` to its canonical target. Beside the points
 * ledger (`points/`), same conventions — atomic write-temp-then-rename,
 * one file, outside the premiere private state root that gets wiped every
 * cycle (see `resolveReplayPremierePointsLedgerRoot`'s doc: the exact same
 * reasoning applies here, so this resolves against the same root by
 * default).
 *
 * Deliberately keyed on GitHub's numeric `id`, never `login`: a handle can
 * be renamed or recycled to a different account, so a handle-keyed link
 * would eventually hand one person's history to a stranger. `login` and
 * `avatarUrl` are refreshed on every successful sign-in — pure display
 * metadata, never identity.
 *
 * Concurrency: every mutation is serialized through this instance's own
 * write queue (identical pattern to `ReplayPremierePointsLedger.mutate`),
 * so two callback requests racing for the same GitHub id — even truly
 * concurrent ones — are strictly ordered: whichever wins the race
 * establishes the canonical link; the second observes it already resolved
 * and takes the merge (or no-op) branch. This guarantees "one GitHub id
 * maps to exactly one canonical identity" as long as both requests are
 * handled by this one process (true for this deployment: one Node server
 * process holds the singleton store).
 *
 * The GitHub identity provider is never in the path of a trade: this store
 * is consulted only by the sign-in/callback routes and (read-only, to
 * resolve a possibly-merged-away cookie to its canonical row) by the
 * points routes — never by market order placement or settlement. If
 * GitHub is unreachable, linking simply fails; trading is unaffected.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ReplayPremierePointsLedger } from "./ReplayPremierePointsLedger";

const PARTICIPANT_ID_PATTERN = /^guest_[a-f0-9]{32}$/;
const GITHUB_USER_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const LINK_STORE_FILE_NAME = "github-identity-links-v1.json";
const SCHEMA_VERSION = 1 as const;

export interface ReplayPremiereGithubUser {
  readonly githubUserId: number;
  readonly login: string;
  readonly avatarUrl: string | null;
}

export interface ReplayPremiereGithubIdentityStatus {
  readonly signedIn: boolean;
  readonly login: string | null;
  readonly avatarUrl: string | null;
  /** The canonical participantId this identity resolves to — equal to the queried id when unlinked or when it IS the canonical id. */
  readonly canonicalParticipantId: string;
}

export interface ReplayPremiereGithubLinkResult {
  readonly canonicalParticipantId: string;
  readonly login: string;
  readonly avatarUrl: string | null;
  /** True iff this call folded a DIFFERENT, previously-distinct participant's history into the canonical identity. */
  readonly merged: boolean;
  /** True iff `merged` AND both sides had carried a DIFFERENT self-asserted league claim, so the source browser's claim was discarded in favor of the canonical target's — see `ReplayPremiereLeagueClaimStore.mergeClaim`. Always false when `merged` is false. */
  readonly leagueClaimReplaced: boolean;
}

const storedLinkSchema = z.object({
  githubUserId: z.number().int().positive(),
  login: z.string().min(1).max(64),
  avatarUrl: z.string().url().nullable(),
  participantId: z.string().regex(PARTICIPANT_ID_PATTERN),
  linkedAt: z.string(),
  updatedAt: z.string(),
});
type StoredLink = z.infer<typeof storedLinkSchema>;

const linkStoreFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  byGithubId: z.record(
    z.string().regex(GITHUB_USER_ID_PATTERN),
    storedLinkSchema,
  ),
  githubIdByParticipantId: z.record(
    z.string().regex(PARTICIPANT_ID_PATTERN),
    z.string().regex(GITHUB_USER_ID_PATTERN),
  ),
  aliases: z.record(
    z.string().regex(PARTICIPANT_ID_PATTERN),
    z.string().regex(PARTICIPANT_ID_PATTERN),
  ),
});
type LinkStoreFile = z.infer<typeof linkStoreFileSchema>;

/**
 * Duck-typed slice of `ReplayPremierePointsLedger` this store depends on —
 * only the merge operation, never settlement or reads, so a test can hand
 * in a minimal fake without constructing a real ledger.
 */
export interface ReplayPremierePointsMerger {
  mergeParticipant(
    fromParticipantId: string,
    intoParticipantId: string,
  ): Promise<void>;
}

/**
 * Duck-typed slice of `ReplayPremiereLeagueClaimStore` this store depends
 * on — only the merge operation, mirroring `ReplayPremierePointsMerger`
 * above. Kept structural (not imported from `account/ReplayPremiereLeagueClaimStore`)
 * for the same reason: no import cycle, and a test can hand in a minimal
 * fake.
 */
export interface ReplayPremiereLeagueClaimMerger {
  mergeClaim(
    fromParticipantId: string,
    intoParticipantId: string,
  ): Promise<{
    readonly claim: {
      readonly playerName: string;
      readonly claimedAt: string;
      readonly updatedAt: string;
    } | null;
    readonly sourceClaimReplaced: boolean;
  }>;
}

export class ReplayPremiereIdentityLinkStore {
  private readonly filePath: string;
  private readonly pointsLedger: ReplayPremierePointsMerger;
  private readonly leagueClaimMerger: ReplayPremiereLeagueClaimMerger;
  private writeQueue: Promise<void> = Promise.resolve();
  /**
   * `resolveCanonicalParticipantId` sits on the hot trading path (every
   * authenticated read/write at the HTTP boundary) and the overwhelming
   * common case has no alias at all — almost nobody links. Re-reading and
   * re-validating the whole JSON blob per request would make that cheap
   * case scale with file size and add a syscall to every trade, so the
   * alias map is cached in memory after the first load and served from
   * there with zero I/O. `mutate` (the only writer) refreshes this cache
   * with the just-persisted state immediately after a successful `save`,
   * so a link/merge is visible to the very next resolve — no staleness
   * window. A fresh process (this origin restarts every cycle) starts
   * with an empty cache and pays exactly one real read, on its first
   * resolve; concurrent first callers share that one in-flight read
   * instead of each triggering their own.
   */
  private cachedAliasesPromise: Promise<ReadonlyMap<string, string>> | null =
    null;

  private constructor(
    root: string,
    pointsLedger: ReplayPremierePointsMerger,
    leagueClaimMerger: ReplayPremiereLeagueClaimMerger,
  ) {
    this.filePath = path.join(root, LINK_STORE_FILE_NAME);
    this.pointsLedger = pointsLedger;
    this.leagueClaimMerger = leagueClaimMerger;
  }

  static async open(
    root: string,
    pointsLedger: ReplayPremierePointsMerger,
    leagueClaimMerger: ReplayPremiereLeagueClaimMerger,
  ): Promise<ReplayPremiereIdentityLinkStore> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return new ReplayPremiereIdentityLinkStore(
      root,
      pointsLedger,
      leagueClaimMerger,
    );
  }

  /**
   * `aliases[participantId] ?? participantId` — always resolves in one hop;
   * see `linkOrMerge`, which collapses chains at merge time. Never a
   * network call (see class doc) and, past the first call in this
   * process, never a file read either — see the `cachedAliasesPromise`
   * doc above.
   */
  async resolveCanonicalParticipantId(participantId: string): Promise<string> {
    const aliases = await this.loadCachedAliases();
    return aliases.get(participantId) ?? participantId;
  }

  private loadCachedAliases(): Promise<ReadonlyMap<string, string>> {
    if (this.cachedAliasesPromise === null) {
      this.cachedAliasesPromise = this.load().then(
        (file) => new Map(Object.entries(file.aliases)),
      );
      // A failed cold read must not permanently poison the cache — let the
      // next call retry a fresh load instead of forever rejecting.
      this.cachedAliasesPromise.catch(() => {
        this.cachedAliasesPromise = null;
      });
    }
    return this.cachedAliasesPromise;
  }

  async getStatus(
    participantId: string,
  ): Promise<ReplayPremiereGithubIdentityStatus> {
    const file = await this.load();
    const canonicalParticipantId = file.aliases[participantId] ?? participantId;
    const githubId = file.githubIdByParticipantId[canonicalParticipantId];
    const link = githubId === undefined ? undefined : file.byGithubId[githubId];
    if (link === undefined) {
      return {
        signedIn: false,
        login: null,
        avatarUrl: null,
        canonicalParticipantId,
      };
    }
    return {
      signedIn: true,
      login: link.login,
      avatarUrl: link.avatarUrl,
      canonicalParticipantId,
    };
  }

  /**
   * Bulk sibling of `getStatus`, for decorating a whole leaderboard page in
   * one file read instead of one per row.
   */
  async describeMany(
    participantIds: readonly string[],
  ): Promise<ReadonlyMap<string, { login: string; avatarUrl: string | null }>> {
    const file = await this.load();
    const described = new Map<
      string,
      { login: string; avatarUrl: string | null }
    >();
    for (const participantId of participantIds) {
      const githubId = file.githubIdByParticipantId[participantId];
      const link =
        githubId === undefined ? undefined : file.byGithubId[githubId];
      if (link !== undefined) {
        described.set(participantId, {
          login: link.login,
          avatarUrl: link.avatarUrl,
        });
      }
    }
    return described;
  }

  /**
   * Links `participantId` to `githubUser.githubUserId`, or — if that
   * GitHub id already resolves to a DIFFERENT canonical participant —
   * merges `participantId`'s entire points history into it (see
   * `ReplayPremierePointsLedger.mergeParticipant`). Refreshes
   * `login`/`avatarUrl` on every call, including a no-op re-sign-in, so a
   * renamed handle is reflected on the very next sign-in.
   *
   * The ledger merge runs BEFORE this store's own file is persisted (both
   * still inside this store's serialized write queue): if the process
   * crashes between the two, the next `linkOrMerge` retry for the same
   * pair safely re-observes an already-emptied source entry and merges a
   * no-op (see `mergeParticipant`'s idempotency) before completing the
   * alias write — self-healing, no manual repair needed.
   */
  async linkOrMerge(
    participantId: string,
    githubUser: ReplayPremiereGithubUser,
  ): Promise<ReplayPremiereGithubLinkResult> {
    if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
      throw new Error("invalid_participant_id");
    }
    if (
      !Number.isSafeInteger(githubUser.githubUserId) ||
      githubUser.githubUserId <= 0 ||
      !GITHUB_LOGIN_PATTERN.test(githubUser.login)
    ) {
      throw new Error("invalid_github_user");
    }
    const githubId = String(githubUser.githubUserId);
    return this.mutate(async (file) => {
      const selfCanonical = file.aliases[participantId] ?? participantId;
      const existing = file.byGithubId[githubId];
      const nowIso = new Date().toISOString();
      // This participant may already be linked to a DIFFERENT GitHub account.
      // Silently repointing them would leave the previous account's record
      // still aimed here, so two GitHub identities would share one score and
      // one of them would be invisible in status. On a shared browser that is
      // a way to attach yourself to someone else's history. Refuse; switching
      // accounts is an explicit unlink, not a side effect of signing in.
      const alreadyLinkedGithubId = file.githubIdByParticipantId[selfCanonical];
      if (
        alreadyLinkedGithubId !== undefined &&
        alreadyLinkedGithubId !== githubId
      ) {
        throw new Error("github_identity_conflict");
      }
      if (existing === undefined) {
        const record: StoredLink = {
          githubUserId: githubUser.githubUserId,
          login: githubUser.login,
          avatarUrl: githubUser.avatarUrl,
          participantId: selfCanonical,
          linkedAt: nowIso,
          updatedAt: nowIso,
        };
        file.byGithubId[githubId] = record;
        file.githubIdByParticipantId[selfCanonical] = githubId;
        return {
          canonicalParticipantId: selfCanonical,
          login: record.login,
          avatarUrl: record.avatarUrl,
          merged: false,
          leagueClaimReplaced: false,
        };
      }
      const refreshed: StoredLink = {
        ...existing,
        login: githubUser.login,
        avatarUrl: githubUser.avatarUrl,
        updatedAt: nowIso,
      };
      file.byGithubId[githubId] = refreshed;
      if (existing.participantId === selfCanonical) {
        return {
          canonicalParticipantId: selfCanonical,
          login: refreshed.login,
          avatarUrl: refreshed.avatarUrl,
          merged: false,
          leagueClaimReplaced: false,
        };
      }
      const canonicalParticipantId = existing.participantId;
      await this.pointsLedger.mergeParticipant(
        selfCanonical,
        canonicalParticipantId,
      );
      const { sourceClaimReplaced } = await this.leagueClaimMerger.mergeClaim(
        selfCanonical,
        canonicalParticipantId,
      );
      // Collapse to one hop: anyone previously aliased to selfCanonical
      // (e.g. it was itself a merge target before ever linking to GitHub)
      // now resolves straight to the new canonical.
      for (const [aliasedId, target] of Object.entries(file.aliases)) {
        if (target === selfCanonical)
          file.aliases[aliasedId] = canonicalParticipantId;
      }
      file.aliases[selfCanonical] = canonicalParticipantId;
      delete file.githubIdByParticipantId[selfCanonical];
      return {
        canonicalParticipantId,
        login: refreshed.login,
        avatarUrl: refreshed.avatarUrl,
        merged: true,
        leagueClaimReplaced: sourceClaimReplaced,
      };
    });
  }

  private async mutate<T>(
    mutator: (file: LinkStoreFile) => Promise<T>,
  ): Promise<T> {
    const run = this.writeQueue.then(async () => {
      const file = await this.load();
      const result = await mutator(file);
      await this.save(file);
      // Refresh, never invalidate-and-wait: the very next resolve must see
      // this write, and doing it here (instead of nulling the cache) also
      // avoids a redundant re-read on the next call.
      this.cachedAliasesPromise = Promise.resolve(
        new Map(Object.entries(file.aliases)),
      );
      return result;
    });
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<LinkStoreFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const result = linkStoreFileSchema.safeParse(parsed);
      if (result.success) return result.data;
      // Readable, but not the shape we wrote. Do NOT fall through to an empty
      // store: the next sign-in would save over it and every account link
      // would be gone, silently. A missing file is the only thing that
      // legitimately means "no links yet".
      throw new Error(
        `Replay Premiere identity link store is unreadable at ${this.filePath} — refusing to start empty and overwrite it`,
      );
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
    return {
      schemaVersion: SCHEMA_VERSION,
      byGithubId: {},
      githubIdByParticipantId: {},
      aliases: {},
    };
  }

  private async save(file: LinkStoreFile): Promise<void> {
    const root = path.dirname(this.filePath);
    const temporaryPath = path.join(
      root,
      `.${LINK_STORE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    await fs.writeFile(temporaryPath, JSON.stringify(file), { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
  }
}

/**
 * A `ReplayPremierePointsMerger`-compatible view over a real
 * `ReplayPremierePointsLedger`, so the identity-link store never needs to
 * import the ledger's concrete class (duck-typed, matching the existing
 * `ReplayPremiereSettlementPointsRecorder` convention in
 * `ReplayPremiereInteractions.ts`).
 */
export function pointsMergerFor(
  ledger: ReplayPremierePointsLedger,
): ReplayPremierePointsMerger {
  return { mergeParticipant: ledger.mergeParticipant.bind(ledger) };
}
