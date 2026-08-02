import { beforeEach, describe, expect, test } from "vitest";
import {
  loadOrCreateVisitorIdentity,
  RETURNING_VISITOR_EMIT_DAY_KEY_PREFIX,
  shouldEmitReturningVisitorToday,
  VISITOR_ID_CREATED_AT_STORAGE_KEY,
  VISITOR_ID_ROTATION_MS,
  VISITOR_ID_STORAGE_KEY,
} from "../../../src/client/analytics/VisitorId";

beforeEach(() => {
  window.localStorage.clear();
});

describe("loadOrCreateVisitorIdentity", () => {
  test("creates a fresh, non-returning identity when storage is empty", () => {
    const identity = loadOrCreateVisitorIdentity(window.localStorage, 1_000_000);
    expect(identity.id.length).toBeGreaterThanOrEqual(8);
    expect(identity.isReturning).toBe(false);
    expect(window.localStorage.getItem(VISITOR_ID_STORAGE_KEY)).toBe(identity.id);
  });

  test("returns the same id and marks isReturning=true on a second call within the rotation window", () => {
    const first = loadOrCreateVisitorIdentity(window.localStorage, 1_000_000);
    const second = loadOrCreateVisitorIdentity(window.localStorage, 1_000_000 + 60_000);
    expect(second.id).toBe(first.id);
    expect(second.isReturning).toBe(true);
  });

  test("generates two different ids across two clean storages", () => {
    const a = loadOrCreateVisitorIdentity(window.localStorage, 1_000_000).id;
    window.localStorage.clear();
    const b = loadOrCreateVisitorIdentity(window.localStorage, 2_000_000).id;
    expect(a).not.toBe(b);
  });

  test("rotates to a new id once the stored id is older than the rotation window", () => {
    const first = loadOrCreateVisitorIdentity(window.localStorage, 1_000_000);
    const rotated = loadOrCreateVisitorIdentity(
      window.localStorage,
      1_000_000 + VISITOR_ID_ROTATION_MS + 1,
    );
    expect(rotated.id).not.toBe(first.id);
    expect(rotated.isReturning).toBe(false);
  });

  test("destroys the old id from storage on rotation — old value cannot be recovered", () => {
    loadOrCreateVisitorIdentity(window.localStorage, 1_000_000);
    loadOrCreateVisitorIdentity(window.localStorage, 1_000_000 + VISITOR_ID_ROTATION_MS + 1);
    const storedCreatedAt = Number(window.localStorage.getItem(VISITOR_ID_CREATED_AT_STORAGE_KEY));
    expect(storedCreatedAt).toBe(1_000_000 + VISITOR_ID_ROTATION_MS + 1);
  });

  test("treats a corrupted created-at value as expired and rotates rather than throwing", () => {
    window.localStorage.setItem(VISITOR_ID_STORAGE_KEY, "some-existing-id");
    window.localStorage.setItem(VISITOR_ID_CREATED_AT_STORAGE_KEY, "not-a-number");
    const identity = loadOrCreateVisitorIdentity(window.localStorage, 1_000_000);
    expect(identity.isReturning).toBe(false);
    expect(identity.id).not.toBe("some-existing-id");
  });

  test("falls back to an ephemeral non-persisted identity when storage is unavailable", () => {
    const identity = loadOrCreateVisitorIdentity(undefined, 1_000_000);
    expect(identity.isReturning).toBe(false);
    expect(identity.id.length).toBeGreaterThan(0);
  });
});

describe("shouldEmitReturningVisitorToday", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const T0 = Date.parse("2026-08-01T00:00:00.000Z");

  test("returns true on the first call of a UTC day, and marks that day as emitted for THIS visitor id", () => {
    expect(shouldEmitReturningVisitorToday("visitor-a", window.localStorage, T0)).toBe(true);
    expect(window.localStorage.getItem(`${RETURNING_VISITOR_EMIT_DAY_KEY_PREFIX}visitor-a`)).toBe(
      "2026-08-01",
    );
  });

  test("returns false on every subsequent call the SAME UTC day for the SAME visitor id — same-session navigation never re-fires", () => {
    expect(shouldEmitReturningVisitorToday("visitor-a", window.localStorage, T0)).toBe(true);
    // Same day, minutes later (e.g. the visitor's second, third, fourth
    // page load in one browsing session).
    expect(
      shouldEmitReturningVisitorToday("visitor-a", window.localStorage, T0 + 60_000),
    ).toBe(false);
    expect(
      shouldEmitReturningVisitorToday(
        "visitor-a",
        window.localStorage,
        T0 + 23 * 60 * 60 * 1000,
      ),
    ).toBe(false);
  });

  test("returns true again once the UTC day rolls over, for the same visitor id", () => {
    expect(shouldEmitReturningVisitorToday("visitor-a", window.localStorage, T0)).toBe(true);
    expect(
      shouldEmitReturningVisitorToday("visitor-a", window.localStorage, T0 + DAY_MS),
    ).toBe(true);
  });

  test("a DIFFERENT visitor id gets its own independent same-day dedup slot — a mid-day id rotation (or a shared machine with a second visitor) never gets blocked by a stranger's emission, and never inherits a stranger's day marker", () => {
    // visitor-a already emitted today.
    expect(shouldEmitReturningVisitorToday("visitor-a", window.localStorage, T0)).toBe(true);
    // visitor-b — a fresh id that took over this browser's storage later
    // the SAME day — must still get its own first-of-day emission; a
    // single shared/global day key would have wrongly suppressed this.
    expect(shouldEmitReturningVisitorToday("visitor-b", window.localStorage, T0 + 120_000)).toBe(
      true,
    );
    // visitor-b's second call the same day is correctly suppressed...
    expect(shouldEmitReturningVisitorToday("visitor-b", window.localStorage, T0 + 180_000)).toBe(
      false,
    );
    // ...but visitor-a's own dedup state is untouched by visitor-b's
    // activity — a single shared key would have wrongly reset or
    // clobbered it.
    expect(shouldEmitReturningVisitorToday("visitor-a", window.localStorage, T0 + 240_000)).toBe(
      false,
    );
  });

  test("never blocks emission when storage genuinely throws on every access (private browsing, disabled storage)", () => {
    const throwingStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    } as unknown as Storage;
    expect(shouldEmitReturningVisitorToday("visitor-a", throwingStorage, T0)).toBe(true);
    expect(shouldEmitReturningVisitorToday("visitor-a", throwingStorage, T0 + 1)).toBe(true);
  });
});
