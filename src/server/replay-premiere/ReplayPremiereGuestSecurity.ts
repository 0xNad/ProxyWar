import { createHmac, timingSafeEqual } from "node:crypto";
import { ReplayPremiereError } from "./ReplayPremiereErrors";

const DEFAULT_GUEST_COOKIE = "proxywar_premiere_guest";
const DEFAULT_GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_CSRF_TTL_MS = 4 * 60 * 60 * 1_000;
const ATTRIBUTION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
/** Cookie name for the short-lived GitHub sign-in link-intent binding — see `mintLinkIntentCookie`. Not configurable (unlike `guestCookieName`): it's an internal implementation detail, never read by client code. */
const LINK_INTENT_COOKIE = "proxywar_premiere_link_intent";
const LINK_INTENT_TTL_MS = 5 * 60 * 1_000;
const GUEST_ID_PATTERN = /^guest_[a-f0-9]{32}$/;
const SHARE_ID_PATTERN = /^share_[a-f0-9]{32}$/;
const PREMIERE_ID_PATTERN = /^prem_[a-z0-9]{16,32}$/;
const TOKEN_PART_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

export interface ReplayPremiereGuestSecurityOptions {
  hmacKey: Uint8Array;
  expectedOrigin: string;
  production: boolean;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  guestCookieName?: string;
  guestTtlMs?: number;
  csrfTtlMs?: number;
}

export interface ReplayPremiereGuestParticipant {
  participantId: string;
  createdAt: string;
}

export interface ReplayPremiereGuestBootstrap {
  participant: ReplayPremiereGuestParticipant;
  setCookie: string | null;
  csrfToken: string;
}

export interface ReplayPremiereGuestWriteAuthorization {
  participant: ReplayPremiereGuestParticipant;
}

export interface ReplayPremiereRequestHeaders {
  cookie?: string | string[];
  origin?: string | string[];
  csrfToken?: string | string[];
  /**
   * `Sec-Fetch-Site`, sent by every modern browser on same-origin GET/HEAD
   * fetches even though `Origin` is correctly omitted there (see
   * `authorizeAuthenticatedRead`). Optional purely for older clients that
   * predate the header; never required when `Origin` itself is present.
   */
  secFetchSite?: string | string[];
  /**
   * `Referer`, the last-resort same-origin proof when both `Origin` and
   * `Sec-Fetch-Site` are absent (very old browsers, or a stripped proxy).
   */
  referer?: string | string[];
}

export interface ReplayPremiereShareAttribution {
  attributionId: string;
  shareId: string;
  premiereId: string;
  issuedAt: string;
  expiresAt: string;
}

interface ParsedGuestCookie extends ReplayPremiereGuestParticipant {
  issuedAtMs: number;
  nonce: string;
}

/**
 * Stateless browser-participant, CSRF, and share-attribution security. The
 * HMAC key is dependency-injected and is never serialized into premiere state.
 */
export class ReplayPremiereGuestSecurity {
  readonly expectedOrigin: string;
  readonly guestCookieName: string;

  private readonly key: Buffer;
  private readonly production: boolean;
  private readonly now: () => Date;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly guestTtlMs: number;
  private readonly csrfTtlMs: number;

  constructor(options: ReplayPremiereGuestSecurityOptions) {
    if (options.hmacKey.byteLength < 32 || options.hmacKey.byteLength > 4_096) {
      throw invalidSecurity("invalid_hmac_key_length");
    }
    this.expectedOrigin = canonicalConfiguredOrigin(options.expectedOrigin);
    this.guestCookieName = validateCookieName(
      options.guestCookieName ?? DEFAULT_GUEST_COOKIE,
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
    this.guestTtlMs = validateTtl(
      options.guestTtlMs ?? DEFAULT_GUEST_TTL_MS,
      "guest_ttl",
      60_000,
      365 * 24 * 60 * 60 * 1_000,
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
  ): ReplayPremiereGuestBootstrap {
    const now = this.nowChecked();
    const existing = this.parseGuestCookieHeader(cookieHeader, now.getTime());
    const guest = existing ?? this.createGuest(now);
    return {
      participant: {
        participantId: guest.participantId,
        createdAt: guest.createdAt,
      },
      setCookie: existing === null ? this.serializeGuestCookie(guest) : null,
      csrfToken: this.createCsrfToken(guest, now.getTime()),
    };
  }

  /**
   * Session bootstrap is the sole write-shaped endpoint that does not require
   * an already-issued CSRF token. A strict, exact Origin check is mandatory,
   * and the response always returns a freshly signed CSRF token. This avoids a
   * reload deadlock when the HttpOnly guest cookie outlives in-memory browser
   * state. Every subsequent write still goes through authorizeWrite().
   */
  authorizeSessionCreation(
    headers: ReplayPremiereRequestHeaders,
  ): ReplayPremiereGuestBootstrap {
    this.assertStrictOrigin(headers.origin);
    return this.bootstrap(headers.cookie);
  }

  assertStrictOrigin(originHeader: string | string[] | undefined): void {
    const origin = singleHeader(originHeader, "origin");
    if (origin === null || origin !== this.expectedOrigin) {
      throw securityError("origin_rejected", 403);
    }
  }

  authorizeWrite(
    headers: ReplayPremiereRequestHeaders,
  ): ReplayPremiereGuestWriteAuthorization {
    this.assertStrictOrigin(headers.origin);
    return this.authorizeGuestCredentials(headers);
  }

  /**
   * GET-appropriate sibling of `authorizeWrite`, for an authenticated read
   * of one participant's own private data (e.g. `GET .../market/me`). A
   * real browser correctly omits `Origin` on a same-origin GET/HEAD fetch —
   * per the Fetch standard, `Origin` is only appended for non-GET/HEAD
   * same-origin requests (it's always sent cross-origin, any method, which
   * `assertStrictOrigin` below still catches). `Origin` is a forbidden
   * header no page script can set, so its absence here is expected browser
   * behavior, never an attack signal — rejecting on that basis would 403
   * every legitimate browser client with valid cookie+CSRF credentials.
   * When `Origin` IS present, it is checked with the exact same strictness
   * as a write; this only relaxes what is REQUIRED, never what gets
   * rejected. When absent, `Sec-Fetch-Site: same-origin` (sent by every
   * modern browser on fetch/XHR) or, failing that, `Referer` matching the
   * expected origin, stands in as the same-origin proof instead.
   */
  authorizeAuthenticatedRead(
    headers: ReplayPremiereRequestHeaders,
  ): ReplayPremiereGuestWriteAuthorization {
    this.assertReadOrigin(headers);
    return this.authorizeGuestCredentials(headers);
  }

  /**
   * GET-appropriate identity bootstrap for a premiere-agnostic surface
   * (the cross-premiere points leaderboard) — same relaxed-but-checked
   * origin discipline as `authorizeAuthenticatedRead` (see its doc: a
   * real browser omits `Origin` on a same-origin GET, so `Sec-Fetch-Site`/
   * `Referer` stand in), but MINTS a guest identity + CSRF token on first
   * visit instead of requiring one already exist — exactly like
   * `authorizeSessionCreation` does for the strict-origin POST session
   * bootstrap. This and `authorizeSessionCreation` are the only two
   * places a guest identity is minted; every other route reuses the
   * cookie/CSRF pair either of them issued.
   */
  bootstrapRead(
    headers: ReplayPremiereRequestHeaders,
  ): ReplayPremiereGuestBootstrap {
    this.assertReadOrigin(headers);
    return this.bootstrap(headers.cookie);
  }

  private assertReadOrigin(headers: ReplayPremiereRequestHeaders): void {
    const origin = singleHeader(headers.origin, "origin");
    if (origin !== null) {
      if (origin !== this.expectedOrigin) {
        throw securityError("origin_rejected", 403);
      }
      return;
    }
    const secFetchSite = singleHeader(headers.secFetchSite, "sec-fetch-site");
    if (secFetchSite !== null) {
      if (secFetchSite !== "same-origin") {
        throw securityError("origin_rejected", 403);
      }
      return;
    }
    const referer = singleHeader(headers.referer, "referer");
    if (referer === null || !this.refererMatchesExpectedOrigin(referer)) {
      throw securityError("origin_rejected", 403);
    }
  }

  private refererMatchesExpectedOrigin(referer: string): boolean {
    try {
      return new URL(referer).origin === this.expectedOrigin;
    } catch {
      return false;
    }
  }

  private authorizeGuestCredentials(
    headers: ReplayPremiereRequestHeaders,
  ): ReplayPremiereGuestWriteAuthorization {
    const nowMs = this.nowChecked().getTime();
    const guest = this.parseGuestCookieHeader(headers.cookie, nowMs);
    if (guest === null) throw securityError("guest_cookie_required", 401);
    const csrfToken = singleHeader(headers.csrfToken, "csrf");
    if (csrfToken === null || !this.verifyCsrfToken(csrfToken, guest, nowMs)) {
      throw securityError("csrf_rejected", 403);
    }
    return {
      participant: {
        participantId: guest.participantId,
        createdAt: guest.createdAt,
      },
    };
  }

  /**
   * Converts a trusted transport-normalized remote address into the opaque
   * bucket required by anonymous-write admission. Never persist the raw IP or
   * derive this value from an untrusted forwarded header.
   */
  deriveRequesterBucketId(remoteAddress: string): string {
    if (
      remoteAddress.length === 0 ||
      remoteAddress.length > 256 ||
      [...remoteAddress].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      })
    ) {
      throw invalidSecurity("invalid_remote_address");
    }
    return `ip_${this.sign(`requester|${remoteAddress}`)}`;
  }

  signShareAttribution(options: {
    attributionId: string;
    shareId: string;
    premiereId: string;
  }): string {
    if (
      !GUEST_ID_PATTERN.test(options.attributionId) ||
      !SHARE_ID_PATTERN.test(options.shareId) ||
      !PREMIERE_ID_PATTERN.test(options.premiereId)
    ) {
      throw invalidSecurity("invalid_attribution_identity");
    }
    const issuedAtMs = this.nowChecked().getTime();
    const payload = {
      v: 1,
      aid: options.attributionId,
      sid: options.shareId,
      pid: options.premiereId,
      iat: issuedAtMs,
      exp: issuedAtMs + ATTRIBUTION_TTL_MS,
    };
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
      "base64url",
    );
    return `${encoded}.${this.sign(`attribution|${encoded}`)}`;
  }

  verifyShareAttribution(token: string): ReplayPremiereShareAttribution | null {
    if (token.length < 32 || token.length > 1_024) return null;
    const parts = token.split(".");
    if (
      parts.length !== 2 ||
      !TOKEN_PART_PATTERN.test(parts[0]) ||
      !TOKEN_PART_PATTERN.test(parts[1]) ||
      !constantTimeEqual(parts[1], this.sign(`attribution|${parts[0]}`))
    ) {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (!isRecord(value) || Object.keys(value).length !== 6) return null;
    const { v, aid, sid, pid, iat, exp } = value;
    const nowMs = this.nowChecked().getTime();
    if (
      v !== 1 ||
      typeof aid !== "string" ||
      !GUEST_ID_PATTERN.test(aid) ||
      typeof sid !== "string" ||
      !SHARE_ID_PATTERN.test(sid) ||
      typeof pid !== "string" ||
      !PREMIERE_ID_PATTERN.test(pid) ||
      !Number.isSafeInteger(iat) ||
      !Number.isSafeInteger(exp) ||
      Number(exp) - Number(iat) !== ATTRIBUTION_TTL_MS ||
      Number(iat) > nowMs + 30_000 ||
      Number(exp) <= nowMs
    ) {
      return null;
    }
    return {
      attributionId: aid,
      shareId: sid,
      premiereId: pid,
      issuedAt: new Date(Number(iat)).toISOString(),
      expiresAt: new Date(Number(exp)).toISOString(),
    };
  }

  /**
   * Mints the short-lived (~5 min) HttpOnly, SameSite=Lax link-intent
   * cookie a GitHub sign-in click binds to: `{participantId, nonce, exp}`,
   * HMAC-signed exactly like the CSRF token above. Verified in the OAuth
   * callback (`verifyLinkIntentCookie`) alongside a `state=` query
   * parameter equal to `nonce`, both required before any code exchange
   * happens. Without this, an attacker who completes their OWN GitHub
   * login and sends a victim a link straight to the bare callback would
   * force-link the attacker's identity onto the victim's guest cookie —
   * the victim's browser never holds a matching link-intent cookie (it's
   * HttpOnly and only ever set by this method, scoped to the participant
   * who clicked "Sign in"), so `verifyLinkIntentCookie` rejects it.
   */
  mintLinkIntentCookie(participantId: string): { cookie: string; nonce: string } {
    if (!GUEST_ID_PATTERN.test(participantId)) {
      throw invalidSecurity("invalid_participant_id");
    }
    const issuedAtMs = this.nowChecked().getTime();
    const nonce = hex(this.randomBytesChecked(16));
    const unsigned = `v1.${participantId}.${issuedAtMs.toString(36)}.${nonce}`;
    const value = `${unsigned}.${this.sign(`link|${unsigned}`)}`;
    const attributes = [
      `${LINK_INTENT_COOKIE}=${value}`,
      "Path=/api/premieres",
      `Max-Age=${Math.floor(LINK_INTENT_TTL_MS / 1_000)}`,
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (this.production) attributes.push("Secure");
    return { cookie: attributes.join("; "), nonce };
  }

  /**
   * Verifies the link-intent cookie minted by `mintLinkIntentCookie`
   * matches `expectedParticipantId` (the CURRENT guest cookie's
   * participant) and carries an unexpired, correctly-signed nonce.
   * Returns the nonce so the caller can additionally check it against an
   * OAuth `state=` query parameter (defense in depth; the cookie binding
   * to `expectedParticipantId` is already the load-bearing check).
   */
  verifyLinkIntentCookie(
    cookieHeader: string | string[] | undefined,
    expectedParticipantId: string,
  ): { nonce: string } | null {
    const raw = singleCookieValue(cookieHeader, LINK_INTENT_COOKIE);
    if (raw === null || raw.length > 512) return null;
    const parts = raw.split(".");
    if (parts.length !== 5 || parts[0] !== "v1") return null;
    const [, participantId, issuedAtPart, nonce, signature] = parts;
    if (
      participantId !== expectedParticipantId ||
      !/^[0-9a-z]{1,16}$/.test(issuedAtPart) ||
      !/^[a-f0-9]{32}$/.test(nonce) ||
      !/^[a-f0-9]{64}$/.test(signature)
    ) {
      return null;
    }
    const unsigned = `v1.${participantId}.${issuedAtPart}.${nonce}`;
    if (!constantTimeEqual(signature, this.sign(`link|${unsigned}`))) return null;
    const issuedAtMs = Number.parseInt(issuedAtPart, 36);
    const nowMs = this.nowChecked().getTime();
    if (
      !Number.isSafeInteger(issuedAtMs) ||
      issuedAtMs > nowMs + 30_000 ||
      nowMs - issuedAtMs >= LINK_INTENT_TTL_MS
    ) {
      return null;
    }
    return { nonce };
  }

  /** Clears the link-intent cookie after the callback consumes it (success or failure) — never left to linger or be replayed. */
  clearLinkIntentCookieHeader(): string {
    const attributes = [
      `${LINK_INTENT_COOKIE}=`,
      "Path=/api/premieres",
      "Max-Age=0",
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (this.production) attributes.push("Secure");
    return attributes.join("; ");
  }

  /**
   * Identifies the current guest from the cookie ALONE, with no Origin/
   * Sec-Fetch-Site/Referer check and no minting on absence. The OAuth
   * callback is a deliberate cross-site top-level navigation (GitHub
   * redirects back to us) — `assertReadOrigin`'s same-origin proof is
   * structurally unavailable there, by design; the SameSite=Lax guest
   * cookie itself IS still sent (Lax allows a top-level cross-site GET
   * navigation), and its own HMAC signature is the only authentication
   * this read needs. Returns `null` if absent, expired, or malformed —
   * never mints a guest identity (unlike `bootstrap`/`bootstrapRead`).
   */
  identifyGuest(
    cookieHeader: string | string[] | undefined,
  ): ReplayPremiereGuestParticipant | null {
    const guest = this.parseGuestCookieHeader(
      cookieHeader,
      this.nowChecked().getTime(),
    );
    return guest === null
      ? null
      : { participantId: guest.participantId, createdAt: guest.createdAt };
  }

  private createGuest(now: Date): ParsedGuestCookie {
    const issuedAtMs = now.getTime();
    return {
      participantId: `guest_${hex(this.randomBytesChecked(16))}`,
      createdAt: now.toISOString(),
      issuedAtMs,
      nonce: hex(this.randomBytesChecked(16)),
    };
  }

  private serializeGuestCookie(guest: ParsedGuestCookie): string {
    const issuedAt = guest.issuedAtMs.toString(36);
    const unsigned = `v1.${guest.participantId}.${issuedAt}.${guest.nonce}`;
    const value = `${unsigned}.${this.sign(`guest|${unsigned}`)}`;
    const attributes = [
      `${this.guestCookieName}=${value}`,
      "Path=/api/premieres",
      `Max-Age=${Math.floor(this.guestTtlMs / 1_000)}`,
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (this.production) attributes.push("Secure");
    return attributes.join("; ");
  }

  private parseGuestCookieHeader(
    header: string | string[] | undefined,
    nowMs: number,
  ): ParsedGuestCookie | null {
    const raw = singleCookieValue(header, this.guestCookieName);
    if (raw === null || raw.length > 512) return null;
    const parts = raw.split(".");
    if (parts.length !== 5 || parts[0] !== "v1") return null;
    const [, participantId, issuedAtPart, nonce, signature] = parts;
    if (
      !GUEST_ID_PATTERN.test(participantId) ||
      !/^[0-9a-z]{1,16}$/.test(issuedAtPart) ||
      !/^[a-f0-9]{32}$/.test(nonce) ||
      !/^[a-f0-9]{64}$/.test(signature)
    ) {
      return null;
    }
    const unsigned = `v1.${participantId}.${issuedAtPart}.${nonce}`;
    if (!constantTimeEqual(signature, this.sign(`guest|${unsigned}`))) {
      return null;
    }
    const issuedAtMs = Number.parseInt(issuedAtPart, 36);
    if (
      !Number.isSafeInteger(issuedAtMs) ||
      issuedAtMs > nowMs + 30_000 ||
      nowMs - issuedAtMs >= this.guestTtlMs
    ) {
      return null;
    }
    return {
      participantId,
      createdAt: new Date(issuedAtMs).toISOString(),
      issuedAtMs,
      nonce,
    };
  }

  private createCsrfToken(guest: ParsedGuestCookie, nowMs: number): string {
    const issuedAt = nowMs.toString(36);
    const nonce = hex(this.randomBytesChecked(16));
    const unsigned = `v1.${issuedAt}.${nonce}`;
    return `${unsigned}.${this.sign(
      `csrf|${guest.participantId}|${guest.issuedAtMs}|${unsigned}`,
    )}`;
  }

  private verifyCsrfToken(
    token: string,
    guest: ParsedGuestCookie,
    nowMs: number,
  ): boolean {
    if (token.length > 512) return false;
    const parts = token.split(".");
    if (
      parts.length !== 4 ||
      parts[0] !== "v1" ||
      !/^[0-9a-z]{1,16}$/.test(parts[1]) ||
      !/^[a-f0-9]{32}$/.test(parts[2]) ||
      !/^[a-f0-9]{64}$/.test(parts[3])
    ) {
      return false;
    }
    const issuedAtMs = Number.parseInt(parts[1], 36);
    const unsigned = parts.slice(0, 3).join(".");
    return (
      Number.isSafeInteger(issuedAtMs) &&
      issuedAtMs <= nowMs + 30_000 &&
      nowMs - issuedAtMs < this.csrfTtlMs &&
      constantTimeEqual(
        parts[3],
        this.sign(
          `csrf|${guest.participantId}|${guest.issuedAtMs}|${unsigned}`,
        ),
      )
    );
  }

  private sign(value: string): string {
    return createHmac("sha256", this.key).update(value, "utf8").digest("hex");
  }

  private randomBytesChecked(size: number): Uint8Array {
    const bytes = this.randomBytes(size);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
      throw invalidSecurity("invalid_random_source");
    }
    return bytes;
  }

  private nowChecked(): Date {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw invalidSecurity("invalid_clock");
    return now;
  }
}

export function isReplayPremiereBotUserAgent(
  userAgent: string | readonly string[] | undefined,
): boolean {
  if (
    typeof userAgent !== "string" ||
    userAgent.trim().length === 0 ||
    userAgent.length > 1_024 ||
    [...userAgent].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return true;
  }
  return /\b(bot|crawler|spider|slurp|preview|facebookexternalhit|twitterbot)\b/i.test(
    userAgent,
  );
}

function singleCookieValue(
  header: string | string[] | undefined,
  name: string,
): string | null {
  if (header === undefined || Array.isArray(header) || header.length > 8_192) {
    return null;
  }
  const values: string[] = [];
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    if (pair.slice(0, separator).trim() === name) {
      values.push(pair.slice(separator + 1).trim());
    }
  }
  return values.length === 1 ? values[0] : null;
}

function singleHeader(
  value: string | string[] | undefined,
  _name: string,
): string | null {
  return typeof value === "string" && value.length <= 2_048 ? value : null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function canonicalConfiguredOrigin(value: string): string {
  if (value.length > 2_048) throw invalidSecurity("invalid_expected_origin");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw invalidSecurity("invalid_expected_origin", error);
  }
  if (
    parsed.origin !== value ||
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw invalidSecurity("invalid_expected_origin");
  }
  return value;
}

function validateCookieName(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
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
    throw invalidSecurity(`invalid_${name}`);
  }
  return value;
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidSecurity(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    400,
    `Replay premiere guest security configuration is invalid: ${operatorCode}`,
    cause === undefined ? undefined : { cause },
  );
}

function securityError(
  operatorCode: string,
  status: 401 | 403,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    status,
    `Replay premiere guest request was rejected: ${operatorCode}`,
  );
}
