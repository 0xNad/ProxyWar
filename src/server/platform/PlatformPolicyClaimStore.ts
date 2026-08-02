/**
 * Durable store for a self-asserted "these league model lineages are
 * mine" claim SET, one per canonical platform `accountId`. Platform-owned
 * per the contract: "Claims cover all of a user's models and policies,
 * not one `playerName`. A person owns a lineage — `daveey-proxywar:v24`
 * and everything before it." — and, per the operator directly, "accounts
 * are for all model": a person can own MORE THAN ONE lineage (plus,
 * potentially, unrelated policies), so an account claims a SET, not a
 * single slot. Claiming a second lineage never discards the first.
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
 * Each account's claims are keyed by `lineageSlug`: `addClaim` on a
 * lineage already in the set updates that ONE entry in place (refreshing
 * `label`, preserving `claimedAt` — same "re-pick keeps provenance"
 * reasoning the old single-claim store had), never appends a duplicate.
 * `removeClaim` takes one lineage back out without touching any other.
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

/** One account's claim SET, keyed by `lineageSlug` — see this module's doc. */
const storedClaimSetSchema = z.record(z.string().min(1), storedClaimSchema);
type StoredClaimSet = z.infer<typeof storedClaimSetSchema>;

/** On-disk file shape. Not a zod schema: the top-level shape is checked manually in `loadDetailed` (see its doc for why — a per-account legacy/current fallback needs finer control than one flat `.safeParse` gives). */
interface ClaimStoreFile {
  schemaVersion: typeof SCHEMA_VERSION;
  claims: Record<string, StoredClaimSet>;
}

export interface PlatformPolicyClaimMergeResult {
  readonly claims: readonly PlatformPolicyClaimView[];
}

/** Same sanitization discipline as `ReplayPremiereLeagueClaimStore`'s: collapse whitespace, drop invisible control/format characters, trim, cap length in code points. `null` means "blank — not a valid label to add". */
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

/** Deterministic, stable order for a claim SET: earliest `claimedAt` first (the longest-standing claim leads), tie-broken by `lineageSlug`. Callers that need "the viewer's primary lineage" (e.g. the replay PoV default) can rely on index 0 of this order without re-sorting themselves. */
function sortClaims(claims: Iterable<StoredClaim>): PlatformPolicyClaimView[] {
  return [...claims]
    .sort((a, b) =>
      a.claimedAt === b.claimedAt
        ? a.lineageSlug.localeCompare(b.lineageSlug)
        : a.claimedAt.localeCompare(b.claimedAt),
    )
    .map((claim) => ({ ...claim }));
}

export class PlatformPolicyClaimStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(root: string) {
    this.filePath = path.join(root, CLAIM_STORE_FILE_NAME);
  }

  static async open(root: string): Promise<PlatformPolicyClaimStore> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const instance = new PlatformPolicyClaimStore(root);
    // Forward-migrate a legacy on-disk file (one bare `StoredClaim` per
    // account, from before an account could claim more than one lineage)
    // once, deterministically, before the instance is ever handed to a
    // request handler — same convention as
    // `ReplayPremierePointsLedger.open()`'s `settledPremiereIds` ->
    // `premiereResults` migration. A no-op for an already-current file,
    // and for a freshly-created empty one.
    const { file, migrated } = await instance.loadDetailed();
    if (migrated) await instance.save(file);
    return instance;
  }

  /** All of `accountId`'s claimed lineages, oldest-claimed first (see `sortClaims`). Empty, never `null`, for an account with nothing claimed. */
  async getClaims(accountId: string): Promise<readonly PlatformPolicyClaimView[]> {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error(`invalid_account_id: ${accountId}`);
    }
    const file = await this.load();
    const set = file.claims[accountId];
    return set === undefined ? [] : sortClaims(Object.values(set));
  }

  /**
   * Adds (or, for a lineage slug already in the set, updates) one claim.
   * `claimedAt` is preserved across an update that changes the exact
   * `label` for an already-claimed lineage — see
   * `ReplayPremiereLeagueClaimStore.setClaim`'s identical reasoning — but
   * a NEW lineage slug always gets a fresh `claimedAt`, since it's a
   * genuinely new claim, not an edit of an existing one.
   *
   * Throws `invalid_claim_label` for a blank/whitespace-only label:
   * unlike the old single-claim `setClaim`, blank no longer means "clear
   * everything" — that's `removeClaim`'s job now, one lineage at a time.
   */
  async addClaim(
    accountId: string,
    rawLabel: string,
  ): Promise<readonly PlatformPolicyClaimView[]> {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error(`invalid_account_id: ${accountId}`);
    }
    const label = sanitizeLabel(rawLabel);
    if (label === null) {
      throw new Error("invalid_claim_label");
    }
    return this.mutate((file) => {
      const lineageSlug = deriveLineageSlug(label);
      const existingSet = file.claims[accountId] ?? {};
      const existingClaim = existingSet[lineageSlug];
      const nowIso = new Date().toISOString();
      const claim: StoredClaim = {
        lineageSlug,
        label,
        claimedAt: existingClaim?.claimedAt ?? nowIso,
        updatedAt: nowIso,
      };
      file.claims[accountId] = { ...existingSet, [lineageSlug]: claim };
      return sortClaims(Object.values(file.claims[accountId]));
    });
  }

  /** Removes one lineage from `accountId`'s claim set, if present — a no-op (never an error) if it isn't. Returns the resulting set. */
  async removeClaim(
    accountId: string,
    lineageSlug: string,
  ): Promise<readonly PlatformPolicyClaimView[]> {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error(`invalid_account_id: ${accountId}`);
    }
    return this.mutate((file) => {
      const existingSet = file.claims[accountId];
      if (existingSet === undefined || !(lineageSlug in existingSet)) {
        return sortClaims(Object.values(existingSet ?? {}));
      }
      const { [lineageSlug]: _removed, ...rest } = existingSet;
      if (Object.keys(rest).length === 0) {
        delete file.claims[accountId];
      } else {
        file.claims[accountId] = rest;
      }
      return sortClaims(Object.values(rest));
    });
  }

  /**
   * Folds `fromAccountId`'s claim set into `intoAccountId`'s on a GitHub
   * link, as a UNION — every lineage either side had claimed is present
   * on `intoAccountId` afterward, and `fromAccountId` ends with none.
   *
   * This deliberately does NOT port the old single-claim store's
   * "canonical side wins on conflict" rule: a claim SET has no conflict
   * to resolve. The only genuine collision is the SAME lineage slug
   * appearing on both sides (most likely one person who claimed it from
   * two browsers before ever linking GitHub) — for that one entry, the
   * merged record keeps the EARLIER `claimedAt` (the longest-standing
   * record of the claim survives, exactly like a same-account re-pick
   * already preserves `claimedAt`) and the fresher side's `label` /
   * `updatedAt` (whichever pick is more recent). Every other lineage is a
   * plain, lossless union — nothing is ever discarded or "replaced".
   */
  async mergeClaims(
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
      return { claims: await this.getClaims(intoAccountId) };
    }
    return this.mutate((file) => {
      const source = file.claims[fromAccountId];
      delete file.claims[fromAccountId];
      const target = file.claims[intoAccountId] ?? {};
      if (source === undefined) {
        return { claims: sortClaims(Object.values(target)) };
      }
      const unioned: StoredClaimSet = { ...target };
      for (const [lineageSlug, sourceClaim] of Object.entries(source)) {
        const targetClaim = target[lineageSlug];
        if (targetClaim === undefined) {
          unioned[lineageSlug] = sourceClaim;
          continue;
        }
        const sourceIsFresher = sourceClaim.updatedAt > targetClaim.updatedAt;
        unioned[lineageSlug] = {
          lineageSlug,
          label: sourceIsFresher ? sourceClaim.label : targetClaim.label,
          claimedAt:
            sourceClaim.claimedAt < targetClaim.claimedAt
              ? sourceClaim.claimedAt
              : targetClaim.claimedAt,
          updatedAt: sourceIsFresher ? sourceClaim.updatedAt : targetClaim.updatedAt,
        };
      }
      if (Object.keys(unioned).length > 0) {
        file.claims[intoAccountId] = unioned;
      } else {
        delete file.claims[intoAccountId];
      }
      return { claims: sortClaims(Object.values(unioned)) };
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
    return (await this.loadDetailed()).file;
  }

  /**
   * Parses the on-disk file, accepting either the current per-account
   * shape (a claim SET, keyed by `lineageSlug`) or the legacy
   * pre-2026-07-29 shape (one bare `StoredClaim`) per account — a mixed
   * file, some accounts already current and some still legacy, is
   * expected mid-rollout and handled transparently, same convention as
   * `ReplayPremierePointsLedger.loadDetailed`. `migrated` is true iff at
   * least one account needed the legacy conversion, so `open()` can
   * decide whether to persist the migrated form back to disk.
   *
   * Unlike the points ledger, this store still REFUSES to silently
   * reset to empty on anything it can't make sense of: an unparseable
   * top-level shape, or a per-account entry that matches NEITHER the
   * current nor the legacy shape, throws rather than dropping data —
   * the original store's "never quietly overwrite live claims with an
   * empty file" guarantee, preserved.
   */
  private async loadDetailed(): Promise<{ file: ClaimStoreFile; migrated: boolean }> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      return { file: { schemaVersion: SCHEMA_VERSION, claims: {} }, migrated: false };
    }
    const unreadable = (): never => {
      throw new Error(
        `Platform policy claim store is unreadable at ${this.filePath} — refusing to start empty and overwrite it`,
      );
    };
    if (typeof raw !== "object" || raw === null) unreadable();
    const top = raw as Record<string, unknown>;
    if (top.schemaVersion !== SCHEMA_VERSION) unreadable();
    if (typeof top.claims !== "object" || top.claims === null) unreadable();

    const claims: Record<string, StoredClaimSet> = {};
    let migrated = false;
    for (const [accountId, rawEntry] of Object.entries(
      top.claims as Record<string, unknown>,
    )) {
      if (!ACCOUNT_ID_PATTERN.test(accountId)) unreadable();
      const asSet = storedClaimSetSchema.safeParse(rawEntry);
      if (asSet.success) {
        claims[accountId] = asSet.data;
        continue;
      }
      const asLegacySingle = storedClaimSchema.safeParse(rawEntry);
      if (asLegacySingle.success) {
        claims[accountId] = { [asLegacySingle.data.lineageSlug]: asLegacySingle.data };
        migrated = true;
        continue;
      }
      unreadable();
    }
    return { file: { schemaVersion: SCHEMA_VERSION, claims }, migrated };
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
