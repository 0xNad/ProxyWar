import { randomUUID } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
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

export interface ReplayPremiereAdmissionWriteOptions {
  gate: VerifiedPremiereEligibilityGate;
  verification: VerifyPremierePublicationOptions;
  chunkBuildLimits: ReplayPremiereChunkBuildLimits;
  collectorLimits: ReplayPremiereLeakAuditCollectorLimits;
}

export class ReplayPremiereAdmissionCatalog {
  readonly privateStateRoot: string;
  readonly catalogRoot: string;
  readonly entriesRoot: string;
  private readonly servedRoots: readonly string[];
  private readonly limits: ReplayPremiereCatalogLimits;
  private readonly lockPath: string;
  private readonly writerId: string;
  private closed = false;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(options: {
    privateStateRoot: string;
    catalogRoot: string;
    entriesRoot: string;
    servedRoots: readonly string[];
    limits: ReplayPremiereCatalogLimits;
    lockPath: string;
    writerId: string;
  }) {
    this.privateStateRoot = options.privateStateRoot;
    this.catalogRoot = options.catalogRoot;
    this.entriesRoot = options.entriesRoot;
    this.servedRoots = options.servedRoots;
    this.limits = options.limits;
    this.lockPath = options.lockPath;
    this.writerId = options.writerId;
  }

  static async open(options: {
    privateStateRoot: string;
    servedRoots: readonly string[];
    limits?: ReplayPremiereCatalogLimits;
  }): Promise<ReplayPremiereAdmissionCatalog> {
    const limits = validateCatalogLimits(
      options.limits ?? DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS,
    );
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
    if (activeCatalogRoots.has(canonicalCatalogRoot)) {
      throw catalogWriter("catalog_writer_already_active_in_process");
    }
    const lockPath = path.join(canonicalCatalogRoot, "write-owner.json");
    const writerId = randomUUID();
    await acquireCatalogLock(lockPath, recoveryRoot, writerId);
    activeCatalogRoots.add(canonicalCatalogRoot);
    return new ReplayPremiereAdmissionCatalog({
      privateStateRoot: layout.privateStateRoot,
      catalogRoot: canonicalCatalogRoot,
      entriesRoot,
      servedRoots: layout.servedRoots,
      limits,
      lockPath,
      writerId,
    });
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
    return immutable(
      { entries: accepted, failures },
      "replay premiere catalog read result",
    );
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
    return this.runExclusive(async () => {
      const destination = path.join(
        this.entriesRoot,
        `${record.premiereId}${ENTRY_SUFFIX}`,
      );
      try {
        const existing = await readBoundedCatalogFile(
          destination,
          this.limits.maxEntryBytes,
        );
        if (!Buffer.from(existing).equals(bytes)) {
          throw catalogIntegrity("catalog_admission_is_immutable");
        }
        return record;
      } catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
      }
      await this.assertWriteCapacity(bytes.byteLength);
      await assertPremiereDurableWriteAdmission({
        destinationPath: this.entriesRoot,
        pendingBytes: bytes.byteLength,
      });
      const temporary = path.join(
        this.entriesRoot,
        `.${record.premiereId}.${randomUUID()}.tmp`,
      );
      const handle = await fs.open(
        temporary,
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
      try {
        await fs.link(temporary, destination);
        await fs.chmod(destination, 0o400);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const existing = await readBoundedCatalogFile(
          destination,
          this.limits.maxEntryBytes,
        );
        if (!Buffer.from(existing).equals(bytes)) {
          throw catalogIntegrity("catalog_admission_publish_conflict");
        }
      } finally {
        await fs.unlink(temporary).catch((error: unknown) => {
          if (!hasCode(error, "ENOENT")) throw error;
        });
      }
      await syncDirectory(this.entriesRoot);
      return record;
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

  private async assertWriteCapacity(pendingBytes: number): Promise<void> {
    const entries = await fs.readdir(this.entriesRoot);
    if (entries.length + 1 > this.limits.maxEntries) {
      throw catalogCapacity("catalog_entry_count_ceiling_exceeded");
    }
    let totalBytes = pendingBytes;
    for (const entry of entries) {
      totalBytes += (await fs.lstat(path.join(this.entriesRoot, entry))).size;
      if (totalBytes > this.limits.maxTotalEntryBytes) {
        throw catalogCapacity("catalog_total_byte_ceiling_exceeded");
      }
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
