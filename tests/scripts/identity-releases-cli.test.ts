import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPendingRelease,
  mutateVersionReleaseStore,
  readVersionReleaseStore,
} from "../../src/server/platform/PlatformVersionReleaseStore";
import { AnalyticsAggregateStore, totalEventCount } from "../../src/server/analytics/AnalyticsAggregateStore";

/**
 * Real subprocess (`tsx`) end-to-end coverage of `identity:releases`'s two
 * CLI entry points — matches the pattern `premiere-schedule-cli.test.ts`
 * already established for this session's other CLIs: proves argv
 * parsing, exit codes, and the real `main()` dispatch actually work, not
 * just the underlying library functions (covered separately in
 * `VersionReleaseReconcile.test.ts` and `PlatformVersionReleaseStore.test.ts`).
 */
const repoRoot = path.resolve(__dirname, "..", "..");
const scriptPath = path.join(repoRoot, "src", "scripts", "identity-releases.ts");

function runCli(
  args: string[],
  releaseStateRoot: string,
  artifactsRootDir: string,
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("npx", ["tsx", scriptPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PROXYWAR_VERSION_RELEASE_STATE_ROOT: releaseStateRoot,
        PROXYWAR_ARTIFACTS_ROOT: artifactsRootDir,
      },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status: number; stdout: Buffer; stderr: Buffer };
    return {
      code: err.status,
      stdout: err.stdout?.toString("utf8") ?? "",
      stderr: err.stderr?.toString("utf8") ?? "",
    };
  }
}

async function writeVersionRegistry(
  registryDir: string,
  versions: readonly unknown[],
): Promise<void> {
  await writeFile(
    path.join(registryDir, "versions.json"),
    `${JSON.stringify({ schemaVersion: 1, versions }, null, 2)}\n`,
    "utf8",
  );
}

describe("identity:releases CLI — real subprocess end to end", () => {
  let releaseStateRoot: string;
  let registryDir: string;
  let artifactsRootDir: string;

  beforeEach(async () => {
    releaseStateRoot = await mkdtemp(
      path.join(os.tmpdir(), "identity-releases-cli-state-"),
    );
    registryDir = await mkdtemp(
      path.join(os.tmpdir(), "identity-releases-cli-registry-"),
    );
    artifactsRootDir = await mkdtemp(
      path.join(os.tmpdir(), "identity-releases-cli-artifacts-"),
    );
  });

  afterEach(async () => {
    await Promise.all(
      [releaseStateRoot, registryDir, artifactsRootDir].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  it("list prints an empty store cleanly", () => {
    const result = runCli(["list"], releaseStateRoot, artifactsRootDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("0 release(s)");
  });

  it("reconcile links a pending release to the next observed version and list reflects it", async () => {
    await mutateVersionReleaseStore(releaseStateRoot, (file) =>
      createPendingRelease(
        file,
        {
          accountId: "acct_00000000000000000000000000000001",
          agentId: "agt_daveey",
          versionLabel: "v25",
          releaseNotes: null,
          baseModel: null,
          scaffoldDescription: null,
          sourceDisclosure: null,
          intendedChanges: null,
        },
        new Date("2026-08-01T00:00:00.000Z"),
      ),
    );
    const before = await readVersionReleaseStore(releaseStateRoot);
    const releaseId = before.releases[0].id;

    await writeVersionRegistry(registryDir, [
      {
        id: "agtv_daveey_v26",
        agentId: "agt_daveey",
        publicVersionLabel: "v26",
        softmaxPolicyLabel: "daveey-proxywar:v26",
        immutableDigest: null,
        releaseDate: null,
        releaseNotes: null,
        declaredBaseModel: null,
        scaffoldDescription: null,
        sourceRepositoryRef: null,
        disclosureStatus: "undisclosed",
        qualificationStatus: "active",
        observedVia: ["rating"],
        observedAt: "2026-08-03T00:00:00.000Z",
        firstObservedAt: "2026-08-03T00:00:00.000Z",
      },
    ]);

    const reconcileResult = runCli(
      ["reconcile", "--dir", registryDir, "--data-json", "/tmp/does-not-need-to-exist.json"],
      releaseStateRoot,
      artifactsRootDir,
    );
    expect(reconcileResult.code).toBe(0);
    expect(reconcileResult.stdout).toContain(
      `${releaseId} observed as agtv_daveey_v26 (first observed 2026-08-03T00:00:00.000Z)`,
    );

    const after = await readVersionReleaseStore(releaseStateRoot);
    expect(after.releases[0]).toMatchObject({
      status: "observed",
      observedVersionId: "agtv_daveey_v26",
      observedAt: "2026-08-03T00:00:00.000Z",
    });

    const analyticsFile = await new AnalyticsAggregateStore(artifactsRootDir).readAll();
    expect(totalEventCount(analyticsFile, "version_observed")).toBe(1);

    const listResult = runCli(["list", "--status", "observed"], releaseStateRoot, artifactsRootDir);
    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain(releaseId);
    expect(listResult.stdout).toContain("observed");

    // Reconciling again is idempotent: nothing new to link, no false re-print.
    const secondReconcile = runCli(["reconcile", "--dir", registryDir], releaseStateRoot, artifactsRootDir);
    expect(secondReconcile.code).toBe(0);
    expect(secondReconcile.stdout).toContain("no newly observed releases");

    // Idempotent reconcile: no additional version_observed events on the second pass.
    const analyticsFileAfterSecond = await new AnalyticsAggregateStore(artifactsRootDir).readAll();
    expect(totalEventCount(analyticsFileAfterSecond, "version_observed")).toBe(1);
  }, 30000);

  it("prints usage and exits non-zero on an unknown subcommand", () => {
    const result = runCli(["bogus"], releaseStateRoot, artifactsRootDir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("usage: identity:releases");
  });
});
