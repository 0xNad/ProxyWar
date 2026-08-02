/**
 * Serializes every identity-minting network call on a page behind the FIRST
 * one to start — closing a real, live-reproduced race (P0, 2026-08-02):
 * several independent client subsystems mounted together on one page
 * (`PremiereGithubSignIn`'s `/api/identity/status` poll,
 * `ReplayPremiereRuntime`'s `POST .../sessions` bootstrap, `AccountPage`'s
 * own account read, `PointsLeaderboard`'s leaderboard read) each hit an
 * endpoint that mints a fresh signed guest cookie via `Set-Cookie` when none
 * exists yet (`ReplayPremiereGuestSecurity.bootstrap()` and
 * `PlatformAccountSecurity`'s sibling — both correctly REUSE an existing
 * cookie; the gap is purely that nothing on the client stops them firing
 * concurrently on a cold load).
 *
 * Fired concurrently on a cold page load — before ANY of their responses
 * have round-tripped — each one independently sees no cookie in ITS OWN
 * request and mints its own distinct guest identity. The browser keeps
 * whichever `Set-Cookie` lands LAST; every other concurrently-minted
 * identity (and anything recorded against it — e.g. a wagering session's
 * trade) becomes permanently unreachable the instant a later response wins,
 * discovered only on the next authenticated read or reload as an
 * inexplicable "fresh guest, 1,000cr, no positions" state. Live-reproduced
 * via CDP against a real cold load of `/bet/<id>`: `/api/identity/status`
 * minted `guest_14fe29a1...`, `POST .../sessions` concurrently minted a
 * DIFFERENT `guest_1dd20142...` — two competing identities from one visit.
 *
 * This is NOT new identity semantics — `bootstrap()` already reuses an
 * existing cookie correctly. The fix only adds an ordering guarantee: the
 * first identity-touching call on the page wins the mint, and every other
 * such call waits for it to land before firing its own request. By the time
 * a waiter runs, the winner's cookie is already set, so the server sees
 * `existing !== null` and reuses it instead of minting again.
 *
 * One gate per page load (module-level singleton, not per-component) — a
 * reload starts clean, intentionally: a fresh load is exactly when the race
 * exists, so the gate must live exactly as long as that window does.
 */
let firstBootstrap: Promise<void> | null = null;

/**
 * Runs `run` — the caller's own identity-touching fetch — after any earlier
 * caller's own fetch on this page has completed. The first caller on a page
 * runs immediately (its own request IS the bootstrap; no extra round trip is
 * spent). Every later caller awaits the first's completion (success OR
 * failure — a failed winner must never wedge every other caller behind it
 * forever) before running its own `run`.
 */
export async function afterFirstIdentityBootstrap<T>(
  run: () => Promise<T>,
): Promise<T> {
  if (firstBootstrap === null) {
    const winner = run();
    firstBootstrap = winner.then(
      () => undefined,
      () => undefined,
    );
    return winner;
  }
  await firstBootstrap;
  return run();
}

/** Test-only: resets the module-level gate between test cases. */
export function resetGuestBootstrapGateForTests(): void {
  firstBootstrap = null;
}
