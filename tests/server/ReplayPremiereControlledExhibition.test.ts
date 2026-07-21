import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
} from "../../src/core/game/Game";
import {
  GAME_ID_REGEX,
  GameRecordSchema,
  type GameRecord,
} from "../../src/core/Schemas";
import type {
  AgentLeagueSmokeExecutionConfig,
  AgentLeagueSmokeRunOptions,
} from "../../src/scripts/ai-agent-league-smoke";
import {
  assertControlledBehaviorEnvironment,
  controlledExhibitionMinimumFreeBytes,
  loadControlledPolicyProvenance,
  loadControlledPolicySet,
  prepareControlledExhibitionOutput,
  resolveControlledExhibitionBuildProvenance,
  runControlledExhibition,
  writeControlledExhibitionBundle,
  type ControlledExhibitionBuildProvenance,
  type ControlledPolicyProvenance,
} from "../../src/scripts/replay-premiere-controlled-exhibition";
import { deterministicAgentClientID } from "../../src/server/agents/AgentDeterministicIdentity";
import {
  hashReplayPremiereJson,
  sha256Hex,
} from "../../src/server/replay-premiere/ReplayPremiereIntegrity";

const execFileAsync = promisify(execFile);
const GIB = 1024 * 1024 * 1024;

describe("Replay Premiere controlled exhibition source", () => {
  it("derives deterministic client IDs accepted by the replay schema", () => {
    const ids = Array.from({ length: 8 }, (_, index) =>
      deterministicAgentClientID(
        "premiere-phase0-pilot-20260721-a",
        "client",
        index,
      ),
    );
    const retry = deterministicAgentClientID(
      "premiere-phase0-pilot-20260721-a",
      "client",
      0,
    );

    expect(ids.every((id) => GAME_ID_REGEX.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(retry).toBe(ids[0]);
  });

  it("writes one strict private bundle without touching a served root", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "premiere-controlled-"),
    );
    const servedRoot = path.join(root, "served");
    const privateRoot = path.join(root, "private");
    await fs.mkdir(servedRoot, { mode: 0o755 });
    await fs.writeFile(path.join(servedRoot, "sentinel.txt"), "unchanged\n");
    const servedBefore = await directorySnapshot(servedRoot);

    try {
      const result = await writeControlledExhibitionBundle({
        sourceRunId: "controlled-run-001",
        artifact: artifactFixture(),
        policies: policyFixtures(),
        expectedExecutionConfig: executionConfigFixture(),
        build: buildFixture(),
        output: {
          privateOutputRoot: privateRoot,
          servedRoots: [servedRoot],
          maxBundleBytes: 2 * 1024 * 1024,
          minFreeBytes: 25 * GIB,
        },
        statfs: statfsWithFreeBytes(30 * GIB),
      });

      expect(await directorySnapshot(servedRoot)).toEqual(servedBefore);
      expect(await fs.readdir(privateRoot)).toEqual([
        "controlled-run-001.source.json",
      ]);
      expect(result.bundlePath).toBe(
        path.join(
          await fs.realpath(privateRoot),
          "controlled-run-001.source.json",
        ),
      );
      const [directoryStat, bundleStat, bytes] = await Promise.all([
        fs.lstat(privateRoot),
        fs.lstat(result.bundlePath),
        fs.readFile(result.bundlePath),
      ]);
      expect(directoryStat.mode & 0o777).toBe(0o700);
      expect(bundleStat.mode & 0o777).toBe(0o600);
      expect(bundleStat.nlink).toBe(1);
      expect(result.bundleSha256).toBe(sha256Hex(bytes));

      const bundle = JSON.parse(bytes.toString("utf8")) as Record<string, any>;
      expect(bundle.bundleKind).toBe("proxywar_controlled_exhibition_source");
      expect(
        GameRecordSchema.strict().safeParse(bundle.gameRecord).success,
      ).toBe(true);
      expect(bundle.gameRecord.info.winner).toEqual(["player", "SEAT0001"]);
      expect(bundle.replay).toEqual({ turnCount: 4, turnIntervalMs: 100 });
      expect(bundle.seats).toEqual([
        {
          seatId: "SEAT0001",
          displayName: "Alpha",
          policyIdentity: policyFixtures()[0].policyIdentity,
        },
        {
          seatId: "SEAT0002",
          displayName: "Beta",
          policyIdentity: policyFixtures()[1].policyIdentity,
        },
      ]);
      const resultBytes = Buffer.from(
        bundle.authoritativeResult.bytes,
        "base64",
      );
      expect(sha256Hex(resultBytes)).toBe(bundle.authoritativeResult.sha256);
      expect(bundle.authoritativeResult.sha256).toBe(
        result.authoritativeResultHash,
      );
      expect(JSON.parse(resultBytes.toString("utf8"))).toMatchObject({
        sourceRunId: "controlled-run-001",
        sourceId: bundle.authoritativeResult.sourceId,
        gameId: "PREM0001",
        winner: ["player", "SEAT0001"],
      });
      expect(bundle.provenance.executionConfig).toEqual(
        executionConfigFixture(),
      );
      expect(bundle.provenance.executionConfigSha256).toBe(
        hashReplayPremiereJson(bundle.provenance.executionConfig),
      );
      const serialized = bytes.toString("utf8");
      expect(serialized).not.toContain("rawLlmPrompt");
      expect(serialized).not.toContain("rawLlmOutput");
      expect(serialized).not.toContain("decision-tail");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects spawn variance omitted from the GameRecord before writing", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "premiere-spawn-binding-"),
    );
    const servedRoot = path.join(root, "served");
    const privateRoot = path.join(root, "private");
    const artifact = artifactFixture();
    const executionConfig: AgentLeagueSmokeExecutionConfig = {
      ...executionConfigFixture(),
      game: {
        ...executionConfigFixture().game,
        varySpawns: true,
      },
    };
    await fs.mkdir(servedRoot, { recursive: true });

    try {
      await expect(
        writeControlledExhibitionBundle({
          sourceRunId: "controlled-run-001",
          artifact: {
            ...artifact,
            artifactInput: {
              ...artifact.artifactInput,
              runnerConfig: {
                ...artifact.artifactInput.runnerConfig,
                variedSpawns: true,
              },
            },
            executionConfig,
          },
          policies: policyFixtures(),
          expectedExecutionConfig: executionConfig,
          build: buildFixture(),
          output: {
            privateOutputRoot: privateRoot,
            servedRoots: [servedRoot],
            maxBundleBytes: 2 * 1024 * 1024,
            minFreeBytes: 25 * GIB,
          },
          statfs: statfsWithFreeBytes(30 * GIB),
        }),
      ).rejects.toThrow(
        "controlled GameRecord config does not match execution provenance",
      );
      expect(await fs.readdir(privateRoot)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("records the canonical planner mode instead of the smoke artifact label", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "premiere-planner-provenance-"),
    );
    const privateRoot = path.join(root, "private");
    const servedRoot = path.join(root, "served");
    const executionConfig = {
      ...executionConfigFixture(),
      brainMode: "planner" as const,
    };
    const artifact = artifactFixture();

    try {
      await fs.mkdir(servedRoot);
      const result = await writeControlledExhibitionBundle({
        sourceRunId: "controlled-run-001",
        artifact: {
          ...artifact,
          artifactInput: {
            ...artifact.artifactInput,
            brainMode: "planner-executor",
          },
          executionConfig,
        },
        policies: policyFixtures(),
        expectedExecutionConfig: executionConfig,
        build: buildFixture(),
        output: {
          privateOutputRoot: privateRoot,
          servedRoots: [servedRoot],
          maxBundleBytes: 2 * 1024 * 1024,
          minFreeBytes: 25 * GIB,
        },
        statfs: statfsWithFreeBytes(30 * GIB),
      });
      const bundle = JSON.parse(
        await fs.readFile(result.bundlePath, "utf8"),
      ) as Record<string, any>;

      expect(bundle.provenance.brainMode).toBe("planner");
      expect(bundle.provenance.brainMode).toBe(
        bundle.provenance.executionConfig.brainMode,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a private output root inside a served root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-overlap-"));
    const servedRoot = path.join(root, "served");
    await fs.mkdir(servedRoot, { recursive: true });
    try {
      await expect(
        prepareControlledExhibitionOutput({
          privateOutputRoot: path.join(servedRoot, "private"),
          servedRoots: [servedRoot],
          maxBundleBytes: 1024,
          minFreeBytes: 25 * GIB,
        }),
      ).rejects.toThrow("private_and_served_roots_overlap");
      expect(await fs.readdir(servedRoot)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not allow callers to lower the bounded-write floor", async () => {
    await expect(
      prepareControlledExhibitionOutput({
        privateOutputRoot: path.resolve("tmp/premiere-private-floor"),
        servedRoots: [path.resolve("static")],
        maxBundleBytes: 1024,
        minFreeBytes: 25 * GIB - 1,
      }),
    ).rejects.toThrow("invalid controlled source private-output ceilings");
  });

  it("requires 25 GiB unless the exact low-disk evaluation override is set", () => {
    expect(controlledExhibitionMinimumFreeBytes({})).toBe(25 * GIB);
    expect(
      controlledExhibitionMinimumFreeBytes({
        PROXYWAR_ALLOW_LOW_DISK_HEAVY_WRITE: "true",
      }),
    ).toBe(25 * GIB);
    expect(
      controlledExhibitionMinimumFreeBytes({
        PROXYWAR_ALLOW_LOW_DISK_HEAVY_WRITE: "1",
      }),
    ).toBe(15 * GIB);
  });

  it("fails preflight when pending bytes would cross the disk reserve", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-capacity-"));
    const servedRoot = path.join(root, "served");
    const privateRoot = path.join(root, "private");
    await fs.mkdir(servedRoot, { recursive: true });
    const statfs = (async () => ({
      type: 0n,
      bsize: 1n,
      blocks: 100n,
      bfree: 100n,
      bavail: 100n,
      files: 100n,
      ffree: 100n,
    })) as unknown as typeof fs.statfs;
    try {
      await expect(
        prepareControlledExhibitionOutput(
          {
            privateOutputRoot: privateRoot,
            servedRoots: [servedRoot],
            maxBundleBytes: 80,
            minFreeBytes: 25 * GIB,
          },
          { statfs },
        ),
      ).rejects.toThrow("free-space reserve");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("separates exact raw-manifest identity from reproducible policy content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-policy-"));
    try {
      const alphaPath = path.join(root, "alpha.json");
      const betaPath = path.join(root, "beta.json");
      const alpha = manifestFixture("Alpha", "alpha-policy");
      const beta = manifestFixture("Beta", "beta-policy");
      await fs.writeFile(alphaPath, `${JSON.stringify(alpha, null, 2)}\n`);
      await fs.writeFile(betaPath, `${JSON.stringify(beta, null, 2)}\n`);
      const formatted = await loadControlledPolicyProvenance(
        root,
        "rule",
        executionConfigFixture(),
      );

      await fs.writeFile(alphaPath, JSON.stringify(alpha));
      const compact = await loadControlledPolicyProvenance(
        root,
        "rule",
        executionConfigFixture(),
      );
      expect(compact[0].policyIdentity.manifestSha256).not.toBe(
        formatted[0].policyIdentity.manifestSha256,
      );
      expect(compact[0].policyIdentity.contentSha256).toBe(
        formatted[0].policyIdentity.contentSha256,
      );
      expect(compact[0].policyIdentity).toMatchObject({
        namespace: "local_manifest",
        manifestName: "alpha-policy",
        declaredVersion: "v1",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("executes the exact frozen manifest set even if source files mutate after preflight", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-toctou-"));
    const manifestRoot = path.join(root, "manifests");
    const servedRoot = path.join(root, "served");
    const privateRoot = path.join(root, "private");
    await fs.mkdir(manifestRoot, { recursive: true });
    await fs.mkdir(servedRoot, { recursive: true });
    const alphaPath = path.join(manifestRoot, "alpha.json");
    const betaPath = path.join(manifestRoot, "beta.json");
    const alphaBytes = Buffer.from(
      `${JSON.stringify(manifestFixture("Alpha", "alpha-policy"), null, 2)}\n`,
    );
    await fs.writeFile(alphaPath, alphaBytes);
    await fs.writeFile(
      betaPath,
      `${JSON.stringify(manifestFixture("Beta", "beta-policy"), null, 2)}\n`,
    );
    let executedAlphaHash: string | null = null;
    const fakeSmoke = async (options: AgentLeagueSmokeRunOptions) => {
      expect(options.args).not.toContain(
        expect.stringContaining("--agent-manifest-dir="),
      );
      expect(options.allowEnvironmentStrategySpec).toBe(false);
      expect(options.planEveryDecisionSteps).toBe(3);
      expect(options.injectedManifests).toHaveLength(2);
      const alpha = options.injectedManifests![0];
      executedAlphaHash = alpha.manifestSha256;
      expect(alpha.manifest.agentName).toBe("Alpha");
      expect(Object.isFrozen(alpha)).toBe(true);
      expect(Object.isFrozen(alpha.manifest)).toBe(true);

      await fs.writeFile(
        alphaPath,
        JSON.stringify(manifestFixture("Gamma", "gamma-policy")),
      );
      expect(alpha.manifest.agentName).toBe("Alpha");
      await options.artifactWriter!(artifactFixture());
    };

    try {
      const result = await runControlledExhibition(
        controlledCliArgs({
          manifestRoot,
          servedRoot,
          privateRoot,
          extra: ["--brain=rule"],
        }),
        {
          runAgentLeagueSmoke: fakeSmoke,
          resolveBuildProvenance: async () => buildFixture(),
          environment: {},
          statfs: statfsWithFreeBytes(30 * GIB),
        },
      );
      expect(executedAlphaHash).toBe(sha256Hex(alphaBytes));
      const bundle = JSON.parse(
        await fs.readFile(result.bundlePath, "utf8"),
      ) as Record<string, any>;
      expect(bundle.seats[0].displayName).toBe("Alpha");
      expect(bundle.seats[0].policyIdentity.manifestSha256).toBe(
        sha256Hex(alphaBytes),
      );
      expect(JSON.parse(await fs.readFile(alphaPath, "utf8")).agentName).toBe(
        "Gamma",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects build drift immediately before commit without writing a bundle", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "premiere-build-toctou-"),
    );
    const manifestRoot = path.join(root, "manifests");
    const servedRoot = path.join(root, "served");
    const privateRoot = path.join(root, "private");
    await fs.mkdir(manifestRoot, { recursive: true });
    await fs.mkdir(servedRoot, { recursive: true });
    await Promise.all([
      fs.writeFile(
        path.join(manifestRoot, "alpha.json"),
        JSON.stringify(manifestFixture("Alpha", "alpha-policy")),
      ),
      fs.writeFile(
        path.join(manifestRoot, "beta.json"),
        JSON.stringify(manifestFixture("Beta", "beta-policy")),
      ),
    ]);
    let provenanceReads = 0;
    const resolveBuildProvenance = async () => {
      provenanceReads += 1;
      return provenanceReads === 1
        ? buildFixture()
        : {
            ...buildFixture(),
            smokeRunnerSha256: "9".repeat(64),
          };
    };
    const fakeSmoke = async (options: AgentLeagueSmokeRunOptions) => {
      await options.artifactWriter!(artifactFixture());
    };

    try {
      await expect(
        runControlledExhibition(
          controlledCliArgs({
            manifestRoot,
            servedRoot,
            privateRoot,
            extra: ["--brain=rule"],
          }),
          {
            runAgentLeagueSmoke: fakeSmoke,
            resolveBuildProvenance,
            environment: {},
            statfs: statfsWithFreeBytes(30 * GIB),
          },
        ),
      ).rejects.toThrow(
        "controlled exhibition build provenance changed before bundle commit",
      );
      expect(provenanceReads).toBe(2);
      expect(await fs.readdir(privateRoot)).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("binds planner cadence and disabled actions into reproducible content identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-config-"));
    try {
      await fs.writeFile(
        path.join(root, "alpha.json"),
        JSON.stringify(manifestFixture("Alpha", "alpha-policy")),
      );
      await fs.writeFile(
        path.join(root, "beta.json"),
        JSON.stringify(manifestFixture("Beta", "beta-policy")),
      );
      const baselineConfig = executionConfigFixture();
      const baseline = await loadControlledPolicySet(
        root,
        "rule",
        baselineConfig,
      );
      const repeat = await loadControlledPolicySet(
        root,
        "rule",
        executionConfigFixture(),
      );
      const cadence = await loadControlledPolicySet(
        root,
        "rule",
        executionConfigFixture({ planEveryDecisionSteps: 4 }),
      );
      const disabled = await loadControlledPolicySet(
        root,
        "rule",
        executionConfigFixture({ disabledActionKinds: ["quick_chat"] }),
      );

      expect(repeat.executionConfigSha256).toBe(baseline.executionConfigSha256);
      expect(repeat.policies[0].policyIdentity.contentSha256).toBe(
        baseline.policies[0].policyIdentity.contentSha256,
      );
      expect(cadence.executionConfigSha256).not.toBe(
        baseline.executionConfigSha256,
      );
      expect(cadence.policies[0].policyIdentity.contentSha256).not.toBe(
        baseline.policies[0].policyIdentity.contentSha256,
      );
      expect(disabled.policies[0].policyIdentity.contentSha256).not.toBe(
        baseline.policies[0].policyIdentity.contentSha256,
      );
      expect(cadence.policies[0].policyIdentity.manifestSha256).toBe(
        baseline.policies[0].policyIdentity.manifestSha256,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unrecorded behavior environment and non-allowlisted CLI overrides", async () => {
    expect(() =>
      assertControlledBehaviorEnvironment({
        PROXYWAR_PLAN_EVERY_DECISION_STEPS: "4",
      }),
    ).toThrow("PROXYWAR_PLAN_EVERY_DECISION_STEPS");
    expect(() =>
      assertControlledBehaviorEnvironment({
        AI_LEAGUE_PLAYER_STRATEGY_SPEC: '{"posture":"aggressive"}',
      }),
    ).toThrow("AI_LEAGUE_PLAYER_STRATEGY_SPEC");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-cli-"));
    try {
      await expect(
        runControlledExhibition(
          controlledCliArgs({
            manifestRoot: path.join(root, "manifests"),
            servedRoot: path.join(root, "served"),
            privateRoot: path.join(root, "private"),
            extra: ["--brain=rule", "--infinite-gold"],
          }),
          { environment: {} },
        ),
      ).rejects.toThrow("not allowlisted");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects uncommitted source when capturing exact build provenance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-build-"));
    const scripts = path.join(root, "src/scripts");
    try {
      await fs.mkdir(scripts, { recursive: true });
      await Promise.all([
        fs.writeFile(
          path.join(root, "package.json"),
          '{"name":"premiere-build-fixture","version":"1.0.0"}\n',
        ),
        fs.writeFile(
          path.join(scripts, "ai-agent-league-smoke.ts"),
          "export {};\n",
        ),
        fs.writeFile(
          path.join(scripts, "replay-premiere-controlled-exhibition.ts"),
          "export {};\n",
        ),
      ]);
      await execFileAsync("git", ["init"], { cwd: root });
      await execFileAsync("git", ["add", "."], { cwd: root });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=ProxyWar Test",
          "-c",
          "user.email=proxywar-test@example.invalid",
          "commit",
          "-m",
          "fixture",
        ],
        { cwd: root },
      );

      await expect(
        resolveControlledExhibitionBuildProvenance(root),
      ).resolves.toMatchObject({ trackedWorktreeClean: true });

      await fs.writeFile(
        path.join(root, "untracked-source.ts"),
        "export {};\n",
      );
      await expect(
        resolveControlledExhibitionBuildProvenance(root),
      ).rejects.toThrow("clean committed source checkout");
      await fs.rm(path.join(root, "untracked-source.ts"));

      await fs.appendFile(
        path.join(scripts, "ai-agent-league-smoke.ts"),
        "// drift\n",
      );
      await expect(
        resolveControlledExhibitionBuildProvenance(root),
      ).rejects.toThrow("clean committed source checkout");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the ordinary smoke writer as the no-options default", async () => {
    const moduleUrl = pathToFileURL(
      path.resolve("src/scripts/ai-agent-league-smoke.ts"),
    ).href;
    const script = [
      `const smoke = await import(${JSON.stringify(moduleUrl)});`,
      `console.log("OUTPUT_MODES=" + smoke.agentLeagueSmokeOutputMode() + "," + smoke.agentLeagueSmokeOutputMode({artifactWriter: async () => null}));`,
      `let fallbackLoads = 0;`,
      `const strategy = smoke.resolveAgentLeagueSmokePlayerStrategySpec(undefined, false, () => { fallbackLoads += 1; throw new Error("must not load env"); });`,
      `console.log("STRATEGY_FALLBACK=" + String(strategy) + "," + fallbackLoads);`,
    ].join("\n");
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "--eval", script],
      {
        cwd: path.resolve("."),
        env: { ...process.env, GAME_ENV: "dev" },
        encoding: "utf8",
      },
    );
    expect(stdout).toContain("OUTPUT_MODES=standard,private-writer");
    expect(stdout).toContain("STRATEGY_FALLBACK=null,0");
  });
});

function artifactFixture() {
  const gameRecord = gameRecordFixture();
  const executionConfig = executionConfigFixture();
  return {
    artifactInput: {
      runID: "controlled-run-001",
      matchID: "PREM0001",
      scenario: "league",
      brainMode: "rule" as const,
      runnerMode: "step-locked" as const,
      runnerConfig: {
        turnsPerDecisionStep: executionConfig.runner.turnsPerDecisionStep,
        turnsPerDecisionSchedule:
          executionConfig.runner.turnsPerDecisionSchedule,
        maxDecisionMs: executionConfig.runner.maxDecisionMs,
        maxSteps: executionConfig.runner.maxSteps,
        stepsCompleted: 1,
        mirrorCatchupSucceeded: true,
        onlyHoldReason: null,
        autopilotEndgameSteps: executionConfig.runner.autopilotEndgameSteps,
        autopilotEngagedAtStep: null,
        replayTailTurns: executionConfig.runner.replayTailTurns,
        agents: 2,
        bots: executionConfig.game.bots,
        nations: executionConfig.game.nations,
        map: executionConfig.game.map,
        mapSize: executionConfig.game.mapSize,
        difficulty: executionConfig.game.difficulty,
        variedSpawns: executionConfig.game.varySpawns,
      },
      startedAt: gameRecord.info.start,
      completedAt: gameRecord.info.end,
      records: [],
      roster: [
        {
          agentID: "alpha-agent",
          username: "Alpha",
          profile: "aggressive" as const,
          clientID: "SEAT0001",
          brainType: "rule" as const,
        },
        {
          agentID: "beta-agent",
          username: "Beta",
          profile: "defensive" as const,
          clientID: "SEAT0002",
          brainType: "rule" as const,
        },
      ],
      gameRecord,
    },
    winner: ["player", "SEAT0001"] as ["player", string],
    turnCount: 4,
    playbackTurnIntervalMs: 100,
    executionConfig,
  };
}

function executionConfigFixture(
  overrides: {
    planEveryDecisionSteps?: number;
    disabledActionKinds?: AgentLeagueSmokeExecutionConfig["disabledActionKinds"];
  } = {},
): AgentLeagueSmokeExecutionConfig {
  return {
    schemaVersion: 1,
    scenario: "league",
    brainMode: "rule",
    runnerMode: "step-locked",
    planEveryDecisionSteps: overrides.planEveryDecisionSteps ?? 3,
    runner: {
      turnsPerDecisionStep: 300,
      turnsPerDecisionSchedule: null,
      maxDecisionMs: 120_000,
      maxSteps: 120,
      maxSpawnAdvanceTurns: 2_000,
      requireWinner: true,
      waitForMirrorCatchup: true,
      autopilotEndgameSteps: 0,
      replayTailTurns: 0,
    },
    game: {
      bots: 0,
      nations: "disabled",
      map: GameMapType.Asia,
      mapSize: GameMapSize.Compact,
      difficulty: Difficulty.Medium,
      varySpawns: false,
    },
    disabledActionKinds: overrides.disabledActionKinds ?? [],
  };
}

function gameRecordFixture(): GameRecord {
  const start = Date.UTC(2026, 6, 20, 18, 0, 0);
  return {
    version: "v0.0.2",
    gitCommit: "a".repeat(40),
    subdomain: "local",
    domain: "controlled",
    info: {
      gameID: "PREM0001",
      lobbyCreatedAt: start,
      config: {
        gameMap: GameMapType.Asia,
        gameMapSize: GameMapSize.Compact,
        gameMode: GameMode.FFA,
        gameType: GameType.Private,
        difficulty: Difficulty.Medium,
        nations: "disabled",
        donateGold: false,
        donateTroops: false,
        bots: 0,
        infiniteGold: false,
        infiniteTroops: false,
        instantBuild: false,
        randomSpawn: false,
        disabledUnits: [],
        maxPlayers: 2,
      },
      players: [
        {
          clientID: "SEAT0001",
          username: "Alpha",
          clanTag: null,
          persistentID: null,
          stats: undefined,
        },
        {
          clientID: "SEAT0002",
          username: "Beta",
          clanTag: null,
          persistentID: null,
          stats: undefined,
        },
      ],
      start,
      end: start + 400,
      duration: 0,
      num_turns: 4,
      winner: undefined,
      lobbyFillTime: 0,
    },
    turns: [],
  };
}

function policyFixtures(): ControlledPolicyProvenance[] {
  return [
    {
      displayName: "Alpha",
      policyIdentity: {
        namespace: "local_manifest",
        manifestName: "alpha-policy",
        declaredVersion: "v1",
        manifestSha256: "b".repeat(64),
        contentSha256: "c".repeat(64),
      },
    },
    {
      displayName: "Beta",
      policyIdentity: {
        namespace: "local_manifest",
        manifestName: "beta-policy",
        declaredVersion: "v1",
        manifestSha256: "d".repeat(64),
        contentSha256: "e".repeat(64),
      },
    },
  ];
}

function buildFixture(): ControlledExhibitionBuildProvenance {
  return {
    repositoryHead: "f".repeat(40),
    repositoryTree: "1".repeat(40),
    trackedWorktreeClean: true,
    trackedWorktreeStateSha256: "2".repeat(64),
    packageName: "proxywar",
    packageVersion: null,
    packageJsonSha256: "3".repeat(64),
    smokeRunnerSha256: "4".repeat(64),
    generatorSha256: "5".repeat(64),
    nodeVersion: "v24.0.0",
    platform: "darwin",
    architecture: "arm64",
  };
}

function manifestFixture(agentName: string, manifestName: string) {
  return {
    schemaVersion: 1,
    agentName,
    profile: agentName === "Alpha" ? "aggressive" : "defensive",
    brainType: "rule",
    provider: { provider: "rule" },
    policyIdentity: {
      namespace: "local_manifest",
      manifestName,
      declaredVersion: "v1",
    },
  };
}

function controlledCliArgs(input: {
  manifestRoot: string;
  servedRoot: string;
  privateRoot: string;
  extra?: string[];
}): string[] {
  return [
    "--run-id=controlled-run-001",
    `--private-output-root=${input.privateRoot}`,
    `--agent-manifest-dir=${input.manifestRoot}`,
    `--served-root=${input.servedRoot}`,
    "--max-bundle-bytes=2097152",
    "--min-free-bytes=0",
    ...(input.extra ?? []),
  ];
}

function statfsWithFreeBytes(freeBytes: number): typeof fs.statfs {
  return (async () => ({
    type: 0n,
    bsize: 1n,
    blocks: BigInt(freeBytes),
    bfree: BigInt(freeBytes),
    bavail: BigInt(freeBytes),
    files: 100n,
    ffree: 100n,
  })) as unknown as typeof fs.statfs;
}

async function directorySnapshot(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const bytes = entry.isFile()
          ? await fs.readFile(path.join(directory, entry.name))
          : Buffer.alloc(0);
        return `${entry.name}:${entry.isFile() ? "file" : "other"}:${sha256Hex(bytes)}`;
      }),
  );
}
