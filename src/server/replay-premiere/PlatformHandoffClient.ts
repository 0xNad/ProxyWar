/**
 * Betting's server-to-server call to the platform's
 * `POST /api/account/handoff/redeem` — the child half of the handoff (see
 * `PlatformHandoffStore`'s doc for the full protocol). Only ever called
 * from `BettingIdentityHandoff.ts`'s callback route, itself only ever hit
 * on an explicit "Sign in" click — never on an ordinary page load, and
 * never on the order/settlement path. A platform that is down, slow, or
 * unreachable degrades ONLY sign-in: every existing identity keeps
 * trading exactly as it already was (see the contract: "Platform down:
 * betting trades, settles and ranks normally. The account authority is
 * never in the path of a trade").
 */
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 5_000;

export interface PlatformHandoffRedeemRequest {
  readonly code: string;
  readonly state: string;
  readonly returnOrigin: string;
  readonly audience: string;
  readonly childSessionId: string;
}

const redeemClaimSchema = z.object({ lineageSlug: z.string(), label: z.string() });

const redeemSuccessSchema = z.object({
  accountId: z.string(),
  displayName: z.string().nullable(),
  claim: redeemClaimSchema.nullable(),
});

const redeemErrorSchema = z.object({ error: z.object({ code: z.string() }) });

export interface PlatformHandoffClaim {
  readonly lineageSlug: string;
  readonly label: string;
}

export type PlatformHandoffClientResult =
  | {
      readonly ok: true;
      readonly accountId: string;
      readonly displayName: string | null;
      /**
       * The account's private, self-asserted lineage claim, or `null` —
       * cached by the caller (`BettingPlatformAccountLinkStore`)
       * alongside `platformAccountId`. Refreshed on every handoff, so it
       * goes stale exactly as long as the last sign-in is old; a caller
       * needing a fresher read must run the handoff again, never treat
       * this as a live platform query.
       */
      readonly claim: PlatformHandoffClaim | null;
    }
  | { readonly ok: false; readonly reason: string };

/** Injectable so tests can stub the platform without a real second server. */
export interface PlatformHandoffClient {
  redeem(request: PlatformHandoffRedeemRequest): Promise<PlatformHandoffClientResult>;
}

export function createPlatformHandoffClient(
  platformOrigin: string,
  fetchTimeoutMs: number = DEFAULT_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): PlatformHandoffClient {
  return {
    async redeem(request) {
      try {
        const response = await fetchImpl(
          `${platformOrigin}/api/account/handoff/redeem`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(fetchTimeoutMs),
          },
        );
        const body: unknown = await response.json().catch(() => null);
        if (response.ok) {
          const parsed = redeemSuccessSchema.safeParse(body);
          if (!parsed.success) return { ok: false, reason: "malformed_response" };
          return {
            ok: true,
            accountId: parsed.data.accountId,
            displayName: parsed.data.displayName,
            claim: parsed.data.claim,
          };
        }
        const parsedError = redeemErrorSchema.safeParse(body);
        return {
          ok: false,
          reason: parsedError.success ? parsedError.data.error.code : `http_${response.status}`,
        };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : "network_error",
        };
      }
    },
  };
}
