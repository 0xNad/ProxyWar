import { randomUUID } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import type { ReplayPremiereCheckpointProjector } from "./ReplayPremiereCheckpointProjection";
import {
  ReplayPremiereCheckpointProjectionStore,
  type ReplayPremiereCheckpointProjectionAdmissionBinding,
  type ReplayPremiereCheckpointProjectionArtifactV1,
  type ReplayPremiereCheckpointProjectionPublicationFaultInjector,
} from "./ReplayPremiereCheckpointProjectionStore";
import {
  buildPremiereChunks,
  type BuildPremiereChunksOptions,
} from "./ReplayPremiereChunks";
import {
  isPremiereId,
  type PremiereEligibility,
  type StagedPremiereSource,
} from "./ReplayPremiereContracts";
import type { PremiereEligibilityAssessmentOptions } from "./ReplayPremiereEligibility";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import type { PremiereReplayImportLimits } from "./ReplayPremiereImport";
import {
  assertReplayPremiereJsonValue,
  canonicalReplayPremiereJson,
  cloneAndFreezeReplayPremiereValue,
  hashReplayPremiereJson,
  isSha256Hex,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import {
  validateReplayPremiereLeakAuditCollectorLimits,
  VerifiedReplayPremiereLeakAuditReceipt,
  type ReplayPremiereLeakAuditCollectorLimits,
  type ReplayPremiereLeakAuditReceiptMaterial,
} from "./ReplayPremiereLeakAuditCollector";
import {
  assertPremiereDurableWriteAdmission,
  readVerifiedStagedPremiereSource,
  validatePremierePrivateLayout,
  type VerifiedStagedPremiereSourceBytes,
} from "./ReplayPremierePrivateStaging";
import {
  importControlledPremiereSourceForPublication,
  replayPremiereDraftChunksMatch,
  VerifiedPremiereEligibilityGate,
  type PremierePublicDefinition,
  type VerifyPremierePublicationOptions,
} from "./ReplayPremierePublication";

const CATALOG_KIND = "replay_premiere_admission_v1" as const;
const CATALOG_DIRECTORY = "catalog-v1";
const ENTRY_DIRECTORY = "entries";
const ENTRY_SUFFIX = ".admission.json";
const MAX_CATALOG_LOCK_BYTES = 4_096;
const MAX_DIAGNOSTIC_TARGET_BYTES = 160;
const MAX_CATALOG_WRITER_WAIT_MS = 10_000;
const SAFE_DIAGNOSTIC_TARGET = /^[A-Za-z0-9._-]+$/;
const activeCatalogRoots = new Set<string>();

export interface ReplayPremiereAdmissionAssessmentV1 {
  assessedAt: string;
  maxLeakCheckAgeMs: number;
  maxExternalEvidenceAgeMs: number;
  maxObservedBodyBytes: number;
  maxFutureClockSkewMs: number | null;
  privateCommitmentNonceBase64: string;
}

export interface ReplayPremiereAdmissionSourceV1 {
  relativePath: string;
  sourceReplaySha256: string;
  byteLength: number;
}

export interface ReplayPremiereAdmissionResultV1 {
  sourceId: string;
  encoding: "base64";
  bytes: string;
  sha256: string;
}

export type ReplayPremiereChunkBuildLimits = Pick<
  BuildPremiereChunksOptions,
  | "maxChunkBytes"
  | "maxTotalBytes"
  | "maxRecordsPerChunk"
  | "maxPresentationSpanMs"
>;

interface ReplayPremiereAdmissionRecordPreimageV1 {
  schemaVersion: 1;
  admissionKind: typeof CATALOG_KIND;
  premiereId: string;
  admittedAt: string;
  stagedSource: ReplayPremiereAdmissionSourceV1;
  eligibilityRecord: PremiereEligibility;
  assessment: ReplayPremiereAdmissionAssessmentV1;
  leakAuditReceipt: ReplayPremiereLeakAuditReceiptMaterial;
  authoritativeResult: ReplayPremiereAdmissionResultV1;
  publicDefinition: PremierePublicDefinition;
  replayImportLimits: PremiereReplayImportLimits;
  chunkBuildLimits: ReplayPremiereChunkBuildLimits;
  collectorLimits: ReplayPremiereLeakAuditCollectorLimits;
  expectedEligibilityRecordHash: string;
  expectedPublicationCommitmentHash: string;
  expectedOrderedDraftManifestRoot: string;
}

export interface ReplayPremiereAdmissionRecordV1 extends ReplayPremiereAdmissionRecordPreimageV1 {
  recordHash: string;
}

export interface ReplayPremiereCatalogLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalEntryBytes: number;
  maxSourceBytes: number;
  maxAuthoritativeResultBytes: number;
}

export const DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS: ReplayPremiereCatalogLimits =
  Object.freeze({
    maxEntries: 128,
    maxEntryBytes: 8 * 1024 * 1024,
    maxTotalEntryBytes: 64 * 1024 * 1024,
    maxSourceBytes: 256 * 1024 * 1024,
    maxAuthoritativeResultBytes: 2 * 1024 * 1024,
  });

export interface ReplayPremiereCatalogFailure {
  target: string;
  operatorCode: string;
}

export interface ReplayPremiereCatalogReadResult {
  entries: ReplayPremiereAdmissionRecordV1[];
  failures: ReplayPremiereCatalogFailure[];
}

export type ReplayPremiereAdmissionPublicationPhase =
  | "after_temporary_write"
  | "after_temporary_sync"
  | "after_temporary_close"
  | "after_admission_link"
  | "after_admission_chmod"
  | "after_temporary_unlink"
  | "after_directory_sync"
  | "before_cleanup_admission_unlink"
  | "before_cleanup_temporary_unlink"
  | "before_cleanup_directory_sync"
  | "before_rollback_absence_stat"
  | "before_rollback_absence_sync";

/** Test-only fault seam around admission-record durability boundaries. */
export type ReplayPremiereAdmissionPublicationFaultInjector = (
  phase: ReplayPremiereAdmissionPublicationPhase,
) => void | Promise<void>;

export interface ReplayPremiereAdmissionWriteOptions {
  gate: VerifiedPremiereEligibilityGate;
  verification: VerifyPremierePublicationOptions;
  chunkBuildLimits: ReplayPremiereChunkBuildLimits;
  collectorLimits: ReplayPremiereLeakAuditCollectorLimits;
  /** New production admissions provide this; omission creates a legacy record. */
  checkpointProjector?: ReplayPremiereCheckpointProjector;
  checkpointProjectionSignal?: AbortSignal;
  /** Test/operator seam after durable artifact publication, before visibility. */
  afterCheckpointProjectionPublished?: (
    artifact: ReplayPremiereCheckpointProjectionArtifactV1,
  ) => void | Promise<void>;
}

export class ReplayPremiereAdmissionCatalog {
  readonly privateStateRoot: string;
  readonly catalogRoot: string;
  readonly entriesRoot: string;
  readonly checkpointProjectionStore: ReplayPremiereCheckpointProjectionStore;
  private readonly servedRoots: readonly string[];
  private readonly limits: ReplayPremiereCatalogLimits;
  private readonly lockPath: string;
  private readonly writerId: string;
  private readonly admissionPublicationFaultInjector?: ReplayPremiereAdmissionPublicationFaultInjector;
  private readonly checkpointProjectionPublicationFaultInjector?: ReplayPremiereCheckpointProjectionPublicationFaultInjector;
  private readonly statfs?: typeof fs.statfs;
  private closed = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private postCloseProjectionQueue: Promise<void> = Promise.resolve();

  private constructor(options: {
    privateStateRoot: string;
    catalogRoot: string;
    entriesRoot: string;
    checkpointProjectionStore: ReplayPremiereCheckpointProjectionStore;
    servedRoots: readonly string[];
    limits: ReplayPremiereCatalogLimits;
    lockPath: string;
    writerId: string;
    admissionPublicationFaultInjector?: ReplayPremiereAdmissionPublicationFaultInjector;
    checkpointProjectionPublicationFaultInjector?: ReplayPremiereCheckpointProjectionPublicationFaultInjector;
    statfs?: typeof fs.statfs;
  }) {
    this.privateStateRoot = options.privateStateRoot;
    this.catalogRoot = options.catalogRoot;
    this.entriesRoot = options.entriesRoot;
    this.checkpointProjectionStore = options.checkpointProjectionStore;
    this.servedRoots = options.servedRoots;
    this.limits = options.limits;
    this.lockPath = options.lockPath;
    this.writerId = options.writerId;
    this.admissionPublicationFaultInjector =
      options.admissionPublicationFaultInjector;
    this.checkpointProjectionPublicationFaultInjector =
      options.checkpointProjectionPublicationFaultInjector;
    this.statfs = options.statfs;
  }

  static async open(options: {
    privateStateRoot: string;
    servedRoots: readonly string[];
    limits?: ReplayPremiereCatalogLimits;
    /** Bounded canonical-lock contention wait; fail-fast remains the default. */
    writerWaitMs?: number;
    /** Test-only failure injection at projection-artifact durability seams. */
    checkpointProjectionPublicationFaultInjector?: ReplayPremiereCheckpointProjectionPublicationFaultInjector;
    /** Test-only failure injection at admission-record durability seams. */
    admissionPublicationFaultInjector?: ReplayPremiereAdmissionPublicationFaultInjector;
    /**
     * Free-space probe for the durable-write floor. Production omits it and
     * gets the real `fs.statfs`; tests inject so a suite asserts catalog
     * behaviour rather than the host machine's spare capacity. Staging, the
     * event store and clips already expose this seam — the catalog and the
     * projection store were the outliers, which is why a full host turned
     * their suites red wholesale on 2026-08-19.
     */
    statfs?: typeof fs.statfs;
  }): Promise<ReplayPremiereAdmissionCatalog> {
    const limits = validateCatalogLimits(
      options.limits ?? DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS,
    );
    const writerWaitMs = validateCatalogWriterWaitMs(options.writerWaitMs);
    const layout = await validatePremierePrivateLayout(options);
    const canonicalCatalogRoot = await ensurePrivateDirectory(
      path.join(layout.privateStateRoot, CATALOG_DIRECTORY),
      layout.privateStateRoot,
    );
    const entriesRoot = await ensurePrivateDirectory(
      path.join(canonicalCatalogRoot, ENTRY_DIRECTORY),
      canonicalCatalogRoot,
    );
    const recoveryRoot = await ensurePrivateDirectory(
      path.join(canonicalCatalogRoot, "recovery"),
      canonicalCatalogRoot,
    );
    const checkpointProjectionStore =
      await ReplayPremiereCheckpointProjectionStore.open({
        catalogRoot: canonicalCatalogRoot,
        catalogEntriesRoot: entriesRoot,
        maxTotalBytes: limits.maxTotalEntryBytes,
        publicationFaultInjector:
          options.checkpointProjectionPublicationFaultInjector,
        statfs: options.statfs,
      });
    const lockPath = path.join(canonicalCatalogRoot, "write-owner.json");
    const writerId = randomUUID();
    await acquireCatalogLockWithWait({
      catalogRoot: canonicalCatalogRoot,
      lockPath,
      recoveryRoot,
      writerId,
      writerWaitMs,
    });
    activeCatalogRoots.add(canonicalCatalogRoot);
    try {
      await recoverInterruptedAdmissionPublications(entriesRoot);
      await checkpointProjectionStore.recoverInterruptedPublications();
      await checkpointProjectionStore.removeOrphanArtifacts({
        admissionBinding: (premiereId) =>
          readCheckpointProjectionAdmissionBinding({
            entriesRoot,
            premiereId,
            maxEntryBytes: limits.maxEntryBytes,
          }),
      });
      return new ReplayPremiereAdmissionCatalog({
        privateStateRoot: layout.privateStateRoot,
        catalogRoot: canonicalCatalogRoot,
        entriesRoot,
        checkpointProjectionStore,
        servedRoots: layout.servedRoots,
        limits,
        lockPath,
        writerId,
        admissionPublicationFaultInjector:
          options.admissionPublicationFaultInjector,
        checkpointProjectionPublicationFaultInjector:
          options.checkpointProjectionPublicationFaultInjector,
        statfs: options.statfs,
      });
    } catch (error) {
      activeCatalogRoots.delete(canonicalCatalogRoot);
      await releaseCatalogLock(lockPath, writerId);
      throw error;
    }
  }

  async readAll(): Promise<ReplayPremiereCatalogReadResult> {
    this.assertOpen();
    const directoryEntries = await fs.readdir(this.entriesRoot, {
      withFileTypes: true,
    });
    if (directoryEntries.length > this.limits.maxEntries) {
      throw catalogCapacity("catalog_entry_count_ceiling_exceeded");
    }
    let catalogBytes = 0;
    for (const entry of directoryEntries) {
      const stat = await fs.lstat(path.join(this.entriesRoot, entry.name));
      catalogBytes += stat.size;
      if (catalogBytes > this.limits.maxTotalEntryBytes) {
        throw catalogCapacity("catalog_total_byte_ceiling_exceeded");
      }
    }
    const records: ReplayPremiereAdmissionRecordV1[] = [];
    const failures: ReplayPremiereCatalogFailure[] = [];
    for (const entry of directoryEntries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const target = catalogDiagnosticTarget(entry.name);
      try {
        if (!entry.isFile() || !entry.name.endsWith(ENTRY_SUFFIX)) {
          throw catalogIntegrity("catalog_entry_name_or_type_invalid");
        }
        const expectedPremiereId = entry.name.slice(0, -ENTRY_SUFFIX.length);
        if (!isPremiereId(expectedPremiereId)) {
          throw catalogIntegrity("catalog_entry_filename_invalid");
        }
        const read = await readBoundedCatalogFile(
          path.join(this.entriesRoot, entry.name),
          this.limits.maxEntryBytes,
        );
        const record = parseAdmissionRecord(read);
        if (record.premiereId !== expectedPremiereId) {
          throw catalogIntegrity("catalog_filename_premiere_mismatch");
        }
        if (record.stagedSource.byteLength > this.limits.maxSourceBytes) {
          throw catalogCapacity("catalog_source_byte_ceiling_exceeded");
        }
        if (
          Buffer.from(record.authoritativeResult.bytes, "base64").byteLength >
          this.limits.maxAuthoritativeResultBytes
        ) {
          throw catalogCapacity("catalog_result_byte_ceiling_exceeded");
        }
        records.push(record);
      } catch (error) {
        failures.push({
          target,
          operatorCode: operatorCode(error, "catalog_entry_rejected"),
        });
      }
    }
    const duplicateIds = duplicates(records.map((record) => record.premiereId));
    const duplicateCommitments = duplicates(
      records.map((record) => record.expectedPublicationCommitmentHash),
    );
    const accepted: ReplayPremiereAdmissionRecordV1[] = [];
    for (const record of records) {
      if (
        duplicateIds.has(record.premiereId) ||
        duplicateCommitments.has(record.expectedPublicationCommitmentHash)
      ) {
        const error = catalogIntegrity("catalog_duplicate_identity");
        failures.push({
          target: `${record.premiereId}${ENTRY_SUFFIX}`,
          operatorCode: error.operatorCode,
        });
      } else {
        accepted.push(record);
      }
    }
    // 2026-07-22 PRODUCTION OUTAGE (round-649 boot crash): this return used to
    // be `immutable({entries, failures})`, which canonicalizes EVERY accepted
    // admission again under ONE shared 100k-node budget. Each record is
    // individually bounded (per-entry canonicalize + clone + freeze inside
    // parseAdmissionRecord, within the per-entry try/catch above), but the
    // catalog accumulates admissions (~7.6k nodes each), so the 16th admission
    // pushed the AGGREGATE over the ceiling — an uncaught
    // json_complexity_exceeded from a fully valid catalog, before the event
    // store's writer lock existed, crash-looping every boot. The aggregate is
    // therefore assembled from the already-validated, already-frozen records
    // with plain container freezing: no shared canonicalize budget exists at
    // any catalog size (maxEntries caps the count; per-record ceilings still
    // guard every trust boundary).
    for (const failure of failures) Object.freeze(failure);
    Object.freeze(accepted);
    Object.freeze(failures);
    return Object.freeze({ entries: accepted, failures });
  }

  async writeVerifiedAdmission(
    options: ReplayPremiereAdmissionWriteOptions,
  ): Promise<ReplayPremiereAdmissionRecordV1> {
    this.assertOpen();
    const record = await createAdmissionRecord({
      ...options,
      privateStateRoot: this.privateStateRoot,
      servedRoots: this.servedRoots,
      limits: this.limits,
    });
    const bytes = Buffer.from(
      `${canonicalReplayPremiereJson(asJson(record))}\n`,
      "utf8",
    );
    if (bytes.byteLength > this.limits.maxEntryBytes) {
      throw catalogCapacity("catalog_entry_byte_ceiling_exceeded");
    }
    const projection =
      options.checkpointProjector === undefined
        ? null
        : await options.checkpointProjector.project({
            gate: options.gate,
            drafts: options.verification.draftChunks,
            signal:
              options.checkpointProjectionSignal ??
              new AbortController().signal,
          });
    assertCheckpointProjectionSignalActive(options.checkpointProjectionSignal);
    return this.runExclusive(async () => {
      assertCheckpointProjectionSignalActive(
        options.checkpointProjectionSignal,
      );
      await recoverInterruptedAdmissionPublications(this.entriesRoot);
      const destination = path.join(
        this.entriesRoot,
        `${record.premiereId}${ENTRY_SUFFIX}`,
      );
      let admissionAlreadyExists = false;
      try {
        const existing = await readBoundedCatalogFile(
          destination,
          this.limits.maxEntryBytes,
        );
        if (!Buffer.from(existing).equals(bytes)) {
          throw catalogIntegrity("catalog_admission_is_immutable");
        }
        admissionAlreadyExists = true;
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
      let publishedArtifact:
        | {
            artifact: ReplayPremiereCheckpointProjectionArtifactV1;
            created: boolean;
          }
        | undefined;
      try {
        if (!admissionAlreadyExists) {
          await this.assertWriteCapacity({
            pendingBytes: bytes.byteLength,
            pendingEntries: 1,
          });
        }
        if (projection !== null) {
          publishedArtifact = await this.checkpointProjectionStore.publish({
            record,
            gate: options.gate,
            projection,
            beforePublish: (artifactBytes) =>
              this.assertWriteCapacity({
                pendingBytes:
                  artifactBytes +
                  (admissionAlreadyExists ? 0 : bytes.byteLength),
                pendingEntries: admissionAlreadyExists ? 0 : 1,
              }),
          });
          await options.afterCheckpointProjectionPublished?.(
            publishedArtifact.artifact,
          );
          assertCheckpointProjectionSignalActive(
            options.checkpointProjectionSignal,
          );
        }
        if (admissionAlreadyExists) return record;
        await assertPremiereDurableWriteAdmission({
          destinationPath: this.entriesRoot,
          pendingBytes: bytes.byteLength,
          statfs: this.statfs,
        });
        assertCheckpointProjectionSignalActive(
          options.checkpointProjectionSignal,
        );
        await this.publishAdmissionRecord({
          record,
          bytes,
          destination,
          signal: options.checkpointProjectionSignal,
        });
        return record;
      } catch (error) {
        if (publishedArtifact !== undefined && !admissionAlreadyExists) {
          const commitState = await this.resolveAdmissionCommitState({
            record,
            gate: options.gate,
            artifact: publishedArtifact.artifact,
            destination,
          });
          if (commitState === "committed") {
            // Publication completed durably even though its cleanup/reporting
            // path failed. Adopt the exact transaction instead of reporting a
            // failure that would let the league release sealed evidence.
            return record;
          }
          if (commitState === "absent" && publishedArtifact.created) {
            try {
              await this.checkpointProjectionStore.removePublishedArtifact({
                record,
                gate: options.gate,
                artifact: publishedArtifact.artifact,
              });
            } catch (cleanupError) {
              throw catalogIntegrity(
                "catalog_projection_rollback_failed",
                new AggregateError(
                  [error, cleanupError],
                  "admission publication and projection rollback failed",
                ),
              );
            }
          }
          if (commitState === "uncertain") {
            throw catalogIntegrity(
              "catalog_admission_commit_state_uncertain",
              error,
            );
          }
        }
        throw error;
      }
    });
  }

  async loadCheckpointProjection(options: {
    record: ReplayPremiereAdmissionRecordV1;
    gate: VerifiedPremiereEligibilityGate;
  }): Promise<ReplayPremiereCheckpointProjectionArtifactV1 | null> {
    if (this.closed) {
      return this.runPostCloseProjectionExclusive(async () => {
        const catalog = await ReplayPremiereAdmissionCatalog.open({
          privateStateRoot: this.privateStateRoot,
          servedRoots: this.servedRoots,
          limits: this.limits,
          writerWaitMs: 1_000,
          checkpointProjectionPublicationFaultInjector:
            this.checkpointProjectionPublicationFaultInjector,
        });
        try {
          return await catalog.loadCheckpointProjection(options);
        } finally {
          await catalog.close();
        }
      });
    }
    await this.assertExactAdmissionPresent(options.record);
    return this.checkpointProjectionStore.load(options);
  }

  async publishCheckpointProjection(options: {
    record: ReplayPremiereAdmissionRecordV1;
    gate: VerifiedPremiereEligibilityGate;
    projection: Awaited<
      ReturnType<ReplayPremiereCheckpointProjector["project"]>
    >;
  }): Promise<ReplayPremiereCheckpointProjectionArtifactV1> {
    if (this.closed) {
      return this.runPostCloseProjectionExclusive(async () => {
        const catalog = await ReplayPremiereAdmissionCatalog.open({
          privateStateRoot: this.privateStateRoot,
          servedRoots: this.servedRoots,
          limits: this.limits,
          writerWaitMs: 1_000,
          checkpointProjectionPublicationFaultInjector:
            this.checkpointProjectionPublicationFaultInjector,
        });
        try {
          return await catalog.publishCheckpointProjection(options);
        } finally {
          await catalog.close();
        }
      });
    }
    return this.runExclusive(async () => {
      await this.assertExactAdmissionPresent(options.record);
      const published = await this.checkpointProjectionStore.publish({
        ...options,
        beforePublish: (artifactBytes) =>
          this.assertWriteCapacity({
            pendingBytes: artifactBytes,
            pendingEntries: 0,
          }),
      });
      try {
        await this.assertExactAdmissionPresent(options.record);
      } catch (error) {
        if (published.created) {
          await this.removeStalePublishedArtifactIfSafe({
            record: options.record,
            gate: options.gate,
            artifact: published.artifact,
          });
        }
        throw error;
      }
      return published.artifact;
    });
  }

  async close(): Promise<void> {
    await this.writeQueue;
    if (this.closed) return;
    this.closed = true;
    try {
      await releaseCatalogLock(this.lockPath, this.writerId);
    } finally {
      activeCatalogRoots.delete(this.catalogRoot);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw catalogWriter("catalog_is_closed");
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release: (() => void) | undefined;
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.assertOpen();
      return await operation();
    } finally {
      release?.();
    }
  }

  private async runPostCloseProjectionExclusive<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.postCloseProjectionQueue;
    let release: (() => void) | undefined;
    this.postCloseProjectionQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async assertWriteCapacity(options: {
    pendingBytes: number;
    pendingEntries: 0 | 1;
  }): Promise<void> {
    const entries = await fs.readdir(this.entriesRoot);
    if (entries.length + options.pendingEntries > this.limits.maxEntries) {
      throw catalogCapacity("catalog_entry_count_ceiling_exceeded");
    }
    let totalBytes =
      options.pendingBytes +
      (await this.checkpointProjectionStore.totalArtifactBytes());
    if (totalBytes > this.limits.maxTotalEntryBytes) {
      throw catalogCapacity("catalog_total_byte_ceiling_exceeded");
    }
    for (const entry of entries) {
      totalBytes += (await fs.lstat(path.join(this.entriesRoot, entry))).size;
      if (totalBytes > this.limits.maxTotalEntryBytes) {
        throw catalogCapacity("catalog_total_byte_ceiling_exceeded");
      }
    }
  }

  private async publishAdmissionRecord(options: {
    record: ReplayPremiereAdmissionRecordV1;
    bytes: Uint8Array;
    destination: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const temporary = path.join(
      this.entriesRoot,
      `.${options.record.premiereId}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    let temporaryIdentity: { dev: number; ino: number } | null = null;
    try {
      handle = await fs.open(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      const opened = await handle.stat();
      temporaryIdentity = { dev: opened.dev, ino: opened.ino };
      await handle.writeFile(options.bytes);
      await this.injectAdmissionPublicationFault("after_temporary_write");
      assertCheckpointProjectionSignalActive(options.signal);
      await handle.sync();
      await this.injectAdmissionPublicationFault("after_temporary_sync");
      assertCheckpointProjectionSignalActive(options.signal);
      await handle.close();
      handle = null;
      await this.injectAdmissionPublicationFault("after_temporary_close");
      assertCheckpointProjectionSignalActive(options.signal);
      await fs.link(temporary, options.destination);
      await this.injectAdmissionPublicationFault("after_admission_link");
      assertCheckpointProjectionSignalActive(options.signal);
      await fs.chmod(options.destination, 0o400);
      await this.injectAdmissionPublicationFault("after_admission_chmod");
      assertCheckpointProjectionSignalActive(options.signal);
      await fs.unlink(temporary);
      await this.injectAdmissionPublicationFault("after_temporary_unlink");
      assertCheckpointProjectionSignalActive(options.signal);
      await syncDirectory(this.entriesRoot);
      await this.injectAdmissionPublicationFault("after_directory_sync");
      assertCheckpointProjectionSignalActive(options.signal);
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => undefined);
      if (hasCode(error, "EEXIST")) {
        try {
          const existing = await readBoundedCatalogFile(
            options.destination,
            this.limits.maxEntryBytes,
          );
          if (!Buffer.from(existing).equals(options.bytes)) {
            throw catalogIntegrity("catalog_admission_publish_conflict");
          }
          await unlinkIfPresent(temporary);
          await syncDirectory(this.entriesRoot);
          return;
        } catch (existingError) {
          await cleanupFailedAdmissionPublication({
            entriesRoot: this.entriesRoot,
            temporary,
            destination: options.destination,
            temporaryIdentity,
            injectFault: (phase) => this.injectAdmissionPublicationFault(phase),
          });
          throw existingError;
        }
      }
      try {
        await cleanupFailedAdmissionPublication({
          entriesRoot: this.entriesRoot,
          temporary,
          destination: options.destination,
          temporaryIdentity,
          injectFault: (phase) => this.injectAdmissionPublicationFault(phase),
        });
      } catch (cleanupError) {
        throw catalogIntegrity(
          "catalog_admission_cleanup_failed",
          new AggregateError(
            [error, cleanupError],
            "admission publication and cleanup failed",
          ),
        );
      }
      throw error;
    }
  }

  private async injectAdmissionPublicationFault(
    phase: ReplayPremiereAdmissionPublicationPhase,
  ): Promise<void> {
    await this.admissionPublicationFaultInjector?.(phase);
  }

  private async admissionAbsenceIsDurable(
    destination: string,
  ): Promise<boolean> {
    try {
      await this.injectAdmissionPublicationFault(
        "before_rollback_absence_stat",
      );
      if ((await lstatIfPresent(destination)) !== null) return false;
      await this.injectAdmissionPublicationFault(
        "before_rollback_absence_sync",
      );
      await syncDirectory(this.entriesRoot);
      await this.injectAdmissionPublicationFault(
        "before_rollback_absence_stat",
      );
      return (await lstatIfPresent(destination)) === null;
    } catch {
      // Absence must be positively observed on both sides of a successful
      // directory fsync. Any stat/fsync uncertainty retains the projection so
      // a possibly-visible admission can never become projectionless.
      return false;
    }
  }

  private async resolveAdmissionCommitState(options: {
    record: ReplayPremiereAdmissionRecordV1;
    gate: VerifiedPremiereEligibilityGate;
    artifact: ReplayPremiereCheckpointProjectionArtifactV1;
    destination: string;
  }): Promise<"committed" | "absent" | "uncertain"> {
    try {
      // Complete both directory durability barriers, then validate the exact
      // immutable pair twice around the artifact read. The catalog lock blocks
      // admissions while this resolves the transaction; any external delete
      // or replacement is detected by the second exact-record check.
      await syncDirectory(this.checkpointProjectionStore.root);
      await syncDirectory(this.entriesRoot);
      await this.assertExactAdmissionPresent(options.record);
      const stored = await this.checkpointProjectionStore.load({
        record: options.record,
        gate: options.gate,
      });
      if (stored?.artifactHash !== options.artifact.artifactHash) {
        return "uncertain";
      }
      await this.assertExactAdmissionPresent(options.record);
      return "committed";
    } catch {
      if (await this.admissionAbsenceIsDurable(options.destination)) {
        return "absent";
      }
      return "uncertain";
    }
  }

  private async assertExactAdmissionPresent(
    record: ReplayPremiereAdmissionRecordV1,
  ): Promise<void> {
    const state = await this.exactAdmissionState(record);
    if (state === "missing") {
      throw catalogIntegrity("catalog_projection_admission_missing");
    }
    if (state === "replaced") {
      throw catalogIntegrity("catalog_projection_admission_replaced");
    }
  }

  private async exactAdmissionState(
    record: ReplayPremiereAdmissionRecordV1,
  ): Promise<"exact" | "missing" | "replaced"> {
    const destination = path.join(
      this.entriesRoot,
      `${record.premiereId}${ENTRY_SUFFIX}`,
    );
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedCatalogFile(
        destination,
        this.limits.maxEntryBytes,
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return "missing";
      }
      throw error;
    }
    const expected = Buffer.from(
      `${canonicalReplayPremiereJson(asJson(record))}\n`,
      "utf8",
    );
    return Buffer.from(bytes).equals(expected) ? "exact" : "replaced";
  }

  private async removeStalePublishedArtifactIfSafe(options: {
    record: ReplayPremiereAdmissionRecordV1;
    gate: VerifiedPremiereEligibilityGate;
    artifact: ReplayPremiereCheckpointProjectionArtifactV1;
  }): Promise<void> {
    let removable = false;
    try {
      const state = await this.exactAdmissionState(options.record);
      if (state === "replaced") {
        removable = true;
      } else if (state === "missing") {
        removable = await this.admissionAbsenceIsDurable(
          path.join(
            this.entriesRoot,
            `${options.record.premiereId}${ENTRY_SUFFIX}`,
          ),
        );
      }
    } catch {
      // Read uncertainty retains the artifact. Removing it could make an exact
      // admission that is merely unreadable at this instant projectionless.
    }
    if (removable) {
      await this.checkpointProjectionStore.removePublishedArtifact(options);
    }
  }
}

async function createAdmissionRecord(
  options: ReplayPremiereAdmissionWriteOptions & {
    privateStateRoot: string;
    servedRoots: readonly string[];
    limits: ReplayPremiereCatalogLimits;
  },
): Promise<ReplayPremiereAdmissionRecordV1> {
  if (!VerifiedPremiereEligibilityGate.isAuthentic(options.gate)) {
    throw catalogIntegrity("catalog_unverified_gate");
  }
  if (
    !VerifiedReplayPremiereLeakAuditReceipt.isAuthentic(
      options.verification.leakAuditReceipt,
    )
  ) {
    throw catalogIntegrity("catalog_unverified_leak_receipt");
  }
  validateReplayPremiereLeakAuditCollectorLimits(options.collectorLimits);
  const verifiedSource = options.verification.verifiedSource;
  const staged = verifiedSource.stagedSource();
  const relativePath = relativeSourcePath(options.privateStateRoot, staged);
  const source = await readVerifiedStagedPremiereSource({
    stagedSource: staged,
    privateStateRoot: options.privateStateRoot,
    servedRoots: options.servedRoots,
    maxSourceBytes: options.limits.maxSourceBytes,
  });
  const resultBytes = Buffer.from(
    options.verification.authoritativeResultBytes,
  );
  if (resultBytes.byteLength > options.limits.maxAuthoritativeResultBytes) {
    throw catalogCapacity("catalog_result_byte_ceiling_exceeded");
  }
  const imported = importControlledPremiereSourceForPublication({
    sourceBytes: source.copyBytes(),
    eligibilityRecord: options.verification.eligibilityRecord,
    authoritativeResultBytes: resultBytes,
    replayImportLimits: options.verification.replayImportLimits,
  });
  const rebuiltDrafts = buildPremiereChunks({
    premiereId: options.verification.premiereId,
    records: imported.records,
    playbackRate: options.verification.publicDefinition.playbackRate,
    checkpointSequences: options.verification.publicDefinition.checkpoints.map(
      (checkpoint) => checkpoint.sequence,
    ),
    ...options.chunkBuildLimits,
  });
  if (
    !replayPremiereDraftChunksMatch(
      rebuiltDrafts,
      options.verification.draftChunks,
    )
  ) {
    throw catalogIntegrity("catalog_rebuilt_draft_mismatch");
  }
  const rebuiltGate = VerifiedPremiereEligibilityGate.verify({
    ...options.verification,
    verifiedSource: source,
    authoritativeResultBytes: resultBytes,
    draftChunks: rebuiltDrafts,
  });
  const commitment = rebuiltGate.publicationCommitment();
  if (
    options.gate.publicationCommitmentHash !==
      rebuiltGate.publicationCommitmentHash ||
    options.gate.eligibilityRecordHash !== rebuiltGate.eligibilityRecordHash
  ) {
    throw catalogIntegrity("catalog_gate_reverification_mismatch");
  }
  const assessment = serializeAssessmentOptions(
    options.verification.eligibilityOptions,
  );
  const preimage: ReplayPremiereAdmissionRecordPreimageV1 = {
    schemaVersion: 1,
    admissionKind: CATALOG_KIND,
    premiereId: rebuiltGate.premiereId,
    admittedAt: assessment.assessedAt,
    stagedSource: {
      relativePath,
      sourceReplaySha256: staged.sourceReplaySha256,
      byteLength: staged.byteLength,
    },
    eligibilityRecord: immutable(
      options.verification.eligibilityRecord,
      "catalog eligibility record",
    ),
    assessment,
    leakAuditReceipt: options.verification.leakAuditReceipt.material(),
    authoritativeResult: {
      sourceId:
        options.verification.eligibilityRecord.authoritativeResult.sourceId,
      encoding: "base64",
      bytes: resultBytes.toString("base64"),
      sha256: sha256Hex(resultBytes),
    },
    publicDefinition: immutable(
      options.verification.publicDefinition,
      "catalog public definition",
    ),
    replayImportLimits: immutable(
      options.verification.replayImportLimits,
      "catalog import limits",
    ),
    chunkBuildLimits: immutable(
      options.chunkBuildLimits,
      "catalog chunk limits",
    ),
    collectorLimits: immutable(
      options.collectorLimits,
      "catalog collector limits",
    ),
    expectedEligibilityRecordHash: commitment.eligibilityRecordHash,
    expectedPublicationCommitmentHash: commitment.publicationCommitmentHash,
    expectedOrderedDraftManifestRoot: commitment.orderedDraftManifestRoot,
  };
  return immutable(
    { ...preimage, recordHash: hashReplayPremiereJson(asJson(preimage)) },
    "replay premiere admission record",
  );
}

function parseAdmissionRecord(
  bytes: Uint8Array,
): ReplayPremiereAdmissionRecordV1 {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw catalogIntegrity("catalog_entry_invalid_json", error);
  }
  if (!isRecord(value)) throw catalogIntegrity("catalog_entry_not_object");
  assertExactKeys(value, [
    "schemaVersion",
    "admissionKind",
    "premiereId",
    "admittedAt",
    "stagedSource",
    "eligibilityRecord",
    "assessment",
    "leakAuditReceipt",
    "authoritativeResult",
    "publicDefinition",
    "replayImportLimits",
    "chunkBuildLimits",
    "collectorLimits",
    "expectedEligibilityRecordHash",
    "expectedPublicationCommitmentHash",
    "expectedOrderedDraftManifestRoot",
    "recordHash",
  ]);
  const record = value as unknown as ReplayPremiereAdmissionRecordV1;
  const { recordHash, ...preimage } = record;
  if (
    record.schemaVersion !== 1 ||
    record.admissionKind !== CATALOG_KIND ||
    !isPremiereId(record.premiereId) ||
    canonicalTimestamp(record.admittedAt) !== record.admittedAt ||
    !isSha256Hex(recordHash) ||
    hashReplayPremiereJson(asJson(preimage)) !== recordHash ||
    !isSha256Hex(record.expectedEligibilityRecordHash) ||
    !isSha256Hex(record.expectedPublicationCommitmentHash) ||
    !isSha256Hex(record.expectedOrderedDraftManifestRoot)
  ) {
    throw catalogIntegrity("catalog_entry_contract_invalid");
  }
  validateSourceRecord(record.stagedSource);
  validateAssessmentRecord(record.assessment);
  validateResultRecord(record.authoritativeResult);
  validateExactPositiveIntegerObject(record.replayImportLimits, [
    "maxBootstrapBytes",
    "maxTurnBytes",
    "maxTurnRecords",
    "maxTotalTurnBytes",
  ]);
  validateExactPositiveIntegerObject(record.chunkBuildLimits, [
    "maxChunkBytes",
    "maxTotalBytes",
    "maxRecordsPerChunk",
    "maxPresentationSpanMs",
  ]);
  validateExactPositiveIntegerObject(record.collectorLimits, [
    "maxTargets",
    "maxTargetUrlBytes",
    "maxBodyBytesPerTarget",
    "maxTotalBodyBytes",
    "maxHeaderBytesPerTarget",
    "maxHeaderCountPerTarget",
    "requestTimeoutMs",
    "totalTimeoutMs",
  ]);
  validateReplayPremiereLeakAuditCollectorLimits(record.collectorLimits);
  assertReplayPremiereJsonValue(record, "replay premiere admission record");
  return immutable(record, "parsed replay premiere admission record");
}

function validateSourceRecord(value: ReplayPremiereAdmissionSourceV1): void {
  if (!isRecord(value)) throw catalogIntegrity("catalog_source_not_object");
  assertExactKeys(value, ["relativePath", "sourceReplaySha256", "byteLength"]);
  if (
    !isSha256Hex(value.sourceReplaySha256) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.relativePath !== expectedSourceRelativePath(value.sourceReplaySha256)
  ) {
    throw catalogIntegrity("catalog_source_contract_invalid");
  }
}

function validateAssessmentRecord(
  value: ReplayPremiereAdmissionAssessmentV1,
): void {
  if (!isRecord(value)) throw catalogIntegrity("catalog_assessment_not_object");
  assertExactKeys(value, [
    "assessedAt",
    "maxLeakCheckAgeMs",
    "maxExternalEvidenceAgeMs",
    "maxObservedBodyBytes",
    "maxFutureClockSkewMs",
    "privateCommitmentNonceBase64",
  ]);
  const nonce = Buffer.from(value.privateCommitmentNonceBase64, "base64");
  if (
    canonicalTimestamp(value.assessedAt) !== value.assessedAt ||
    nonce.toString("base64") !== value.privateCommitmentNonceBase64 ||
    nonce.byteLength < 16 ||
    nonce.byteLength > 64 ||
    !positiveInteger(value.maxLeakCheckAgeMs) ||
    !positiveInteger(value.maxExternalEvidenceAgeMs) ||
    !positiveInteger(value.maxObservedBodyBytes) ||
    (value.maxFutureClockSkewMs !== null &&
      !positiveInteger(value.maxFutureClockSkewMs))
  ) {
    throw catalogIntegrity("catalog_assessment_contract_invalid");
  }
}

function validateResultRecord(value: ReplayPremiereAdmissionResultV1): void {
  if (!isRecord(value)) throw catalogIntegrity("catalog_result_not_object");
  assertExactKeys(value, ["sourceId", "encoding", "bytes", "sha256"]);
  const bytes = Buffer.from(value.bytes, "base64");
  if (
    value.encoding !== "base64" ||
    typeof value.sourceId !== "string" ||
    value.sourceId.length < 1 ||
    value.sourceId.length > 256 ||
    bytes.toString("base64") !== value.bytes ||
    !isSha256Hex(value.sha256) ||
    sha256Hex(bytes) !== value.sha256
  ) {
    throw catalogIntegrity("catalog_result_contract_invalid");
  }
}

function serializeAssessmentOptions(
  options: PremiereEligibilityAssessmentOptions,
): ReplayPremiereAdmissionAssessmentV1 {
  if (!Number.isFinite(options.now.getTime())) {
    throw catalogIntegrity("catalog_assessment_clock_invalid");
  }
  return immutable(
    {
      assessedAt: options.now.toISOString(),
      maxLeakCheckAgeMs: options.maxLeakCheckAgeMs,
      maxExternalEvidenceAgeMs: options.maxExternalEvidenceAgeMs,
      maxObservedBodyBytes: options.maxObservedBodyBytes,
      maxFutureClockSkewMs: options.maxFutureClockSkewMs ?? null,
      privateCommitmentNonceBase64: Buffer.from(
        options.privateCommitmentNonce,
      ).toString("base64"),
    },
    "catalog assessment options",
  );
}

export function assessmentOptionsFromAdmission(
  assessment: ReplayPremiereAdmissionAssessmentV1,
): PremiereEligibilityAssessmentOptions {
  validateAssessmentRecord(assessment);
  return {
    now: new Date(assessment.assessedAt),
    maxLeakCheckAgeMs: assessment.maxLeakCheckAgeMs,
    maxExternalEvidenceAgeMs: assessment.maxExternalEvidenceAgeMs,
    maxObservedBodyBytes: assessment.maxObservedBodyBytes,
    ...(assessment.maxFutureClockSkewMs === null
      ? {}
      : { maxFutureClockSkewMs: assessment.maxFutureClockSkewMs }),
    privateCommitmentNonce: new Uint8Array(
      Buffer.from(assessment.privateCommitmentNonceBase64, "base64"),
    ),
  };
}

export async function readAdmissionVerifiedSource(options: {
  record: ReplayPremiereAdmissionRecordV1;
  privateStateRoot: string;
  servedRoots: readonly string[];
  maxSourceBytes: number;
}): Promise<VerifiedStagedPremiereSourceBytes> {
  const stagedSource: StagedPremiereSource = {
    schemaVersion: 1,
    sourceReplaySha256: options.record.stagedSource.sourceReplaySha256,
    byteLength: options.record.stagedSource.byteLength,
    privatePath: path.join(
      options.privateStateRoot,
      ...options.record.stagedSource.relativePath.split("/"),
    ),
    reused: true,
  };
  return readVerifiedStagedPremiereSource({
    stagedSource,
    privateStateRoot: options.privateStateRoot,
    servedRoots: options.servedRoots,
    maxSourceBytes: options.maxSourceBytes,
  });
}

function relativeSourcePath(
  root: string,
  staged: StagedPremiereSource,
): string {
  const relative = path
    .relative(root, staged.privatePath)
    .split(path.sep)
    .join("/");
  if (relative !== expectedSourceRelativePath(staged.sourceReplaySha256)) {
    throw catalogIntegrity("catalog_source_path_not_content_addressed");
  }
  return relative;
}

function expectedSourceRelativePath(hash: string): string {
  return `sources/sha256/${hash.slice(0, 2)}/${hash}.replay`;
}

async function readBoundedCatalogFile(
  filePath: string,
  maximum: number,
): Promise<Uint8Array> {
  const before = await fs.lstat(filePath);
  validateCatalogFileStat(before, maximum);
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    validateCatalogFileStat(opened, maximum);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw catalogIntegrity("catalog_entry_identity_changed_before_read");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    validateCatalogFileStat(after, maximum);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw catalogIntegrity("catalog_entry_changed_during_read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function validateCatalogFileStat(stat: Stats, maximum: number): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o400 ||
    !ownedByCurrentProcess(stat.uid) ||
    stat.size <= 0 ||
    stat.size > maximum
  ) {
    throw catalogIntegrity("catalog_entry_file_contract_invalid");
  }
}

function validateExactPositiveIntegerObject(
  value: object,
  keys: readonly string[],
): void {
  if (!isRecord(value)) throw catalogIntegrity("catalog_limits_not_object");
  assertExactKeys(value, keys);
  if (keys.some((key) => !positiveInteger(value[key]))) {
    throw catalogIntegrity("catalog_limits_invalid");
  }
}

function validateCatalogLimits(
  limits: ReplayPremiereCatalogLimits,
): ReplayPremiereCatalogLimits {
  validateExactPositiveIntegerObject(limits, [
    "maxEntries",
    "maxEntryBytes",
    "maxTotalEntryBytes",
    "maxSourceBytes",
    "maxAuthoritativeResultBytes",
  ]);
  if (
    limits.maxEntries > 1_024 ||
    limits.maxEntryBytes > 32 * 1024 * 1024 ||
    limits.maxTotalEntryBytes > 256 * 1024 * 1024 ||
    limits.maxTotalEntryBytes < limits.maxEntryBytes ||
    limits.maxSourceBytes > 1024 * 1024 * 1024 ||
    limits.maxAuthoritativeResultBytes > 16 * 1024 * 1024
  ) {
    throw catalogCapacity("catalog_limits_outside_hard_bounds");
  }
  return immutable(limits, "replay premiere catalog limits");
}

function validateCatalogWriterWaitMs(value: number | undefined): number {
  const waitMs = value ?? 0;
  if (
    !Number.isSafeInteger(waitMs) ||
    waitMs < 0 ||
    waitMs > MAX_CATALOG_WRITER_WAIT_MS
  ) {
    throw catalogWriter("catalog_writer_wait_invalid");
  }
  return waitMs;
}

async function ensurePrivateDirectory(
  directory: string,
  expectedParent: string,
): Promise<string> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  const before = await fs.lstat(directory);
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    !ownedByCurrentProcess(before.uid)
  ) {
    throw catalogIntegrity("catalog_directory_not_private");
  }
  const handle = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !ownedByCurrentProcess(opened.uid)
    ) {
      throw catalogIntegrity("catalog_directory_identity_changed");
    }
    await handle.chmod(0o700);
    const hardened = await handle.stat();
    if (
      hardened.dev !== opened.dev ||
      hardened.ino !== opened.ino ||
      (hardened.mode & 0o777) !== 0o700 ||
      !ownedByCurrentProcess(hardened.uid)
    ) {
      throw catalogIntegrity("catalog_directory_not_private");
    }
  } finally {
    await handle.close();
  }
  const canonical = await fs.realpath(directory);
  const canonicalParent = await fs.realpath(expectedParent);
  if (
    canonical !== path.resolve(directory) ||
    path.dirname(canonical) !== canonicalParent
  ) {
    throw catalogIntegrity("catalog_directory_alias_rejected");
  }
  await syncDirectory(canonicalParent);
  return canonical;
}

async function acquireCatalogLock(
  lockPath: string,
  recoveryRoot: string,
  writerId: string,
): Promise<void> {
  const value = {
    schemaVersion: 1,
    pid: process.pid,
    writerId,
    acquiredAt: new Date().toISOString(),
  };
  const bytes = `${JSON.stringify(value)}\n`;
  try {
    await createCatalogLockFile(lockPath, bytes);
    return;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  let existing: unknown;
  try {
    existing = JSON.parse(await readCatalogLockFile(lockPath));
  } catch (error) {
    throw catalogWriter("catalog_existing_lock_unreadable", error);
  }
  if (!isCatalogLockRecord(existing)) {
    throw catalogWriter("catalog_existing_lock_invalid");
  }
  if (isProcessAlive(Number(existing.pid))) {
    throw catalogWriter("catalog_writer_already_active_on_host");
  }
  await fs.rename(
    lockPath,
    path.join(
      recoveryRoot,
      `stale-write-owner-${Date.now()}-${randomUUID()}.json`,
    ),
  );
  await Promise.all([
    syncDirectory(path.dirname(lockPath)),
    syncDirectory(recoveryRoot),
  ]);
  try {
    await createCatalogLockFile(lockPath, bytes);
  } catch (error) {
    throw catalogWriter("catalog_lock_reacquisition_failed", error);
  }
}

async function acquireCatalogLockWithWait(options: {
  catalogRoot: string;
  lockPath: string;
  recoveryRoot: string;
  writerId: string;
  writerWaitMs: number;
}): Promise<void> {
  const deadline = Date.now() + options.writerWaitMs;
  while (true) {
    let contention: ReplayPremiereError;
    if (activeCatalogRoots.has(options.catalogRoot)) {
      contention = catalogWriter("catalog_writer_already_active_in_process");
    } else {
      try {
        await acquireCatalogLock(
          options.lockPath,
          options.recoveryRoot,
          options.writerId,
        );
        return;
      } catch (error) {
        if (
          !(error instanceof ReplayPremiereError) ||
          error.operatorCode !== "catalog_writer_already_active_on_host"
        ) {
          throw error;
        }
        contention = error;
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw contention;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(25, remainingMs)),
    );
  }
}

async function releaseCatalogLock(
  lockPath: string,
  writerId: string,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(await readCatalogLockFile(lockPath));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  if (!isCatalogLockRecord(value) || value.writerId !== writerId) {
    throw catalogWriter("catalog_lock_ownership_changed");
  }
  await fs.unlink(lockPath);
  await syncDirectory(path.dirname(lockPath));
}

async function createCatalogLockFile(
  lockPath: string,
  bytes: string,
): Promise<void> {
  const handle = await fs.open(
    lockPath,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(lockPath));
}

async function readCatalogLockFile(lockPath: string): Promise<string> {
  const before = await fs.lstat(lockPath);
  validateCatalogLockStat(before);
  const handle = await fs.open(
    lockPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    validateCatalogLockStat(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw catalogWriter("catalog_lock_identity_changed_before_read");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    validateCatalogLockStat(after);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw catalogWriter("catalog_lock_changed_during_read");
    }
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

function validateCatalogLockStat(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    !ownedByCurrentProcess(stat.uid) ||
    stat.size <= 0 ||
    stat.size > MAX_CATALOG_LOCK_BYTES
  ) {
    throw catalogWriter("catalog_lock_file_contract_invalid");
  }
}

function isCatalogLockRecord(
  value: unknown,
): value is Record<string, unknown> & { pid: number; writerId: string } {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\u0000") !==
      ["schemaVersion", "pid", "writerId", "acquiredAt"]
        .sort()
        .join("\u0000") ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    Number(value.pid) <= 0 ||
    typeof value.writerId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.writerId,
    )
  ) {
    return false;
  }
  try {
    return canonicalTimestamp(value.acquiredAt) === value.acquiredAt;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function recoverInterruptedAdmissionPublications(
  entriesRoot: string,
): Promise<void> {
  let changed = false;
  const entries = await fs.readdir(entriesRoot, { withFileTypes: true });
  for (const temporaryEntry of entries) {
    if (!isAdmissionPublicationTemporaryName(temporaryEntry.name)) continue;
    if (!temporaryEntry.isFile()) {
      throw catalogIntegrity("catalog_admission_temporary_invalid");
    }
    const temporary = path.join(entriesRoot, temporaryEntry.name);
    const temporaryStat = await fs.lstat(temporary);
    if (
      !temporaryStat.isFile() ||
      temporaryStat.isSymbolicLink() ||
      !ownedByCurrentProcess(temporaryStat.uid) ||
      temporaryStat.nlink < 1 ||
      temporaryStat.nlink > 2
    ) {
      throw catalogIntegrity("catalog_admission_temporary_invalid");
    }
    const linkedAdmissions: string[] = [];
    for (const candidate of entries) {
      if (!candidate.name.endsWith(ENTRY_SUFFIX)) continue;
      const candidatePath = path.join(entriesRoot, candidate.name);
      const candidateStat = await fs.lstat(candidatePath);
      if (
        candidateStat.dev === temporaryStat.dev &&
        candidateStat.ino === temporaryStat.ino
      ) {
        linkedAdmissions.push(candidatePath);
      }
    }
    if (temporaryStat.nlink === 1 && linkedAdmissions.length === 0) {
      await fs.unlink(temporary);
      changed = true;
      continue;
    }
    if (temporaryStat.nlink !== 2 || linkedAdmissions.length !== 1) {
      throw catalogIntegrity("catalog_admission_temporary_invalid");
    }
    // The admission link is not committed until its temporary is removed.
    // A crash before that point rolls the entry back; the projection-store
    // orphan sweep that follows removes its now-unreferenced artifact.
    await fs.unlink(linkedAdmissions[0]);
    await fs.unlink(temporary);
    changed = true;
  }
  if (changed) await syncDirectory(entriesRoot);
}

async function readCheckpointProjectionAdmissionBinding(options: {
  entriesRoot: string;
  premiereId: string;
  maxEntryBytes: number;
}): Promise<ReplayPremiereCheckpointProjectionAdmissionBinding> {
  const destination = path.join(
    options.entriesRoot,
    `${options.premiereId}${ENTRY_SUFFIX}`,
  );
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedCatalogFile(destination, options.maxEntryBytes);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return { state: "missing" };
    // The catalog reader owns per-target diagnostics. An unreadable, unsafe,
    // or transiently uncertain admission must not make Catalog.open fail and
    // must not authorize deleting its possibly-required projection.
    return { state: "uncertain" };
  }
  try {
    const record = parseAdmissionRecord(bytes);
    if (record.premiereId !== options.premiereId) {
      return { state: "uncertain" };
    }
    return { state: "validated", recordHash: record.recordHash };
  } catch {
    return { state: "uncertain" };
  }
}

async function cleanupFailedAdmissionPublication(options: {
  entriesRoot: string;
  temporary: string;
  destination: string;
  temporaryIdentity: { dev: number; ino: number } | null;
  injectFault: (
    phase: ReplayPremiereAdmissionPublicationPhase,
  ) => void | Promise<void>;
}): Promise<void> {
  const temporaryStat = await lstatIfPresent(options.temporary);
  const destinationStat = await lstatIfPresent(options.destination);
  const identity = temporaryStat ?? options.temporaryIdentity;
  if (
    destinationStat !== null &&
    identity !== null &&
    destinationStat.dev === identity.dev &&
    destinationStat.ino === identity.ino
  ) {
    await options.injectFault("before_cleanup_admission_unlink");
    await fs.unlink(options.destination);
  }
  await options.injectFault("before_cleanup_temporary_unlink");
  await unlinkIfPresent(options.temporary);
  await options.injectFault("before_cleanup_directory_sync");
  await syncDirectory(options.entriesRoot);
}

async function lstatIfPresent(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

function isAdmissionPublicationTemporaryName(name: string): boolean {
  const match = /^\.(prem_[a-z0-9]{16,32})\.([0-9a-f-]{36})\.tmp$/.exec(name);
  return match !== null && isPremiereId(match[1]);
}

function duplicates(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return duplicate;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") throw catalogIntegrity("invalid_timestamp");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw catalogIntegrity("invalid_timestamp");
  }
  return value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function assertExactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw catalogIntegrity("catalog_unknown_or_missing_fields");
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

function ownedByCurrentProcess(uid: number): boolean {
  const getuid = process.getuid;
  return getuid === undefined || uid === getuid.call(process);
}

function operatorCode(error: unknown, fallback: string): string {
  return error instanceof ReplayPremiereError ? error.operatorCode : fallback;
}

function catalogDiagnosticTarget(filename: string): string {
  if (
    Buffer.byteLength(filename, "utf8") <= MAX_DIAGNOSTIC_TARGET_BYTES &&
    SAFE_DIAGNOSTIC_TARGET.test(filename)
  ) {
    return filename;
  }
  return `catalog_entry_${sha256Hex(Buffer.from(filename, "utf8"))}`;
}

function asJson(value: unknown): ReplayPremiereJsonValue {
  assertReplayPremiereJsonValue(value, "replay premiere catalog JSON");
  return value as ReplayPremiereJsonValue;
}

function immutable<T>(value: T, label: string): T {
  return cloneAndFreezeReplayPremiereValue(value, label);
}

function catalogIntegrity(
  operatorCodeValue: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCodeValue,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    "Replay Premiere private admission catalog failed integrity validation",
    cause === undefined ? undefined : { cause },
  );
}

function catalogCapacity(operatorCodeValue: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCodeValue,
    "PREMIERE_CAPACITY_EXCEEDED",
    413,
    "Replay Premiere private admission catalog exceeded a bounded limit",
  );
}

function assertCheckpointProjectionSignalActive(
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted === true) {
    throw new ReplayPremiereError(
      "checkpoint_projection_aborted",
      "PREMIERE_UNAVAILABLE",
      503,
      "Replay Premiere checkpoint projection was aborted before publication",
    );
  }
}

function catalogWriter(
  operatorCodeValue: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCodeValue,
    "PREMIERE_UNAVAILABLE",
    503,
    "Replay Premiere private admission catalog writer is unavailable",
    cause === undefined ? undefined : { cause },
  );
}
