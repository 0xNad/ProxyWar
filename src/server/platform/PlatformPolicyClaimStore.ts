/**
 * Durable store for a self-asserted "this league model lineage is mine"
 * claim, one per canonical platform `accountId`. Platform-owned per the
 * contract: "Claims cover all of a user's models and policies, not one
 * `playerName`. A person owns a lineage — `daveey-proxywar:v24` and
 * everything before it."
 *
 * A league `policyLabel` is `<lineageSlug>:v<N>` (e.g.
 * `"daveey-proxywar:v24"` — see `artifacts/ai-league-runs/league/data.json`'s
 * `standings[].policyLabel`). Claiming any one version claims the whole
 * lineage: `lineageSlug` (the part before `:v<N>`) is what's actually
 * stored and compared, so a claim survives the lineage advancing past the
 * exact version the user picked — v24 today, v25 tomorrow, still the same
 * claim. `label` (the raw text the user submitted, usually the exact
 * `policyLabel` they picked from standings) is kept alongside purely for
 * display — "you claimed `daveey-proxywar:v24`" reads better than the
 * bare slug — and is never itself compared against anything.
 *
 * NOT an identity link like `PlatformGithubIdentityLinkStore` — there is
 * no cryptographic or platform-verified proof that an account actually
 * owns a given lineage (GitHub hands us an id/login; the league mirror
 * identifies competitors by `playerName`/`policyLabel`; nothing joins the
 * two). This is exactly what a participant typed into a picker: private
 * to their own account read, never surfaced on a public profile, a
 * leaderboard, or in any premiere. A verified path (Softmax sign-in) can
 * replace this with a verified owned-policy id later without callers
 * changing — see `docs/project-state/2026-07-27-softmax-signin-ask.md`.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

const ACCOUNT_ID_PATTERN = /^acct_[a-f0-9]{32}$/;
const CLAIM_STORE_FILE_NAME = "platform-policy-claims-v1.json";
const SCHEMA_VERSION = 1 as const;
const MAX_LABEL_CODEPOINTS = 120;
/** Matches the league mirror's `<slug>:v<N>` policyLabel convention (see `CoworldLeagueMirrorCore.ts`). Case/format of `slug` itself is whatever the league writer emitted — never re-validated here, only the trailing version suffix is meaningful to strip. */
const VERSION_SUFFIX = /:v\d+$/i;

export interface PlatformPolicyClaimView {
  readonly lineageSlug: string;
  readonly label: string;
  readonly claimedAt: string;
  readonly updatedAt: string;
}

const storedClaimSchema = z.object({
  lineageSlug: z.string().min(1),
  label: z.string().min(1),
  claimedAt: z.string(),
  updatedAt: z.string(),
});
type StoredClaim = z.infer<typeof storedClaimSchema>;

const claimStoreFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  claims: z.record(z.string().regex(ACCOUNT_ID_PATTERN), storedClaimSchema),
});
type ClaimStoreFile = z.infer<typeof claimStoreFileSchema>;

export interface PlatformPolicyClaimMergeResult {
  readonly claim: PlatformPolicyClaimView | null;
  readonly sourceClaimReplaced: boolean;
}

/** Same sanitization discipline as `ReplayPremiereLeagueClaimStore`'s: collapse whitespace, drop invisible control/format characters, trim, cap length in code points. `null` means "clear it". */
function sanitizeLabel(raw: string): string | null {
  const stripped = raw
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  if (stripped.length === 0) return null;
  const codePoints = Array.from(stripped);
  return codePoints.length > MAX_LABEL_CODEPOINTS
    ? codePoints.slice(0, MAX_LABEL_CODEPOINTS).join("")
    : stripped;
}

/** `"daveey-proxywar:v24"` -> `"daveey-proxywar"`. A label with no `:v<N>` suffix (a raw playerName, or hand-typed text) is its own lineage slug verbatim — still a coherent claim, just one with no version history attached yet. */
export function deriveLineageSlug(label: string): string {
  return label.replace(VERSION_SUFFIX, "");
}

export class PlatformPolicyClaimStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(root: string) {
    this.filePath = path.join(root, CLAIM_STORE_FILE_NAME);
  }

  static async open(root: string): Promise<PlatformPolicyClaimStore> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return new PlatformPolicyClaimStore(root);
  }

  async getClaim(accountId: string): Promise<PlatformPolicyClaimView | null> {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error(`invalid_account_id: ${accountId}`);
    }
    const file = await this.load();
    const stored = file.claims[accountId];
    return stored === undefined ? null : { ...stored };
  }

  /** Sets (or, given a blank/whitespace-only label, clears) the claim. `claimedAt` is preserved across an edit that changes which lineage is claimed — see `ReplayPremiereLeagueClaimStore.setClaim`'s identical reasoning. */
  async setClaim(
    accountId: string,
    rawLabel: string,
  ): Promise<PlatformPolicyClaimView | null> {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error(`invalid_account_id: ${accountId}`);
    }
    const label = sanitizeLabel(rawLabel);
    return this.mutate((file) => {
      if (label === null) {
        delete file.claims[accountId];
        return null;
      }
      const nowIso = new Date().toISOString();
      const existing = file.claims[accountId];
      const claim: StoredClaim = {
        lineageSlug: deriveLineageSlug(label),
        label,
        claimedAt: existing?.claimedAt ?? nowIso,
        updatedAt: nowIso,
      };
      file.claims[accountId] = claim;
      return { ...claim };
    });
  }

  /** Folds `fromAccountId`'s claim into `intoAccountId`'s on a GitHub link — same "canonical side wins on conflict, deterministic and explainable" reconciliation as `ReplayPremiereLeagueClaimStore.mergeClaim`; see its doc for why summing (like points) would be wrong here. */
  async mergeClaim(
    fromAccountId: string,
    intoAccountId: string,
  ): Promise<PlatformPolicyClaimMergeResult> {
    if (
      !ACCOUNT_ID_PATTERN.test(fromAccountId) ||
      !ACCOUNT_ID_PATTERN.test(intoAccountId)
    ) {
      throw new Error("invalid_account_id");
    }
    if (fromAccountId === intoAccountId) {
      const claim = await this.getClaim(intoAccountId);
      return { claim, sourceClaimReplaced: false };
    }
    return this.mutate((file) => {
      const source = file.claims[fromAccountId];
      delete file.claims[fromAccountId];
      const target = file.claims[intoAccountId];
      if (source === undefined) {
        return {
          claim: target === undefined ? null : { ...target },
          sourceClaimReplaced: false,
        };
      }
      if (target === undefined) {
        file.claims[intoAccountId] = { ...source };
        return { claim: { ...source }, sourceClaimReplaced: false };
      }
      if (target.lineageSlug === source.lineageSlug) {
        return { claim: { ...target }, sourceClaimReplaced: false };
      }
      return { claim: { ...target }, sourceClaimReplaced: true };
    });
  }

  private async mutate<T>(mutator: (file: ClaimStoreFile) => T): Promise<T> {
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

  private async load(): Promise<ClaimStoreFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const result = claimStoreFileSchema.safeParse(parsed);
      if (result.success) return result.data;
      throw new Error(
        `Platform policy claim store is unreadable at ${this.filePath} — refusing to start empty and overwrite it`,
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
    return { schemaVersion: SCHEMA_VERSION, claims: {} };
  }

  private async save(file: ClaimStoreFile): Promise<void> {
    const root = path.dirname(this.filePath);
    const temporaryPath = path.join(
      root,
      `.${CLAIM_STORE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    await fs.writeFile(temporaryPath, JSON.stringify(file), { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
  }
}
