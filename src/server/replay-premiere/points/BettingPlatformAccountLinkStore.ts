/**
 * Durable link from a platform `accountId` to betting's own canonical
 * guest `participantId`, plus an alias map from any merged-away
 * `participantId` to its canonical target. Betting's replacement for the
 * old direct-GitHub-link store (`ReplayPremiereIdentityLinkStore`,
 * removed): the platform is now the sole account authority, so betting no
 * longer talks to GitHub at all — it learns "the platform recognises this
 * browser as account X, currently displaying as Y" once, at handoff-redeem
 * time (see `BettingIdentityHandoff.ts`), and caches it here.
 *
 * This is exactly the "own local guest cookie, unchanged; learn the
 * platform account via the handoff" half of the contract's child-app
 * design: betting's canonical-participant merge machinery (this store)
 * and its points ledger stay betting-owned and betting-written; only the
 * TRIGGER for a merge moved from "GitHub OAuth completed directly here"
 * to "the platform's handoff redeemed successfully".
 *
 * Same structure, same concurrency reasoning, same crash-safety as the
 * store it replaces — see its historical doc (now `PlatformGithubIdentityLinkStore`'s,
 * the platform-side sibling of the same design) for the exhaustive
 * per-method reasoning; only what merges (display name, not points —
 * betting's points ledger merge stays a plain `mergeParticipant` call
 * driven from here) and what's cached (`displayName`, not `login`/
 * `avatarUrl`) differ.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ReplayPremierePointsLedger } from "./ReplayPremierePointsLedger";

const PARTICIPANT_ID_PATTERN = /^guest_[a-f0-9]{32}$/;
const PLATFORM_ACCOUNT_ID_PATTERN = /^acct_[a-f0-9]{32}$/;
const LINK_STORE_FILE_NAME = "platform-account-links-v1.json";
const SCHEMA_VERSION = 1 as const;

export interface BettingPlatformClaim {
  readonly lineageSlug: string;
  readonly label: string;
}

export interface BettingPlatformLinkStatus {
  readonly linked: boolean;
  readonly displayName: string | null;
  readonly canonicalParticipantId: string;
  /**
   * Cached from the platform at the last successful handoff — private,
   * self-asserted, and STALE by construction: it reflects whatever the
   * claim SET was when the user last signed in, not a live platform
   * read. See this store's class doc. Empty for an unlinked participant,
   * or a linked one who has never claimed anything.
   */
  readonly claims: readonly BettingPlatformClaim[];
}

export interface BettingPlatformLinkResult {
  readonly canonicalParticipantId: string;
  readonly displayName: string | null;
  readonly claims: readonly BettingPlatformClaim[];
  readonly merged: boolean;
}

const bettingPlatformClaimSchema = z.object({ lineageSlug: z.string(), label: z.string() });

/**
 * Accepts either the current shape (`claims`, an array) or the
 * pre-2026-07-29 shape (`claim`, one nullable object, or altogether
 * missing on a link written before that field existed) — renamed and
 * array-ified BEFORE the object schema below ever sees it, so an
 * already-linked participant's cached claim (`null`, or one claim)
 * migrates forward losslessly the next time this file is read. No
 * forced write-back needed: this is a CACHE, refreshed on every sign-in
 * anyway (unlike the platform's own durable `PlatformPolicyClaimStore`,
 * which self-heals on `open()` because it's the only copy that matters).
 */
const storedLinkSchema = z.preprocess((raw) => {
  if (typeof raw !== "object" || raw === null || "claims" in raw) return raw;
  const { claim, ...rest } = raw as Record<string, unknown>;
  return { ...rest, claims: claim === null || claim === undefined ? [] : [claim] };
}, z.object({
  platformAccountId: z.string().regex(PLATFORM_ACCOUNT_ID_PATTERN),
  displayName: z.string().nullable(),
  claims: z.array(bettingPlatformClaimSchema),
  participantId: z.string().regex(PARTICIPANT_ID_PATTERN),
  linkedAt: z.string(),
  updatedAt: z.string(),
}));
type StoredLink = z.infer<typeof storedLinkSchema>;

const linkStoreFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  byPlatformAccountId: z.record(
    z.string().regex(PLATFORM_ACCOUNT_ID_PATTERN),
    storedLinkSchema,
  ),
  platformAccountIdByParticipantId: z.record(
    z.string().regex(PARTICIPANT_ID_PATTERN),
    z.string().regex(PLATFORM_ACCOUNT_ID_PATTERN),
  ),
  aliases: z.record(
    z.string().regex(PARTICIPANT_ID_PATTERN),
    z.string().regex(PARTICIPANT_ID_PATTERN),
  ),
});
type LinkStoreFile = z.infer<typeof linkStoreFileSchema>;

export interface BettingPointsMerger {
  mergeParticipant(fromParticipantId: string, intoParticipantId: string): Promise<void>;
}

export function pointsMergerFor(ledger: ReplayPremierePointsLedger): BettingPointsMerger {
  return { mergeParticipant: ledger.mergeParticipant.bind(ledger) };
}

export class BettingPlatformAccountLinkStore {
  private readonly filePath: string;
  private readonly pointsLedger: BettingPointsMerger;
  private writeQueue: Promise<void> = Promise.resolve();
  private cachedAliasesPromise: Promise<ReadonlyMap<string, string>> | null = null;

  private constructor(root: string, pointsLedger: BettingPointsMerger) {
    this.filePath = path.join(root, LINK_STORE_FILE_NAME);
    this.pointsLedger = pointsLedger;
  }

  static async open(
    root: string,
    pointsLedger: BettingPointsMerger,
  ): Promise<BettingPlatformAccountLinkStore> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return new BettingPlatformAccountLinkStore(root, pointsLedger);
  }

  async resolveCanonicalParticipantId(participantId: string): Promise<string> {
    const aliases = await this.loadCachedAliases();
    return aliases.get(participantId) ?? participantId;
  }

  private loadCachedAliases(): Promise<ReadonlyMap<string, string>> {
    if (this.cachedAliasesPromise === null) {
      this.cachedAliasesPromise = this.load().then(
        (file) => new Map(Object.entries(file.aliases)),
      );
      this.cachedAliasesPromise.catch(() => {
        this.cachedAliasesPromise = null;
      });
    }
    return this.cachedAliasesPromise;
  }

  async getStatus(participantId: string): Promise<BettingPlatformLinkStatus> {
    const file = await this.load();
    const canonicalParticipantId = file.aliases[participantId] ?? participantId;
    const platformAccountId = file.platformAccountIdByParticipantId[canonicalParticipantId];
    const link =
      platformAccountId === undefined ? undefined : file.byPlatformAccountId[platformAccountId];
    if (link === undefined) {
      return { linked: false, displayName: null, canonicalParticipantId, claims: [] };
    }
    return {
      linked: true,
      displayName: link.displayName,
      canonicalParticipantId,
      claims: link.claims,
    };
  }

  /** Bulk sibling of `getStatus`, for decorating a whole leaderboard page in one file read instead of one per row. `platformAccountId` is non-null ONLY for a genuinely linked participant (never derivable from free text) — the anti-spoof primitive a consumer like the player-profile route needs to match "this leaderboard row is a real linked account" without trusting a display name alone. */
  async describeMany(
    participantIds: readonly string[],
  ): Promise<
    ReadonlyMap<string, { displayName: string | null; platformAccountId: string | null }>
  > {
    const file = await this.load();
    const described = new Map<
      string,
      { displayName: string | null; platformAccountId: string | null }
    >();
    for (const participantId of participantIds) {
      const platformAccountId = file.platformAccountIdByParticipantId[participantId];
      const link =
        platformAccountId === undefined ? undefined : file.byPlatformAccountId[platformAccountId];
      if (link !== undefined) {
        described.set(participantId, {
          displayName: link.displayName,
          platformAccountId: link.platformAccountId,
        });
      }
    }
    return described;
  }

  /**
   * Direct O(1) lookup by the platform's OWN opaque account id — the
   * correct join key for a public per-account betting profile. Display
   * name is NOT unique (`PlatformAccountStore.setDisplayName` never
   * enforces it) and is self-asserted, so matching on it — as
   * `/api/players/:name` used to — can silently surface one linked
   * account's stats under a DIFFERENT linked account's chosen name, or
   * under an unrelated league player's name. `platformAccountId` is
   * opaque, stable, and minted once at account creation; it never
   * collides and never needs a text match.
   */
  async getByPlatformAccountId(
    platformAccountId: string,
  ): Promise<{ participantId: string; displayName: string | null } | null> {
    if (!PLATFORM_ACCOUNT_ID_PATTERN.test(platformAccountId)) return null;
    const file = await this.load();
    const link = file.byPlatformAccountId[platformAccountId];
    return link === undefined
      ? null
      : { participantId: link.participantId, displayName: link.displayName };
  }

  /**
   * Links `participantId` to `platformAccountId` (or merges, if that
   * platform account already resolves to a DIFFERENT canonical
   * participant). Refreshes `displayName`/`claims` from the platform's
   * `displayName`/`claims` on every call, including a no-op re-link, so a
   * rename or a re-picked claim on the platform is reflected on the very
   * next sign-in here — see this store's class doc on staleness.
   */
  async linkOrMerge(
    participantId: string,
    platform: {
      platformAccountId: string;
      displayName: string | null;
      claims: readonly BettingPlatformClaim[];
    },
  ): Promise<BettingPlatformLinkResult> {
    if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
      throw new Error("invalid_participant_id");
    }
    if (!PLATFORM_ACCOUNT_ID_PATTERN.test(platform.platformAccountId)) {
      throw new Error("invalid_platform_account_id");
    }
    return this.mutate(async (file) => {
      const selfCanonical = file.aliases[participantId] ?? participantId;
      const existing = file.byPlatformAccountId[platform.platformAccountId];
      const nowIso = new Date().toISOString();
      const alreadyLinked = file.platformAccountIdByParticipantId[selfCanonical];
      if (alreadyLinked !== undefined && alreadyLinked !== platform.platformAccountId) {
        throw new Error("platform_account_conflict");
      }
      if (existing === undefined) {
        const record: StoredLink = {
          platformAccountId: platform.platformAccountId,
          displayName: platform.displayName,
          claims: [...platform.claims],
          participantId: selfCanonical,
          linkedAt: nowIso,
          updatedAt: nowIso,
        };
        file.byPlatformAccountId[platform.platformAccountId] = record;
        file.platformAccountIdByParticipantId[selfCanonical] = platform.platformAccountId;
        return {
          canonicalParticipantId: selfCanonical,
          displayName: record.displayName,
          claims: record.claims,
          merged: false,
        };
      }
      const refreshed: StoredLink = {
        ...existing,
        displayName: platform.displayName,
        claims: [...platform.claims],
        updatedAt: nowIso,
      };
      file.byPlatformAccountId[platform.platformAccountId] = refreshed;
      if (existing.participantId === selfCanonical) {
        return {
          canonicalParticipantId: selfCanonical,
          displayName: refreshed.displayName,
          claims: refreshed.claims,
          merged: false,
        };
      }
      const canonicalParticipantId = existing.participantId;
      await this.pointsLedger.mergeParticipant(selfCanonical, canonicalParticipantId);
      for (const [aliasedId, target] of Object.entries(file.aliases)) {
        if (target === selfCanonical) file.aliases[aliasedId] = canonicalParticipantId;
      }
      file.aliases[selfCanonical] = canonicalParticipantId;
      delete file.platformAccountIdByParticipantId[selfCanonical];
      return {
        canonicalParticipantId,
        displayName: refreshed.displayName,
        claims: refreshed.claims,
        merged: true,
      };
    });
  }

  private async mutate<T>(mutator: (file: LinkStoreFile) => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(async () => {
      const file = await this.load();
      const result = await mutator(file);
      await this.save(file);
      this.cachedAliasesPromise = Promise.resolve(new Map(Object.entries(file.aliases)));
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
      throw new Error(
        `Betting platform-account link store is unreadable at ${this.filePath} — refusing to start empty and overwrite it`,
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
      byPlatformAccountId: {},
      platformAccountIdByParticipantId: {},
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
