import { constants, promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GameRecordSchema } from "../core/Schemas";
import { loadProxyWarDemoServerNetworkConfig } from "../server/agents/ProxyWarDemoServerConfig";
import {
  ReplayPremiereAdmissionCatalog,
  type ReplayPremiereAdmissionPublicationFaultInjector,
  type ReplayPremiereAdmissionRecordV1,
  type ReplayPremiereChunkBuildLimits,
} from "../server/replay-premiere/ReplayPremiereCatalog";
import {
  DeterministicReplayPremiereCheckpointProjector,
  type ReplayPremiereCheckpointProjector,
} from "../server/replay-premiere/ReplayPremiereCheckpointProjection";
import type { ReplayPremiereCheckpointProjectionArtifactV1 } from "../server/replay-premiere/ReplayPremiereCheckpointProjectionStore";
import { rebuildReplayPremiereProjectionInput } from "../server/replay-premiere/ReplayPremiereCheckpointProjectionStore";
import { buildPremiereChunks } from "../server/replay-premiere/ReplayPremiereChunks";
import {
  isPremiereId,
  REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS,
  type CoworldPremiereSourceIds,
  type PolicyIdentity,
  type PremiereEligibility,
  type PremiereExternalEmbargoEvidence,
  type PremierePublicLabel,
  type PremiereSeatIdentity,
  type PremiereSourceKind,
} from "../server/replay-premiere/ReplayPremiereContracts";
import {
  assessPremiereEligibility,
  buildRequiredProxyWarLeakAuditManifest,
  type PremiereEligibilityAssessmentOptions,
} from "../server/replay-premiere/ReplayPremiereEligibility";
import { ReplayPremiereError } from "../server/replay-premiere/ReplayPremiereErrors";
import type { PremiereReplayImportLimits } from "../server/replay-premiere/ReplayPremiereImport";
import {
  assertReplayPremiereJsonValue,
  canonicalReplayPremiereJson,
  isSha256Hex,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "../server/replay-premiere/ReplayPremiereIntegrity";
import {
  collectReplayPremiereLeakAudit,
  type ReplayPremiereLeakAuditCollectorLimits,
} from "../server/replay-premiere/ReplayPremiereLeakAuditCollector";
import {
  readVerifiedStagedPremiereSource,
  stagePremiereSource,
  validatePremierePrivateLayout,
} from "../server/replay-premiere/ReplayPremierePrivateStaging";
import {
  importControlledPremiereSourceForPublication,
  VerifiedPremiereEligibilityGate,
  type PremierePublicDefinition,
} from "../server/replay-premiere/ReplayPremierePublication";

const MIB = 1024 * 1024;
const MAX_SOURCE_BYTES = 256 * MIB;
const MAX_RESULT_BYTES = 2 * MIB;
const MAX_INPUT_JSON_BYTES = 1 * MIB;
const MAX_SERVED_ROOTS = 16;
export const REPLAY_PREMIERE_ADMISSION_PROJECTION_TIMEOUT_MS = 90_000;
/**
 * Chunk build span. At real-speed pacing (100 ms/turn nominal offsets) the
 * worst admitted show is 3,600 s of presentation (36k turns @1x), so 45 s
 * chunks keep the count at ~80-82 — well inside the 128-chunk journal-budget
 * cap — while bounding the viewer's presentation trail (a chunk releases at
 * its LAST record's time) to 45 s. Must stay at or below the
 * REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS validation ceiling (60 s).
 * History: 1,000 ms while nominal offsets were ~1 ms/turn.
 */
const MAX_PRESENTATION_SPAN_MS = 45_000;

const REPLAY_IMPORT_LIMITS: PremiereReplayImportLimits = Object.freeze({
  maxBootstrapBytes: 1 * MIB,
  maxTurnBytes: 1 * MIB,
  maxTurnRecords: 1_000_000,
  maxTotalTurnBytes: 128 * MIB,
});

const CHUNK_BUILD_LIMITS: ReplayPremiereChunkBuildLimits = Object.freeze({
  maxChunkBytes: 1 * MIB,
  maxTotalBytes: 128 * MIB,
  maxRecordsPerChunk: 1_000,
  maxPresentationSpanMs: MAX_PRESENTATION_SPAN_MS,
});

const COLLECTOR_LIMITS: ReplayPremiereLeakAuditCollectorLimits = Object.freeze({
  maxTargets: 256,
  maxTargetUrlBytes: 4_096,
  maxBodyBytesPerTarget: 1 * MIB,
  maxTotalBodyBytes: 4 * MIB,
  maxHeaderBytesPerTarget: 16_384,
  maxHeaderCountPerTarget: 64,
  requestTimeoutMs: 5_000,
  totalTimeoutMs: 60_000,
});

const REQUIRED_ARGUMENT_PREFIXES = [
  "--premiere-id=",
  "--source-file=",
  "--expected-source-sha256=",
  "--private-state-root=",
  "--eligibility-file=",
  "--definition-file=",
  "--deployment-origin=",
  "--nonce-file=",
] as const;
const REPEATED_ARGUMENT_PREFIX = "--served-root=";
// Optional: overrides the admitted chunk build's maxPresentationSpanMs (default
// MAX_PRESENTATION_SPAN_MS = 45s). Wagering-enabled premieres must be admitted
// with a span <= wagering's WAGERING_MAX_PRESENTATION_SPAN_MS (1s) or startup
// refuses to assemble them (`wagering_presentation_span_exceeds_ceiling`) — see
// ReplayPremiereStartup.ts. Non-wagering admissions should leave this unset.
const OPTIONAL_MAX_PRESENTATION_SPAN_MS_PREFIX = "--max-presentation-span-ms=";

interface ReplayPremiereAdmissionCliOptions {
  premiereId: string;
  sourceFile: string;
  expectedSourceSha256: string;
  privateStateRoot: string;
  servedRoots: string[];
  eligibilityFile: string;
  definitionFile: string;
  deploymentOrigin: string;
  nonceFile: string;
  maxPresentationSpanMs: number;
}

interface OperatorEligibilityInput {
  schemaVersion: 1;
  eligibilityCheckVersion: string;
  externalEmbargoEvidence: PremiereExternalEmbargoEvidence[];
  externalOutcomeMayBePublic: boolean;
  publicLabel: PremierePublicLabel;
}

interface SpoilerNeutralDefinitionInput extends Omit<
  PremierePublicDefinition,
  "provenance"
> {
  schemaVersion: 1;
}

interface StrictBundleAdmissionMaterial {
  sourceKind: PremiereSourceKind;
  sourceRunId: string;
  seats: PremiereSeatIdentity[];
  gameId: string;
  coworld: CoworldPremiereSourceIds | null;
  authoritativeResultSourceId: string;
  authoritativeResultHash: string;
  authoritativeResultBytes: Buffer;
}

export interface ReplayPremiereAdmissionSummary {
  premiereId: string;
  sourceRunId: string;
  sourceReplaySha256: string;
  eligibilityRecordHash: string;
  publicationCommitmentHash: string;
  orderedDraftManifestRoot: string;
  admissionRecordHash: string;
  deploymentOriginSha256: string;
}

export interface ReplayPremiereAdmissionDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  environment?: Record<string, string | undefined>;
  checkpointProjector?: ReplayPremiereCheckpointProjector;
  /**
   * Operator/orchestrator deadline for the deterministic checkpoint projection.
   * The catalog passes this exact signal through; aborting it must happen before
   * either the projection artifact or admission record becomes visible.
   */
  checkpointProjectionSignal?: AbortSignal;
  /** Test-only stricter override; production cannot exceed the fixed ceiling. */
  checkpointProjectionTimeoutMs?: number;
  afterCheckpointProjectionPublished?: (
    artifact: ReplayPremiereCheckpointProjectionArtifactV1,
  ) => void | Promise<void>;
  /** Test-only admission-record durability seam. */
  admissionPublicationFaultInjector?: ReplayPremiereAdmissionPublicationFaultInjector;
}

export interface ReplayPremiereAdmissionCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export async function runReplayPremiereAdmission(
  args = process.argv.slice(2),
  dependencies: ReplayPremiereAdmissionDependencies = {},
): Promise<ReplayPremiereAdmissionSummary> {
  const options = parseReplayPremiereAdmissionArgs(args);
  const deploymentOrigin = configuredReplayPremiereDeploymentOrigin(
    dependencies.environment ?? process.env,
  );
  if (options.deploymentOrigin !== deploymentOrigin) {
    throw cliFailure("admission_deployment_origin_mismatch");
  }
  const now = exactNow(dependencies.now?.() ?? new Date());
  const layout = await validatePremierePrivateLayout({
    privateStateRoot: options.privateStateRoot,
    servedRoots: options.servedRoots,
  });
  const [operatorInput, definitionInput, privateCommitmentNonce] =
    await Promise.all([
      readOperatorEligibilityInput(options.eligibilityFile),
      readSpoilerNeutralDefinitionInput(options.definitionFile),
      readPrivateCommitmentNonce(options.nonceFile, layout.servedRoots),
    ]);
  let catalog: ReplayPremiereAdmissionCatalog | null = null;
  try {
    catalog = await ReplayPremiereAdmissionCatalog.open({
      privateStateRoot: layout.privateStateRoot,
      servedRoots: layout.servedRoots,
      writerWaitMs: 1_000,
      admissionPublicationFaultInjector:
        dependencies.admissionPublicationFaultInjector,
    });
    const existing = await catalog.readAll();
    if (existing.failures.length > 0) {
      throw cliFailure("admission_catalog_not_clean");
    }
    const existingPremiere = existing.entries.find(
      (entry) => entry.premiereId === options.premiereId,
    );
    if (existingPremiere !== undefined) {
      return await exactExistingAdmissionSummary({
        record: existingPremiere,
        catalog,
        options,
        layout,
        operatorInput,
        definitionInput,
        privateCommitmentNonce,
        deploymentOrigin,
      });
    }
    await catalog.close();
    catalog = null;

    // Failure-retention contract: once this content-addressed copy exists, a
    // later import/probe/gate failure retains it as private integrity evidence.
    // This command never deletes replay evidence; an exact retry reuses it.
    const stagedSource = await stagePremiereSource({
      sourceFilePath: options.sourceFile,
      privateStateRoot: layout.privateStateRoot,
      servedRoots: layout.servedRoots,
      maxSourceBytes: MAX_SOURCE_BYTES,
      expectedSourceReplaySha256: options.expectedSourceSha256,
    });
    const verifiedSource = await readVerifiedStagedPremiereSource({
      stagedSource,
      privateStateRoot: layout.privateStateRoot,
      servedRoots: layout.servedRoots,
      maxSourceBytes: MAX_SOURCE_BYTES,
    });
    const sourceBytes = verifiedSource.copyBytes();
    const source = deriveStrictBundleAdmissionMaterial(sourceBytes);
    if (
      source.sourceKind === "rated_coworld" &&
      operatorInput.externalOutcomeMayBePublic !== true
    ) {
      // League standings make every rated episode outcome externally public;
      // an operator claim to the contrary is a false embargo claim.
      throw cliFailure("admission_rated_outcome_must_be_public");
    }
    const manifest = buildRequiredProxyWarLeakAuditManifest({
      origin: deploymentOrigin,
      sourceRunId: source.sourceRunId,
      createdAt: now.toISOString(),
      sourceKind: source.sourceKind,
      fingerprintBinding: {
        sourceReplaySha256: stagedSource.sourceReplaySha256,
        authoritativeResultSha256: source.authoritativeResultHash,
        authoritativeResultSourceId: source.authoritativeResultSourceId,
        gameIds: [source.gameId],
        seatIds: source.seats.map((seat) => seat.seatId),
        seatDisplayNames: source.seats.map((seat) => seat.displayName),
        ...(source.coworld === null
          ? {}
          : { coworldEpisodeId: source.coworld.episodeId }),
      },
    });
    const baseEligibility: PremiereEligibility = {
      schemaVersion: 1,
      eligibilityCheckVersion: operatorInput.eligibilityCheckVersion,
      createdAt: now.toISOString(),
      sourceKind: source.sourceKind,
      sourceRunId: source.sourceRunId,
      coworld: source.coworld,
      sourceReplaySha256: stagedSource.sourceReplaySha256,
      sourceBundleOutsideServedRoots: true,
      proxyWarLeakAuditManifest: manifest,
      proxyWarLeakChecks: [],
      externalEmbargoEvidence: operatorInput.externalEmbargoEvidence,
      externalOutcomeMayBePublic: operatorInput.externalOutcomeMayBePublic,
      seats: source.seats,
      authoritativeResult: {
        sourceKind:
          source.sourceKind === "rated_coworld"
            ? "coworld_result"
            : "controlled_result",
        sourceId: source.authoritativeResultSourceId,
        resultHash: source.authoritativeResultHash,
      },
      publicLabel: operatorInput.publicLabel,
    };
    const imported = importControlledPremiereSourceForPublication({
      sourceBytes,
      eligibilityRecord: baseEligibility,
      authoritativeResultBytes: source.authoritativeResultBytes,
      replayImportLimits: REPLAY_IMPORT_LIMITS,
    });
    const eligibilityOptions: PremiereEligibilityAssessmentOptions = {
      now,
      maxLeakCheckAgeMs: 5 * 60_000,
      maxExternalEvidenceAgeMs: 5 * 60_000,
      maxObservedBodyBytes: COLLECTOR_LIMITS.maxBodyBytesPerTarget,
      maxFutureClockSkewMs: 30_000,
      privateCommitmentNonce,
    };

    const leakAuditReceipt = await collectReplayPremiereLeakAudit({
      manifest,
      expectedOrigin: deploymentOrigin,
      assessmentOptions: eligibilityOptions,
      limits: COLLECTOR_LIMITS,
      ...(dependencies.fetch === undefined
        ? {}
        : { fetch: dependencies.fetch }),
      now: () => new Date(now),
    });
    const eligibilityRecord: PremiereEligibility = {
      ...baseEligibility,
      proxyWarLeakChecks: leakAuditReceipt.evidence(),
    };
    const assessment = assessPremiereEligibility(
      eligibilityRecord,
      eligibilityOptions,
    );
    if (!assessment.eligible) {
      throw cliFailure(
        assessment.operatorFailureCodes[0] ?? "admission_source_ineligible",
        "PREMIERE_SOURCE_INELIGIBLE",
        422,
      );
    }
    const publicDefinition = buildPublicDefinition({
      input: definitionInput,
      eligibilityRecord,
      eligibilityRecordHash: assessment.eligibilityRecordHash,
    });
    const chunkBuildLimits: ReplayPremiereChunkBuildLimits = {
      ...CHUNK_BUILD_LIMITS,
      maxPresentationSpanMs: options.maxPresentationSpanMs,
    };
    const draftChunks = buildPremiereChunks({
      premiereId: options.premiereId,
      records: imported.records,
      playbackRate: publicDefinition.playbackRate,
      checkpointSequences: publicDefinition.checkpoints.map(
        (checkpoint) => checkpoint.sequence,
      ),
      ...chunkBuildLimits,
    });
    const verification = {
      premiereId: options.premiereId,
      eligibilityRecord,
      eligibilityOptions,
      leakAuditReceipt,
      verifiedSource,
      authoritativeResultBytes: source.authoritativeResultBytes,
      replayImportLimits: REPLAY_IMPORT_LIMITS,
      publicDefinition,
      draftChunks,
      maxPresentationSpanMs: chunkBuildLimits.maxPresentationSpanMs,
    } satisfies Parameters<typeof VerifiedPremiereEligibilityGate.verify>[0];
    const gate = VerifiedPremiereEligibilityGate.verify(verification);
    const checkpointProjectionSignal =
      dependencies.checkpointProjectionSignal ?? new AbortController().signal;
    const checkpointProjection = await deadlineBoundCheckpointProjector({
      projector:
        dependencies.checkpointProjector ??
        new DeterministicReplayPremiereCheckpointProjector(
          path.join(process.cwd(), "resources", "maps"),
        ),
      timeoutMs:
        dependencies.checkpointProjectionTimeoutMs ??
        REPLAY_PREMIERE_ADMISSION_PROJECTION_TIMEOUT_MS,
    }).project({
      gate,
      drafts: verification.draftChunks,
      signal: checkpointProjectionSignal,
    });
    catalog = await ReplayPremiereAdmissionCatalog.open({
      privateStateRoot: layout.privateStateRoot,
      servedRoots: layout.servedRoots,
      writerWaitMs: 1_000,
      admissionPublicationFaultInjector:
        dependencies.admissionPublicationFaultInjector,
    });
    const current = await catalog.readAll();
    if (current.failures.length > 0) {
      throw cliFailure("admission_catalog_not_clean");
    }
    const concurrentlyAdmittedPremiere = current.entries.find(
      (entry) => entry.premiereId === options.premiereId,
    );
    if (concurrentlyAdmittedPremiere !== undefined) {
      return await exactExistingAdmissionSummary({
        record: concurrentlyAdmittedPremiere,
        catalog,
        options,
        layout,
        operatorInput,
        definitionInput,
        privateCommitmentNonce,
        deploymentOrigin,
      });
    }
    if (
      current.entries.some(
        (entry) =>
          entry.expectedPublicationCommitmentHash ===
          gate.publicationCommitmentHash,
      )
    ) {
      throw cliFailure("admission_commitment_already_exists");
    }
    const record = await catalog.writeVerifiedAdmission({
      gate,
      verification,
      chunkBuildLimits,
      collectorLimits: COLLECTOR_LIMITS,
      checkpointProjector: {
        async project() {
          return checkpointProjection;
        },
      },
      checkpointProjectionSignal,
      ...(dependencies.afterCheckpointProjectionPublished === undefined
        ? {}
        : {
            afterCheckpointProjectionPublished:
              dependencies.afterCheckpointProjectionPublished,
          }),
    });
    return admissionSummary(record, deploymentOrigin);
  } finally {
    await catalog?.close();
  }
}

export async function executeReplayPremiereAdmissionCli(
  args: string[],
  dependencies: ReplayPremiereAdmissionDependencies,
  io: ReplayPremiereAdmissionCliIo,
): Promise<number> {
  try {
    const summary = await runReplayPremiereAdmission(args, dependencies);
    io.stdout(`${JSON.stringify(summary)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`REPLAY_PREMIERE_ADMISSION_FAILED ${operatorCode(error)}\n`);
    return 1;
  }
}

function parseReplayPremiereAdmissionArgs(
  args: string[],
): ReplayPremiereAdmissionCliOptions {
  if (
    args.length === 0 ||
    args.some(
      (argument) =>
        !REQUIRED_ARGUMENT_PREFIXES.some((prefix) =>
          argument.startsWith(prefix),
        ) &&
        !argument.startsWith(REPEATED_ARGUMENT_PREFIX) &&
        !argument.startsWith(OPTIONAL_MAX_PRESENTATION_SPAN_MS_PREFIX),
    )
  ) {
    throw cliFailure("admission_unknown_or_missing_argument");
  }
  for (const prefix of REQUIRED_ARGUMENT_PREFIXES) {
    if (args.filter((argument) => argument.startsWith(prefix)).length !== 1) {
      throw cliFailure("admission_argument_cardinality_invalid");
    }
  }
  const maxPresentationSpanMsValues = valuesFor(
    args,
    OPTIONAL_MAX_PRESENTATION_SPAN_MS_PREFIX,
  );
  if (maxPresentationSpanMsValues.length > 1) {
    throw cliFailure("admission_argument_cardinality_invalid");
  }
  let maxPresentationSpanMs = MAX_PRESENTATION_SPAN_MS;
  if (maxPresentationSpanMsValues.length === 1) {
    const parsed = Number(maxPresentationSpanMsValues[0]);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed <= 0 ||
      parsed > REPLAY_PREMIERE_MAX_PRESENTATION_SPAN_MS
    ) {
      throw cliFailure("admission_argument_value_invalid");
    }
    maxPresentationSpanMs = parsed;
  }
  const servedRoots = valuesFor(args, REPEATED_ARGUMENT_PREFIX);
  if (
    servedRoots.length === 0 ||
    servedRoots.length > MAX_SERVED_ROOTS ||
    new Set(servedRoots.map((root) => path.resolve(root))).size !==
      servedRoots.length
  ) {
    throw cliFailure("admission_served_roots_invalid");
  }
  const options = {
    premiereId: singleValue(args, "--premiere-id="),
    sourceFile: singleValue(args, "--source-file="),
    expectedSourceSha256: singleValue(args, "--expected-source-sha256="),
    privateStateRoot: singleValue(args, "--private-state-root="),
    servedRoots,
    eligibilityFile: singleValue(args, "--eligibility-file="),
    definitionFile: singleValue(args, "--definition-file="),
    deploymentOrigin: singleValue(args, "--deployment-origin="),
    nonceFile: singleValue(args, "--nonce-file="),
    maxPresentationSpanMs,
  };
  const paths = [
    options.sourceFile,
    options.privateStateRoot,
    options.eligibilityFile,
    options.definitionFile,
    options.nonceFile,
    ...options.servedRoots,
  ];
  if (
    !isPremiereId(options.premiereId) ||
    !isSha256Hex(options.expectedSourceSha256) ||
    !options.sourceFile.endsWith(".source.json") ||
    paths.some((entry) => !path.isAbsolute(entry))
  ) {
    throw cliFailure("admission_argument_value_invalid");
  }
  let origin: URL;
  try {
    origin = new URL(options.deploymentOrigin);
  } catch {
    throw cliFailure("admission_expected_origin_invalid");
  }
  if (
    (origin.protocol !== "https:" && origin.protocol !== "http:") ||
    origin.origin !== options.deploymentOrigin ||
    origin.username !== "" ||
    origin.password !== ""
  ) {
    throw cliFailure("admission_expected_origin_invalid");
  }
  return options;
}

function valuesFor(args: string[], prefix: string): string[] {
  const values = args
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  if (values.some((value) => value.length === 0 || value.includes("\0"))) {
    throw cliFailure("admission_argument_value_invalid");
  }
  return values;
}

function singleValue(args: string[], prefix: string): string {
  const values = valuesFor(args, prefix);
  if (values.length !== 1) {
    throw cliFailure("admission_argument_cardinality_invalid");
  }
  return values[0];
}

async function readOperatorEligibilityInput(
  filePath: string,
): Promise<OperatorEligibilityInput> {
  const value = await readBoundedJson(filePath, "admission_eligibility_input");
  const record = exactRecord(
    value,
    [
      "schemaVersion",
      "eligibilityCheckVersion",
      "externalEmbargoEvidence",
      "externalOutcomeMayBePublic",
      "publicLabel",
    ],
    "admission_eligibility_input_invalid",
  );
  if (
    record.schemaVersion !== 1 ||
    typeof record.eligibilityCheckVersion !== "string" ||
    record.eligibilityCheckVersion.length === 0 ||
    record.eligibilityCheckVersion.length > 128 ||
    typeof record.externalOutcomeMayBePublic !== "boolean" ||
    (record.publicLabel !== "premiere" &&
      record.publicLabel !== "spoiler_resistant_premiere") ||
    !Array.isArray(record.externalEmbargoEvidence)
  ) {
    throw cliFailure("admission_eligibility_input_invalid");
  }
  const evidence = record.externalEmbargoEvidence.map((entry) => {
    const parsed = exactRecord(
      entry,
      ["source", "scope", "observedAt", "verifier", "embargoConfirmed"],
      "admission_eligibility_input_invalid",
    );
    if (
      typeof parsed.source !== "string" ||
      typeof parsed.scope !== "string" ||
      typeof parsed.observedAt !== "string" ||
      typeof parsed.verifier !== "string" ||
      typeof parsed.embargoConfirmed !== "boolean"
    ) {
      throw cliFailure("admission_eligibility_input_invalid");
    }
    return parsed as unknown as PremiereExternalEmbargoEvidence;
  });
  return {
    schemaVersion: 1,
    eligibilityCheckVersion: record.eligibilityCheckVersion,
    externalEmbargoEvidence: evidence,
    externalOutcomeMayBePublic: record.externalOutcomeMayBePublic,
    publicLabel: record.publicLabel,
  };
}

async function readSpoilerNeutralDefinitionInput(
  filePath: string,
): Promise<SpoilerNeutralDefinitionInput> {
  const value = await readBoundedJson(filePath, "admission_definition_input");
  const record = exactRecord(
    value,
    [
      "schemaVersion",
      "title",
      "spoilerNeutralDescription",
      "map",
      "matchFormat",
      "scheduledAt",
      "playbackRate",
      "checkpoints",
    ],
    "admission_definition_input_invalid",
  );
  const map = exactRecord(
    record.map,
    ["id", "label"],
    "admission_definition_input_invalid",
  );
  const matchFormat = exactRecord(
    record.matchFormat,
    ["id", "label", "seatCount"],
    "admission_definition_input_invalid",
  );
  if (!Array.isArray(record.checkpoints) || record.checkpoints.length !== 2) {
    throw cliFailure("admission_definition_input_invalid");
  }
  const checkpoints = record.checkpoints.map((value) => {
    const checkpoint = exactRecord(
      value,
      ["id", "sequence"],
      "admission_definition_input_invalid",
    );
    if (
      typeof checkpoint.id !== "string" ||
      !Number.isSafeInteger(checkpoint.sequence)
    ) {
      throw cliFailure("admission_definition_input_invalid");
    }
    return { id: checkpoint.id, sequence: Number(checkpoint.sequence) };
  }) as [{ id: string; sequence: number }, { id: string; sequence: number }];
  if (
    record.schemaVersion !== 1 ||
    typeof record.title !== "string" ||
    typeof record.spoilerNeutralDescription !== "string" ||
    typeof map.id !== "string" ||
    typeof map.label !== "string" ||
    typeof matchFormat.id !== "string" ||
    typeof matchFormat.label !== "string" ||
    !Number.isSafeInteger(matchFormat.seatCount) ||
    typeof record.scheduledAt !== "string" ||
    (record.playbackRate !== 1 &&
      record.playbackRate !== 2 &&
      record.playbackRate !== 4)
  ) {
    throw cliFailure("admission_definition_input_invalid");
  }
  return {
    schemaVersion: 1,
    title: record.title,
    spoilerNeutralDescription: record.spoilerNeutralDescription,
    map: { id: map.id, label: map.label },
    matchFormat: {
      id: matchFormat.id,
      label: matchFormat.label,
      seatCount: Number(matchFormat.seatCount),
    },
    scheduledAt: record.scheduledAt,
    playbackRate: record.playbackRate,
    checkpoints,
  };
}

function deriveStrictBundleAdmissionMaterial(
  bytes: Uint8Array,
): StrictBundleAdmissionMaterial {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw cliFailure("admission_source_invalid_json");
  }
  assertReplayPremiereJsonValue(value, "operator admission source");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw cliFailure("admission_source_contract_invalid");
  }
  const bundleKind = (value as Record<string, unknown>).bundleKind;
  const rated = bundleKind === "proxywar_rated_coworld_source";
  if (!rated && bundleKind !== "proxywar_controlled_exhibition_source") {
    throw cliFailure("admission_source_contract_invalid");
  }
  const source = exactRecord(
    value,
    [
      "schemaVersion",
      "bundleKind",
      "sourceRunId",
      "createdAt",
      "gameRecord",
      "replay",
      "authoritativeResult",
      "seats",
      ...(rated ? ["coworld"] : []),
      "provenance",
    ],
    "admission_source_contract_invalid",
  );
  if (
    source.schemaVersion !== 1 ||
    typeof source.sourceRunId !== "string" ||
    !Array.isArray(source.seats)
  ) {
    throw cliFailure("admission_source_contract_invalid");
  }
  let coworld: CoworldPremiereSourceIds | null = null;
  if (rated) {
    const coworldRecord = exactRecord(
      source.coworld,
      ["episodeId", "leagueId", "divisionId", "roundId"],
      "admission_source_coworld_invalid",
    );
    if (
      typeof coworldRecord.episodeId !== "string" ||
      typeof coworldRecord.leagueId !== "string" ||
      typeof coworldRecord.divisionId !== "string" ||
      typeof coworldRecord.roundId !== "string"
    ) {
      throw cliFailure("admission_source_coworld_invalid");
    }
    coworld = {
      episodeId: coworldRecord.episodeId,
      leagueId: coworldRecord.leagueId,
      divisionId: coworldRecord.divisionId,
      roundId: coworldRecord.roundId,
    };
  }
  const parsedGameRecord = GameRecordSchema.strict().safeParse(
    source.gameRecord,
  );
  if (!parsedGameRecord.success) {
    throw cliFailure("admission_source_game_record_invalid");
  }
  const seats = source.seats.map(parseSeatIdentity);
  const result = exactRecord(
    source.authoritativeResult,
    ["sourceId", "encoding", "bytes", "sha256"],
    "admission_source_result_invalid",
  );
  if (
    typeof result.sourceId !== "string" ||
    result.encoding !== "base64" ||
    typeof result.bytes !== "string" ||
    typeof result.sha256 !== "string" ||
    !isSha256Hex(result.sha256)
  ) {
    throw cliFailure("admission_source_result_invalid");
  }
  const resultBytes = Buffer.from(result.bytes, "base64");
  if (
    resultBytes.byteLength === 0 ||
    resultBytes.byteLength > MAX_RESULT_BYTES ||
    resultBytes.toString("base64") !== result.bytes ||
    sha256Hex(resultBytes) !== result.sha256
  ) {
    throw cliFailure("admission_source_result_invalid");
  }
  return {
    sourceKind: rated ? "rated_coworld" : "controlled_exhibition",
    sourceRunId: source.sourceRunId,
    seats,
    gameId: parsedGameRecord.data.info.gameID,
    coworld,
    authoritativeResultSourceId: result.sourceId,
    authoritativeResultHash: result.sha256,
    authoritativeResultBytes: resultBytes,
  };
}

function parseSeatIdentity(value: unknown): PremiereSeatIdentity {
  const seat = exactRecord(
    value,
    ["seatId", "displayName", "policyIdentity"],
    "admission_source_seat_invalid",
  );
  const policy = exactRecord(
    seat.policyIdentity,
    undefined,
    "admission_source_seat_invalid",
  );
  let policyIdentity: PolicyIdentity;
  if (policy.namespace === "softmax_policy_version") {
    assertExactKeys(
      policy,
      ["namespace", "policyVersionId", "policyName", "serverAssignedVersion"],
      "admission_source_seat_invalid",
    );
    if (
      typeof policy.policyVersionId !== "string" ||
      typeof policy.policyName !== "string" ||
      typeof policy.serverAssignedVersion !== "string"
    ) {
      throw cliFailure("admission_source_seat_invalid");
    }
    policyIdentity = {
      namespace: "softmax_policy_version",
      policyVersionId: policy.policyVersionId,
      policyName: policy.policyName,
      serverAssignedVersion: policy.serverAssignedVersion,
    };
  } else if (policy.namespace === "local_manifest") {
    assertExactKeys(
      policy,
      [
        "namespace",
        "manifestName",
        "declaredVersion",
        "manifestSha256",
        "contentSha256",
      ],
      "admission_source_seat_invalid",
    );
    if (
      typeof policy.manifestName !== "string" ||
      typeof policy.declaredVersion !== "string" ||
      typeof policy.manifestSha256 !== "string" ||
      typeof policy.contentSha256 !== "string"
    ) {
      throw cliFailure("admission_source_seat_invalid");
    }
    policyIdentity = {
      namespace: "local_manifest",
      manifestName: policy.manifestName,
      declaredVersion: policy.declaredVersion,
      manifestSha256: policy.manifestSha256,
      contentSha256: policy.contentSha256,
    };
  } else {
    throw cliFailure("admission_source_seat_invalid");
  }
  if (typeof seat.seatId !== "string" || typeof seat.displayName !== "string") {
    throw cliFailure("admission_source_seat_invalid");
  }
  return {
    seatId: seat.seatId,
    displayName: seat.displayName,
    policyIdentity,
  };
}

function buildPublicDefinition(options: {
  input: SpoilerNeutralDefinitionInput;
  eligibilityRecord: PremiereEligibility;
  eligibilityRecordHash: string;
}): PremierePublicDefinition {
  const { input, eligibilityRecord } = options;
  return {
    title: input.title,
    spoilerNeutralDescription: input.spoilerNeutralDescription,
    map: { ...input.map },
    matchFormat: { ...input.matchFormat },
    scheduledAt: input.scheduledAt,
    playbackRate: input.playbackRate,
    checkpoints: input.checkpoints.map((checkpoint) => ({ ...checkpoint })) as [
      { id: string; sequence: number },
      { id: string; sequence: number },
    ],
    provenance: {
      sourceKind: eligibilityRecord.sourceKind,
      sourceRunId: eligibilityRecord.sourceRunId,
      coworld: eligibilityRecord.coworld,
      sourceReplaySha256: eligibilityRecord.sourceReplaySha256,
      seats: eligibilityRecord.seats.map((seat) => ({
        seatId: seat.seatId,
        displayName: seat.displayName,
        policyIdentity: { ...seat.policyIdentity },
      })),
      publicLabel: eligibilityRecord.publicLabel,
      eligibilityRecordHash: options.eligibilityRecordHash,
    },
  };
}

/**
 * A retained admission retry may observe the catalog record written by its
 * previous process immediately before that process crashed. Reuse is safe only
 * when the durable record is the exact transaction described by the retained
 * inputs and its precomputed checkpoint projection is still present and
 * authentic. A shared premiere id or publication commitment alone is never an
 * identity proof.
 */
async function exactExistingAdmissionSummary(options: {
  record: ReplayPremiereAdmissionRecordV1;
  catalog: ReplayPremiereAdmissionCatalog;
  options: ReplayPremiereAdmissionCliOptions;
  layout: { privateStateRoot: string; servedRoots: readonly string[] };
  operatorInput: OperatorEligibilityInput;
  definitionInput: SpoilerNeutralDefinitionInput;
  privateCommitmentNonce: Buffer;
  deploymentOrigin: string;
}): Promise<ReplayPremiereAdmissionSummary> {
  const expectedSourceSha256 = options.options.expectedSourceSha256;
  if (
    options.record.stagedSource.sourceReplaySha256 !== expectedSourceSha256 ||
    options.record.eligibilityRecord.sourceReplaySha256 !== expectedSourceSha256
  ) {
    throw existingAdmissionUnavailable("admission_existing_identity_mismatch");
  }

  let retainedSource: Awaited<ReturnType<typeof stagePremiereSource>>;
  try {
    retainedSource = await stagePremiereSource({
      sourceFilePath: options.options.sourceFile,
      privateStateRoot: options.layout.privateStateRoot,
      servedRoots: options.layout.servedRoots,
      maxSourceBytes: MAX_SOURCE_BYTES,
      expectedSourceReplaySha256: options.options.expectedSourceSha256,
    });
  } catch (error) {
    if (
      error instanceof ReplayPremiereError &&
      error.operatorCode === "source_bundle_hash_mismatch"
    ) {
      throw existingAdmissionUnavailable(
        "admission_existing_identity_mismatch",
        error,
      );
    }
    throw existingAdmissionUnavailable(
      "admission_existing_identity_unverified",
      error,
    );
  }

  const { provenance: _provenance, ...storedDefinition } =
    options.record.publicDefinition;
  const storedEligibilityInput: OperatorEligibilityInput = {
    schemaVersion: 1,
    eligibilityCheckVersion:
      options.record.eligibilityRecord.eligibilityCheckVersion,
    externalEmbargoEvidence:
      options.record.eligibilityRecord.externalEmbargoEvidence,
    externalOutcomeMayBePublic:
      options.record.eligibilityRecord.externalOutcomeMayBePublic,
    publicLabel: options.record.eligibilityRecord.publicLabel,
  };
  const requestedDefinition = options.definitionInput;
  const storedDefinitionInput: SpoilerNeutralDefinitionInput = {
    schemaVersion: 1,
    ...storedDefinition,
  };
  const identityMatches =
    retainedSource.sourceReplaySha256 === expectedSourceSha256 &&
    retainedSource.byteLength === options.record.stagedSource.byteLength &&
    options.record.stagedSource.sourceReplaySha256 === expectedSourceSha256 &&
    options.record.eligibilityRecord.sourceReplaySha256 ===
      expectedSourceSha256 &&
    Buffer.from(
      options.record.assessment.privateCommitmentNonceBase64,
      "base64",
    ).equals(options.privateCommitmentNonce) &&
    sameCanonicalJson(storedEligibilityInput, options.operatorInput) &&
    sameCanonicalJson(storedDefinitionInput, requestedDefinition);
  if (!identityMatches) {
    throw existingAdmissionUnavailable("admission_existing_identity_mismatch");
  }

  try {
    const rebuilt = await rebuildReplayPremiereProjectionInput({
      record: options.record,
      privateStateRoot: options.layout.privateStateRoot,
      servedRoots: options.layout.servedRoots,
      maxSourceBytes: MAX_SOURCE_BYTES,
      publicOrigin: options.deploymentOrigin,
    });
    const projection = await options.catalog.loadCheckpointProjection({
      record: options.record,
      gate: rebuilt.gate,
    });
    if (projection === null) {
      throw existingAdmissionUnavailable(
        "admission_existing_projection_unavailable",
      );
    }
  } catch (error) {
    if (
      error instanceof ReplayPremiereError &&
      error.operatorCode === "admission_existing_projection_unavailable"
    ) {
      throw error;
    }
    throw existingAdmissionUnavailable(
      "admission_existing_projection_unavailable",
      error,
    );
  }
  return admissionSummary(options.record, options.deploymentOrigin);
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  assertReplayPremiereJsonValue(left, "existing admission identity");
  assertReplayPremiereJsonValue(right, "retained admission identity");
  return (
    canonicalReplayPremiereJson(left as ReplayPremiereJsonValue) ===
    canonicalReplayPremiereJson(right as ReplayPremiereJsonValue)
  );
}

function existingAdmissionUnavailable(
  operatorCode: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_UNAVAILABLE",
    503,
    "Replay Premiere could not prove an exact retained admission retry",
    cause === undefined ? undefined : { cause },
  );
}

async function readBoundedJson(
  filePath: string,
  operatorCodeValue: string,
): Promise<unknown> {
  const bytes = await readStableRegularFile(
    filePath,
    MAX_INPUT_JSON_BYTES,
    operatorCodeValue,
  );
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw cliFailure(operatorCodeValue);
  }
  assertReplayPremiereJsonValue(value, operatorCodeValue);
  return value;
}

async function readPrivateCommitmentNonce(
  filePath: string,
  servedRoots: readonly string[],
): Promise<Buffer> {
  const resolved = path.resolve(filePath);
  const canonicalBefore = await fs
    .realpath(resolved)
    .catch(() => "admission-nonce-unavailable");
  if (
    canonicalBefore !== resolved ||
    servedRoots.some((root) => pathsOverlap(root, canonicalBefore))
  ) {
    throw cliFailure("admission_nonce_file_invalid");
  }
  const bytes = await readStableRegularFile(
    resolved,
    64,
    "admission_nonce_file_invalid",
    { requireOwner: true, allowedModes: [0o400, 0o600] },
  );
  const canonicalAfter = await fs
    .realpath(resolved)
    .catch(() => "admission-nonce-unavailable");
  if (
    canonicalAfter !== canonicalBefore ||
    bytes.byteLength < 16 ||
    bytes.byteLength > 64
  ) {
    throw cliFailure("admission_nonce_file_invalid");
  }
  return bytes;
}

async function readStableRegularFile(
  filePath: string,
  maxBytes: number,
  operatorCodeValue: string,
  options: {
    requireOwner?: boolean;
    allowedModes?: readonly number[];
  } = {},
): Promise<Buffer> {
  const resolved = path.resolve(filePath);
  let before: Stats;
  try {
    before = await fs.lstat(resolved);
  } catch {
    throw cliFailure(operatorCodeValue);
  }
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > maxBytes ||
    (options.requireOwner === true && !ownedByCurrentProcess(before.uid)) ||
    (options.allowedModes !== undefined &&
      !options.allowedModes.includes(before.mode & 0o777))
  ) {
    throw cliFailure(operatorCodeValue);
  }
  const handle = await fs
    .open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(() => null);
  if (handle === null) throw cliFailure(operatorCodeValue);
  try {
    const openedBefore = await handle.stat();
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat();
    const pathAfter = await fs.lstat(resolved).catch(() => null);
    if (
      !openedBefore.isFile() ||
      before.dev !== openedBefore.dev ||
      before.ino !== openedBefore.ino ||
      before.mode !== openedBefore.mode ||
      before.uid !== openedBefore.uid ||
      openedBefore.dev !== openedAfter.dev ||
      openedBefore.ino !== openedAfter.ino ||
      openedBefore.size !== openedAfter.size ||
      openedBefore.mtimeMs !== openedAfter.mtimeMs ||
      openedBefore.mode !== openedAfter.mode ||
      openedBefore.uid !== openedAfter.uid ||
      openedAfter.nlink !== 1 ||
      bytes.byteLength !== openedAfter.size ||
      bytes.byteLength > maxBytes ||
      pathAfter === null ||
      pathAfter.dev !== openedAfter.dev ||
      pathAfter.ino !== openedAfter.ino ||
      pathAfter.isSymbolicLink() ||
      (options.requireOwner === true &&
        !ownedByCurrentProcess(openedAfter.uid)) ||
      (options.allowedModes !== undefined &&
        !options.allowedModes.includes(openedAfter.mode & 0o777))
    ) {
      throw cliFailure(operatorCodeValue);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[] | undefined,
  operatorCodeValue: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw cliFailure(operatorCodeValue);
  }
  const record = value as Record<string, unknown>;
  if (keys !== undefined) {
    assertExactKeys(record, keys, operatorCodeValue);
  }
  return record;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  operatorCodeValue: string,
): void {
  const actual = Object.keys(value).sort();
  const orderedExpected = [...expected].sort();
  if (
    actual.length !== orderedExpected.length ||
    actual.some((key, index) => key !== orderedExpected[index])
  ) {
    throw cliFailure(operatorCodeValue);
  }
}

function exactNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw cliFailure("admission_clock_invalid");
  }
  return new Date(value);
}

function pathsOverlap(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function ownedByCurrentProcess(uid: number): boolean {
  return process.getuid === undefined || process.getuid() === uid;
}

function admissionSummary(
  record: ReplayPremiereAdmissionRecordV1,
  deploymentOrigin: string,
): ReplayPremiereAdmissionSummary {
  return {
    premiereId: record.premiereId,
    sourceRunId: record.eligibilityRecord.sourceRunId,
    sourceReplaySha256: record.stagedSource.sourceReplaySha256,
    eligibilityRecordHash: record.expectedEligibilityRecordHash,
    publicationCommitmentHash: record.expectedPublicationCommitmentHash,
    orderedDraftManifestRoot: record.expectedOrderedDraftManifestRoot,
    admissionRecordHash: record.recordHash,
    deploymentOriginSha256: sha256Hex(deploymentOrigin),
  };
}

function deadlineBoundCheckpointProjector(options: {
  projector: ReplayPremiereCheckpointProjector;
  timeoutMs: number;
}): ReplayPremiereCheckpointProjector {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > REPLAY_PREMIERE_ADMISSION_PROJECTION_TIMEOUT_MS
  ) {
    throw cliFailure("admission_checkpoint_projection_timeout_invalid");
  }
  return {
    async project(projectOptions) {
      const controller = new AbortController();
      let deadlineExpired = false;
      let rejectFence: ((error: ReplayPremiereError) => void) | undefined;
      const fence = new Promise<never>((_resolve, reject) => {
        rejectFence = reject;
      });
      const abortFromCaller = (): void => {
        controller.abort();
        rejectFence?.(
          new ReplayPremiereError(
            "checkpoint_projection_aborted",
            "PREMIERE_UNAVAILABLE",
            503,
            "Replay Premiere checkpoint projection was aborted",
          ),
        );
      };
      projectOptions.signal.addEventListener("abort", abortFromCaller, {
        once: true,
      });
      if (projectOptions.signal.aborted) abortFromCaller();
      const timer = setTimeout(() => {
        deadlineExpired = true;
        controller.abort();
        rejectFence?.(
          cliFailure(
            "admission_checkpoint_projection_deadline_exceeded",
            "PREMIERE_UNAVAILABLE",
            503,
          ),
        );
      }, options.timeoutMs);
      timer.unref?.();
      const projection = Promise.resolve().then(() =>
        options.projector.project({
          ...projectOptions,
          signal: controller.signal,
        }),
      );
      void projection.catch(() => undefined);
      try {
        return await Promise.race([projection, fence]);
      } catch (error) {
        if (deadlineExpired) {
          throw cliFailure(
            "admission_checkpoint_projection_deadline_exceeded",
            "PREMIERE_UNAVAILABLE",
            503,
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
        projectOptions.signal.removeEventListener("abort", abortFromCaller);
      }
    },
  };
}

export function configuredReplayPremiereDeploymentOrigin(
  environment: Record<string, string | undefined>,
): string {
  const configured = loadProxyWarDemoServerNetworkConfig(environment).publicUrl;
  if (configured === null) {
    throw cliFailure("admission_deployment_origin_not_configured");
  }
  let origin: URL;
  try {
    origin = new URL(configured);
  } catch {
    throw cliFailure("admission_deployment_origin_not_configured");
  }
  if (
    (origin.protocol !== "https:" && origin.protocol !== "http:") ||
    origin.username !== "" ||
    origin.password !== ""
  ) {
    throw cliFailure("admission_deployment_origin_not_configured");
  }
  return origin.origin;
}

function cliFailure(
  operatorCodeValue: string,
  publicCode: ReplayPremiereError["publicCode"] = "PREMIERE_INVALID_REQUEST",
  httpStatus = 400,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCodeValue,
    publicCode,
    httpStatus,
    "Replay Premiere admission command rejected the operation",
  );
}

function operatorCode(error: unknown): string {
  return error instanceof ReplayPremiereError
    ? error.operatorCode
    : "admission_unavailable";
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const exitCode = await executeReplayPremiereAdmissionCli(
    process.argv.slice(2),
    {},
    {
      stdout: (line) => process.stdout.write(line),
      stderr: (line) => process.stderr.write(line),
    },
  );
  if (exitCode !== 0) process.exitCode = exitCode;
}
