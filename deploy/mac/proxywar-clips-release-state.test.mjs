import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  hashStaticBuild,
  parseClipReleaseState,
  readClipReleaseState,
  writeClipReleaseState,
} from "./proxywar-clips-release-state.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

test("strictly parses enabled and disabled release state", () => {
  const enabled = {
    schemaVersion: 1,
    enabled: true,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    buildSha256: "c".repeat(64),
  };
  assert.deepEqual(parseClipReleaseState(JSON.stringify(enabled)), enabled);
  assert.deepEqual(
    parseClipReleaseState(
      JSON.stringify({
        schemaVersion: 1,
        enabled: false,
        commit: null,
        tree: null,
        buildSha256: null,
      }),
    ),
    {
      schemaVersion: 1,
      enabled: false,
      commit: null,
      tree: null,
      buildSha256: null,
    },
  );
  assert.equal(
    parseClipReleaseState(JSON.stringify({ ...enabled, extra: true })),
    null,
  );
  assert.equal(
    parseClipReleaseState(
      JSON.stringify({ ...enabled, commit: "A".repeat(40) }),
    ),
    null,
  );
});

test("atomically replaces an owner-only release state", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pw-clip-release-state-"),
  );
  roots.push(root);
  await fs.chmod(root, 0o700);
  const statePath = path.join(root, "clip-release-v1.json");
  const enabled = {
    schemaVersion: 1,
    enabled: true,
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    buildSha256: "c".repeat(64),
  };
  await writeClipReleaseState({ statePath, state: enabled });
  assert.equal((await fs.lstat(statePath)).mode & 0o777, 0o600);
  assert.deepEqual(
    parseClipReleaseState(await fs.readFile(statePath, "utf8")),
    enabled,
  );
  const disabled = {
    schemaVersion: 1,
    enabled: false,
    commit: null,
    tree: null,
    buildSha256: null,
  };
  await writeClipReleaseState({ statePath, state: disabled });
  assert.deepEqual(
    parseClipReleaseState(await fs.readFile(statePath, "utf8")),
    disabled,
  );
  assert.deepEqual((await fs.readdir(root)).sort(), ["clip-release-v1.json"]);
});

test("refuses a group-readable parent", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pw-clip-release-unsafe-"),
  );
  roots.push(root);
  await fs.chmod(root, 0o755);
  await assert.rejects(
    writeClipReleaseState({
      statePath: path.join(root, "clip-release-v1.json"),
      state: {
        schemaVersion: 1,
        enabled: false,
        commit: null,
        tree: null,
        buildSha256: null,
      },
    }),
    /clip_release_state_parent_unsafe/,
  );
});

test("bounded no-follow reads reject extra bytes, oversized files, symlinks, and fifos", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pw-clip-release-read-"),
  );
  roots.push(root);
  await fs.chmod(root, 0o700);
  const statePath = path.join(root, "clip-release-v1.json");
  const valid = JSON.stringify({
    schemaVersion: 1,
    enabled: false,
    commit: null,
    tree: null,
    buildSha256: null,
  });

  await fs.writeFile(statePath, `${valid}\n${valid}\n`, { mode: 0o600 });
  await assert.rejects(
    readClipReleaseState({ statePath }),
    /clip_release_state_malformed/,
  );

  await fs.writeFile(statePath, Buffer.alloc(1_025), { mode: 0o600 });
  await assert.rejects(
    readClipReleaseState({ statePath }),
    /clip_release_state_too_large/,
  );

  await fs.rm(statePath);
  const target = path.join(root, "target.json");
  await fs.writeFile(target, `${valid}\n`, { mode: 0o600 });
  await fs.symlink(target, statePath);
  await assert.rejects(
    readClipReleaseState({ statePath }),
    /clip_release_state_not_regular/,
  );

  await fs.rm(statePath);
  await new Promise((resolve, reject) =>
    execFile("mkfifo", [statePath], (error) =>
      error === null ? resolve() : reject(error),
    ),
  );
  await fs.chmod(statePath, 0o600);
  await assert.rejects(
    Promise.race([
      readClipReleaseState({ statePath }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("fifo_read_blocked")), 500),
      ),
    ]),
    /clip_release_state_not_regular/,
  );
});

test("static build hash is deterministic across roots and creation order and changes with content", async () => {
  const left = await fs.mkdtemp(path.join(os.tmpdir(), "pw-clip-build-left-"));
  const right = await fs.mkdtemp(
    path.join(os.tmpdir(), "pw-clip-build-right-"),
  );
  roots.push(left, right);
  await fs.mkdir(path.join(left, "assets"));
  await fs.writeFile(path.join(left, "z.txt"), "zeta");
  await fs.writeFile(
    path.join(left, "assets", "a.bin"),
    Buffer.from([0, 1, 2]),
  );
  await fs.mkdir(path.join(right, "assets"));
  await fs.writeFile(
    path.join(right, "assets", "a.bin"),
    Buffer.from([0, 1, 2]),
  );
  await fs.writeFile(path.join(right, "z.txt"), "zeta");

  const leftHash = await hashStaticBuild(left);
  assert.match(leftHash, /^[a-f0-9]{64}$/);
  assert.equal(await hashStaticBuild(left), leftHash);
  assert.equal(await hashStaticBuild(right), leftHash);

  await fs.writeFile(path.join(right, "z.txt"), "changed");
  assert.notEqual(await hashStaticBuild(right), leftHash);
});

test("static build hash rejects symlinks and special files", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "pw-clip-build-unsafe-"),
  );
  roots.push(root);
  const target = path.join(root, "target.txt");
  const unsafe = path.join(root, "unsafe");
  await fs.writeFile(target, "target");
  await fs.symlink(target, unsafe);
  await assert.rejects(hashStaticBuild(root), /clip_release_build_symlink/);

  await fs.rm(unsafe);
  await new Promise((resolve, reject) =>
    execFile("mkfifo", [unsafe], (error) =>
      error === null ? resolve() : reject(error),
    ),
  );
  await assert.rejects(hashStaticBuild(root), /clip_release_build_not_regular/);
});
