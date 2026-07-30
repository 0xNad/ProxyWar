/**
 * The account authority's origin, in ONE place.
 *
 * `PROXYWAR_PLATFORM_ORIGIN` configures it; this is what every consumer falls
 * back to when it is unset. It was previously copy-pasted as
 * `?? "https://app.proxywar.xyz"` into four files — the client's profile-link
 * helper, the league site writer, the demo server's CSP origin, and Vite's
 * build-time `define` — and the 2026-07-30 apex cutover proved why that is a
 * defect rather than a style question: moving the origin updated the platform's
 * own env and left the *betting* process (which sets no
 * `PROXYWAR_PLATFORM_ORIGIN`) serving league documents with
 * `connect-src 'self' https://app.proxywar.xyz`.
 *
 * That failure mode is invisible. The stale host still answers — it 302s to the
 * apex — but CSP is enforced against redirect targets too, so the credentialed
 * `/api/account/pov-claims` fetch behind it dies as a console violation with no
 * failed response and no server-side trace. Four copies of a constant meant
 * four chances to miss one; there is now one.
 */
export const DEFAULT_PLATFORM_ORIGIN = "https://proxywar.xyz";
