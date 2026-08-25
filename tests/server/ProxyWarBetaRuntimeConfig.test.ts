import fs from "fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");

describe("Proxy War beta runtime config", () => {
  it("keeps the direct premiere-loop wrapper in the package projector environment", async () => {
    const [packageJson, wrapper] = await Promise.all([
      fs
        .readFile(path.join(root, "package.json"), "utf8")
        .then(
          (source) => JSON.parse(source) as { scripts: Record<string, string> },
        ),
      fs.readFile(
        path.join(root, "deploy", "mac", "start-proxywar-premiere-loop.zsh"),
        "utf8",
      ),
    ]);

    expect(packageJson.scripts["premiere:loop"]).toContain("GAME_ENV=dev");
    const gameEnvironment = wrapper.indexOf("export GAME_ENV=dev");
    const directNode = wrapper.indexOf(
      'exec "$NODE_BIN" --import tsx src/scripts/replay-premiere-loop.ts',
    );
    expect(gameEnvironment).toBeGreaterThanOrEqual(0);
    expect(directNode).toBeGreaterThan(gameEnvironment);
  });

  it("keeps the archived Clip canary master override explicit and bounded to the server wrapper", async () => {
    const [wrapper, runbook] = await Promise.all([
      fs.readFile(
        path.join(root, "deploy", "mac", "start-proxywar-beta.zsh"),
        "utf8",
      ),
      fs.readFile(
        path.join(root, "docs", "PROXYWAR_ARCHIVED_CLIP_CANARY.md"),
        "utf8",
      ),
    ]);

    expect(wrapper).toContain(
      'ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE="${PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE:-false}"',
    );
    expect(wrapper).toContain(
      'if [[ "$ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE" == "true" ]]',
    );
    expect(wrapper).toContain("export PROXYWAR_CLIPS_ENABLED=true");
    expect(wrapper).toContain(
      "unset PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE",
    );
    expect(runbook).toContain(
      "launchctl setenv PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE true",
    );
    expect(runbook).toContain(
      "launchctl unsetenv PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE",
    );
  });

  it("keeps general replay Clip enablement explicit, complete, and mutually exclusive with the canary", async () => {
    const [wrapper, runbook] = await Promise.all([
      fs.readFile(
        path.join(root, "deploy", "mac", "start-proxywar-beta.zsh"),
        "utf8",
      ),
      fs.readFile(
        path.join(root, "docs", "PROXYWAR_ARCHIVED_CLIP_CANARY.md"),
        "utf8",
      ),
    ]);

    expect(wrapper).toContain(
      'CLIPS_RELEASE_OVERRIDE="${PROXYWAR_CLIPS_RELEASE_OVERRIDE:-false}"',
    );
    expect(wrapper).toContain(
      'CLIPS_EXPECTED_COMMIT="${PROXYWAR_CLIPS_EXPECTED_COMMIT:-}"',
    );
    expect(wrapper).toContain(
      'CLIPS_FORCE_DISABLED="${PROXYWAR_CLIPS_FORCE_DISABLED:-false}"',
    );
    expect(wrapper).toContain(
      'CLIPS_VERIFY_ATTESTATION_ONLY="${PROXYWAR_CLIPS_VERIFY_ATTESTATION_ONLY:-false}"',
    );
    expect(wrapper).toContain(
      'CLIPS_EXPECTED_TREE="${PROXYWAR_CLIPS_EXPECTED_TREE:-}"',
    );
    expect(wrapper).toContain(
      'CLIPS_EXPECTED_BUILD_SHA256="${PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256:-}"',
    );
    expect(wrapper).toContain(
      'CLIPS_EXPECTED_ATTESTATION_NONCE="${PROXYWAR_CLIPS_EXPECTED_ATTESTATION_NONCE:-}"',
    );
    expect(wrapper).toContain("proxywar-clips-deployment-attestation.mjs");
    const helperSha256 = createHash("sha256")
      .update(
        await fs.readFile(
          path.join(
            root,
            "deploy",
            "mac",
            "proxywar-clips-deployment-attestation.mjs",
          ),
        ),
      )
      .digest("hex");
    expect(wrapper).toContain(
      `CLIPS_DEPLOYMENT_ATTESTATION_HELPER_SHA256="${helperSha256}"`,
    );
    expect(wrapper).not.toContain('$(git -C "$PROJECT_DIR"');
    expect(wrapper).not.toContain("PROXYWAR_CLIPS_RELEASE_STATE_FILE");
    expect(wrapper).not.toContain(
      '"$PROJECT_DIR/deploy/mac/proxywar-clips-release-state.mjs"',
    );
    expect(wrapper).toContain(
      '"failed tracked_content") CLIPS_DEPLOYMENT_ATTESTATION_STAGE="tracked content"',
    );
    expect(wrapper).toContain(
      '"failed runtime_inventory") CLIPS_DEPLOYMENT_ATTESTATION_STAGE="runtime inventory"',
    );
    expect(wrapper).toContain(
      'echo "Clip deployment attestation verification passed" >&2',
    );
    expect(wrapper).toContain(
      'if [[ "$CLIPS_FORCE_DISABLED" != "true" && "$ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE" == "true" && "$CLIPS_RELEASE_OVERRIDE" == "true" ]]',
    );
    expect(wrapper).toContain("export PROXYWAR_CLIPS_ENABLED=true");
    expect(wrapper).toContain("export PROXYWAR_PREMIERE_CLIPS_ENABLED=false");
    expect(wrapper).toContain("export PROXYWAR_LEAGUE_CLIPS_ENABLED=true");
    expect(wrapper).toContain("unset PROXYWAR_CLIPS_RELEASE_OVERRIDE");
    expect(wrapper).toContain("unset PROXYWAR_CLIPS_FORCE_DISABLED");
    expect(runbook).toContain(
      "launchctl setenv PROXYWAR_CLIPS_RELEASE_OVERRIDE true",
    );
    expect(runbook).toContain(
      "launchctl unsetenv PROXYWAR_CLIPS_RELEASE_OVERRIDE",
    );
    expect(runbook).toContain(
      "launchctl setenv PROXYWAR_CLIPS_VERIFY_ATTESTATION_ONLY true",
    );
    expect(runbook).toContain(
      "Clip deployment attestation verification passed",
    );
    expect(runbook).toContain(
      'test "$(launchctl getenv PROXYWAR_CLIPS_EXPECTED_COMMIT)" = "$RELEASE_COMMIT"',
    );
    expect(runbook).toContain(
      'test "$(launchctl getenv PROXYWAR_CLIPS_EXPECTED_TREE)" = "$RELEASE_TREE"',
    );
    expect(runbook).toContain(
      'test "$(launchctl getenv PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256)" = "$RELEASE_BUILD_SHA256"',
    );
    expect(runbook).not.toContain("--git-bin=");
    expect(runbook).toContain("these eight unsets");
  });

  // macOS-only, so CI (ubuntu-latest on every job) always skips it — a developer
  // Mac is the ONLY place this ever runs, and therefore the only place its cost
  // is ever paid: real mkdtemp, chmod, copied helpers and a PATH-shimmed node,
  // ~1.4s warm but past vitest's old 5s default cold. Covered by the shared 60s
  // testTimeout in vite.config.ts.
  it.skipIf(process.platform !== "darwin")(
    "binds Clip activation to the outside-Documents content attestation after the private env replaces PATH",
    async () => {
      const rawFixture = await fs.mkdtemp(
        path.join(os.tmpdir(), "pw-clip-release-"),
      );
      const fixture = await fs.realpath(rawFixture);
      const projectDir = path.join(fixture, "project");
      const envFile = path.join(fixture, "proxywar-beta.env");
      const fakeNode = path.join(fixture, "fake-node.zsh");
      const trustedRoot = path.join(fixture, "trusted");
      const stateRoot = path.join(trustedRoot, "storage", "replay-premiere");
      const binRoot = path.join(trustedRoot, "bin");
      const installedWrapper = path.join(binRoot, "start-proxywar-beta.zsh");
      const installedHelper = path.join(
        binRoot,
        "proxywar-clips-deployment-attestation.mjs",
      );
      const attestationHelper = path.join(
        root,
        "deploy",
        "mac",
        "proxywar-clips-deployment-attestation.mjs",
      );
      const releaseStateFile = path.join(stateRoot, "clip-release-v1.json");
      await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
      await fs.chmod(trustedRoot, 0o700);
      await fs.chmod(path.join(trustedRoot, "storage"), 0o700);
      await fs.chmod(stateRoot, 0o700);
      await fs.mkdir(binRoot, { mode: 0o755 });
      await fs.mkdir(path.join(projectDir, "static"), { recursive: true });
      await fs.mkdir(path.join(projectDir, "deploy", "mac"), {
        recursive: true,
      });
      await fs.writeFile(path.join(projectDir, "static", "index.html"), "v1\n");
      await fs.copyFile(
        path.join(root, "deploy", "mac", "proxywar-clips-release-state.mjs"),
        path.join(
          projectDir,
          "deploy",
          "mac",
          "proxywar-clips-release-state.mjs",
        ),
      );
      await fs.writeFile(path.join(projectDir, ".gitignore"), "static/\n");
      await fs.writeFile(path.join(projectDir, "README.md"), "fixture\n");
      await fs.copyFile(
        path.join(root, "deploy", "mac", "start-proxywar-beta.zsh"),
        installedWrapper,
      );
      await fs.chmod(installedWrapper, 0o755);
      await fs.copyFile(attestationHelper, installedHelper);
      await fs.chmod(installedHelper, 0o755);
      await fs.writeFile(
        envFile,
        [
          "PROXYWAR_CLIPS_ENABLED=false",
          "PROXYWAR_PREMIERE_CLIPS_ENABLED=true",
          "PROXYWAR_LEAGUE_CLIPS_ENABLED=false",
          `PATH=${JSON.stringify(path.join(fixture, "private-env-bin-without-git"))}`,
          `PROXYWAR_REPLAY_PREMIERE_STATE_ROOT=${JSON.stringify(stateRoot)}`,
          "",
        ].join("\n"),
      );
      await fs.writeFile(
        fakeNode,
        [
          "#!/bin/zsh",
          'if [[ "$1" == */proxywar-clips-release-state.mjs ]]; then exit 91; fi',
          `if [[ "$1" == */proxywar-clips-deployment-attestation.mjs ]]; then exec ${JSON.stringify(process.execPath)} "$@"; fi`,
          'print -r -- "$PROXYWAR_CLIPS_ENABLED|$PROXYWAR_PREMIERE_CLIPS_ENABLED|$PROXYWAR_LEAGUE_CLIPS_ENABLED|${PROXYWAR_CLIPS_RELEASE_OVERRIDE-unset}|${PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE-unset}|${PROXYWAR_CLIPS_EXPECTED_ATTESTATION_NONCE-unset}"',
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      for (const args of [
        ["init", "-q"],
        ["config", "user.email", "clip-test@proxywar.invalid"],
        ["config", "user.name", "ProxyWar Clip Test"],
        [
          "add",
          ".gitignore",
          "README.md",
          "deploy/mac/proxywar-clips-release-state.mjs",
        ],
        ["commit", "-qm", "fixture"],
      ]) {
        expect(spawnSync("git", args, { cwd: projectDir }).status).toBe(0);
      }
      const commit = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: projectDir,
        encoding: "utf8",
      }).stdout.trim();
      const tree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: projectDir,
        encoding: "utf8",
      }).stdout.trim();
      const buildHashResult = spawnSync(
        process.execPath,
        [
          path.join(
            projectDir,
            "deploy",
            "mac",
            "proxywar-clips-release-state.mjs",
          ),
          "build-hash",
          `--path=${path.join(projectDir, "static")}`,
        ],
        { encoding: "utf8" },
      );
      expect(buildHashResult.status, buildHashResult.stderr).toBe(0);
      const buildSha256 = buildHashResult.stdout.trim();
      expect(buildSha256).toMatch(/^[a-f0-9]{64}$/);
      const wrapperSha256 = createHash("sha256")
        .update(await fs.readFile(installedWrapper))
        .digest("hex");
      const helperSha256 = createHash("sha256")
        .update(await fs.readFile(installedHelper))
        .digest("hex");
      const createAttestation = spawnSync(
        process.execPath,
        [
          attestationHelper,
          "create",
          `--state-root=${stateRoot}`,
          `--trusted-root=${trustedRoot}`,
          `--project-dir=${projectDir}`,
          `--wrapper-path=${installedWrapper}`,
          `--helper-path=${installedHelper}`,
          `--expected-commit=${commit}`,
          `--expected-tree=${tree}`,
          `--expected-build-sha256=${buildSha256}`,
          `--expected-wrapper-sha256=${wrapperSha256}`,
          `--expected-helper-sha256=${helperSha256}`,
        ],
        { encoding: "utf8" },
      );
      expect(createAttestation.status, createAttestation.stderr).toBe(0);
      const attestationNonce = (
        JSON.parse(createAttestation.stdout) as { nonce: string }
      ).nonce;
      expect(attestationNonce).toMatch(/^[a-f0-9]{64}$/);
      const runWrapper = (overrides: Record<string, string>) =>
        spawnSync("/bin/zsh", [installedWrapper], {
          cwd: projectDir,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: process.env.PATH ?? "",
            PROXYWAR_PROJECT_DIR: projectDir,
            PROXYWAR_ENV_FILE: envFile,
            PROXYWAR_NODE_BIN: fakeNode,
            PROXYWAR_CLIPS_EXPECTED_COMMIT: commit,
            PROXYWAR_CLIPS_EXPECTED_TREE: tree,
            PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256: buildSha256,
            PROXYWAR_CLIPS_EXPECTED_ATTESTATION_NONCE: attestationNonce,
            ...overrides,
          },
        });
      try {
        const enabled = runWrapper({ PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true" });
        expect(enabled.status, enabled.stderr).toBe(0);
        expect(enabled.stderr).toContain(
          "Clip activation source: release_manager",
        );
        expect(enabled.stdout.trim()).toBe("true|false|true|unset|unset|unset");

        const disabledProbe = runWrapper({
          PROXYWAR_CLIPS_FORCE_DISABLED: "true",
          PROXYWAR_CLIPS_VERIFY_ATTESTATION_ONLY: "true",
        });
        expect(disabledProbe.status).toBe(0);
        expect(disabledProbe.stderr).toContain(
          "Clip deployment attestation verification passed",
        );
        expect(disabledProbe.stderr).not.toContain("Clip activation source:");
        expect(disabledProbe.stdout.trim()).toBe(
          "false|false|false|unset|unset|unset",
        );

        const unsafeProbe = runWrapper({
          PROXYWAR_CLIPS_VERIFY_ATTESTATION_ONLY: "true",
        });
        expect(unsafeProbe.status).toBe(0);
        expect(unsafeProbe.stderr).toContain(
          "Clip deployment attestation probe requires force-disabled with activation overrides unset; Clips disabled",
        );
        expect(unsafeProbe.stderr).not.toContain(
          "Clip deployment attestation verification passed",
        );

        const wrongNonce = runWrapper({
          PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true",
          PROXYWAR_CLIPS_EXPECTED_ATTESTATION_NONCE: "0".repeat(64),
        });
        expect(wrongNonce.status).toBe(0);
        expect(wrongNonce.stderr).toContain(
          "Clip deployment attestation binding verification failed; Clips disabled",
        );
        expect(wrongNonce.stderr).not.toContain(commit);
        expect(wrongNonce.stderr).not.toContain(tree);
        expect(wrongNonce.stderr).not.toContain(buildSha256);
        expect(wrongNonce.stdout.trim()).toBe(
          "false|false|false|unset|unset|unset",
        );

        const installedHelperBytes = await fs.readFile(installedHelper);
        await fs.writeFile(
          installedHelper,
          "#!/usr/bin/env node\nprocess.exit(1);\n",
        );
        const helperDrift = runWrapper({
          PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true",
        });
        expect(helperDrift.status).toBe(0);
        expect(helperDrift.stderr).toContain(
          "Clip deployment attestation helper verification failed; Clips disabled",
        );
        expect(helperDrift.stdout.trim()).toBe(
          "false|false|false|unset|unset|unset",
        );
        await fs.writeFile(installedHelper, installedHelperBytes);

        await fs.writeFile(
          releaseStateFile,
          `${JSON.stringify({
            schemaVersion: 2,
            enabled: true,
            commit,
            tree,
            buildSha256,
            attestationNonce,
          })}\n`,
          { mode: 0o600 },
        );
        const stateStatus = spawnSync(
          process.execPath,
          [
            installedHelper,
            "release-status",
            `--state-root=${stateRoot}`,
            `--trusted-root=${trustedRoot}`,
          ],
          { encoding: "utf8" },
        );
        expect(stateStatus.status, stateStatus.stderr).toBe(0);
        expect(stateStatus.stdout.trim()).toBe(
          `enabled ${commit} ${tree} ${buildSha256} ${attestationNonce}`,
        );
        const rebootRecovered = runWrapper({});
        expect(rebootRecovered.status).toBe(0);
        expect(rebootRecovered.stderr).toContain(
          "Clip activation source: durable_state",
        );
        expect(rebootRecovered.stdout.trim()).toBe(
          "true|false|true|unset|unset|unset",
        );

        await fs.writeFile(
          releaseStateFile,
          `${JSON.stringify({
            schemaVersion: 1,
            enabled: true,
            commit,
            tree,
            buildSha256,
          })}\n`,
          { mode: 0o600 },
        );
        const unsafeLegacyEnable = runWrapper({});
        expect(unsafeLegacyEnable.status).toBe(0);
        expect(unsafeLegacyEnable.stderr).toContain(
          "Clip durable release state is unsafe or malformed; Clips disabled",
        );
        expect(unsafeLegacyEnable.stdout.trim()).toBe(
          "false|false|false|unset|unset|unset",
        );

        await fs.chmod(releaseStateFile, 0o644);
        const forceDisabled = runWrapper({
          PROXYWAR_CLIPS_FORCE_DISABLED: "true",
        });
        expect(forceDisabled.status).toBe(0);
        expect(forceDisabled.stderr).not.toContain(
          "Clip durable release state is unsafe or malformed",
        );
        expect(forceDisabled.stderr).not.toContain("Clip activation source:");
        expect(forceDisabled.stdout.trim()).toBe(
          "false|false|false|unset|unset|unset",
        );
        const forcedManagerDisable = runWrapper({
          PROXYWAR_CLIPS_FORCE_DISABLED: "true",
          PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true",
        });
        expect(forcedManagerDisable.status).toBe(0);
        expect(forcedManagerDisable.stderr).not.toContain(
          "Clip activation source:",
        );
        expect(forcedManagerDisable.stdout.trim()).toBe(
          "false|false|false|unset|unset|unset",
        );
        await fs.chmod(releaseStateFile, 0o600);
        await fs.writeFile(
          releaseStateFile,
          '{"schemaVersion":1,"enabled":false,"commit":null,"tree":null,"buildSha256":null}\n',
          { mode: 0o600 },
        );
        const durablyDisabled = runWrapper({});
        expect(durablyDisabled.status).toBe(0);
        expect(durablyDisabled.stdout.trim()).toBe(
          "false|false|false|unset|unset|unset",
        );

        const conflict = runWrapper({
          PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE: "true",
          PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true",
        });
        expect(conflict.status).toBe(0);
        expect(conflict.stderr).toContain(
          "Clip canary and release overrides cannot be enabled together",
        );
        expect(conflict.stdout.trim()).toBe(
          "false|false|false|unset|unset|unset",
        );

        await fs.writeFile(
          path.join(projectDir, "static", "index.html"),
          "v2\n",
        );
        const buildDrift = runWrapper({
          PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true",
        });
        expect(buildDrift.status).toBe(0);
        expect(buildDrift.stderr).toContain(
          "Clip deployment attestation static build verification failed; Clips disabled",
        );
        expect(buildDrift.stdout.trim()).toBe(
          "false|false|false|unset|unset|unset",
        );
        await fs.writeFile(
          path.join(projectDir, "static", "index.html"),
          "v1\n",
        );

        await fs.symlink(
          path.join(projectDir, "README.md"),
          path.join(projectDir, "static", "linked-readme"),
        );
        const symlinkBuild = runWrapper({
          PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true",
        });
        expect(symlinkBuild.status).toBe(0);
        expect(symlinkBuild.stderr).toContain(
          "Clip deployment attestation static build verification failed; Clips disabled",
        );
        expect(symlinkBuild.stdout.trim()).toBe(
          "false|false|false|unset|unset|unset",
        );
        await fs.rm(path.join(projectDir, "static", "linked-readme"));

        await fs.writeFile(
          path.join(projectDir, "README.md"),
          "tracked drift\n",
        );
        const tracked = runWrapper({ PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true" });
        expect(tracked.status).toBe(0);
        expect(tracked.stderr).toContain(
          "Clip deployment attestation tracked content verification failed; Clips disabled",
        );
        expect(tracked.stdout.trim()).toBe(
          "false|false|false|unset|unset|unset",
        );
        await fs.writeFile(path.join(projectDir, "README.md"), "fixture\n");

        await fs.writeFile(path.join(projectDir, "src-shadow.ts"), "shadow\n");
        const runtimeShadow = runWrapper({
          PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true",
        });
        expect(runtimeShadow.status).toBe(0);
        expect(runtimeShadow.stderr).toContain(
          "Clip deployment attestation runtime inventory verification failed; Clips disabled",
        );
        expect(runtimeShadow.stdout.trim()).toBe(
          "false|false|false|unset|unset|unset",
        );
        await fs.rm(path.join(projectDir, "src-shadow.ts"));

        await fs.rm(path.join(projectDir, "static"), {
          recursive: true,
          force: true,
        });
        const missingBuild = runWrapper({
          PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true",
        });
        expect(missingBuild.status).toBe(0);
        expect(missingBuild.stderr).toContain(
          "Clip deployment attestation static build verification failed; Clips disabled",
        );
        expect(missingBuild.stdout.trim()).toBe(
          "false|false|false|unset|unset|unset",
        );
      } finally {
        await fs.rm(rawFixture, { recursive: true, force: true });
      }
    },
  );

  it("bounds Claude planner waits in the live beta scripts without shortening the match", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    // The live house brain is the Claude CLI planner; these scripts must bound
    // its per-decision wait and must not carry the deprecated Codex tuners.
    const claudeBetaScripts = [
      "agent:closed-beta",
      "agent:beta",
      "agent:closed-beta:lan",
      "agent:closed-beta:remote",
      "agent:closed-beta:prod",
    ];

    for (const scriptName of claudeBetaScripts) {
      const script = packageJson.scripts[scriptName];
      expect(script, scriptName).toContain(
        "PROXYWAR_HOUSE_AGENT_BRAIN=planner-claude-cli",
      );
      expect(script, scriptName).toContain("AI_LEAGUE_CLAUDE_TIMEOUT_MS=60000");
      expect(script, scriptName).toContain(
        "AI_LEAGUE_REQUIRE_EXTERNAL_BRAIN_SUCCESS=true",
      );
      expect(script, scriptName).not.toContain(
        "AI_LEAGUE_LLM_PROVIDER=codex-cli",
      );
      expect(script, scriptName).not.toContain(
        "AI_LEAGUE_CLAUDE_TIMEOUT_MS=180000",
      );
    }
  });

  it("keeps the Codex fallback beta script bounded without shortening the match", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const script = packageJson.scripts["agent:closed-beta:codex"];

    expect(script).toContain("PROXYWAR_HOUSE_AGENT_BRAIN=planner-codex-cli");
    expect(script).toContain("AI_LEAGUE_CODEX_TIMEOUT_MS=45000");
    expect(script).toContain("AI_LEAGUE_CODEX_APP_SERVER_FALLBACK=false");
    expect(script).not.toContain("AI_LEAGUE_CODEX_TIMEOUT_MS=180000");
  });
});
