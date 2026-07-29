/**
 * The allowlist of sibling origins permitted an AMBIENT, CREDENTIALED,
 * cross-origin read of a viewer's claimed lineage slugs
 * (`GET /api/account/pov-claims` — see `PlatformAccountHttp.ts`).
 *
 * Deliberately SEPARATE from the handoff's `audience -> origin` return map
 * (`PlatformReturnOrigins.ts`), and not derived from it, because the two are
 * different grants and the stronger one must not be acquired by accident:
 *
 * - A handoff return origin may receive a redirect and redeem a one-time code
 *   for a sign-in the VIEWER EXPLICITLY STARTED. No user action, no data.
 * - An origin on THIS list may read the viewer's claim set silently, on any
 *   page load, with no gesture and no visible trace, for as long as their
 *   platform cookie is valid.
 *
 * Reusing the handoff map would mean that registering any future child app —
 * a bot surface, a partner deployment — silently widened who can harvest
 * every viewer's claims. That is a privilege escalation performed by a config
 * change, with nothing in the diff to notice. So this list is explicit, and
 * defaults to EMPTY: absent configuration, no origin gets an ambient read and
 * the PoV default simply does not apply off the platform.
 *
 * Note that a cookie-level bound also applies underneath this allowlist: the
 * session cookie is host-only and `SameSite=Lax`, so an origin outside the
 * registrable domain gets no cookie regardless of what is listed here. This
 * allowlist narrows the same-site set; it cannot widen beyond it.
 */
export const PLATFORM_POV_CLAIM_ORIGINS_ENV =
  "PROXYWAR_PLATFORM_POV_CLAIM_ORIGINS" as const;

/**
 * Parses `PROXYWAR_PLATFORM_POV_CLAIM_ORIGINS` — a JSON array of origins, e.g.
 * `["https://beta.proxywar.xyz"]`. Each entry is normalised through `URL` and
 * kept only if it is a well-formed HTTP(S) origin; a bad entry is dropped on
 * its own rather than taking the list (or the platform's startup) down with
 * it, matching `resolvePlatformReturnOrigins`'s failure discipline. Malformed
 * JSON logs and yields an empty set — fail CLOSED, since the failure mode of
 * this list is "who may read viewer data".
 */
export function resolvePlatformPovClaimOrigins(
  environment: Record<string, string | undefined> = process.env,
): ReadonlySet<string> {
  const raw = environment[PLATFORM_POV_CLAIM_ORIGINS_ENV]?.trim();
  const origins = new Set<string>();
  if (raw === undefined || raw === "") return origins;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(
      `${PLATFORM_POV_CLAIM_ORIGINS_ENV} is not valid JSON — ignoring it`,
    );
    return origins;
  }
  if (!Array.isArray(parsed)) {
    console.error(
      `${PLATFORM_POV_CLAIM_ORIGINS_ENV} must be a JSON array — ignoring it`,
    );
    return origins;
  }
  for (const value of parsed) {
    if (typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (
        url.origin !== "null" &&
        (url.protocol === "http:" || url.protocol === "https:")
      ) {
        origins.add(url.origin);
      }
    } catch {
      // One malformed origin — skip it, keep the rest.
    }
  }
  return origins;
}
