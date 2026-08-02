/**
 * The handoff's return-origin allowlist (contract: "Return origins are an
 * explicit allowlist. Never reflect an arbitrary origin."). Keyed by
 * `audience` — a short, stable name for the child app, never a client-
 * supplied origin string. `/handoff/start` looks the caller's declared
 * `audience` up here and redirects to the CONFIGURED origin for it; an
 * unknown audience has no origin to redirect to at all.
 */
export const PLATFORM_RETURN_ORIGINS_ENV =
  "PROXYWAR_PLATFORM_RETURN_ORIGINS" as const;

const AUDIENCE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/** Parses `PROXYWAR_PLATFORM_RETURN_ORIGINS` — a JSON object of `audience -> origin`, e.g. `{"betting":"https://bet.proxywar.xyz"}`. Malformed JSON, a non-object, or any entry with a bad audience name or non-HTTP(S) origin is dropped (that one entry, not the whole map) rather than thrown — a typo in one child's config must never take down every other child's handoff, or the platform's own startup. */
export function resolvePlatformReturnOrigins(
  environment: Record<string, string | undefined> = process.env,
): ReadonlyMap<string, string> {
  const raw = environment[PLATFORM_RETURN_ORIGINS_ENV]?.trim();
  const origins = new Map<string, string>();
  if (raw === undefined || raw === "") return origins;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`${PLATFORM_RETURN_ORIGINS_ENV} is not valid JSON — ignoring it`);
    return origins;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error(`${PLATFORM_RETURN_ORIGINS_ENV} must be a JSON object — ignoring it`);
    return origins;
  }
  for (const [audience, value] of Object.entries(parsed)) {
    if (!AUDIENCE_PATTERN.test(audience) || typeof value !== "string") continue;
    try {
      const url = new URL(value);
      if (url.origin !== "null" && (url.protocol === "http:" || url.protocol === "https:")) {
        origins.set(audience, url.origin);
      }
    } catch {
      // Malformed origin for this one audience — skip it, keep the rest.
    }
  }
  return origins;
}

export function isValidHandoffAudience(value: string): boolean {
  return AUDIENCE_PATTERN.test(value);
}
