import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import {
  loadOrCreateReplayPremiereGuestHmacKey,
  resolveReplayPremierePrivateStateRoot,
} from "../../../src/server/replay-premiere/ReplayPremiereSecrets";

describe("ReplayPremiere secret storage", () => {
  let root: string;
  let servedRoot: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(realTemporaryRoot, "premiere-secret-"));
    servedRoot = path.join(root, "served");
    await fs.mkdir(servedRoot, { mode: 0o755 });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("resolves the durable default and explicit absolute override", () => {
    expect(resolveReplayPremierePrivateStateRoot({}, "/Users/tester")).toBe(
      "/Users/tester/Library/Application Support/ProxyWar/storage/replay-premiere",
    );
    expect(
      resolveReplayPremierePrivateStateRoot(
        { PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: "/private/premiere" },
        "/Users/tester",
      ),
    ).toBe("/private/premiere");
    expect(() =>
      resolveReplayPremierePrivateStateRoot(
        { PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: "/" },
        "/Users/tester",
      ),
    ).toThrow();
  });

  test("atomically creates one restart-stable 0600 key under a private root", async () => {
    const stateRoot = path.join(root, "private");
    const keys = await Promise.all(
      Array.from({ length: 8 }, () =>
        loadOrCreateReplayPremiereGuestHmacKey({
          privateStateRoot: stateRoot,
          servedRoots: [servedRoot],
        }),
      ),
    );
    expect(
      keys.every((key) => Buffer.from(key).equals(Buffer.from(keys[0]))),
    ).toBe(true);
    expect(keys[0]).toHaveLength(32);
    const keyPath = path.join(stateRoot, "guest-hmac-key-v1.bin");
    const [rootStat, keyStat] = await Promise.all([
      fs.stat(stateRoot),
      fs.stat(keyPath),
    ]);
    expect(rootStat.mode & 0o077).toBe(0);
    expect(keyStat.mode & 0o077).toBe(0);
    expect(keyStat.nlink).toBe(1);
    expect(
      Buffer.from(
        await loadOrCreateReplayPremiereGuestHmacKey({
          privateStateRoot: stateRoot,
          servedRoots: [servedRoot],
        }),
      ).equals(Buffer.from(keys[0])),
    ).toBe(true);
  });

  test("rejects a symlink key and accepts a stable explicit hex override", async () => {
    const stateRoot = path.join(root, "private");
    await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const outside = path.join(root, "outside-key");
    await fs.writeFile(outside, Buffer.alloc(32, 9), { mode: 0o600 });
    await fs.symlink(outside, path.join(stateRoot, "guest-hmac-key-v1.bin"));
    await expect(
      loadOrCreateReplayPremiereGuestHmacKey({
        privateStateRoot: stateRoot,
        servedRoots: [servedRoot],
      }),
    ).rejects.toBeDefined();

    const configured = await loadOrCreateReplayPremiereGuestHmacKey({
      privateStateRoot: path.join(root, "unused"),
      servedRoots: [servedRoot],
      configuredHex: "ab".repeat(32),
    });
    expect(Buffer.from(configured).toString("hex")).toBe("ab".repeat(32));
  });

  test("rejects a state root equal to, inside, or containing a served root", async () => {
    const containingRoot = path.join(root, "contains-served");
    const nestedServedRoot = path.join(containingRoot, "public");
    for (const [privateStateRoot, servedRoots] of [
      [servedRoot, [servedRoot]],
      [path.join(servedRoot, "private"), [servedRoot]],
      [containingRoot, [nestedServedRoot]],
    ] as const) {
      await expect(
        loadOrCreateReplayPremiereGuestHmacKey({
          privateStateRoot,
          servedRoots,
        }),
      ).rejects.toMatchObject({
        operatorCode: "private_state_root_overlaps_served_root",
      });
    }
  });

  test("rejects a canonical served-root alias that resolves onto private state", async () => {
    const stateRoot = path.join(root, "private-canonical-alias");
    const servedAlias = path.join(root, "served-private-alias");
    await fs.mkdir(stateRoot, { mode: 0o700 });
    await fs.symlink(stateRoot, servedAlias);

    await expect(
      loadOrCreateReplayPremiereGuestHmacKey({
        privateStateRoot: stateRoot,
        servedRoots: [servedAlias],
      }),
    ).rejects.toMatchObject({
      operatorCode: "private_state_root_overlaps_served_root",
    });
  });

  test("rejects a symlink ancestor without writing through it", async () => {
    const actualParent = path.join(root, "actual-parent");
    const linkedParent = path.join(root, "linked-parent");
    await fs.mkdir(actualParent, { mode: 0o700 });
    await fs.symlink(actualParent, linkedParent);

    await expect(
      loadOrCreateReplayPremiereGuestHmacKey({
        privateStateRoot: path.join(linkedParent, "private"),
        servedRoots: [servedRoot],
      }),
    ).rejects.toMatchObject({
      operatorCode: "private_state_root_symlink_ancestor",
    });
    await expect(
      fs.access(path.join(actualParent, "private", "guest-hmac-key-v1.bin")),
    ).rejects.toBeDefined();
  });

  test("rejects weakened root and key permissions", async () => {
    const stateRoot = path.join(root, "private-permissions");
    await loadOrCreateReplayPremiereGuestHmacKey({
      privateStateRoot: stateRoot,
      servedRoots: [servedRoot],
    });

    await fs.chmod(stateRoot, 0o750);
    await expect(
      loadOrCreateReplayPremiereGuestHmacKey({
        privateStateRoot: stateRoot,
        servedRoots: [servedRoot],
      }),
    ).rejects.toMatchObject({
      operatorCode: "private_state_root_not_private",
    });

    await fs.chmod(stateRoot, 0o700);
    await fs.chmod(path.join(stateRoot, "guest-hmac-key-v1.bin"), 0o640);
    await expect(
      loadOrCreateReplayPremiereGuestHmacKey({
        privateStateRoot: stateRoot,
        servedRoots: [servedRoot],
      }),
    ).rejects.toMatchObject({
      operatorCode: "guest_hmac_key_file_invalid",
    });
  });

  test("rejects private state owned by a different uid", async () => {
    if (process.getuid === undefined) return;
    const stateRoot = path.join(root, "private-wrong-owner");
    await fs.mkdir(stateRoot, { mode: 0o700 });
    const actualUid = process.getuid();
    const uid = vi.spyOn(process, "getuid").mockReturnValue(actualUid + 1);
    try {
      await expect(
        loadOrCreateReplayPremiereGuestHmacKey({
          privateStateRoot: stateRoot,
          servedRoots: [servedRoot],
        }),
      ).rejects.toMatchObject({
        operatorCode: "private_state_root_not_private",
      });
    } finally {
      uid.mockRestore();
    }
  });

  test("fails closed on a hard-link crash residue", async () => {
    const stateRoot = path.join(root, "private-crash-residue");
    await loadOrCreateReplayPremiereGuestHmacKey({
      privateStateRoot: stateRoot,
      servedRoots: [servedRoot],
    });
    const keyPath = path.join(stateRoot, "guest-hmac-key-v1.bin");
    const residuePath = path.join(stateRoot, ".guest-hmac-key-v1.crash.tmp");
    await fs.link(keyPath, residuePath);

    await expect(
      loadOrCreateReplayPremiereGuestHmacKey({
        privateStateRoot: stateRoot,
        servedRoots: [servedRoot],
      }),
    ).rejects.toMatchObject({
      operatorCode: "guest_hmac_key_file_invalid",
    });
    expect((await fs.stat(keyPath)).nlink).toBe(2);
    await expect(fs.stat(residuePath)).resolves.toBeDefined();
  });

  test("detects a state-root swap after pinning and never writes the replacement", async () => {
    const stateRoot = path.join(root, "private-race");
    const movedRoot = path.join(root, "private-race-moved");

    await expect(
      loadOrCreateReplayPremiereGuestHmacKey({
        privateStateRoot: stateRoot,
        servedRoots: [servedRoot],
        afterRootPinnedForTest: async () => {
          await fs.rename(stateRoot, movedRoot);
          await fs.mkdir(stateRoot, { mode: 0o700 });
        },
      }),
    ).rejects.toMatchObject({
      operatorCode: "private_state_root_identity_changed",
    });
    await expect(
      fs.access(path.join(stateRoot, "guest-hmac-key-v1.bin")),
    ).rejects.toBeDefined();
    await expect(
      fs.access(path.join(movedRoot, "guest-hmac-key-v1.bin")),
    ).rejects.toBeDefined();
  });
});
