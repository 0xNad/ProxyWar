/**
 * One canonical host for the account authority, enforced at the edge of the
 * platform process.
 *
 * `PlatformAccountSecurity` accepts exactly ONE `expectedOrigin` and the
 * session cookie is host-only, so a second hostname pointed at the same port
 * is not an alias — it is a half-working duplicate: `GET`s mint a separate
 * anonymous account (an `Origin`-less same-origin read carries no host to
 * check), while every write 403s with `origin_rejected`. That shape is worse
 * than a hard failure because it looks like it works until the user tries to
 * name themselves.
 *
 * The apex cutover creates exactly that situation: `app.proxywar.xyz` stays in
 * the tunnel ingress, so it keeps reaching this process after the canonical
 * origin moves to the apex. This module is what makes it a redirect instead of
 * a trap.
 */

/**
 * Hosts that are never canonicalized, in either direction — see
 * {@link resolveCanonicalHostRedirect}. `.localhost` subdomains are covered by
 * the suffix test at each call site (RFC 6761 reserves the whole TLD).
 */
const LOOPBACK_HOSTNAMES: Record<string, true> = {
  localhost: true,
  "127.0.0.1": true,
  "::1": true,
  "[::1]": true,
};

function hostnameOf(host: string): string {
  // IPv6 literals are bracketed (`[::1]:8793`); everything else splits on the
  // last colon so a port never leaks into the comparison.
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    return close === -1 ? host.toLowerCase() : host.slice(0, close + 1).toLowerCase();
  }
  const colon = host.lastIndexOf(":");
  return (colon === -1 ? host : host.slice(0, colon)).toLowerCase();
}

export interface CanonicalHostRedirectRequest {
  /** `PROXYWAR_PLATFORM_ORIGIN`, i.e. the one origin cookies and writes are scoped to. */
  readonly canonicalOrigin: string;
  /** The `Host` header exactly as received. */
  readonly host: string | string[] | undefined;
  readonly method: string;
  /** `req.originalUrl` — path plus query, so a redirect keeps the deep link. */
  readonly originalUrl: string;
}

/**
 * The absolute URL a request arriving on a non-canonical host should be sent
 * to, or `null` when it must be served as-is.
 *
 * Deliberately narrow:
 *
 * - **`GET`/`HEAD` only.** A 301 on a `POST` is re-issued as a `GET` by most
 *   clients, which would turn a rejected write into a silent no-op that
 *   answers 200. Other methods fall through to the existing
 *   `origin_rejected` 403, which is the honest answer.
 * - **Loopback is exempt, in both directions.** Health checks, the platform's
 *   own league-mirror refresher and every local smoke test address
 *   `127.0.0.1:8793`; redirecting them would push internal traffic out through
 *   Cloudflare and back. And when the canonical origin is ITSELF loopback (dev,
 *   no `PROXYWAR_PUBLIC_URL`) there is nothing to canonicalize — a LAN-IP
 *   request must not be bounced to the developer's own localhost.
 * - **No `Host` header, no redirect.** Fabricating a target for an HTTP/1.0
 *   request tells the caller less than serving it does.
 */
export function resolveCanonicalHostRedirect(
  request: CanonicalHostRedirectRequest,
): string | null {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  const host = typeof request.host === "string" ? request.host : null;
  if (host === null || host === "") return null;

  let canonical: URL;
  try {
    canonical = new URL(request.canonicalOrigin);
  } catch {
    return null;
  }
  const canonicalHostname = canonical.hostname.toLowerCase();
  if (
    LOOPBACK_HOSTNAMES[canonicalHostname] === true ||
    canonicalHostname.endsWith(".localhost")
  ) {
    return null;
  }

  const requestHostname = hostnameOf(host);
  if (requestHostname === canonicalHostname) return null;
  if (
    LOOPBACK_HOSTNAMES[requestHostname] === true ||
    requestHostname.endsWith(".localhost")
  ) {
    return null;
  }

  return `${canonical.origin}${request.originalUrl}`;
}
