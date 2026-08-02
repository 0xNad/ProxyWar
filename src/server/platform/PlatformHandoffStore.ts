/**
 * The handoff's opaque-code issuance and redemption — the mechanism a
 * child app (betting, later the league) uses to learn who the platform
 * thinks the user is, per the contract:
 *
 *   1. Child redirects the user to the platform with a `state` it
 *      generated and its return URL.
 *   2. Platform authenticates/recognises the user, then redirects back
 *      with a short-lived opaque code — a random identifier, NEVER a
 *      signed token carrying claims.
 *   3. The code is bound at issue time to: the `state`, the exact
 *      allowlisted return origin, an audience naming the child app, and
 *      the child's guest/session id.
 *   4. Child redeems it server-to-server against the platform, exactly
 *      once, atomically consumed on redemption.
 *
 * In-memory only, deliberately: a code lives at most `ttlMs` (minutes),
 * far shorter than a process restart cadence matters for — losing an
 * in-flight code on a restart just means the rare unlucky sign-in click
 * has to be retried, not a durability bug. Unlike account/claim/link
 * data, there is nothing here worth persisting across a restart.
 *
 * Atomicity: `redeemCode` is fully synchronous — no `await` anywhere in
 * its body — so the check-then-delete on `codes` can never be interleaved
 * by another turn of the event loop, regardless of how many concurrent
 * `Promise.all`-driven callers race to redeem the same code. Exactly one
 * caller observes the record and deletes it; every other caller (even one
 * that started reading the map in the "same" tick) finds it already gone
 * and gets `already_redeemed`.
 */
import { randomBytes } from "node:crypto";

const CODE_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_TTL_MS = 2 * 60 * 1_000;
const MAX_FIELD_LENGTH = 512;

export interface PlatformHandoffClaim {
  readonly lineageSlug: string;
  readonly label: string;
}

export interface PlatformHandoffIssueInput {
  readonly state: string;
  readonly returnOrigin: string;
  readonly audience: string;
  readonly childSessionId: string;
  readonly accountId: string;
  readonly displayName: string | null;
  /**
   * The account's private, self-asserted lineage claim SET — the SAME
   * shape `GET /api/account` exposes to the platform's own client.
   * Handed to the child so a same-origin default (e.g. replay
   * point-of-view) can work on origins that can never reach the
   * platform's own host-only cookie cross-origin. Still private and
   * self-asserted once it lands in the child: never surfaced on any
   * public route, profile, or leaderboard there either — see
   * `BettingPlatformAccountLinkStore`'s doc. Empty, never omitted, for an
   * account with nothing claimed.
   */
  readonly claims: readonly PlatformHandoffClaim[];
}

export interface PlatformHandoffIssued {
  readonly code: string;
  readonly expiresAt: string;
}

export interface PlatformHandoffRedeemRequest {
  readonly code: string;
  readonly state: string;
  readonly returnOrigin: string;
  readonly audience: string;
  readonly childSessionId: string;
}

export type PlatformHandoffRedeemFailureReason =
  | "invalid_code"
  | "expired"
  | "already_redeemed"
  | "state_mismatch"
  | "origin_mismatch"
  | "audience_mismatch"
  | "session_mismatch";

export type PlatformHandoffRedeemResult =
  | {
      readonly ok: true;
      readonly accountId: string;
      readonly displayName: string | null;
      readonly claims: readonly PlatformHandoffClaim[];
    }
  | { readonly ok: false; readonly reason: PlatformHandoffRedeemFailureReason };

interface HandoffRecord extends PlatformHandoffIssueInput {
  readonly expiresAtMs: number;
}

function withinFieldLimits(input: PlatformHandoffIssueInput): boolean {
  return (
    input.state.length > 0 &&
    input.state.length <= MAX_FIELD_LENGTH &&
    input.returnOrigin.length > 0 &&
    input.returnOrigin.length <= MAX_FIELD_LENGTH &&
    input.audience.length > 0 &&
    input.audience.length <= MAX_FIELD_LENGTH &&
    input.childSessionId.length > 0 &&
    input.childSessionId.length <= MAX_FIELD_LENGTH
  );
}

export class PlatformHandoffStore {
  private readonly codes = new Map<string, HandoffRecord>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /** Synchronous by design — see the class doc's atomicity section. */
  issueCode(input: PlatformHandoffIssueInput): PlatformHandoffIssued {
    if (!withinFieldLimits(input)) {
      throw new Error("invalid_handoff_issue_input");
    }
    this.sweepExpired();
    const code = randomBytes(32).toString("hex");
    const expiresAtMs = this.now() + this.ttlMs;
    this.codes.set(code, { ...input, expiresAtMs });
    return { code, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  /** Synchronous by design — see the class doc's atomicity section. Every check happens before the single mutating `delete`, and the delete is the ONLY mutation, so a caller either gets the full, correct record or a clean rejection; there is no partially-consumed state. */
  redeemCode(request: PlatformHandoffRedeemRequest): PlatformHandoffRedeemResult {
    if (!CODE_PATTERN.test(request.code)) {
      return { ok: false, reason: "invalid_code" };
    }
    const record = this.codes.get(request.code);
    if (record === undefined) {
      return { ok: false, reason: "invalid_code" };
    }
    if (record.expiresAtMs <= this.now()) {
      this.codes.delete(request.code);
      return { ok: false, reason: "expired" };
    }
    if (record.state !== request.state) {
      return { ok: false, reason: "state_mismatch" };
    }
    if (record.returnOrigin !== request.returnOrigin) {
      return { ok: false, reason: "origin_mismatch" };
    }
    if (record.audience !== request.audience) {
      return { ok: false, reason: "audience_mismatch" };
    }
    if (record.childSessionId !== request.childSessionId) {
      return { ok: false, reason: "session_mismatch" };
    }
    // Every binding matched — consume now, atomically (see class doc).
    this.codes.delete(request.code);
    return {
      ok: true,
      accountId: record.accountId,
      displayName: record.displayName,
      claims: record.claims,
    };
  }

  /** Opportunistic cleanup on every issuance — bounds memory for a long-running process without a timer to manage; a code nobody ever tries to redeem simply ages out on the next unrelated issuance instead of lingering forever. */
  private sweepExpired(): void {
    const nowMs = this.now();
    for (const [code, record] of this.codes) {
      if (record.expiresAtMs <= nowMs) this.codes.delete(code);
    }
  }
}
