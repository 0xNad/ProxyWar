import fs from "fs/promises";
import { spawnSync } from "node:child_process";
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
      'CLIPS_EXPECTED_TREE="${PROXYWAR_CLIPS_EXPECTED_TREE:-}"',
    );
    expect(wrapper).toContain(
      'CLIPS_EXPECTED_BUILD_SHA256="${PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256:-}"',
    );
    expect(wrapper).toContain(
      "Clip activation does not match the clean deployed commit, tree, and build; Clips disabled",
    );
    expect(wrapper).toContain(
      'if [[ "$ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE" == "true" && "$CLIPS_RELEASE_OVERRIDE" == "true" ]]',
    );
    expect(wrapper).toContain("export PROXYWAR_CLIPS_ENABLED=true");
    expect(wrapper).toContain("export PROXYWAR_PREMIERE_CLIPS_ENABLED=false");
    expect(wrapper).toContain("export PROXYWAR_LEAGUE_CLIPS_ENABLED=true");
    expect(wrapper).toContain("unset PROXYWAR_CLIPS_RELEASE_OVERRIDE");
    expect(runbook).toContain(
      "launchctl setenv PROXYWAR_CLIPS_RELEASE_OVERRIDE true",
    );
    expect(runbook).toContain(
      "launchctl unsetenv PROXYWAR_CLIPS_RELEASE_OVERRIDE",
    );
  });

  it.skipIf(process.platform !== "darwin")(
    "binds Clip activation to a clean commit, tree, and production build while failing drift closed",
    async () => {
      const fixture = await fs.mkdtemp(
        path.join(os.tmpdir(), "pw-clip-release-"),
      );
      const projectDir = path.join(fixture, "project");
      const envFile = path.join(fixture, "proxywar-beta.env");
      const fakeNode = path.join(fixture, "fake-node.zsh");
      const fakeGit = path.join(fixture, "git");
      const releaseStateFile = path.join(fixture, "clip-release-v1.json");
      const realGit = spawnSync("/bin/zsh", ["-lc", "command -v git"], {
        encoding: "utf8",
      }).stdout.trim();
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
      await fs.writeFile(
        envFile,
        [
          "PROXYWAR_CLIPS_ENABLED=false",
          "PROXYWAR_PREMIERE_CLIPS_ENABLED=true",
          "PROXYWAR_LEAGUE_CLIPS_ENABLED=false",
          `PROXYWAR_REPLAY_PREMIERE_STATE_ROOT=${fixture}`,
          "",
        ].join("\n"),
      );
      await fs.writeFile(
        fakeNode,
        [
          "#!/bin/zsh",
          `if [[ "$1" == */proxywar-clips-release-state.mjs ]]; then exec ${JSON.stringify(process.execPath)} "$@"; fi`,
          'print -r -- "$PROXYWAR_CLIPS_ENABLED|$PROXYWAR_PREMIERE_CLIPS_ENABLED|$PROXYWAR_LEAGUE_CLIPS_ENABLED|${PROXYWAR_CLIPS_RELEASE_OVERRIDE-unset}|${PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE-unset}"',
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      await fs.writeFile(
        fakeGit,
        [
          "#!/bin/zsh",
          'if [[ "${PROXYWAR_TEST_GIT_STATUS_FAIL:-false}" == "true" && "$3" == "status" ]]; then exit 70; fi',
          `exec ${JSON.stringify(realGit)} "$@"`,
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
      const runWrapper = (overrides: Record<string, string>) =>
        spawnSync(
          "/bin/zsh",
          [path.join(root, "deploy", "mac", "start-proxywar-beta.zsh")],
          {
            cwd: projectDir,
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${fixture}:${process.env.PATH ?? ""}`,
              PROXYWAR_PROJECT_DIR: projectDir,
              PROXYWAR_ENV_FILE: envFile,
              PROXYWAR_NODE_BIN: fakeNode,
              PROXYWAR_CLIPS_EXPECTED_COMMIT: commit,
              PROXYWAR_CLIPS_EXPECTED_TREE: tree,
              PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256: buildSha256,
              ...overrides,
            },
          },
        );
      try {
        const enabled = runWrapper({ PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true" });
        expect(enabled.status).toBe(0);
        expect(enabled.stderr).toContain(
          "Clip activation source: release_manager",
        );
        expect(enabled.stdout.trim()).toBe("true|false|true|unset|unset");

        const statusFailure = runWrapper({
          PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true",
          PROXYWAR_TEST_GIT_STATUS_FAIL: "true",
        });
        expect(statusFailure.status).toBe(0);
        expect(statusFailure.stderr).toContain(
          "Clip activation could not verify the deployed commit, tree, status, and build; Clips disabled",
        );
        expect(statusFailure.stdout.trim()).toBe(
          "false|false|false|unset|unset",
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
        const stateStatus = spawnSync(
          process.execPath,
          [
            path.join(
              projectDir,
              "deploy",
              "mac",
              "proxywar-clips-release-state.mjs",
            ),
            "status",
            `--path=${releaseStateFile}`,
            "--shell=true",
          ],
          { encoding: "utf8" },
        );
        expect(stateStatus.status, stateStatus.stderr).toBe(0);
        expect(stateStatus.stdout.trim()).toBe(
          `enabled ${commit} ${tree} ${buildSha256}`,
        );
        const rebootRecovered = runWrapper({});
        expect(rebootRecovered.status).toBe(0);
        expect(rebootRecovered.stderr).toContain(
          "Clip activation source: durable_state",
        );
        expect(rebootRecovered.stdout.trim()).toBe(
          "true|false|true|unset|unset",
        );
        await fs.writeFile(
          releaseStateFile,
          '{"schemaVersion":1,"enabled":false,"commit":null,"tree":null,"buildSha256":null}\n',
          { mode: 0o600 },
        );
        const durablyDisabled = runWrapper({});
        expect(durablyDisabled.status).toBe(0);
        expect(durablyDisabled.stdout.trim()).toBe(
          "false|false|false|unset|unset",
        );

        const conflict = runWrapper({
          PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE: "true",
          PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true",
        });
        expect(conflict.status).toBe(0);
        expect(conflict.stderr).toContain(
          "Clip canary and release overrides cannot be enabled together",
        );
        expect(conflict.stdout.trim()).toBe("false|false|false|unset|unset");

        await fs.writeFile(path.join(projectDir, "untracked.ts"), "drift\n");
        const untracked = runWrapper({
          PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true",
        });
        expect(untracked.status).toBe(0);
        expect(untracked.stderr).toContain(
          "Clip activation does not match the clean deployed commit, tree, and build; Clips disabled",
        );
        expect(untracked.stdout.trim()).toBe("false|false|false|unset|unset");
        await fs.rm(path.join(projectDir, "untracked.ts"));

        await fs.writeFile(
          path.join(projectDir, "static", "index.html"),
          "v2\n",
        );
        const buildDrift = runWrapper({
          PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true",
        });
        expect(buildDrift.status).toBe(0);
        expect(buildDrift.stderr).toContain("Clips disabled");
        expect(buildDrift.stdout.trim()).toBe("false|false|false|unset|unset");
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
        expect(symlinkBuild.stderr).toContain("Clips disabled");
        expect(symlinkBuild.stdout.trim()).toBe(
          "false|false|false|unset|unset",
        );
        await fs.rm(path.join(projectDir, "static", "linked-readme"));

        await fs.writeFile(
          path.join(projectDir, "README.md"),
          "tracked drift\n",
        );
        const tracked = runWrapper({ PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true" });
        expect(tracked.status).toBe(0);
        expect(tracked.stderr).toContain("Clips disabled");
        expect(tracked.stdout.trim()).toBe("false|false|false|unset|unset");
        await fs.writeFile(path.join(projectDir, "README.md"), "fixture\n");

        await fs.rm(path.join(projectDir, "static"), {
          recursive: true,
          force: true,
        });
        const missingBuild = runWrapper({
          PROXYWAR_CLIPS_RELEASE_OVERRIDE: "true",
        });
        expect(missingBuild.status).toBe(0);
        expect(missingBuild.stderr).toContain("Clips disabled");
        expect(missingBuild.stdout.trim()).toBe(
          "false|false|false|unset|unset",
        );
      } finally {
        await fs.rm(fixture, { recursive: true, force: true });
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
