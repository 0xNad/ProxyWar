import { beforeEach, describe, expect, test } from "vitest";
import {
  loadOrCreateVisitorIdentity,
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
