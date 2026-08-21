import { randomUUID } from "node:crypto";
import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import {
  assessmentOptionsFromAdmission,
  readAdmissionVerifiedSource,
  type ReplayPremiereAdmissionRecordV1,
} from "./ReplayPremiereCatalog";
import {
  assertReplayPremiereCheckpointProjection,
  freezeReplayPremiereCheckpointProjection,
  type ReplayPremiereCheckpointProjection,
} from "./ReplayPremiereCheckpointProjection";
import { buildPremiereChunks } from "./ReplayPremiereChunks";
import {
  isPremiereId,
  type PremiereChunkDraft,
} from "./ReplayPremiereContracts";
import { ReplayPremiereError } from "./ReplayPremiereErrors";
import {
  assertReplayPremiereJsonValue,
  canonicalReplayPremiereJson,
  hashReplayPremiereJson,
  isSha256Hex,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "./ReplayPremiereIntegrity";
import { verifyStoredReplayPremiereLeakAuditReceipt } from "./ReplayPremiereLeakAuditCollector";
import { assertPremiereDurableWriteAdmission } from "./ReplayPremierePrivateStaging";
import {
  importControlledPremiereSourceForPublication,
  VerifiedPremiereEligibilityGate,
} from "./ReplayPremierePublication";

const ARTIFACT_KIND = "replay_premiere_checkpoint_projection_v1" as const;
const ARTIFACT_DIRECTORY = "checkpoint-projections";
const ARTIFACT_SUFFIX = ".checkpoint-projection.json";
const MAX_ARTIFACT_BYTES = 64 * 1024;

interface ReplayPremiereCheckpointProjectionArtifactPreimageV1 {
  schemaVersion: 1;
  artifactKind: typeof ARTIFACT_KIND;
  premiereId: string;
  admissionRecordHash: string;
  sourceReplaySha256: string;
  eligibilityRecordHash: string;
  publicationCommitmentHash: string;
  orderedDraftManifestRoot: string;
  projection: ReplayPremiereCheckpointProjection;
}

export interface ReplayPremiereCheckpointProjectionArtifactV1 extends ReplayPremiereCheckpointProjectionArtifactPreimageV1 {
  artifactHash: string;
}

export interface RebuiltReplayPremiereProjectionInput {
  gate: VerifiedPremiereEligibilityGate;
  drafts: readonly PremiereChunkDraft[];
}

export type ReplayPremiereCheckpointProjectionPublicationPhase =
  | "after_temporary_write"
  | "after_temporary_sync"
  | "after_temporary_close"
  | "after_artifact_link"
  | "after_artifact_chmod"
  | "after_temporary_unlink"
  | "after_directory_sync";

/** Test-only fault seam around the durability boundaries of publication. */
export type ReplayPremiereCheckpointProjectionPublicationFaultInjector = (
  phase: ReplayPremiereCheckpointProjectionPublicationPhase,
) => void | Promise<void>;

export interface ReplayPremiereCheckpointProjectionPublishResult {
  artifact: ReplayPremiereCheckpointProjectionArtifactV1;
  created: boolean;
}

export type ReplayPremiereCheckpointProjectionAdmissionBinding =
  | { state: "missing" }
  | { state: "validated"; recordHash: string }
  | { state: "uncertain" };

/**
 * Small, immutable, private projection artifacts. The fixed filename makes a
 * present-but-invalid artifact distinguishable from absence: corruption is a
 * fail-closed condition and can never silently fall back to GameRunner.
 */
export class ReplayPremiereCheckpointProjectionStore {
  readonly root: string;
  private readonly catalogEntriesRoot: string;
  private readonly maxTotalBytes: number;
  private readonly publicationFaultInjector?: ReplayPremiereCheckpointProjectionPublicationFaultInjector;
  /** See the catalog's `statfs` note: production omits it, tests inject. */
  private readonly statfs?: typeof fs.statfs;

  private constructor(
    root: string,
    catalogEntriesRoot: string,
    maxTotalBytes: number,
    publicationFaultInjector?: ReplayPremiereCheckpointProjectionPublicationFaultInjector,
    statfs?: typeof fs.statfs,
  ) {
    this.root = root;
    this.catalogEntriesRoot = catalogEntriesRoot;
    this.maxTotalBytes = maxTotalBytes;
    this.publicationFaultInjector = publicationFaultInjector;
    this.statfs = statfs;
  }

  static async open(options: {
    catalogRoot: string;
    catalogEntriesRoot: string;
    maxTotalBytes: number;
    publicationFaultInjector?: ReplayPremiereCheckpointProjectionPublicationFaultInjector;
    statfs?: typeof fs.statfs;
  }): Promise<ReplayPremiereCheckpointProjectionStore> {
    const root = await ensurePrivateArtifactDirectory(
      path.join(options.catalogRoot, ARTIFACT_DIRECTORY),
      options.catalogRoot,
    );
    return new ReplayPremiereCheckpointProjectionStore(
      root,
      options.catalogEntriesRoot,
      options.maxTotalBytes,
      options.publicationFaultInjector,
      options.statfs,
    );
  }

  async load(options: {
    record: ReplayPremiereAdmissionRecordV1;
    gate: VerifiedPremiereEligibilityGate;
  }): Promise<ReplayPremiereCheckpointProjectionArtifactV1 | null> {
    assertAuthenticRecordGateBinding(options.record, options.gate);
    const destination = this.artifactPath(
      options.record.premiereId,
      options.record.recordHash,
    );
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedArtifactFile(destination);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
    return parseAndValidateArtifact(bytes, options.record, options.gate);
  }

  async publish(options: {
    record: ReplayPremiereAdmissionRecordV1;
    gate: VerifiedPremiereEligibilityGate;
    projection: ReplayPremiereCheckpointProjection;
    beforePublish?: (pendingBytes: number) => void | Promise<void>;
  }): Promise<ReplayPremiereCheckpointProjectionPublishResult> {
    assertAuthenticRecordGateBinding(options.record, options.gate);
    assertReplayPremiereCheckpointProjection({
      projection: options.projection,
      gate: options.gate,
    });
    const preimage: ReplayPremiereCheckpointProjectionArtifactPreimageV1 = {
      schemaVersion: 1,
      artifactKind: ARTIFACT_KIND,
      premiereId: options.record.premiereId,
      admissionRecordHash: options.record.recordHash,
      sourceReplaySha256: options.record.stagedSource.sourceReplaySha256,
      eligibilityRecordHash: options.record.expectedEligibilityRecordHash,
      publicationCommitmentHash:
        options.record.expectedPublicationCommitmentHash,
      orderedDraftManifestRoot: options.record.expectedOrderedDraftManifestRoot,
      projection: options.projection,
    };
    const artifact = Object.freeze({
      ...preimage,
      artifactHash: hashReplayPremiereJson(asJson(preimage)),
    });
    const bytes = Buffer.from(
      `${canonicalReplayPremiereJson(asJson(artifact))}\n`,
      "utf8",
    );
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw artifactIntegrity("checkpoint_projection_artifact_too_large");
    }
    const destination = this.artifactPath(
      options.record.premiereId,
      options.record.recordHash,
    );
    try {
      const existingBytes = await readBoundedArtifactFile(destination);
      const existing = parseAndValidateArtifact(
        existingBytes,
        options.record,
        options.gate,
      );
      if (!Buffer.from(existingBytes).equals(bytes)) {
        throw artifactIntegrity(
          "checkpoint_projection_artifact_publish_conflict",
        );
      }
      return { artifact: existing, created: false };
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }

    await options.beforePublish?.(bytes.byteLength);
    if (
      (await this.totalArtifactBytes()) +
        (await this.totalCatalogEntryBytes()) +
        bytes.byteLength >
      this.maxTotalBytes
    ) {
      throw artifactIntegrity(
        "checkpoint_projection_artifact_capacity_exceeded",
      );
    }
    await assertPremiereDurableWriteAdmission({
      statfs: this.statfs,
      destinationPath: this.root,
      pendingBytes: bytes.byteLength,
    });

    const temporary = path.join(
      this.root,
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
      await handle.writeFile(bytes);
      await this.injectFault("after_temporary_write");
      await handle.sync();
      await this.injectFault("after_temporary_sync");
      await handle.close();
      handle = null;
      await this.injectFault("after_temporary_close");
      await fs.link(temporary, destination);
      await this.injectFault("after_artifact_link");
      await fs.chmod(destination, 0o400);
      await this.injectFault("after_artifact_chmod");
      await fs.unlink(temporary);
      await this.injectFault("after_temporary_unlink");
      await syncDirectory(this.root);
      await this.injectFault("after_directory_sync");
      return { artifact, created: true };
    } catch (error) {
      if (handle !== null) {
        await handle.close().catch(() => undefined);
      }
      if (hasCode(error, "EEXIST")) {
        try {
          const existingBytes = await readBoundedArtifactFile(destination);
          const existing = parseAndValidateArtifact(
            existingBytes,
            options.record,
            options.gate,
          );
          if (!Buffer.from(existingBytes).equals(bytes)) {
            throw artifactIntegrity(
              "checkpoint_projection_artifact_publish_conflict",
            );
          }
          await unlinkIfPresent(temporary);
          await syncDirectory(this.root);
          return { artifact: existing, created: false };
        } catch (existingError) {
          await this.cleanupFailedPublication({
            temporary,
            destination,
            temporaryIdentity,
          });
          throw existingError;
        }
      }
      try {
        await this.cleanupFailedPublication({
          temporary,
          destination,
          temporaryIdentity,
        });
      } catch (cleanupError) {
        throw artifactIntegrity(
          "checkpoint_projection_artifact_cleanup_failed",
          new AggregateError(
            [error, cleanupError],
            "checkpoint projection publication and cleanup failed",
          ),
        );
      }
      throw error;
    }
  }

  /**
   * Runs only while the owning catalog lock is held. It repairs the two
   * crash windows created by no-replace hard-link publication: an unlinked
   * temporary, or a temporary still linked to its destination.
   */
  async recoverInterruptedPublications(): Promise<void> {
    let changed = false;
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    const temporaries = entries.filter((entry) =>
      isPublicationTemporaryName(entry.name),
    );
    for (const temporaryEntry of temporaries) {
      if (!temporaryEntry.isFile()) {
        throw artifactIntegrity("checkpoint_projection_temporary_invalid");
      }
      const temporary = path.join(this.root, temporaryEntry.name);
      const temporaryStat = await fs.lstat(temporary);
      if (
        !temporaryStat.isFile() ||
        temporaryStat.isSymbolicLink() ||
        !ownedByCurrentProcess(temporaryStat.uid) ||
        temporaryStat.nlink < 1 ||
        temporaryStat.nlink > 2
      ) {
        throw artifactIntegrity("checkpoint_projection_temporary_invalid");
      }
      const linkedArtifacts: string[] = [];
      for (const candidate of entries) {
        if (!candidate.name.endsWith(ARTIFACT_SUFFIX)) continue;
        const candidatePath = path.join(this.root, candidate.name);
        const candidateStat = await fs.lstat(candidatePath);
        if (
          candidateStat.dev === temporaryStat.dev &&
          candidateStat.ino === temporaryStat.ino
        ) {
          linkedArtifacts.push(candidatePath);
        }
      }
      if (temporaryStat.nlink === 1 && linkedArtifacts.length === 0) {
        await fs.unlink(temporary);
        changed = true;
        continue;
      }
      if (temporaryStat.nlink !== 2 || linkedArtifacts.length !== 1) {
        throw artifactIntegrity("checkpoint_projection_temporary_invalid");
      }
      const destination = linkedArtifacts[0];
      if (
        (temporaryStat.mode & 0o777) === 0o400 &&
        temporaryStat.size > 0 &&
        temporaryStat.size <= MAX_ARTIFACT_BYTES
      ) {
        await fs.unlink(temporary);
      } else {
        await fs.unlink(destination);
        await fs.unlink(temporary);
      }
      changed = true;
    }
    if (changed) await syncDirectory(this.root);
  }

  /** Removes only artifacts proven absent or bound to a replaced admission. */
  async removeOrphanArtifacts(options: {
    admissionBinding: (
      premiereId: string,
    ) => Promise<ReplayPremiereCheckpointProjectionAdmissionBinding>;
  }): Promise<void> {
    let changed = false;
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(ARTIFACT_SUFFIX)) continue;
      const binding = artifactFilenameBinding(entry.name);
      if (binding === null) continue;
      const admission = await options.admissionBinding(binding.premiereId);
      if (
        admission.state === "missing" ||
        (admission.state === "validated" &&
          admission.recordHash !== binding.admissionRecordHash)
      ) {
        const artifactPath = path.join(this.root, entry.name);
        const stat = await fs.lstat(artifactPath);
        validateArtifactFileStat(stat);
        await fs.unlink(artifactPath);
        changed = true;
      }
    }
    if (changed) await syncDirectory(this.root);
  }

  async removePublishedArtifact(options: {
    record: ReplayPremiereAdmissionRecordV1;
    gate: VerifiedPremiereEligibilityGate;
    artifact: ReplayPremiereCheckpointProjectionArtifactV1;
  }): Promise<void> {
    const destination = this.artifactPath(
      options.record.premiereId,
      options.record.recordHash,
    );
    const bytes = await readBoundedArtifactFile(destination);
    const stored = parseAndValidateArtifact(
      bytes,
      options.record,
      options.gate,
    );
    if (stored.artifactHash !== options.artifact.artifactHash) {
      throw artifactIntegrity("checkpoint_projection_artifact_remove_conflict");
    }
    await fs.unlink(destination);
    await syncDirectory(this.root);
  }

  artifactPath(premiereId: string, admissionRecordHash: string): string {
    return path.join(
      this.root,
      `${premiereId}.${admissionRecordHash}${ARTIFACT_SUFFIX}`,
    );
  }

  async totalArtifactBytes(): Promise<number> {
    let total = 0;
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(ARTIFACT_SUFFIX)) {
        throw artifactIntegrity("checkpoint_projection_artifact_root_dirty");
      }
      const stat = await fs.lstat(path.join(this.root, entry.name));
      validateArtifactFileStat(stat);
      total += stat.size;
      if (!Number.isSafeInteger(total)) {
        throw artifactIntegrity("checkpoint_projection_artifact_bytes_invalid");
      }
    }
    return total;
  }

  private async totalCatalogEntryBytes(): Promise<number> {
    let total = 0;
    for (const entry of await fs.readdir(this.catalogEntriesRoot, {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(".admission.json")) {
        throw artifactIntegrity("checkpoint_projection_catalog_entries_dirty");
      }
      const stat = await fs.lstat(
        path.join(this.catalogEntriesRoot, entry.name),
      );
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw artifactIntegrity("checkpoint_projection_catalog_entries_dirty");
      }
      total += stat.size;
      if (!Number.isSafeInteger(total)) {
        throw artifactIntegrity("checkpoint_projection_catalog_bytes_invalid");
      }
    }
    return total;
  }

  private async injectFault(
    phase: ReplayPremiereCheckpointProjectionPublicationPhase,
  ): Promise<void> {
    await this.publicationFaultInjector?.(phase);
  }

  private async cleanupFailedPublication(options: {
    temporary: string;
    destination: string;
    temporaryIdentity: { dev: number; ino: number } | null;
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
      await fs.unlink(options.destination);
    }
    await unlinkIfPresent(options.temporary);
    await syncDirectory(this.root);
  }
}

/** Rebuilds the exact authentic gate used by startup and explicit preparation. */
export async function rebuildReplayPremiereProjectionInput(options: {
  record: ReplayPremiereAdmissionRecordV1;
  privateStateRoot: string;
  servedRoots: readonly string[];
  maxSourceBytes: number;
  publicOrigin: string;
}): Promise<RebuiltReplayPremiereProjectionInput> {
  const assessmentOptions = assessmentOptionsFromAdmission(
    options.record.assessment,
  );
  const receipt = verifyStoredReplayPremiereLeakAuditReceipt({
    material: options.record.leakAuditReceipt,
    assessmentOptions,
  });
  assertProductionLeakAuditOrigin(options.record, options.publicOrigin);
  const verifiedSource = await readAdmissionVerifiedSource({
    record: options.record,
    privateStateRoot: options.privateStateRoot,
    servedRoots: options.servedRoots,
    maxSourceBytes: options.maxSourceBytes,
  });
  const resultBytes = Buffer.from(
    options.record.authoritativeResult.bytes,
    "base64",
  );
  if (
    sha256Hex(resultBytes) !== options.record.authoritativeResult.sha256 ||
    options.record.authoritativeResult.sourceId !==
      options.record.eligibilityRecord.authoritativeResult.sourceId
  ) {
    throw artifactIntegrity("startup_authoritative_result_binding_mismatch");
  }
  const imported = importControlledPremiereSourceForPublication({
    sourceBytes: verifiedSource.copyBytes(),
    eligibilityRecord: options.record.eligibilityRecord,
    authoritativeResultBytes: resultBytes,
    replayImportLimits: options.record.replayImportLimits,
  });
  const drafts = buildPremiereChunks({
    premiereId: options.record.premiereId,
    records: imported.records,
    playbackRate: options.record.publicDefinition.playbackRate,
    checkpointSequences: options.record.publicDefinition.checkpoints.map(
      (checkpoint) => checkpoint.sequence,
    ),
    ...options.record.chunkBuildLimits,
  });
  const gate = VerifiedPremiereEligibilityGate.verify({
    premiereId: options.record.premiereId,
    eligibilityRecord: options.record.eligibilityRecord,
    eligibilityOptions: assessmentOptions,
    leakAuditReceipt: receipt,
    verifiedSource,
    authoritativeResultBytes: resultBytes,
    replayImportLimits: options.record.replayImportLimits,
    publicDefinition: options.record.publicDefinition,
    draftChunks: drafts,
    maxPresentationSpanMs:
      options.record.chunkBuildLimits.maxPresentationSpanMs,
  });
  const commitment = gate.publicationCommitment();
  if (
    gate.eligibilityRecordHash !==
      options.record.expectedEligibilityRecordHash ||
    gate.publicationCommitmentHash !==
      options.record.expectedPublicationCommitmentHash ||
    commitment.orderedDraftManifestRoot !==
      options.record.expectedOrderedDraftManifestRoot
  ) {
    throw artifactIntegrity("startup_publication_commitment_mismatch");
  }
  return Object.freeze({ gate, drafts });
}

function parseAndValidateArtifact(
  bytes: Uint8Array,
  record: ReplayPremiereAdmissionRecordV1,
  gate: VerifiedPremiereEligibilityGate,
): ReplayPremiereCheckpointProjectionArtifactV1 {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw artifactIntegrity(
      "checkpoint_projection_artifact_invalid_json",
      error,
    );
  }
  if (!isRecord(value)) {
    throw artifactIntegrity("checkpoint_projection_artifact_not_object");
  }
  assertExactKeys(value, [
    "schemaVersion",
    "artifactKind",
    "premiereId",
    "admissionRecordHash",
    "sourceReplaySha256",
    "eligibilityRecordHash",
    "publicationCommitmentHash",
    "orderedDraftManifestRoot",
    "projection",
    "artifactHash",
  ]);
  const rawProjection = value.projection;
  if (!isRecord(rawProjection) || !Array.isArray(rawProjection.checkpoints)) {
    throw artifactIntegrity("checkpoint_projection_artifact_contract_invalid");
  }
  if (rawProjection.checkpoints.length !== 2) {
    throw artifactIntegrity("checkpoint_projection_artifact_contract_invalid");
  }
  const checkpoints = rawProjection.checkpoints.map((checkpoint) => {
    if (
      !isRecord(checkpoint) ||
      typeof checkpoint.id !== "string" ||
      !Number.isSafeInteger(checkpoint.sequence) ||
      !Array.isArray(checkpoint.optionSeatIds) ||
      checkpoint.optionSeatIds.some((seatId) => typeof seatId !== "string")
    ) {
      throw artifactIntegrity(
        "checkpoint_projection_artifact_contract_invalid",
      );
    }
    return {
      id: checkpoint.id,
      sequence: Number(checkpoint.sequence),
      optionSeatIds: checkpoint.optionSeatIds as string[],
    };
  }) as unknown as ReplayPremiereCheckpointProjection["checkpoints"];
  const projection = freezeReplayPremiereCheckpointProjection({
    premiereId: String(rawProjection.premiereId),
    publicationCommitmentHash: String(rawProjection.publicationCommitmentHash),
    checkpoints,
  });
  const artifact = {
    schemaVersion: value.schemaVersion,
    artifactKind: value.artifactKind,
    premiereId: value.premiereId,
    admissionRecordHash: value.admissionRecordHash,
    sourceReplaySha256: value.sourceReplaySha256,
    eligibilityRecordHash: value.eligibilityRecordHash,
    publicationCommitmentHash: value.publicationCommitmentHash,
    orderedDraftManifestRoot: value.orderedDraftManifestRoot,
    projection,
    artifactHash: value.artifactHash,
  } as ReplayPremiereCheckpointProjectionArtifactV1;
  const { artifactHash, ...preimage } = artifact;
  if (
    artifact.schemaVersion !== 1 ||
    artifact.artifactKind !== ARTIFACT_KIND ||
    !isSha256Hex(artifactHash) ||
    hashReplayPremiereJson(asJson(preimage)) !== artifactHash ||
    artifact.premiereId !== record.premiereId ||
    artifact.admissionRecordHash !== record.recordHash ||
    artifact.sourceReplaySha256 !== record.stagedSource.sourceReplaySha256 ||
    artifact.eligibilityRecordHash !== record.expectedEligibilityRecordHash ||
    artifact.publicationCommitmentHash !==
      record.expectedPublicationCommitmentHash ||
    artifact.orderedDraftManifestRoot !==
      record.expectedOrderedDraftManifestRoot
  ) {
    throw artifactIntegrity("checkpoint_projection_artifact_binding_mismatch");
  }
  const canonicalBytes = Buffer.from(
    `${canonicalReplayPremiereJson(asJson(artifact))}\n`,
    "utf8",
  );
  if (!Buffer.from(bytes).equals(canonicalBytes)) {
    throw artifactIntegrity("checkpoint_projection_artifact_not_canonical");
  }
  assertReplayPremiereCheckpointProjection({ projection, gate });
  return Object.freeze(artifact);
}

function assertAuthenticRecordGateBinding(
  record: ReplayPremiereAdmissionRecordV1,
  gate: VerifiedPremiereEligibilityGate,
): void {
  if (
    !VerifiedPremiereEligibilityGate.isAuthentic(gate) ||
    record.premiereId !== gate.premiereId ||
    record.expectedPublicationCommitmentHash !== gate.publicationCommitmentHash
  ) {
    throw artifactIntegrity("checkpoint_projection_artifact_gate_mismatch");
  }
}

function assertProductionLeakAuditOrigin(
  record: ReplayPremiereAdmissionRecordV1,
  publicOrigin: string,
): void {
  const targetUrls = [
    ...record.leakAuditReceipt.manifest.targets.map((target) => target.target),
    ...record.leakAuditReceipt.evidence.map((evidence) => evidence.target),
    ...record.eligibilityRecord.proxyWarLeakAuditManifest.targets.map(
      (target) => target.target,
    ),
    ...record.eligibilityRecord.proxyWarLeakChecks.map(
      (evidence) => evidence.target,
    ),
  ];
  for (const targetUrl of targetUrls) {
    let target: URL;
    try {
      target = new URL(targetUrl);
    } catch (error) {
      throw artifactIntegrity("startup_leak_audit_origin_mismatch", error);
    }
    if (target.origin !== publicOrigin) {
      throw artifactIntegrity("startup_leak_audit_origin_mismatch");
    }
  }
}

async function readBoundedArtifactFile(filePath: string): Promise<Uint8Array> {
  const before = await fs.lstat(filePath);
  validateArtifactFileStat(before);
  const handle = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    validateArtifactFileStat(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw artifactIntegrity(
        "checkpoint_projection_artifact_identity_changed_before_read",
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    validateArtifactFileStat(after);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      bytes.byteLength !== after.size
    ) {
      throw artifactIntegrity(
        "checkpoint_projection_artifact_changed_during_read",
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function validateArtifactFileStat(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o400 ||
    !ownedByCurrentProcess(stat.uid) ||
    stat.size <= 0 ||
    stat.size > MAX_ARTIFACT_BYTES
  ) {
    throw artifactIntegrity("checkpoint_projection_artifact_file_invalid");
  }
}

async function ensurePrivateArtifactDirectory(
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
    throw artifactIntegrity("checkpoint_projection_artifact_root_invalid");
  }
  const handle = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await handle.chmod(0o700);
    const opened = await handle.stat();
    if (
      !opened.isDirectory() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (opened.mode & 0o777) !== 0o700 ||
      !ownedByCurrentProcess(opened.uid)
    ) {
      throw artifactIntegrity("checkpoint_projection_artifact_root_invalid");
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
    throw artifactIntegrity("checkpoint_projection_artifact_root_alias");
  }
  await syncDirectory(canonicalParent);
  return canonical;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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

function isPublicationTemporaryName(name: string): boolean {
  const match = /^\.(prem_[a-z0-9]{16,32})\.([0-9a-f-]{36})\.tmp$/.exec(name);
  return match !== null && isPremiereId(match[1]);
}

function artifactFilenameBinding(
  name: string,
): { premiereId: string; admissionRecordHash: string } | null {
  if (!name.endsWith(ARTIFACT_SUFFIX)) return null;
  const stem = name.slice(0, -ARTIFACT_SUFFIX.length);
  const separator = stem.lastIndexOf(".");
  if (separator < 0) return null;
  const premiereId = stem.slice(0, separator);
  const admissionRecordHash = stem.slice(separator + 1);
  return isPremiereId(premiereId) && isSha256Hex(admissionRecordHash)
    ? { premiereId, admissionRecordHash }
    : null;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw artifactIntegrity("checkpoint_projection_artifact_unknown_fields");
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

function asJson(value: unknown): ReplayPremiereJsonValue {
  assertReplayPremiereJsonValue(value, "checkpoint projection artifact");
  return value as ReplayPremiereJsonValue;
}

function artifactIntegrity(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INTEGRITY_FAILURE",
    409,
    "Replay Premiere checkpoint projection artifact failed integrity validation",
    cause === undefined ? undefined : { cause },
  );
}
