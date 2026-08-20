import type fs from "node:fs/promises";
import type { StatsFs } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PREMIERE_BOUNDED_WRITE_FLOOR_BYTES,
  PREMIERE_IMMUTABLE_MIRROR_RESERVE_BYTES,
  assertPremiereDurableWriteAdmission,
} from "../../../src/server/replay-premiere/ReplayPremierePrivateStaging";

/**
 * THE FLOOR'S OWN NEGATIVE COVERAGE.
 *
 * `assertPremiereDurableWriteAdmission` refuses a durable premiere write when
 * the destination is short on space. Until this file existed, every premiere
 * suite injected AMPLE space so it could assert premiere LOGIC without being
 * hostage to the host's disk — correct, and the reason a full host once turned
 * 268 tests red for no real defect. But it left the guard itself with no test
 * anywhere that watched it REFUSE: the call could have been deleted from both
 * of its callers and the whole suite would have stayed green.
 *
 * `ReplayPremiereFixtures` says it plainly — "a suite that means to test the
 * floor ITSELF must inject its own low value rather than rely on the machine
 * happening to be full." This is that suite.
 *
 * Every case pins its own `statfs`, so none of it depends on the machine it
 * runs on.
 */

/** `fs.statfs` is overloaded, so the double cast is what satisfies the seam. */
const diskWith = (availableBytes: number) =>
  (async () =>
    ({ bavail: availableBytes, bsize: 1 }) as StatsFs) as unknown as typeof fs.statfs;

const GIB = 1024 ** 3;

describe("premiere durable-write floor", () => {
  it("refuses a write when free space is under the bounded-write floor", async () => {
    await expect(
      assertPremiereDurableWriteAdmission({
        destinationPath: "/does/not/need/to/exist",
        pendingBytes: 0,
        statfs: diskWith(PREMIERE_BOUNDED_WRITE_FLOOR_BYTES - 1),
      }),
    ).rejects.toThrow(/durable_write_free_space_floor_not_met/);
  });

  it("admits a write when free space clears the floor", async () => {
    await expect(
      assertPremiereDurableWriteAdmission({
        destinationPath: "/does/not/need/to/exist",
        pendingBytes: 0,
        statfs: diskWith(PREMIERE_BOUNDED_WRITE_FLOOR_BYTES),
      }),
    ).resolves.toBeUndefined();
  });

  /**
   * The second arm, which the floor alone cannot catch. Here free space is
   * comfortably ABOVE the bounded-write floor, so a guard that only compared
   * against the floor would admit this write — but the pending bytes plus the
   * immutable mirror reserve do not fit. Deleting `pendingBytes` from the
   * requirement makes exactly this case pass and the others stay green.
   */
  it("counts the pending bytes on top of the mirror reserve, not just the floor", async () => {
    const pendingBytes = 20 * GIB;
    const available = PREMIERE_IMMUTABLE_MIRROR_RESERVE_BYTES + pendingBytes - 1;
    expect(available).toBeGreaterThan(PREMIERE_BOUNDED_WRITE_FLOOR_BYTES);

    await expect(
      assertPremiereDurableWriteAdmission({
        destinationPath: "/does/not/need/to/exist",
        pendingBytes,
        statfs: diskWith(available),
      }),
    ).rejects.toThrow(/durable_write_free_space_floor_not_met/);

    await expect(
      assertPremiereDurableWriteAdmission({
        destinationPath: "/does/not/need/to/exist",
        pendingBytes,
        statfs: diskWith(available + 1),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a nonsensical pending size before it ever reads the disk", async () => {
    const exploded = () => {
      throw new Error("statfs must not be reached for an invalid request");
    };
    for (const pendingBytes of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(
        assertPremiereDurableWriteAdmission({
          destinationPath: "/does/not/need/to/exist",
          pendingBytes,
          statfs: exploded as unknown as typeof fs.statfs,
        }),
      ).rejects.toThrow(/invalid_pending_write_bytes/);
    }
  });
});
