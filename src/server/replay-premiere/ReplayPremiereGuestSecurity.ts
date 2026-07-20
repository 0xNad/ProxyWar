import { createHmac, timingSafeEqual } from "node:crypto";
import { ReplayPremiereError } from "./ReplayPremiereErrors";

const DEFAULT_GUEST_COOKIE = "proxywar_premiere_guest";
const DEFAULT_GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_CSRF_TTL_MS = 4 * 60 * 60 * 1_000;
const ATTRIBUTION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
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
  userAgent: string | undefined,
): boolean {
  if (userAgent === undefined) return true;
  if (userAgent.length > 1_024) return true;
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
