/**
 * Durable platform account records — the one place a display name lives.
 * Same on-disk conventions as
 * every other store in this codebase: flat JSON map, atomic
 * write-temp-then-rename, one file, serialized per-instance write queue.
 *
 * A visitor gets a stable `accountId` (via `PlatformAccountSecurity`'s
 * cookie) before they ever appear here — this store only gains a row once
 * something worth persisting happens (a display name is set, or a GitHub
 * link creates one implicitly). `getAccount` returning `null` for a
 * cookie-only, never-customized visitor is the expected common case, not
 * an error.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

const ACCOUNT_ID_PATTERN = /^acct_[a-f0-9]{32}$/;
const ACCOUNT_STORE_FILE_NAME = "platform-accounts-v1.json";
const SCHEMA_VERSION = 1 as const;
const MAX_DISPLAY_NAME_CODEPOINTS = 32;

export interface PlatformAccountView {
  readonly accountId: string;
  readonly displayName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const storedAccountSchema = z.object({
  displayName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type StoredAccount = z.infer<typeof storedAccountSchema>;

const accountStoreFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  accounts: z.record(z.string().regex(ACCOUNT_ID_PATTERN), storedAccountSchema),
});
type AccountStoreFile = z.infer<typeof accountStoreFileSchema>;

/** Same sanitization discipline as `ReplayPremierePointsLedger`'s display name: collapse whitespace, drop invisible control/format characters, trim, cap length in code points. `null` means "clear it". */
function sanitizeDisplayName(raw: string): string | null {
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

function toView(accountId: string, stored: StoredAccount): PlatformAccountView {
  return {
    accountId,
    displayName: stored.displayName,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

export class PlatformAccountStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(root: string) {
    this.filePath = path.join(root, ACCOUNT_STORE_FILE_NAME);
  }

  static async open(root: string): Promise<PlatformAccountStore> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return new PlatformAccountStore(root);
  }

  async getAccount(accountId: string): Promise<PlatformAccountView | null> {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error(`invalid_account_id: ${accountId}`);
    }
    const file = await this.load();
    const stored = file.accounts[accountId];
    return stored === undefined ? null : toView(accountId, stored);
  }

  async setDisplayName(
    accountId: string,
    rawName: string,
  ): Promise<PlatformAccountView> {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error(`invalid_account_id: ${accountId}`);
    }
    const displayName = sanitizeDisplayName(rawName);
    return this.mutate((file) => {
      const nowIso = new Date().toISOString();
      const existing = file.accounts[accountId];
      const stored: StoredAccount = {
        displayName,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };
      file.accounts[accountId] = stored;
      return toView(accountId, stored);
    });
  }

  /**
   * Folds `fromAccountId`'s row into `intoAccountId` on a GitHub link —
   * the canonical (target) side's display name wins when both sides have
   * one (deterministic, matching `ReplayPremiereLeagueClaimStore.
   * mergeClaim`'s reconciliation, not `ReplayPremierePointsLedger.
   * mergeParticipant`'s sum-both-sides rule: a display name isn't
   * fungible like credits, so "keep one side, deterministically" is
   * correct here). The earlier `createdAt` of the two survives, since the
   * account genuinely existed from whichever first appeared.
   */
  async mergeAccount(
    fromAccountId: string,
    intoAccountId: string,
  ): Promise<PlatformAccountView | null> {
    if (
      !ACCOUNT_ID_PATTERN.test(fromAccountId) ||
      !ACCOUNT_ID_PATTERN.test(intoAccountId)
    ) {
      throw new Error("invalid_account_id");
    }
    if (fromAccountId === intoAccountId) {
      const account = await this.getAccount(intoAccountId);
      return account;
    }
    return this.mutate((file) => {
      const source = file.accounts[fromAccountId];
      delete file.accounts[fromAccountId];
      const target = file.accounts[intoAccountId];
      if (source === undefined) {
        return target === undefined ? null : toView(intoAccountId, target);
      }
      if (target === undefined) {
        file.accounts[intoAccountId] = { ...source };
        return toView(intoAccountId, source);
      }
      const nowIso = new Date().toISOString();
      const merged: StoredAccount = {
        displayName: target.displayName ?? source.displayName,
        createdAt:
          source.createdAt < target.createdAt
            ? source.createdAt
            : target.createdAt,
        updatedAt: nowIso,
      };
      file.accounts[intoAccountId] = merged;
      return toView(intoAccountId, merged);
    });
  }

  private async mutate<T>(mutator: (file: AccountStoreFile) => T): Promise<T> {
    const run = this.writeQueue.then(async () => {
      const file = await this.load();
      const result = mutator(file);
      await this.save(file);
      return result;
    });
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async load(): Promise<AccountStoreFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const result = accountStoreFileSchema.safeParse(parsed);
      if (result.success) return result.data;
      throw new Error(
        `Platform account store is unreadable at ${this.filePath} — refusing to start empty and overwrite it`,
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
    return { schemaVersion: SCHEMA_VERSION, accounts: {} };
  }

  private async save(file: AccountStoreFile): Promise<void> {
    const root = path.dirname(this.filePath);
    const temporaryPath = path.join(
      root,
      `.${ACCOUNT_STORE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    await fs.writeFile(temporaryPath, JSON.stringify(file), { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
  }
}
