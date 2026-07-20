import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  readAdmissionVerifiedSource,
  ReplayPremiereAdmissionCatalog,
  type ReplayPremiereAdmissionRecordV1,
} from "../../../src/server/replay-premiere/ReplayPremiereCatalog";
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

  test("serializes concurrent admissions across the entry-count ceiling", async () => {
    const fixture = await verifiedPublicationFixture(root);
    const alternate = alternateAdmission(fixture);
    const catalog = await ReplayPremiereAdmissionCatalog.open({
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
        privateStateRoot: privateRoot,
        servedRoots: [servedRoot],
      }),
    ).rejects.toMatchObject({
      operatorCode: "catalog_directory_not_private",
    });
    expect(await fs.readdir(outside)).toEqual([]);
  });
});

async function openCatalog(
  root: string,
): Promise<ReplayPremiereAdmissionCatalog> {
  return ReplayPremiereAdmissionCatalog.open({
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
