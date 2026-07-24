import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  createDeploymentAttestation,
  DEPLOYMENT_ATTESTATION_NAME,
  hashStaticBuild,
  parseDeploymentAttestation,
  verifyDeploymentAttestation,
} from "./proxywar-clips-deployment-attestation.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

test("creates and verifies a content-bound owner-only deployment attestation", async () => {
  const fixture = await makeFixture();
  const created = await createDeploymentAttestation(fixture.createOptions);
  const state = created.attestation;

  assert.equal(created.attestationPath, fixture.attestationPath);
  assert.equal((await fs.lstat(created.attestationPath)).mode & 0o777, 0o600);
  assert.match(state.nonce, /^[a-f0-9]{64}$/);
  assert.equal(state.commit, fixture.commit);
  assert.equal(state.tree, fixture.tree);
  assert.equal(state.buildSha256, fixture.buildSha256);
  assert.equal(state.wrapperSha256, fixture.wrapperSha256);
  assert.equal(state.helperSha256, fixture.helperSha256);
  assert.deepEqual(
    state.trackedFiles.map((entry) => entry.path),
    [".gitignore", "src/main.ts"],
  );
  assert.notEqual(
    parseDeploymentAttestation(await fs.readFile(created.attestationPath)),
    null,
  );

  const verified = await verifyDeploymentAttestation({
    ...fixture.verifyOptions,
    expectedNonce: state.nonce,
  });
  assert.equal(verified.trackedContentSha256, state.trackedContentSha256);
});

test("create proves clean status and exact commit, tree, build, wrapper, and helper", async () => {
  const fixture = await makeFixture();
  const failingGit = path.join(fixture.trustedRoot, "bin", "failing-git.zsh");
  await fs.writeFile(
    failingGit,
    [
      "#!/bin/zsh",
      '[[ "${GIT_OPTIONAL_LOCKS:-}" == "0" ]] || exit 71',
      '[[ "$3" != "status" ]] || exit 70',
      `exec ${JSON.stringify(fixture.gitBin)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await assertStage(
    () =>
      createDeploymentAttestation({
        ...fixture.createOptions,
        gitBin: failingGit,
      }),
    "status",
  );

  await fs.writeFile(path.join(fixture.projectDir, "untracked.txt"), "drift\n");
  await assertStage(
    () => createDeploymentAttestation(fixture.createOptions),
    "status",
  );
  await fs.rm(path.join(fixture.projectDir, "untracked.txt"));

  for (const [override, stage] of [
    [{ expectedCommit: "f".repeat(40) }, "commit"],
    [{ expectedTree: "e".repeat(40) }, "tree"],
    [{ expectedBuildSha256: "d".repeat(64) }, "static_build"],
    [{ expectedWrapperSha256: "c".repeat(64) }, "wrapper"],
    [{ expectedHelperSha256: "b".repeat(64) }, "helper"],
  ]) {
    await assertStage(
      () =>
        createDeploymentAttestation({
          ...fixture.createOptions,
          ...override,
        }),
      stage,
    );
  }
});

test("verify fails closed at the exact binding, tracked, static, wrapper, and helper stages", async () => {
  const fixture = await makeFixture();
  const { attestation } = await createDeploymentAttestation(
    fixture.createOptions,
  );
  const options = {
    ...fixture.verifyOptions,
    expectedNonce: attestation.nonce,
  };

  await assertStage(
    () =>
      verifyDeploymentAttestation({
        ...options,
        expectedNonce: "0".repeat(64),
      }),
    "binding",
  );

  await fs.writeFile(path.join(fixture.projectDir, "src/main.ts"), "drift\n");
  await assertStage(
    () => verifyDeploymentAttestation(options),
    "tracked_content",
  );
  await fs.writeFile(
    path.join(fixture.projectDir, "src/main.ts"),
    "export const value = 1;\n",
  );

  await fs.rename(
    path.join(fixture.projectDir, "src"),
    path.join(fixture.projectDir, "src-real"),
  );
  await fs.symlink(
    path.join(fixture.projectDir, "src-real"),
    path.join(fixture.projectDir, "src"),
  );
  await assertStage(
    () => verifyDeploymentAttestation(options),
    "tracked_content",
  );
  await fs.rm(path.join(fixture.projectDir, "src"));
  await fs.rename(
    path.join(fixture.projectDir, "src-real"),
    path.join(fixture.projectDir, "src"),
  );

  await fs.writeFile(
    path.join(fixture.projectDir, "static/index.html"),
    "v2\n",
  );
  await assertStage(() => verifyDeploymentAttestation(options), "static_build");
  await fs.writeFile(
    path.join(fixture.projectDir, "static/index.html"),
    "v1\n",
  );

  await fs.writeFile(fixture.wrapperPath, "#!/bin/zsh\nexit 1\n");
  await assertStage(() => verifyDeploymentAttestation(options), "wrapper");
  await fs.writeFile(fixture.wrapperPath, fixture.wrapperBytes);

  await fs.writeFile(
    fixture.helperPath,
    "#!/usr/bin/env node\nprocess.exit(1);\n",
  );
  await assertStage(() => verifyDeploymentAttestation(options), "helper");
});

test("verify rejects malformed, permissive, and symlinked attestation state", async () => {
  const fixture = await makeFixture();
  const { attestation } = await createDeploymentAttestation(
    fixture.createOptions,
  );
  const options = {
    ...fixture.verifyOptions,
    expectedNonce: attestation.nonce,
  };

  await fs.writeFile(fixture.attestationPath, "{}\n");
  await assertStage(() => verifyDeploymentAttestation(options), "attestation");

  await createDeploymentAttestation({
    ...fixture.createOptions,
    nonce: attestation.nonce,
  });
  await fs.chmod(fixture.attestationPath, 0o644);
  await assertStage(() => verifyDeploymentAttestation(options), "attestation");

  await fs.rm(fixture.attestationPath);
  const target = path.join(fixture.stateRoot, "target.json");
  await fs.writeFile(target, "{}\n", { mode: 0o600 });
  await fs.symlink(target, fixture.attestationPath);
  await assertStage(() => verifyDeploymentAttestation(options), "attestation");
});

async function makeFixture() {
  const rawTrustedRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "pw-clip-attestation-trusted-"),
  );
  const rawProjectDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pw-clip-attestation-project-"),
  );
  roots.push(rawTrustedRoot, rawProjectDir);
  const trustedRoot = await fs.realpath(rawTrustedRoot);
  const projectDir = await fs.realpath(rawProjectDir);
  await fs.chmod(trustedRoot, 0o700);
  const stateRoot = path.join(trustedRoot, "storage", "replay-premiere");
  const binRoot = path.join(trustedRoot, "bin");
  await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(path.join(trustedRoot, "storage"), 0o700);
  await fs.chmod(stateRoot, 0o700);
  await fs.mkdir(binRoot, { mode: 0o755 });

  const wrapperPath = path.join(binRoot, "start-proxywar-beta.zsh");
  const helperPath = path.join(
    binRoot,
    "proxywar-clips-deployment-attestation.mjs",
  );
  const wrapperBytes = "#!/bin/zsh\nexit 0\n";
  const helperBytes = "#!/usr/bin/env node\nprocess.exit(0);\n";
  await fs.writeFile(wrapperPath, wrapperBytes, { mode: 0o755 });
  await fs.writeFile(helperPath, helperBytes, { mode: 0o755 });

  await fs.mkdir(path.join(projectDir, "src"));
  await fs.mkdir(path.join(projectDir, "static"));
  await fs.writeFile(path.join(projectDir, ".gitignore"), "static/\n");
  await fs.writeFile(
    path.join(projectDir, "src/main.ts"),
    "export const value = 1;\n",
  );
  await fs.writeFile(path.join(projectDir, "static/index.html"), "v1\n");
  const gitBin = execFileSync("/bin/zsh", ["-lc", "command -v git"], {
    encoding: "utf8",
  }).trim();
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "clip-test@proxywar.invalid"],
    ["config", "user.name", "ProxyWar Clip Test"],
    ["add", ".gitignore", "src/main.ts"],
    ["commit", "-qm", "fixture"],
  ]) {
    execFileSync(gitBin, args, { cwd: projectDir });
  }
  const commit = execFileSync(gitBin, ["rev-parse", "HEAD"], {
    cwd: projectDir,
    encoding: "utf8",
  }).trim();
  const tree = execFileSync(gitBin, ["rev-parse", "HEAD^{tree}"], {
    cwd: projectDir,
    encoding: "utf8",
  }).trim();
  const buildSha256 = await hashStaticBuild(path.join(projectDir, "static"));
  const wrapperSha256 = sha256(wrapperBytes);
  const helperSha256 = sha256(helperBytes);
  return {
    trustedRoot,
    stateRoot,
    projectDir,
    wrapperPath,
    helperPath,
    wrapperBytes,
    commit,
    tree,
    buildSha256,
    wrapperSha256,
    helperSha256,
    gitBin,
    attestationPath: path.join(stateRoot, DEPLOYMENT_ATTESTATION_NAME),
    createOptions: {
      stateRoot,
      trustedRoot,
      projectDir,
      wrapperPath,
      helperPath,
      gitBin,
      expectedCommit: commit,
      expectedTree: tree,
      expectedBuildSha256: buildSha256,
      expectedWrapperSha256: wrapperSha256,
      expectedHelperSha256: helperSha256,
    },
    verifyOptions: {
      stateRoot,
      trustedRoot,
      projectDir,
      wrapperPath,
      helperPath,
      expectedCommit: commit,
      expectedTree: tree,
      expectedBuildSha256: buildSha256,
    },
  };
}

async function assertStage(operation, stage) {
  await assert.rejects(operation, (error) => error?.stage === stage);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
