import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs, constants as fsConstants, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReplayPremiereError } from "./ReplayPremiereErrors";

export const REPLAY_PREMIERE_STATE_ROOT_ENV =
  "PROXYWAR_REPLAY_PREMIERE_STATE_ROOT" as const;
export const REPLAY_PREMIERE_HMAC_HEX_ENV =
  "PROXYWAR_REPLAY_PREMIERE_HMAC_KEY_HEX" as const;

const activeKeyLoads = new Map<string, Promise<Uint8Array>>();

export function resolveReplayPremierePrivateStateRoot(
  environment: Record<string, string | undefined> = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configured = environment[REPLAY_PREMIERE_STATE_ROOT_ENV]?.trim();
  const selected =
    configured === undefined || configured === ""
      ? path.join(
          homeDirectory,
          "Library",
          "Application Support",
          "ProxyWar",
          "storage",
          "replay-premiere",
        )
      : configured;
  const resolved = path.resolve(selected);
  if (
    !path.isAbsolute(selected) ||
    resolved === path.parse(resolved).root ||
    resolved === path.resolve(homeDirectory)
  ) {
    throw secretFailure("invalid_private_state_root");
  }
  return resolved;
}

export async function loadOrCreateReplayPremiereGuestHmacKey(options: {
  privateStateRoot: string;
  servedRoots: readonly string[];
  configuredHex?: string;
  /** Deterministic race injection for the focused filesystem test only. */
  afterRootPinnedForTest?: () => Promise<void>;
}): Promise<Uint8Array> {
  const root = path.resolve(options.privateStateRoot);
  assertSafeRoot(root, options.servedRoots);
  if (options.configuredHex !== undefined) {
    return decodeConfiguredKey(options.configuredHex);
  }
  const existing = activeKeyLoads.get(root);
  if (existing !== undefined) {
    return new Uint8Array(await existing);
  }
  const pending = loadOrCreateFileKey({ ...options, privateStateRoot: root });
  activeKeyLoads.set(root, pending);
  try {
    return new Uint8Array(await pending);
  } finally {
    if (activeKeyLoads.get(root) === pending) activeKeyLoads.delete(root);
  }
}

async function loadOrCreateFileKey(options: {
  privateStateRoot: string;
  servedRoots: readonly string[];
  afterRootPinnedForTest?: () => Promise<void>;
}): Promise<Uint8Array> {
  const root = options.privateStateRoot;
  await assertNoSymlinkAncestors(root);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await assertNoSymlinkAncestors(root);
  const canonicalRoot = await fs.realpath(root);
  if (!samePath(canonicalRoot, root)) {
    throw secretFailure("private_state_root_alias_rejected");
  }
  await assertCanonicalRootDisjoint(canonicalRoot, options.servedRoots);

  const directory = await fs.open(
    root,
    fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      fsConstants.O_NOFOLLOW,
  );
  const pinned = await directory.stat();
  validatePrivateRootStat(pinned);
  try {
    await options.afterRootPinnedForTest?.();
    await assertPinnedRoot(root, pinned);
    const keyPath = path.join(root, "guest-hmac-key-v1.bin");
    try {
      const key = await readKeyFile(keyPath);
      await assertPinnedRoot(root, pinned);
      return key;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }

    const temporaryPath = path.join(
      root,
      `.guest-hmac-key-v1.${process.pid}.${randomUUID()}.tmp`,
    );
    let temporaryCreated = false;
    try {
      await assertPinnedRoot(root, pinned);
      const handle = await fs.open(
        temporaryPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_NOFOLLOW,
        0o600,
      );
      temporaryCreated = true;
      try {
        validateKeyStat(await handle.stat(), true);
        await handle.writeFile(randomBytes(32));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await assertPinnedRoot(root, pinned);
      try {
        await fs.link(temporaryPath, keyPath);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
      // The final name is durable only after the temporary hard link is gone
      // and that unlink is covered by the directory fsync. A crash before this
      // point leaves nlink=2, which readKeyFile rejects on restart.
      await fs.unlink(temporaryPath);
      temporaryCreated = false;
      await directory.sync();
      await assertPinnedRoot(root, pinned);
    } finally {
      if (temporaryCreated) {
        await fs.unlink(temporaryPath).catch(() => undefined);
        await directory.sync().catch(() => undefined);
      }
    }
    const key = await readKeyFile(keyPath);
    await assertPinnedRoot(root, pinned);
    return key;
  } finally {
    await directory.close();
  }
}

async function readKeyFile(keyPath: string): Promise<Uint8Array> {
  const handle = await fs.open(
    keyPath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    validateKeyStat(await handle.stat(), false);
    const key = await handle.readFile();
    if (key.byteLength !== 32) {
      throw secretFailure("guest_hmac_key_read_incomplete");
    }
    return new Uint8Array(key);
  } finally {
    await handle.close();
  }
}

function assertSafeRoot(root: string, servedRoots: readonly string[]): void {
  if (
    root === path.parse(root).root ||
    servedRoots.length === 0 ||
    servedRoots.some((servedRoot) =>
      pathsOverlap(root, path.resolve(servedRoot)),
    )
  ) {
    throw secretFailure("private_state_root_overlaps_served_root");
  }
}

async function assertCanonicalRootDisjoint(
  root: string,
  servedRoots: readonly string[],
): Promise<void> {
  for (const configured of servedRoots) {
    const resolved = path.resolve(configured);
    const canonical = await fs.realpath(resolved).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return resolved;
      throw error;
    });
    if (pathsOverlap(root, canonical)) {
      throw secretFailure("private_state_root_overlaps_served_root");
    }
  }
}

async function assertNoSymlinkAncestors(target: string): Promise<void> {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const segments = absolute
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw secretFailure("private_state_root_symlink_ancestor");
    }
  }
}

async function assertPinnedRoot(root: string, pinned: Stats): Promise<void> {
  await assertNoSymlinkAncestors(root);
  const current = await fs.lstat(root);
  validatePrivateRootStat(current);
  if (current.dev !== pinned.dev || current.ino !== pinned.ino) {
    throw secretFailure("private_state_root_identity_changed");
  }
}

function validatePrivateRootStat(stat: Stats): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 ||
    !ownedByCurrentProcess(stat)
  ) {
    throw secretFailure("private_state_root_not_private");
  }
}

function validateKeyStat(stat: Stats, temporary: boolean): void {
  if (
    !stat.isFile() ||
    stat.size !== (temporary ? 0 : 32) ||
    (stat.mode & 0o777) !== 0o600 ||
    !ownedByCurrentProcess(stat) ||
    stat.nlink !== 1
  ) {
    throw secretFailure("guest_hmac_key_file_invalid");
  }
}

function ownedByCurrentProcess(stat: Stats): boolean {
  const getuid = process.getuid;
  return getuid === undefined || stat.uid === getuid.call(process);
}

function pathsOverlap(left: string, right: string): boolean {
  return isAtOrInside(left, right) || isAtOrInside(right, left);
}

function isAtOrInside(candidate: string, root: string): boolean {
  const normalizedCandidate = comparablePath(candidate);
  const normalizedRoot = comparablePath(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.toLocaleLowerCase("en-US")
    : resolved;
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function decodeConfiguredKey(value: string): Uint8Array {
  const configured = value.trim();
  if (
    configured.length < 64 ||
    configured.length > 8_192 ||
    configured.length % 2 !== 0 ||
    !/^[a-fA-F0-9]+$/.test(configured)
  ) {
    throw secretFailure("configured_guest_hmac_key_invalid");
  }
  return new Uint8Array(Buffer.from(configured, "hex"));
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function secretFailure(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_UNAVAILABLE",
    503,
    `Replay Premiere secret storage rejected: ${operatorCode}`,
  );
}
