/**
 * Betting's half of the platform handoff — replaces the old direct
 * "Sign in with GitHub" flow (`ReplayPremiereGithubAuth.ts`, removed): the
 * platform (`app.proxywar.xyz`) is now the sole account authority, so
 * betting never talks to GitHub itself. Two routes:
 *
 * - `GET /api/premieres/auth/handoff/start` — mints a short-lived,
 *   HMAC-signed state-binding cookie (reusing
 *   `ReplayPremiereGuestSecurity.mintLinkIntentCookie`, exactly the same
 *   primitive the old GitHub flow used for its own `state=` binding) and
 *   redirects the browser to the platform's `/handoff/start`.
 * - `GET /api/premieres/auth/handoff/callback` — the platform redirects
 *   back here with `?code=&state=`. Verifies the state-binding cookie,
 *   redeems the code server-to-server (`PlatformHandoffClient`), then
 *   links/merges the resulting platform account onto this browser's
 *   canonical participant (`BettingPlatformAccountLinkStore`) — closing
 *   the same two-tab Sybil race the old flow closed, via the SAME
 *   `retireForIdentityLinkIfSafe`/`releaseIdentityLinkRetirement` guard on
 *   `ReplayPremiereInteractions` (unrelated to what triggers the merge).
 *   The redemption response also carries the account's private, self-
 *   asserted lineage claim SET (possibly empty), cached alongside
 *   `platformAccountId` / `displayName` — see
 *   `BettingPlatformAccountLinkStore`. This is betting's OWN local copy
 *   for a same-origin authenticated read (`GET /api/premieres/account`'s
 *   `identity.claims`); it goes stale the moment the user changes a
 *   claim on the platform and is refreshed only by running this handoff
 *   again (the next sign-in), never treated as a live platform query. A
 *   guest who never links stays claim-free with zero extra requests —
 *   no failed fetch, no console noise.
 *
 * Also mounts `/api/identity/status` (betting's side of the origin-
 * agnostic identity-status contract `GithubSignIn.ts` relies on — see
 * `PlatformAccountHttp.ts`'s sibling route for the platform's side).
 *
 * GitHub — and now the platform — is never in the path of a trade:
 * nothing here is on the order/settlement path, and every handler fails
 * closed with a redirect/JSON error, never a thrown 500.
 */
import express, { type Request, type Response, type Router } from "express";
import type { BettingPlatformAccountLinkStore } from "./points/BettingPlatformAccountLinkStore";
import type { PlatformHandoffClient } from "./PlatformHandoffClient";
import { requestSecurityHeaders } from "./ReplayPremiereHttp";
import type { ReplayPremiereGuestSecurity } from "./ReplayPremiereGuestSecurity";

export const BETTING_HANDOFF_START_PATH =
  "/api/premieres/auth/handoff/start" as const;
export const BETTING_HANDOFF_CALLBACK_PATH =
  "/api/premieres/auth/handoff/callback" as const;
export const BETTING_HANDOFF_AUDIENCE = "betting" as const;

/**
 * Narrow, duck-typed slice of `ReplayPremiereInteractions` — identical
 * shape and purpose to the guard the old GitHub-direct flow used, only
 * renamed away from that file. See `ReplayPremiereInteractions.
 * retireForIdentityLinkIfSafe`'s doc for the exact Sybil scenario this
 * closes.
 */
export interface BettingCurrentMarketIdentityGuard {
  retireForIdentityLinkIfSafe(participantId: string): Promise<{ safe: boolean }>;
  releaseIdentityLinkRetirement(participantId: string): Promise<void>;
}

export interface BettingIdentityHandoffRouterOptions {
  readonly security: ReplayPremiereGuestSecurity;
  readonly linkStore: BettingPlatformAccountLinkStore;
  readonly handoffClient: PlatformHandoffClient;
  /** e.g. `https://app.proxywar.xyz` — MUST be one of the platform's own configured return origins for the `betting` audience. */
  readonly platformOrigin: string;
  /** This origin, exactly as the platform's allowlist has it — sent as `returnOrigin` on both halves so the platform can verify it was never reflected from client input. */
  readonly ownOrigin: string;
  readonly returnPath?: string;
  readonly resolveCurrentMarketIdentityGuard: () => BettingCurrentMarketIdentityGuard | null;
  readonly onOperatorError?: (operatorCode: string, error: unknown) => void;
}

export function createBettingIdentityHandoffRouter(
  options: BettingIdentityHandoffRouterOptions,
): Router {
  const router = express.Router();
  const returnPath = options.returnPath ?? "/bet";
  const logError = options.onOperatorError ?? ((): void => {});

  router.get(BETTING_HANDOFF_START_PATH, (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    try {
      const guest = options.security.bootstrapRead(requestSecurityHeaders(req));
      const { cookie: intentCookie, nonce } = options.security.mintLinkIntentCookie(
        guest.participant.participantId,
      );
      const setCookies =
        guest.setCookie === null ? [intentCookie] : [intentCookie, guest.setCookie];
      res.setHeader("Set-Cookie", setCookies);
      const target = new URL("/handoff/start", options.platformOrigin);
      target.searchParams.set("audience", BETTING_HANDOFF_AUDIENCE);
      target.searchParams.set("state", nonce);
      target.searchParams.set("returnPath", BETTING_HANDOFF_CALLBACK_PATH);
      target.searchParams.set("childSessionId", guest.participant.participantId);
      res.redirect(302, target.toString());
    } catch (error) {
      logError("betting_handoff_start_failed", error);
      res.redirect(302, `${returnPath}?identity=error`);
    }
  });

  router.get(
    BETTING_HANDOFF_CALLBACK_PATH,
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      const failClosed = (operatorCode: string, error?: unknown): void => {
        logError(operatorCode, error ?? new Error(operatorCode));
        res.setHeader("Set-Cookie", options.security.clearLinkIntentCookieHeader());
        res.redirect(302, `${returnPath}?identity=error`);
      };
      const failActiveTrade = (): void => {
        logError(
          "betting_handoff_active_market_participation",
          new Error("betting_handoff_active_market_participation"),
        );
        res.setHeader("Set-Cookie", options.security.clearLinkIntentCookieHeader());
        res.redirect(302, `${returnPath}?identity=active_trade`);
      };
      let marketGuard: BettingCurrentMarketIdentityGuard | null = null;
      let retiredParticipantId: string | null = null;
      try {
        const guest = options.security.identifyGuest(req.headers.cookie);
        if (guest === null) {
          failClosed("betting_handoff_no_guest_cookie");
          return;
        }
        const linkIntent = options.security.verifyLinkIntentCookie(
          req.headers.cookie,
          guest.participantId,
        );
        const state = typeof req.query.state === "string" ? req.query.state : null;
        const code = typeof req.query.code === "string" ? req.query.code : null;
        if (linkIntent === null) {
          failClosed("betting_handoff_intent_missing_or_expired");
          return;
        }
        if (state === null || state !== linkIntent.nonce) {
          failClosed("betting_handoff_state_mismatch");
          return;
        }
        if (code === null) {
          failClosed("betting_handoff_code_missing");
          return;
        }
        // Closes the two-tab Sybil race BEFORE the redeem round trip —
        // see `ReplayPremiereInteractions.retireForIdentityLinkIfSafe`.
        marketGuard = options.resolveCurrentMarketIdentityGuard();
        if (marketGuard !== null) {
          const { safe } = await marketGuard.retireForIdentityLinkIfSafe(
            guest.participantId,
          );
          if (!safe) {
            failActiveTrade();
            return;
          }
          retiredParticipantId = guest.participantId;
        }
        const redemption = await options.handoffClient.redeem({
          code,
          state,
          returnOrigin: options.ownOrigin,
          audience: BETTING_HANDOFF_AUDIENCE,
          childSessionId: guest.participantId,
        });
        if (!redemption.ok) {
          failClosed(`betting_handoff_redeem_${redemption.reason}`);
          return;
        }
        let result: {
          canonicalParticipantId: string;
          merged: boolean;
        };
        try {
          result = await options.linkStore.linkOrMerge(guest.participantId, {
            platformAccountId: redemption.accountId,
            displayName: redemption.displayName,
            claims: redemption.claims,
          });
        } catch (error) {
          failClosed("betting_handoff_link_failed", error);
          return;
        }
        if (result.canonicalParticipantId === guest.participantId) {
          if (marketGuard !== null && retiredParticipantId !== null) {
            await marketGuard.releaseIdentityLinkRetirement(retiredParticipantId);
          }
        }
        retiredParticipantId = null;
        res.setHeader("Set-Cookie", [
          options.security.clearLinkIntentCookieHeader(),
          options.security.mintGuestCookieForParticipant(result.canonicalParticipantId),
        ]);
        res.redirect(302, `${returnPath}?identity=linked`);
      } catch (error) {
        failClosed("betting_handoff_callback_failed", error);
      } finally {
        if (marketGuard !== null && retiredParticipantId !== null) {
          try {
            await marketGuard.releaseIdentityLinkRetirement(retiredParticipantId);
          } catch (releaseError) {
            logError("betting_handoff_retirement_release_failed", releaseError);
          }
        }
      }
    },
  );

  return router;
}

export interface BettingIdentityStatusRouterOptions {
  readonly security: ReplayPremiereGuestSecurity;
  readonly linkStore: BettingPlatformAccountLinkStore;
  readonly handoffAvailable: boolean;
  readonly onOperatorError?: (operatorCode: string, error: unknown) => void;
}

/** Betting's side of the origin-agnostic `/api/identity/status` contract — see `PlatformAccountHttp.ts`'s sibling route on the platform. */
export function createBettingIdentityStatusRouter(
  options: BettingIdentityStatusRouterOptions,
): Router {
  const router = express.Router();
  const logError = options.onOperatorError ?? ((): void => {});
  router.get("/api/identity/status", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    try {
      const guest = options.security.bootstrapRead(requestSecurityHeaders(req));
      if (guest.setCookie !== null) res.setHeader("Set-Cookie", guest.setCookie);
      const status = await options.linkStore.getStatus(guest.participant.participantId);
      res.status(200).json({
        schemaVersion: 1,
        identity: {
          signedIn: status.linked,
          displayName: status.displayName,
          githubLogin: null,
          githubAvatarUrl: null,
        },
        signInUrl: options.handoffAvailable ? BETTING_HANDOFF_START_PATH : null,
      });
    } catch (error) {
      logError("betting_identity_status_failed", error);
      res.status(503).json({ error: { code: "PREMIERE_UNAVAILABLE" } });
    }
  });
  return router;
}
