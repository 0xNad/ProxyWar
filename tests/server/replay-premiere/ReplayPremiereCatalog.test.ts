import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS,
  readAdmissionVerifiedSource,
  ReplayPremiereAdmissionCatalog,
  type ReplayPremiereAdmissionRecordV1,
} from "../../../src/server/replay-premiere/ReplayPremiereCatalog";
import {
  freezeReplayPremiereCheckpointProjection,
  type ReplayPremiereCheckpointProjector,
} from "../../../src/server/replay-premiere/ReplayPremiereCheckpointProjection";
import { buildPremiereChunks } from "../../../src/server/replay-premiere/ReplayPremiereChunks";
import { ReplayPremiereError } from "../../../src/server/replay-premiere/ReplayPremiereErrors";
import {
  canonicalReplayPremiereJson,
  hashReplayPremiereJson,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import {
  importControlledPremiereSourceForPublication,
  VerifiedPremiereEligibilityGate,
} from "../../../src/server/replay-premiere/ReplayPremierePublication";
import {
  AMPLE_DISK,
  PREMIERE_ID,
  verifiedPublicationFixture,
} from "./ReplayPremiereFixtures";

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

const MEBIBYTE = 1024 * 1024;
const OBSERVED_LIVE_CATALOG_BYTES = 67_091_213;

describe("ReplayPremiereAdmissionCatalog", () => {
  let root: string;
  const catalogs: ReplayPremiereAdmissionCatalog[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-catalog-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const catalog of catalogs.splice(0)) await catalog.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test("persists and reloads exact verified admission inputs", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const catalog = await openCatalog(root);
    catalogs.push(catalog);

    const written = await catalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
    const loaded = await catalog.readAll();

    expect(loaded.failures).toEqual([]);
    expect(loaded.entries).toEqual([written]);
    expect(loaded.entries[0]).toMatchObject({
      premiereId: PREMIERE_ID,
      expectedEligibilityRecordHash: fixture.gate.eligibilityRecordHash,
      expectedPublicationCommitmentHash: fixture.gate.publicationCommitmentHash,
      expectedOrderedDraftManifestRoot:
        fixture.gate.publicationCommitment().orderedDraftManifestRoot,
    });
    expect(loaded.entries[0].leakAuditReceipt).toEqual(
      fixture.verificationOptions.leakAuditReceipt.material(),
    );
  });

  test("isolates a truncated entry with sanitized per-target diagnostics", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const catalog = await openCatalog(root);
    catalogs.push(catalog);
    await catalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
    const entryPath = path.join(
      catalog.entriesRoot,
      `${PREMIERE_ID}.admission.json`,
    );
    await fs.chmod(entryPath, 0o600);
    await fs.writeFile(entryPath, "{\n");
    await fs.chmod(entryPath, 0o400);

    const loaded = await catalog.readAll();

    expect(loaded.entries).toEqual([]);
    expect(loaded.failures).toEqual([
      {
        target: `${PREMIERE_ID}.admission.json`,
        operatorCode: "catalog_entry_invalid_json",
      },
    ]);
    expect(Object.keys(loaded.failures[0]).sort()).toEqual([
      "operatorCode",
      "target",
    ]);
  });

  test("replaces control-bearing and oversized filenames with a bounded opaque diagnostic target", async () => {
    const catalog = await openCatalog(root);
    catalogs.push(catalog);
    const maliciousName = `${"x".repeat(170)}\nforged\u0001.admission.json`;
    await fs.writeFile(path.join(catalog.entriesRoot, maliciousName), "{", {
      mode: 0o400,
    });

    const loaded = await catalog.readAll();

    expect(loaded.entries).toEqual([]);
    expect(loaded.failures).toEqual([
      {
        target: `catalog_entry_${sha256Hex(Buffer.from(maliciousName, "utf8"))}`,
        operatorCode: "catalog_entry_filename_invalid",
      },
    ]);
    expect(loaded.failures[0].target).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(
      Buffer.byteLength(loaded.failures[0].target, "utf8"),
    ).toBeLessThanOrEqual(160);
  });

  test("rejects staged source drift when a persisted admission is reconstructed", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const catalog = await openCatalog(root);
    catalogs.push(catalog);
    const record = await catalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
    const sourcePath = path.join(
      path.join(root, "private"),
      ...record.stagedSource.relativePath.split("/"),
    );
    await fs.chmod(sourcePath, 0o600);
    await fs.appendFile(sourcePath, " ");
    await fs.chmod(sourcePath, 0o400);

    await expect(
      readAdmissionVerifiedSource({
        record,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
        maxSourceBytes: 2_000_000,
      }),
    ).rejects.toBeInstanceOf(ReplayPremiereError);
  });

  test("rejects both entries when a second identity reuses a commitment", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const catalog = await openCatalog(root);
    catalogs.push(catalog);
    const record = await catalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
    const duplicatePremiereId = "prem_fedcba9876543210";
    const { recordHash: _recordHash, ...recordPreimage } = record;
    const duplicatePreimage = {
      ...recordPreimage,
      premiereId: duplicatePremiereId,
    };
    const duplicate: ReplayPremiereAdmissionRecordV1 = {
      ...duplicatePreimage,
      recordHash: hashReplayPremiereJson(
        duplicatePreimage as unknown as ReplayPremiereJsonValue,
      ),
    };
    const duplicatePath = path.join(
      catalog.entriesRoot,
      `${duplicatePremiereId}.admission.json`,
    );
    await fs.writeFile(
      duplicatePath,
      `${canonicalReplayPremiereJson(
        duplicate as unknown as ReplayPremiereJsonValue,
      )}\n`,
      { mode: 0o400 },
    );

    const loaded = await catalog.readAll();

    expect(loaded.entries).toEqual([]);
    expect(loaded.failures).toEqual([
      {
        target: `${PREMIERE_ID}.admission.json`,
        operatorCode: "catalog_duplicate_identity",
      },
      {
        target: `${duplicatePremiereId}.admission.json`,
        operatorCode: "catalog_duplicate_identity",
      },
    ]);
  });

  test("enforces one catalog writer and the total-byte hard ceiling", async () => {
    const catalog = await openCatalog(root);
    catalogs.push(catalog);
    await expect(openCatalog(root)).rejects.toMatchObject({
      operatorCode: "catalog_writer_already_active_in_process",
    });
    await catalog.close();
    catalogs.splice(catalogs.indexOf(catalog), 1);

    const bounded = await ReplayPremiereAdmissionCatalog.open({
      statfs: AMPLE_DISK,
      privateStateRoot: path.join(root, "bounded-private"),
      servedRoots: [path.join(root, "bounded-served")],
      limits: {
        maxEntries: 4,
        maxEntryBytes: 100,
        maxTotalEntryBytes: 100,
        maxSourceBytes: 1_000,
        maxAuthoritativeResultBytes: 1_000,
      },
    });
    catalogs.push(bounded);
    await Promise.all([
      writeOpaqueEntry(bounded.entriesRoot, "premiere_alpha1", 60),
      writeOpaqueEntry(bounded.entriesRoot, "premiere_alpha2", 60),
    ]);

    await expect(bounded.readAll()).rejects.toMatchObject({
      operatorCode: "catalog_total_byte_ceiling_exceeded",
    });
  });

  test("admits a normal record beside the observed live catalog under the bounded default", async () => {
    const fixture = await verifiedPublicationFixture(root, {
      leakEvidenceBodyBytes: 683_458,
    });
    const catalog = await openCatalog(root);
    catalogs.push(catalog);
    await writeSparseCatalogBytes(
      catalog.entriesRoot,
      OBSERVED_LIVE_CATALOG_BYTES,
    );
    expect(await catalogEntryBytes(catalog.entriesRoot)).toBe(
      OBSERVED_LIVE_CATALOG_BYTES,
    );

    const record = await catalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
    const admissionBytes = (
      await fs.stat(entryPath(catalog, record.premiereId))
    ).size;

    expect(DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS).toEqual({
      maxEntries: 128,
      maxEntryBytes: 8 * MEBIBYTE,
      maxTotalEntryBytes: 256 * MEBIBYTE,
      maxSourceBytes: 256 * MEBIBYTE,
      maxAuthoritativeResultBytes: 2 * MEBIBYTE,
    });
    expect(admissionBytes).toBeGreaterThanOrEqual(1.49 * MEBIBYTE);
    expect(admissionBytes).toBeLessThanOrEqual(1.51 * MEBIBYTE);
    expect(OBSERVED_LIVE_CATALOG_BYTES + admissionBytes).toBeGreaterThan(
      64 * MEBIBYTE,
    );
    expect(OBSERVED_LIVE_CATALOG_BYTES + admissionBytes).toBeLessThan(
      DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS.maxTotalEntryBytes,
    );
  });

  test("fails closed at the 256 MiB aggregate and validator hard ceilings", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const catalog = await openCatalog(root);
    catalogs.push(catalog);
    await writeSparseCatalogBytes(
      catalog.entriesRoot,
      DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS.maxTotalEntryBytes,
    );
    expect(await catalogEntryBytes(catalog.entriesRoot)).toBe(
      DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS.maxTotalEntryBytes,
    );

    await expect(
      catalog.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
      }),
    ).rejects.toMatchObject({
      operatorCode: "catalog_total_byte_ceiling_exceeded",
    });

    await catalog.close();
    catalogs.splice(catalogs.indexOf(catalog), 1);
    await expect(
      ReplayPremiereAdmissionCatalog.open({
        statfs: AMPLE_DISK,
        privateStateRoot: path.join(root, "over-hard-max-private"),
        servedRoots: [path.join(root, "over-hard-max-served")],
        limits: {
          ...DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS,
          maxTotalEntryBytes:
            DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS.maxTotalEntryBytes + 1,
        },
      }),
    ).rejects.toMatchObject({
      operatorCode: "catalog_limits_outside_hard_bounds",
    });
  });

  test("serializes concurrent admissions across the entry-count ceiling", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const alternate = alternateAdmission(fixture);
    const catalog = await ReplayPremiereAdmissionCatalog.open({
      statfs: AMPLE_DISK,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      limits: {
        maxEntries: 1,
        maxEntryBytes: 8 * 1024 * 1024,
        maxTotalEntryBytes: 16 * 1024 * 1024,
        maxSourceBytes: 256 * 1024 * 1024,
        maxAuthoritativeResultBytes: 2 * 1024 * 1024,
      },
    });
    catalogs.push(catalog);

    const settled = await Promise.allSettled([
      catalog.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
      }),
      catalog.writeVerifiedAdmission({
        gate: alternate.gate,
        verification: alternate.verification,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
      }),
    ]);

    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      (
        settled.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult
      ).reason,
    ).toMatchObject({ operatorCode: "catalog_entry_count_ceiling_exceeded" });
    expect((await catalog.readAll()).entries).toHaveLength(1);
    expect(
      (await fs.readdir(catalog.entriesRoot)).some((name) =>
        name.startsWith("."),
      ),
    ).toBe(false);
  });

  test("serializes concurrent admissions across the total-byte ceiling", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const alternate = alternateAdmission(fixture);
    const sizing = await openCatalog(root);
    catalogs.push(sizing);
    const sizingRecord = await sizing.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
    const firstBytes = Buffer.byteLength(
      `${canonicalReplayPremiereJson(
        sizingRecord as unknown as ReplayPremiereJsonValue,
      )}\n`,
    );
    await sizing.close();
    catalogs.splice(catalogs.indexOf(sizing), 1);
    await fs.rm(path.join(root, "private", "catalog-v1"), {
      recursive: true,
      force: true,
    });
    const maxEntryBytes = firstBytes + 4_096;
    const catalog = await ReplayPremiereAdmissionCatalog.open({
      statfs: AMPLE_DISK,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      limits: {
        maxEntries: 4,
        maxEntryBytes,
        maxTotalEntryBytes: Math.floor(maxEntryBytes * 1.5),
        maxSourceBytes: 256 * 1024 * 1024,
        maxAuthoritativeResultBytes: 2 * 1024 * 1024,
      },
    });
    catalogs.push(catalog);

    const settled = await Promise.allSettled([
      catalog.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
      }),
      catalog.writeVerifiedAdmission({
        gate: alternate.gate,
        verification: alternate.verification,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
      }),
    ]);

    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        settled.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult
      ).reason,
    ).toMatchObject({ operatorCode: "catalog_total_byte_ceiling_exceeded" });
    const names = await fs.readdir(catalog.entriesRoot);
    expect(names).toHaveLength(1);
    expect(names.some((name) => name.startsWith("."))).toBe(false);
  });

  test("accounts for projection artifact bytes before either artifact or admission publication", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const sizing = await openCatalog(root);
    catalogs.push(sizing);
    const sizingRecord = await sizing.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
      checkpointProjector: allSeatsProjector(),
    });
    const entryBytes = (
      await fs.stat(entryPath(sizing, sizingRecord.premiereId))
    ).size;
    const artifactBytes = (
      await fs.stat(
        sizing.checkpointProjectionStore.artifactPath(
          sizingRecord.premiereId,
          sizingRecord.recordHash,
        ),
      )
    ).size;
    expect(artifactBytes).toBeGreaterThan(0);
    await sizing.close();
    catalogs.splice(catalogs.indexOf(sizing), 1);
    await fs.rm(path.join(root, "private", "catalog-v1"), {
      recursive: true,
      force: true,
    });

    const bounded = await ReplayPremiereAdmissionCatalog.open({
      statfs: AMPLE_DISK,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      limits: {
        maxEntries: 4,
        maxEntryBytes: entryBytes,
        maxTotalEntryBytes: entryBytes,
        maxSourceBytes: 256 * 1024 * 1024,
        maxAuthoritativeResultBytes: 2 * 1024 * 1024,
      },
    });
    catalogs.push(bounded);
    await expect(
      bounded.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
        checkpointProjector: allSeatsProjector(),
      }),
    ).rejects.toMatchObject({
      operatorCode: "catalog_total_byte_ceiling_exceeded",
    });
    expect(await fs.readdir(bounded.entriesRoot)).toEqual([]);
    expect(await fs.readdir(bounded.checkpointProjectionStore.root)).toEqual(
      [],
    );
  });

  test.each([
    "after_temporary_write",
    "after_temporary_sync",
    "after_temporary_close",
    "after_artifact_link",
    "after_artifact_chmod",
    "after_temporary_unlink",
    "after_directory_sync",
  ] as const)(
    "cleans an injected %s failure and retries without temp or hardlink poison",
    async (phase) => {
      const fixture = await verifiedPublicationFixture(root);
      let injected = false;
      const catalog = await ReplayPremiereAdmissionCatalog.open({
        statfs: AMPLE_DISK,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
        checkpointProjectionPublicationFaultInjector: (observed) => {
          if (!injected && observed === phase) {
            injected = true;
            throw new Error(`injected ${phase}`);
          }
        },
      });
      catalogs.push(catalog);

      await expect(
        catalog.writeVerifiedAdmission({
          gate: fixture.gate,
          verification: fixture.verificationOptions,
          chunkBuildLimits: CHUNK_LIMITS,
          collectorLimits: COLLECTOR_LIMITS,
          checkpointProjector: allSeatsProjector(),
        }),
      ).rejects.toThrow(`injected ${phase}`);
      expect(injected).toBe(true);
      expect(await fs.readdir(catalog.entriesRoot)).toEqual([]);
      expect(await fs.readdir(catalog.checkpointProjectionStore.root)).toEqual(
        [],
      );

      const record = await catalog.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
        checkpointProjector: allSeatsProjector(),
      });
      const artifactPath = catalog.checkpointProjectionStore.artifactPath(
        record.premiereId,
        record.recordHash,
      );
      const artifactStat = await fs.lstat(artifactPath);
      expect(artifactStat.nlink).toBe(1);
      expect(artifactStat.mode & 0o777).toBe(0o400);
      expect(
        (await fs.readdir(catalog.checkpointProjectionStore.root)).some(
          (name) => name.endsWith(".tmp"),
        ),
      ).toBe(false);
      expect((await catalog.readAll()).entries).toEqual([record]);
    },
  );

  test("aborts after artifact publication before admission visibility", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const controller = new AbortController();
    const catalog = await openCatalog(root);
    catalogs.push(catalog);

    await expect(
      catalog.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
        checkpointProjector: allSeatsProjector(),
        checkpointProjectionSignal: controller.signal,
        afterCheckpointProjectionPublished: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ operatorCode: "checkpoint_projection_aborted" });
    expect(await fs.readdir(catalog.entriesRoot)).toEqual([]);
    expect(await fs.readdir(catalog.checkpointProjectionStore.root)).toEqual(
      [],
    );
  });

  test.each(["after_admission_link", "after_directory_sync"] as const)(
    "rolls admission and artifact back when the deadline fires at %s",
    async (abortPhase) => {
      const fixture = await verifiedPublicationFixture(root);
      const controller = new AbortController();
      let aborted = false;
      const catalog = await ReplayPremiereAdmissionCatalog.open({
        statfs: AMPLE_DISK,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
        admissionPublicationFaultInjector: (phase) => {
          if (!aborted && phase === abortPhase) {
            aborted = true;
            controller.abort();
          }
        },
      });
      catalogs.push(catalog);

      await expect(
        catalog.writeVerifiedAdmission({
          gate: fixture.gate,
          verification: fixture.verificationOptions,
          chunkBuildLimits: CHUNK_LIMITS,
          collectorLimits: COLLECTOR_LIMITS,
          checkpointProjector: allSeatsProjector(),
          checkpointProjectionSignal: controller.signal,
        }),
      ).rejects.toMatchObject({
        operatorCode: "checkpoint_projection_aborted",
      });
      expect(aborted).toBe(true);
      expect(await fs.readdir(catalog.entriesRoot)).toEqual([]);
      expect(await fs.readdir(catalog.checkpointProjectionStore.root)).toEqual(
        [],
      );
    },
  );

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
    "rolls a newly durable projection back after admission $mutation",
    async ({ operatorCode, mutate }) => {
      const fixture = await verifiedPublicationFixture(root);
      const admissionPath = path.join(
        root,
        "private",
        "catalog-v1",
        "entries",
        `${PREMIERE_ID}.admission.json`,
      );
      let mutated = false;
      const catalog = await ReplayPremiereAdmissionCatalog.open({
        statfs: AMPLE_DISK,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
        checkpointProjectionPublicationFaultInjector: async (phase) => {
          if (!mutated && phase === "after_directory_sync") {
            mutated = true;
            await mutate(admissionPath);
          }
        },
      });
      catalogs.push(catalog);
      const record = await catalog.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
      });
      const projection = await allSeatsProjector().project({
        gate: fixture.gate,
        drafts: fixture.verificationOptions.draftChunks,
        signal: new AbortController().signal,
      });

      await expect(
        catalog.publishCheckpointProjection({
          record,
          gate: fixture.gate,
          projection,
        }),
      ).rejects.toMatchObject({ operatorCode });
      expect(mutated).toBe(true);
      expect(await fs.readdir(catalog.checkpointProjectionStore.root)).toEqual(
        [],
      );
    },
  );

  test.each([
    "after_temporary_write",
    "after_temporary_sync",
    "after_temporary_close",
    "after_admission_link",
    "after_admission_chmod",
    "after_temporary_unlink",
    "after_directory_sync",
  ] as const)(
    "rolls admission and projection back after injected admission %s failure",
    async (phase) => {
      const fixture = await verifiedPublicationFixture(root);
      let injected = false;
      const catalog = await ReplayPremiereAdmissionCatalog.open({
        statfs: AMPLE_DISK,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
        admissionPublicationFaultInjector: (observed) => {
          if (!injected && observed === phase) {
            injected = true;
            throw new Error(`injected admission ${phase}`);
          }
        },
      });
      catalogs.push(catalog);

      await expect(
        catalog.writeVerifiedAdmission({
          gate: fixture.gate,
          verification: fixture.verificationOptions,
          chunkBuildLimits: CHUNK_LIMITS,
          collectorLimits: COLLECTOR_LIMITS,
          checkpointProjector: allSeatsProjector(),
        }),
      ).rejects.toThrow(`injected admission ${phase}`);
      expect(injected).toBe(true);
      expect(await fs.readdir(catalog.entriesRoot)).toEqual([]);
      expect(await fs.readdir(catalog.checkpointProjectionStore.root)).toEqual(
        [],
      );

      const record = await catalog.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
        checkpointProjector: allSeatsProjector(),
      });
      expect((await catalog.readAll()).entries).toEqual([record]);
      expect(
        (await fs.lstat(entryPath(catalog, record.premiereId))).nlink,
      ).toBe(1);
      expect(
        (
          await fs.lstat(
            catalog.checkpointProjectionStore.artifactPath(
              record.premiereId,
              record.recordHash,
            ),
          )
        ).nlink,
      ).toBe(1);
    },
  );

  test("adopts an exact durable admission and projection after cleanup uncertainty", async () => {
    const fixture = await verifiedPublicationFixture(root);
    let publicationFailed = false;
    let cleanupFailed = false;
    const catalog = await ReplayPremiereAdmissionCatalog.open({
      statfs: AMPLE_DISK,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      admissionPublicationFaultInjector: (phase) => {
        if (!publicationFailed && phase === "after_directory_sync") {
          publicationFailed = true;
          throw new Error("injected post-fsync admission failure");
        }
        if (!cleanupFailed && phase === "before_cleanup_admission_unlink") {
          cleanupFailed = true;
          throw Object.assign(new Error("injected admission unlink EIO"), {
            code: "EIO",
          });
        }
      },
    });
    catalogs.push(catalog);

    const adopted = await catalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
      checkpointProjector: allSeatsProjector(),
    });
    expect(publicationFailed).toBe(true);
    expect(cleanupFailed).toBe(true);
    const retained = await catalog.readAll();
    expect(retained.entries).toHaveLength(1);
    const record = retained.entries[0];
    expect(adopted).toEqual(record);
    const artifactPath = catalog.checkpointProjectionStore.artifactPath(
      record.premiereId,
      record.recordHash,
    );
    expect((await fs.lstat(entryPath(catalog, record.premiereId))).nlink).toBe(
      1,
    );
    expect((await fs.lstat(artifactPath)).nlink).toBe(1);

    const retried = await catalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
      checkpointProjector: allSeatsProjector(),
    });
    expect(retried).toEqual(record);
    expect(await fs.readdir(catalog.checkpointProjectionStore.root)).toEqual([
      path.basename(artifactPath),
    ]);
  });

  test("reports a distinct hold-required outcome for an uncertain linked admission", async () => {
    const fixture = await verifiedPublicationFixture(root);
    let publicationFailed = false;
    let cleanupFailed = false;
    const catalog = await ReplayPremiereAdmissionCatalog.open({
      statfs: AMPLE_DISK,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
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
    });
    catalogs.push(catalog);

    await expect(
      catalog.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
        checkpointProjector: allSeatsProjector(),
      }),
    ).rejects.toMatchObject({
      operatorCode: "catalog_admission_commit_state_uncertain",
    });
    expect(publicationFailed).toBe(true);
    expect(cleanupFailed).toBe(true);
    expect(
      await fs.readdir(catalog.checkpointProjectionStore.root),
    ).toHaveLength(1);
    expect((await fs.lstat(entryPath(catalog, PREMIERE_ID))).nlink).toBe(2);
  });

  test.each([
    "before_rollback_absence_stat",
    "before_rollback_absence_sync",
  ] as const)(
    "retains an orphan projection when %s makes admission absence uncertain, then recovers",
    async (uncertainPhase) => {
      const fixture = await verifiedPublicationFixture(root);
      let publicationFailed = false;
      let absenceUncertain = false;
      const catalog = await ReplayPremiereAdmissionCatalog.open({
        statfs: AMPLE_DISK,
        privateStateRoot: path.join(root, "private"),
        servedRoots: [path.join(root, "served")],
        admissionPublicationFaultInjector: (phase) => {
          if (!publicationFailed && phase === "after_temporary_write") {
            publicationFailed = true;
            throw new Error("injected admission write failure");
          }
          if (!absenceUncertain && phase === uncertainPhase) {
            absenceUncertain = true;
            throw Object.assign(new Error(`injected ${uncertainPhase} EIO`), {
              code: "EIO",
            });
          }
        },
      });
      catalogs.push(catalog);

      await expect(
        catalog.writeVerifiedAdmission({
          gate: fixture.gate,
          verification: fixture.verificationOptions,
          chunkBuildLimits: CHUNK_LIMITS,
          collectorLimits: COLLECTOR_LIMITS,
          checkpointProjector: allSeatsProjector(),
        }),
      ).rejects.toMatchObject({
        operatorCode: "catalog_admission_commit_state_uncertain",
      });
      expect(publicationFailed).toBe(true);
      expect(absenceUncertain).toBe(true);
      expect(await fs.readdir(catalog.entriesRoot)).toEqual([]);
      expect(
        await fs.readdir(catalog.checkpointProjectionStore.root),
      ).toHaveLength(1);
      await catalog.close();
      catalogs.splice(catalogs.indexOf(catalog), 1);

      const recovered = await openCatalog(root);
      catalogs.push(recovered);
      expect((await recovered.readAll()).entries).toEqual([]);
      expect(
        await fs.readdir(recovered.checkpointProjectionStore.root),
      ).toEqual([]);
      const retried = await recovered.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
        checkpointProjector: allSeatsProjector(),
      });
      expect((await recovered.readAll()).entries).toEqual([retried]);
    },
  );

  test("re-verifies durable absence after cleanup directory fsync fails", async () => {
    const fixture = await verifiedPublicationFixture(root);
    let publicationFailed = false;
    let cleanupSyncFailed = false;
    const catalog = await ReplayPremiereAdmissionCatalog.open({
      statfs: AMPLE_DISK,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      admissionPublicationFaultInjector: (phase) => {
        if (!publicationFailed && phase === "after_admission_link") {
          publicationFailed = true;
          throw new Error("injected post-link admission failure");
        }
        if (!cleanupSyncFailed && phase === "before_cleanup_directory_sync") {
          cleanupSyncFailed = true;
          throw Object.assign(new Error("injected cleanup fsync EIO"), {
            code: "EIO",
          });
        }
      },
    });
    catalogs.push(catalog);

    await expect(
      catalog.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
        checkpointProjector: allSeatsProjector(),
      }),
    ).rejects.toMatchObject({
      operatorCode: "catalog_admission_cleanup_failed",
    });
    expect(publicationFailed).toBe(true);
    expect(cleanupSyncFailed).toBe(true);
    expect(await fs.readdir(catalog.entriesRoot)).toEqual([]);
    expect(await fs.readdir(catalog.checkpointProjectionStore.root)).toEqual(
      [],
    );
  });

  test("rolls a crash-linked admission and its orphan projection back on catalog startup", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const first = await openCatalog(root);
    catalogs.push(first);
    const record = await first.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
      checkpointProjector: allSeatsProjector(),
    });
    const admissionPath = entryPath(first, record.premiereId);
    const artifactPath = first.checkpointProjectionStore.artifactPath(
      record.premiereId,
      record.recordHash,
    );
    await first.close();
    catalogs.splice(catalogs.indexOf(first), 1);

    const interruptedTemporary = path.join(
      path.dirname(admissionPath),
      `.${record.premiereId}.00000000-0000-4000-8000-000000000003.tmp`,
    );
    await fs.link(admissionPath, interruptedTemporary);
    expect((await fs.lstat(admissionPath)).nlink).toBe(2);

    const recovered = await openCatalog(root);
    catalogs.push(recovered);
    expect((await recovered.readAll()).entries).toEqual([]);
    expect(await fs.lstat(interruptedTemporary).catch(() => null)).toBeNull();
    expect(await fs.lstat(admissionPath).catch(() => null)).toBeNull();
    expect(await fs.lstat(artifactPath).catch(() => null)).toBeNull();

    const retried = await recovered.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
      checkpointProjector: allSeatsProjector(),
    });
    expect((await recovered.readAll()).entries).toEqual([retried]);
    expect(
      (await fs.lstat(entryPath(recovered, retried.premiereId))).nlink,
    ).toBe(1);
  });

  test("removes an orphan projection whose same-id admission has a different record hash", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const first = await openCatalog(root);
    catalogs.push(first);
    const record = await first.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
      checkpointProjector: allSeatsProjector(),
    });
    const original = await readEntryObject(first, PREMIERE_ID);
    const artifactPath = first.checkpointProjectionStore.artifactPath(
      record.premiereId,
      record.recordHash,
    );
    await first.close();
    catalogs.splice(catalogs.indexOf(first), 1);

    await rewriteEntry(first, PREMIERE_ID, {
      ...original,
      admittedAt: "2026-07-20T18:00:00.001Z",
    });
    const replacement = await readEntryObject(first, PREMIERE_ID);
    expect(replacement.recordHash).not.toBe(record.recordHash);
    expect(await fs.lstat(artifactPath)).toBeDefined();

    const recovered = await openCatalog(root);
    catalogs.push(recovered);
    expect(await fs.lstat(artifactPath).catch(() => null)).toBeNull();
    const loaded = await recovered.readAll();
    expect(loaded.failures).toEqual([]);
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0].recordHash).toBe(replacement.recordHash);
  });

  test.each([
    {
      condition: "corrupt JSON",
      operatorCode: "catalog_entry_invalid_json",
      mutate: async (filePath: string, _bytes: Buffer, _root: string) => {
        await fs.chmod(filePath, 0o600);
        await fs.writeFile(filePath, "{\n");
        await fs.chmod(filePath, 0o400);
      },
    },
    {
      condition: "wrong mode",
      operatorCode: "catalog_entry_file_contract_invalid",
      mutate: async (filePath: string) => fs.chmod(filePath, 0o600),
    },
    {
      condition: "symlink",
      operatorCode: "catalog_entry_name_or_type_invalid",
      mutate: async (filePath: string, bytes: Buffer, testRoot: string) => {
        const target = path.join(testRoot, "symlinked-admission-target.json");
        await fs.writeFile(target, bytes, { mode: 0o400 });
        await fs.unlink(filePath);
        await fs.symlink(target, filePath);
      },
    },
  ])(
    "retains a projection and defers $condition admission rejection to readAll",
    async ({ operatorCode, mutate }) => {
      const fixture = await verifiedPublicationFixture(root);
      const first = await openCatalog(root);
      catalogs.push(first);
      const record = await first.writeVerifiedAdmission({
        gate: fixture.gate,
        verification: fixture.verificationOptions,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
        checkpointProjector: allSeatsProjector(),
      });
      const admissionPath = entryPath(first, record.premiereId);
      const admissionBytes = await fs.readFile(admissionPath);
      const artifactPath = first.checkpointProjectionStore.artifactPath(
        record.premiereId,
        record.recordHash,
      );
      await first.close();
      catalogs.splice(catalogs.indexOf(first), 1);

      await mutate(admissionPath, admissionBytes, root);
      const reopened = await openCatalog(root);
      catalogs.push(reopened);

      expect(await fs.lstat(artifactPath)).toBeDefined();
      expect(await reopened.readAll()).toEqual({
        entries: [],
        failures: [
          {
            target: `${PREMIERE_ID}.admission.json`,
            operatorCode,
          },
        ],
      });
    },
  );

  test("recovers complete and incomplete hardlink crash windows under the catalog lock", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const first = await openCatalog(root);
    catalogs.push(first);
    const record = await first.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
      checkpointProjector: allSeatsProjector(),
    });
    const artifactPath = first.checkpointProjectionStore.artifactPath(
      record.premiereId,
      record.recordHash,
    );
    await first.close();
    catalogs.splice(catalogs.indexOf(first), 1);

    const completeTemporary = path.join(
      path.dirname(artifactPath),
      `.${record.premiereId}.00000000-0000-4000-8000-000000000001.tmp`,
    );
    await fs.link(artifactPath, completeTemporary);
    expect((await fs.lstat(artifactPath)).nlink).toBe(2);
    const completedRecovery = await openCatalog(root);
    catalogs.push(completedRecovery);
    expect(await fs.lstat(completeTemporary).catch(() => null)).toBeNull();
    expect((await fs.lstat(artifactPath)).nlink).toBe(1);
    expect(
      await completedRecovery.loadCheckpointProjection({
        record,
        gate: fixture.gate,
      }),
    ).not.toBeNull();
    await completedRecovery.close();
    catalogs.splice(catalogs.indexOf(completedRecovery), 1);

    const incompleteTemporary = path.join(
      path.dirname(artifactPath),
      `.${record.premiereId}.00000000-0000-4000-8000-000000000002.tmp`,
    );
    await fs.chmod(artifactPath, 0o600);
    await fs.link(artifactPath, incompleteTemporary);
    const incompleteRecovery = await openCatalog(root);
    catalogs.push(incompleteRecovery);
    expect(await fs.lstat(incompleteTemporary).catch(() => null)).toBeNull();
    expect(await fs.lstat(artifactPath).catch(() => null)).toBeNull();
    const projection = await allSeatsProjector().project({
      gate: fixture.gate,
      drafts: fixture.verificationOptions.draftChunks,
      signal: new AbortController().signal,
    });
    await incompleteRecovery.publishCheckpointProjection({
      record,
      gate: fixture.gate,
      projection,
    });
    expect((await fs.lstat(artifactPath)).nlink).toBe(1);
    expect((await fs.lstat(artifactPath)).mode & 0o777).toBe(0o400);
  });

  test("serializes a legacy projection publication against a projected admission capacity transaction", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const alternate = alternateAdmission(fixture);
    const sizing = await openCatalog(root);
    catalogs.push(sizing);
    const firstRecord = await sizing.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
    const firstProjection = await allSeatsProjector().project({
      gate: fixture.gate,
      drafts: fixture.verificationOptions.draftChunks,
      signal: new AbortController().signal,
    });
    await sizing.publishCheckpointProjection({
      record: firstRecord,
      gate: fixture.gate,
      projection: firstProjection,
    });
    const secondRecord = await sizing.writeVerifiedAdmission({
      gate: alternate.gate,
      verification: alternate.verification,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
      checkpointProjector: allSeatsProjector(),
    });
    const firstEntryBytes = (await fs.stat(entryPath(sizing, PREMIERE_ID)))
      .size;
    const secondEntryBytes = (
      await fs.stat(entryPath(sizing, secondRecord.premiereId))
    ).size;
    const firstArtifactBytes = (
      await fs.stat(
        sizing.checkpointProjectionStore.artifactPath(
          firstRecord.premiereId,
          firstRecord.recordHash,
        ),
      )
    ).size;
    const secondArtifactBytes = (
      await fs.stat(
        sizing.checkpointProjectionStore.artifactPath(
          secondRecord.premiereId,
          secondRecord.recordHash,
        ),
      )
    ).size;
    await sizing.close();
    catalogs.splice(catalogs.indexOf(sizing), 1);
    await fs.rm(path.join(root, "private", "catalog-v1"), {
      recursive: true,
      force: true,
    });

    const maxTotalEntryBytes =
      firstEntryBytes +
      Math.max(firstArtifactBytes, secondEntryBytes + secondArtifactBytes);
    const bounded = await ReplayPremiereAdmissionCatalog.open({
      statfs: AMPLE_DISK,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      limits: {
        maxEntries: 2,
        maxEntryBytes: Math.max(firstEntryBytes, secondEntryBytes),
        maxTotalEntryBytes,
        maxSourceBytes: 256 * 1024 * 1024,
        maxAuthoritativeResultBytes: 2 * 1024 * 1024,
      },
    });
    catalogs.push(bounded);
    const legacyRecord = await bounded.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });

    const settled = await Promise.allSettled([
      bounded.publishCheckpointProjection({
        record: legacyRecord,
        gate: fixture.gate,
        projection: firstProjection,
      }),
      bounded.writeVerifiedAdmission({
        gate: alternate.gate,
        verification: alternate.verification,
        chunkBuildLimits: CHUNK_LIMITS,
        collectorLimits: COLLECTOR_LIMITS,
        checkpointProjector: allSeatsProjector(),
      }),
    ]);

    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        settled.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult
      ).reason,
    ).toMatchObject({ operatorCode: "catalog_total_byte_ceiling_exceeded" });
    const entryNames = await fs.readdir(bounded.entriesRoot);
    const artifactNames = await fs.readdir(
      bounded.checkpointProjectionStore.root,
    );
    expect(entryNames.some((name) => name.startsWith("."))).toBe(false);
    expect(artifactNames.some((name) => name.startsWith("."))).toBe(false);
    const totalBytes = (
      await Promise.all(
        [
          ...entryNames.map((name) => path.join(bounded.entriesRoot, name)),
          ...artifactNames.map((name) =>
            path.join(bounded.checkpointProjectionStore.root, name),
          ),
        ].map(async (filePath) => (await fs.stat(filePath)).size),
      )
    ).reduce((sum, size) => sum + size, 0);
    expect(totalBytes).toBeLessThanOrEqual(maxTotalEntryBytes);
    expect(artifactNames).toHaveLength(1);
  });

  test("serializes a closed startup projection load and publish behind an active catalog writer", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const startupCatalog = await openCatalog(root);
    catalogs.push(startupCatalog);
    const record = await startupCatalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
    const projection = await allSeatsProjector().project({
      gate: fixture.gate,
      drafts: fixture.verificationOptions.draftChunks,
      signal: new AbortController().signal,
    });
    await startupCatalog.close();
    catalogs.splice(catalogs.indexOf(startupCatalog), 1);

    const activeWriter = await openCatalog(root);
    catalogs.push(activeWriter);
    let loadSettled = false;
    const load = startupCatalog
      .loadCheckpointProjection({ record, gate: fixture.gate })
      .finally(() => {
        loadSettled = true;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(loadSettled).toBe(false);
    await activeWriter.close();
    catalogs.splice(catalogs.indexOf(activeWriter), 1);
    expect(await load).toBeNull();

    const secondWriter = await openCatalog(root);
    catalogs.push(secondWriter);
    let publishSettled = false;
    const publish = startupCatalog
      .publishCheckpointProjection({
        record,
        gate: fixture.gate,
        projection,
      })
      .finally(() => {
        publishSettled = true;
      });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(publishSettled).toBe(false);
    await secondWriter.close();
    catalogs.splice(catalogs.indexOf(secondWriter), 1);
    const artifact = await publish;
    expect(artifact.admissionRecordHash).toBe(record.recordHash);

    const verify = await openCatalog(root);
    catalogs.push(verify);
    expect(
      await verify.loadCheckpointProjection({
        record,
        gate: fixture.gate,
      }),
    ).toEqual(artifact);
    expect((await verify.readAll()).entries).toEqual([record]);
  });

  test("rejects symlink, hardlink, mode, and owner violations", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const catalog = await openCatalog(root);
    catalogs.push(catalog);
    await catalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
    const original = entryPath(catalog, PREMIERE_ID);
    const symlinkName = "prem_aaaaaaaaaaaaaaaa";
    await fs.symlink(original, entryPath(catalog, symlinkName));
    let loaded = await catalog.readAll();
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.failures).toContainEqual({
      target: `${symlinkName}.admission.json`,
      operatorCode: "catalog_entry_name_or_type_invalid",
    });
    await fs.unlink(entryPath(catalog, symlinkName));

    const hardlinkName = "prem_bbbbbbbbbbbbbbbb";
    await fs.link(original, entryPath(catalog, hardlinkName));
    loaded = await catalog.readAll();
    expect(loaded.entries).toEqual([]);
    expect(loaded.failures).toHaveLength(2);
    expect(
      loaded.failures.every(
        (failure) =>
          failure.operatorCode === "catalog_entry_file_contract_invalid",
      ),
    ).toBe(true);
    await fs.unlink(entryPath(catalog, hardlinkName));

    await fs.chmod(original, 0o600);
    loaded = await catalog.readAll();
    expect(loaded.entries).toEqual([]);
    expect(loaded.failures[0].operatorCode).toBe(
      "catalog_entry_file_contract_invalid",
    );
    await fs.chmod(original, 0o400);

    const actualUid = process.getuid?.();
    if (actualUid !== undefined) {
      vi.spyOn(process, "getuid").mockReturnValue(actualUid + 1);
      loaded = await catalog.readAll();
      expect(loaded.entries).toEqual([]);
      expect(loaded.failures[0].operatorCode).toBe(
        "catalog_entry_file_contract_invalid",
      );
    }
  });

  test("rejects traversal, unknown keys, record-hash drift, and result-hash drift", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const catalog = await openCatalog(root);
    catalogs.push(catalog);
    await catalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
    const original = await readEntryObject(catalog, PREMIERE_ID);

    await rewriteEntry(catalog, PREMIERE_ID, {
      ...original,
      stagedSource: {
        ...(original.stagedSource as Record<string, unknown>),
        relativePath: "../outside.replay",
      },
    });
    expect((await catalog.readAll()).failures[0].operatorCode).toBe(
      "catalog_source_contract_invalid",
    );

    await rewriteEntry(catalog, PREMIERE_ID, {
      ...original,
      unexpectedField: "rejected",
    });
    expect((await catalog.readAll()).failures[0].operatorCode).toBe(
      "catalog_unknown_or_missing_fields",
    );

    await writeEntryObject(catalog, PREMIERE_ID, {
      ...original,
      recordHash: "0".repeat(64),
    });
    expect((await catalog.readAll()).failures[0].operatorCode).toBe(
      "catalog_entry_contract_invalid",
    );

    await rewriteEntry(catalog, PREMIERE_ID, {
      ...original,
      authoritativeResult: {
        ...(original.authoritativeResult as Record<string, unknown>),
        sha256: "a".repeat(64),
      },
    });
    expect((await catalog.readAll()).failures[0].operatorCode).toBe(
      "catalog_result_contract_invalid",
    );
  });

  test("bounds entry count and individual entry bytes before parsing", async () => {
    const catalog = await ReplayPremiereAdmissionCatalog.open({
      statfs: AMPLE_DISK,
      privateStateRoot: path.join(root, "private"),
      servedRoots: [path.join(root, "served")],
      limits: {
        maxEntries: 1,
        maxEntryBytes: 100,
        maxTotalEntryBytes: 1_000,
        maxSourceBytes: 1_000,
        maxAuthoritativeResultBytes: 1_000,
      },
    });
    catalogs.push(catalog);
    await writeOpaqueEntry(catalog.entriesRoot, "prem_aaaaaaaaaaaaaaaa", 101);
    const loaded = await catalog.readAll();
    expect(loaded.entries).toEqual([]);
    expect(loaded.failures[0].operatorCode).toBe(
      "catalog_entry_file_contract_invalid",
    );
    await fs.unlink(entryPath(catalog, "prem_aaaaaaaaaaaaaaaa"));
    await Promise.all([
      writeOpaqueEntry(catalog.entriesRoot, "prem_aaaaaaaaaaaaaaaa", 10),
      writeOpaqueEntry(catalog.entriesRoot, "prem_bbbbbbbbbbbbbbbb", 10),
    ]);
    await expect(catalog.readAll()).rejects.toMatchObject({
      operatorCode: "catalog_entry_count_ceiling_exceeded",
    });
  });

  test("quarantines partial temp residue while retaining a valid admission", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const catalog = await openCatalog(root);
    catalogs.push(catalog);
    await catalog.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
    await fs.writeFile(path.join(catalog.entriesRoot, ".partial.tmp"), "{", {
      mode: 0o400,
    });

    const loaded = await catalog.readAll();

    expect(loaded.entries).toHaveLength(1);
    expect(loaded.failures).toEqual([
      {
        target: ".partial.tmp",
        operatorCode: "catalog_entry_name_or_type_invalid",
      },
    ]);
  });

  test("reopens after a clean lock release and retains the immutable entry", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const first = await openCatalog(root);
    catalogs.push(first);
    const written = await first.writeVerifiedAdmission({
      gate: fixture.gate,
      verification: fixture.verificationOptions,
      chunkBuildLimits: CHUNK_LIMITS,
      collectorLimits: COLLECTOR_LIMITS,
    });
    await first.close();
    catalogs.splice(catalogs.indexOf(first), 1);

    const restarted = await openCatalog(root);
    catalogs.push(restarted);

    expect(await restarted.readAll()).toEqual({
      entries: [written],
      failures: [],
    });
  });

  test("retains a valid stale writer lock before reacquiring ownership", async () => {
    const first = await openCatalog(root);
    catalogs.push(first);
    const catalogRoot = first.catalogRoot;
    await first.close();
    catalogs.splice(catalogs.indexOf(first), 1);
    const lockPath = path.join(catalogRoot, "write-owner.json");
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_647,
        writerId: "00000000-0000-4000-8000-000000000000",
        acquiredAt: "2026-07-20T18:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );

    const restarted = await openCatalog(root);
    catalogs.push(restarted);

    const recoveryEntries = await fs.readdir(
      path.join(catalogRoot, "recovery"),
    );
    expect(recoveryEntries).toHaveLength(1);
    expect(recoveryEntries[0]).toMatch(/^stale-write-owner-/);
  });

  test("rejects a symlinked catalog directory before hardening or locking", async () => {
    const privateRoot = path.join(root, "private");
    const servedRoot = path.join(root, "served");
    const outside = path.join(root, "outside");
    await Promise.all([
      fs.mkdir(privateRoot, { mode: 0o700 }),
      fs.mkdir(servedRoot, { mode: 0o700 }),
      fs.mkdir(outside, { mode: 0o700 }),
    ]);
    await fs.symlink(outside, path.join(privateRoot, "catalog-v1"));

    await expect(
      ReplayPremiereAdmissionCatalog.open({
        statfs: AMPLE_DISK,
        privateStateRoot: privateRoot,
        servedRoots: [servedRoot],
      }),
    ).rejects.toMatchObject({
      operatorCode: "catalog_directory_not_private",
    });
    expect(await fs.readdir(outside)).toEqual([]);
  });
});

function allSeatsProjector(): ReplayPremiereCheckpointProjector {
  return {
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
  };
}

async function openCatalog(
  root: string,
): Promise<ReplayPremiereAdmissionCatalog> {
  return ReplayPremiereAdmissionCatalog.open({
    statfs: AMPLE_DISK,
    privateStateRoot: path.join(root, "private"),
    servedRoots: [path.join(root, "served")],
  });
}

async function writeOpaqueEntry(
  entriesRoot: string,
  premiereId: string,
  bytes: number,
): Promise<void> {
  await fs.writeFile(
    path.join(entriesRoot, `${premiereId}.admission.json`),
    "x".repeat(bytes),
    { mode: 0o400 },
  );
}

async function writeSparseCatalogBytes(
  entriesRoot: string,
  totalBytes: number,
): Promise<void> {
  let remaining = totalBytes;
  let index = 0;
  while (remaining > 0) {
    const entryBytes = Math.min(
      remaining,
      DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS.maxEntryBytes,
    );
    const premiereId = `prem_${(0xf000000000000000n + BigInt(index)).toString(
      16,
    )}`;
    const file = await fs.open(
      entryPathFromRoot(entriesRoot, premiereId),
      "wx",
      0o600,
    );
    try {
      await file.truncate(entryBytes);
    } finally {
      await file.close();
    }
    await fs.chmod(entryPathFromRoot(entriesRoot, premiereId), 0o400);
    remaining -= entryBytes;
    index += 1;
  }
}

function entryPathFromRoot(entriesRoot: string, premiereId: string): string {
  return path.join(entriesRoot, `${premiereId}.admission.json`);
}

async function catalogEntryBytes(entriesRoot: string): Promise<number> {
  const entries = await fs.readdir(entriesRoot);
  return (
    await Promise.all(
      entries.map(
        async (entry) => (await fs.lstat(path.join(entriesRoot, entry))).size,
      ),
    )
  ).reduce((total, bytes) => total + bytes, 0);
}

function entryPath(
  catalog: ReplayPremiereAdmissionCatalog,
  premiereId: string,
): string {
  return path.join(catalog.entriesRoot, `${premiereId}.admission.json`);
}

async function readEntryObject(
  catalog: ReplayPremiereAdmissionCatalog,
  premiereId: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(entryPath(catalog, premiereId), "utf8"),
  ) as Record<string, unknown>;
}

async function rewriteEntry(
  catalog: ReplayPremiereAdmissionCatalog,
  premiereId: string,
  value: Record<string, unknown>,
): Promise<void> {
  const { recordHash: _recordHash, ...preimage } = value;
  await writeEntryObject(catalog, premiereId, {
    ...preimage,
    recordHash: hashReplayPremiereJson(
      preimage as unknown as ReplayPremiereJsonValue,
    ),
  });
}

async function writeEntryObject(
  catalog: ReplayPremiereAdmissionCatalog,
  premiereId: string,
  value: Record<string, unknown>,
): Promise<void> {
  const filePath = entryPath(catalog, premiereId);
  await fs.chmod(filePath, 0o600);
  await fs.writeFile(
    filePath,
    `${canonicalReplayPremiereJson(
      value as unknown as ReplayPremiereJsonValue,
    )}\n`,
  );
  await fs.chmod(filePath, 0o400);
}

function alternateAdmission(
  fixture: Awaited<ReturnType<typeof verifiedPublicationFixture>>,
): {
  gate: VerifiedPremiereEligibilityGate;
  verification: Parameters<typeof VerifiedPremiereEligibilityGate.verify>[0];
} {
  const premiereId = "prem_fedcba9876543210";
  const imported = importControlledPremiereSourceForPublication({
    sourceBytes: fixture.verificationOptions.verifiedSource.copyBytes(),
    eligibilityRecord: fixture.verificationOptions.eligibilityRecord,
    authoritativeResultBytes:
      fixture.verificationOptions.authoritativeResultBytes,
    replayImportLimits: fixture.verificationOptions.replayImportLimits,
  });
  const drafts = buildPremiereChunks({
    premiereId,
    records: imported.records,
    playbackRate: fixture.verificationOptions.publicDefinition.playbackRate,
    checkpointSequences:
      fixture.verificationOptions.publicDefinition.checkpoints.map(
        (checkpoint) => checkpoint.sequence,
      ),
    ...CHUNK_LIMITS,
  });
  const verification = {
    ...fixture.verificationOptions,
    premiereId,
    draftChunks: drafts,
  };
  return {
    gate: VerifiedPremiereEligibilityGate.verify(verification),
    verification,
  };
}
