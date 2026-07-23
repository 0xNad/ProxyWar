import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  AI_LEAGUE_CLIP_CANARY_FILE,
  AI_LEAGUE_CLIP_CANARY_LOCK_FILE,
  AI_LEAGUE_CLIP_CANARY_LOCK_MAX_BYTES,
  AI_LEAGUE_CLIP_CANARY_MAX_BYTES,
  armAiLeagueClipCanary,
  claimAiLeagueClipCanary,
  disarmAiLeagueClipCanary,
  parseAiLeagueClipCanaryRecord,
  readAiLeagueClipCanary,
  type AiLeagueClipCanaryRecord,
  type AiLeagueClipCanaryTarget,
} from "../../src/server/agents/AiLeagueClipCanary";

const NOW_MS = Date.parse("2026-07-23T20:00:00.000Z");
const TARGET: AiLeagueClipCanaryTarget = {
  runKey: "league-coworld-canary-1234abcd",
  bucket: 60,
  sourceReplaySha256: "a".repeat(64),
};

let root: string;
let statePath: string;
let lockPath: string;

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pw-clip-canary-")),
  );
  await fs.chmod(root, 0o700);
  statePath = path.join(root, AI_LEAGUE_CLIP_CANARY_FILE);
  lockPath = path.join(root, AI_LEAGUE_CLIP_CANARY_LOCK_FILE);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function armedRecord(
  overrides: Partial<AiLeagueClipCanaryRecord> = {},
): AiLeagueClipCanaryRecord {
  return {
    schemaVersion: 1,
    lifecycle: "armed",
    ...TARGET,
    armedAt: new Date(NOW_MS).toISOString(),
    expiresAt: new Date(NOW_MS + 10 * 60_000).toISOString(),
    claimedAt: null,
    disarmedAt: null,
    ...overrides,
  };
}

async function writeState(
  value: string | AiLeagueClipCanaryRecord,
  mode = 0o600,
): Promise<void> {
  await fs.writeFile(
    statePath,
    typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
    { mode },
  );
}

describe("strict clip canary v1 state", () => {
  test("defaults off when the record is missing", async () => {
    await expect(
      readAiLeagueClipCanary({ privateStateRoot: root, now: () => NOW_MS }),
    ).resolves.toMatchObject({
      enabled: false,
      record: null,
      diagnostic: { code: "clip_canary_state_missing" },
    });
  });

  test("accepts only exact keys, canonical timestamps, target grammar, and a 30-minute arm", () => {
    expect(
      parseAiLeagueClipCanaryRecord(JSON.stringify(armedRecord())),
    ).toEqual(armedRecord());
    for (const invalid of [
      { ...armedRecord(), extra: true },
      { ...armedRecord(), schemaVersion: 2 },
      { ...armedRecord(), runKey: "coworld-not-public" },
      { ...armedRecord(), bucket: 0 },
      { ...armedRecord(), sourceReplaySha256: "A".repeat(64) },
      { ...armedRecord(), armedAt: "2026-07-23T20:00:00Z" },
      {
        ...armedRecord(),
        expiresAt: new Date(NOW_MS + 30 * 60_000 + 1).toISOString(),
      },
      { ...armedRecord(), lifecycle: "claimed", claimedAt: null },
      {
        ...armedRecord(),
        lifecycle: "disarmed",
        disarmedAt: null,
      },
    ]) {
      expect(parseAiLeagueClipCanaryRecord(JSON.stringify(invalid))).toBeNull();
    }
  });

  test("fails closed for malformed, oversized, symlinked, non-regular, wrong-mode, wrong-owner, and hardlinked state", async () => {
    await writeState("{not json");
    expect(
      (await readAiLeagueClipCanary({ privateStateRoot: root })).diagnostic
        .code,
    ).toBe("clip_canary_state_malformed");

    await fs.writeFile(
      statePath,
      Buffer.alloc(AI_LEAGUE_CLIP_CANARY_MAX_BYTES + 1),
    );
    expect(
      (await readAiLeagueClipCanary({ privateStateRoot: root })).diagnostic
        .code,
    ).toBe("clip_canary_state_too_large");

    await fs.rm(statePath);
    const outside = path.join(root, "outside.json");
    await fs.writeFile(outside, JSON.stringify(armedRecord()), { mode: 0o600 });
    await fs.symlink(outside, statePath);
    expect(
      (await readAiLeagueClipCanary({ privateStateRoot: root })).diagnostic
        .code,
    ).toBe("clip_canary_state_symlink");

    await fs.rm(statePath);
    await fs.mkdir(statePath);
    expect(
      (await readAiLeagueClipCanary({ privateStateRoot: root })).diagnostic
        .code,
    ).toBe("clip_canary_state_not_regular");

    await fs.rm(statePath, { recursive: true });
    await writeState(armedRecord(), 0o644);
    expect(
      (await readAiLeagueClipCanary({ privateStateRoot: root })).diagnostic
        .code,
    ).toBe("clip_canary_state_wrong_mode");

    await fs.chmod(statePath, 0o600);
    const actualUid = process.getuid?.();
    if (actualUid !== undefined) {
      expect(
        (
          await readAiLeagueClipCanary({
            privateStateRoot: root,
            expectedFileUid: actualUid + 1,
          })
        ).diagnostic.code,
      ).toBe("clip_canary_state_wrong_owner");
    }

    const hardlink = path.join(root, "hardlink.json");
    await fs.link(statePath, hardlink);
    expect(
      (await readAiLeagueClipCanary({ privateStateRoot: root })).diagnostic
        .code,
    ).toBe("clip_canary_state_hardlinked");
  });

  test("expiry disables both an unclaimed arm and claimed read authority", async () => {
    await writeState(armedRecord());
    expect(
      (
        await readAiLeagueClipCanary({
          privateStateRoot: root,
          now: () => NOW_MS + 10 * 60_000,
        })
      ).diagnostic.code,
    ).toBe("clip_canary_state_expired");

    await writeState(
      armedRecord({
        lifecycle: "claimed",
        claimedAt: new Date(NOW_MS + 1).toISOString(),
      }),
    );
    const claimed = await readAiLeagueClipCanary({
      privateStateRoot: root,
      now: () => NOW_MS + 60 * 60_000,
    });
    expect(claimed).toMatchObject({
      enabled: false,
      claimable: false,
      readEnabled: false,
      diagnostic: { code: "clip_canary_state_expired" },
      record: { lifecycle: "claimed" },
    });
  });
});

describe("durable clip canary transitions", () => {
  test("atomically arms, claims once, and idempotently disarms without deleting evidence", async () => {
    const armed = await armAiLeagueClipCanary({
      privateStateRoot: root,
      target: TARGET,
      expiresAt: new Date(NOW_MS + 10 * 60_000).toISOString(),
      now: () => NOW_MS,
    });
    expect(armed.lifecycle).toBe("armed");
    expect((await fs.lstat(statePath)).mode & 0o777).toBe(0o600);
    await expect(
      fs.lstat(path.join(root, AI_LEAGUE_CLIP_CANARY_LOCK_FILE)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const claimed = await claimAiLeagueClipCanary({
      privateStateRoot: root,
      expectedTarget: TARGET,
      now: () => NOW_MS + 1_000,
    });
    expect(claimed).toMatchObject({
      lifecycle: "claimed",
      claimedAt: new Date(NOW_MS + 1_000).toISOString(),
    });
    await expect(
      claimAiLeagueClipCanary({
        privateStateRoot: root,
        expectedTarget: TARGET,
        now: () => NOW_MS + 2_000,
      }),
    ).rejects.toThrow("clip_canary_claim_refused:clip_canary_state_claimed");

    const firstDisarm = await disarmAiLeagueClipCanary({
      privateStateRoot: root,
      now: () => NOW_MS + 3_000,
    });
    const persistedAfterFirst = await fs.readFile(statePath, "utf8");
    const repeated = await disarmAiLeagueClipCanary({
      privateStateRoot: root,
      now: () => NOW_MS + 4_000,
    });
    expect(repeated.record).toEqual(firstDisarm.record);
    expect(await fs.readFile(statePath, "utf8")).toBe(persistedAfterFirst);
    expect(repeated.record).toMatchObject({
      lifecycle: "disarmed",
      runKey: TARGET.runKey,
      claimedAt: claimed.claimedAt,
      disarmedAt: new Date(NOW_MS + 3_000).toISOString(),
    });
  });

  test("recovers one strictly verified stale lock and permits durable disarm", async () => {
    await armAiLeagueClipCanary({
      privateStateRoot: root,
      target: TARGET,
      expiresAt: new Date(NOW_MS + 10 * 60_000).toISOString(),
      now: () => NOW_MS,
    });
    await writeLock(999_999);
    const probed: number[] = [];

    const disarmed = await disarmAiLeagueClipCanary({
      privateStateRoot: root,
      now: () => NOW_MS + 1_000,
      mutationLockHost: {
        processStatus: (pid) => {
          probed.push(pid);
          return "absent";
        },
      },
    });

    expect(probed).toEqual([999_999]);
    expect(disarmed.record?.lifecycle).toBe("disarmed");
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses live, reused, or unverifiable lock-owner pids without mutating state or lock", async () => {
    await armAiLeagueClipCanary({
      privateStateRoot: root,
      target: TARGET,
      expiresAt: new Date(NOW_MS + 10 * 60_000).toISOString(),
      now: () => NOW_MS,
    });
    await writeLock(777_777);
    const originalLock = await fs.readFile(lockPath, "utf8");

    for (const [status, diagnostic] of [
      ["alive", "clip_canary_mutation_lock_owner_pid_live"],
      ["unknown", "clip_canary_mutation_lock_owner_pid_unverifiable"],
    ] as const) {
      await expect(
        disarmAiLeagueClipCanary({
          privateStateRoot: root,
          now: () => NOW_MS + 1_000,
          mutationLockHost: { processStatus: () => status },
        }),
      ).rejects.toThrow(diagnostic);
      expect(await fs.readFile(lockPath, "utf8")).toBe(originalLock);
      expect(
        (
          await readAiLeagueClipCanary({
            privateStateRoot: root,
            now: () => NOW_MS + 1_000,
          })
        ).record?.lifecycle,
      ).toBe("armed");
    }
  });

  test("fails closed on malformed, foreign, oversized, non-regular, wrong-mode, hardlinked, and symlinked locks", async () => {
    await armAiLeagueClipCanary({
      privateStateRoot: root,
      target: TARGET,
      expiresAt: new Date(NOW_MS + 10 * 60_000).toISOString(),
      now: () => NOW_MS,
    });
    const attempt = () =>
      disarmAiLeagueClipCanary({
        privateStateRoot: root,
        now: () => NOW_MS + 1_000,
        mutationLockHost: { processStatus: () => "absent" },
      });

    await fs.writeFile(lockPath, "{malformed", { mode: 0o600 });
    await expect(attempt()).rejects.toThrow(
      "clip_canary_mutation_lock_malformed",
    );
    await fs.rm(lockPath);

    await fs.writeFile(
      lockPath,
      '{"schemaVersion":1,"pid":999999,"foreign":true}\n',
      { mode: 0o600 },
    );
    await expect(attempt()).rejects.toThrow(
      "clip_canary_mutation_lock_malformed",
    );
    await fs.rm(lockPath);

    await fs.writeFile(
      lockPath,
      Buffer.alloc(AI_LEAGUE_CLIP_CANARY_LOCK_MAX_BYTES + 1),
      { mode: 0o600 },
    );
    await expect(attempt()).rejects.toThrow(
      "clip_canary_mutation_lock_too_large",
    );
    await fs.rm(lockPath);

    await fs.mkdir(lockPath, { mode: 0o700 });
    await expect(attempt()).rejects.toThrow(
      "clip_canary_mutation_lock_not_regular",
    );
    await fs.rm(lockPath, { recursive: true });

    await writeLock(999_999, 0o644);
    await expect(attempt()).rejects.toThrow(
      "clip_canary_mutation_lock_wrong_mode",
    );
    await fs.rm(lockPath);

    await writeLock(999_999);
    const hardlink = path.join(root, "lock-hardlink");
    await fs.link(lockPath, hardlink);
    await expect(attempt()).rejects.toThrow(
      "clip_canary_mutation_lock_hardlinked",
    );
    await fs.rm(lockPath);
    await fs.rm(hardlink);

    const symlinkTarget = path.join(root, "lock-symlink-target");
    await fs.writeFile(symlinkTarget, '{"schemaVersion":1,"pid":999999}\n', {
      mode: 0o600,
    });
    await fs.symlink(symlinkTarget, lockPath);
    await expect(attempt()).rejects.toThrow(
      "clip_canary_mutation_lock_symlink",
    );
    expect(
      (
        await readAiLeagueClipCanary({
          privateStateRoot: root,
          now: () => NOW_MS + 1_000,
        })
      ).record?.lifecycle,
    ).toBe("armed");
  });

  test("refuses an inode replacement between verified read and stale unlink", async () => {
    await armAiLeagueClipCanary({
      privateStateRoot: root,
      target: TARGET,
      expiresAt: new Date(NOW_MS + 10 * 60_000).toISOString(),
      now: () => NOW_MS,
    });
    await writeLock(999_999);
    const displaced = path.join(root, "displaced-stale-lock");
    let probes = 0;

    await expect(
      disarmAiLeagueClipCanary({
        privateStateRoot: root,
        now: () => NOW_MS + 1_000,
        mutationLockHost: {
          processStatus: () => {
            probes += 1;
            return "absent";
          },
          beforeStaleLockUnlink: async (currentLockPath) => {
            await fs.rename(currentLockPath, displaced);
            await writeLock(888_888);
          },
        },
      }),
    ).rejects.toThrow("clip_canary_mutation_lock_changed_during_recovery");
    expect(probes).toBe(0);
    expect(await fs.readFile(lockPath, "utf8")).toContain('"pid":888888');
  });

  test("rechecks pathname identity after an asynchronous pid probe and preserves its replacement", async () => {
    await armAiLeagueClipCanary({
      privateStateRoot: root,
      target: TARGET,
      expiresAt: new Date(NOW_MS + 10 * 60_000).toISOString(),
      now: () => NOW_MS,
    });
    await writeLock(999_999);
    const displaced = path.join(root, "pid-probe-displaced-lock");

    await expect(
      disarmAiLeagueClipCanary({
        privateStateRoot: root,
        now: () => NOW_MS + 1_000,
        mutationLockHost: {
          processStatus: async () => {
            await fs.rename(lockPath, displaced);
            await writeLock(777_777);
            return "absent" as const;
          },
        },
      }),
    ).rejects.toThrow("clip_canary_mutation_lock_changed_during_recovery");
    expect(await fs.readFile(lockPath, "utf8")).toContain('"pid":777777');
    expect(
      (
        await readAiLeagueClipCanary({
          privateStateRoot: root,
          now: () => NOW_MS + 1_000,
        })
      ).record?.lifecycle,
    ).toBe("armed");
  });

  test("release proves its open handle still owns the pathname and preserves a replacement", async () => {
    await armAiLeagueClipCanary({
      privateStateRoot: root,
      target: TARGET,
      expiresAt: new Date(NOW_MS + 10 * 60_000).toISOString(),
      now: () => NOW_MS,
    });
    const displaced = path.join(root, "release-displaced-lock");

    await expect(
      disarmAiLeagueClipCanary({
        privateStateRoot: root,
        now: () => NOW_MS + 1_000,
        mutationLockHost: {
          processStatus: () => "absent",
          beforeMutationLockRelease: async (currentLockPath) => {
            await fs.rename(currentLockPath, displaced);
            await writeLock(555_555);
          },
        },
      }),
    ).rejects.toThrow("clip_canary_mutation_lock_release_uncertain");
    expect(await fs.readFile(lockPath, "utf8")).toContain('"pid":555555');
    expect((await fs.lstat(displaced)).isFile()).toBe(true);
    expect(
      (
        await readAiLeagueClipCanary({
          privateStateRoot: root,
          now: () => NOW_MS + 1_000,
        })
      ).record?.lifecycle,
    ).toBe("disarmed");
  });

  test("retries exclusive creation once and preserves a racing replacement lock", async () => {
    await armAiLeagueClipCanary({
      privateStateRoot: root,
      target: TARGET,
      expiresAt: new Date(NOW_MS + 10 * 60_000).toISOString(),
      now: () => NOW_MS,
    });
    await writeLock(999_999);

    await expect(
      disarmAiLeagueClipCanary({
        privateStateRoot: root,
        now: () => NOW_MS + 1_000,
        mutationLockHost: {
          processStatus: () => "absent",
          afterStaleLockRemoval: async () => writeLock(666_666),
        },
      }),
    ).rejects.toThrow("clip_canary_mutation_lock_retry_blocked");
    expect(await fs.readFile(lockPath, "utf8")).toContain('"pid":666666');
    expect(
      (
        await readAiLeagueClipCanary({
          privateStateRoot: root,
          now: () => NOW_MS + 1_000,
        })
      ).record?.lifecycle,
    ).toBe("armed");
  });

  test("refuses claim when the expected target changed", async () => {
    await armAiLeagueClipCanary({
      privateStateRoot: root,
      target: TARGET,
      expiresAt: new Date(NOW_MS + 10 * 60_000).toISOString(),
      now: () => NOW_MS,
    });
    await expect(
      claimAiLeagueClipCanary({
        privateStateRoot: root,
        expectedTarget: { ...TARGET, bucket: 61 },
        now: () => NOW_MS + 1_000,
      }),
    ).rejects.toThrow("clip_canary_claim_target_mismatch");
  });
});

async function writeLock(pid: number, mode = 0o600): Promise<void> {
  await fs.writeFile(
    lockPath,
    `${JSON.stringify({ schemaVersion: 1, pid })}\n`,
    {
      mode,
    },
  );
}
