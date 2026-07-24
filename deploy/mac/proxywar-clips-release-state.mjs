#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEYS = ["buildSha256", "commit", "enabled", "schemaVersion", "tree"];
const MAX_STATE_BYTES = 1_024;

export function parseClipReleaseState(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== KEYS.length ||
    keys.some((key, index) => key !== KEYS[index])
  ) {
    return null;
  }
  if (value.schemaVersion !== 1 || typeof value.enabled !== "boolean") {
    return null;
  }
  if (value.enabled) {
    if (
      !isHex(value.commit, 40) ||
      !isHex(value.tree, 40) ||
      !isHex(value.buildSha256, 64)
    ) {
      return null;
    }
  } else if (
    value.commit !== null ||
    value.tree !== null ||
    value.buildSha256 !== null
  ) {
    return null;
  }
  return value;
}

export async function writeClipReleaseState({ statePath, state }) {
  if (
    !path.isAbsolute(statePath) ||
    parseClipReleaseState(JSON.stringify(state)) === null
  ) {
    throw new Error("clip_release_state_invalid");
  }
  const parent = path.dirname(statePath);
  const parentStat = await fs.lstat(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.uid !== process.getuid() ||
    (parentStat.mode & 0o077) !== 0
  ) {
    throw new Error("clip_release_state_parent_unsafe");
  }
  const temp = path.join(
    parent,
    `.${path.basename(statePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, statePath);
    const directory = await fs.open(parent, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temp).catch(() => undefined);
  }
}

export async function readClipReleaseState({ statePath }) {
  if (!path.isAbsolute(statePath))
    throw new Error("clip_release_state_path_not_absolute");
  let before;
  try {
    before = await fs.lstat(statePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("clip_release_state_unverifiable", { cause: error });
  }
  validateStateMetadata(before);
  let handle;
  try {
    handle = await fs.open(
      statePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    throw new Error("clip_release_state_unverifiable", { cause: error });
  }
  let bytes;
  try {
    const opened = await handle.stat();
    validateStateMetadata(opened);
    if (!sameIdentity(before, opened))
      throw new Error("clip_release_state_changed");
    bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    if (!sameIdentity(opened, openedAfter))
      throw new Error("clip_release_state_changed");
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (bytes.byteLength > MAX_STATE_BYTES)
    throw new Error("clip_release_state_too_large");
  const after = await fs.lstat(statePath).catch((error) => {
    throw new Error("clip_release_state_changed", { cause: error });
  });
  if (!sameIdentity(before, after) || after.size !== bytes.byteLength) {
    throw new Error("clip_release_state_changed");
  }
  const state = parseClipReleaseState(bytes.toString("utf8"));
  if (state === null) throw new Error("clip_release_state_malformed");
  return state;
}

export async function hashStaticBuild(staticRoot) {
  if (!path.isAbsolute(staticRoot))
    throw new Error("clip_release_build_path_not_absolute");
  const files = [];
  await collectStaticFiles(staticRoot, "", files);
  files.sort();
  const digest = createHash("sha256");
  for (const relativePath of files) {
    const absolutePath = path.join(staticRoot, ...relativePath.split("/"));
    const before = await fs.lstat(absolutePath);
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error("clip_release_build_not_regular");
    const handle = await fs.open(
      absolutePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (!sameIdentity(before, opened))
        throw new Error("clip_release_build_changed");
      const bytes = await handle.readFile();
      const openedAfter = await handle.stat();
      if (
        !sameIdentity(opened, openedAfter) ||
        bytes.byteLength !== opened.size
      )
        throw new Error("clip_release_build_changed");
      digest.update(relativePath, "utf8");
      digest.update("\0");
      digest.update(String(bytes.byteLength), "utf8");
      digest.update("\0");
      digest.update(bytes);
      digest.update("\0");
    } finally {
      await handle.close();
    }
  }
  return digest.digest("hex");
}

async function collectStaticFiles(root, relativeDirectory, files) {
  const directory = path.join(
    root,
    ...relativeDirectory.split("/").filter(Boolean),
  );
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("clip_release_build_symlink");
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      await collectStaticFiles(root, relativePath, files);
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error("clip_release_build_not_regular");
    }
  }
}

function validateStateMetadata(stats) {
  if (!stats.isFile() || stats.isSymbolicLink())
    throw new Error("clip_release_state_not_regular");
  if (stats.nlink !== 1) throw new Error("clip_release_state_hardlinked");
  if (stats.uid !== process.getuid())
    throw new Error("clip_release_state_wrong_owner");
  if ((stats.mode & 0o777) !== 0o600)
    throw new Error("clip_release_state_wrong_mode");
  if (stats.size > MAX_STATE_BYTES)
    throw new Error("clip_release_state_too_large");
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function isHex(value, length) {
  return (
    typeof value === "string" &&
    value.length === length &&
    /^[a-f0-9]+$/.test(value)
  );
}

function parseArgs(argv) {
  const command = argv[0];
  if (
    command !== "enable" &&
    command !== "disable" &&
    command !== "status" &&
    command !== "build-hash"
  ) {
    throw new Error(
      "usage: proxywar-clips-release-state.mjs <enable|disable|status|build-hash> --path=/absolute/path",
    );
  }
  const options = { command };
  for (const arg of argv.slice(1)) {
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (match === null || match[2] === "")
      throw new Error("clip_release_state_argument_invalid");
    const key = match[1];
    if (key in options)
      throw new Error(`clip_release_state_argument_duplicate:${key}`);
    options[key] = match[2];
  }
  if (!path.isAbsolute(options.path ?? ""))
    throw new Error("clip_release_state_path_not_absolute");
  const allowed =
    command === "enable"
      ? ["path", "commit", "tree", "build-sha256"]
      : command === "status"
        ? ["path", "shell"]
        : ["path"];
  const unknown = Object.keys(options).filter(
    (key) => key !== "command" && !allowed.includes(key),
  );
  if (unknown.length > 0)
    throw new Error(`clip_release_state_argument_unknown:${unknown.join(",")}`);
  return options;
}

const invokedModulePath = process.argv[1]
  ? await fs.realpath(path.resolve(process.argv[1])).catch(() => null)
  : null;
const currentModulePath = await fs
  .realpath(fileURLToPath(import.meta.url))
  .catch(() => null);

if (invokedModulePath !== null && invokedModulePath === currentModulePath) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === "build-hash") {
      process.stdout.write(`${await hashStaticBuild(options.path)}\n`);
    } else if (options.command === "status") {
      if (options.shell !== undefined && options.shell !== "true") {
        throw new Error("clip_release_state_shell_invalid");
      }
      const state = await readClipReleaseState({ statePath: options.path });
      if (options.shell === "true") {
        process.stdout.write(
          state === null || !state.enabled
            ? "disabled\n"
            : `enabled ${state.commit} ${state.tree} ${state.buildSha256}\n`,
        );
      } else {
        process.stdout.write(`${JSON.stringify(state)}\n`);
      }
    } else {
      const state =
        options.command === "enable"
          ? {
              schemaVersion: 1,
              enabled: true,
              commit: options.commit,
              tree: options.tree,
              buildSha256: options["build-sha256"],
            }
          : {
              schemaVersion: 1,
              enabled: false,
              commit: null,
              tree: null,
              buildSha256: null,
            };
      await writeClipReleaseState({ statePath: options.path, state });
      process.stdout.write(`${JSON.stringify(state)}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
