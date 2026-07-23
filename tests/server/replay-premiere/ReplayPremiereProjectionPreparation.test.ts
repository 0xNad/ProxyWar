import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { executeReplayPremiereProjectionPreparationCli } from "../../../src/scripts/replay-premiere-prepare-projection";
import { ReplayPremiereAdmissionCatalog } from "../../../src/server/replay-premiere/ReplayPremiereCatalog";
import {
  freezeReplayPremiereCheckpointProjection,
  type ReplayPremiereCheckpointProjector,
} from "../../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
import { ReplayPremiereEventStore } from "../../../src/server/replay-premiere/ReplayPremiereEventStore";
import { sha256Hex } from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS } from "../../../src/server/replay-premiere/ReplayPremiereStartup";
import {
  PREMIERE_ID,
  verifiedPublicationFixture,
} from "./ReplayPremiereFixtures";

const ORIGIN = "https://beta.proxywar.xyz";
const execFileAsync = promisify(execFile);
const CHUNK_LIMITS = {
  maxChunkBytes: 100_000,
  maxTotalBytes: 1_000_000,
  maxRecordsPerChunk: 20,
  maxPresentationSpanMs: 1_000,
} as const;
const COLLECTOR_LIMITS = {
  maxTargets: 256,
  maxTargetUrlBytes: 4_096,
  maxBodyBytesPerTarget: 1_000_000,
  maxTotalBodyBytes: 8_000_000,
  maxHeaderBytesPerTarget: 16_384,
  maxHeaderCountPerTarget: 64,
  requestTimeoutMs: 1_000,
  totalTimeoutMs: 10_000,
} as const;

describe("Replay Premiere legacy projection preparation CLI", () => {
  let root: string;
  let privateStateRoot: string;
  let servedRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-prepare-"));
    privateStateRoot = path.join(root, "private");
    servedRoot = path.join(root, "served");
    const fixture = await verifiedPublicationFixture(root);
    const catalog = await ReplayPremiereAdmissionCatalog.open({
      privateStateRoot,
      servedRoots: [servedRoot],
    });
    try {
      await catalog.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
      });
    } finally {
      await catalog.close();
    }
    const eventStore = await ReplayPremiereEventStore.open({
      privateStateRoot,
      servedRoots: [servedRoot],
      limits: DEFAULT_REPLAY_PREMIERE_EVENT_STORE_LIMITS,
    });
    await eventStore.close();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("writes only the exact artifact and reports the second run as reused", async () => {
    const admissionPath = admissionFilePath(privateStateRoot);
    const eventJournalPath = path.join(
      privateStateRoot,
      "event-store-v1",
      "events.jsonl",
    );
    const sourcePath = await findOnlySource(privateStateRoot);
    const before = await hashes([admissionPath, eventJournalPath, sourcePath]);
    const args = [
      `--premiere-id=${PREMIERE_ID}`,
      `--private-state-root=${privateStateRoot}`,
      `--served-root=${servedRoot}`,
      `--deployment-origin=${ORIGIN}`,
    ];
    const firstCapture = capture();
    const project = vi.fn(allSeatsProjection);
    const firstExit = await executeReplayPremiereProjectionPreparationCli(
      args,
      {
        environment: { PROXYWAR_PUBLIC_URL: ORIGIN },
        checkpointProjector: { project },
      },
      firstCapture.io,
    );
    expect(firstExit).toBe(0);
    expect(firstCapture.stderr()).toBe("");
    const first = JSON.parse(firstCapture.stdout()) as {
      projectionArtifactHash: string;
      reused: boolean;
    };
    expect(first.reused).toBe(false);
    expect(first.projectionArtifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(project).toHaveBeenCalledTimes(1);
    expect(await hashes([admissionPath, eventJournalPath, sourcePath])).toEqual(
      before,
    );

    const secondCapture = capture();
    const secondExit = await executeReplayPremiereProjectionPreparationCli(
      args,
      {
        environment: { PROXYWAR_PUBLIC_URL: ORIGIN },
        checkpointProjector: {
          async project() {
            throw new Error("reused preparation must not project");
          },
        },
      },
      secondCapture.io,
    );
    expect(secondExit).toBe(0);
    expect(secondCapture.stderr()).toBe("");
    const second = JSON.parse(secondCapture.stdout()) as {
      projectionArtifactHash: string;
      reused: boolean;
    };
    expect(second.reused).toBe(true);
    expect(second.projectionArtifactHash).toBe(first.projectionArtifactHash);
    expect(await hashes([admissionPath, eventJournalPath, sourcePath])).toEqual(
      before,
    );
  });

  test("releases the catalog lock while the projector does expensive work", async () => {
    const captureOutput = capture();
    let concurrentRead = false;
    const exitCode = await executeReplayPremiereProjectionPreparationCli(
      preparationArgs(privateStateRoot, servedRoot),
      {
        environment: { PROXYWAR_PUBLIC_URL: ORIGIN },
        checkpointProjector: {
          async project(options) {
            const concurrent = await ReplayPremiereAdmissionCatalog.open({
              privateStateRoot,
              servedRoots: [servedRoot],
            });
            try {
              const read = await concurrent.readAll();
              expect(read.failures).toEqual([]);
              expect(read.entries.map((entry) => entry.premiereId)).toEqual([
                PREMIERE_ID,
              ]);
              concurrentRead = true;
            } finally {
              await concurrent.close();
            }
            return allSeatsProjection(options);
          },
        },
      },
      captureOutput.io,
    );

    expect(exitCode).toBe(0);
    expect(concurrentRead).toBe(true);
    expect(captureOutput.stderr()).toBe("");
    expect(
      await fs.readdir(projectionDirectory(privateStateRoot)),
    ).toHaveLength(1);
  });

  test.each([
    {
      mutation: "deletion",
      operatorCode: "catalog_projection_admission_missing",
      mutate: async (filePath: string) => fs.unlink(filePath),
    },
    {
      mutation: "replacement",
      operatorCode: "catalog_projection_admission_replaced",
      mutate: async (filePath: string) => {
        await fs.chmod(filePath, 0o600);
        await fs.writeFile(filePath, "{}\n");
        await fs.chmod(filePath, 0o400);
      },
    },
  ])(
    "rejects admission $mutation during projection without publishing an artifact",
    async ({ operatorCode, mutate }) => {
      const captureOutput = capture();
      const exitCode = await executeReplayPremiereProjectionPreparationCli(
        preparationArgs(privateStateRoot, servedRoot),
        {
          environment: { PROXYWAR_PUBLIC_URL: ORIGIN },
          checkpointProjector: {
            async project(options) {
              await mutate(admissionFilePath(privateStateRoot));
              return allSeatsProjection(options);
            },
          },
        },
        captureOutput.io,
      );

      expect(exitCode).toBe(1);
      expect(captureOutput.stdout()).toBe("");
      expect(captureOutput.stderr()).toBe(
        `REPLAY_PREMIERE_PROJECTION_PREPARATION_FAILED ${operatorCode}\n`,
      );
      expect(await fs.readdir(projectionDirectory(privateStateRoot))).toEqual(
        [],
      );
    },
  );

  test("rolls a new artifact back when reclamation deletes its admission after publication", async () => {
    const captureOutput = capture();
    let admissionDeleted = false;
    const exitCode = await executeReplayPremiereProjectionPreparationCli(
      preparationArgs(privateStateRoot, servedRoot),
      {
        environment: { PROXYWAR_PUBLIC_URL: ORIGIN },
        checkpointProjector: { project: allSeatsProjection },
        checkpointProjectionPublicationFaultInjector: async (phase) => {
          if (!admissionDeleted && phase === "after_directory_sync") {
            admissionDeleted = true;
            await fs.unlink(admissionFilePath(privateStateRoot));
          }
        },
      },
      captureOutput.io,
    );

    expect(exitCode).toBe(1);
    expect(admissionDeleted).toBe(true);
    expect(captureOutput.stdout()).toBe("");
    expect(captureOutput.stderr()).toBe(
      "REPLAY_PREMIERE_PROJECTION_PREPARATION_FAILED " +
        "catalog_projection_admission_missing\n",
    );
    expect(await fs.readdir(projectionDirectory(privateStateRoot))).toEqual([]);
  });

  test("bounds an unresponsive projector and publishes no artifact", async () => {
    const captureOutput = capture();
    let observedAbort = false;
    const exitCode = await executeReplayPremiereProjectionPreparationCli(
      preparationArgs(privateStateRoot, servedRoot),
      {
        environment: { PROXYWAR_PUBLIC_URL: ORIGIN },
        projectionTimeoutMs: 10,
        checkpointProjector: {
          async project({ signal }) {
            return new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  observedAbort = true;
                  reject(new Error("projector observed abort"));
                },
                { once: true },
              );
            });
          },
        },
      },
      captureOutput.io,
    );

    expect(exitCode).toBe(1);
    expect(observedAbort).toBe(true);
    expect(captureOutput.stdout()).toBe("");
    expect(captureOutput.stderr()).toBe(
      "REPLAY_PREMIERE_PROJECTION_PREPARATION_FAILED " +
        "projection_preparation_deadline_exceeded\n",
    );
    expect(
      await fs.readdir(
        path.join(privateStateRoot, "catalog-v1", "checkpoint-projections"),
      ),
    ).toEqual([]);
  });

  test("boots the package CLI's real projector in the bundled game environment", async () => {
    let failure: unknown;
    try {
      await execFileAsync(
        "npm",
        [
          "run",
          "--silent",
          "premiere:prepare-projection",
          "--",
          `--premiere-id=${PREMIERE_ID}`,
          `--private-state-root=${privateStateRoot}`,
          `--served-root=${servedRoot}`,
          `--deployment-origin=${ORIGIN}`,
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, PROXYWAR_PUBLIC_URL: ORIGIN },
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    } catch (error) {
      failure = error;
    }

    // This intentionally tiny fixture has no spawn intents. Reaching the
    // semantic player check proves the package script initialized real bundled
    // game logic; without GAME_ENV=dev it fails earlier at environment loading.
    expect(failure).toMatchObject({
      code: 1,
      stderr:
        "REPLAY_PREMIERE_PROJECTION_PREPARATION_FAILED " +
        "checkpoint_projection_player_unspawned\n",
    });
  }, 130_000);
});

async function allSeatsProjection(
  options: Parameters<ReplayPremiereCheckpointProjector["project"]>[0],
) {
  const definition = options.gate.publicDefinition();
  const optionSeatIds = definition.provenance.seats.map((seat) => seat.seatId);
  return freezeReplayPremiereCheckpointProjection({
    premiereId: options.gate.premiereId,
    publicationCommitmentHash: options.gate.publicationCommitmentHash,
    checkpoints: [
      { ...definition.checkpoints[0], optionSeatIds },
      { ...definition.checkpoints[1], optionSeatIds },
    ],
  });
}

function preparationArgs(
  privateStateRoot: string,
  servedRoot: string,
): string[] {
  return [
    `--premiere-id=${PREMIERE_ID}`,
    `--private-state-root=${privateStateRoot}`,
    `--served-root=${servedRoot}`,
    `--deployment-origin=${ORIGIN}`,
  ];
}

function admissionFilePath(privateStateRoot: string): string {
  return path.join(
    privateStateRoot,
    "catalog-v1",
    "entries",
    `${PREMIERE_ID}.admission.json`,
  );
}

function projectionDirectory(privateStateRoot: string): string {
  return path.join(privateStateRoot, "catalog-v1", "checkpoint-projections");
}

async function findOnlySource(privateStateRoot: string): Promise<string> {
  const root = path.join(privateStateRoot, "sources", "sha256");
  const prefixes = await fs.readdir(root);
  const files = (
    await Promise.all(
      prefixes.map(async (prefix) =>
        (await fs.readdir(path.join(root, prefix))).map((file) =>
          path.join(root, prefix, file),
        ),
      ),
    )
  ).flat();
  expect(files).toHaveLength(1);
  return files[0];
}

async function hashes(paths: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (filePath) => [
        path.basename(filePath),
        sha256Hex(await fs.readFile(filePath)),
      ]),
    ),
  );
}

function capture() {
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
