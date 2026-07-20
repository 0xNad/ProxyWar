import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { toPublicReplayPremiereFailure } from "../../../src/server/replay-premiere/ReplayPremiereErrors";
import { sha256Hex } from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import {
  isContainedPath,
  readVerifiedStagedPremiereSource,
  stagePremiereSource,
} from "../../../src/server/replay-premiere/ReplayPremierePrivateStaging";

describe("ReplayPremierePrivateStaging", () => {
  let root: string;
  let privateRoot: string;
  let servedRoot: string;
  let sourcePath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-staging-"));
    privateRoot = path.join(root, "private");
    servedRoot = path.join(root, "served");
    sourcePath = path.join(root, "controlled.replay");
    await fs.mkdir(servedRoot);
    await fs.writeFile(sourcePath, "private controlled replay", {
      mode: 0o600,
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("stages immutable content outside served roots and reuses exact bytes", async () => {
    const expectedHash = sha256Hex("private controlled replay");
    const first = await stagePremiereSource({
      sourceFilePath: sourcePath,
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      maxSourceBytes: 1_000,
      expectedSourceReplaySha256: expectedHash,
    });
    const second = await stagePremiereSource({
      sourceFilePath: sourcePath,
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      maxSourceBytes: 1_000,
      expectedSourceReplaySha256: expectedHash,
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(first.privatePath.startsWith(await fs.realpath(privateRoot))).toBe(
      true,
    );
    expect((await fs.lstat(first.privatePath)).nlink).toBe(1);
    expect((await fs.lstat(first.privatePath)).mode & 0o777).toBe(0o400);
    expect((await fs.lstat(privateRoot)).mode & 0o777).toBe(0o700);
  });

  test("rejects symlink, hard-link, served-root, and byte-ceiling escapes", async () => {
    const symlinkPath = path.join(root, "source-link.replay");
    await fs.symlink(sourcePath, symlinkPath);
    await expect(
      stagePremiereSource({
        sourceFilePath: symlinkPath,
        privateStateRoot: privateRoot,
        servedRoots: [servedRoot],
        maxSourceBytes: 1_000,
      }),
    ).rejects.toThrow(/symlink/);

    const hardLinkPath = path.join(root, "hard-link.replay");
    await fs.link(sourcePath, hardLinkPath);
    await expect(
      stagePremiereSource({
        sourceFilePath: sourcePath,
        privateStateRoot: privateRoot,
        servedRoots: [servedRoot],
        maxSourceBytes: 1_000,
      }),
    ).rejects.toThrow(/regular_file/);
    await fs.unlink(hardLinkPath);

    const publicSource = path.join(servedRoot, "public.replay");
    await fs.writeFile(publicSource, "public");
    await expect(
      stagePremiereSource({
        sourceFilePath: publicSource,
        privateStateRoot: privateRoot,
        servedRoots: [servedRoot],
        maxSourceBytes: 1_000,
      }),
    ).rejects.toThrow(/served_root/);

    await expect(
      stagePremiereSource({
        sourceFilePath: sourcePath,
        privateStateRoot: privateRoot,
        servedRoots: [servedRoot],
        maxSourceBytes: 2,
      }),
    ).rejects.toThrow(/byte_ceiling/);
  });

  test("public failures never disclose private filesystem paths", async () => {
    let thrown: unknown;
    try {
      await stagePremiereSource({
        sourceFilePath: path.join(servedRoot, "missing.replay"),
        privateStateRoot: privateRoot,
        servedRoots: [servedRoot],
        maxSourceBytes: 1_000,
      });
    } catch (error) {
      thrown = error;
    }
    const serialized = JSON.stringify(toPublicReplayPremiereFailure(thrown));
    expect(serialized).not.toContain(root);
    expect(serialized).toContain("PREMIERE_INVALID_REQUEST");
  });

  test("rechecks read-only identity and hash on every staged-source consumption", async () => {
    const staged = await stagePremiereSource({
      sourceFilePath: sourcePath,
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      maxSourceBytes: 1_000,
    });
    const verified = await readVerifiedStagedPremiereSource({
      stagedSource: staged,
      privateStateRoot: privateRoot,
      servedRoots: [servedRoot],
      maxSourceBytes: 1_000,
    });
    expect(verified.copyBytes().toString("utf8")).toBe(
      "private controlled replay",
    );
    await fs.chmod(staged.privatePath, 0o600);
    await expect(
      readVerifiedStagedPremiereSource({
        stagedSource: staged,
        privateStateRoot: privateRoot,
        servedRoots: [servedRoot],
        maxSourceBytes: 1_000,
      }),
    ).rejects.toThrow(/read_contract_mismatch/);
  });

  test("preserves exact case and Unicode filesystem containment semantics", () => {
    expect(isContainedPath("/private/Root", "/private/root/source")).toBe(
      false,
    );
    expect(
      isContainedPath("/private/caf\u00e9", "/private/cafe\u0301/source"),
    ).toBe(false);
    expect(isContainedPath("/private/root", "/private/root/source")).toBe(
      true,
    );
  });

  test("fails durable staging below the bounded-write floor", async () => {
    await expect(
      stagePremiereSource({
        sourceFilePath: sourcePath,
        privateStateRoot: privateRoot,
        servedRoots: [servedRoot],
        maxSourceBytes: 1_000,
        statfs: (async () => ({
          bavail: 1,
          bsize: 1,
        })) as unknown as typeof fs.statfs,
      }),
    ).rejects.toThrow(/free_space_floor/);
  });
});
