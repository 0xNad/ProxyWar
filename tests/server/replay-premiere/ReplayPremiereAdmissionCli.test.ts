import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  executeReplayPremiereAdmissionCli,
  runReplayPremiereAdmission,
} from "../../../src/scripts/replay-premiere-admit";
import { ReplayPremiereAnonymousWriteLimiter } from "../../../src/server/replay-premiere/ReplayPremiereAnonymousWriteLimiter";
import { ReplayPremiereAdmissionCatalog } from "../../../src/server/replay-premiere/ReplayPremiereCatalog";
import { ReplayPremiereError } from "../../../src/server/replay-premiere/ReplayPremiereErrors";
import { ReplayPremiereGuestSecurity } from "../../../src/server/replay-premiere/ReplayPremiereGuestSecurity";
import { ReplayPremiereHttpRegistry } from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import {
  canonicalReplayPremiereJson,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { ReplayPremiereRuntimeRegistry } from "../../../src/server/replay-premiere/ReplayPremiereRuntimeCoordinator";
import { startReplayPremiereProduction } from "../../../src/server/replay-premiere/ReplayPremiereStartup";
import {
  controlledSourceBytes,
  eligibilityFixture,
  NOW,
  PREMIERE_ID,
  publicDefinitionFixture,
} from "./ReplayPremiereFixtures";

const EXPECTED_ORIGIN = "https://beta.proxywar.xyz";

describe("Replay Premiere operator admission command", () => {
  let root: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(
      path.join(realTemporaryRoot, "premiere-admit-cli-"),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("rejects an unknown argument before output, filesystem writes, or probes", async () => {
    const harness = await createHarness(root);
    const capture = cliCapture();
    const exitCode = await executeReplayPremiereAdmissionCli(
      [...harness.args, "--passed=true"],
      harness.dependencies,
      capture.io,
    );

    expect(exitCode).toBe(1);
    expect(capture.stdout()).toBe("");
    expect(capture.stderr()).toBe(
      "REPLAY_PREMIERE_ADMISSION_FAILED admission_unknown_or_missing_argument\n",
    );
    expect(harness.fetchCalls()).toBe(0);
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([]);
  });

  test("admits a legitimate non-varied source with sanitized hash-and-id output", async () => {
    const source = JSON.parse(controlledSourceBytes().toString("utf8")) as {
      gameRecord: { info: { config: { randomSpawn: boolean } } };
      provenance: {
        executionConfig: { game: { varySpawns: boolean } };
      };
    };
    expect(source.provenance.executionConfig.game.varySpawns).toBe(false);
    expect(source.gameRecord.info.config.randomSpawn).toBe(false);
    const harness = await createHarness(root);
    const capture = cliCapture();
    const exitCode = await executeReplayPremiereAdmissionCli(
      harness.args,
      harness.dependencies,
      capture.io,
    );

    expect(exitCode).toBe(0);
    expect(capture.stderr()).toBe("");
    const output = JSON.parse(capture.stdout()) as Record<string, unknown>;
    expect(Object.keys(output).sort()).toEqual(
      [
        "admissionRecordHash",
        "deploymentOriginSha256",
        "eligibilityRecordHash",
        "orderedDraftManifestRoot",
        "premiereId",
        "publicationCommitmentHash",
        "sourceReplaySha256",
        "sourceRunId",
      ].sort(),
    );
    expect(output).toMatchObject({
      premiereId: PREMIERE_ID,
      sourceRunId: "controlled-run-001",
      sourceReplaySha256: harness.sourceSha256,
      deploymentOriginSha256: sha256Hex(EXPECTED_ORIGIN),
    });
    expect(capture.stdout()).not.toMatch(
      /winner|authoritativeResult|resultHash|bytes|SEAT000/i,
    );
    expect(harness.fetchCalls()).toBeGreaterThan(70);
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([
      `${PREMIERE_ID}.admission.json`,
    ]);
    const stored = JSON.parse(
      await fs.readFile(
        path.join(
          harness.privateStateRoot,
          "catalog-v1",
          "entries",
          `${PREMIERE_ID}.admission.json`,
        ),
        "utf8",
      ),
    ) as {
      eligibilityRecord: {
        proxyWarLeakAuditManifest: { targets: Array<{ target: string }> };
      };
    };
    expect(
      new Set(
        stored.eligibilityRecord.proxyWarLeakAuditManifest.targets.map(
          (target) => new URL(target.target).origin,
        ),
      ),
    ).toEqual(new Set([EXPECTED_ORIGIN]));
  });

  test("rejects a decoy deployment origin that differs from production config", async () => {
    const harness = await createHarness(root);
    await expectOperatorCode(
      runReplayPremiereAdmission(
        replaceArgument(
          harness.args,
          "--deployment-origin=",
          "https://clean-decoy.invalid",
        ),
        harness.dependencies,
      ),
      "admission_deployment_origin_mismatch",
    );
    expect(harness.fetchCalls()).toBe(0);
    expect(await privateFileSnapshot(harness.privateStateRoot)).toEqual({});
  });

  test("admits beside a running production service without hot activation", async () => {
    const harness = await createHarness(root);
    const limiter = new ReplayPremiereAnonymousWriteLimiter({
      now: () => NOW,
    });
    const httpRegistry = new ReplayPremiereHttpRegistry(limiter.admit);
    const runtimeRegistry = new ReplayPremiereRuntimeRegistry();
    const started = await startReplayPremiereProduction({
      privateStateRoot: harness.privateStateRoot,
      servedRoots: [harness.servedRoot],
      publicOrigin: EXPECTED_ORIGIN,
      security: new ReplayPremiereGuestSecurity({
        hmacKey: Buffer.alloc(32, 7),
        expectedOrigin: EXPECTED_ORIGIN,
        production: true,
        now: () => NOW,
      }),
      httpRegistry,
      runtimeRegistry,
      checkpointProjector: {
        async project() {
          throw new Error("unexpected projection without an admission");
        },
      },
      clock: { now: () => NOW },
    });
    try {
      expect(started.registeredPremiereIds).toEqual([]);
      const admitted = await runReplayPremiereAdmission(
        harness.args,
        harness.dependencies,
      );
      expect(admitted.premiereId).toBe(PREMIERE_ID);
      expect(httpRegistry.get(PREMIERE_ID)).toBeNull();
      expect(runtimeRegistry.get(PREMIERE_ID)).toBeNull();
      expect(await admissionEntries(harness.privateStateRoot)).toEqual([
        `${PREMIERE_ID}.admission.json`,
      ]);
    } finally {
      await started.service.close();
    }
  });

  test("rejects overlapping private/served roots before probes and catalog entry", async () => {
    const harness = await createHarness(root);
    const overlappingPrivateRoot = path.join(harness.servedRoot, "private");
    await expectOperatorCode(
      runReplayPremiereAdmission(
        replaceArgument(
          harness.args,
          "--private-state-root=",
          overlappingPrivateRoot,
        ),
        harness.dependencies,
      ),
      "private_and_served_roots_overlap",
    );
    expect(harness.fetchCalls()).toBe(0);
    expect(await admissionEntries(overlappingPrivateRoot)).toEqual([]);
  });

  test("rejects a failed authentic probe without a catalog entry", async () => {
    const harness = await createHarness(root, {
      fetch: async () =>
        new Response("controlled-run-001", {
          status: 200,
          headers: { "cache-control": "no-store" },
        }),
    });
    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, harness.dependencies),
      "premiere_leak_collected_leak_audit_failed",
    );
    expect(harness.fetchCalls()).toBeGreaterThan(0);
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([]);
    const residue = await privateFileSnapshot(harness.privateStateRoot);
    expect(residue).toEqual({
      [`sources/sha256/${harness.sourceSha256.slice(0, 2)}/${harness.sourceSha256}.replay`]:
        {
          mode: 0o400,
          sha256: harness.sourceSha256,
        },
    });
  });

  test("rejects source drift against the explicit hash before probes", async () => {
    const harness = await createHarness(root);
    await expectOperatorCode(
      runReplayPremiereAdmission(
        replaceArgument(
          harness.args,
          "--expected-source-sha256=",
          "f".repeat(64),
        ),
        harness.dependencies,
      ),
      "source_bundle_hash_mismatch",
    );
    expect(harness.fetchCalls()).toBe(0);
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([]);
  });

  test("rejects an opposite authoritative winner after authentic probes and rebuilt hashes", async () => {
    const sourceBytes = controlledSourceWithResultMutation((result) => {
      result.winner = ["player", "SEAT0002"];
      result.seats = [
        { seatId: "SEAT0001", displayName: "Alpha", won: false },
        { seatId: "SEAT0002", displayName: "Beta", won: true },
      ];
    });
    const harness = await createHarness(root, { sourceBytes });
    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, harness.dependencies),
      "result_game_record_winner_mismatch",
    );
    expect(harness.fetchCalls()).toBeGreaterThan(70);
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([]);
  });

  test("rejects authoritative completion-time drift after authentic probes and rebuilt hashes", async () => {
    const sourceBytes = controlledSourceWithResultMutation((result) => {
      result.completedAt = "2026-07-20T18:00:00.601Z";
    });
    const harness = await createHarness(root, { sourceBytes });
    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, harness.dependencies),
      "result_game_record_completed_at_mismatch",
    );
    expect(harness.fetchCalls()).toBeGreaterThan(70);
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([]);
  });

  test("does not let operator input claim a passed leak audit", async () => {
    const harness = await createHarness(root);
    const eligibility = {
      ...harness.operatorEligibility,
      proxyWarLeakChecks: [],
      status: "passed",
    };
    await fs.writeFile(
      harness.eligibilityFile,
      `${JSON.stringify(eligibility)}\n`,
      { mode: 0o600 },
    );
    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, harness.dependencies),
      "admission_eligibility_input_invalid",
    );
    expect(harness.fetchCalls()).toBe(0);
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([]);
  });

  test("requires at least a private 128-bit nonce before staging or probes", async () => {
    const harness = await createHarness(root);
    const nonceArgument = harness.args.find((argument) =>
      argument.startsWith("--nonce-file="),
    );
    if (nonceArgument === undefined) throw new Error("missing test nonce arg");
    const nonceFile = nonceArgument.slice("--nonce-file=".length);
    await fs.writeFile(nonceFile, Buffer.alloc(15, 9), { mode: 0o600 });
    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, harness.dependencies),
      "admission_nonce_file_invalid",
    );
    expect(harness.fetchCalls()).toBe(0);
    expect(await privateFileSnapshot(harness.privateStateRoot)).toEqual({});
  });

  test("fails closed before probes when the premiere id already exists", async () => {
    const harness = await createHarness(root);
    const first = await runReplayPremiereAdmission(
      harness.args,
      harness.dependencies,
    );
    const entryPath = path.join(
      harness.privateStateRoot,
      "catalog-v1",
      "entries",
      `${PREMIERE_ID}.admission.json`,
    );
    const before = await fs.readFile(entryPath);
    const privateBefore = await privateFileSnapshot(harness.privateStateRoot);
    const callsAfterFirst = harness.fetchCalls();

    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, {
        now: () => NOW,
        environment: { PROXYWAR_PUBLIC_URL: EXPECTED_ORIGIN },
        fetch: async () => {
          throw new Error("existing admission must not probe");
        },
      }),
      "admission_premiere_already_exists",
    );

    expect(first.premiereId).toBe(PREMIERE_ID);
    expect(harness.fetchCalls()).toBe(callsAfterFirst);
    expect(await fs.readFile(entryPath)).toEqual(before);
    expect(await privateFileSnapshot(harness.privateStateRoot)).toEqual(
      privateBefore,
    );
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([
      `${PREMIERE_ID}.admission.json`,
    ]);
  });

  test("reports catalog lock contention with a fixed operator code and no entry", async () => {
    const harness = await createHarness(root);
    const catalog = await ReplayPremiereAdmissionCatalog.open({
      privateStateRoot: harness.privateStateRoot,
      servedRoots: [harness.servedRoot],
    });
    try {
      await expectOperatorCode(
        runReplayPremiereAdmission(harness.args, harness.dependencies),
        "catalog_writer_already_active_in_process",
      );
      expect(harness.fetchCalls()).toBe(0);
      expect(await admissionEntries(harness.privateStateRoot)).toEqual([]);
      expect(
        Object.keys(await privateFileSnapshot(harness.privateStateRoot)).some(
          (entry) => entry.startsWith("sources/"),
        ),
      ).toBe(false);
    } finally {
      await catalog.close();
    }
  });
});

async function createHarness(
  testRoot: string,
  options: {
    fetch?: typeof globalThis.fetch;
    sourceBytes?: Buffer;
  } = {},
) {
  const sourceFile = path.join(testRoot, "controlled-run-001.source.json");
  const privateStateRoot = path.join(testRoot, "private");
  const servedRoot = path.join(testRoot, "served");
  const eligibilityFile = path.join(testRoot, "eligibility-input.json");
  const definitionFile = path.join(testRoot, "definition-input.json");
  const nonceFile = path.join(testRoot, "commitment-nonce.bin");
  const sourceBytes = options.sourceBytes ?? controlledSourceBytes();
  const completeEligibility = eligibilityFixture({ sourceBytes });
  const operatorEligibility = {
    schemaVersion: 1,
    eligibilityCheckVersion: completeEligibility.eligibilityCheckVersion,
    externalEmbargoEvidence: completeEligibility.externalEmbargoEvidence,
    externalOutcomeMayBePublic: completeEligibility.externalOutcomeMayBePublic,
    publicLabel: completeEligibility.publicLabel,
  };
  const { provenance: _provenance, ...definition } = publicDefinitionFixture(
    "0".repeat(64),
    completeEligibility,
  );
  await fs.mkdir(servedRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(sourceFile, sourceBytes, { mode: 0o600 }),
    fs.writeFile(eligibilityFile, `${JSON.stringify(operatorEligibility)}\n`, {
      mode: 0o600,
    }),
    fs.writeFile(
      definitionFile,
      `${JSON.stringify({ schemaVersion: 1, ...definition })}\n`,
      { mode: 0o600 },
    ),
    fs.writeFile(nonceFile, Buffer.alloc(32, 9), { mode: 0o600 }),
  ]);

  const expectedEvidence = new Map(
    completeEligibility.proxyWarLeakChecks.map((evidence) => [
      `${evidence.method} ${evidence.target}`,
      evidence,
    ]),
  );
  let fetchCalls = 0;
  const fixtureFetch = (async (input, init) => {
    fetchCalls += 1;
    if (options.fetch !== undefined) return options.fetch(input, init);
    const target = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const evidence = expectedEvidence.get(`${method} ${target}`);
    if (evidence === undefined || evidence.observedHttpStatus === null) {
      throw new Error("unexpected admission leak probe");
    }
    return new Response(evidence.observedBodyText ?? "", {
      status: evidence.observedHttpStatus,
      headers: {
        ...(evidence.observedHeaders.age === null
          ? {}
          : { age: evidence.observedHeaders.age }),
        ...(evidence.observedHeaders.cacheControl === null
          ? {}
          : { "cache-control": evidence.observedHeaders.cacheControl }),
        ...(evidence.observedHeaders.cdnCacheStatus === null
          ? {}
          : {
              "cf-cache-status": evidence.observedHeaders.cdnCacheStatus,
            }),
      },
    });
  }) as typeof globalThis.fetch;
  const sourceSha256 = sha256Hex(sourceBytes);
  return {
    args: [
      `--premiere-id=${PREMIERE_ID}`,
      `--source-file=${sourceFile}`,
      `--expected-source-sha256=${sourceSha256}`,
      `--private-state-root=${privateStateRoot}`,
      `--served-root=${servedRoot}`,
      `--eligibility-file=${eligibilityFile}`,
      `--definition-file=${definitionFile}`,
      `--deployment-origin=${EXPECTED_ORIGIN}`,
      `--nonce-file=${nonceFile}`,
    ],
    dependencies: {
      fetch: fixtureFetch,
      now: () => NOW,
      environment: { PROXYWAR_PUBLIC_URL: EXPECTED_ORIGIN },
    },
    fetchCalls: () => fetchCalls,
    sourceSha256,
    privateStateRoot,
    servedRoot,
    eligibilityFile,
    operatorEligibility,
  };
}

function cliCapture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout(line: string) {
        stdout += line;
      },
      stderr(line: string) {
        stderr += line;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

async function admissionEntries(privateStateRoot: string): Promise<string[]> {
  try {
    return (
      await fs.readdir(path.join(privateStateRoot, "catalog-v1", "entries"))
    )
      .filter((entry) => entry.endsWith(".admission.json"))
      .sort();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

async function privateFileSnapshot(
  privateStateRoot: string,
): Promise<Record<string, { mode: number; sha256: string }>> {
  const entries: Array<[string, { mode: number; sha256: string }]> = [];
  async function visit(directory: string, relativeDirectory: string) {
    let directoryEntries;
    try {
      directoryEntries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
    for (const entry of directoryEntries) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const [bytes, stat] = await Promise.all([
          fs.readFile(absolutePath),
          fs.lstat(absolutePath),
        ]);
        entries.push([
          relativePath,
          { mode: stat.mode & 0o777, sha256: sha256Hex(bytes) },
        ]);
      }
    }
  }
  await visit(privateStateRoot, "");
  return Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function expectOperatorCode(
  operation: Promise<unknown>,
  expected: string,
): Promise<void> {
  try {
    await operation;
    throw new Error("expected Replay Premiere admission failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayPremiereError);
    expect((error as ReplayPremiereError).operatorCode).toBe(expected);
  }
}

function replaceArgument(
  args: string[],
  prefix: string,
  value: string,
): string[] {
  return args.map((argument) =>
    argument.startsWith(prefix) ? `${prefix}${value}` : argument,
  );
}

function controlledSourceWithResultMutation(
  mutate: (result: Record<string, unknown>) => void,
): Buffer {
  const source = JSON.parse(controlledSourceBytes().toString("utf8")) as Record<
    string,
    unknown
  >;
  const authoritativeResult = source.authoritativeResult as Record<
    string,
    unknown
  >;
  const result = JSON.parse(
    Buffer.from(String(authoritativeResult.bytes), "base64").toString("utf8"),
  ) as Record<string, unknown>;
  mutate(result);
  const resultBytes = Buffer.from(
    canonicalReplayPremiereJson(result as unknown as ReplayPremiereJsonValue),
    "utf8",
  );
  authoritativeResult.bytes = resultBytes.toString("base64");
  authoritativeResult.sha256 = sha256Hex(resultBytes);
  return Buffer.from(
    canonicalReplayPremiereJson(source as unknown as ReplayPremiereJsonValue),
    "utf8",
  );
}
