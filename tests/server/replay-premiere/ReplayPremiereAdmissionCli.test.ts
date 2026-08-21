import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  executeReplayPremiereAdmissionCli,
  runReplayPremiereAdmission,
} from "../../../src/scripts/replay-premiere-admit";
import { runLoopReplayPremiereAdmission } from "../../../src/scripts/replay-premiere-loop";
import { ReplayPremiereAnonymousWriteLimiter } from "../../../src/server/replay-premiere/ReplayPremiereAnonymousWriteLimiter";
import { ReplayPremiereAdmissionCatalog } from "../../../src/server/replay-premiere/ReplayPremiereCatalog";
import {
  freezeReplayPremiereCheckpointProjection,
  type ReplayPremiereCheckpointProjector,
} from "../../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
import { ReplayPremiereError } from "../../../src/server/replay-premiere/ReplayPremiereErrors";
import { ReplayPremiereGuestSecurity } from "../../../src/server/replay-premiere/ReplayPremiereGuestSecurity";
import { ReplayPremiereHttpRegistry } from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import {
  canonicalReplayPremiereJson,
  hashReplayPremiereJson,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { ReplayPremiereRuntimeRegistry } from "../../../src/server/replay-premiere/ReplayPremiereRuntimeCoordinator";
import { startReplayPremiereProduction } from "../../../src/server/replay-premiere/ReplayPremiereStartup";
import {
  AMPLE_DISK,
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
    const projectionArtifactName =
      `${PREMIERE_ID}.${String(output.admissionRecordHash)}` +
      ".checkpoint-projection.json";
    expect(await projectionEntries(harness.privateStateRoot)).toEqual([
      projectionArtifactName,
    ]);
    const projectionArtifact = JSON.parse(
      await fs.readFile(
        path.join(
          harness.privateStateRoot,
          "catalog-v1",
          "checkpoint-projections",
          projectionArtifactName,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(projectionArtifact).toMatchObject({
      premiereId: PREMIERE_ID,
      admissionRecordHash: output.admissionRecordHash,
      sourceReplaySha256: output.sourceReplaySha256,
      eligibilityRecordHash: output.eligibilityRecordHash,
      publicationCommitmentHash: output.publicationCommitmentHash,
      orderedDraftManifestRoot: output.orderedDraftManifestRoot,
    });
    expect(projectionArtifact.artifactHash).toMatch(/^[a-f0-9]{64}$/);
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

  test("releases the catalog lock while the direct projector does expensive work", async () => {
    const harness = await createHarness(root);
    const projector = harness.dependencies.checkpointProjector;
    let concurrentRead = false;

    const admitted = await runReplayPremiereAdmission(harness.args, {
      ...harness.dependencies,
      checkpointProjector: {
        async project(options) {
          const concurrent = await ReplayPremiereAdmissionCatalog.open({
            statfs: AMPLE_DISK,
            privateStateRoot: harness.privateStateRoot,
            servedRoots: [harness.servedRoot],
          });
          try {
            expect(await concurrent.readAll()).toEqual({
              entries: [],
              failures: [],
            });
            concurrentRead = true;
          } finally {
            await concurrent.close();
          }
          return projector.project(options);
        },
      },
    });

    expect(concurrentRead).toBe(true);
    expect(admitted.premiereId).toBe(PREMIERE_ID);
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([
      `${PREMIERE_ID}.admission.json`,
    ]);
    expect(await projectionEntries(harness.privateStateRoot)).toHaveLength(1);
  });

  test("rolls back a projected artifact when admission visibility fails", async () => {
    const harness = await createHarness(root);
    let artifactObserved = false;
    let projectionArtifactName = "";
    await expect(
      runReplayPremiereAdmission(harness.args, {
        ...harness.dependencies,
        afterCheckpointProjectionPublished: async (artifact) => {
          artifactObserved = true;
          projectionArtifactName =
            `${PREMIERE_ID}.${artifact.admissionRecordHash}` +
            ".checkpoint-projection.json";
          expect(artifact.premiereId).toBe(PREMIERE_ID);
          expect(await projectionEntries(harness.privateStateRoot)).toEqual([
            projectionArtifactName,
          ]);
          expect(await admissionEntries(harness.privateStateRoot)).toEqual([]);
          throw new Error("injected before catalog visibility");
        },
      }),
    ).rejects.toThrow("injected before catalog visibility");

    expect(artifactObserved).toBe(true);
    expect(await projectionEntries(harness.privateStateRoot)).toEqual([]);
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([]);

    const retried = await runReplayPremiereAdmission(harness.args, {
      ...harness.dependencies,
      now: () => new Date(NOW.getTime() + 1),
    });
    expect(retried.admissionRecordHash).not.toBe(
      projectionArtifactName.split(".")[1],
    );
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([
      `${PREMIERE_ID}.admission.json`,
    ]);
    expect(await projectionEntries(harness.privateStateRoot)).toHaveLength(1);
  });

  test("keeps the loop hold when Catalog cannot resolve a linked admission", async () => {
    const harness = await createHarness(root);
    let publicationFailed = false;
    let cleanupFailed = false;

    const result = await runLoopReplayPremiereAdmission({
      args: harness.args,
      premiereId: PREMIERE_ID,
      bundleSha256: harness.sourceSha256,
      environment: { PROXYWAR_PUBLIC_URL: EXPECTED_ORIGIN },
      runAdmission: (args, loopDependencies) =>
        runReplayPremiereAdmission(args, {
          ...harness.dependencies,
          ...loopDependencies,
          admissionPublicationFaultInjector: (phase) => {
            if (!publicationFailed && phase === "after_admission_link") {
              publicationFailed = true;
              throw new Error("injected linked admission failure");
            }
            if (!cleanupFailed && phase === "before_cleanup_admission_unlink") {
              cleanupFailed = true;
              throw Object.assign(new Error("injected admission unlink EIO"), {
                code: "EIO",
              });
            }
          },
        }),
    });

    expect(publicationFailed).toBe(true);
    expect(cleanupFailed).toBe(true);
    expect(result).toEqual({
      kind: "hold",
      reason: "admission_state_uncertain",
    });
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([
      `${PREMIERE_ID}.admission.json`,
    ]);
    expect(await projectionEntries(harness.privateStateRoot)).toHaveLength(1);
  });

  test("an aborted checkpoint projection publishes neither artifact nor admission", async () => {
    const harness = await createHarness(root);
    const controller = new AbortController();
    controller.abort();

    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, {
        ...harness.dependencies,
        checkpointProjectionSignal: controller.signal,
        checkpointProjector: {
          async project({ signal }) {
            expect(signal).not.toBe(controller.signal);
            expect(signal.aborted).toBe(true);
            throw new ReplayPremiereError(
              "checkpoint_projection_aborted",
              "PREMIERE_UNAVAILABLE",
              503,
              "checkpoint projection aborted",
            );
          },
        },
      }),
      "checkpoint_projection_aborted",
    );

    expect(await admissionEntries(harness.privateStateRoot)).toEqual([]);
    expect(await projectionEntries(harness.privateStateRoot)).toEqual([]);
  });

  test("bounds a direct admission projector and publishes nothing after its full prelude", async () => {
    const harness = await createHarness(root);
    let observedAbort = false;

    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, {
        ...harness.dependencies,
        checkpointProjectionTimeoutMs: 10,
        checkpointProjector: {
          async project({ signal }) {
            return new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  observedAbort = true;
                  reject(new Error("projector observed intrinsic deadline"));
                },
                { once: true },
              );
            });
          },
        },
      }),
      "admission_checkpoint_projection_deadline_exceeded",
    );

    expect(observedAbort).toBe(true);
    expect(harness.fetchCalls()).toBeGreaterThan(70);
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([]);
    expect(await projectionEntries(harness.privateStateRoot)).toEqual([]);
  });

  test("rechecks projection cancellation after the projector resolves", async () => {
    const harness = await createHarness(root);
    const controller = new AbortController();
    const projector = harness.dependencies.checkpointProjector;

    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, {
        ...harness.dependencies,
        checkpointProjectionSignal: controller.signal,
        checkpointProjector: {
          async project(options) {
            const projection = await projector.project(options);
            controller.abort();
            return projection;
          },
        },
      }),
      "checkpoint_projection_aborted",
    );

    expect(await admissionEntries(harness.privateStateRoot)).toEqual([]);
    expect(await projectionEntries(harness.privateStateRoot)).toEqual([]);
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
      statfs: AMPLE_DISK,
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

  test("reuses an exact existing admission and its bound projection before probes", async () => {
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

    const reused = await runReplayPremiereAdmission(harness.args, {
      now: () => new Date(NOW.getTime() + 60_000),
      environment: { PROXYWAR_PUBLIC_URL: EXPECTED_ORIGIN },
      fetch: async () => {
        throw new Error("existing admission must not probe");
      },
      checkpointProjector: {
        async project() {
          throw new Error("existing admission must not project");
        },
      },
    });

    expect(first.premiereId).toBe(PREMIERE_ID);
    expect(reused).toEqual(first);
    expect(harness.fetchCalls()).toBe(callsAfterFirst);
    expect(await fs.readFile(entryPath)).toEqual(before);
    expect(await privateFileSnapshot(harness.privateStateRoot)).toEqual(
      privateBefore,
    );
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([
      `${PREMIERE_ID}.admission.json`,
    ]);
  });

  test("holds an incompatible same-id retry across two ticks without probes or mutation", async () => {
    const harness = await createHarness(root);
    await runReplayPremiereAdmission(harness.args, harness.dependencies);
    const privateBefore = await privateFileSnapshot(harness.privateStateRoot);
    const callsAfterFirst = harness.fetchCalls();
    const definition = JSON.parse(
      await fs.readFile(harness.definitionFile, "utf8"),
    ) as Record<string, unknown>;
    definition.title = "Different retained transaction";
    await fs.writeFile(
      harness.definitionFile,
      `${JSON.stringify(definition)}\n`,
      { mode: 0o600 },
    );
    const runTick = () =>
      runLoopReplayPremiereAdmission({
        args: harness.args,
        premiereId: PREMIERE_ID,
        bundleSha256: harness.sourceSha256,
        environment: { PROXYWAR_PUBLIC_URL: EXPECTED_ORIGIN },
        runAdmission: (args, dependencies) =>
          runReplayPremiereAdmission(args, {
            ...dependencies,
            fetch: async () => {
              throw new Error("incompatible existing admission must not probe");
            },
          }),
      });

    await expect(runTick()).resolves.toEqual({
      kind: "hold",
      reason: "admission_state_uncertain",
    });
    await expect(runTick()).resolves.toEqual({
      kind: "hold",
      reason: "admission_state_uncertain",
    });

    expect(harness.fetchCalls()).toBe(callsAfterFirst);
    expect(await admissionEntries(harness.privateStateRoot)).toEqual([
      `${PREMIERE_ID}.admission.json`,
    ]);
    const privateAfter = await privateFileSnapshot(harness.privateStateRoot);
    expect(privateAfter).toEqual(privateBefore);
    expect(await fs.readFile(harness.definitionFile, "utf8")).toContain(
      "Different retained transaction",
    );
  });

  test("refuses same-id reuse when retained source bytes differ", async () => {
    const harness = await createHarness(root);
    await runReplayPremiereAdmission(harness.args, harness.dependencies);
    const callsAfterFirst = harness.fetchCalls();
    await fs.writeFile(harness.sourceFile, Buffer.from("different source"), {
      mode: 0o600,
    });

    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, {
        environment: { PROXYWAR_PUBLIC_URL: EXPECTED_ORIGIN },
      }),
      "admission_existing_identity_mismatch",
    );
    expect(harness.fetchCalls()).toBe(callsAfterFirst);
  });

  test("rejects a different declared source identity before staging retained bytes", async () => {
    const harness = await createHarness(root);
    await runReplayPremiereAdmission(harness.args, harness.dependencies);
    const privateBefore = await privateFileSnapshot(harness.privateStateRoot);
    const callsAfterFirst = harness.fetchCalls();
    const differentSourceBytes = Buffer.from(
      '{"different":"retained source identity"}\n',
    );
    const differentSourceSha256 = sha256Hex(differentSourceBytes);
    await fs.writeFile(harness.sourceFile, differentSourceBytes, {
      mode: 0o600,
    });
    const retryArgs = harness.args.map((argument) =>
      argument.startsWith("--expected-source-sha256=")
        ? `--expected-source-sha256=${differentSourceSha256}`
        : argument,
    );

    await expectOperatorCode(
      runReplayPremiereAdmission(retryArgs, {
        environment: { PROXYWAR_PUBLIC_URL: EXPECTED_ORIGIN },
        fetch: async () => {
          throw new Error("identity mismatch must not probe");
        },
      }),
      "admission_existing_identity_mismatch",
    );

    expect(harness.fetchCalls()).toBe(callsAfterFirst);
    const privateAfter = await privateFileSnapshot(harness.privateStateRoot);
    expect(privateAfter).toEqual(privateBefore);
    expect(Object.keys(privateAfter)).not.toContain(
      `sources/sha256/${differentSourceSha256.slice(0, 2)}/${differentSourceSha256}.replay`,
    );
  });

  test.each(["operator input", "private nonce"] as const)(
    "refuses same-id reuse when the retained %s differs",
    async (mismatch) => {
      const harness = await createHarness(root);
      await runReplayPremiereAdmission(harness.args, harness.dependencies);
      const privateBefore = await privateFileSnapshot(harness.privateStateRoot);
      if (mismatch === "operator input") {
        const eligibility = JSON.parse(
          await fs.readFile(harness.eligibilityFile, "utf8"),
        ) as Record<string, unknown>;
        eligibility.eligibilityCheckVersion = "different-retained-check";
        await fs.writeFile(
          harness.eligibilityFile,
          `${JSON.stringify(eligibility)}\n`,
          { mode: 0o600 },
        );
      } else {
        await fs.writeFile(harness.nonceFile, Buffer.alloc(32, 7), {
          mode: 0o600,
        });
      }

      await expectOperatorCode(
        runReplayPremiereAdmission(harness.args, {
          environment: { PROXYWAR_PUBLIC_URL: EXPECTED_ORIGIN },
          fetch: async () => {
            throw new Error("identity mismatch must not probe");
          },
        }),
        "admission_existing_identity_mismatch",
      );

      expect(await privateFileSnapshot(harness.privateStateRoot)).toEqual(
        privateBefore,
      );
    },
  );

  test("refuses exact reuse when the bound checkpoint projection is missing", async () => {
    const harness = await createHarness(root);
    await runReplayPremiereAdmission(harness.args, harness.dependencies);
    const [artifactName] = await projectionEntries(harness.privateStateRoot);
    expect(artifactName).toBeDefined();
    await fs.rm(
      path.join(
        harness.privateStateRoot,
        "catalog-v1",
        "checkpoint-projections",
        artifactName,
      ),
    );

    await expectOperatorCode(
      runReplayPremiereAdmission(harness.args, {
        environment: { PROXYWAR_PUBLIC_URL: EXPECTED_ORIGIN },
      }),
      "admission_existing_projection_unavailable",
    );
  });

  test.each(["corrupt", "mismatched"] as const)(
    "refuses exact reuse when the bound checkpoint projection is %s",
    async (failureMode) => {
      const harness = await createHarness(root);
      await runReplayPremiereAdmission(harness.args, harness.dependencies);
      const [artifactName] = await projectionEntries(harness.privateStateRoot);
      expect(artifactName).toBeDefined();
      const artifactPath = path.join(
        harness.privateStateRoot,
        "catalog-v1",
        "checkpoint-projections",
        artifactName,
      );
      await fs.chmod(artifactPath, 0o600);
      if (failureMode === "corrupt") {
        await fs.writeFile(artifactPath, "{}\n", { mode: 0o600 });
      } else {
        const artifact = JSON.parse(
          await fs.readFile(artifactPath, "utf8"),
        ) as Record<string, unknown>;
        artifact.admissionRecordHash = "f".repeat(64);
        const { artifactHash: _artifactHash, ...preimage } = artifact;
        artifact.artifactHash = hashReplayPremiereJson(
          preimage as ReplayPremiereJsonValue,
        );
        await fs.writeFile(
          artifactPath,
          `${canonicalReplayPremiereJson(
            artifact as ReplayPremiereJsonValue,
          )}\n`,
          { mode: 0o600 },
        );
      }
      await fs.chmod(artifactPath, 0o400);

      await expectOperatorCode(
        runReplayPremiereAdmission(harness.args, {
          environment: { PROXYWAR_PUBLIC_URL: EXPECTED_ORIGIN },
        }),
        "admission_existing_projection_unavailable",
      );
    },
  );

  test("maps a commitment-only collision with no requested premiere to a retained hold", async () => {
    const result = await runLoopReplayPremiereAdmission({
      args: [],
      premiereId: PREMIERE_ID,
      bundleSha256: "a".repeat(64),
      environment: {},
      runAdmission: async () => {
        throw new ReplayPremiereError(
          "admission_commitment_already_exists",
          "PREMIERE_INVALID_REQUEST",
          409,
          "commitment belongs to a different premiere",
        );
      },
    });

    expect(result).toEqual({
      kind: "hold",
      reason: "admission_state_uncertain",
    });
  });

  test("reports catalog lock contention with a fixed operator code and no entry", async () => {
    const harness = await createHarness(root);
    const catalog = await ReplayPremiereAdmissionCatalog.open({
      statfs: AMPLE_DISK,
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
      checkpointProjector: {
        async project({ gate }) {
          const definition = gate.publicDefinition();
          const optionSeatIds = definition.provenance.seats.map(
            (seat) => seat.seatId,
          );
          return freezeReplayPremiereCheckpointProjection({
            premiereId: gate.premiereId,
            publicationCommitmentHash: gate.publicationCommitmentHash,
            checkpoints: [
              { ...definition.checkpoints[0], optionSeatIds },
              { ...definition.checkpoints[1], optionSeatIds },
            ],
          });
        },
      } satisfies ReplayPremiereCheckpointProjector,
    },
    fetchCalls: () => fetchCalls,
    sourceSha256,
    sourceFile,
    privateStateRoot,
    servedRoot,
    eligibilityFile,
    definitionFile,
    nonceFile,
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

async function projectionEntries(privateStateRoot: string): Promise<string[]> {
  try {
    return (
      await fs.readdir(
        path.join(privateStateRoot, "catalog-v1", "checkpoint-projections"),
      )
    ).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
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
