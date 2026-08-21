import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertResolvedCommanderRuntime,
  captureCommanderSourceIdentity,
  COMMANDER_OUTER_DECISION_TIMEOUT_MS,
  COMMANDER_PROVIDER_KILL_TIMEOUT_MS,
  COMMANDER_SELECTOR_TIMEOUT_MS,
  commanderExperimentOutputDirectory,
  commanderTrustedClaudeBinaryCandidates,
  prepareCommanderProviderCwd,
  reserveCommanderExperimentOutput,
  resolveRealCommanderRuntime as resolveRealCommanderRuntimeWithCwd,
  resolveScriptedCommanderRuntime,
  writeCommanderExperimentSeal,
  type CommanderExperimentPreRegistration,
} from "../../src/server/agents/CommanderExperimentProtocol";

const temporaryRoots: string[] = [];

function emptyProviderCwd(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "commander-provider-cwd-"));
  temporaryRoots.push(root);
  return realpathSync(root);
}

function resolveRealCommanderRuntime(
  env: Parameters<typeof resolveRealCommanderRuntimeWithCwd>[0] = process.env,
  inspection: Parameters<typeof resolveRealCommanderRuntimeWithCwd>[1] = {},
  providerCwd: string = emptyProviderCwd(),
) {
  return resolveRealCommanderRuntimeWithCwd(env, inspection, providerCwd);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((entry) => rm(entry, { recursive: true, force: true })),
  );
});

describe("Commander experiment runtime identity", () => {
  it("never trusts a Claude binary merely because it is beside the invoking Node runtime", () => {
    const candidates = commanderTrustedClaudeBinaryCandidates(
      "/Users/fixed-operator",
    );
    expect(candidates).toEqual([
      "/Users/fixed-operator/.local/bin/claude",
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ]);
    expect(candidates).not.toContain("/tmp/foreign-node/bin/claude");
  });

  it("seals an allowlisted binary, exact model, argv/tool policy, budgets, and environment", () => {
    const binary = Buffer.from("sealed-claude-binary\n");
    const runtime = resolveRealCommanderRuntime(
      {
        HOME: "/tmp/commander-home",
        PATH: "/opt/bin",
        AI_LEAGUE_CLAUDE_MODEL: "claude-fable-5-20260821",
      },
      {
        resolveDefaultBinary: () => "/opt/bin/claude",
        realpath: (value) => value,
        readBinary: () => binary,
        readVersion: () => "9.8.7 (Claude Code)",
      },
    );

    expect(runtime.identity).toMatchObject({
      providerMode: "claude-cli",
      outerDecisionTimeoutMs: COMMANDER_OUTER_DECISION_TIMEOUT_MS,
      commanderSelectorTimeoutMs: COMMANDER_SELECTOR_TIMEOUT_MS,
      provider: {
        binaryPath: "/opt/bin/claude",
        binarySha256: createHash("sha256").update(binary).digest("hex"),
        version: "9.8.7 (Claude Code)",
        cwd: expect.stringContaining("commander-provider-cwd-"),
        cwdStateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        model: "claude-fable-5-20260821",
        allowedTools: [],
        killTimeoutMs: COMMANDER_PROVIDER_KILL_TIMEOUT_MS,
      },
      environment: {
        sanitized: true,
      },
    });
    expect(runtime.identity.provider.argv).toEqual([
      "-p",
      "--max-turns",
      "1",
      "--disallowedTools",
      "Bash,Edit,MultiEdit,Write,Read,WebFetch,WebSearch",
      "--setting-sources=",
      "--tools",
      "",
      "--no-session-persistence",
      "--safe-mode",
      "--model",
      "claude-fable-5-20260821",
    ]);
    expect(runtime.identity.environment.values).toMatchObject({
      GAME_ENV: "dev",
      NODE_ENV: null,
      TZ: "UTC",
      AI_LEAGUE_CLAUDE_COMMAND: "/opt/bin/claude",
      AI_LEAGUE_CLAUDE_MODEL: "claude-fable-5-20260821",
      AI_LEAGUE_CLAUDE_TIMEOUT_MS: String(COMMANDER_PROVIDER_KILL_TIMEOUT_MS),
      AI_LEAGUE_LLM_MODEL: null,
      AI_LEAGUE_LLM_TIMEOUT_MS: null,
      AI_LEAGUE_REQUIRE_CODEX_SUCCESS: null,
      AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS: null,
      PROXYWAR_WRITE_DEMO_INDEX: null,
    });
    expect(Object.keys(runtime.identity.environment.tunableValues).length).toBe(
      40,
    );
    expect(runtime.identity.environment.snapshotSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(runtime.identity.environment.tunableSnapshotSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(runtime.identity.identitySha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects command, tool, timeout, tunable, alias-model, and provider-alias attacks", async () => {
    const root = await temporaryDirectory();
    const fakeCommand = path.join(root, "fake-claude");
    await writeFile(fakeCommand, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(fakeCommand, 0o755);
    const inspection = {
      resolveDefaultBinary: () => "/opt/bin/claude",
      realpath: (value: string) => value,
      readBinary: () => Buffer.from("binary"),
      readVersion: () => "1.0.0",
    };
    const base = {
      HOME: "/tmp/commander-home",
      PATH: root,
      AI_LEAGUE_CLAUDE_MODEL: "claude-fable-5-20260821",
    };

    expect(() =>
      resolveRealCommanderRuntime(
        { ...base, AI_LEAGUE_CLAUDE_COMMAND: fakeCommand },
        inspection,
      ),
    ).toThrow(/non-allowlisted Claude binaries/);
    expect(() =>
      resolveRealCommanderRuntime(
        { ...base, AI_LEAGUE_CLAUDE_DISALLOWED_TOOLS: "Read" },
        inspection,
      ),
    ).toThrow(/altered Claude tool policy/);
    expect(() =>
      resolveRealCommanderRuntime(
        { ...base, AI_LEAGUE_CLAUDE_TIMEOUT_MS: "12000" },
        inspection,
      ),
    ).toThrow(/altered provider timeout/);
    expect(() =>
      resolveRealCommanderRuntime(
        { ...base, PROXYWAR_TUNE_WAR_MODE: "1" },
        inspection,
      ),
    ).toThrow(/ambient tunable override PROXYWAR_TUNE_WAR_MODE/);
    expect(() =>
      resolveRealCommanderRuntime(
        { ...base, AI_LEAGUE_CLAUDE_MODEL: "claude-sonnet-4-6" },
        inspection,
      ),
    ).toThrow(/exact non-alias Claude model ID/);
    expect(() =>
      resolveRealCommanderRuntime(
        { ...base, AI_LEAGUE_LLM_MODEL: "alias-model" },
        inspection,
      ),
    ).toThrow(/provider alias environment/);
  });

  it("makes an otherwise valid model or binary-version change nonmixable", () => {
    const providerCwd = emptyProviderCwd();
    const inspection = {
      resolveDefaultBinary: () => "/opt/bin/claude",
      realpath: (value: string) => value,
      readBinary: () => Buffer.from("binary"),
      readVersion: () => "1.0.0",
    };
    const first = resolveRealCommanderRuntime(
      { AI_LEAGUE_CLAUDE_MODEL: "claude-fable-5-20260821" },
      inspection,
      providerCwd,
    );
    const second = resolveRealCommanderRuntime(
      { AI_LEAGUE_CLAUDE_MODEL: "claude-opus-5-20260821" },
      inspection,
      providerCwd,
    );
    const third = resolveRealCommanderRuntime(
      { AI_LEAGUE_CLAUDE_MODEL: "claude-fable-5-20260821" },
      { ...inspection, readVersion: () => "1.0.1" },
      providerCwd,
    );

    expect(first.identity.identitySha256).not.toBe(
      second.identity.identitySha256,
    );
    expect(first.identity.identitySha256).not.toBe(
      third.identity.identitySha256,
    );
    const changedPath = resolveRealCommanderRuntime(
      {
        PATH: "/different/sealed/path",
        AI_LEAGUE_CLAUDE_MODEL: "claude-fable-5-20260821",
      },
      inspection,
      providerCwd,
    );
    const irrelevantSecret = resolveRealCommanderRuntime(
      {
        AI_LEAGUE_CLAUDE_MODEL: "claude-fable-5-20260821",
        UNRELATED_SECRET: "must-not-enter-evidence",
      },
      inspection,
      providerCwd,
    );
    expect(first.identity.identitySha256).not.toBe(
      changedPath.identity.identitySha256,
    );
    expect(irrelevantSecret.identity.identitySha256).toBe(
      first.identity.identitySha256,
    );
    expect(
      irrelevantSecret.identity.environment.childEnvironmentKeys,
    ).not.toContain("UNRELATED_SECRET");
  });

  it("rejects a provider config relabeled with an unchanged sealed identity", () => {
    const runtime = resolveRealCommanderRuntime(
      { AI_LEAGUE_CLAUDE_MODEL: "claude-fable-5-20260821" },
      {
        resolveDefaultBinary: () => "/opt/bin/claude",
        realpath: (value) => value,
        readBinary: () => Buffer.from("binary"),
        readVersion: () => "1.0.0",
      },
    );
    runtime.providerConfig!.timeoutMs = 999;

    expect(() => assertResolvedCommanderRuntime(runtime)).toThrow(
      /provider config disagrees with its identity/,
    );
    runtime.providerConfig!.timeoutMs = COMMANDER_PROVIDER_KILL_TIMEOUT_MS;
    runtime.providerConfig!.cwd = "/tmp/relabeled-provider-cwd";
    expect(() => assertResolvedCommanderRuntime(runtime)).toThrow(
      /provider config disagrees with its identity/,
    );
    runtime.providerConfig!.cwd = runtime.identity.provider.cwd!;
    runtime.providerConfig!.safeMode = false;
    expect(() => assertResolvedCommanderRuntime(runtime)).toThrow(
      /provider config disagrees with its identity/,
    );
  });

  it("requires the sealed provider cwd to remain the same real empty directory", async () => {
    const providerCwd = emptyProviderCwd();
    const runtime = resolveRealCommanderRuntime(
      { AI_LEAGUE_CLAUDE_MODEL: "claude-fable-5-20260821" },
      {
        resolveDefaultBinary: () => "/opt/bin/claude",
        realpath: (value) => value,
        readBinary: () => Buffer.from("binary"),
        readVersion: () => "1.0.0",
      },
      providerCwd,
    );
    await writeFile(path.join(providerCwd, "CLAUDE.md"), "host memory\n");

    expect(() => assertResolvedCommanderRuntime(runtime)).toThrow(
      /provider cwd is not empty/,
    );
  });

  it("creates one exclusive owner-only provider cwd per experiment UUID", () => {
    const temporaryRoot = emptyProviderCwd();
    const experimentID = "523e4567-e89b-42d3-a456-426614174000";
    const providerCwd = prepareCommanderProviderCwd(
      experimentID,
      temporaryRoot,
    );
    expect(providerCwd).toContain(experimentID);
    expect(() =>
      prepareCommanderProviderCwd(experimentID, temporaryRoot),
    ).toThrow(/already exists; refusing experiment reuse/);
  });
});

describe("Commander experiment evidence reservation", () => {
  it("derives one canonical evidence root from the UUID alone", () => {
    const experimentID = "123e4567-e89b-42d3-a456-426614174000";
    expect(
      commanderExperimentOutputDirectory("/tmp/source", experimentID),
    ).toBe(
      `/tmp/source/artifacts/ai-learning-comparisons/commander-experiment-${experimentID}`,
    );
  });

  it("refuses a reused output root without changing the registered manifest bytes", async () => {
    const root = await temporaryDirectory();
    const outputDirectory = path.join(root, "experiment-output");
    const source = await captureCommanderSourceIdentity();
    const runtime = resolveScriptedCommanderRuntime().identity;
    const manifest: CommanderExperimentPreRegistration = {
      schemaVersion: 1,
      experimentKind: "strategic-commander-three-arm",
      experimentID: "123e4567-e89b-42d3-a456-426614174000",
      createdAt: "2026-08-21T00:00:00.000Z",
      source,
      runtime,
      configuration: { maxSteps: 7 },
      seeds: [
        {
          replicaIndex: 0,
          runID: "run",
          seed: "seed",
          gameID: "CM000001",
          subjectSeatIndex: 0,
          episodeIndex: 0,
          armOrder: ["A", "B", "C"],
        },
      ],
      expectedArmManifestPaths: [],
    };
    const first = await reserveCommanderExperimentOutput({
      outputDirectory,
      manifest,
    });
    const bytesBefore = await readFile(first.manifestPath);

    await expect(
      reserveCommanderExperimentOutput({ outputDirectory, manifest }),
    ).rejects.toThrow(/output root already exists; refusing overwrite/);
    expect(await readFile(first.manifestPath)).toEqual(bytesBefore);
  });

  it("rejects a canonical output path redirected by a symlink ancestor", async () => {
    const sourceRoot = await temporaryDirectory();
    const outsideRoot = await temporaryDirectory();
    await symlink(outsideRoot, path.join(sourceRoot, "artifacts"));
    const source = await captureCommanderSourceIdentity();
    const runtime = resolveScriptedCommanderRuntime().identity;
    const experimentID = "623e4567-e89b-42d3-a456-426614174000";
    const manifest: CommanderExperimentPreRegistration = {
      schemaVersion: 1,
      experimentKind: "strategic-commander-three-arm",
      experimentID,
      createdAt: "2026-08-21T00:00:00.000Z",
      source,
      runtime,
      configuration: {},
      seeds: [],
      expectedArmManifestPaths: [],
    };

    await expect(
      reserveCommanderExperimentOutput({
        outputDirectory: commanderExperimentOutputDirectory(
          sourceRoot,
          experimentID,
        ),
        manifest,
        containmentRoot: sourceRoot,
      }),
    ).rejects.toThrow(/symlink or non-directory/);
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it("rejects a leaf symlink instead of sealing the target under a different path", async () => {
    const outputDirectory = await temporaryDirectory();
    const actualPath = path.join(outputDirectory, "actual.txt");
    const requestedPath = path.join(outputDirectory, "expected.json");
    await writeFile(actualPath, "actual evidence\n", "utf8");
    await symlink(actualPath, requestedPath);
    const source = await captureCommanderSourceIdentity();
    const runtime = resolveScriptedCommanderRuntime().identity;

    await expect(
      writeCommanderExperimentSeal({
        outputDirectory,
        seal: {
          schemaVersion: 1,
          experimentKind: "strategic-commander-three-arm-seal",
          experimentID: "923e4567-e89b-42d3-a456-426614174000",
          status: "complete",
          reasons: [],
          preRegistrationManifestSha256: "a".repeat(64),
          finalSource: source,
          finalRuntime: runtime,
          recapture: {
            source: "captured",
            runtime: "captured",
            sourceFailure: null,
            runtimeFailure: null,
          },
        },
        artifactPaths: [requestedPath],
      }),
    ).rejects.toThrow(/not a real file|symlink/);
  });

  it("inventories every surviving regular file in an invalid experiment", async () => {
    const outputDirectory = await temporaryDirectory();
    const preRegistrationPath = path.join(
      outputDirectory,
      "commander-experiment-manifest.json",
    );
    const armDirectory = path.join(outputDirectory, "inputs", "triplet", "A");
    await mkdir(armDirectory, { recursive: true });
    const decisionsPath = path.join(armDirectory, "decisions.json");
    const replayPath = path.join(armDirectory, "replay.json");
    await Promise.all([
      writeFile(preRegistrationPath, "preregistered\n", "utf8"),
      writeFile(decisionsPath, "partial decisions\n", "utf8"),
      writeFile(replayPath, "partial replay\n", "utf8"),
    ]);
    const source = await captureCommanderSourceIdentity();
    const runtime = resolveScriptedCommanderRuntime().identity;

    const written = await writeCommanderExperimentSeal({
      outputDirectory,
      seal: {
        schemaVersion: 1,
        experimentKind: "strategic-commander-three-arm-seal",
        experimentID: "a23e4567-e89b-42d3-a456-426614174000",
        status: "invalid",
        reasons: ["category=experiment_failure"],
        preRegistrationManifestSha256: "b".repeat(64),
        finalSource: source,
        finalRuntime: runtime,
        recapture: {
          source: "captured",
          runtime: "captured",
          sourceFailure: null,
          runtimeFailure: null,
        },
      },
      artifactPaths: [preRegistrationPath],
    });

    expect(written.envelope.seal.artifacts.map((entry) => entry.path)).toEqual([
      "commander-experiment-manifest.json",
      "inputs/triplet/A/decisions.json",
      "inputs/triplet/A/replay.json",
    ]);
  });

  it("rejects impossible complete and invalid seal status combinations", async () => {
    const outputDirectory = await temporaryDirectory();
    const source = await captureCommanderSourceIdentity();
    const runtime = resolveScriptedCommanderRuntime().identity;
    const common = {
      schemaVersion: 1 as const,
      experimentKind: "strategic-commander-three-arm-seal" as const,
      experimentID: "b23e4567-e89b-42d3-a456-426614174000",
      preRegistrationManifestSha256: "c".repeat(64),
    };

    await expect(
      writeCommanderExperimentSeal({
        outputDirectory,
        seal: {
          ...common,
          status: "complete",
          reasons: [],
          finalSource: null,
          finalRuntime: runtime,
          recapture: {
            source: "unavailable",
            runtime: "captured",
            sourceFailure: "category=experiment_failure",
            runtimeFailure: null,
          },
        },
        artifactPaths: [],
      }),
    ).rejects.toThrow(/Complete Commander experiment seal/);

    await expect(
      writeCommanderExperimentSeal({
        outputDirectory,
        seal: {
          ...common,
          status: "invalid",
          reasons: [],
          finalSource: source,
          finalRuntime: runtime,
          recapture: {
            source: "captured",
            runtime: "captured",
            sourceFailure: null,
            runtimeFailure: null,
          },
        },
        artifactPaths: [],
      }),
    ).rejects.toThrow(/requires a reason/);

    await expect(
      writeCommanderExperimentSeal({
        outputDirectory,
        seal: {
          ...common,
          status: "invalid",
          reasons: ["category=experiment_failure"],
          finalSource: null,
          finalRuntime: runtime,
          recapture: {
            source: "unavailable",
            runtime: "captured",
            sourceFailure: null,
            runtimeFailure: null,
          },
        },
        artifactPaths: [],
      }),
    ).rejects.toThrow(/inconsistent source recapture status/);

    await expect(
      writeCommanderExperimentSeal({
        outputDirectory,
        seal: {
          ...common,
          status: "bogus" as "invalid",
          reasons: ["category=experiment_failure"],
          finalSource: source,
          finalRuntime: runtime,
          recapture: {
            source: "captured",
            runtime: "captured",
            sourceFailure: null,
            runtimeFailure: null,
          },
        },
        artifactPaths: [],
      }),
    ).rejects.toThrow(/seal status is unknown/);

    await expect(
      writeCommanderExperimentSeal({
        outputDirectory,
        seal: {
          ...common,
          status: "invalid",
          reasons: ["category=experiment_failure"],
          finalSource: source,
          finalRuntime: runtime,
          recapture: {
            source: "bogus" as "captured",
            runtime: "captured",
            sourceFailure: null,
            runtimeFailure: null,
          },
        },
        artifactPaths: [],
      }),
    ).rejects.toThrow(/unknown source recapture status/);
  });
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "commander-protocol-"));
  temporaryRoots.push(root);
  return realpathSync(root);
}
