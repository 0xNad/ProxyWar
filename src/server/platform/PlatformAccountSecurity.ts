/**
 * Stateless browser-session, CSRF, and GitHub-link-intent security for the
 * PLATFORM's own account cookie — `app.proxywar.xyz` is the sole account
 * and session authority (see the platform build's contract).
 *
 * Deliberately a fresh class, not a reuse of the betting origin's
 * `ReplayPremiereGuestSecurity`, for three reasons the contract requires:
 *
 * - New cookie, new name (`proxywar_platform_account`, configurable),
 *   never `proxywar_premiere_guest`. Two identity systems sharing one
 *   cookie name would collide the moment both are visited from the same
 *   browser profile pointed at the same host.
 * - New HMAC key (`PlatformSecrets.ts`), never
 *   `PROXYWAR_REPLAY_PREMIERE_HMAC_KEY_HEX` — a leaked betting key must
 *   never let an attacker mint platform account cookies, and vice versa.
 * - Host-only: no `Path=/api/premieres` narrowing (betting's cookie is
 *   scoped that way only because it predates a real account system and
 *   still shares a domain with the login-intent cookie); this cookie has
 *   no `Domain=` attribute at all (never set one — see the contract:
 *   widening a cookie's scope with `Domain=.proxywar.xyz` would let any
 *   sibling origin overwrite platform identity), so per RFC 6265 it is
 *   already strictly host-only to whichever single origin serves it
 *   (`app.proxywar.xyz`), and applies path-wide (`Path=/`) since every
 *   platform route — `/account`, `/api/account/*`, `/api/auth/github/*`,
 *   `/handoff/start` — legitimately needs it.
 *
 * Share-attribution and the anonymous-write IP bucket
 * (`ReplayPremiereGuestSecurity`'s `signShareAttribution` /
 * `deriveRequesterBucketId`) are betting-specific anti-abuse features for
 * a public prediction market and have no platform equivalent — omitted
 * here, not ported.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_ACCOUNT_COOKIE = "proxywar_platform_account";
const DEFAULT_ACCOUNT_TTL_MS = 400 * 24 * 60 * 60 * 1_000;
const DEFAULT_CSRF_TTL_MS = 4 * 60 * 60 * 1_000;
/** Cookie name for the short-lived GitHub sign-in link-intent binding — see `mintLinkIntentCookie`. Not configurable: an internal implementation detail, never read by client code. */
const LINK_INTENT_COOKIE = "proxywar_platform_link_intent";
const LINK_INTENT_TTL_MS = 5 * 60 * 1_000;
const ACCOUNT_ID_PATTERN = /^acct_[a-f0-9]{32}$/;
const TOKEN_PART_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

export interface PlatformAccountSecurityOptions {
  hmacKey: Uint8Array;
  expectedOrigin: string;
  production: boolean;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  accountCookieName?: string;
  accountTtlMs?: number;
  csrfTtlMs?: number;
}

export interface PlatformAccountIdentity {
  accountId: string;
  createdAt: string;
}

export interface PlatformAccountBootstrap {
  account: PlatformAccountIdentity;
  setCookie: string | null;
  csrfToken: string;
}

export interface PlatformAccountWriteAuthorization {
  account: PlatformAccountIdentity;
}

export interface PlatformRequestHeaders {
  cookie?: string | string[];
  origin?: string | string[];
  csrfToken?: string | string[];
  secFetchSite?: string | string[];
  referer?: string | string[];
}

interface ParsedAccountCookie extends PlatformAccountIdentity {
  issuedAtMs: number;
  nonce: string;
}

function invalidSecurity(operatorCode: string): Error {
  return new Error(`platform_security_invalid: ${operatorCode}`);
}

export class PlatformSecurityError extends Error {
  constructor(
    public readonly operatorCode: string,
    public readonly httpStatus: 401 | 403,
  ) {
    super(`platform_security_rejected: ${operatorCode}`);
  }
}

/** Same class of class as `ReplayPremiereGuestSecurity` — see that class's doc for the reasoning behind every method here; this is its platform-scoped, host-only sibling. */
export class PlatformAccountSecurity {
  readonly expectedOrigin: string;
  readonly accountCookieName: string;

  private readonly key: Buffer;
  private readonly production: boolean;
  private readonly now: () => Date;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly accountTtlMs: number;
  private readonly csrfTtlMs: number;

  constructor(options: PlatformAccountSecurityOptions) {
    if (options.hmacKey.byteLength < 32 || options.hmacKey.byteLength > 4_096) {
      throw invalidSecurity("invalid_hmac_key_length");
    }
    this.expectedOrigin = canonicalConfiguredOrigin(options.expectedOrigin);
    this.accountCookieName = validateCookieName(
      options.accountCookieName ?? DEFAULT_ACCOUNT_COOKIE,
    );
    this.production = options.production;
    this.now = options.now ?? (() => new Date());
    this.randomBytes =
      options.randomBytes ??
      ((size: number): Uint8Array => {
        const bytes = new Uint8Array(size);
        globalThis.crypto.getRandomValues(bytes);
        return bytes;
      });
    this.accountTtlMs = validateTtl(
      options.accountTtlMs ?? DEFAULT_ACCOUNT_TTL_MS,
      "account_ttl",
      60_000,
      3_650 * 24 * 60 * 60 * 1_000,
    );
    this.csrfTtlMs = validateTtl(
      options.csrfTtlMs ?? DEFAULT_CSRF_TTL_MS,
      "csrf_ttl",
      60_000,
      24 * 60 * 60 * 1_000,
    );
    this.key = Buffer.from(options.hmacKey);
  }

  bootstrap(
    cookieHeader: string | string[] | undefined,
  ): PlatformAccountBootstrap {
    const now = this.now();
    const existing = this.parseAccountCookieHeader(cookieHeader, now.getTime());
    const account = existing ?? this.createAccount(now);
    return {
      account: { accountId: account.accountId, createdAt: account.createdAt },
      setCookie:
        existing === null ? this.serializeAccountCookie(account) : null,
      csrfToken: this.createCsrfToken(account, now.getTime()),
    };
  }

  /** Same "no prior CSRF token required" reasoning as `ReplayPremiereGuestSecurity.authorizeSessionCreation`: a strict Origin check stands in for it on the one route that has to work with no CSRF token yet in hand. */
  authorizeSessionCreation(
    headers: PlatformRequestHeaders,
  ): PlatformAccountBootstrap {
    this.assertStrictOrigin(headers.origin);
    return this.bootstrap(headers.cookie);
  }

  assertStrictOrigin(originHeader: string | string[] | undefined): void {
    const origin = singleHeader(originHeader);
    if (origin === null || origin !== this.expectedOrigin) {
      throw new PlatformSecurityError("origin_rejected", 403);
    }
  }

  authorizeWrite(
    headers: PlatformRequestHeaders,
  ): PlatformAccountWriteAuthorization {
    this.assertStrictOrigin(headers.origin);
    return this.authorizeAccountCredentials(headers);
  }

  /** GET-appropriate sibling of `authorizeWrite`/`bootstrap` — mints on first visit like `bootstrap`, but relaxes the Origin requirement to accept a same-origin browser GET (no `Origin` header) the way `ReplayPremiereGuestSecurity.bootstrapRead` does; see that method's doc for the Fetch-standard reasoning. */
  bootstrapRead(headers: PlatformRequestHeaders): PlatformAccountBootstrap {
    this.assertReadOrigin(headers);
    return this.bootstrap(headers.cookie);
  }

  /**
   * Parses an ALREADY-ESTABLISHED account cookie and nothing else: no
   * Origin/Sec-Fetch-Site/Referer check, no CSRF check, and — unlike
   * `bootstrap`/`bootstrapRead` — no minting of a new account when the
   * cookie is absent or expired (`null` instead).
   *
   * The long name is the warning. Every other entry point on this class
   * enforces an origin; this one delegates that duty to its caller, so a
   * caller MUST have already established that the request is permitted —
   * see `/api/account/pov-claims`, which matches an exact CORS allowlist
   * first and is the only intended caller. Do not reach for this to make a
   * route "work cross-origin"; it grants nothing on its own precisely
   * because it returns no CSRF token, so it must never gate a write.
   *
   * Not minting matters as much as not checking: a cross-origin reader is
   * typically a league visitor who has never touched the platform, and
   * silently issuing them an account would create an empty account per
   * visitor and set a cookie from a surface they never visited.
   */
  readEstablishedAccountWithoutOriginCheck(
    cookieHeader: string | string[] | undefined,
  ): { readonly accountId: string } | null {
    const account = this.parseAccountCookieHeader(
      cookieHeader,
      this.now().getTime(),
    );
    return account === null ? null : { accountId: account.accountId };
  }

  private assertReadOrigin(headers: PlatformRequestHeaders): void {
    const origin = singleHeader(headers.origin);
    if (origin !== null) {
      if (origin !== this.expectedOrigin) {
        throw new PlatformSecurityError("origin_rejected", 403);
      }
      return;
    }
    const secFetchSite = singleHeader(headers.secFetchSite);
    if (secFetchSite !== null) {
      if (secFetchSite !== "same-origin") {
        throw new PlatformSecurityError("origin_rejected", 403);
      }
      return;
    }
    const referer = singleHeader(headers.referer);
    if (referer === null || !this.refererMatchesExpectedOrigin(referer)) {
      throw new PlatformSecurityError("origin_rejected", 403);
    }
  }

  private refererMatchesExpectedOrigin(referer: string): boolean {
    try {
      return new URL(referer).origin === this.expectedOrigin;
    } catch {
      return false;
    }
  }

  private authorizeAccountCredentials(
    headers: PlatformRequestHeaders,
  ): PlatformAccountWriteAuthorization {
    const nowMs = this.now().getTime();
    const account = this.parseAccountCookieHeader(headers.cookie, nowMs);
    if (account === null)
      throw new PlatformSecurityError("account_cookie_required", 401);
    const csrfToken = singleHeader(headers.csrfToken);
    if (
      csrfToken === null ||
      !this.verifyCsrfToken(csrfToken, account, nowMs)
    ) {
      throw new PlatformSecurityError("csrf_rejected", 403);
    }
    return {
      account: { accountId: account.accountId, createdAt: account.createdAt },
    };
  }

  /**
   * Mints the short-lived (~5 min) HttpOnly, SameSite=Lax link-intent
   * cookie a GitHub sign-in click binds to: `{accountId, nonce, exp}`,
   * HMAC-signed exactly like the CSRF token. Verified in the OAuth
   * callback (`verifyLinkIntentCookie`) alongside a `state=` query
   * parameter equal to `nonce`. See `ReplayPremiereGuestSecurity.
   * mintLinkIntentCookie`'s doc for the exact Sybil scenario this closes.
   */
  mintLinkIntentCookie(accountId: string): { cookie: string; nonce: string } {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw invalidSecurity("invalid_account_id");
    }
    const issuedAtMs = this.now().getTime();
    const nonce = hex(this.randomBytesChecked(16));
    const unsigned = `v1.${accountId}.${issuedAtMs.toString(36)}.${nonce}`;
    const value = `${unsigned}.${this.sign(`link|${unsigned}`)}`;
    const attributes = [
      `${LINK_INTENT_COOKIE}=${value}`,
      "Path=/",
      `Max-Age=${Math.floor(LINK_INTENT_TTL_MS / 1_000)}`,
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (this.production) attributes.push("Secure");
    return { cookie: attributes.join("; "), nonce };
  }

  verifyLinkIntentCookie(
    cookieHeader: string | string[] | undefined,
    expectedAccountId: string,
  ): { nonce: string } | null {
    const raw = singleCookieValue(cookieHeader, LINK_INTENT_COOKIE);
    if (raw === null || raw.length > 512) return null;
    const parts = raw.split(".");
    if (parts.length !== 5 || parts[0] !== "v1") return null;
    const [, accountId, issuedAtPart, nonce, signature] = parts;
    if (
      accountId !== expectedAccountId ||
      !/^[0-9a-z]{1,16}$/.test(issuedAtPart) ||
      !/^[a-f0-9]{32}$/.test(nonce) ||
      !/^[a-f0-9]{64}$/.test(signature)
    ) {
      return null;
    }
    const unsigned = `v1.${accountId}.${issuedAtPart}.${nonce}`;
    if (!constantTimeEqual(signature, this.sign(`link|${unsigned}`)))
      return null;
    const issuedAtMs = Number.parseInt(issuedAtPart, 36);
    const nowMs = this.now().getTime();
    if (
      !Number.isSafeInteger(issuedAtMs) ||
      issuedAtMs > nowMs + 30_000 ||
      nowMs - issuedAtMs >= LINK_INTENT_TTL_MS
    ) {
      return null;
    }
    return { nonce };
  }

  clearLinkIntentCookieHeader(): string {
    const attributes = [
      `${LINK_INTENT_COOKIE}=`,
      "Path=/",
      "Max-Age=0",
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (this.production) attributes.push("Secure");
    return attributes.join("; ");
  }

  /** Cookie-only identity read, no Origin/CSRF proof — for the OAuth callback, a deliberate cross-site top-level navigation where no same-origin proof is available. See `ReplayPremiereGuestSecurity.identifyGuest`'s doc. */
  identifyAccount(
    cookieHeader: string | string[] | undefined,
  ): PlatformAccountIdentity | null {
    const account = this.parseAccountCookieHeader(
      cookieHeader,
      this.now().getTime(),
    );
    return account === null
      ? null
      : { accountId: account.accountId, createdAt: account.createdAt };
  }

  /** Mints a signed cookie for an account id THE CALLER ALREADY VERIFIED — see `ReplayPremiereGuestSecurity.mintGuestCookieForParticipant`'s doc for the exact scoping discipline (only ever called immediately after a verified link/merge result). */
  mintCookieForAccount(accountId: string): string {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw invalidSecurity("invalid_account_id");
    }
    const now = this.now();
    return this.serializeAccountCookie({
      accountId,
      createdAt: now.toISOString(),
      issuedAtMs: now.getTime(),
      nonce: hex(this.randomBytesChecked(16)),
    });
  }

  private createAccount(now: Date): ParsedAccountCookie {
    const issuedAtMs = now.getTime();
    return {
      accountId: `acct_${hex(this.randomBytesChecked(16))}`,
      createdAt: now.toISOString(),
      issuedAtMs,
      nonce: hex(this.randomBytesChecked(16)),
    };
  }

  private serializeAccountCookie(account: ParsedAccountCookie): string {
    const issuedAt = account.issuedAtMs.toString(36);
    const unsigned = `v1.${account.accountId}.${issuedAt}.${account.nonce}`;
    const value = `${unsigned}.${this.sign(`account|${unsigned}`)}`;
    const attributes = [
      `${this.accountCookieName}=${value}`,
      "Path=/",
      `Max-Age=${Math.floor(this.accountTtlMs / 1_000)}`,
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (this.production) attributes.push("Secure");
    return attributes.join("; ");
  }

  private parseAccountCookieHeader(
    header: string | string[] | undefined,
    nowMs: number,
  ): ParsedAccountCookie | null {
    const raw = singleCookieValue(header, this.accountCookieName);
    if (raw === null || raw.length > 512) return null;
    const parts = raw.split(".");
    if (parts.length !== 5 || parts[0] !== "v1") return null;
    const [, accountId, issuedAtPart, nonce, signature] = parts;
    if (
      !ACCOUNT_ID_PATTERN.test(accountId) ||
      !/^[0-9a-z]{1,16}$/.test(issuedAtPart) ||
      !/^[a-f0-9]{32}$/.test(nonce) ||
      !/^[a-f0-9]{64}$/.test(signature)
    ) {
      return null;
    }
    const unsigned = `v1.${accountId}.${issuedAtPart}.${nonce}`;
    if (!constantTimeEqual(signature, this.sign(`account|${unsigned}`)))
      return null;
    const issuedAtMs = Number.parseInt(issuedAtPart, 36);
    if (
      !Number.isSafeInteger(issuedAtMs) ||
      issuedAtMs > nowMs + 30_000 ||
      nowMs - issuedAtMs >= this.accountTtlMs
    ) {
      return null;
    }
    return {
      accountId,
      createdAt: new Date(issuedAtMs).toISOString(),
      issuedAtMs,
      nonce,
    };
  }

  private createCsrfToken(
    account: ParsedAccountCookie,
    issuedAtMs: number,
  ): string {
    const unsigned = `v1.${account.accountId}.${issuedAtMs.toString(36)}`;
    return `${unsigned}.${this.sign(`csrf|${unsigned}`)}`;
  }

  private verifyCsrfToken(
    token: string,
    account: ParsedAccountCookie,
    nowMs: number,
  ): boolean {
    if (token.length > 256) return false;
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") return false;
    const [, accountId, issuedAtPart, signature] = parts;
    if (
      accountId !== account.accountId ||
      !/^[0-9a-z]{1,16}$/.test(issuedAtPart)
    ) {
      return false;
    }
    const unsigned = `v1.${accountId}.${issuedAtPart}`;
    if (!constantTimeEqual(signature, this.sign(`csrf|${unsigned}`)))
      return false;
    const issuedAt = Number.parseInt(issuedAtPart, 36);
    if (!Number.isSafeInteger(issuedAt) || issuedAt > nowMs + 30_000)
      return false;
    return nowMs - issuedAt < this.csrfTtlMs;
  }

  private randomBytesChecked(size: number): Uint8Array {
    const bytes = this.randomBytes(size);
    if (bytes.byteLength !== size) throw invalidSecurity("random_bytes_short");
    return bytes;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.key).update(payload).digest("hex");
  }
}

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" && value.length <= 2_048 ? value : null;
}

function singleCookieValue(
  header: string | string[] | undefined,
  name: string,
): string | null {
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (typeof raw !== "string" || raw.length > 8_192) return null;
  for (const part of raw.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 0) continue;
    const key = part.slice(0, separatorIndex).trim();
    if (key !== name) continue;
    const value = part.slice(separatorIndex + 1).trim();
    return value.split(".").every((segment) => TOKEN_PART_PATTERN.test(segment))
      ? value
      : null;
  }
  return null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.byteLength !== rightBuffer.byteLength) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function canonicalConfiguredOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin === "null") throw invalidSecurity("invalid_expected_origin");
  return url.origin;
}

function validateCookieName(value: string): string {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(value)) {
    throw invalidSecurity("invalid_cookie_name");
  }
  return value;
}

function validateTtl(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidSecurity(`invalid_ttl_${name}`);
  }
  return value;
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}
