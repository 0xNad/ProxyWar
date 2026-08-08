/**
 * Durable GitHub-identity link store for the PLATFORM: GitHub's immutable
 * numeric user id mapped to a canonical platform `accountId`, plus an
 * alias map from any merged-away `accountId` to its canonical target. Merges
 * `PlatformAccountStore` display names and `PlatformPolicyClaimStore`
 * lineage claims.
 *
 * Deliberately keyed on GitHub's numeric `id`, never `login`: a handle can
 * be renamed or recycled to a different account, so a handle-keyed link
 * would eventually hand one person's history to a stranger. `login` and
 * `avatarUrl` are refreshed on every successful sign-in — pure display
 * metadata, never identity.
 *
 * Concurrency: every mutation is serialized through this instance's own
 * write queue, so two callback requests racing for the same GitHub id —
 * even truly concurrent ones — are strictly ordered: whichever wins the
 * race establishes the canonical link; the second observes it already
 * resolved and takes the merge (or no-op) branch.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { GithubOAuthUser } from "../GithubOAuthClient";
import type { PlatformAccountStore } from "./PlatformAccountStore";
import type { PlatformPolicyClaimStore } from "./PlatformPolicyClaimStore";

const ACCOUNT_ID_PATTERN = /^acct_[a-f0-9]{32}$/;
const GITHUB_USER_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const LINK_STORE_FILE_NAME = "platform-github-links-v1.json";
const SCHEMA_VERSION = 1 as const;

export interface PlatformGithubIdentityStatus {
  readonly signedIn: boolean;
  readonly login: string | null;
  readonly avatarUrl: string | null;
  readonly canonicalAccountId: string;
}

export interface PlatformGithubLinkResult {
  readonly canonicalAccountId: string;
  readonly login: string;
  readonly avatarUrl: string | null;
  readonly merged: boolean;
}

const storedLinkSchema = z.object({
  githubUserId: z.number().int().positive(),
  login: z.string().min(1).max(64),
  avatarUrl: z.string().url().nullable(),
  accountId: z.string().regex(ACCOUNT_ID_PATTERN),
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
  githubIdByAccountId: z.record(
    z.string().regex(ACCOUNT_ID_PATTERN),
    z.string().regex(GITHUB_USER_ID_PATTERN),
  ),
  aliases: z.record(
    z.string().regex(ACCOUNT_ID_PATTERN),
    z.string().regex(ACCOUNT_ID_PATTERN),
  ),
});
type LinkStoreFile = z.infer<typeof linkStoreFileSchema>;

export class PlatformGithubIdentityLinkStore {
  private readonly filePath: string;
  private readonly accounts: PlatformAccountStore;
  private readonly claims: PlatformPolicyClaimStore;
  private writeQueue: Promise<void> = Promise.resolve();
  /** See `ReplayPremiereIdentityLinkStore`'s identical field for the full reasoning: `resolveCanonicalAccountId` is cheap and hot enough (every authenticated platform read/write) to warrant an in-memory cache refreshed synchronously on every write. */
  private cachedAliasesPromise: Promise<ReadonlyMap<string, string>> | null =
    null;

  private constructor(
    root: string,
    accounts: PlatformAccountStore,
    claims: PlatformPolicyClaimStore,
  ) {
    this.filePath = path.join(root, LINK_STORE_FILE_NAME);
    this.accounts = accounts;
    this.claims = claims;
  }

  static async open(
    root: string,
    accounts: PlatformAccountStore,
    claims: PlatformPolicyClaimStore,
  ): Promise<PlatformGithubIdentityLinkStore> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return new PlatformGithubIdentityLinkStore(root, accounts, claims);
  }

  async resolveCanonicalAccountId(accountId: string): Promise<string> {
    const aliases = await this.loadCachedAliases();
    return aliases.get(accountId) ?? accountId;
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

  async getStatus(accountId: string): Promise<PlatformGithubIdentityStatus> {
    const file = await this.load();
    const canonicalAccountId = file.aliases[accountId] ?? accountId;
    const githubId = file.githubIdByAccountId[canonicalAccountId];
    const link = githubId === undefined ? undefined : file.byGithubId[githubId];
    if (link === undefined) {
      return {
        signedIn: false,
        login: null,
        avatarUrl: null,
        canonicalAccountId,
      };
    }
    return {
      signedIn: true,
      login: link.login,
      avatarUrl: link.avatarUrl,
      canonicalAccountId,
    };
  }

  /**
   * Links `accountId` to `githubUser.githubUserId`, or — if that GitHub id
   * already resolves to a DIFFERENT canonical account — merges
   * `accountId`'s display name and claim into it. See
   * `ReplayPremiereIdentityLinkStore.linkOrMerge`'s doc for the identical
   * conflict-refusal and self-healing-on-crash reasoning.
   */
  async linkOrMerge(
    accountId: string,
    githubUser: GithubOAuthUser,
  ): Promise<PlatformGithubLinkResult> {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error("invalid_account_id");
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
      const selfCanonical = file.aliases[accountId] ?? accountId;
      const existing = file.byGithubId[githubId];
      const nowIso = new Date().toISOString();
      const alreadyLinkedGithubId = file.githubIdByAccountId[selfCanonical];
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
          accountId: selfCanonical,
          linkedAt: nowIso,
          updatedAt: nowIso,
        };
        file.byGithubId[githubId] = record;
        file.githubIdByAccountId[selfCanonical] = githubId;
        return {
          canonicalAccountId: selfCanonical,
          login: record.login,
          avatarUrl: record.avatarUrl,
          merged: false,
        };
      }
      const refreshed: StoredLink = {
        ...existing,
        login: githubUser.login,
        avatarUrl: githubUser.avatarUrl,
        updatedAt: nowIso,
      };
      file.byGithubId[githubId] = refreshed;
      if (existing.accountId === selfCanonical) {
        return {
          canonicalAccountId: selfCanonical,
          login: refreshed.login,
          avatarUrl: refreshed.avatarUrl,
          merged: false,
        };
      }
      const canonicalAccountId = existing.accountId;
      await this.accounts.mergeAccount(selfCanonical, canonicalAccountId);
      // Union, not "canonical side wins" — see
      // `PlatformPolicyClaimStore.mergeClaims`'s doc for why a claim SET
      // has no conflict left to resolve; nothing here is ever discarded.
      await this.claims.mergeClaims(selfCanonical, canonicalAccountId);
      for (const [aliasedId, target] of Object.entries(file.aliases)) {
        if (target === selfCanonical)
          file.aliases[aliasedId] = canonicalAccountId;
      }
      file.aliases[selfCanonical] = canonicalAccountId;
      delete file.githubIdByAccountId[selfCanonical];
      return {
        canonicalAccountId,
        login: refreshed.login,
        avatarUrl: refreshed.avatarUrl,
        merged: true,
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
      throw new Error(
        `Platform GitHub identity link store is unreadable at ${this.filePath} — refusing to start empty and overwrite it`,
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
      githubIdByAccountId: {},
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
