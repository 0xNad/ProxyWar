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
export const VERIFIER_AGGREGATE_FILE =
  "commander-xp-verifier-aggregate-v2.json";
const BUNDLE_REQUEST_PATH = `authority/${SEAL_REQUEST_FILE}`;
const BUNDLE_VERIFIER_AGGREGATE_PATH = `authority/${VERIFIER_AGGREGATE_FILE}`;

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
  "commander-xp-local-verification-v2.json",
  "commander-xp-source-provenance-v2.json",
  "commander-xp-source-tree-diff-v1.json",
  "policy-identities-v2.json",
  "eval-coworld-identity-v2.json",
  "eval-coworld-inspect.json",
  "eval-coworld-manifest-v2.json",
  "eval-coworld-terminal-proof-v2.json",
  "xp-openapi.sha256",
  "commander-xp-prereg-ledger-v2.json",
  "commander-xp-provider-preflight-ledger-v2.json",
  "commander-xp-canary-ledger-v2.json",
  "commander-xp-confirmatory-activation-v2.json",
]);
const ALLOWED_RUN_SUFFIXES = new Set([
  "xp-evidence.json",
  "submitted-request.json",
  "create-response.json",
  "normalized-request-readback.json",
  "replay-evidence.json",
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
  "coworldplayerartifactuploadurl",
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

export function safeAbsoluteUrlPath(value) {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 500 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("?") ||
    value.includes("#") ||
    hasControlCharacters(value)
  )
    return false;
  try {
    const parsed = new URL(value, "https://commander-xp.invalid");
    return (
      parsed.origin === "https://commander-xp.invalid" &&
      parsed.pathname === value &&
      parsed.search === "" &&
      parsed.hash === "" &&
      !value
        .slice(1)
        .split("/")
        .some((part) => part === "" || part === "." || part === "..")
    );
  } catch {
    return false;
  }
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

async function readPrivacyValidatedJsonFile(filePath, label) {
  const bytes = await fs.readFile(filePath);
  if (bytes.length > MAX_FILE_BYTES)
    fail("EVIDENCE_SIZE_LIMIT_EXCEEDED", label);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("EVIDENCE_UTF8_INVALID", label);
  }
  for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
    if (pattern.test(text)) fail("PRIVACY_VALUE_FORBIDDEN", label);
  }
  for (const forbidden of FORBIDDEN_PRIVACY_TEXT) {
    if (text.includes(forbidden))
      fail("PRIVACY_TEXT_FORBIDDEN", `${label}:${forbidden}`);
  }
  const parsed = parseJsonText(text, label);
  inspectJsonPrivacy(parsed, label, true);
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
      "providerPreflightReceipt",
      "priorPhaseReceipt",
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
  if (
    request.sourceArtifact.headSha !== request.source.workflowSourceSha ||
    request.sourceCI.headSha !== request.source.workflowSourceSha
  ) {
    fail("SEAL_REQUEST_SOURCE_HEAD_MISMATCH");
  }
  validateEvidenceBinding(request.evidence);
  if (request.phase === "preregistration") {
    if (
      request.preregistrationReceipt !== null ||
      request.providerPreflightReceipt !== null ||
      request.priorPhaseReceipt !== null ||
      request.canaryReceipt !== null
    )
      fail("PREREGISTRATION_REQUEST_MUST_NOT_BIND_PRIOR_RECEIPT");
  } else {
    validatePhaseReceiptBinding(
      request.preregistrationReceipt,
      "preregistration",
    );
  }
  if (request.phase === "provider-preflight") {
    if (
      request.providerPreflightReceipt !== null ||
      request.priorPhaseReceipt !== null ||
      request.canaryReceipt !== null
    )
      fail("PROVIDER_PREFLIGHT_REQUEST_PRIOR_RECEIPT_INVALID");
  } else if (request.phase === "canary") {
    validatePhaseReceiptBinding(
      request.providerPreflightReceipt,
      "provider-preflight",
    );
    validatePhaseReceiptBinding(
      request.priorPhaseReceipt,
      "provider-preflight",
    );
    if (
      canonicalJson(request.providerPreflightReceipt) !==
      canonicalJson(request.priorPhaseReceipt)
    )
      fail("CANARY_PRIOR_PHASE_RECEIPT_MISMATCH");
    if (request.canaryReceipt !== null)
      fail("CANARY_REQUEST_MUST_NOT_BIND_CANARY_RECEIPT");
  } else if (request.phase === "confirmatory") {
    validatePhaseReceiptBinding(
      request.providerPreflightReceipt,
      "provider-preflight",
    );
    validatePhaseReceiptBinding(request.priorPhaseReceipt, "canary");
    validateCanaryReceiptBinding(request.canaryReceipt);
    if (
      canonicalJson(request.canaryReceipt) !==
      canonicalJson(request.priorPhaseReceipt)
    )
      fail("CONFIRMATORY_CANARY_RECEIPT_MISMATCH");
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
      "triggeringActor",
      "headRepository",
      "event",
      "ref",
      "headSha",
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
    binding.triggeringActor !== "0xNad" ||
    binding.headRepository !== "0xNad/ProxyWar" ||
    binding.event !== "workflow_dispatch" ||
    binding.ref !== "refs/heads/main" ||
    !SHA1.test(binding.headSha) ||
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
    [
      "workflowID",
      "workflowPath",
      "runID",
      "runAttempt",
      "headSha",
      "actor",
      "triggeringActor",
      "headRepository",
      "event",
      "ref",
    ],
    "SOURCE_CI_BINDING_INVALID",
  );
  positiveInteger(binding.workflowID, "source CI workflow ID");
  positiveInteger(binding.runID, "source CI run ID");
  positiveInteger(binding.runAttempt, "source CI run attempt");
  if (
    binding.workflowPath !== CI_WORKFLOW_PATH ||
    !SHA1.test(binding.headSha) ||
    binding.actor !== "0xNad" ||
    binding.triggeringActor !== "0xNad" ||
    binding.headRepository !== "0xNad/ProxyWar" ||
    binding.event !== "push" ||
    binding.ref !== "refs/heads/main"
  )
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
    ],
    "EVIDENCE_BINDING_INVALID",
  );
  for (const field of [
    "preRegistrationPath",
    "localIndexPath",
    "localSealPath",
  ]) {
    if (!safeRelativePath(evidence[field]))
      fail("EVIDENCE_PATH_INVALID", field);
  }
  for (const field of [
    "preRegistrationSha256",
    "localIndexSha256",
    "localSealFileSha256",
    "localSealSha256",
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
      "ledgerArtifact",
      "authorityArtifact",
      "terminalArtifact",
      "localSealSha256",
      "namespaceRegistrySha256",
      "workflowPath",
      "workflowID",
      "workflowName",
      "actor",
      "triggeringActor",
      "event",
      "ref",
      "phase",
      "experimentID",
      "behaviorBaseSha",
      "behaviorBaseTreeSha",
      "headSha",
      "treeSha",
    ],
    "PHASE_RECEIPT_BINDING_INVALID",
  );
  const expectedPath = {
    preregistration: "commander-xp-prereg-ledger-v2.json",
    "provider-preflight": "commander-xp-provider-preflight-ledger-v2.json",
    canary: "commander-xp-canary-ledger-v2.json",
  }[expectedPhase];
  if (binding.path !== expectedPath)
    fail("PHASE_RECEIPT_PATH_INVALID", expectedPhase);
  normalizeSha256(binding.sha256, `${expectedPhase} receipt SHA-256`);
  normalizeRawSha256(binding.ledgerSha256, `${expectedPhase} ledger SHA-256`);
  if (!/^\d+$/.test(binding.runId)) fail("PHASE_RECEIPT_RUN_ID_INVALID");
  positiveInteger(binding.attempt, `${expectedPhase} workflow run attempt`);
  validateLedgerEvidenceArtifact(binding.evidenceArtifact);
  validateLedgerReceiptArtifact(binding.receiptArtifact);
  validateRetainedPhaseArtifact(binding.ledgerArtifact, "ledgerSha256");
  validateRetainedPhaseArtifact(binding.authorityArtifact, "receiptSha256");
  validateRetainedPhaseArtifact(binding.terminalArtifact, "envelopeSha256");
  normalizeRawSha256(
    binding.localSealSha256,
    `${expectedPhase} local seal SHA-256`,
  );
  normalizeRawSha256(
    binding.namespaceRegistrySha256,
    `${expectedPhase} namespace registry SHA-256`,
  );
  if (binding.localSealSha256 !== binding.evidenceArtifact.localSealSha256)
    fail("PHASE_RECEIPT_LOCAL_SEAL_MISMATCH", expectedPhase);
  if (binding.ledgerArtifact.ledgerSha256 !== binding.ledgerSha256)
    fail("PHASE_RECEIPT_LEDGER_ARTIFACT_MISMATCH");
  if (
    binding.workflowPath !==
      ".github/workflows/commander-xp-external-seal.yml" ||
    !/^\d+$/.test(binding.workflowID) ||
    binding.workflowName !== "Commander XP external seal" ||
    binding.actor !== "0xNad" ||
    binding.triggeringActor !== "0xNad" ||
    binding.event !== "workflow_run" ||
    binding.ref !== "refs/heads/main" ||
    binding.phase !== expectedPhase ||
    !SAFE_ID.test(binding.experimentID) ||
    !SHA1.test(binding.behaviorBaseSha) ||
    !SHA1.test(binding.behaviorBaseTreeSha) ||
    !SHA1.test(binding.headSha) ||
    !SHA1.test(binding.treeSha)
  )
    fail("PHASE_RECEIPT_SOURCE_INVALID");
  const artifactPrefix = `${expectedPhase}-${binding.headSha}-${binding.runId}-${binding.attempt}`;
  if (
    binding.ledgerArtifact.name !==
      `commander-xp-phase-ledger-${artifactPrefix}` ||
    binding.authorityArtifact.name !==
      `commander-xp-authority-${artifactPrefix}` ||
    binding.terminalArtifact.name !==
      `commander-xp-terminal-authority-${artifactPrefix}` ||
    new Set([
      binding.evidenceArtifact.id,
      binding.receiptArtifact.id,
      binding.ledgerArtifact.id,
      binding.authorityArtifact.id,
      binding.terminalArtifact.id,
    ]).size !== 5 ||
    binding.ledgerArtifact.attestationID ===
      binding.authorityArtifact.attestationID
  ) {
    fail("PHASE_RECEIPT_ARTIFACT_CHAIN_INVALID", expectedPhase);
  }
}

export function verifyPhaseReceiptBindingDocument(binding, expectedPhase) {
  if (
    !["preregistration", "provider-preflight", "canary"].includes(expectedPhase)
  )
    fail("PHASE_RECEIPT_BINDING_INVALID", expectedPhase);
  validatePhaseReceiptBinding(binding, expectedPhase);
  return binding;
}

function validateRetainedPhaseArtifact(value, contentHashField) {
  const extraFields =
    contentHashField === "envelopeSha256" ? ["subjectSha256"] : [];
  const attestationFields =
    contentHashField === "envelopeSha256" ? [] : ["attestationID"];
  exactKeys(
    value,
    [
      "id",
      "name",
      "digest",
      contentHashField,
      ...extraFields,
      ...attestationFields,
    ],
    "RETAINED_PHASE_ARTIFACT_INVALID",
  );
  if (
    !/^\d+$/.test(value.id) ||
    (contentHashField !== "envelopeSha256" &&
      !/^\d+$/.test(value.attestationID))
  )
    fail("RETAINED_PHASE_ARTIFACT_INVALID");
  normalizeSha256(value.digest, "retained phase artifact digest");
  normalizeSha256(value[contentHashField], "retained phase content hash");
  if (contentHashField === "envelopeSha256")
    normalizeSha256(value.subjectSha256, "retained terminal subject hash");
}

function validateCanaryReceiptBinding(binding) {
  validatePhaseReceiptBinding(binding, "canary");
}

function validatePhaseAuthoritySet(value) {
  if (!PHASES.has(value.phase)) fail("PHASE_AUTHORITY_SET_INVALID");
  if (value.phase === "preregistration") {
    if (
      value.preregistrationReceipt !== null ||
      value.providerPreflightReceipt !== null ||
      value.priorPhaseReceipt !== null ||
      value.canaryReceipt !== null
    )
      fail("PHASE_AUTHORITY_SET_INVALID", value.phase);
    return;
  }
  validatePhaseReceiptBinding(value.preregistrationReceipt, "preregistration");
  if (value.phase === "provider-preflight") {
    if (
      value.providerPreflightReceipt !== null ||
      value.priorPhaseReceipt !== null ||
      value.canaryReceipt !== null
    )
      fail("PHASE_AUTHORITY_SET_INVALID", value.phase);
    return;
  }
  validatePhaseReceiptBinding(
    value.providerPreflightReceipt,
    "provider-preflight",
  );
  validatePhaseReceiptBinding(
    value.priorPhaseReceipt,
    value.phase === "canary" ? "provider-preflight" : "canary",
  );
  if (value.phase === "canary") {
    if (
      value.canaryReceipt !== null ||
      canonicalJson(value.providerPreflightReceipt) !==
        canonicalJson(value.priorPhaseReceipt)
    )
      fail("PHASE_AUTHORITY_SET_INVALID", value.phase);
    return;
  }
  validateCanaryReceiptBinding(value.canaryReceipt);
  if (
    canonicalJson(value.canaryReceipt) !==
    canonicalJson(value.priorPhaseReceipt)
  )
    fail("PHASE_AUTHORITY_SET_INVALID", value.phase);
}

function validateNamespaceRegistryChain(value) {
  const registry = validateNamespaceRegistry(value.namespaceRegistry);
  if (value.phase === "preregistration") {
    if (
      registry.priorRegistrySha256 !== null ||
      REGISTRY_NAMESPACE_KEYS.some(
        (key) => registry.namespaces[key].length !== 0,
      )
    )
      fail("PREREGISTRATION_NAMESPACE_REGISTRY_INVALID");
    return;
  }
  const priorBinding =
    value.phase === "provider-preflight"
      ? value.preregistrationReceipt
      : value.priorPhaseReceipt;
  if (registry.priorRegistrySha256 !== priorBinding.namespaceRegistrySha256)
    fail("NAMESPACE_REGISTRY_PRIOR_BINDING_MISMATCH");
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
    run.event !== (expected.event ?? "workflow_dispatch") ||
    metadata.repository.visibility !== "public" ||
    (expected.headSha !== undefined && run.head_sha !== expected.headSha) ||
    (expected.repository !== undefined &&
      metadata.repository.full_name !== expected.repository) ||
    (expected.workflowID !== undefined &&
      run.workflow_id !== expected.workflowID) ||
    (expected.workflowPath !== undefined &&
      run.path !== expected.workflowPath) ||
    (expected.actor !== undefined && run.actor?.login !== expected.actor) ||
    (expected.triggeringActor !== undefined &&
      run.triggering_actor?.login !== expected.triggeringActor) ||
    (expected.headRepository !== undefined &&
      run.head_repository?.full_name !== expected.headRepository) ||
    (expected.ref !== undefined &&
      `refs/heads/${run.head_branch}` !== expected.ref) ||
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
    metadata.actor?.login !== binding.actor ||
    metadata.triggering_actor?.login !== binding.triggeringActor ||
    metadata.head_repository?.full_name !== binding.headRepository ||
    `refs/heads/${metadata.head_branch}` !== binding.ref ||
    metadata.event !== binding.event ||
    metadata.status !== "completed" ||
    metadata.conclusion !== "success" ||
    metadata.event !== "push"
  ) {
    fail("SOURCE_CI_METADATA_IDENTITY_MISMATCH");
  }
  return true;
}

export async function verifyEvidenceBindings({
  evidenceRoot,
  request,
  verifierAggregatePath,
  boundVerifierAggregatePath = null,
}) {
  const boundFiles = {};
  for (const [pathField, hashField] of [
    ["preRegistrationPath", "preRegistrationSha256"],
    ["localIndexPath", "localIndexSha256"],
    ["localSealPath", "localSealFileSha256"],
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
  const aggregate = await readPrivacyValidatedJsonFile(
    verifierAggregatePath,
    "verifier aggregate",
  );
  validateVerifierAggregate(aggregate, request.phase);
  if (boundVerifierAggregatePath !== null) {
    const boundAggregate = await readPrivacyValidatedJsonFile(
      boundVerifierAggregatePath,
      "bound verifier aggregate",
    );
    validateVerifierAggregate(boundAggregate, request.phase);
    if (canonicalJson(aggregate) !== canonicalJson(boundAggregate))
      fail("VERIFIER_AGGREGATE_RERUN_MISMATCH");
  }
  const preregCreatedAt = Date.parse(prereg.createdAt ?? "");
  if (!Number.isFinite(preregCreatedAt))
    fail("PREREGISTRATION_CREATED_AT_INVALID");
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
  let preregLedger = null;
  let providerPreflightLedger = null;
  let priorPhaseLedger = null;
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
    preregLedger = await verifyBoundPhaseReceipt(
      evidenceRoot,
      request,
      request.preregistrationReceipt,
      "preregistration",
    );
    if (Date.parse(preregLedger.completedAt) < preregCreatedAt)
      fail("PREREGISTRATION_LEDGER_CHRONOLOGY_INVALID");
    if (request.phase === "canary" || request.phase === "confirmatory") {
      providerPreflightLedger = await verifyBoundPhaseReceipt(
        evidenceRoot,
        request,
        request.providerPreflightReceipt,
        "provider-preflight",
      );
      if (
        Date.parse(providerPreflightLedger.completedAt) <
        Date.parse(preregLedger.completedAt)
      )
        fail("PROVIDER_PREFLIGHT_LEDGER_CHRONOLOGY_INVALID");
      if (request.phase === "confirmatory") {
        priorPhaseLedger = await verifyBoundCanaryReceipt(
          evidenceRoot,
          request,
          index,
        );
        if (
          Date.parse(priorPhaseLedger.completedAt) <
          Date.parse(providerPreflightLedger.completedAt)
        )
          fail("CANARY_LEDGER_CHRONOLOGY_INVALID");
      } else {
        priorPhaseLedger = providerPreflightLedger;
      }
    } else {
      priorPhaseLedger = preregLedger;
    }
  }
  return {
    prereg,
    index,
    localSeal,
    aggregate,
    preregLedger,
    providerPreflightLedger,
    priorPhaseLedger,
  };
}

function validateVerifierAggregate(aggregate, expectedPhase) {
  exactKeys(
    aggregate,
    [
      "schemaVersion",
      "integrityVerified",
      "experimentUsable",
      "phase",
      "verifiedRunCount",
      "completePairCount",
      "diagnostics",
      "performanceClaimAuthorized",
      "authenticity",
    ],
    "VERIFIER_AGGREGATE_SCHEMA_INVALID",
  );
  exactKeys(
    aggregate.authenticity,
    ["verified", "status", "sealSha256"],
    "VERIFIER_AGGREGATE_SCHEMA_INVALID",
  );
  if (
    aggregate.schemaVersion !== 2 ||
    aggregate.integrityVerified !== true ||
    aggregate.experimentUsable !== false ||
    aggregate.phase !== expectedPhase ||
    !Number.isSafeInteger(aggregate.verifiedRunCount) ||
    aggregate.verifiedRunCount < 0 ||
    !Number.isSafeInteger(aggregate.completePairCount) ||
    aggregate.completePairCount < 0 ||
    !Array.isArray(aggregate.diagnostics) ||
    aggregate.performanceClaimAuthorized !== false ||
    aggregate.authenticity.verified !== false ||
    aggregate.authenticity.status !== "external-seal-receipt-required"
  )
    fail("VERIFIER_AGGREGATE_SCHEMA_INVALID");
  normalizeRawSha256(
    aggregate.authenticity.sealSha256,
    "verifier aggregate seal SHA-256",
  );
  for (const diagnostic of aggregate.diagnostics) {
    exactKeys(
      diagnostic,
      ["code", "path"],
      "VERIFIER_AGGREGATE_SCHEMA_INVALID",
    );
    if (
      !SAFE_ID.test(diagnostic.code) ||
      (diagnostic.path !== null && !safeRelativePath(diagnostic.path))
    )
      fail("VERIFIER_AGGREGATE_SCHEMA_INVALID");
  }
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
    ledger.namespaceRegistry.registrySha256 !==
      binding.namespaceRegistrySha256 ||
    binding.workflowPath !== ledger.workflowPath ||
    binding.workflowID !== ledger.workflowID ||
    binding.workflowName !== ledger.workflowName ||
    binding.actor !== ledger.actor ||
    binding.triggeringActor !== ledger.triggeringActor ||
    binding.event !== ledger.event ||
    binding.ref !== ledger.ref ||
    binding.phase !== ledger.phase ||
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
  const ledger = await verifyBoundPhaseReceipt(
    evidenceRoot,
    request,
    binding,
    "canary",
  );
  if (
    normalizeRawSha256(
      index.canarySealSha256,
      "confirmatory canary local seal",
    ) !== binding.localSealSha256
  ) {
    fail("CONFIRMATORY_CANARY_LOCAL_SEAL_MISMATCH");
  }
  return ledger;
}

export async function scanPrivacyAndInventory(
  root,
  { validateCoworldReceipts = true } = {},
) {
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
      const parsed = parseJsonText(text, entry.path);
      inspectJsonPrivacy(parsed, entry.path);
      if (entry.path === "commander-xp-preregistration-v2.json") {
        const privacyContract = parsed?.privacyContract;
        exactKeys(
          privacyContract,
          [
            "promptBodiesRetained",
            "providerBodiesRetained",
            "inboundCommsBodiesRetained",
            "outboundCommsBodiesRetained",
            "uploadUrlsRetained",
            "environmentValuesRetained",
            "promptAndOutputHashesOnly",
          ],
          "PRIVACY_CONTRACT_SCHEMA_MISMATCH",
        );
        if (
          privacyContract.promptBodiesRetained !== false ||
          privacyContract.providerBodiesRetained !== false ||
          privacyContract.inboundCommsBodiesRetained !== false ||
          privacyContract.outboundCommsBodiesRetained !== false ||
          privacyContract.uploadUrlsRetained !== false ||
          privacyContract.environmentValuesRetained !== false ||
          privacyContract.promptAndOutputHashesOnly !== true
        ) {
          fail("PRIVACY_CONTRACT_INVALID", entry.path);
        }
      }
      if (entry.path === "commander-xp-local-verification-v2.json") {
        exactKeys(
          parsed,
          [
            "schemaVersion",
            "verifierSchemaVersion",
            "phase",
            "integrityExpected",
            "experimentUsable",
            "authenticity",
          ],
          "LOCAL_VERIFICATION_SCHEMA_MISMATCH",
        );
        if (
          parsed.schemaVersion !== 2 ||
          parsed.verifierSchemaVersion !== 2 ||
          !PHASES.has(parsed.phase) ||
          parsed.integrityExpected !== true ||
          parsed.experimentUsable !== false ||
          parsed.authenticity !== "external-seal-receipt-required"
        ) {
          fail("LOCAL_VERIFICATION_DECLARATION_INVALID", entry.path);
        }
      }
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
  if (validateCoworldReceipts) {
    await validateCoworldProjectionReceipts(root, inventory);
  }
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
        "gameID",
        "seed",
        "coworldID",
        "coworldVersion",
        "variantID",
        "include",
        "manifestSha256",
        "outerBundleSha256",
        "members",
        "projections",
      ],
      "COWORLD_BUNDLE_RECEIPT_SCHEMA_INVALID",
    );
    if (
      receipt.schemaVersion !== 2 ||
      receipt.authority !== "coworld-authenticated-bundle-projection-v2" ||
      !Number.isFinite(Date.parse(receipt.downloadedAt)) ||
      [
        receipt.xpRequestID,
        receipt.episodeRequestID,
        receipt.jobID,
        receipt.episodeID,
        receipt.gameID,
      ].some((value) => !SAFE_ID.test(value)) ||
      !Number.isSafeInteger(receipt.seed) ||
      receipt.seed < 0 ||
      !SAFE_ID.test(receipt.coworldID) ||
      !SAFE_ID.test(receipt.coworldVersion) ||
      !SAFE_ID.test(receipt.variantID) ||
      canonicalJson(receipt.include) !==
        canonicalJson(["results", "replay", "game_logs"]) ||
      !Array.isArray(receipt.members) ||
      receipt.members.length !== 4
    ) {
      fail("COWORLD_BUNDLE_RECEIPT_IDENTITY_INVALID", receiptPath);
    }
    normalizeRawSha256(receipt.manifestSha256, "Coworld manifest SHA-256");
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
    const expectedMembers = [
      "logs/game.log",
      "manifest.json",
      "replay",
      "results.json",
    ];
    if (
      receipt.members.some(
        (entry, index) => entry.path !== expectedMembers[index],
      )
    ) {
      fail("COWORLD_BUNDLE_MEMBER_ORDER_INVALID", receiptPath);
    }
    if (
      receipt.members.find((member) => member.path === "manifest.json")
        ?.sha256 !== receipt.manifestSha256
    )
      fail("COWORLD_BUNDLE_MANIFEST_HASH_MISMATCH", receiptPath);
    exactKeys(
      receipt.projections,
      [
        "replayEvidenceSha256",
        "episodeResultsSha256",
        "gameEvidenceSha256",
        "commandReceiptsSha256",
      ],
      "COWORLD_BUNDLE_PROJECTION_SCHEMA_INVALID",
    );
    const isPreflight = runRoot.includes("/provider-preflight/");
    for (const [field, suffix] of [
      ["replayEvidenceSha256", "replay-evidence.json"],
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
    for (const [field, suffix] of [
      ["episodeResultsSha256", "episode-results.json"],
      ["gameEvidenceSha256", "game-evidence.jsonl"],
    ]) {
      const actual = hashes.get(`${runRoot}/${suffix}`);
      if (isPreflight) {
        if (receipt.projections[field] !== null || actual !== undefined)
          fail(
            "COWORLD_PREFLIGHT_GAMEPLAY_PROJECTION_PRESENT",
            `${receiptPath}:${field}`,
          );
      } else if (
        actual === undefined ||
        normalizeSha256(receipt.projections[field], field) !== actual
      ) {
        fail(
          "COWORLD_BUNDLE_PROJECTION_HASH_MISMATCH",
          `${receiptPath}:${field}`,
        );
      }
    }
    const xp = await readJsonFile(
      path.join(root, `${runRoot}/xp-evidence.json`),
    );
    const replay = await readJsonFile(
      path.join(root, `${runRoot}/replay-evidence.json`),
    );
    const results = isPreflight
      ? null
      : await readJsonFile(path.join(root, `${runRoot}/episode-results.json`));
    const joined = {
      xpRequestID: xp.xpRequestID,
      episodeRequestID: xp.episodeRequestID,
      jobID: xp.jobID,
      episodeID: xp.episodeID,
      gameID: replay.matchID,
      seed: replay.config?.seed,
      coworldID: xp.coworldID,
      coworldVersion: xp.coworldVersion,
      variantID: xp.variantID,
    };
    for (const [field, expected] of Object.entries(joined)) {
      if (receipt[field] !== expected) {
        fail(
          "COWORLD_BUNDLE_IDENTITY_JOIN_MISMATCH",
          `${receiptPath}:${field}`,
        );
      }
    }
    for (const field of [
      "xpRequestID",
      "episodeRequestID",
      "jobID",
      "episodeID",
    ]) {
      if (replay[field] !== receipt[field])
        fail(
          "COWORLD_REPLAY_IDENTITY_JOIN_MISMATCH",
          `${receiptPath}:${field}`,
        );
    }
    if (
      results !== null &&
      (results.gameID !== receipt.gameID || results.seed !== receipt.seed)
    ) {
      fail("COWORLD_REPLAY_GAME_JOIN_MISMATCH", receiptPath);
    }
    const replayDigest = replay.contentSha256 ?? replay.replaySha256;
    const replayMember = receipt.members.find(
      (member) => member.path === "replay",
    );
    if (
      replayMember === undefined ||
      normalizeRawSha256(
        replayMember.sha256,
        "Coworld replay member SHA-256",
      ) !== normalizeRawSha256(replayDigest, "replay evidence content SHA-256")
    ) {
      fail("COWORLD_REPLAY_MEMBER_HASH_MISMATCH", receiptPath);
    }
  }
}

const REGISTRY_NAMESPACE_KEYS = [
  "decisionRequestID",
  "episodeID",
  "episodeRequestID",
  "jobID",
  "providerRequestID",
  "replayPath",
  "replayURLSha256",
  "runKey",
  "xpRequestID",
];

export async function buildNamespaceRegistry(
  evidenceRoot,
  phase,
  priorRegistry = null,
) {
  if (!PHASES.has(phase)) fail("NAMESPACE_REGISTRY_PHASE_INVALID");
  const current = Object.fromEntries(
    REGISTRY_NAMESPACE_KEYS.map((key) => [key, new Map()]),
  );
  if (phase !== "preregistration") {
    const prereg = await readJsonFile(
      path.join(evidenceRoot, "commander-xp-preregistration-v2.json"),
    );
    const planned =
      phase === "provider-preflight"
        ? Array.isArray(prereg.providerPreflightRequests)
          ? prereg.providerPreflightRequests
          : []
        : Array.isArray(prereg.requests)
          ? prereg.requests.filter((entry) => entry?.phase === phase)
          : [];
    for (const [index, entry] of planned.entries()) {
      registerNamespace(
        current.runKey,
        entry?.runKey,
        "runKey",
        `plan:${index}`,
      );
    }
    const inventory = await inventoryRegularFiles(evidenceRoot);
    for (const entry of inventory) {
      const absolute = path.join(evidenceRoot, entry.path);
      if (entry.path.endsWith("/xp-evidence.json")) {
        const xp = await readJsonFile(absolute);
        for (const key of [
          "xpRequestID",
          "episodeRequestID",
          "jobID",
          "episodeID",
          "replayPath",
          "replayURLSha256",
        ]) {
          registerNamespace(current[key], xp[key], key, entry.path);
        }
      } else if (entry.path.endsWith("/game-evidence.jsonl")) {
        const text = await fs.readFile(absolute, "utf8");
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (line === "") continue;
          const record = parseJsonText(line, `${entry.path}:${index + 1}`);
          registerNamespace(
            current.decisionRequestID,
            record.requestID,
            "decisionRequestID",
            entry.path,
            true,
          );
        }
      } else if (entry.path.endsWith("/player-artifact/trace.jsonl")) {
        const text = await fs.readFile(absolute, "utf8");
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (line === "") continue;
          const record = parseJsonText(line, `${entry.path}:${index + 1}`);
          if (record.recordType === "provider") {
            registerNamespace(
              current.providerRequestID,
              record.requestID,
              "providerRequestID",
              entry.path,
              true,
            );
          }
        }
      }
    }
  }
  const prior =
    priorRegistry === null
      ? emptyNamespaceRegistry()
      : validateNamespaceRegistry(priorRegistry);
  const namespaces = {};
  for (const key of REGISTRY_NAMESPACE_KEYS) {
    const union = new Set(prior.namespaces[key]);
    for (const value of current[key].keys()) {
      if (union.has(value))
        fail("CROSS_PHASE_NAMESPACE_REUSE", `${key}:${value}`);
      union.add(value);
    }
    namespaces[key] = [...union].sort();
  }
  const body = {
    schemaVersion: 2,
    mode: "cumulative-per-namespace",
    priorRegistrySha256: priorRegistry === null ? null : prior.registrySha256,
    namespaces,
  };
  return {
    ...body,
    registrySha256: normalizeRawSha256(
      sha256Bytes(Buffer.from(canonicalJson(body))),
      "namespace registry SHA-256",
    ),
  };
}

function emptyNamespaceRegistry() {
  return {
    schemaVersion: 2,
    mode: "cumulative-per-namespace",
    priorRegistrySha256: null,
    namespaces: Object.fromEntries(
      REGISTRY_NAMESPACE_KEYS.map((key) => [key, []]),
    ),
    registrySha256: "",
  };
}

function validateNamespaceRegistry(value) {
  exactKeys(
    value,
    [
      "schemaVersion",
      "mode",
      "priorRegistrySha256",
      "namespaces",
      "registrySha256",
    ],
    "NAMESPACE_REGISTRY_INVALID",
  );
  exactKeys(
    value.namespaces,
    REGISTRY_NAMESPACE_KEYS,
    "NAMESPACE_REGISTRY_INVALID",
  );
  const { registrySha256, ...body } = value;
  if (
    value.schemaVersion !== 2 ||
    value.mode !== "cumulative-per-namespace" ||
    (value.priorRegistrySha256 !== null &&
      normalizeRawSha256(
        value.priorRegistrySha256,
        "prior registry SHA-256",
      ) !== value.priorRegistrySha256) ||
    normalizeRawSha256(registrySha256, "registry SHA-256") !==
      normalizeRawSha256(
        sha256Bytes(Buffer.from(canonicalJson(body))),
        "computed registry SHA-256",
      )
  )
    fail("NAMESPACE_REGISTRY_INVALID");
  for (const key of REGISTRY_NAMESPACE_KEYS) {
    const entries = value.namespaces[key];
    if (
      !Array.isArray(entries) ||
      entries.some((entry) => !validNamespaceValue(key, entry)) ||
      new Set(entries).size !== entries.length ||
      entries.some((entry, index) => entry !== [...entries].sort()[index])
    )
      fail("NAMESPACE_REGISTRY_INVALID", key);
  }
  return value;
}

function registerNamespace(
  namespace,
  value,
  label,
  owner,
  allowSameOwner = false,
) {
  if (!validNamespaceValue(label, value)) fail("NAMESPACE_ID_INVALID", label);
  const previousOwner = namespace.get(value);
  if (
    previousOwner !== undefined &&
    (!allowSameOwner || previousOwner !== owner)
  )
    fail("CURRENT_PHASE_NAMESPACE_REUSE", `${label}:${value}`);
  namespace.set(value, owner);
}

function validNamespaceValue(namespace, value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 500 ||
    hasControlCharacters(value)
  )
    return false;
  if (namespace === "xpRequestID") return /^xreq_[A-Za-z0-9-]+$/.test(value);
  if (namespace === "episodeRequestID")
    return /^ereq_[A-Za-z0-9-]+$/.test(value);
  if (namespace === "replayURLSha256") return /^[0-9a-f]{64}$/.test(value);
  if (namespace === "replayPath") return safeAbsoluteUrlPath(value);
  if (namespace === "runKey") return safeRelativePath(value);
  return SAFE_ID.test(value);
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
  if (
    bindings.priorPhaseLedger !== null &&
    Date.parse(normalizedCreatedAt) <=
      Date.parse(bindings.priorPhaseLedger.completedAt)
  )
    fail("SEAL_BEFORE_IMMEDIATE_PRIOR_PHASE");
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
  await fs.copyFile(
    verifierAggregatePath,
    path.join(outputRoot, BUNDLE_VERIFIER_AGGREGATE_PATH),
    fsConstants.COPYFILE_EXCL,
  );
  await fs.chmod(path.join(outputRoot, BUNDLE_VERIFIER_AGGREGATE_PATH), 0o600);
  const treeDiffPath = path.join(outputRoot, TREE_DIFF_FILE);
  await writeJsonExclusive(treeDiffPath, treeDiff);
  const treeDiffSha256 = await sha256File(treeDiffPath);
  const privacyInventorySha256 = sha256Bytes(
    Buffer.from(canonicalJson(inventory.files)),
  );
  const priorRegistry =
    bindings.priorPhaseLedger === null
      ? null
      : bindings.priorPhaseLedger.namespaceRegistry;
  const namespaceRegistry = await buildNamespaceRegistry(
    evidenceRoot,
    request.phase,
    priorRegistry,
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
    preregistrationReceipt: request.preregistrationReceipt,
    providerPreflightReceipt: request.providerPreflightReceipt,
    priorPhaseReceipt: request.priorPhaseReceipt,
    canaryReceipt: request.canaryReceipt,
    namespaceRegistry,
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
      aggregatePath: BUNDLE_VERIFIER_AGGREGATE_PATH,
      aggregateSha256: await sha256File(verifierAggregatePath),
      preregistrationReceiptSha256:
        request.preregistrationReceipt === null
          ? null
          : normalizeSha256(request.preregistrationReceipt.sha256),
      providerPreflightReceiptSha256:
        request.providerPreflightReceipt === null
          ? null
          : normalizeSha256(request.providerPreflightReceipt.sha256),
      priorPhaseReceiptSha256:
        request.priorPhaseReceipt === null
          ? null
          : normalizeSha256(request.priorPhaseReceipt.sha256),
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
    {
      path: BUNDLE_VERIFIER_AGGREGATE_PATH,
      sha256: manifest.evidence.aggregateSha256,
    },
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
      "preregistrationReceipt",
      "providerPreflightReceipt",
      "priorPhaseReceipt",
      "canaryReceipt",
      "namespaceRegistry",
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
  const request = await verifyBundleRequestBinding(root, manifest);
  await verifyEvidenceBindings({
    evidenceRoot: path.join(root, "evidence"),
    request,
    verifierAggregatePath: path.join(root, BUNDLE_VERIFIER_AGGREGATE_PATH),
    boundVerifierAggregatePath: path.join(root, BUNDLE_VERIFIER_AGGREGATE_PATH),
  });
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
    BUNDLE_VERIFIER_AGGREGATE_PATH,
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
  if (
    (await sha256File(path.join(root, BUNDLE_VERIFIER_AGGREGATE_PATH))) !==
    normalizeSha256(manifest.evidence.aggregateSha256)
  )
    fail("BUNDLE_VERIFIER_AGGREGATE_HASH_MISMATCH");
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
    preregistrationReceiptSha256:
      request.preregistrationReceipt === null
        ? null
        : normalizeSha256(request.preregistrationReceipt.sha256),
    providerPreflightReceiptSha256:
      request.providerPreflightReceipt === null
        ? null
        : normalizeSha256(request.providerPreflightReceipt.sha256),
    priorPhaseReceiptSha256:
      request.priorPhaseReceipt === null
        ? null
        : normalizeSha256(request.priorPhaseReceipt.sha256),
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
    preregistrationReceiptSha256:
      manifest.evidence.preregistrationReceiptSha256,
    providerPreflightReceiptSha256:
      manifest.evidence.providerPreflightReceiptSha256,
    priorPhaseReceiptSha256: manifest.evidence.priorPhaseReceiptSha256,
    canaryReceiptSha256: manifest.evidence.canaryReceiptSha256,
  };
  if (
    manifest.experimentID !== request.experimentID ||
    manifest.phase !== request.phase ||
    canonicalJson(manifest.sourceCI) !== canonicalJson(request.sourceCI) ||
    canonicalJson(manifestSourceBinding) !== canonicalJson(request.source) ||
    canonicalJson(manifest.sourceArtifact) !==
      canonicalJson(request.sourceArtifact) ||
    canonicalJson(manifest.preregistrationReceipt) !==
      canonicalJson(request.preregistrationReceipt) ||
    canonicalJson(manifest.providerPreflightReceipt) !==
      canonicalJson(request.providerPreflightReceipt) ||
    canonicalJson(manifest.priorPhaseReceipt) !==
      canonicalJson(request.priorPhaseReceipt) ||
    canonicalJson(manifest.canaryReceipt) !==
      canonicalJson(request.canaryReceipt) ||
    canonicalJson(actualEvidence) !== canonicalJson(expectedEvidence)
  ) {
    fail("BUNDLE_REQUEST_CROSS_BINDING_MISMATCH");
  }
  return request;
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
  validatePhaseAuthoritySet(manifest);
  validateNamespaceRegistryChain(manifest);
  exactKeys(
    manifest.evidence,
    [
      "requestPath",
      "requestSha256",
      "preRegistrationSha256",
      "localIndexSha256",
      "localSealFileSha256",
      "localSealSha256",
      "aggregatePath",
      "aggregateSha256",
      "preregistrationReceiptSha256",
      "providerPreflightReceiptSha256",
      "priorPhaseReceiptSha256",
      "canaryReceiptSha256",
    ],
    "BUNDLE_EVIDENCE_SCHEMA_INVALID",
  );
  if (manifest.evidence.requestPath !== BUNDLE_REQUEST_PATH)
    fail("BUNDLE_REQUEST_PATH_INVALID");
  if (manifest.evidence.aggregatePath !== BUNDLE_VERIFIER_AGGREGATE_PATH)
    fail("BUNDLE_VERIFIER_AGGREGATE_PATH_INVALID");
  for (const [key, value] of Object.entries(manifest.evidence)) {
    if (
      key === "requestPath" ||
      key === "aggregatePath" ||
      ([
        "preregistrationReceiptSha256",
        "providerPreflightReceiptSha256",
        "priorPhaseReceiptSha256",
        "canaryReceiptSha256",
      ].includes(key) &&
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
  platformRefetchPath,
  outputPath,
  bundleArtifactMetadataPath,
  completedAt,
}) {
  const manifest = await verifyBundle(bundleRoot);
  await verifyPlatformRefetchReceipt(platformRefetchPath, manifest);
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
    event: "workflow_run",
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
    preregistrationReceipt: manifest.preregistrationReceipt,
    providerPreflightReceipt: manifest.providerPreflightReceipt,
    priorPhaseReceipt: manifest.priorPhaseReceipt,
    canaryReceipt: manifest.canaryReceipt,
    namespaceRegistry: manifest.namespaceRegistry,
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
      providerPreflightReceiptSha256:
        manifest.evidence.providerPreflightReceiptSha256,
      priorPhaseReceiptSha256: manifest.evidence.priorPhaseReceiptSha256,
      canaryReceiptSha256: manifest.evidence.canaryReceiptSha256,
      namespaceRegistrySha256: manifest.namespaceRegistry.registrySha256,
      treeDiffSha256: manifest.source.treeDiffSha256,
      privacyInventorySha256: manifest.privacy.inventorySha256,
      platformRefetchSha256: await sha256File(platformRefetchPath),
    },
    attestation: {
      required: true,
      issuer: "GitHub Actions OIDC / Sigstore public-good instance",
      subjects: [
        "sealed-bundle",
        EXTERNAL_RECEIPT_FILE,
        "commander-xp-independent-platform-refetch-v2.json",
      ],
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
      "preregistrationReceipt",
      "providerPreflightReceipt",
      "priorPhaseReceipt",
      "canaryReceipt",
      "namespaceRegistry",
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
      canonicalJson([
        "sealed-bundle",
        EXTERNAL_RECEIPT_FILE,
        "commander-xp-independent-platform-refetch-v2.json",
      ])
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
  validatePhaseAuthoritySet(receipt);
  validateNamespaceRegistryChain(receipt);
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
      "providerPreflightReceiptSha256",
      "priorPhaseReceiptSha256",
      "canaryReceiptSha256",
      "namespaceRegistrySha256",
      "treeDiffSha256",
      "privacyInventorySha256",
      "platformRefetchSha256",
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
  if (
    receipt.evidence.namespaceRegistrySha256 !==
    receipt.namespaceRegistry.registrySha256
  )
    fail("EXTERNAL_RECEIPT_NAMESPACE_REGISTRY_MISMATCH");
  for (const [bindingField, hashField] of [
    ["preregistrationReceipt", "preregistrationReceiptSha256"],
    ["providerPreflightReceipt", "providerPreflightReceiptSha256"],
    ["priorPhaseReceipt", "priorPhaseReceiptSha256"],
    ["canaryReceipt", "canaryReceiptSha256"],
  ]) {
    const binding = receipt[bindingField];
    const digest = receipt.evidence[hashField];
    if (
      (binding === null && digest !== null) ||
      (binding !== null && normalizeSha256(binding.sha256) !== digest)
    )
      fail("EXTERNAL_RECEIPT_AUTHORITY_HASH_MISMATCH", bindingField);
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
  for (const field of [
    "preregistrationReceipt",
    "providerPreflightReceipt",
    "priorPhaseReceipt",
    "canaryReceipt",
    "namespaceRegistry",
  ]) {
    if (canonicalJson(receipt[field]) !== canonicalJson(manifest[field]))
      fail("LEDGER_RECEIPT_BUNDLE_AUTHORITY_MISMATCH", field);
  }
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
    event: "workflow_run",
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
    triggeringActor: metadata.workflowRun.triggering_actor?.login,
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
    preregistrationReceipt: manifest.preregistrationReceipt,
    providerPreflightReceipt: manifest.providerPreflightReceipt,
    priorPhaseReceipt: manifest.priorPhaseReceipt,
    canaryReceipt: manifest.canaryReceipt,
    namespaceRegistry: manifest.namespaceRegistry,
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
      platformRefetchSha256: normalizeRawSha256(
        receipt.evidence.platformRefetchSha256,
        "platform refetch SHA-256",
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
      "triggeringActor",
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
      "preregistrationReceipt",
      "providerPreflightReceipt",
      "priorPhaseReceipt",
      "canaryReceipt",
      "namespaceRegistry",
      "evidenceArtifact",
      "receiptArtifact",
      "ledgerSha256",
    ],
    "EXTERNAL_PHASE_LEDGER_SCHEMA_INVALID",
  );
  validateLedgerEvidenceArtifact(ledger.evidenceArtifact);
  validateLedgerReceiptArtifact(ledger.receiptArtifact);
  validatePhaseAuthoritySet(ledger);
  validateNamespaceRegistryChain(ledger);
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
    ledger.triggeringActor !== "0xNad" ||
    ledger.event !== "workflow_run" ||
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

export async function verifyRetainedPhaseAuthority({
  ledgerPath,
  authorityReceiptPath,
  terminalEnvelopePath,
  binding,
  phase,
}) {
  validatePhaseReceiptBinding(binding, phase);
  if (
    (await sha256File(ledgerPath)) !== normalizeSha256(binding.sha256) ||
    binding.ledgerArtifact.ledgerSha256 !== binding.ledgerSha256
  ) {
    fail("RETAINED_LEDGER_SUBJECT_MISMATCH", phase);
  }
  const ledger = await verifyExternalPhaseLedger(ledgerPath, {
    phase,
    experimentID: binding.experimentID,
    behaviorBaseSha: binding.behaviorBaseSha,
    behaviorBaseTreeSha: binding.behaviorBaseTreeSha,
    headSha: binding.headSha,
    treeSha: binding.treeSha,
  });
  const authority = await readJsonFile(authorityReceiptPath);
  exactKeys(
    authority,
    [
      "schemaVersion",
      "authority",
      "repository",
      "workflowPath",
      "workflowID",
      "workflowName",
      "actor",
      "triggeringActor",
      "event",
      "workflowRef",
      "experimentID",
      "runId",
      "attempt",
      "headSha",
      "treeSha",
      "behaviorBaseSha",
      "behaviorBaseTreeSha",
      "localSealSha256",
      "phase",
      "sourceCI",
      "collectorArtifact",
      "bundleArtifact",
      "receiptArtifact",
      "ledgerArtifact",
      "attestations",
      "integrityVerified",
      "experimentUsable",
      "performanceClaimAuthorized",
    ],
    "RETAINED_AUTHORITY_SCHEMA_INVALID",
  );
  if (
    (await sha256File(authorityReceiptPath)) !==
      normalizeSha256(binding.authorityArtifact.receiptSha256) ||
    authority.schemaVersion !== 1 ||
    authority.authority !==
      "github-actions-protected-main-public-sigstore-v1" ||
    authority.repository !== ledger.repository ||
    authority.workflowPath !== ledger.workflowPath ||
    authority.workflowID !== ledger.workflowID ||
    authority.workflowName !== ledger.workflowName ||
    authority.actor !== ledger.actor ||
    authority.triggeringActor !== ledger.triggeringActor ||
    authority.event !== ledger.event ||
    authority.workflowRef !== ledger.ref ||
    authority.experimentID !== ledger.experimentID ||
    authority.runId !== ledger.runId ||
    authority.attempt !== ledger.attempt ||
    authority.headSha !== ledger.headSha ||
    authority.treeSha !== ledger.treeSha ||
    authority.behaviorBaseSha !== ledger.behaviorBaseSha ||
    authority.behaviorBaseTreeSha !== ledger.behaviorBaseTreeSha ||
    authority.localSealSha256 !== ledger.evidenceArtifact.localSealSha256 ||
    authority.phase !== ledger.phase ||
    canonicalJson(authority.collectorArtifact) !==
      canonicalJson(ledger.collector) ||
    String(authority.bundleArtifact?.id) !== ledger.evidenceArtifact.id ||
    normalizeSha256(authority.bundleArtifact?.digest) !==
      normalizeSha256(ledger.evidenceArtifact.digest) ||
    String(authority.receiptArtifact?.id) !== ledger.receiptArtifact.id ||
    normalizeSha256(authority.receiptArtifact?.digest) !==
      normalizeSha256(ledger.receiptArtifact.digest) ||
    String(authority.ledgerArtifact?.id) !== binding.ledgerArtifact.id ||
    normalizeSha256(authority.ledgerArtifact?.digest) !==
      normalizeSha256(binding.ledgerArtifact.digest) ||
    authority.ledgerArtifact?.ledgerSha256 !== ledger.ledgerSha256 ||
    String(authority.attestations?.ledger?.id) !==
      binding.ledgerArtifact.attestationID ||
    authority.integrityVerified !== true ||
    authority.experimentUsable !== false ||
    authority.performanceClaimAuthorized !== false
  ) {
    fail("RETAINED_AUTHORITY_CROSS_BINDING_MISMATCH", phase);
  }
  const terminal = await readJsonFile(terminalEnvelopePath);
  exactKeys(
    terminal,
    [
      "schemaVersion",
      "authority",
      "repository",
      "workflowPath",
      "workflowID",
      "workflowName",
      "actor",
      "triggeringActor",
      "event",
      "workflowRef",
      "experimentID",
      "runId",
      "attempt",
      "headSha",
      "treeSha",
      "behaviorBaseSha",
      "behaviorBaseTreeSha",
      "localSealSha256",
      "phase",
      "sourceCI",
      "collectorArtifact",
      "bundleArtifact",
      "receiptArtifact",
      "ledgerArtifact",
      "subjectAttestation",
      "ledgerAttestation",
      "authorityArtifact",
      "authorityAttestation",
      "integrityVerified",
      "experimentUsable",
      "performanceClaimAuthorized",
      "envelopeSha256",
    ],
    "RETAINED_TERMINAL_SCHEMA_INVALID",
  );
  const { envelopeSha256, ...terminalBody } = terminal;
  if (
    normalizeSha256(envelopeSha256) !==
      sha256Bytes(Buffer.from(canonicalJson(terminalBody))) ||
    normalizeSha256(envelopeSha256) !==
      normalizeSha256(binding.terminalArtifact.envelopeSha256) ||
    (await sha256File(terminalEnvelopePath)) !==
      normalizeSha256(binding.terminalArtifact.subjectSha256) ||
    terminal.schemaVersion !== 2 ||
    terminal.authority !== "github-actions-terminal-authority-envelope-v2" ||
    terminal.repository !== authority.repository ||
    terminal.workflowPath !== authority.workflowPath ||
    terminal.workflowID !== authority.workflowID ||
    terminal.workflowName !== authority.workflowName ||
    terminal.actor !== authority.actor ||
    terminal.triggeringActor !== authority.triggeringActor ||
    terminal.event !== authority.event ||
    terminal.workflowRef !== authority.workflowRef ||
    terminal.experimentID !== authority.experimentID ||
    terminal.runId !== authority.runId ||
    terminal.attempt !== authority.attempt ||
    terminal.headSha !== authority.headSha ||
    terminal.treeSha !== authority.treeSha ||
    terminal.behaviorBaseSha !== authority.behaviorBaseSha ||
    terminal.behaviorBaseTreeSha !== authority.behaviorBaseTreeSha ||
    terminal.localSealSha256 !== authority.localSealSha256 ||
    terminal.phase !== authority.phase ||
    canonicalJson(terminal.sourceCI) !== canonicalJson(authority.sourceCI) ||
    canonicalJson(terminal.collectorArtifact) !==
      canonicalJson(authority.collectorArtifact) ||
    canonicalJson(terminal.bundleArtifact) !==
      canonicalJson(authority.bundleArtifact) ||
    canonicalJson(terminal.receiptArtifact) !==
      canonicalJson(authority.receiptArtifact) ||
    canonicalJson(terminal.ledgerArtifact) !==
      canonicalJson(authority.ledgerArtifact) ||
    canonicalJson(terminal.subjectAttestation) !==
      canonicalJson(authority.attestations.subject) ||
    canonicalJson(terminal.ledgerAttestation) !==
      canonicalJson(authority.attestations.ledger) ||
    String(terminal.authorityArtifact?.id) !== binding.authorityArtifact.id ||
    normalizeSha256(terminal.authorityArtifact?.digest) !==
      normalizeSha256(binding.authorityArtifact.digest) ||
    normalizeSha256(terminal.authorityArtifact?.receiptSha256) !==
      normalizeSha256(binding.authorityArtifact.receiptSha256) ||
    String(terminal.authorityAttestation?.id) !==
      binding.authorityArtifact.attestationID ||
    terminal.integrityVerified !== true ||
    terminal.experimentUsable !== false ||
    terminal.performanceClaimAuthorized !== false
  ) {
    fail("RETAINED_TERMINAL_CROSS_BINDING_MISMATCH", phase);
  }
  return { ledger, authority, terminal };
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
      "platformRefetchSha256",
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
  normalizeRawSha256(
    value.platformRefetchSha256,
    "ledger platform refetch SHA-256",
  );
}

async function verifyPlatformRefetchReceipt(filePath, manifest) {
  const receipt = await readJsonFile(filePath);
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "authority",
      "experimentID",
      "phase",
      "preRegistrationSha256",
      "verifiedAt",
      "runCount",
      "runs",
      "refetchSha256",
    ],
    "PLATFORM_REFETCH_SCHEMA_INVALID",
  );
  const { refetchSha256, ...body } = receipt;
  const expectedCount = {
    preregistration: 0,
    "provider-preflight": 3,
    canary: 12,
    confirmatory: 96,
  }[manifest.phase];
  if (
    receipt.schemaVersion !== 2 ||
    receipt.authority !== "independent-coworld-0.1.42-refetch-v2" ||
    receipt.experimentID !== manifest.experimentID ||
    receipt.phase !== manifest.phase ||
    normalizeRawSha256(receipt.preRegistrationSha256) !==
      normalizeRawSha256(manifest.evidence.preRegistrationSha256) ||
    !Number.isFinite(Date.parse(receipt.verifiedAt)) ||
    receipt.runCount !== expectedCount ||
    !Array.isArray(receipt.runs) ||
    receipt.runs.length !== expectedCount ||
    normalizeRawSha256(refetchSha256) !==
      normalizeRawSha256(sha256Bytes(Buffer.from(canonicalJson(body))))
  ) {
    fail("PLATFORM_REFETCH_IDENTITY_INVALID");
  }
  const seen = new Set();
  for (const run of receipt.runs) {
    exactKeys(
      run,
      [
        "runPath",
        "xpRequestID",
        "episodeRequestID",
        "memberSetSha256",
        "xpEvidenceSha256",
        "normalizedReadbackSha256",
        "replayEvidenceSha256",
        "episodeResultsSha256",
        "gameEvidenceSha256",
        "playerArtifactSha256",
      ],
      "PLATFORM_REFETCH_RUN_SCHEMA_INVALID",
    );
    if (
      !/^runs\/(?:provider-preflight|canary|confirmatory)\/r\d{2}\/(?:A|B|C)$/.test(
        run.runPath,
      ) ||
      seen.has(run.runPath) ||
      !SAFE_ID.test(run.xpRequestID) ||
      !SAFE_ID.test(run.episodeRequestID)
    ) {
      fail("PLATFORM_REFETCH_RUN_IDENTITY_INVALID", run.runPath);
    }
    seen.add(run.runPath);
    for (const field of [
      "memberSetSha256",
      "xpEvidenceSha256",
      "normalizedReadbackSha256",
      "replayEvidenceSha256",
      "playerArtifactSha256",
    ]) {
      normalizeRawSha256(run[field], `platform refetch ${field}`);
    }
    const preflight = manifest.phase === "provider-preflight";
    for (const field of ["episodeResultsSha256", "gameEvidenceSha256"]) {
      if (preflight ? run[field] !== null : run[field] === null) {
        fail("PLATFORM_REFETCH_GAMEPLAY_HASH_INVALID", run.runPath);
      }
      if (run[field] !== null)
        normalizeRawSha256(run[field], `platform refetch ${field}`);
    }
  }
  return receipt;
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
