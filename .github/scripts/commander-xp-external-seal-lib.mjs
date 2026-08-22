import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SEAL_REQUEST_FILE = "commander-xp-external-seal-request-v1.json";
export const BUNDLE_MANIFEST_FILE = "commander-xp-external-seal-bundle-v1.json";
export const TREE_DIFF_FILE = "commander-xp-source-tree-diff-v1.json";
export const BUNDLE_CHECKSUM_FILE = "SHA256SUMS";
export const EXTERNAL_RECEIPT_FILE =
  "commander-xp-external-seal-receipt-v1.json";
export const EXTERNAL_PHASE_LEDGER_FILE =
  "commander-xp-external-phase-ledger-v2.json";
const BUNDLE_REQUEST_PATH = `authority/${SEAL_REQUEST_FILE}`;

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^(?:sha256:)?([0-9a-f]{64})$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const COLLECTOR_WORKFLOW_PATH = ".github/workflows/commander-xp-evidence.yml";
const PHASES = new Set([
  "preregistration",
  "provider-preflight",
  "canary",
  "confirmatory",
]);
const ALLOWED_TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".sha256"]);
const ALLOWED_TOP_LEVEL_EVIDENCE = new Set([
  "commander-xp-preregistration-v2.json",
  "commander-xp-evidence-index-v2.json",
  "commander-xp-evidence-seal-v2.json",
  "policy-identities-v2.json",
  "eval-coworld-identity-v2.json",
  "eval-coworld-inspect.json",
  "eval-coworld-manifest-v2.json",
  "xp-openapi.sha256",
  "commander-xp-local-verification-v2.json",
  "commander-xp-prereg-ledger-v2.json",
  "commander-xp-prior-phase-ledger-v2.json",
  "commander-xp-confirmatory-activation-v2.json",
]);
const ALLOWED_RUN_SUFFIXES = new Set([
  "xp-evidence.json",
  "submitted-request.json",
  "create-response.json",
  "normalized-request-readback.json",
  "replay-evidence.json",
  "replay.json",
  "episode-results.json",
  "game-evidence.jsonl",
  "command-receipts.json",
  "coworld-bundle-receipt.json",
  "player-artifact/runtime-manifest.json",
  "player-artifact/trace.jsonl",
  "player-artifact/hashes.json",
]);
const PUBLIC_INLINE_JSON_ARTIFACTS = new Set([
  "game-record.json",
  "deal-ledger.json",
  "match-summary.json",
  "spectator-telemetry.json",
]);
const PUBLIC_INLINE_ROOT_KEYS = new Map([
  [
    "game-record.json",
    new Set(["domain", "gitCommit", "info", "subdomain", "turns", "version"]),
  ],
  [
    "deal-ledger.json",
    new Set([
      "actionEvidence",
      "deals",
      "decisionSteps",
      "events",
      "finalizedAtStep",
      "finalizedAtTurn",
      "matchID",
      "runID",
      "schemaVersion",
    ]),
  ],
  [
    "spectator-telemetry.json",
    new Set([
      "agents",
      "communicationThreads",
      "events",
      "generatedAt",
      "relationships",
      "runID",
      "timelineBuckets",
      "version",
    ]),
  ],
  [
    "match-summary.json",
    new Set([
      "acceptedCount",
      "actionCounts",
      "averageDecisionLatencyMs",
      "behaviorQuality",
      "behaviorQualityMarkdownPath",
      "behaviorQualityPath",
      "brainDecisionCount",
      "brainFallbackCount",
      "brainMode",
      "completedAt",
      "confirmedEffectCount",
      "decisionCount",
      "durationMs",
      "externalActionCallCount",
      "externalAgentCount",
      "externalAgentFeedbackMarkdownPath",
      "externalAgentFeedbackPath",
      "externalAgentFeedbackSummary",
      "externalAgentReadyForDeveloperReview",
      "externalAgentTopSuggestions",
      "externalPlannerCallCount",
      "failedEffectCount",
      "fallbackCount",
      "finalState",
      "matchID",
      "matchPackageHtmlPath",
      "matchPackageMarkdownPath",
      "matchPackagePath",
      "matchStory",
      "matchStoryMarkdownPath",
      "matchStoryPath",
      "notApplicableEffectCount",
      "notes",
      "objectiveAlignedDecisionCount",
      "objectiveAlignmentRate",
      "objectiveCounts",
      "objectiveScore",
      "objectiveScoreGrade",
      "objectiveScoreSummary",
      "objectiveScorecardMarkdownPath",
      "objectiveScorecardPath",
      "parseFailureCount",
      "planFollowedCount",
      "plannerFallbackCount",
      "plannerRunCount",
      "postSpawnNonHoldActionCount",
      "rawProviderOutputRecordCount",
      "rejectedCount",
      "roster",
      "runID",
      "runnerConfig",
      "runnerMode",
      "runtimeModes",
      "scenario",
      "spectator",
      "spectatorTelemetry",
      "spectatorTelemetryPath",
      "startedAt",
      "strategicPriorityCounts",
      "tacticalAffordances",
      "unknownEffectCount",
    ]),
  ],
]);
const FORBIDDEN_PRIVACY_KEYS = [
  "accesstoken",
  "apikey",
  "authorization",
  "commslottext",
  "credential",
  "messagebody",
  "messagetext",
  "modeltranscript",
  "password",
  "passphrase",
  "presigned",
  "privatekey",
  "providerrequestbody",
  "providerresponsebody",
  "providertranscript",
  "provideroutput",
  "prompttext",
  "rawprompt",
  "rawprovideroutput",
  "refreshtoken",
  "secret",
  "systemprompt",
];
const FORBIDDEN_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/,
  /(?:^|[?&])X-Amz-(?:Credential|Signature)=/i,
  /(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[A-Za-z0-9/+_.-]{16,}/i,
];
const FORBIDDEN_PRIVACY_TEXT = [
  "messageText",
  "commsSlotText",
  "externalRawOutput",
  "rawPrompt",
  "presigned",
  "AWS_",
  "COWORLD_PLAYER_ARTIFACT_UPLOAD_URL",
];

export class SealFailure extends Error {
  constructor(code, detail = null) {
    super(detail === null ? code : `${code}: ${detail}`);
    this.name = "SealFailure";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code, detail = null) {
  throw new SealFailure(code, detail);
}

export function normalizeSha256(value, field = "sha256") {
  const match = String(value ?? "").match(SHA256);
  if (!match) fail("SHA256_INVALID", field);
  return `sha256:${match[1]}`;
}

export function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function sha256File(filePath) {
  return sha256Bytes(await fs.readFile(filePath));
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

export function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 500)
    return false;
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    hasControlCharacters(value)
  )
    return false;
  const parsed = path.posix.normalize(value);
  return (
    parsed === value &&
    !parsed.startsWith("/") &&
    parsed !== "." &&
    parsed !== ".." &&
    !parsed.startsWith("../") &&
    !parsed.split("/").some((part) => part === "" || part.startsWith("."))
  );
}

export function safeSourcePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 500)
    return false;
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    hasControlCharacters(value)
  )
    return false;
  const parsed = path.posix.normalize(value);
  return (
    parsed === value &&
    !parsed.startsWith("/") &&
    parsed !== "." &&
    parsed !== ".." &&
    !parsed.startsWith("../") &&
    !parsed
      .split("/")
      .some(
        (part, index) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          (part.startsWith(".") && !(index === 0 && part === ".github")),
      )
  );
}

export async function readJsonFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    fail("JSON_INVALID", `${filePath}: ${error.message}`);
  }
  return parsed;
}

export async function writeJsonExclusive(filePath, value) {
  await fs.writeFile(filePath, canonicalJson(value), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function loadAndVerifySealRequest(
  evidenceRoot,
  expectedRequestSha256,
) {
  const requestPath = path.join(evidenceRoot, SEAL_REQUEST_FILE);
  const actualRequestSha256 = await sha256File(requestPath);
  if (
    actualRequestSha256 !==
    normalizeSha256(expectedRequestSha256, "expected request SHA-256")
  ) {
    fail("SEAL_REQUEST_HASH_MISMATCH");
  }
  const request = await readJsonFile(requestPath);
  exactKeys(
    request,
    [
      "schemaVersion",
      "experimentID",
      "phase",
      "sourceCI",
      "sourceArtifact",
      "source",
      "evidence",
      "preregistrationReceipt",
      "canaryReceipt",
    ],
    "SEAL_REQUEST_SCHEMA_INVALID",
  );
  if (
    request.schemaVersion !== 1 ||
    !SAFE_ID.test(request.experimentID) ||
    !PHASES.has(request.phase)
  ) {
    fail("SEAL_REQUEST_IDENTITY_INVALID");
  }
  validateSourceCIBinding(request.sourceCI);
  validateSourceArtifactBinding(request.sourceArtifact);
  validateSourceBinding(request.source);
  validateEvidenceBinding(request.evidence);
  if (request.phase === "preregistration") {
    if (request.preregistrationReceipt !== null)
      fail("PREREGISTRATION_REQUEST_MUST_NOT_BIND_PRIOR_RECEIPT");
  } else {
    validatePhaseReceiptBinding(
      request.preregistrationReceipt,
      "preregistration",
    );
  }
  if (request.phase !== "confirmatory") {
    if (request.canaryReceipt !== null)
      fail("CANARY_REQUEST_MUST_NOT_BIND_PRIOR_RECEIPT");
  } else {
    validateCanaryReceiptBinding(request.canaryReceipt);
  }
  return { request, requestPath, actualRequestSha256 };
}

function validateSourceArtifactBinding(binding) {
  exactKeys(
    binding,
    [
      "artifactID",
      "artifactName",
      "artifactDigest",
      "workflowRunID",
      "workflowRunAttempt",
      "workflowID",
      "workflowPath",
      "workflowName",
      "actor",
      "headRepository",
      "event",
      "ref",
    ],
    "SOURCE_ARTIFACT_BINDING_INVALID",
  );
  positiveInteger(binding.artifactID, "artifactID");
  positiveInteger(binding.workflowRunID, "workflowRunID");
  positiveInteger(binding.workflowRunAttempt, "workflowRunAttempt");
  positiveInteger(binding.workflowID, "workflowID");
  if (!SAFE_ID.test(binding.artifactName)) fail("SOURCE_ARTIFACT_NAME_INVALID");
  if (
    binding.workflowPath !== COLLECTOR_WORKFLOW_PATH ||
    binding.workflowName !== "Commander XP protected experiment evidence" ||
    binding.actor !== "0xNad" ||
    binding.headRepository !== "0xNad/ProxyWar" ||
    binding.event !== "workflow_dispatch" ||
    binding.ref !== "refs/heads/main" ||
    !binding.artifactName.endsWith(
      `-${binding.workflowRunID}-${binding.workflowRunAttempt}`,
    )
  )
    fail("SOURCE_ARTIFACT_AUTHORITY_INVALID");
  normalizeSha256(binding.artifactDigest, "source artifact digest");
}

function validateSourceCIBinding(binding) {
  exactKeys(
    binding,
    ["workflowID", "workflowPath", "runID", "runAttempt", "headSha"],
    "SOURCE_CI_BINDING_INVALID",
  );
  positiveInteger(binding.workflowID, "source CI workflow ID");
  positiveInteger(binding.runID, "source CI run ID");
  positiveInteger(binding.runAttempt, "source CI run attempt");
  if (binding.workflowPath !== CI_WORKFLOW_PATH || !SHA1.test(binding.headSha))
    fail("SOURCE_CI_BINDING_INVALID");
}

function validateSourceBinding(source) {
  exactKeys(
    source,
    [
      "behaviorBaseSha",
      "behaviorBaseTreeSha",
      "workflowSourceSha",
      "workflowSourceTreeSha",
      "sourceAllowlist",
    ],
    "SOURCE_BINDING_INVALID",
  );
  for (const field of [
    "behaviorBaseSha",
    "behaviorBaseTreeSha",
    "workflowSourceSha",
    "workflowSourceTreeSha",
  ]) {
    if (!SHA1.test(source[field])) fail("SOURCE_SHA_INVALID", field);
  }
  if (
    !Array.isArray(source.sourceAllowlist) ||
    source.sourceAllowlist.length === 0 ||
    source.sourceAllowlist.some((entry) => !safeSourcePath(entry)) ||
    new Set(source.sourceAllowlist).size !== source.sourceAllowlist.length ||
    [...source.sourceAllowlist]
      .sort()
      .some((entry, index) => entry !== source.sourceAllowlist[index])
  ) {
    fail("SOURCE_ALLOWLIST_INVALID");
  }
}

function validateEvidenceBinding(evidence) {
  exactKeys(
    evidence,
    [
      "preRegistrationPath",
      "preRegistrationSha256",
      "localIndexPath",
      "localIndexSha256",
      "localSealPath",
      "localSealFileSha256",
      "localSealSha256",
      "aggregatePath",
      "aggregateSha256",
    ],
    "EVIDENCE_BINDING_INVALID",
  );
  for (const field of [
    "preRegistrationPath",
    "localIndexPath",
    "localSealPath",
    "aggregatePath",
  ]) {
    if (!safeRelativePath(evidence[field]))
      fail("EVIDENCE_PATH_INVALID", field);
  }
  for (const field of [
    "preRegistrationSha256",
    "localIndexSha256",
    "localSealFileSha256",
    "localSealSha256",
    "aggregateSha256",
  ]) {
    normalizeSha256(evidence[field], field);
  }
}

function validatePhaseReceiptBinding(binding, expectedPhase) {
  exactKeys(
    binding,
    [
      "path",
      "sha256",
      "ledgerSha256",
      "runId",
      "attempt",
      "evidenceArtifact",
      "receiptArtifact",
      "localSealSha256",
      "workflowPath",
      "experimentID",
      "behaviorBaseSha",
      "behaviorBaseTreeSha",
      "headSha",
      "treeSha",
    ],
    "PHASE_RECEIPT_BINDING_INVALID",
  );
  const expectedPath =
    expectedPhase === "preregistration"
      ? "commander-xp-prereg-ledger-v2.json"
      : "commander-xp-prior-phase-ledger-v2.json";
  if (binding.path !== expectedPath)
    fail("PHASE_RECEIPT_PATH_INVALID", expectedPhase);
  normalizeSha256(binding.sha256, `${expectedPhase} receipt SHA-256`);
  normalizeRawSha256(binding.ledgerSha256, `${expectedPhase} ledger SHA-256`);
  if (!/^\d+$/.test(binding.runId)) fail("PHASE_RECEIPT_RUN_ID_INVALID");
  positiveInteger(binding.attempt, `${expectedPhase} workflow run attempt`);
  validateLedgerEvidenceArtifact(binding.evidenceArtifact);
  validateLedgerReceiptArtifact(binding.receiptArtifact);
  normalizeRawSha256(
    binding.localSealSha256,
    `${expectedPhase} local seal SHA-256`,
  );
  if (
    binding.workflowPath !==
      ".github/workflows/commander-xp-external-seal.yml" ||
    !SAFE_ID.test(binding.experimentID) ||
    !SHA1.test(binding.behaviorBaseSha) ||
    !SHA1.test(binding.behaviorBaseTreeSha) ||
    !SHA1.test(binding.headSha) ||
    !SHA1.test(binding.treeSha)
  )
    fail("PHASE_RECEIPT_SOURCE_INVALID");
}

function validateCanaryReceiptBinding(binding) {
  validatePhaseReceiptBinding(binding, "canary");
}

export async function verifyGitSourceIdentity({ repository, source }) {
  const status = await git(repository, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") fail("SOURCE_WORKTREE_DIRTY");
  const headSha = await git(repository, ["rev-parse", "HEAD"]);
  const headTreeSha = await git(repository, ["rev-parse", "HEAD^{tree}"]);
  const baseTreeSha = await git(repository, [
    "rev-parse",
    `${source.behaviorBaseSha}^{tree}`,
  ]);
  if (
    headSha !== source.workflowSourceSha ||
    headTreeSha !== source.workflowSourceTreeSha ||
    baseTreeSha !== source.behaviorBaseTreeSha
  ) {
    fail("SOURCE_GIT_IDENTITY_MISMATCH");
  }
  try {
    await git(repository, [
      "merge-base",
      "--is-ancestor",
      source.behaviorBaseSha,
      source.workflowSourceSha,
    ]);
  } catch {
    fail("BEHAVIOR_BASE_NOT_ANCESTOR");
  }
  return { headSha, headTreeSha, baseTreeSha };
}

export async function buildTreeDiffManifest({ repository, source }) {
  await verifyGitSourceIdentity({ repository, source });
  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      repository,
      "diff-tree",
      "-r",
      "--no-commit-id",
      "--no-renames",
      "--raw",
      "-z",
      source.behaviorBaseSha,
      source.workflowSourceSha,
    ],
    { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 },
  );
  const entries = parseRawDiff(stdout);
  const actualPaths = entries.map((entry) => entry.path).sort();
  if (
    actualPaths.length !== source.sourceAllowlist.length ||
    actualPaths.some((entry, index) => entry !== source.sourceAllowlist[index])
  ) {
    fail("SOURCE_DIFF_ALLOWLIST_MISMATCH");
  }
  const hydrated = [];
  for (const entry of entries.sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const content = await gitBuffer(repository, [
      "show",
      `${source.workflowSourceSha}:${entry.path}`,
    ]);
    hydrated.push({
      ...entry,
      baseBlob: /^0+$/.test(entry.baseBlob) ? null : entry.baseBlob,
      contentSha256: sha256Bytes(content),
      bytes: content.byteLength,
    });
  }
  return {
    schemaVersion: 1,
    behaviorBaseSha: source.behaviorBaseSha,
    behaviorBaseTreeSha: source.behaviorBaseTreeSha,
    workflowSourceSha: source.workflowSourceSha,
    workflowSourceTreeSha: source.workflowSourceTreeSha,
    allowlistMode: "exact",
    entries: hydrated,
  };
}

function parseRawDiff(buffer) {
  if (buffer.byteLength === 0) fail("SOURCE_DIFF_EMPTY");
  const tokens = buffer.toString("utf8").split("\0");
  if (tokens.at(-1) !== "") fail("SOURCE_DIFF_RAW_INVALID");
  tokens.pop();
  const entries = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const header = tokens[index];
    const filePath = tokens[index + 1];
    const match = header?.match(
      /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/,
    );
    if (!match || !safeSourcePath(filePath)) fail("SOURCE_DIFF_RAW_INVALID");
    const [, baseMode, headMode, baseBlob, headBlob, status] = match;
    if (!new Set(["A", "M"]).has(status))
      fail("SOURCE_DIFF_STATUS_FORBIDDEN", `${status}:${filePath}`);
    if (!["100644", "100755"].includes(headMode))
      fail("SOURCE_DIFF_OBJECT_TYPE_FORBIDDEN", `${headMode}:${filePath}`);
    if (status === "M" && !["100644", "100755"].includes(baseMode)) {
      fail("SOURCE_DIFF_BASE_OBJECT_TYPE_FORBIDDEN", `${baseMode}:${filePath}`);
    }
    if (entries.some((entry) => entry.path === filePath))
      fail("SOURCE_DIFF_DUPLICATE_PATH", filePath);
    entries.push({
      status,
      path: filePath,
      baseMode: status === "A" ? null : baseMode,
      headMode,
      baseBlob,
      headBlob,
    });
  }
  return entries;
}

export async function verifyArtifactMetadata(metadata, expected) {
  exactKeys(
    metadata,
    ["artifact", "workflowRun", "repository"],
    "ARTIFACT_METADATA_SCHEMA_INVALID",
  );
  const artifact = metadata.artifact;
  const run = metadata.workflowRun;
  if (!isRecord(artifact) || !isRecord(run) || !isRecord(metadata.repository))
    fail("ARTIFACT_METADATA_SCHEMA_INVALID");
  const runStateValid =
    expected.allowCurrentRunInProgress === true
      ? run.status === "in_progress" && run.conclusion === null
      : run.status === "completed" && run.conclusion === "success";
  if (
    artifact.id !== expected.artifactID ||
    artifact.name !== expected.artifactName ||
    normalizeSha256(artifact.digest, "artifact API digest") !==
      normalizeSha256(expected.artifactDigest, "expected artifact digest") ||
    artifact.expired !== false ||
    !artifact.archive_download_url ||
    artifact.workflow_run?.id !== expected.workflowRunID ||
    run.id !== expected.workflowRunID ||
    run.run_attempt !== expected.workflowRunAttempt ||
    !runStateValid ||
    run.event !== "workflow_dispatch" ||
    metadata.repository.visibility !== "public" ||
    (expected.headSha !== undefined && run.head_sha !== expected.headSha) ||
    (expected.repository !== undefined &&
      metadata.repository.full_name !== expected.repository) ||
    (expected.workflowID !== undefined &&
      run.workflow_id !== expected.workflowID) ||
    (expected.workflowPath !== undefined &&
      run.path !== expected.workflowPath) ||
    (expected.actor !== undefined && run.actor?.login !== expected.actor) ||
    (expected.headRepository !== undefined &&
      run.head_repository?.full_name !== expected.headRepository) ||
    artifact.workflow_run?.head_sha !== run.head_sha ||
    artifact.workflow_run?.head_repository_id !== run.head_repository?.id
  ) {
    fail("ARTIFACT_METADATA_IDENTITY_MISMATCH");
  }
  const createdAt = Date.parse(artifact.created_at ?? "");
  const expiresAt = Date.parse(artifact.expires_at ?? "");
  if (
    !Number.isFinite(createdAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  )
    fail("ARTIFACT_EXPIRED_OR_EXPIRY_INVALID");
  if (
    expected.minRetentionDays !== undefined &&
    expiresAt - createdAt < expected.minRetentionDays * 86_400_000
  ) {
    fail("ARTIFACT_RETENTION_TOO_SHORT");
  }
  return true;
}

export function verifySourceCIMetadata(metadata, binding) {
  validateSourceCIBinding(binding);
  if (
    !isRecord(metadata) ||
    metadata.id !== binding.runID ||
    metadata.run_attempt !== binding.runAttempt ||
    metadata.workflow_id !== binding.workflowID ||
    metadata.path !== binding.workflowPath ||
    metadata.head_sha !== binding.headSha ||
    metadata.head_repository?.full_name !== "0xNad/ProxyWar" ||
    metadata.repository?.full_name !== "0xNad/ProxyWar" ||
    metadata.actor?.login !== "0xNad" ||
    metadata.status !== "completed" ||
    metadata.conclusion !== "success" ||
    !["push", "workflow_dispatch"].includes(metadata.event)
  ) {
    fail("SOURCE_CI_METADATA_IDENTITY_MISMATCH");
  }
  return true;
}

export async function verifyEvidenceBindings({
  evidenceRoot,
  request,
  verifierAggregatePath,
}) {
  const boundFiles = {};
  for (const [pathField, hashField] of [
    ["preRegistrationPath", "preRegistrationSha256"],
    ["localIndexPath", "localIndexSha256"],
    ["localSealPath", "localSealFileSha256"],
    ["aggregatePath", "aggregateSha256"],
  ]) {
    const absolute = await containedRegularFile(
      evidenceRoot,
      request.evidence[pathField],
    );
    const digest = await sha256File(absolute);
    if (digest !== normalizeSha256(request.evidence[hashField], hashField))
      fail("EVIDENCE_BOUND_HASH_MISMATCH", request.evidence[pathField]);
    boundFiles[pathField] = absolute;
  }
  const prereg = await readJsonFile(boundFiles.preRegistrationPath);
  const index = await readJsonFile(boundFiles.localIndexPath);
  const localSeal = await readJsonFile(boundFiles.localSealPath);
  const aggregate = await readJsonFile(boundFiles.aggregatePath);
  const rerunAggregate = await readJsonFile(verifierAggregatePath);
  const preregCreatedAt = Date.parse(prereg.createdAt ?? "");
  if (!Number.isFinite(preregCreatedAt))
    fail("PREREGISTRATION_CREATED_AT_INVALID");
  if (canonicalJson(aggregate) !== canonicalJson(rerunAggregate))
    fail("VERIFIER_AGGREGATE_RERUN_MISMATCH");
  if (
    prereg.experimentID !== request.experimentID ||
    prereg.identities?.behaviorSourceSha !== request.source.behaviorBaseSha ||
    prereg.identities?.behaviorSourceTreeSha !==
      request.source.behaviorBaseTreeSha ||
    prereg.identities?.adapterSourceSha !== request.source.workflowSourceSha ||
    prereg.identities?.adapterSourceTreeSha !==
      request.source.workflowSourceTreeSha
  ) {
    fail("PREREGISTRATION_SOURCE_IDENTITY_MISMATCH");
  }
  if (
    index.experimentID !== request.experimentID ||
    index.phase !== request.phase ||
    localSeal.experimentID !== request.experimentID ||
    localSeal.phase !== request.phase ||
    localSeal.status !== "complete" ||
    normalizeSha256(localSeal.sealSha256, "local seal") !==
      normalizeSha256(request.evidence.localSealSha256, "bound local seal")
  ) {
    fail("LOCAL_INDEX_SEAL_IDENTITY_MISMATCH");
  }
  if (
    aggregate.schemaVersion !== 2 ||
    aggregate.integrityVerified !== true ||
    aggregate.experimentUsable !== false ||
    aggregate.phase !== request.phase ||
    aggregate.performanceClaimAuthorized !== false ||
    aggregate.authenticity?.verified !== false ||
    aggregate.authenticity?.status !== "external-seal-receipt-required" ||
    normalizeSha256(aggregate.authenticity?.sealSha256, "aggregate seal") !==
      normalizeSha256(localSeal.sealSha256, "local seal")
  ) {
    fail("AGGREGATE_NOT_READY_FOR_EXTERNAL_SEAL");
  }
  if (request.phase === "confirmatory") {
    await verifyBoundCanaryReceipt(evidenceRoot, request, index);
  }
  if (request.phase === "preregistration") {
    const actualFiles = await inventoryRegularFiles(evidenceRoot);
    if (
      !Array.isArray(index.artifacts) ||
      index.artifacts.some((artifact) =>
        String(artifact?.path ?? "").startsWith("runs/"),
      ) ||
      actualFiles.some((artifact) => artifact.path.startsWith("runs/"))
    ) {
      fail("PREREGISTRATION_RUN_EVIDENCE_FORBIDDEN");
    }
  } else {
    const preregLedger = await verifyBoundPhaseReceipt(
      evidenceRoot,
      request,
      request.preregistrationReceipt,
      "preregistration",
    );
    if (Date.parse(preregLedger.completedAt) < preregCreatedAt)
      fail("PREREGISTRATION_LEDGER_CHRONOLOGY_INVALID");
  }
  return { prereg, index, localSeal, aggregate };
}

async function verifyBoundPhaseReceipt(
  evidenceRoot,
  request,
  binding,
  expectedPhase,
) {
  const ledgerPath = await containedRegularFile(evidenceRoot, binding.path);
  if ((await sha256File(ledgerPath)) !== normalizeSha256(binding.sha256))
    fail("PHASE_RECEIPT_HASH_MISMATCH", expectedPhase);
  const ledger = await verifyExternalPhaseLedger(ledgerPath, {
    phase: expectedPhase,
    experimentID: request.experimentID,
    behaviorBaseSha: request.source.behaviorBaseSha,
    behaviorBaseTreeSha: request.source.behaviorBaseTreeSha,
    headSha: request.source.workflowSourceSha,
    treeSha: request.source.workflowSourceTreeSha,
  });
  if (
    ledger.ledgerSha256 !== binding.ledgerSha256 ||
    ledger.runId !== binding.runId ||
    ledger.attempt !== binding.attempt ||
    canonicalJson(ledger.evidenceArtifact) !==
      canonicalJson(binding.evidenceArtifact) ||
    canonicalJson(ledger.receiptArtifact) !==
      canonicalJson(binding.receiptArtifact) ||
    ledger.evidenceArtifact.localSealSha256 !== binding.localSealSha256 ||
    binding.workflowPath !== ledger.workflowPath ||
    binding.experimentID !== request.experimentID ||
    binding.behaviorBaseSha !== request.source.behaviorBaseSha ||
    binding.behaviorBaseTreeSha !== request.source.behaviorBaseTreeSha ||
    binding.headSha !== request.source.workflowSourceSha ||
    binding.treeSha !== request.source.workflowSourceTreeSha ||
    ledger.preRegistrationSha256 !==
      normalizeRawSha256(
        request.evidence.preRegistrationSha256,
        "bound preregistration SHA-256",
      )
  ) {
    fail("PHASE_RECEIPT_BINDING_MISMATCH", expectedPhase);
  }
  return ledger;
}

async function verifyBoundCanaryReceipt(evidenceRoot, request, index) {
  const binding = request.canaryReceipt;
  await verifyBoundPhaseReceipt(evidenceRoot, request, binding, "canary");
  if (
    normalizeRawSha256(
      index.canarySealSha256,
      "confirmatory canary local seal",
    ) !== binding.localSealSha256
  ) {
    fail("CONFIRMATORY_CANARY_LOCAL_SEAL_MISMATCH");
  }
}

export async function scanPrivacyAndInventory(root) {
  const files = await inventoryRegularFiles(root);
  let totalBytes = 0;
  const inventory = [];
  for (const entry of files) {
    if (!allowedEvidencePath(entry.path))
      fail("EVIDENCE_PATH_NOT_IN_PROTOCOL_ALLOWLIST", entry.path);
    totalBytes += entry.bytes;
    if (entry.bytes > MAX_FILE_BYTES || totalBytes > MAX_BUNDLE_BYTES)
      fail("EVIDENCE_SIZE_LIMIT_EXCEEDED", entry.path);
    if (!ALLOWED_TEXT_EXTENSIONS.has(path.posix.extname(entry.path)))
      fail("EVIDENCE_NON_TEXT_FILE_FORBIDDEN", entry.path);
    const bytes = await fs.readFile(path.join(root, entry.path));
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("EVIDENCE_UTF8_INVALID", entry.path);
    }
    for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
      if (pattern.test(text)) fail("PRIVACY_VALUE_FORBIDDEN", entry.path);
    }
    for (const forbidden of FORBIDDEN_PRIVACY_TEXT) {
      if (text.includes(forbidden))
        fail("PRIVACY_TEXT_FORBIDDEN", `${entry.path}:${forbidden}`);
    }
    const extension = path.posix.extname(entry.path);
    if (extension === ".json") {
      inspectJsonPrivacy(parseJsonText(text, entry.path), entry.path);
    } else if (extension === ".jsonl") {
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (line === "") continue;
        inspectJsonPrivacy(
          parseJsonText(line, `${entry.path}:${index + 1}`),
          entry.path,
        );
      }
    }
    inventory.push({
      path: entry.path,
      bytes: entry.bytes,
      sha256: sha256Bytes(bytes),
    });
  }
  await validateCoworldProjectionReceipts(root, inventory);
  return { fileCount: inventory.length, totalBytes, files: inventory };
}

async function validateCoworldProjectionReceipts(root, inventory) {
  const runRoots = new Set();
  for (const entry of inventory) {
    const match = entry.path.match(
      /^(runs\/(?:provider-preflight|canary|confirmatory)\/r\d{2}\/(?:A|B|C))\//,
    );
    if (match) runRoots.add(match[1]);
  }
  const hashes = new Map(inventory.map((entry) => [entry.path, entry.sha256]));
  for (const runRoot of runRoots) {
    const receiptPath = `${runRoot}/coworld-bundle-receipt.json`;
    const receipt = await readJsonFile(path.join(root, receiptPath));
    exactKeys(
      receipt,
      [
        "schemaVersion",
        "authority",
        "downloadedAt",
        "xpRequestID",
        "episodeRequestID",
        "jobID",
        "episodeID",
        "outerBundleSha256",
        "members",
        "projections",
      ],
      "COWORLD_BUNDLE_RECEIPT_SCHEMA_INVALID",
    );
    if (
      receipt.schemaVersion !== 2 ||
      receipt.authority !== "coworld-authenticated-bundle-projection-v1" ||
      !Number.isFinite(Date.parse(receipt.downloadedAt)) ||
      [
        receipt.xpRequestID,
        receipt.episodeRequestID,
        receipt.jobID,
        receipt.episodeID,
      ].some((value) => !SAFE_ID.test(value)) ||
      !Array.isArray(receipt.members) ||
      receipt.members.length < 1
    ) {
      fail("COWORLD_BUNDLE_RECEIPT_IDENTITY_INVALID", receiptPath);
    }
    normalizeRawSha256(
      receipt.outerBundleSha256,
      "Coworld outer bundle SHA-256",
    );
    const memberPaths = new Set();
    for (const member of receipt.members) {
      exactKeys(
        member,
        ["path", "bytes", "sha256"],
        "COWORLD_BUNDLE_MEMBER_SCHEMA_INVALID",
      );
      if (
        !safeRelativePath(member.path) ||
        memberPaths.has(member.path) ||
        !Number.isSafeInteger(member.bytes) ||
        member.bytes < 0
      ) {
        fail("COWORLD_BUNDLE_MEMBER_INVALID", receiptPath);
      }
      normalizeRawSha256(member.sha256, "Coworld bundle member SHA-256");
      memberPaths.add(member.path);
    }
    exactKeys(
      receipt.projections,
      ["episodeResultsSha256", "gameEvidenceSha256", "commandReceiptsSha256"],
      "COWORLD_BUNDLE_PROJECTION_SCHEMA_INVALID",
    );
    for (const [field, suffix] of [
      ["episodeResultsSha256", "episode-results.json"],
      ["gameEvidenceSha256", "game-evidence.jsonl"],
      ["commandReceiptsSha256", "command-receipts.json"],
    ]) {
      const actual = hashes.get(`${runRoot}/${suffix}`);
      if (
        actual === undefined ||
        normalizeSha256(receipt.projections[field], field) !== actual
      ) {
        fail(
          "COWORLD_BUNDLE_PROJECTION_HASH_MISMATCH",
          `${receiptPath}:${field}`,
        );
      }
    }
  }
}

function allowedEvidencePath(filePath) {
  if (ALLOWED_TOP_LEVEL_EVIDENCE.has(filePath)) return true;
  if (/^policy-inspect\/(?:A|B|C)\.json$/.test(filePath)) return true;
  const match = filePath.match(
    /^runs\/(?:provider-preflight|canary|confirmatory)\/r\d{2}\/(?:A|B|C)\/(.+)$/,
  );
  return match !== null && ALLOWED_RUN_SUFFIXES.has(match[1]);
}

function inspectJsonPrivacy(
  value,
  filePath,
  rejectJsonEncodedString = false,
  allowJsonEncodedString = false,
) {
  if (typeof value === "string") {
    if (
      rejectJsonEncodedString &&
      !allowJsonEncodedString &&
      isJsonEncodedEnvelope(value)
    )
      fail("INLINE_NESTED_JSON_ENVELOPE_FORBIDDEN", filePath);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value)
      inspectJsonPrivacy(item, filePath, rejectJsonEncodedString);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (key === "inlineRunArtifacts") {
      inspectInlineRunArtifacts(item, filePath);
      continue;
    }
    if (
      key === "rawProviderOutputRecordCount" &&
      Number.isSafeInteger(item) &&
      item >= 0
    ) {
      continue;
    }
    if (
      FORBIDDEN_PRIVACY_KEYS.some((forbidden) => normalized.includes(forbidden))
    )
      fail("PRIVACY_KEY_FORBIDDEN", `${filePath}:${key}`);
    inspectJsonPrivacy(
      item,
      filePath,
      rejectJsonEncodedString,
      key === "text" && value.type === "agent_message",
    );
  }
}

function inspectInlineRunArtifacts(value, filePath) {
  if (!isRecord(value)) fail("INLINE_RUN_ARTIFACTS_SCHEMA_INVALID", filePath);
  for (const [artifactName, encoded] of Object.entries(value)) {
    if (
      !PUBLIC_INLINE_JSON_ARTIFACTS.has(artifactName) ||
      typeof encoded !== "string"
    ) {
      fail("INLINE_RUN_ARTIFACT_FORBIDDEN", `${filePath}:${artifactName}`);
    }
    const label = `${filePath}#inlineRunArtifacts/${artifactName}`;
    const decoded = parseJsonText(encoded, label);
    validateInlineArtifactRoot(artifactName, decoded, label);
    inspectJsonPrivacy(decoded, label, true);
  }
}

function validateInlineArtifactRoot(artifactName, value, label) {
  if (!isRecord(value)) fail("INLINE_ARTIFACT_ROOT_SCHEMA_INVALID", label);
  const allowed = PUBLIC_INLINE_ROOT_KEYS.get(artifactName);
  if (
    allowed === undefined ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    fail("INLINE_ARTIFACT_ROOT_SCHEMA_INVALID", label);
  }
}

function isJsonEncodedEnvelope(value) {
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return false;
  }
  try {
    const decoded = JSON.parse(trimmed);
    return decoded !== null && typeof decoded === "object";
  } catch {
    return false;
  }
}

function parseJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail("EVIDENCE_JSON_INVALID", label);
  }
}

export async function copyInventory(sourceRoot, destinationRoot, inventory) {
  await fs.mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  for (const entry of inventory.files) {
    const destination = path.join(destinationRoot, entry.path);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(
      path.join(sourceRoot, entry.path),
      destination,
      fsConstants.COPYFILE_EXCL,
    );
    await fs.chmod(destination, 0o600);
  }
}

export async function buildBundle({
  repository,
  evidenceRoot,
  sealRequestRoot,
  outputRoot,
  expectedRequestSha256,
  sourceArtifactMetadataPath,
  sourceCIMetadataPath,
  verifierAggregatePath,
  createdAt,
}) {
  const existing = await fs.stat(outputRoot).catch(() => null);
  if (existing !== null) fail("BUNDLE_OUTPUT_ALREADY_EXISTS");
  const { request, actualRequestSha256 } = await loadAndVerifySealRequest(
    sealRequestRoot,
    expectedRequestSha256,
  );
  const sourceMetadata = await readJsonFile(sourceArtifactMetadataPath);
  await verifyArtifactMetadata(sourceMetadata, {
    ...request.sourceArtifact,
    headSha: request.source.workflowSourceSha,
    repository: "0xNad/ProxyWar",
    minRetentionDays: 89,
  });
  const sourceCIMetadata = await readJsonFile(sourceCIMetadataPath);
  verifySourceCIMetadata(sourceCIMetadata, request.sourceCI);
  const treeDiff = await buildTreeDiffManifest({
    repository,
    source: request.source,
  });
  const bindings = await verifyEvidenceBindings({
    evidenceRoot,
    request,
    verifierAggregatePath,
  });
  const normalizedCreatedAt = isoTimestamp(createdAt, "createdAt");
  if (Date.parse(normalizedCreatedAt) < Date.parse(bindings.prereg.createdAt))
    fail("SEAL_BEFORE_PREREGISTRATION");
  const inventory = await scanPrivacyAndInventory(evidenceRoot);
  if (
    request.phase === "preregistration" &&
    inventory.files.some((entry) => entry.path.startsWith("runs/"))
  )
    fail("PREREGISTRATION_RUN_EVIDENCE_FORBIDDEN");
  await fs.mkdir(outputRoot, { recursive: false, mode: 0o700 });
  await copyInventory(
    path.resolve(evidenceRoot),
    path.join(outputRoot, "evidence"),
    inventory,
  );
  await fs.mkdir(path.join(outputRoot, "authority"), {
    recursive: false,
    mode: 0o700,
  });
  await fs.copyFile(
    path.join(sealRequestRoot, SEAL_REQUEST_FILE),
    path.join(outputRoot, BUNDLE_REQUEST_PATH),
    fsConstants.COPYFILE_EXCL,
  );
  const treeDiffPath = path.join(outputRoot, TREE_DIFF_FILE);
  await writeJsonExclusive(treeDiffPath, treeDiff);
  const treeDiffSha256 = await sha256File(treeDiffPath);
  const privacyInventorySha256 = sha256Bytes(
    Buffer.from(canonicalJson(inventory.files)),
  );
  const manifest = {
    schemaVersion: 1,
    artifactKind: "commander-xp-external-seal-bundle",
    experimentID: request.experimentID,
    phase: request.phase,
    createdAt: normalizedCreatedAt,
    workflow: {
      repository: sourceMetadata.repository.full_name,
      runID: positiveInteger(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
      runAttempt: positiveInteger(
        process.env.GITHUB_RUN_ATTEMPT,
        "GITHUB_RUN_ATTEMPT",
      ),
    },
    sourceCI: request.sourceCI,
    source: {
      ...request.source,
      treeDiffPath: TREE_DIFF_FILE,
      treeDiffSha256,
    },
    sourceArtifact: request.sourceArtifact,
    evidence: {
      requestPath: BUNDLE_REQUEST_PATH,
      requestSha256: actualRequestSha256,
      preRegistrationSha256: normalizeSha256(
        request.evidence.preRegistrationSha256,
      ),
      localIndexSha256: normalizeSha256(request.evidence.localIndexSha256),
      localSealFileSha256: normalizeSha256(
        request.evidence.localSealFileSha256,
      ),
      localSealSha256: normalizeSha256(request.evidence.localSealSha256),
      aggregateSha256: normalizeSha256(request.evidence.aggregateSha256),
      preregistrationReceiptSha256:
        request.preregistrationReceipt === null
          ? null
          : normalizeSha256(request.preregistrationReceipt.sha256),
      canaryReceiptSha256:
        request.canaryReceipt === null
          ? null
          : normalizeSha256(request.canaryReceipt.sha256),
    },
    privacy: {
      scannerVersion: 1,
      fileCount: inventory.fileCount,
      totalBytes: inventory.totalBytes,
      inventorySha256: privacyInventorySha256,
    },
    files: inventory.files.map((entry) => ({
      ...entry,
      path: `evidence/${entry.path}`,
    })),
    verifier: {
      engine: "CommanderXpVerifier-v2-exact-structural-and-privacy",
      schemaVersion: bindings.aggregate.schemaVersion,
      delegatedEvidenceSchemaValidation: true,
      integrityVerified: true,
      experimentUsable: false,
      performanceClaimAuthorized: false,
      externalSealRequired: true,
    },
  };
  const manifestPath = path.join(outputRoot, BUNDLE_MANIFEST_FILE);
  await writeJsonExclusive(manifestPath, manifest);
  await writeChecksums(outputRoot, manifest);
  await verifyBundle(outputRoot, {
    repository,
    sourceSha: request.source.workflowSourceSha,
    workflowRunID: positiveInteger(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    workflowRunAttempt: positiveInteger(
      process.env.GITHUB_RUN_ATTEMPT,
      "GITHUB_RUN_ATTEMPT",
    ),
  });
  return manifest;
}

async function writeChecksums(root, manifest) {
  const entries = [
    ...manifest.files,
    { path: BUNDLE_REQUEST_PATH, sha256: manifest.evidence.requestSha256 },
    { path: TREE_DIFF_FILE, sha256: manifest.source.treeDiffSha256 },
    {
      path: BUNDLE_MANIFEST_FILE,
      sha256: await sha256File(path.join(root, BUNDLE_MANIFEST_FILE)),
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const text =
    entries
      .map(
        (entry) => `${normalizeSha256(entry.sha256).slice(7)}  ${entry.path}`,
      )
      .join("\n") + "\n";
  await fs.writeFile(path.join(root, BUNDLE_CHECKSUM_FILE), text, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export async function verifyBundle(root, expected = {}) {
  const manifest = await readJsonFile(path.join(root, BUNDLE_MANIFEST_FILE));
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "artifactKind",
      "experimentID",
      "phase",
      "createdAt",
      "workflow",
      "sourceCI",
      "source",
      "sourceArtifact",
      "evidence",
      "privacy",
      "files",
      "verifier",
    ],
    "BUNDLE_MANIFEST_SCHEMA_INVALID",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.artifactKind !== "commander-xp-external-seal-bundle" ||
    !PHASES.has(manifest.phase) ||
    !SAFE_ID.test(manifest.experimentID)
  ) {
    fail("BUNDLE_MANIFEST_IDENTITY_INVALID");
  }
  validateBundleManifest(manifest);
  await verifyBundleRequestBinding(root, manifest);
  if (
    expected.sourceSha !== undefined &&
    manifest.source.workflowSourceSha !== expected.sourceSha
  )
    fail("BUNDLE_SOURCE_SHA_MISMATCH");
  if (
    expected.workflowRunID !== undefined &&
    manifest.workflow.runID !== expected.workflowRunID
  )
    fail("BUNDLE_WORKFLOW_RUN_MISMATCH");
  if (
    expected.workflowRunAttempt !== undefined &&
    manifest.workflow.runAttempt !== expected.workflowRunAttempt
  )
    fail("BUNDLE_WORKFLOW_ATTEMPT_MISMATCH");
  const treeDiff = await readJsonFile(path.join(root, TREE_DIFF_FILE));
  verifyTreeDiffStructure(treeDiff, manifest.source);
  if (expected.repository !== undefined) {
    const rebuilt = await buildTreeDiffManifest({
      repository: expected.repository,
      source: manifest.source,
    });
    if (canonicalJson(treeDiff) !== canonicalJson(rebuilt))
      fail("BUNDLE_TREE_DIFF_REBUILD_MISMATCH");
  }
  const actualInventory = await inventoryRegularFiles(root);
  const expectedPaths = new Set([
    ...manifest.files.map((entry) => entry.path),
    BUNDLE_REQUEST_PATH,
    TREE_DIFF_FILE,
    BUNDLE_MANIFEST_FILE,
    BUNDLE_CHECKSUM_FILE,
  ]);
  if (
    actualInventory.length !== expectedPaths.size ||
    actualInventory.some((entry) => !expectedPaths.has(entry.path))
  )
    fail("BUNDLE_FILE_SET_MISMATCH");
  for (const entry of manifest.files) {
    if (!safeRelativePath(entry.path) || !entry.path.startsWith("evidence/"))
      fail("BUNDLE_FILE_PATH_INVALID", entry.path);
    const actual = await containedRegularFile(root, entry.path);
    if (
      (await sha256File(actual)) !== normalizeSha256(entry.sha256) ||
      (await fs.stat(actual)).size !== entry.bytes
    )
      fail("BUNDLE_FILE_HASH_MISMATCH", entry.path);
  }
  if (
    (await sha256File(path.join(root, TREE_DIFF_FILE))) !==
    normalizeSha256(manifest.source.treeDiffSha256)
  )
    fail("BUNDLE_TREE_DIFF_HASH_MISMATCH");
  await verifyChecksumFile(root);
  const privacy = await scanPrivacyAndInventory(path.join(root, "evidence"));
  if (
    privacy.fileCount !== manifest.privacy.fileCount ||
    privacy.totalBytes !== manifest.privacy.totalBytes ||
    sha256Bytes(Buffer.from(canonicalJson(privacy.files))) !==
      normalizeSha256(manifest.privacy.inventorySha256)
  )
    fail("BUNDLE_PRIVACY_INVENTORY_MISMATCH");
  return manifest;
}

async function verifyBundleRequestBinding(root, manifest) {
  const requestRoot = path.join(root, "authority");
  const { request } = await loadAndVerifySealRequest(
    requestRoot,
    manifest.evidence.requestSha256,
  );
  const manifestSourceBinding = {
    behaviorBaseSha: manifest.source.behaviorBaseSha,
    behaviorBaseTreeSha: manifest.source.behaviorBaseTreeSha,
    workflowSourceSha: manifest.source.workflowSourceSha,
    workflowSourceTreeSha: manifest.source.workflowSourceTreeSha,
    sourceAllowlist: manifest.source.sourceAllowlist,
  };
  const expectedEvidence = {
    preRegistrationSha256: normalizeSha256(
      request.evidence.preRegistrationSha256,
    ),
    localIndexSha256: normalizeSha256(request.evidence.localIndexSha256),
    localSealFileSha256: normalizeSha256(request.evidence.localSealFileSha256),
    localSealSha256: normalizeSha256(request.evidence.localSealSha256),
    aggregateSha256: normalizeSha256(request.evidence.aggregateSha256),
    preregistrationReceiptSha256:
      request.preregistrationReceipt === null
        ? null
        : normalizeSha256(request.preregistrationReceipt.sha256),
    canaryReceiptSha256:
      request.canaryReceipt === null
        ? null
        : normalizeSha256(request.canaryReceipt.sha256),
  };
  const actualEvidence = {
    preRegistrationSha256: manifest.evidence.preRegistrationSha256,
    localIndexSha256: manifest.evidence.localIndexSha256,
    localSealFileSha256: manifest.evidence.localSealFileSha256,
    localSealSha256: manifest.evidence.localSealSha256,
    aggregateSha256: manifest.evidence.aggregateSha256,
    preregistrationReceiptSha256:
      manifest.evidence.preregistrationReceiptSha256,
    canaryReceiptSha256: manifest.evidence.canaryReceiptSha256,
  };
  if (
    manifest.experimentID !== request.experimentID ||
    manifest.phase !== request.phase ||
    canonicalJson(manifest.sourceCI) !== canonicalJson(request.sourceCI) ||
    canonicalJson(manifestSourceBinding) !== canonicalJson(request.source) ||
    canonicalJson(manifest.sourceArtifact) !==
      canonicalJson(request.sourceArtifact) ||
    canonicalJson(actualEvidence) !== canonicalJson(expectedEvidence)
  ) {
    fail("BUNDLE_REQUEST_CROSS_BINDING_MISMATCH");
  }
}

function validateBundleManifest(manifest) {
  exactKeys(
    manifest.workflow,
    ["repository", "runID", "runAttempt"],
    "BUNDLE_WORKFLOW_SCHEMA_INVALID",
  );
  if (
    manifest.workflow.repository !== "0xNad/ProxyWar" ||
    positiveInteger(manifest.workflow.runID, "bundle workflow run ID") < 1 ||
    positiveInteger(
      manifest.workflow.runAttempt,
      "bundle workflow run attempt",
    ) < 1
  ) {
    fail("BUNDLE_WORKFLOW_SCHEMA_INVALID");
  }
  validateSourceCIBinding(manifest.sourceCI);
  exactKeys(
    manifest.source,
    [
      "behaviorBaseSha",
      "behaviorBaseTreeSha",
      "workflowSourceSha",
      "workflowSourceTreeSha",
      "sourceAllowlist",
      "treeDiffPath",
      "treeDiffSha256",
    ],
    "BUNDLE_SOURCE_SCHEMA_INVALID",
  );
  const sourceBinding = {
    behaviorBaseSha: manifest.source.behaviorBaseSha,
    behaviorBaseTreeSha: manifest.source.behaviorBaseTreeSha,
    workflowSourceSha: manifest.source.workflowSourceSha,
    workflowSourceTreeSha: manifest.source.workflowSourceTreeSha,
    sourceAllowlist: manifest.source.sourceAllowlist,
  };
  validateSourceBinding(sourceBinding);
  if (manifest.source.treeDiffPath !== TREE_DIFF_FILE)
    fail("BUNDLE_TREE_DIFF_PATH_INVALID");
  normalizeSha256(manifest.source.treeDiffSha256, "bundle tree diff SHA-256");
  validateSourceArtifactBinding(manifest.sourceArtifact);
  exactKeys(
    manifest.evidence,
    [
      "requestPath",
      "requestSha256",
      "preRegistrationSha256",
      "localIndexSha256",
      "localSealFileSha256",
      "localSealSha256",
      "aggregateSha256",
      "preregistrationReceiptSha256",
      "canaryReceiptSha256",
    ],
    "BUNDLE_EVIDENCE_SCHEMA_INVALID",
  );
  if (manifest.evidence.requestPath !== BUNDLE_REQUEST_PATH)
    fail("BUNDLE_REQUEST_PATH_INVALID");
  for (const [key, value] of Object.entries(manifest.evidence)) {
    if (
      key === "requestPath" ||
      (["preregistrationReceiptSha256", "canaryReceiptSha256"].includes(key) &&
        value === null)
    )
      continue;
    normalizeSha256(value, `bundle evidence ${key}`);
  }
  exactKeys(
    manifest.privacy,
    ["scannerVersion", "fileCount", "totalBytes", "inventorySha256"],
    "BUNDLE_PRIVACY_SCHEMA_INVALID",
  );
  if (
    manifest.privacy.scannerVersion !== 1 ||
    !Number.isSafeInteger(manifest.privacy.fileCount) ||
    manifest.privacy.fileCount < 1 ||
    !Number.isSafeInteger(manifest.privacy.totalBytes) ||
    manifest.privacy.totalBytes < 1
  )
    fail("BUNDLE_PRIVACY_SCHEMA_INVALID");
  normalizeSha256(
    manifest.privacy.inventorySha256,
    "privacy inventory SHA-256",
  );
  exactKeys(
    manifest.verifier,
    [
      "engine",
      "schemaVersion",
      "delegatedEvidenceSchemaValidation",
      "integrityVerified",
      "experimentUsable",
      "performanceClaimAuthorized",
      "externalSealRequired",
    ],
    "BUNDLE_VERIFIER_SCHEMA_INVALID",
  );
  if (
    manifest.verifier.engine !==
      "CommanderXpVerifier-v2-exact-structural-and-privacy" ||
    manifest.verifier.schemaVersion !== 2 ||
    manifest.verifier.delegatedEvidenceSchemaValidation !== true ||
    manifest.verifier.integrityVerified !== true ||
    manifest.verifier.experimentUsable !== false ||
    manifest.verifier.performanceClaimAuthorized !== false ||
    manifest.verifier.externalSealRequired !== true
  )
    fail("BUNDLE_VERIFIER_SCHEMA_INVALID");
  if (!Array.isArray(manifest.files) || manifest.files.length < 1)
    fail("BUNDLE_FILE_LEDGER_INVALID");
  if (
    manifest.phase === "preregistration" &&
    manifest.files.some((entry) =>
      String(entry?.path ?? "").startsWith("evidence/runs/"),
    )
  )
    fail("PREREGISTRATION_RUN_EVIDENCE_FORBIDDEN");
  const paths = new Set();
  for (const entry of manifest.files) {
    exactKeys(entry, ["path", "bytes", "sha256"], "BUNDLE_FILE_LEDGER_INVALID");
    if (
      !safeRelativePath(entry.path) ||
      !entry.path.startsWith("evidence/") ||
      paths.has(entry.path) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0
    )
      fail("BUNDLE_FILE_LEDGER_INVALID");
    normalizeSha256(entry.sha256, `bundle file ${entry.path}`);
    paths.add(entry.path);
  }
}

function verifyTreeDiffStructure(treeDiff, source) {
  exactKeys(
    treeDiff,
    [
      "schemaVersion",
      "behaviorBaseSha",
      "behaviorBaseTreeSha",
      "workflowSourceSha",
      "workflowSourceTreeSha",
      "allowlistMode",
      "entries",
    ],
    "TREE_DIFF_SCHEMA_INVALID",
  );
  if (
    treeDiff.schemaVersion !== 1 ||
    treeDiff.behaviorBaseSha !== source.behaviorBaseSha ||
    treeDiff.behaviorBaseTreeSha !== source.behaviorBaseTreeSha ||
    treeDiff.workflowSourceSha !== source.workflowSourceSha ||
    treeDiff.workflowSourceTreeSha !== source.workflowSourceTreeSha ||
    treeDiff.allowlistMode !== "exact" ||
    !Array.isArray(treeDiff.entries)
  )
    fail("TREE_DIFF_IDENTITY_INVALID");
  const paths = [];
  for (const entry of treeDiff.entries) {
    exactKeys(
      entry,
      [
        "status",
        "path",
        "baseMode",
        "headMode",
        "baseBlob",
        "headBlob",
        "contentSha256",
        "bytes",
      ],
      "TREE_DIFF_ENTRY_INVALID",
    );
    if (
      !["A", "M"].includes(entry.status) ||
      !safeSourcePath(entry.path) ||
      !["100644", "100755"].includes(entry.headMode) ||
      (entry.status === "A" &&
        (entry.baseMode !== null || entry.baseBlob !== null)) ||
      (entry.status === "M" &&
        (!SHA1.test(entry.baseBlob) ||
          !["100644", "100755"].includes(entry.baseMode))) ||
      !SHA1.test(entry.headBlob) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0
    )
      fail("TREE_DIFF_ENTRY_INVALID");
    normalizeSha256(entry.contentSha256, `tree diff ${entry.path}`);
    paths.push(entry.path);
  }
  if (
    paths.length !== source.sourceAllowlist.length ||
    paths.some((entry, index) => entry !== source.sourceAllowlist[index])
  )
    fail("TREE_DIFF_ALLOWLIST_MISMATCH");
}

async function verifyChecksumFile(root) {
  const text = await fs.readFile(path.join(root, BUNDLE_CHECKSUM_FILE), "utf8");
  const seen = new Set();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!match || !safeRelativePath(match[2]) || seen.has(match[2]))
      fail("BUNDLE_CHECKSUM_FILE_INVALID");
    seen.add(match[2]);
    if (
      (await sha256File(await containedRegularFile(root, match[2]))) !==
      `sha256:${match[1]}`
    )
      fail("BUNDLE_CHECKSUM_MISMATCH", match[2]);
  }
  const inventory = await inventoryRegularFiles(root);
  const expected = inventory
    .map((entry) => entry.path)
    .filter((entry) => entry !== BUNDLE_CHECKSUM_FILE);
  if (
    seen.size !== expected.length ||
    expected.some((entry) => !seen.has(entry))
  )
    fail("BUNDLE_CHECKSUM_COVERAGE_INVALID");
}

export async function createExternalReceipt({
  bundleRoot,
  sealedBundlePath,
  outputPath,
  bundleArtifactMetadataPath,
  completedAt,
}) {
  const manifest = await verifyBundle(bundleRoot);
  const normalizedCompletedAt = isoTimestamp(completedAt, "completedAt");
  if (Date.parse(normalizedCompletedAt) < Date.parse(manifest.createdAt))
    fail("RECEIPT_BEFORE_BUNDLE");
  const metadata = await readJsonFile(bundleArtifactMetadataPath);
  const expectedArtifact = {
    artifactID: positiveInteger(
      process.env.BUNDLE_ARTIFACT_ID,
      "BUNDLE_ARTIFACT_ID",
    ),
    artifactName: process.env.BUNDLE_ARTIFACT_NAME,
    artifactDigest: normalizeSha256(
      process.env.BUNDLE_ARTIFACT_DIGEST,
      "BUNDLE_ARTIFACT_DIGEST",
    ),
    workflowRunID: positiveInteger(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    workflowRunAttempt: positiveInteger(
      process.env.GITHUB_RUN_ATTEMPT,
      "GITHUB_RUN_ATTEMPT",
    ),
  };
  await verifyArtifactMetadata(metadata, {
    ...expectedArtifact,
    headSha: manifest.source.workflowSourceSha,
    repository: "0xNad/ProxyWar",
    minRetentionDays: 89,
    allowCurrentRunInProgress: true,
  });
  if (
    manifest.workflow.runID !== expectedArtifact.workflowRunID ||
    manifest.workflow.runAttempt !== expectedArtifact.workflowRunAttempt
  )
    fail("RECEIPT_BUNDLE_WORKFLOW_MISMATCH");
  const receipt = {
    schemaVersion: 1,
    artifactKind: "commander-xp-external-seal-receipt",
    status: "sealed-integrity-only-performance-unauthorized",
    experimentID: manifest.experimentID,
    phase: manifest.phase,
    completedAt: normalizedCompletedAt,
    repository: metadata.repository.full_name,
    workflow: {
      sourceSha: manifest.source.workflowSourceSha,
      sourceTreeSha: manifest.source.workflowSourceTreeSha,
      behaviorBaseSha: manifest.source.behaviorBaseSha,
      behaviorBaseTreeSha: manifest.source.behaviorBaseTreeSha,
      runID: expectedArtifact.workflowRunID,
      runAttempt: expectedArtifact.workflowRunAttempt,
    },
    sourceCI: manifest.sourceCI,
    bundleArtifact: {
      artifactID: expectedArtifact.artifactID,
      artifactName: expectedArtifact.artifactName,
      artifactDigest: expectedArtifact.artifactDigest,
      sealedBundleSha256: await sha256File(sealedBundlePath),
      expiresAt: metadata.artifact.expires_at,
    },
    evidence: {
      preRegistrationSha256: manifest.evidence.preRegistrationSha256,
      localIndexSha256: manifest.evidence.localIndexSha256,
      localSealFileSha256: manifest.evidence.localSealFileSha256,
      localSealSha256: manifest.evidence.localSealSha256,
      aggregateSha256: manifest.evidence.aggregateSha256,
      preregistrationReceiptSha256:
        manifest.evidence.preregistrationReceiptSha256,
      canaryReceiptSha256: manifest.evidence.canaryReceiptSha256,
      treeDiffSha256: manifest.source.treeDiffSha256,
      privacyInventorySha256: manifest.privacy.inventorySha256,
    },
    attestation: {
      required: true,
      issuer: "GitHub Actions OIDC / Sigstore public-good instance",
      subjects: ["sealed-bundle", EXTERNAL_RECEIPT_FILE],
    },
    integrityVerified: true,
    experimentUsable: false,
    performanceClaimAuthorized: false,
  };
  await writeJsonExclusive(outputPath, receipt);
  await verifyExternalReceipt(outputPath, {
    experimentID: manifest.experimentID,
    phase: manifest.phase,
  });
  return receipt;
}

export async function verifyExternalReceipt(filePath, expected = {}) {
  const receipt = await readJsonFile(filePath);
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "artifactKind",
      "status",
      "experimentID",
      "phase",
      "completedAt",
      "repository",
      "workflow",
      "sourceCI",
      "bundleArtifact",
      "evidence",
      "attestation",
      "integrityVerified",
      "experimentUsable",
      "performanceClaimAuthorized",
    ],
    "EXTERNAL_RECEIPT_SCHEMA_INVALID",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.artifactKind !== "commander-xp-external-seal-receipt" ||
    receipt.status !== "sealed-integrity-only-performance-unauthorized" ||
    !SAFE_ID.test(receipt.experimentID) ||
    !PHASES.has(receipt.phase) ||
    receipt.integrityVerified !== true ||
    receipt.experimentUsable !== false ||
    receipt.performanceClaimAuthorized !== false ||
    receipt.attestation?.required !== true ||
    receipt.attestation?.issuer !==
      "GitHub Actions OIDC / Sigstore public-good instance" ||
    canonicalJson(receipt.attestation?.subjects) !==
      canonicalJson(["sealed-bundle", EXTERNAL_RECEIPT_FILE])
  )
    fail("EXTERNAL_RECEIPT_IDENTITY_INVALID");
  exactKeys(
    receipt.workflow,
    [
      "sourceSha",
      "sourceTreeSha",
      "behaviorBaseSha",
      "behaviorBaseTreeSha",
      "runID",
      "runAttempt",
    ],
    "EXTERNAL_RECEIPT_WORKFLOW_INVALID",
  );
  validateSourceCIBinding(receipt.sourceCI);
  exactKeys(
    receipt.bundleArtifact,
    [
      "artifactID",
      "artifactName",
      "artifactDigest",
      "sealedBundleSha256",
      "expiresAt",
    ],
    "EXTERNAL_RECEIPT_ARTIFACT_INVALID",
  );
  exactKeys(
    receipt.evidence,
    [
      "preRegistrationSha256",
      "localIndexSha256",
      "localSealFileSha256",
      "localSealSha256",
      "aggregateSha256",
      "preregistrationReceiptSha256",
      "canaryReceiptSha256",
      "treeDiffSha256",
      "privacyInventorySha256",
    ],
    "EXTERNAL_RECEIPT_EVIDENCE_INVALID",
  );
  exactKeys(
    receipt.attestation,
    ["required", "issuer", "subjects"],
    "EXTERNAL_RECEIPT_ATTESTATION_INVALID",
  );
  if (expected.experimentID && receipt.experimentID !== expected.experimentID)
    fail("EXTERNAL_RECEIPT_EXPERIMENT_MISMATCH");
  if (expected.phase && receipt.phase !== expected.phase)
    fail("EXTERNAL_RECEIPT_PHASE_MISMATCH");
  positiveInteger(receipt.workflow?.runID, "receipt workflow run ID");
  positiveInteger(receipt.workflow?.runAttempt, "receipt workflow run attempt");
  positiveInteger(receipt.bundleArtifact?.artifactID, "receipt artifact ID");
  normalizeSha256(
    receipt.bundleArtifact?.artifactDigest,
    "receipt artifact digest",
  );
  normalizeSha256(
    receipt.bundleArtifact?.sealedBundleSha256,
    "receipt sealed bundle SHA-256",
  );
  for (const field of Object.values(receipt.evidence ?? {})) {
    if (field !== null) normalizeSha256(field, "receipt evidence SHA-256");
  }
  isoTimestamp(receipt.completedAt, "receipt completedAt");
  const expiresAt = Date.parse(receipt.bundleArtifact?.expiresAt ?? "");
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.parse(receipt.completedAt)
  )
    fail("EXTERNAL_RECEIPT_ARTIFACT_EXPIRY_INVALID");
  return receipt;
}

export async function createExternalPhaseLedger({
  bundleRoot,
  receiptPath,
  receiptArtifactMetadataPath,
  outputPath,
  completedAt,
}) {
  const manifest = await verifyBundle(bundleRoot);
  const receipt = await verifyExternalReceipt(receiptPath, {
    experimentID: manifest.experimentID,
    phase: manifest.phase,
  });
  const normalizedCompletedAt = isoTimestamp(completedAt, "completedAt");
  if (Date.parse(normalizedCompletedAt) < Date.parse(receipt.completedAt))
    fail("LEDGER_BEFORE_RECEIPT");
  const metadata = await readJsonFile(receiptArtifactMetadataPath);
  const expectedArtifact = {
    artifactID: positiveInteger(
      process.env.RECEIPT_ARTIFACT_ID,
      "RECEIPT_ARTIFACT_ID",
    ),
    artifactName: process.env.RECEIPT_ARTIFACT_NAME,
    artifactDigest: normalizeSha256(
      process.env.RECEIPT_ARTIFACT_DIGEST,
      "RECEIPT_ARTIFACT_DIGEST",
    ),
    workflowRunID: positiveInteger(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
    workflowRunAttempt: positiveInteger(
      process.env.GITHUB_RUN_ATTEMPT,
      "GITHUB_RUN_ATTEMPT",
    ),
  };
  await verifyArtifactMetadata(metadata, {
    ...expectedArtifact,
    headSha: manifest.source.workflowSourceSha,
    repository: "0xNad/ProxyWar",
    minRetentionDays: 89,
    allowCurrentRunInProgress: true,
  });
  const receiptSha256 = normalizeRawSha256(
    await sha256File(receiptPath),
    "receipt subject SHA-256",
  );
  const body = {
    schemaVersion: 2,
    authority: "github-actions-attested-ledger-v1",
    repository: "0xNad/ProxyWar",
    workflowPath: ".github/workflows/commander-xp-external-seal.yml",
    workflowID: String(metadata.workflowRun.workflow_id),
    workflowName: "Commander XP external seal",
    actor: metadata.workflowRun.actor?.login,
    event: metadata.workflowRun.event,
    ref: `refs/heads/${metadata.workflowRun.head_branch}`,
    experimentID: manifest.experimentID,
    preRegistrationSha256: normalizeRawSha256(
      manifest.evidence.preRegistrationSha256,
      "preregistration SHA-256",
    ),
    behaviorBaseSha: manifest.source.behaviorBaseSha,
    behaviorBaseTreeSha: manifest.source.behaviorBaseTreeSha,
    runnerEnvironment: "github-hosted",
    attestationPolicy: {
      repository: "0xNad/ProxyWar",
      signerWorkflow:
        "0xNad/ProxyWar/.github/workflows/commander-xp-external-seal.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: manifest.source.workflowSourceSha,
      signerDigest: manifest.source.workflowSourceSha,
      denySelfHostedRunners: true,
    },
    collector: manifest.sourceArtifact,
    runId: String(expectedArtifact.workflowRunID),
    attempt: expectedArtifact.workflowRunAttempt,
    headSha: manifest.source.workflowSourceSha,
    treeSha: manifest.source.workflowSourceTreeSha,
    phase: manifest.phase,
    completedAt: normalizedCompletedAt,
    evidenceArtifact: {
      id: String(receipt.bundleArtifact.artifactID),
      digest: normalizeSha256(receipt.bundleArtifact.artifactDigest),
      aggregateSha256: normalizeRawSha256(
        receipt.evidence.aggregateSha256,
        "aggregate SHA-256",
      ),
      attestedSubjectDigest: normalizeRawSha256(
        receipt.bundleArtifact.sealedBundleSha256,
        "sealed bundle SHA-256",
      ),
      localSealSha256: normalizeRawSha256(
        receipt.evidence.localSealSha256,
        "local seal SHA-256",
      ),
    },
    receiptArtifact: {
      id: String(expectedArtifact.artifactID),
      digest: expectedArtifact.artifactDigest,
      receiptSha256,
      attestedSubjectDigest: receiptSha256,
    },
  };
  const ledger = {
    ...body,
    ledgerSha256: normalizeRawSha256(
      sha256Bytes(Buffer.from(canonicalJson(body))),
      "ledger SHA-256",
    ),
  };
  await writeJsonExclusive(outputPath, ledger);
  await verifyExternalPhaseLedger(outputPath, {
    phase: manifest.phase,
    experimentID: manifest.experimentID,
    behaviorBaseSha: manifest.source.behaviorBaseSha,
    behaviorBaseTreeSha: manifest.source.behaviorBaseTreeSha,
    headSha: manifest.source.workflowSourceSha,
    treeSha: manifest.source.workflowSourceTreeSha,
  });
  return ledger;
}

export async function verifyExternalPhaseLedger(filePath, expected = {}) {
  const ledger = await readJsonFile(filePath);
  exactKeys(
    ledger,
    [
      "schemaVersion",
      "authority",
      "repository",
      "workflowPath",
      "workflowID",
      "workflowName",
      "actor",
      "event",
      "ref",
      "experimentID",
      "preRegistrationSha256",
      "behaviorBaseSha",
      "behaviorBaseTreeSha",
      "runnerEnvironment",
      "attestationPolicy",
      "collector",
      "runId",
      "attempt",
      "headSha",
      "treeSha",
      "phase",
      "completedAt",
      "evidenceArtifact",
      "receiptArtifact",
      "ledgerSha256",
    ],
    "EXTERNAL_PHASE_LEDGER_SCHEMA_INVALID",
  );
  validateLedgerEvidenceArtifact(ledger.evidenceArtifact);
  validateLedgerReceiptArtifact(ledger.receiptArtifact);
  validateSourceArtifactBinding(ledger.collector);
  exactKeys(
    ledger.attestationPolicy,
    [
      "repository",
      "signerWorkflow",
      "sourceRef",
      "sourceDigest",
      "signerDigest",
      "denySelfHostedRunners",
    ],
    "LEDGER_ATTESTATION_POLICY_INVALID",
  );
  const { ledgerSha256, ...body } = ledger;
  if (
    ledger.schemaVersion !== 2 ||
    ledger.authority !== "github-actions-attested-ledger-v1" ||
    ledger.repository !== "0xNad/ProxyWar" ||
    ledger.workflowPath !==
      ".github/workflows/commander-xp-external-seal.yml" ||
    !/^\d+$/.test(ledger.workflowID) ||
    ledger.workflowName !== "Commander XP external seal" ||
    ledger.actor !== "0xNad" ||
    ledger.event !== "workflow_dispatch" ||
    ledger.ref !== "refs/heads/main" ||
    !SAFE_ID.test(ledger.experimentID) ||
    normalizeRawSha256(
      ledger.preRegistrationSha256,
      "ledger preregistration SHA-256",
    ) !== ledger.preRegistrationSha256 ||
    !SHA1.test(ledger.behaviorBaseSha) ||
    !SHA1.test(ledger.behaviorBaseTreeSha) ||
    ledger.runnerEnvironment !== "github-hosted" ||
    ledger.attestationPolicy.repository !== "0xNad/ProxyWar" ||
    ledger.attestationPolicy.signerWorkflow !==
      "0xNad/ProxyWar/.github/workflows/commander-xp-external-seal.yml" ||
    ledger.attestationPolicy.sourceRef !== "refs/heads/main" ||
    ledger.attestationPolicy.sourceDigest !== ledger.headSha ||
    ledger.attestationPolicy.signerDigest !== ledger.headSha ||
    ledger.attestationPolicy.denySelfHostedRunners !== true ||
    !/^\d+$/.test(ledger.runId) ||
    !Number.isSafeInteger(ledger.attempt) ||
    ledger.attempt < 1 ||
    !SHA1.test(ledger.headSha) ||
    !SHA1.test(ledger.treeSha) ||
    !PHASES.has(ledger.phase) ||
    (expected.phase !== undefined && ledger.phase !== expected.phase) ||
    (expected.experimentID !== undefined &&
      ledger.experimentID !== expected.experimentID) ||
    (expected.behaviorBaseSha !== undefined &&
      ledger.behaviorBaseSha !== expected.behaviorBaseSha) ||
    (expected.behaviorBaseTreeSha !== undefined &&
      ledger.behaviorBaseTreeSha !== expected.behaviorBaseTreeSha) ||
    (expected.headSha !== undefined && ledger.headSha !== expected.headSha) ||
    (expected.treeSha !== undefined && ledger.treeSha !== expected.treeSha) ||
    normalizeRawSha256(ledgerSha256, "ledger SHA-256") !==
      normalizeRawSha256(
        sha256Bytes(Buffer.from(canonicalJson(body))),
        "computed ledger SHA-256",
      )
  ) {
    fail("EXTERNAL_PHASE_LEDGER_INVALID");
  }
  isoTimestamp(ledger.completedAt, "ledger completedAt");
  return ledger;
}

function validateLedgerEvidenceArtifact(value) {
  exactKeys(
    value,
    [
      "id",
      "digest",
      "aggregateSha256",
      "attestedSubjectDigest",
      "localSealSha256",
    ],
    "LEDGER_EVIDENCE_ARTIFACT_INVALID",
  );
  if (!/^\d+$/.test(value.id)) fail("LEDGER_EVIDENCE_ARTIFACT_INVALID");
  normalizeSha256(value.digest, "ledger evidence artifact digest");
  normalizeRawSha256(value.aggregateSha256, "ledger aggregate SHA-256");
  normalizeRawSha256(
    value.attestedSubjectDigest,
    "ledger evidence subject digest",
  );
  normalizeRawSha256(value.localSealSha256, "ledger local seal SHA-256");
}

function validateLedgerReceiptArtifact(value) {
  exactKeys(
    value,
    ["id", "digest", "receiptSha256", "attestedSubjectDigest"],
    "LEDGER_RECEIPT_ARTIFACT_INVALID",
  );
  if (!/^\d+$/.test(value.id)) fail("LEDGER_RECEIPT_ARTIFACT_INVALID");
  normalizeSha256(value.digest, "ledger receipt artifact digest");
  normalizeRawSha256(value.receiptSha256, "ledger receipt SHA-256");
  normalizeRawSha256(
    value.attestedSubjectDigest,
    "ledger receipt subject digest",
  );
  if (value.receiptSha256 !== value.attestedSubjectDigest)
    fail("LEDGER_RECEIPT_SUBJECT_MISMATCH");
}

function normalizeRawSha256(value, field) {
  return normalizeSha256(value, field).slice(7);
}

async function inventoryRegularFiles(root) {
  const result = [];
  async function visit(directory, prefix) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (!safeRelativePath(relative)) fail("EVIDENCE_PATH_UNSAFE", relative);
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail("EVIDENCE_SYMLINK_FORBIDDEN", relative);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        const stat = await fs.stat(absolute);
        result.push({ path: relative, bytes: stat.size });
      } else {
        fail("EVIDENCE_OBJECT_TYPE_FORBIDDEN", relative);
      }
    }
  }
  await visit(path.resolve(root), "");
  return result;
}

async function containedRegularFile(root, relativePath) {
  if (!safeRelativePath(relativePath))
    fail("CONTAINED_PATH_INVALID", relativePath);
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  if (!candidate.startsWith(`${resolvedRoot}${path.sep}`))
    fail("CONTAINED_PATH_ESCAPE", relativePath);
  const stat = await fs.lstat(candidate).catch(() => null);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink())
    fail("CONTAINED_REGULAR_FILE_REQUIRED", relativePath);
  return candidate;
}

async function git(repository, args) {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

async function gitBuffer(repository, args) {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout;
}

function exactKeys(value, expected, code) {
  if (!isRecord(value)) fail(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((entry, index) => entry !== wanted[index])
  )
    fail(code);
}

function positiveInteger(value, field) {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(numeric) || numeric < 1)
    fail("POSITIVE_INTEGER_REQUIRED", field);
  return numeric;
}

function isoTimestamp(value, field) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text))
    fail("ISO_TIMESTAMP_REQUIRED", field);
  if (!Number.isFinite(Date.parse(text))) fail("ISO_TIMESTAMP_REQUIRED", field);
  return text;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 31 || code === 127;
  });
}
