/**
 * Durable store for a self-asserted "this league agent is mine" claim, one
 * per canonical guest `participantId`. This is NOT an identity link like
 * `ReplayPremiereIdentityLinkStore` — there is no cryptographic or
 * platform-verified proof that a browser's guest identity actually owns a
 * given league `playerName` (GitHub hands us an `id`/`login`; the league
 * mirror identifies competitors by `playerName`; nothing joins the two).
 * The claim is exactly what a participant typed into a dropdown, kept
 * PRIVATE to their own account page — never surfaced on the points
 * leaderboard, in a premiere, or anywhere another participant can read it
 * (see the account route in `ai-agent-demo-server.ts`, which never joins
 * this store into any public response).
 *
 * Beside the points ledger and identity link store: same root (outside the
 * premiere private state root that `cycle-premiere.sh` wipes every cycle —
 * see `ReplayPremierePointsLedger`'s doc for why), same atomic
 * write-temp-then-rename convention, its own file
 * (`league-claims-v1.json`).
 *
 * Merge-aware across a GitHub link, the same way points are
 * (`ReplayPremierePointsLedger.mergeParticipant`), but with a DIFFERENT
 * reconciliation rule — see {@link ReplayPremiereLeagueClaimStore.mergeClaim}.
 * Points sum both sides because money is fungible and cherry-picking which
 * side's contribution survives is exploitable; a claim is a single,
 * unverified, unscored choice, so "keep the canonical side's, deterministic
 * and explainable" is correct here instead — never blocks the identity
 * link either way (a claim costs one click to re-pick, so refusing an
 * account merge over a claim conflict would be wildly disproportionate).
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

const PARTICIPANT_ID_PATTERN = /^guest_[a-f0-9]{32}$/;
const CLAIM_STORE_FILE_NAME = "league-claims-v1.json";
const SCHEMA_VERSION = 1 as const;
const MAX_PLAYER_NAME_CODEPOINTS = 80;

/**
 * Outcome of folding one participant's claim into another's, per
 * {@link ReplayPremiereLeagueClaimStore.mergeClaim}'s reconciliation rule.
 */
export interface ReplayPremiereLeagueClaimMergeResult {
  /** The resulting claim at `intoParticipantId` after the merge — `null` if neither side had one. */
  readonly claim: ReplayPremiereLeagueClaimView | null;
  /** True iff BOTH sides had a claim, for DIFFERENT players, so the source's was discarded in favor of the target's — the caller can surface this ("your claim on this browser was replaced by the one on your linked account"). False for every other case, including a same-player no-op. */
  readonly sourceClaimReplaced: boolean;
}

export interface ReplayPremiereLeagueClaimView {
  readonly playerName: string;
  readonly claimedAt: string;
  readonly updatedAt: string;
}

const storedClaimSchema = z.object({
  playerName: z.string().min(1),
  claimedAt: z.string(),
  updatedAt: z.string(),
});
type StoredClaim = z.infer<typeof storedClaimSchema>;

const claimStoreFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  claims: z.record(z.string().regex(PARTICIPANT_ID_PATTERN), storedClaimSchema),
});
type ClaimStoreFile = z.infer<typeof claimStoreFileSchema>;

/**
 * Same sanitization discipline as `ReplayPremierePointsLedger`'s display
 * name: collapse whitespace first (so a tab/newline becomes a space
 * instead of gluing two words together once control characters are
 * stripped), then drop invisible control/format characters, trim, and cap
 * length in code points (never UTF-16 units). Returns `null` for a blank
 * result — the caller treats that as "clear the claim", matching the
 * display-name endpoint's own convention.
 */
function sanitizePlayerName(raw: string): string | null {
  const stripped = raw
    .replace(/\s+/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  if (stripped.length === 0) return null;
  const codePoints = Array.from(stripped);
  return codePoints.length > MAX_PLAYER_NAME_CODEPOINTS
    ? codePoints.slice(0, MAX_PLAYER_NAME_CODEPOINTS).join("")
    : stripped;
}

export class ReplayPremiereLeagueClaimStore {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(root: string) {
    this.filePath = path.join(root, CLAIM_STORE_FILE_NAME);
  }

  static async open(root: string): Promise<ReplayPremiereLeagueClaimStore> {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    return new ReplayPremiereLeagueClaimStore(root);
  }

  async getClaim(
    participantId: string,
  ): Promise<ReplayPremiereLeagueClaimView | null> {
    if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
      throw new Error(`invalid_participant_id: ${participantId}`);
    }
    const file = await this.load();
    const stored = file.claims[participantId];
    return stored === undefined ? null : { ...stored };
  }

  /**
   * Sets (or, given a blank/whitespace-only name, clears) the claim.
   * `claimedAt` is preserved across an edit that changes which player is
   * claimed — re-picking a different agent is still "when this
   * participant first told us they own a league agent", not a fresh
   * claim, so a later verified-ownership feature can see how long a claim
   * has stood without a player-name change resetting that clock.
   */
  async setClaim(
    participantId: string,
    rawPlayerName: string,
  ): Promise<ReplayPremiereLeagueClaimView | null> {
    if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
      throw new Error(`invalid_participant_id: ${participantId}`);
    }
    const playerName = sanitizePlayerName(rawPlayerName);
    return this.mutate((file) => {
      if (playerName === null) {
        delete file.claims[participantId];
        return null;
      }
      const nowIso = new Date().toISOString();
      const existing = file.claims[participantId];
      const claim: StoredClaim = {
        playerName,
        claimedAt: existing?.claimedAt ?? nowIso,
        updatedAt: nowIso,
      };
      file.claims[participantId] = claim;
      return { ...claim };
    });
  }

  async clearClaim(participantId: string): Promise<void> {
    if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
      throw new Error(`invalid_participant_id: ${participantId}`);
    }
    await this.mutate((file) => {
      delete file.claims[participantId];
    });
  }

  /**
   * Folds `fromParticipantId`'s claim into `intoParticipantId`'s on a
   * GitHub link/merge — see {@link ReplayPremiereLeagueClaimMergeResult}
   * for the reconciliation rule. Idempotent: a retried merge for the same
   * pair re-observes an already-emptied source (or an already-settled
   * target) and returns the same outcome without changing anything.
   */
  async mergeClaim(
    fromParticipantId: string,
    intoParticipantId: string,
  ): Promise<ReplayPremiereLeagueClaimMergeResult> {
    if (
      !PARTICIPANT_ID_PATTERN.test(fromParticipantId) ||
      !PARTICIPANT_ID_PATTERN.test(intoParticipantId)
    ) {
      throw new Error("invalid_participant_id");
    }
    if (fromParticipantId === intoParticipantId) {
      const claim = await this.getClaim(intoParticipantId);
      return { claim, sourceClaimReplaced: false };
    }
    return this.mutate((file) => {
      const source = file.claims[fromParticipantId];
      delete file.claims[fromParticipantId];
      const target = file.claims[intoParticipantId];
      if (source === undefined) {
        // Source has none — keep the target's (possibly also none).
        return {
          claim: target === undefined ? null : { ...target },
          sourceClaimReplaced: false,
        };
      }
      if (target === undefined) {
        // Target has none — carry the source's claim over verbatim,
        // including its original `claimedAt`.
        file.claims[intoParticipantId] = { ...source };
        return { claim: { ...source }, sourceClaimReplaced: false };
      }
      if (target.playerName === source.playerName) {
        // Same player claimed on both sides — no-op, target already
        // holds it.
        return { claim: { ...target }, sourceClaimReplaced: false };
      }
      // Different players — the canonical target's claim wins,
      // deterministically; the source's is dropped and reported.
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
      // Readable but not the shape we wrote — refuse to start empty and
      // silently overwrite every existing claim on the next save (same
      // discipline as `ReplayPremiereIdentityLinkStore.load`).
      throw new Error(
        `Replay Premiere league claim store is unreadable at ${this.filePath} — refusing to start empty and overwrite it`,
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

/**
 * A `ReplayPremiereLeagueClaimMerger`-compatible view over a real
 * `ReplayPremiereLeagueClaimStore` — mirrors `pointsMergerFor`
 * (`ReplayPremiereIdentityLinkStore.ts`) so that store never needs to
 * import this one's concrete class, only the duck-typed interface it
 * declares locally.
 */
export function leagueClaimMergerFor(
  store: ReplayPremiereLeagueClaimStore,
): { mergeClaim: ReplayPremiereLeagueClaimStore["mergeClaim"] } {
  return { mergeClaim: store.mergeClaim.bind(store) };
}
