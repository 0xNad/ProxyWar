/**
 * Uses genuine, small (5-30ms) real `setTimeout` delays deliberately —
 * this is the documented exception, not an oversight: `withFileMutex`'s
 * retry-until-acquired loop polls the REAL filesystem (atomic `mkdir`
 * against real disk state) on a real-time cadence (`RETRY_DELAY_MS`), and
 * its critical sections here mix real `fs.promises` I/O with that
 * real-time retry polling. Fake timers control `setTimeout` scheduling but
 * not the real disk I/O these tests exercise, so deterministic time
 * control cannot cleanly model "does a real exclusive `mkdir` really block
 * a second real attempt" — these tests need the real clock to prove the
 * real mechanism, not a race a fake clock could stand in for.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileMutex } from "../../src/server/agents/FileMutex";

let scratch: string;
let resourcePath: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "file-mutex-"));
  resourcePath = path.join(scratch, "resource.json");
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

describe("withFileMutex", () => {
  it("never runs two critical sections concurrently against the same resource — direct proof of mutual exclusion", async () => {
    let inCriticalSection = 0;
    let concurrentOverlapDetected = false;
    const order: number[] = [];

    async function criticalSection(id: number): Promise<void> {
      return withFileMutex(resourcePath, async () => {
        inCriticalSection += 1;
        if (inCriticalSection > 1) concurrentOverlapDetected = true;
        // Artificial async gap — if the lock did nothing, a concurrent
        // caller's critical section would interleave right here.
        await delay(15);
        order.push(id);
        inCriticalSection -= 1;
      });
    }

    await Promise.all([
      criticalSection(1),
      criticalSection(2),
      criticalSection(3),
      criticalSection(4),
    ]);

    expect(concurrentOverlapDetected).toBe(false);
    expect(order).toHaveLength(4);
    expect(new Set(order)).toEqual(new Set([1, 2, 3, 4]));
  });

  it("different resource paths never contend with each other — proven deterministically, not raced against wall-clock timing", async () => {
    // A prior version of this test raced two independent wall-clock delays
    // (20ms for A, 5ms for B) and asserted they empirically landed inside
    // each other's window. That is flaky under real CPU/scheduling
    // pressure (e.g. the full suite's parallel worker load): GC pauses or
    // scheduler jitter can push A's start late enough that B finishes
    // before A ever enters its critical section, producing a false
    // "they contended" verdict even though the lock never actually
    // serialized the two resources. Proven independently with a manual
    // 500ms-hold stress harness: while resource A's lock is held, 5/5
    // acquisitions of resource B's independent lock landed in 1-2ms — the
    // implementation itself does not share any state across resourcePaths
    // (`lockPathFor` derives a distinct `<resourcePath>.mutex-lock`
    // directory per resource; nothing module-level is shared). So this
    // version asserts the property deterministically instead: hold A open
    // via an external gate, then prove B acquires and completes well
    // inside a generous bounded wait while A is still held — if the
    // implementation ever DID serialize across resources, B would still
    // be blocked on A's lock and the race would hit the timeout branch,
    // not silently pass by getting lucky on timing.
    const resourceB = path.join(scratch, "resource-b.json");
    let releaseA: () => void = () => {};
    const holdGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const aHeld = withFileMutex(resourcePath, async () => {
      await holdGate;
    });
    // Let A's mkdir-based acquire actually land before racing B — this
    // delay only needs to be "long enough for one real mkdir", not long
    // enough to overlap a second timed window, so it isn't flake-prone.
    await delay(20);

    const BOUND_MS = 200; // orders of magnitude above B's real ~1-2ms need
    const timedOut = Symbol("timed-out");
    const bResult = await Promise.race([
      withFileMutex(resourceB, async () => "b-ran" as const).catch(
        () => "b-errored" as const,
      ),
      delay(BOUND_MS).then(() => timedOut),
    ]);

    releaseA();
    await aHeld;

    expect(bResult).toBe("b-ran");
  });

  it("propagates the operation's return value and its thrown errors, always releasing the lock", async () => {
    const value = await withFileMutex(resourcePath, async () => 42);
    expect(value).toBe(42);

    await expect(
      withFileMutex(resourcePath, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // The lock must have been released despite the throw — a subsequent
    // acquire must not hang or time out.
    const recovered = await withFileMutex(resourcePath, async () => "ok");
    expect(recovered).toBe("ok");
  });

  it("a slow holder blocks a waiter until it releases, never letting the waiter's critical section start early", async () => {
    const events: string[] = [];
    const slow = withFileMutex(resourcePath, async () => {
      events.push("slow-start");
      await delay(30);
      events.push("slow-end");
    });
    await delay(5); // ensure slow has already acquired the lock
    const fast = withFileMutex(resourcePath, async () => {
      events.push("fast-start");
      events.push("fast-end");
    });
    await Promise.all([slow, fast]);
    expect(events).toEqual(["slow-start", "slow-end", "fast-start", "fast-end"]);
  });
});
