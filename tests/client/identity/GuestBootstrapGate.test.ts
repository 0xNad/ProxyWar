import { describe, expect, test, beforeEach } from "vitest";
import {
  afterFirstIdentityBootstrap,
  resetGuestBootstrapGateForTests,
} from "../../../src/client/identity/GuestBootstrapGate";

describe("afterFirstIdentityBootstrap", () => {
  beforeEach(() => {
    resetGuestBootstrapGateForTests();
  });

  test("the first caller on a page runs immediately, spending no extra round trip", async () => {
    let started = false;
    const result = await afterFirstIdentityBootstrap(async () => {
      started = true;
      return "first";
    });
    expect(started).toBe(true);
    expect(result).toBe("first");
  });

  test("a second concurrent caller does not start its own request until the first has resolved -- the exact race this closes: two identity-minting calls fired together on a cold load must never both see 'no cookie yet' at once", async () => {
    const order: string[] = [];
    let resolveFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });

    const firstCall = afterFirstIdentityBootstrap(async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
      return "first";
    });

    // Fired concurrently, exactly like GithubSignIn's connectedCallback and
    // ReplayPremiereRuntime's session bootstrap both firing on the same
    // cold page load -- the second caller must not start its OWN fetch
    // until the first one has actually landed.
    const secondCall = afterFirstIdentityBootstrap(async () => {
      order.push("second-start");
      return "second";
    });

    // Give the microtask queue a turn: the second caller must still be
    // waiting on the gate, not already running its own request.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);

    resolveFirst!();
    const [firstResult, secondResult] = await Promise.all([
      firstCall,
      secondCall,
    ]);

    expect(order).toEqual(["first-start", "first-end", "second-start"]);
    expect(firstResult).toBe("first");
    expect(secondResult).toBe("second");
  });

  test("a failed first caller does not wedge every later caller behind it forever", async () => {
    const first = afterFirstIdentityBootstrap(async () => {
      throw new Error("network_error");
    });
    await expect(first).rejects.toThrow("network_error");

    let secondRan = false;
    const second = await afterFirstIdentityBootstrap(async () => {
      secondRan = true;
      return "recovered";
    });
    expect(secondRan).toBe(true);
    expect(second).toBe("recovered");
  });

  test("once the first bootstrap has landed, later callers run concurrently with each other -- the cookie already exists by then, so there is no more race to serialize against", async () => {
    await afterFirstIdentityBootstrap(async () => "first");
    const order: string[] = [];
    let resolveSecond: (() => void) | null = null;
    const secondGate = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const second = afterFirstIdentityBootstrap(async () => {
      order.push("second-start");
      await secondGate;
      order.push("second-end");
      return "second-result";
    });
    const third = afterFirstIdentityBootstrap(async () => {
      order.push("third-start");
      return "third-result";
    });
    // Both started without waiting on each other -- "third" is not blocked
    // behind "second" the way "second" would have been blocked behind an
    // in-flight "first".
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["second-start", "third-start"]);
    resolveSecond!();
    await Promise.all([second, third]);
  });
});
