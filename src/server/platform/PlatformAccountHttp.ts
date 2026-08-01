/**
 * The platform's own account API — `/api/account/*` — plus `/handoff/start`,
 * the platform half of the handoff (see `PlatformHandoffStore`'s doc for
 * the full protocol; the child half lives in
 * `src/server/replay-premiere/BettingIdentityHandoff.ts`).
 *
 * Every route here is reachable with wagering off: nothing in this file
 * reads `PROXYWAR_WAGERING_ENABLED`, imports anything from
 * `replay-premiere/wagering/`, or touches a market. Accounts working with
 * wagering off is the entire point of the re-scope — see the contract.
 */
import express, { type Request, type Response, type Router } from "express";
import { emitServerAnalyticsEvent } from "../analytics/AnalyticsServerEmit";
import { requestSecurityHeaders } from "../replay-premiere/ReplayPremiereHttp";
import type { PlatformAccountSecurity } from "./PlatformAccountSecurity";
import type { PlatformAccountStore } from "./PlatformAccountStore";
import type { PlatformGithubIdentityLinkStore } from "./PlatformGithubIdentityLinkStore";
import { PlatformHandoffStore } from "./PlatformHandoffStore";
import type { PlatformPolicyClaimStore } from "./PlatformPolicyClaimStore";
import { isValidHandoffAudience } from "./PlatformReturnOrigins";

const MAX_DISPLAY_NAME_REQUEST_BYTES = 512;
const MAX_CLAIM_LABEL_REQUEST_BYTES = 512;
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;
const CHILD_SESSION_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const RETURN_PATH_PATTERN = /^\/[A-Za-z0-9/_-]{0,256}$/;

export interface PlatformAccountHttpOptions {
  readonly security: PlatformAccountSecurity;
  readonly accounts: PlatformAccountStore;
  readonly claims: PlatformPolicyClaimStore;
  readonly identityLinkStore: PlatformGithubIdentityLinkStore;
  readonly handoffs: PlatformHandoffStore;
  /** `audience -> allowlisted return origin` — see `resolvePlatformReturnOrigins`. Never trust a client-supplied origin; this map is the only source of truth. */
  readonly returnOrigins: ReadonlyMap<string, string>;
  /**
   * Origins allowed an ambient credentialed read of `/api/account/pov-claims`
   * — see `resolvePlatformPovClaimOrigins` for why this is NOT the same list
   * as `returnOrigins`. Empty means no origin may.
   */
  readonly povClaimOrigins: ReadonlySet<string>;
  readonly githubSignInAvailable: boolean;
  /** Threaded through only for the `returning_authenticated_visitor` emission below — see that route handler's own doc for why GET /api/account is the right hook. */
  readonly artifactsRootDir: string;
  readonly onOperatorError?: (operatorCode: string, error: unknown) => void;
}

function sendFailure(res: Response, status: number, code: string): void {
  res.status(status).json({ error: { code } });
}

function stringField(
  body: unknown,
  field: string,
  maxBytes: number,
): string | null {
  if (typeof body !== "object" || body === null || !(field in body))
    return null;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : null;
}

export function createPlatformAccountRouter(
  options: PlatformAccountHttpOptions,
): Router {
  const router = express.Router();
  const logError = options.onOperatorError ?? ((): void => {});

  // `returning_authenticated_visitor` dedup: bounded, in-memory, reset on
  // UTC day rollover — mirrors the day-bucketing `AnalyticsAggregateStore.ts`
  // itself already uses, so "once per accountId per day" here lines up with
  // the aggregate's own day boundary. Best-effort only (a process restart
  // resets it, and the `MAX_DEDUP_ACCOUNT_IDS` bound means a pathologically
  // busy day could under-dedup past the cap) — acceptable for a retention
  // signal that's explicitly raw-counts-not-precision per the Season Zero
  // overinterpretation rule, and correct in the overwhelmingly common case.
  const MAX_DEDUP_ACCOUNT_IDS = 5_000;
  let dedupDayKey = new Date().toISOString().slice(0, 10);
  let dedupSeenAccountIds = new Set<string>();

  router.get("/api/account", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    try {
      const bootstrap = options.security.bootstrapRead(
        requestSecurityHeaders(req),
      );
      if (bootstrap.setCookie !== null)
        res.setHeader("Set-Cookie", bootstrap.setCookie);
      const canonicalAccountId =
        await options.identityLinkStore.resolveCanonicalAccountId(
          bootstrap.account.accountId,
        );
      // `setCookie === null` means `bootstrapRead` found an ALREADY-
      // established account cookie rather than minting a fresh one (see
      // `PlatformAccountSecurity.bootstrap`'s doc) — but that alone is NOT
      // "authenticated": every platform visitor, signed in or not, gets an
      // auto-minted GUEST account cookie on first touch, so a plain
      // returning GUEST would also satisfy `setCookie === null` on their
      // second visit. If this fired `returning_authenticated_visitor` for
      // that guest, the SAME visit would be double-counted against the
      // report's return metric — once here, once client-side via
      // `returning_anonymous_visitor` (the localStorage visitor id already
      // existed too). `returning_authenticated_visitor` therefore requires
      // BOTH signals: an already-established cookie AND a genuinely
      // GitHub-linked identity (`githubStatus.login !== null`) — "carries
      // an established, GitHub-linked platform identity", not merely "has
      // ever loaded a page here before". This is an authenticated
      // visit-DAY count, not strict per-session counting; see
      // docs/SEASON_ZERO_ANALYTICS.md.
      const [account, claims, githubStatus] = await Promise.all([
        options.accounts.getAccount(canonicalAccountId),
        options.claims.getClaims(canonicalAccountId),
        options.identityLinkStore.getStatus(canonicalAccountId),
      ]);
      if (bootstrap.setCookie === null && githubStatus.login !== null) {
        const dayKey = new Date().toISOString().slice(0, 10);
        if (dayKey !== dedupDayKey) {
          dedupDayKey = dayKey;
          dedupSeenAccountIds = new Set();
        }
        if (!dedupSeenAccountIds.has(canonicalAccountId)) {
          if (dedupSeenAccountIds.size < MAX_DEDUP_ACCOUNT_IDS) {
            dedupSeenAccountIds.add(canonicalAccountId);
          }
          void emitServerAnalyticsEvent(
            options.artifactsRootDir,
            "returning_authenticated_visitor",
          );
        }
      }
      res.status(200).json({
        schemaVersion: 1,
        csrfToken: bootstrap.csrfToken,
        identity: {
          accountId: canonicalAccountId,
          displayName: account?.displayName ?? null,
          githubLogin: githubStatus.login,
          githubAvatarUrl: githubStatus.avatarUrl,
        },
        claims,
      });
    } catch (error) {
      logError("platform_account_read_failed", error);
      sendFailure(res, 503, "PLATFORM_UNAVAILABLE");
    }
  });

  /**
   * The ONLY cross-origin-readable account route, and deliberately the
   * narrowest possible one: a sibling surface (the league mirror at
   * `beta.*`, the market at `bet.*`) needs the viewer's claimed lineage
   * slugs to default the replay camera to their own agent, and needs
   * nothing else whatsoever.
   *
   * Why not just CORS-enable `GET /api/account`? Because it returns
   * `csrfToken`. Handing that to another origin with credentials would let
   * anything executing there perform authenticated writes against this
   * account authority — it would convert a read grant into a full CSRF
   * bypass. So this route returns claims and a schema version, never the
   * CSRF token, the account id, the display name, or the GitHub identity.
   *
   * Why this works at all without weakening the session cookie: `bet.*`,
   * `beta.*` and this origin are cross-ORIGIN but same-SITE (shared
   * registrable domain), and `SameSite` is a site-level control — so the
   * host-only `SameSite=Lax` session cookie IS sent on a credentialed
   * fetch here. No `SameSite=None` is needed, and it must not be added:
   * that would expose the sole account authority to genuinely cross-site
   * requests. The corollary is that this grant does not extend to any
   * origin outside the registrable domain, cookie-wise, no matter what the
   * allowlist says.
   *
   * The allowlist is its OWN explicit list (`povClaimOrigins`), deliberately
   * NOT the handoff's `audience -> origin` map. Those are different grants:
   * a handoff return origin receives a redirect for a sign-in the viewer
   * explicitly started, whereas an origin here may read that viewer's claims
   * silently on any page load. Deriving one from the other would mean
   * registering a future handoff child quietly widened who can harvest every
   * viewer's claims — an escalation performed by config, invisible in the
   * diff. See `PlatformPovClaimOrigins.ts`. An arbitrary `Origin` is never
   * reflected, and an empty list denies everyone. `Vary: Origin` is
   * mandatory — without it a shared cache could serve one origin's allow
   * header to another.
   *
   * A GET carrying only `Accept` triggers no preflight (both are CORS-
   * safelisted), so there is deliberately no `OPTIONS` handler here; adding
   * a request header later would need one.
   */
  router.get("/api/account/pov-claims", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    // Mandatory, and mandatory even on the paths that set no allow header:
    // a shared cache keying on URL alone could otherwise hand one origin's
    // `Access-Control-Allow-Origin` to a different origin.
    res.setHeader("Vary", "Origin");
    const empty = { schemaVersion: 1, lineageSlugs: [] as readonly string[] };
    const requestOrigin = req.headers.origin;
    if (typeof requestOrigin === "string" && requestOrigin !== "") {
      if (!options.povClaimOrigins.has(requestOrigin)) {
        // A cross-origin caller we do not allowlist. The browser would
        // withhold the body anyway for want of an allow header, but do not
        // lean on that: read no cookie and disclose nothing. Answering 200
        // with an empty set rather than 403 keeps this off the error path —
        // it is a camera default, and a same-site sibling probing it learns
        // only that it exists.
        res.status(200).json(empty);
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    try {
      // Origin duty is discharged above, which is the precondition this
      // method documents. It also does NOT mint on a cookieless request —
      // a league visitor who has never touched the platform must not walk
      // away with a freshly created empty account.
      const account = options.security.readEstablishedAccountWithoutOriginCheck(
        req.headers.cookie,
      );
      if (account === null) {
        res.status(200).json(empty);
        return;
      }
      const canonicalAccountId =
        await options.identityLinkStore.resolveCanonicalAccountId(
          account.accountId,
        );
      const claims = await options.claims.getClaims(canonicalAccountId);
      // Slugs only. `label` is user-supplied free text and the timestamps
      // are nobody else's business; the consumer matches on `lineageSlug`
      // alone (see `findPlayerForClaimedLineages`), so anything more would
      // be disclosure without a caller.
      res.status(200).json({
        schemaVersion: 1,
        lineageSlugs: claims.map((claim) => claim.lineageSlug),
      });
    } catch (error) {
      logError("platform_pov_claims_read_failed", error);
      // A camera default is not worth a 503 the caller must special-case:
      // "no claims" is already the overwhelmingly common answer, and the
      // picker has a neutral default for it.
      res.status(200).json(empty);
    }
  });

  router.post(
    "/api/account/display-name",
    express.json({ limit: "8kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const authorization = options.security.authorizeWrite(
          requestSecurityHeaders(req),
        );
        const displayName = stringField(
          req.body,
          "displayName",
          MAX_DISPLAY_NAME_REQUEST_BYTES,
        );
        if (displayName === null) {
          sendFailure(res, 400, "PLATFORM_INVALID_REQUEST");
          return;
        }
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            authorization.account.accountId,
          );
        const account = await options.accounts.setDisplayName(
          canonicalAccountId,
          displayName,
        );
        res.status(200).json({ schemaVersion: 1, account });
      } catch (error) {
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_display_name_failed",
          error,
        );
      }
    },
  );

  /** Adds (or updates, for an already-claimed lineage) one claim — never clears the whole set; see `PlatformPolicyClaimStore.addClaim`'s doc. Returns the account's full, resulting claim set. */
  router.post(
    "/api/account/claim",
    express.json({ limit: "4kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const authorization = options.security.authorizeWrite(
          requestSecurityHeaders(req),
        );
        const label = stringField(
          req.body,
          "label",
          MAX_CLAIM_LABEL_REQUEST_BYTES,
        );
        if (label === null || label.trim().length === 0) {
          sendFailure(res, 400, "PLATFORM_INVALID_REQUEST");
          return;
        }
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            authorization.account.accountId,
          );
        const claims = await options.claims.addClaim(canonicalAccountId, label);
        res.status(200).json({ schemaVersion: 1, claims });
      } catch (error) {
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_claim_failed",
          error,
        );
      }
    },
  );

  /** Removes one lineage from the caller's claim set — a no-op, not an error, if it was never claimed. Returns the account's full, resulting claim set. */
  router.post(
    "/api/account/claim/remove",
    express.json({ limit: "4kb" }),
    async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      try {
        const authorization = options.security.authorizeWrite(
          requestSecurityHeaders(req),
        );
        const lineageSlug = stringField(
          req.body,
          "lineageSlug",
          MAX_CLAIM_LABEL_REQUEST_BYTES,
        );
        if (lineageSlug === null || lineageSlug.trim().length === 0) {
          sendFailure(res, 400, "PLATFORM_INVALID_REQUEST");
          return;
        }
        const canonicalAccountId =
          await options.identityLinkStore.resolveCanonicalAccountId(
            authorization.account.accountId,
          );
        const claims = await options.claims.removeClaim(
          canonicalAccountId,
          lineageSlug,
        );
        res.status(200).json({ schemaVersion: 1, claims });
      } catch (error) {
        sendPlatformSecurityFailure(
          res,
          logError,
          "platform_claim_remove_failed",
          error,
        );
      }
    },
  );

  /**
   * Child entrypoint — a plain top-level GET navigation, never a fetch
   * (see the contract's handoff protocol). Recognises the platform's own
   * persistent session (mints one on first visit, exactly like every
   * other bootstrap read here) and immediately issues a code for it — no
   * forced GitHub sign-in gate: an anonymous platform visitor still has a
   * stable `accountId`, and requiring a GitHub link here would make the
   * whole flow untestable while GitHub OAuth stays dormant (see the
   * top-level constraints). A child that wants ONLY verified identities
   * can simply not offer this until the user has linked on `/account`.
   */
  router.get("/handoff/start", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    try {
      const audience =
        typeof req.query.audience === "string" ? req.query.audience : "";
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const returnPath =
        typeof req.query.returnPath === "string" ? req.query.returnPath : "";
      const childSessionId =
        typeof req.query.childSessionId === "string"
          ? req.query.childSessionId
          : "";
      if (
        !isValidHandoffAudience(audience) ||
        !STATE_PATTERN.test(state) ||
        !RETURN_PATH_PATTERN.test(returnPath) ||
        !CHILD_SESSION_PATTERN.test(childSessionId)
      ) {
        sendFailure(res, 400, "PLATFORM_INVALID_HANDOFF_REQUEST");
        return;
      }
      const returnOrigin = options.returnOrigins.get(audience);
      if (returnOrigin === undefined) {
        sendFailure(res, 400, "PLATFORM_UNKNOWN_HANDOFF_AUDIENCE");
        return;
      }
      // Deliberately `bootstrap`, not `bootstrapRead`: this route exists
      // ONLY to be reached via a genuine cross-site top-level GET
      // navigation (a child redirects the browser here) — the same
      // reasoning as the GitHub OAuth callback's `identifyAccount`
      // (see `PlatformGithubAuth.ts`). No Origin/Sec-Fetch-Site proof is
      // possible or expected; the SameSite=Lax cookie itself (still sent
      // on a top-level cross-site GET) is the only signal, and a blind
      // CSRF GET against this route can only waste an unreachable code —
      // `returnOrigin` is resolved server-side from the allowlist, never
      // reflected from the request, so the resulting redirect always
      // lands on a real child, never an attacker-controlled origin.
      const bootstrap = options.security.bootstrap(req.headers.cookie);
      if (bootstrap.setCookie !== null)
        res.setHeader("Set-Cookie", bootstrap.setCookie);
      const canonicalAccountId =
        await options.identityLinkStore.resolveCanonicalAccountId(
          bootstrap.account.accountId,
        );
      const [account, claims] = await Promise.all([
        options.accounts.getAccount(canonicalAccountId),
        options.claims.getClaims(canonicalAccountId),
      ]);
      const { code } = options.handoffs.issueCode({
        state,
        returnOrigin,
        audience,
        childSessionId,
        accountId: canonicalAccountId,
        displayName: account?.displayName ?? null,
        claims: claims.map((claim) => ({
          lineageSlug: claim.lineageSlug,
          label: claim.label,
        })),
      });
      const target = new URL(returnPath, returnOrigin);
      target.searchParams.set("code", code);
      target.searchParams.set("state", state);
      res.redirect(302, target.toString());
    } catch (error) {
      logError("platform_handoff_start_failed", error);
      sendFailure(res, 503, "PLATFORM_UNAVAILABLE");
    }
  });

  /** Server-to-server redemption — see `PlatformHandoffStore.redeemCode` for the atomicity guarantee this route relies on. Deliberately NOT behind `authorizeWrite`/CSRF: the caller is another server, not a browser with this platform's own cookie, so browser-CSRF defenses are the wrong tool — the code itself (plus the four bound fields) IS the credential. */
  router.post(
    "/api/account/handoff/redeem",
    express.json({ limit: "4kb" }),
    (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      const body: unknown = req.body;
      const code = stringField(body, "code", 256);
      const state = stringField(body, "state", 512);
      const returnOrigin = stringField(body, "returnOrigin", 512);
      const audience = stringField(body, "audience", 128);
      const childSessionId = stringField(body, "childSessionId", 512);
      if (
        code === null ||
        state === null ||
        returnOrigin === null ||
        audience === null ||
        childSessionId === null
      ) {
        sendFailure(res, 400, "PLATFORM_INVALID_REQUEST");
        return;
      }
      const result = options.handoffs.redeemCode({
        code,
        state,
        returnOrigin,
        audience,
        childSessionId,
      });
      if (!result.ok) {
        sendFailure(
          res,
          409,
          `PLATFORM_HANDOFF_${result.reason.toUpperCase()}`,
        );
        return;
      }
      res.status(200).json({
        schemaVersion: 1,
        accountId: result.accountId,
        displayName: result.displayName,
        claims: result.claims,
      });
    },
  );

  /** Origin-agnostic "who am I, where do I sign in" read — see `src/client/prediction/wagering/components/GithubSignIn.ts`'s doc for why the client always hits this same relative path on every origin. On the platform itself, `signInUrl` points straight at `/api/auth/github/start`. */
  router.get("/api/identity/status", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    try {
      const bootstrap = options.security.bootstrapRead(
        requestSecurityHeaders(req),
      );
      if (bootstrap.setCookie !== null)
        res.setHeader("Set-Cookie", bootstrap.setCookie);
      const canonicalAccountId =
        await options.identityLinkStore.resolveCanonicalAccountId(
          bootstrap.account.accountId,
        );
      const [account, githubStatus] = await Promise.all([
        options.accounts.getAccount(canonicalAccountId),
        options.identityLinkStore.getStatus(canonicalAccountId),
      ]);
      res.status(200).json({
        schemaVersion: 1,
        identity: {
          signedIn: githubStatus.signedIn,
          displayName: account?.displayName ?? null,
          githubLogin: githubStatus.login,
          githubAvatarUrl: githubStatus.avatarUrl,
        },
        signInUrl: options.githubSignInAvailable
          ? "/api/auth/github/start"
          : null,
      });
    } catch (error) {
      logError("platform_identity_status_failed", error);
      sendFailure(res, 503, "PLATFORM_UNAVAILABLE");
    }
  });

  return router;
}

function sendPlatformSecurityFailure(
  res: Response,
  logError: (operatorCode: string, error: unknown) => void,
  operatorCode: string,
  error: unknown,
): void {
  const status =
    typeof error === "object" &&
    error !== null &&
    "httpStatus" in error &&
    (error.httpStatus === 401 || error.httpStatus === 403)
      ? error.httpStatus
      : 503;
  logError(operatorCode, error);
  sendFailure(
    res,
    status,
    status === 503 ? "PLATFORM_UNAVAILABLE" : "PLATFORM_UNAUTHORIZED",
  );
}
