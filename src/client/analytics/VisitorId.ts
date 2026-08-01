/**
 * Bounded, privacy-conscious anonymous visitor identity for the Phase 7
 * product-analytics client. Deliberately NOT a fingerprint:
 *
 *  - a single random id (crypto-strength when available), nothing derived
 *    from IP, user agent, screen size, timezone, or any other ambient
 *    browser signal;
 *  - stored only in `localStorage` on this origin — never a cookie sent
 *    cross-origin, never synced to a server-side identity table;
 *  - rotated on an explicit 30-day schedule: once the stored id is older
 *    than `ROTATION_MS`, it is destroyed and replaced, not renewed. That
 *    makes correlating one visitor's behavior across more than ~30 days
 *    structurally impossible from this id alone — there is no persistent
 *    long-lived value to correlate;
 *  - "returning visitor" is derived from nothing but this presence+age
 *    check (an id that already existed, and hasn't rotated, must belong to
 *    a prior visit) — no server-side session table, no IP matching.
 *
 * `localStorage` may be unavailable (private browsing, disabled storage,
 * non-browser test environment) — every function here degrades to an
 * in-memory, non-persisted id rather than throwing, so a page that embeds
 * this module never breaks because analytics storage isn't available.
 */

export const VISITOR_ID_STORAGE_KEY = "pw_analytics_visitor_id";
export const VISITOR_ID_CREATED_AT_STORAGE_KEY = "pw_analytics_visitor_created_at";
export const VISITOR_ID_ROTATION_MS = 30 * 24 * 60 * 60 * 1000;

export interface VisitorIdentity {
  id: string;
  createdAt: number;
  /** True when this id already existed (and hadn't rotated) before this call — i.e. this is not the visitor's first page load with this id. */
  isReturning: boolean;
}

function generateId(): string {
  const cryptoObj = typeof crypto !== "undefined" ? crypto : undefined;
  if (cryptoObj?.randomUUID !== undefined) {
    return cryptoObj.randomUUID().replace(/-/g, "");
  }
  if (cryptoObj?.getRandomValues !== undefined) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  // Last-resort fallback for environments without a crypto API at all —
  // still bounded/opaque, just lower entropy.
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
}

/**
 * Reads (and rotates, if expired) the visitor identity from `storage`.
 * Pass `now`/`storage` explicitly only from tests; production call sites
 * use the defaults.
 */
export function loadOrCreateVisitorIdentity(
  storage: Storage | undefined = safeLocalStorage(),
  now: number = Date.now(),
): VisitorIdentity {
  if (storage === undefined) {
    return { id: generateId(), createdAt: now, isReturning: false };
  }
  try {
    const storedId = storage.getItem(VISITOR_ID_STORAGE_KEY);
    const storedCreatedAtRaw = storage.getItem(VISITOR_ID_CREATED_AT_STORAGE_KEY);
    const storedCreatedAt = storedCreatedAtRaw === null ? NaN : Number(storedCreatedAtRaw);
    const isValidStoredId =
      storedId !== null && storedId.length >= 8 && storedId.length <= 64;
    const age = now - storedCreatedAt;
    if (isValidStoredId && Number.isFinite(storedCreatedAt) && age >= 0 && age < VISITOR_ID_ROTATION_MS) {
      return { id: storedId, createdAt: storedCreatedAt, isReturning: true };
    }
    const id = generateId();
    storage.setItem(VISITOR_ID_STORAGE_KEY, id);
    storage.setItem(VISITOR_ID_CREATED_AT_STORAGE_KEY, String(now));
    return { id, createdAt: now, isReturning: false };
  } catch {
    return { id: generateId(), createdAt: now, isReturning: false };
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}
