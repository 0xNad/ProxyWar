import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { coworldEpisodeIdentity } from "../../../coworld-adapter/src/coworld-seed";
import { legalActionKinds } from "./AgentTypes";
import type { CommanderXpGameEvidence } from "./CommanderXpGameEvidence";
import {
  buildCommanderXpPreRegistration,
  COMMANDER_XP_COMMANDER_METADATA_ALLOWLIST,
  commanderXpProviderPreflightRequestID,
  sha256Canonical,
  type CommanderXpArm,
  type CommanderXpPlanInput,
  type CommanderXpPlannedRequest,
  type CommanderXpPreRegistrationV2,
  type CommanderXpRequestBody,
} from "./CommanderXpProtocol";

export const COMMANDER_XP_VERIFIER_SCHEMA_VERSION = 2;

type CommanderXpEvidencePhase =
  | "preregistration"
  | "provider-preflight"
  | "canary"
  | "confirmatory";

export interface CommanderXpVerification {
  schemaVersion: 2;
  integrityVerified: boolean;
  experimentUsable: boolean;
  phase: CommanderXpEvidencePhase | null;
  verifiedRunCount: number;
  completePairCount: number;
  diagnostics: Array<{ code: string; path: string | null }>;
  performanceClaimAuthorized: false;
  authenticity: {
    verified: false;
    status: "external-seal-receipt-required";
    sealSha256: string | null;
  };
}

interface EvidenceIndex {
  schemaVersion: 2;
  experimentID: string;
  phase: CommanderXpEvidencePhase;
  preRegistrationSha256: string;
  xpOpenApiSha256: string;
  canarySealSha256: string | null;
  namespaceRegistry: NamespaceRegistry;
  artifacts: Array<{ path: string; sha256: string }>;
}

interface EvidenceSeal {
  schemaVersion: 2;
  experimentID: string;
  phase: CommanderXpEvidencePhase;
  status: "complete";
  indexSha256: string;
  sealedAt: string;
  sealSha256: string;
}

interface ExternalEvidenceArtifact {
  id: string;
  digest: string;
  aggregateSha256: string;
  attestedSubjectDigest: string;
  localSealSha256: string;
}

interface ExternalReceiptArtifact {
  id: string;
  digest: string;
  receiptSha256: string;
  attestedSubjectDigest: string;
}

interface PhaseReceiptBinding {
  phase: "preregistration" | "provider-preflight" | "canary";
  path: string;
  sha256: string;
  ledgerSha256: string;
  runId: string;
  attempt: number;
  evidenceArtifact: ExternalEvidenceArtifact;
  receiptArtifact: ExternalReceiptArtifact;
  localSealSha256: string;
  namespaceRegistrySha256: string;
  workflowPath: ".github/workflows/commander-xp-external-seal.yml";
  experimentID: string;
  behaviorBaseSha: string;
  behaviorBaseTreeSha: string;
  headSha: string;
  treeSha: string;
}

interface ExternalPhaseReceipt {
  schemaVersion: 2;
  authority: "github-actions-attested-ledger-v1";
  repository: "0xNad/ProxyWar";
  workflowPath: string;
  workflowID: string;
  workflowName: string;
  actor: "0xNad";
  event: "workflow_dispatch";
  ref: "refs/heads/main";
  experimentID: string;
  preRegistrationSha256: string;
  runId: string;
  attempt: number;
  headSha: string;
  treeSha: string;
  behaviorBaseSha: string;
  behaviorBaseTreeSha: string;
  runnerEnvironment: "github-hosted";
  attestationPolicy: {
    repository: "0xNad/ProxyWar";
    signerWorkflow: "0xNad/ProxyWar/.github/workflows/commander-xp-external-seal.yml";
    sourceRef: "refs/heads/main";
    sourceDigest: string;
    signerDigest: string;
    denySelfHostedRunners: true;
  };
  collector: {
    artifactID: number;
    artifactName: string;
    artifactDigest: string;
    workflowRunID: number;
    workflowRunAttempt: number;
    workflowID: number;
    workflowPath: ".github/workflows/commander-xp-evidence.yml";
    workflowName: "Commander XP protected experiment evidence";
    actor: "0xNad";
    headRepository: "0xNad/ProxyWar";
    event: "workflow_dispatch";
    ref: "refs/heads/main";
  };
  phase: "preregistration" | "provider-preflight" | "canary" | "confirmatory";
  completedAt: string;
  preregistrationReceipt: PhaseReceiptBinding | null;
  providerPreflightReceipt: PhaseReceiptBinding | null;
  priorPhaseReceipt: PhaseReceiptBinding | null;
  canaryReceipt: PhaseReceiptBinding | null;
  namespaceRegistry: NamespaceRegistry;
  evidenceArtifact: ExternalEvidenceArtifact;
  receiptArtifact: ExternalReceiptArtifact;
  ledgerSha256: string;
}

interface NamespaceRegistry {
  schemaVersion: 2;
  mode: "cumulative-per-namespace";
  priorRegistrySha256: string | null;
  namespaces: {
    decisionRequestID: string[];
    episodeID: string[];
    episodeRequestID: string[];
    jobID: string[];
    providerRequestID: string[];
    replayPath: string[];
    replayURLSha256: string[];
    runKey: string[];
    xpRequestID: string[];
  };
  registrySha256: string;
}

interface ConfirmatoryActivation {
  schemaVersion: 2;
  experimentID: string;
  phase: "confirmatory";
  createdAt: string;
  preRegistrationSha256: string;
  priorCanaryLedgerSha256: string;
  priorCanaryRunId: string;
  priorCanaryAttempt: number;
  priorCanaryEvidenceArtifact: ExternalPhaseReceipt["evidenceArtifact"];
  priorCanaryReceiptArtifact: ExternalPhaseReceipt["receiptArtifact"];
  priorCanaryLocalSealSha256: string;
  confirmatoryRequestPlanSha256: string;
  activationSha256: string;
}

interface PolicyIdentityReceipt {
  schemaVersion: 2;
  authority: "coworld-0.1.42-policy-inspect-v1";
  inspectedAt: string;
  policyImageID: string;
  platform: "linux/amd64";
  policyBuildProvenanceDigest: string;
  imageDigest: string;
  bedrockModel: string;
  arms: Record<
    CommanderXpArm,
    {
      policyVersionID: string;
      imageDigest: string;
      useBedrock: true;
      bedrockModel: string;
      runArgv: string[];
      inspectResponseSha256: string;
    }
  >;
}

interface CollectedXpEvidence {
  schemaVersion: 2;
  xpRequestID: string;
  xpRequestCreatedAt: string;
  xpRequestStartedAt: string;
  xpRequestCompletedAt: string;
  episodeCount: 1;
  pendingCount: 0;
  submittedCount: 0;
  runningCount: 0;
  completedCount: 1;
  failedCount: 0;
  episodeRequestID: string;
  jobID: string;
  status: "completed";
  coworldID: string;
  coworldVersion: string;
  variantID: string;
  episodeID: string;
  replayPath: string;
  replayURLSha256: string;
  episodeCreatedAt: string;
  dispatchedAt: string;
  runningAt: string;
  completedAt: string;
  participants: Array<{
    position: number;
    policyVersionID: string;
  }>;
  gameConfig: Record<string, unknown>;
}

interface SubmittedRequestEvidence {
  schemaVersion: 2;
  coworldClient: "0.1.42";
  submittedAt: string;
  requestBody: CommanderXpRequestBody;
  requestBodySha256: string;
  submittedRequestSha256: string;
}

interface CreateResponseEvidence {
  schemaVersion: 2;
  coworldClient: "0.1.42";
  xpRequestID: string;
  createdAt: string;
  status: string;
  receivedAt: string;
  submittedRequestSha256: string;
  createResponseSha256: string;
}

interface NormalizedRequestReadback {
  schemaVersion: 2;
  notes: string;
  numEpisodes: 1;
  roster: Array<{ slot: number; policy: string }>;
}

interface ReplayEvidence {
  schemaVersion: 2;
  xpRequestID: string;
  episodeRequestID: string;
  jobID: string;
  episodeID: string;
  replayPath: string;
  replayURLSha256: string;
  contentSha256: string;
  byteLength: number;
  sourceSchemaVersion: number;
  replayKind: string;
  runID: string;
  matchID: string;
  config: Record<string, unknown>;
  configSha256: string;
  results: Record<string, unknown> | null;
  resultsSha256: string | null;
}

interface CoworldBundleReceipt {
  schemaVersion: 2;
  authority: "coworld-authenticated-bundle-projection-v2";
  downloadedAt: string;
  xpRequestID: string;
  episodeRequestID: string;
  jobID: string;
  episodeID: string;
  gameID: string;
  seed: number;
  coworldID: string;
  coworldVersion: string;
  variantID: string;
  include: ["results", "replay", "game_logs"];
  manifestSha256: string;
  outerBundleSha256: string;
  members: Array<{ path: string; bytes: number; sha256: string }>;
  projections: {
    episodeResultsSha256: string | null;
    gameEvidenceSha256: string | null;
    replayEvidenceSha256: string;
    commandReceiptsSha256: string;
  };
}

interface CoworldCommandReceipts {
  schemaVersion: 2;
  coworldClient: "0.1.42";
  commands: Array<{ command: string[]; resultSha256: string }>;
}

interface EvalCoworldIdentityReceipt {
  schemaVersion: 2;
  authority: "coworld-0.1.42-coworld-inspect-v1";
  inspectedAt: string;
  inspectResponseSha256: string;
  evalOnly: true;
  publicLeagueBound: false;
  coworldName: string;
  coworldID: string;
  coworldVersion: string;
  manifestSha256: string;
  gameImageID: string;
  gameImageDigest: string;
  gameBuildProvenanceDigest: string;
  gameRunnableEnv: Record<string, string>;
  canonicalProduct: {
    coworldID: string;
    coworldVersion: string;
    leagueBindingBeforeSha256: string;
    leagueBindingAfterSha256: string;
  };
  receiptSha256: string;
}

interface EpisodeResultsEvidence {
  schemaVersion: 2;
  xpRequestID: string;
  episodeRequestID: string;
  jobID: string;
  episodeID: string;
  gameID: string;
  seed: number;
  scores: number[];
  winnerSlot: number;
  subjectWon: boolean;
  turnCount: number;
  tick: number;
  decisionCount: number;
  acceptedDecisionCount: number;
  fallbackCount: number;
  degradedCount: number;
  players: Array<{
    slot: number;
    name: string;
    score: number;
    tilesOwned: number | null;
    isAlive: boolean | null;
  }>;
}

export interface PlayerRuntimeManifest {
  schemaVersion: 2;
  artifactKind: "commander-xp-policy-evidence";
  arm: CommanderXpArm;
  gameID: string;
  runKey: string;
  behaviorSourceSha: string;
  behaviorSourceTreeSha: string;
  adapterSourceSha: string;
  adapterSourceTreeSha: string;
  sourceProvenanceSha256: string;
  imageDigest: string | null;
  policyVersionID: string | null;
  policyIdentityAuthority: "external-policy-inspect-and-xp-participant-metadata";
  requestedModel: string;
  runArgv: string[];
  flags: Record<string, string>;
  providerPreflight: {
    required: true;
    status: "succeeded";
    requestID: string;
    requestedModel: string;
    responseModel: string;
    succeeded: true;
  };
}

interface PlayerTraceProvider {
  recordType: "provider";
  schemaVersion: 2;
  requestID: string;
  stage: "preflight" | "planner" | "selector";
  sequence: number;
  provider: "bedrock-sidecar";
  requestedModel: string;
  responseModel: string | null;
  promptSha256: string;
  promptCharacters: number;
  outputSha256: string | null;
  outputCharacters: number | null;
  succeeded: boolean;
  failureKind: string | null;
}

interface PlayerTraceDecision {
  recordType: "decision";
  schemaVersion: 2;
  requestID: string;
  sequence: number;
  arm: CommanderXpArm;
  offeredLegalActions: Array<{ id: string; kind: string }>;
  offeredLegalActionSetSha256: string;
  selectedLegalActionID: string;
  selectedLegalActionIDs: string[];
  selectedDealActionID: string | null;
  selectedMessageActionID: string | null;
  spawnPreferenceLegalActionIDs: string[];
  runtimeMode: string | null;
  fallbackUsed: boolean;
  llmPlannerDegraded: boolean;
  degradedCause: string | null;
  commander: Record<string, unknown>;
}

type PlayerTrace = PlayerTraceProvider | PlayerTraceDecision;

export function verifyCommanderXpJoinedGameplayEvidence(input: {
  preregistration: CommanderXpPreRegistrationV2;
  plannedRequest: CommanderXpPlannedRequest;
  runtimeManifest: PlayerRuntimeManifest;
  playerTraceJsonl: string;
  gameEvidenceJsonl: string;
  expectedGameID: string;
}): string[] {
  verifyRuntimeManifest(
    input.preregistration,
    input.plannedRequest,
    input.runtimeManifest,
  );
  return verifyJoinedTrace(
    input.preregistration,
    input.plannedRequest,
    input.runtimeManifest,
    parsePlayerTrace(input.playerTraceJsonl),
    parseGameEvidence(input.gameEvidenceJsonl),
    input.expectedGameID,
  ).decisionRequestIDs;
}

export async function verifyCommanderXpCoworldBundleProjection(input: {
  evidenceRoot: string;
  runDirectory: string;
  plannedRequest: CommanderXpPlannedRequest;
}): Promise<void> {
  const root = await canonicalDirectory(input.evidenceRoot);
  const xp = await readJson<CollectedXpEvidence>(
    root,
    `${input.runDirectory}/xp-evidence.json`,
  );
  const replay = await readJson<ReplayEvidence>(
    root,
    `${input.runDirectory}/replay-evidence.json`,
  );
  const receipt = await readJson<CoworldBundleReceipt>(
    root,
    `${input.runDirectory}/coworld-bundle-receipt.json`,
  );
  const isPreflight = input.plannedRequest.phase === "provider-preflight";
  const results = isPreflight
    ? null
    : await readJson<EpisodeResultsEvidence>(
        root,
        `${input.runDirectory}/episode-results.json`,
      );
  const gameEvidenceText = isPreflight
    ? null
    : await readText(root, `${input.runDirectory}/game-evidence.jsonl`);
  await verifyCoworldBundleReceipt(
    root,
    input.runDirectory,
    input.plannedRequest,
    xp,
    receipt,
    replay,
    results,
    gameEvidenceText,
  );
}

class VerificationFailure extends Error {
  constructor(
    readonly code: string,
    readonly relativePath: string | null = null,
  ) {
    super(code);
  }
}

export async function verifyCommanderXpEvidence(
  evidenceRoot: string,
): Promise<CommanderXpVerification> {
  let sealSha256: string | null = null;
  let phase: CommanderXpEvidencePhase | null = null;
  let verifiedRunCount = 0;
  try {
    const root = await canonicalDirectory(evidenceRoot);
    const preregPath = "commander-xp-preregistration-v2.json";
    const prereg = await readJson<CommanderXpPreRegistrationV2>(
      root,
      preregPath,
    );
    verifyPreRegistration(prereg);
    const index = await readJson<EvidenceIndex>(
      root,
      "commander-xp-evidence-index-v2.json",
    );
    const seal = await readJson<EvidenceSeal>(
      root,
      "commander-xp-evidence-seal-v2.json",
    );
    phase = index.phase;
    verifyIndexAndSeal(prereg, index, seal);
    sealSha256 = seal.sealSha256;
    const indexedPaths = await verifyIndexedArtifacts(root, index);
    await verifyEvidenceTreeAllowlist(root, indexedPaths);
    const requiredRequests = prereg.requests.filter(
      (request) => request.phase === index.phase,
    );
    const requiredPaths =
      index.phase === "preregistration"
        ? new Set<string>()
        : index.phase === "provider-preflight"
          ? requiredPreflightArtifactPaths(prereg.providerPreflightRequests)
          : requiredArtifactPaths(requiredRequests);
    requiredPaths.add(preregPath);
    requiredPaths.add("policy-identities-v2.json");
    requiredPaths.add("policy-inspect/A.json");
    requiredPaths.add("policy-inspect/B.json");
    requiredPaths.add("policy-inspect/C.json");
    requiredPaths.add("eval-coworld-identity-v2.json");
    requiredPaths.add("eval-coworld-inspect.json");
    requiredPaths.add("eval-coworld-manifest-v2.json");
    requiredPaths.add("xp-openapi.sha256");
    requiredPaths.add("commander-xp-local-verification-v2.json");
    if (index.phase !== "preregistration") {
      requiredPaths.add("commander-xp-prereg-ledger-v2.json");
    }
    if (index.phase === "canary" || index.phase === "confirmatory") {
      requiredPaths.add("commander-xp-provider-preflight-ledger-v2.json");
    }
    if (index.phase === "confirmatory") {
      requiredPaths.add("commander-xp-canary-ledger-v2.json");
      requiredPaths.add("commander-xp-confirmatory-activation-v2.json");
    }
    if (!sameSet(indexedPaths, requiredPaths)) {
      throw new VerificationFailure("SEALED_ARTIFACT_SET_MISMATCH");
    }
    const policies = await readJson<PolicyIdentityReceipt>(
      root,
      "policy-identities-v2.json",
    );
    const evalCoworld = await readJson<EvalCoworldIdentityReceipt>(
      root,
      "eval-coworld-identity-v2.json",
    );
    const evalCoworldManifestText = await readText(
      root,
      "eval-coworld-manifest-v2.json",
    );
    const openApiReceipt = await readText(root, "xp-openapi.sha256");
    const localVerification = await readJson<Record<string, unknown>>(
      root,
      "commander-xp-local-verification-v2.json",
    );
    exactRecord(
      localVerification,
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
      localVerification.schemaVersion !== 2 ||
      localVerification.verifierSchemaVersion !== 2 ||
      localVerification.phase !== index.phase ||
      localVerification.integrityExpected !== true ||
      localVerification.experimentUsable !== false ||
      localVerification.authenticity !== "external-seal-receipt-required"
    ) {
      throw new VerificationFailure("LOCAL_VERIFICATION_DECLARATION_INVALID");
    }
    if (
      openApiReceipt !==
      `${prereg.identities.xpOpenApiSha256}  https://softmax.com/api/observatory/openapi.json\n`
    ) {
      throw new VerificationFailure("XP_OPENAPI_RECEIPT_MISMATCH");
    }
    const policyInspectTexts = {
      A: await readText(root, "policy-inspect/A.json"),
      B: await readText(root, "policy-inspect/B.json"),
      C: await readText(root, "policy-inspect/C.json"),
    };
    const evalCoworldInspectText = await readText(
      root,
      "eval-coworld-inspect.json",
    );
    verifyPolicyIdentities(prereg, policies, policyInspectTexts);
    verifyEvalCoworldIdentity(
      prereg,
      evalCoworld,
      evalCoworldManifestText,
      evalCoworldInspectText,
    );
    const envelopeRoot = await canonicalDirectory(path.dirname(root));
    if (path.basename(root) !== "evidence") {
      throw new VerificationFailure("EVIDENCE_ROOT_NOT_ENVELOPED");
    }
    const authorityRoot = await canonicalDirectory(
      path.join(envelopeRoot, "authority"),
    );
    const authority = await verifyAuthorityTree(
      authorityRoot,
      index.phase,
      prereg,
      index,
      seal,
    );
    verifyNamespaceRegistry(index.namespaceRegistry);
    if (index.phase === "preregistration") {
      if (!namespaceRegistryIsEmpty(index.namespaceRegistry)) {
        throw new VerificationFailure("PREREGISTRATION_NAMESPACE_NOT_EMPTY");
      }
      return localIntegrityResult(index.phase, 0, seal.sealSha256);
    }
    const preregLedger = await readJson<ExternalPhaseReceipt>(
      root,
      "commander-xp-prereg-ledger-v2.json",
    );
    verifyExternalLedger(prereg, preregLedger, "preregistration");
    await verifyReceiptBinding(
      root,
      prereg,
      authority.preregistrationReceipt,
      preregLedger,
      "preregistration",
      "commander-xp-prereg-ledger-v2.json",
    );
    const providerReceipt =
      index.phase === "provider-preflight"
        ? null
        : await readJson<ExternalPhaseReceipt>(
            root,
            "commander-xp-provider-preflight-ledger-v2.json",
          );
    if (providerReceipt !== null) {
      verifyExternalLedger(prereg, providerReceipt, "provider-preflight");
      await verifyReceiptBinding(
        root,
        prereg,
        authority.providerPreflightReceipt,
        providerReceipt,
        "provider-preflight",
        "commander-xp-provider-preflight-ledger-v2.json",
      );
    }
    const canaryReceipt =
      index.phase === "confirmatory"
        ? await readJson<ExternalPhaseReceipt>(
            root,
            "commander-xp-canary-ledger-v2.json",
          )
        : null;
    if (canaryReceipt !== null) {
      verifyExternalLedger(prereg, canaryReceipt, "canary");
      await verifyReceiptBinding(
        root,
        prereg,
        authority.canaryReceipt,
        canaryReceipt,
        "canary",
        "commander-xp-canary-ledger-v2.json",
      );
    }
    const priorReceipt =
      index.phase === "provider-preflight"
        ? preregLedger
        : index.phase === "canary"
          ? providerReceipt!
          : canaryReceipt!;
    if (
      Date.parse(priorReceipt.completedAt) <
      Date.parse(preregLedger.completedAt)
    ) {
      throw new VerificationFailure("PHASE_LEDGER_BEFORE_PREREG_LEDGER");
    }
    const priorIdentities = namespaceSetsFromRegistry(
      index.phase === "provider-preflight"
        ? preregLedger.namespaceRegistry
        : priorReceipt.namespaceRegistry,
    );
    const phaseIdentities = emptyNamespaceSets();
    const gameIDBySeed = new Map<number, string>();
    const seedByGameID = new Map<string, number>();
    if (index.phase === "provider-preflight") {
      const completed: Array<{
        orderIndex: number;
        submittedAt: string;
        createdAt: string;
        completedAt: string;
      }> = [];
      for (const planned of prereg.providerPreflightRequests) {
        registerNamespaceIdentity(
          priorIdentities,
          phaseIdentities,
          "runKey",
          planned.runKey,
          "GLOBAL_RUN_KEY_DUPLICATE",
        );
        const providerPreflight = await verifyProviderPreflightRun(
          root,
          prereg,
          planned,
          seal.sealedAt,
          preregLedger.completedAt,
        );
        registerUniqueXpIdentity(
          priorIdentities,
          phaseIdentities,
          providerPreflight.xp,
        );
        for (const requestID of providerPreflight.providerRequestIDs) {
          registerNamespaceIdentity(
            priorIdentities,
            phaseIdentities,
            "providerRequestID",
            requestID,
            "GLOBAL_PROVIDER_REQUEST_ID_DUPLICATE",
          );
        }
        completed.push({
          orderIndex: planned.orderIndex,
          submittedAt: providerPreflight.submittedAt,
          createdAt: providerPreflight.xp.xpRequestCreatedAt,
          completedAt: providerPreflight.completedAt,
        });
      }
      verifyPreflightRequestOrder(completed);
      assertRegistryMatchesSets(
        index.namespaceRegistry,
        preregLedger.namespaceRegistry,
        priorIdentities,
        phaseIdentities,
      );
      return localIntegrityResult(index.phase, 3, seal.sealSha256);
    }
    let phaseAuthorizedAt = priorReceipt.completedAt;
    if (index.phase === "confirmatory") {
      if (
        index.canarySealSha256 !== priorReceipt.evidenceArtifact.localSealSha256
      ) {
        throw new VerificationFailure("CONFIRMATORY_CANARY_RECEIPT_MISMATCH");
      }
      const activation = await readJson<ConfirmatoryActivation>(
        root,
        "commander-xp-confirmatory-activation-v2.json",
      );
      verifyConfirmatoryActivation(prereg, priorReceipt, activation);
      phaseAuthorizedAt = activation.createdAt;
    }
    const verifiedOrder: Array<{
      replicaIndex: number;
      orderIndex: number;
      submittedAt: string;
      createdAt: string;
      completedAt: string;
    }> = [];
    for (const request of requiredRequests) {
      registerNamespaceIdentity(
        priorIdentities,
        phaseIdentities,
        "runKey",
        request.runKey,
        "GLOBAL_RUN_KEY_DUPLICATE",
      );
      const verifiedRun = await verifyRun(
        root,
        prereg,
        request,
        phaseAuthorizedAt,
        seal.sealedAt,
      );
      registerUniqueXpIdentity(
        priorIdentities,
        phaseIdentities,
        verifiedRun.xp,
      );
      const priorGameID = gameIDBySeed.get(verifiedRun.seed);
      const priorSeed = seedByGameID.get(verifiedRun.gameID);
      if (
        (priorGameID !== undefined && priorGameID !== verifiedRun.gameID) ||
        (priorSeed !== undefined && priorSeed !== verifiedRun.seed)
      ) {
        throw new VerificationFailure("GLOBAL_SEED_GAME_ID_MAPPING_MISMATCH");
      }
      gameIDBySeed.set(verifiedRun.seed, verifiedRun.gameID);
      seedByGameID.set(verifiedRun.gameID, verifiedRun.seed);
      for (const requestID of verifiedRun.decisionRequestIDs) {
        registerNamespaceIdentity(
          priorIdentities,
          phaseIdentities,
          "decisionRequestID",
          requestID,
          "GLOBAL_DECISION_REQUEST_ID_DUPLICATE",
        );
      }
      for (const requestID of verifiedRun.providerRequestIDs) {
        registerNamespaceIdentity(
          priorIdentities,
          phaseIdentities,
          "providerRequestID",
          requestID,
          "GLOBAL_PROVIDER_REQUEST_ID_DUPLICATE",
        );
      }
      verifiedRunCount += 1;
      verifiedOrder.push({
        replicaIndex: request.replicaIndex,
        orderIndex: request.orderIndex,
        submittedAt: verifiedRun.submittedAt,
        createdAt: verifiedRun.xp.xpRequestCreatedAt,
        completedAt: verifiedRun.xp.xpRequestCompletedAt,
      });
    }
    const gameplayPhase = index.phase;
    if (gameplayPhase !== "canary" && gameplayPhase !== "confirmatory") {
      throw new VerificationFailure("GAMEPLAY_PHASE_INVALID");
    }
    verifyMatchedRequestOrder(
      gameplayPhase === "canary" ? "canary" : "confirmatory",
      verifiedOrder,
    );
    assertRegistryMatchesSets(
      index.namespaceRegistry,
      priorReceipt.namespaceRegistry,
      priorIdentities,
      phaseIdentities,
    );
    return localIntegrityResult(index.phase, verifiedRunCount, seal.sealSha256);
  } catch (error) {
    const failure =
      error instanceof VerificationFailure
        ? error
        : new VerificationFailure("VERIFICATION_INPUT_INVALID");
    return {
      schemaVersion: COMMANDER_XP_VERIFIER_SCHEMA_VERSION,
      integrityVerified: false,
      experimentUsable: false,
      phase,
      verifiedRunCount,
      completePairCount: 0,
      diagnostics: [{ code: failure.code, path: failure.relativePath }],
      performanceClaimAuthorized: false,
      authenticity: {
        verified: false,
        status: "external-seal-receipt-required",
        sealSha256,
      },
    };
  }
}

function localIntegrityResult(
  phase: CommanderXpEvidencePhase,
  verifiedRunCount: number,
  sealSha256: string,
): CommanderXpVerification {
  return {
    schemaVersion: COMMANDER_XP_VERIFIER_SCHEMA_VERSION,
    integrityVerified: true,
    experimentUsable: false,
    phase,
    verifiedRunCount,
    completePairCount: phase === "confirmatory" ? 48 : 0,
    diagnostics: [
      { code: "EXTERNAL_IMMUTABLE_SEAL_RECEIPT_REQUIRED", path: null },
      ...(phase === "confirmatory"
        ? [{ code: "PREREGISTERED_ANALYSIS_NOT_IMPLEMENTED", path: null }]
        : []),
    ],
    performanceClaimAuthorized: false,
    authenticity: {
      verified: false,
      status: "external-seal-receipt-required",
      sealSha256,
    },
  };
}

async function verifyReceiptBinding(
  root: string,
  prereg: CommanderXpPreRegistrationV2,
  binding: PhaseReceiptBinding | null,
  receipt: ExternalPhaseReceipt,
  expectedPhase: PhaseReceiptBinding["phase"],
  expectedPath: string,
): Promise<void> {
  if (binding === null) {
    throw new VerificationFailure("PRIOR_PHASE_BINDING_MISSING");
  }
  verifyPhaseReceiptBindingShape(binding, expectedPhase);
  const fileText = await readText(root, expectedPath);
  if (
    binding.path !== expectedPath ||
    normalizeSha256(binding.sha256) !== sha256(fileText) ||
    binding.ledgerSha256 !== receipt.ledgerSha256 ||
    binding.runId !== receipt.runId ||
    binding.attempt !== receipt.attempt ||
    sha256Canonical(binding.evidenceArtifact) !==
      sha256Canonical(receipt.evidenceArtifact) ||
    sha256Canonical(binding.receiptArtifact) !==
      sha256Canonical(receipt.receiptArtifact) ||
    binding.localSealSha256 !== receipt.evidenceArtifact.localSealSha256 ||
    binding.namespaceRegistrySha256 !==
      receipt.namespaceRegistry.registrySha256 ||
    binding.experimentID !== prereg.experimentID ||
    binding.experimentID !== receipt.experimentID ||
    binding.behaviorBaseSha !== prereg.identities.behaviorSourceSha ||
    binding.behaviorBaseTreeSha !== prereg.identities.behaviorSourceTreeSha ||
    binding.headSha !== prereg.identities.adapterSourceSha ||
    binding.treeSha !== prereg.identities.adapterSourceTreeSha ||
    receipt.phase !== expectedPhase
  ) {
    throw new VerificationFailure("PRIOR_PHASE_BINDING_MISMATCH", expectedPath);
  }
}

function verifyPhaseReceiptBindingShape(
  binding: PhaseReceiptBinding,
  expectedPhase: PhaseReceiptBinding["phase"],
): void {
  exactRecord(
    binding,
    [
      "phase",
      "path",
      "sha256",
      "ledgerSha256",
      "runId",
      "attempt",
      "evidenceArtifact",
      "receiptArtifact",
      "localSealSha256",
      "namespaceRegistrySha256",
      "workflowPath",
      "experimentID",
      "behaviorBaseSha",
      "behaviorBaseTreeSha",
      "headSha",
      "treeSha",
    ],
    "PRIOR_PHASE_BINDING_SCHEMA_MISMATCH",
  );
  exactRecord(
    binding.evidenceArtifact,
    [
      "id",
      "digest",
      "aggregateSha256",
      "attestedSubjectDigest",
      "localSealSha256",
    ],
    "PRIOR_PHASE_BINDING_EVIDENCE_SCHEMA_MISMATCH",
  );
  exactRecord(
    binding.receiptArtifact,
    ["id", "digest", "receiptSha256", "attestedSubjectDigest"],
    "PRIOR_PHASE_BINDING_RECEIPT_SCHEMA_MISMATCH",
  );
  if (
    binding.phase !== expectedPhase ||
    !safeRelativePath(binding.path) ||
    !isSha256(normalizeSha256(binding.sha256)) ||
    !isSha256(binding.ledgerSha256) ||
    !/^\d+$/.test(binding.runId) ||
    !isPositiveInteger(binding.attempt) ||
    binding.workflowPath !==
      ".github/workflows/commander-xp-external-seal.yml" ||
    !/^[0-9a-f]{40}$/.test(binding.behaviorBaseSha) ||
    !/^[0-9a-f]{40}$/.test(binding.behaviorBaseTreeSha) ||
    !/^[0-9a-f]{40}$/.test(binding.headSha) ||
    !/^[0-9a-f]{40}$/.test(binding.treeSha) ||
    !isSha256(binding.localSealSha256) ||
    binding.localSealSha256 !== binding.evidenceArtifact.localSealSha256 ||
    !isSha256(binding.namespaceRegistrySha256)
  ) {
    throw new VerificationFailure("PRIOR_PHASE_BINDING_INVALID");
  }
}

function verifyExternalLedger(
  prereg: CommanderXpPreRegistrationV2,
  receipt: ExternalPhaseReceipt,
  expectedPhase:
    | "preregistration"
    | "provider-preflight"
    | "canary"
    | "confirmatory",
): void {
  exactRecord(
    receipt,
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
      "runId",
      "attempt",
      "headSha",
      "treeSha",
      "behaviorBaseSha",
      "behaviorBaseTreeSha",
      "runnerEnvironment",
      "attestationPolicy",
      "collector",
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
    "PRIOR_PHASE_RECEIPT_SCHEMA_MISMATCH",
  );
  exactRecord(
    receipt.evidenceArtifact,
    [
      "id",
      "digest",
      "aggregateSha256",
      "attestedSubjectDigest",
      "localSealSha256",
    ],
    "PRIOR_EVIDENCE_ARTIFACT_SCHEMA_MISMATCH",
  );
  exactRecord(
    receipt.attestationPolicy,
    [
      "repository",
      "signerWorkflow",
      "sourceRef",
      "sourceDigest",
      "signerDigest",
      "denySelfHostedRunners",
    ],
    "PRIOR_ATTESTATION_POLICY_SCHEMA_MISMATCH",
  );
  exactRecord(
    receipt.receiptArtifact,
    ["id", "digest", "receiptSha256", "attestedSubjectDigest"],
    "PRIOR_RECEIPT_ARTIFACT_SCHEMA_MISMATCH",
  );
  exactRecord(
    receipt.collector,
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
    "PRIOR_COLLECTOR_SCHEMA_MISMATCH",
  );
  verifyNamespaceRegistry(receipt.namespaceRegistry);
  verifyExternalLedgerPhaseBindings(receipt, expectedPhase);
  const { ledgerSha256, ...body } = receipt;
  if (
    receipt.schemaVersion !== 2 ||
    receipt.authority !== "github-actions-attested-ledger-v1" ||
    receipt.repository !== "0xNad/ProxyWar" ||
    receipt.workflowPath !==
      ".github/workflows/commander-xp-external-seal.yml" ||
    !/^\d+$/.test(receipt.workflowID) ||
    receipt.workflowName !== "Commander XP external seal" ||
    receipt.actor !== "0xNad" ||
    receipt.event !== "workflow_dispatch" ||
    receipt.ref !== "refs/heads/main" ||
    receipt.experimentID !== prereg.experimentID ||
    receipt.preRegistrationSha256 !== prereg.preRegistrationSha256 ||
    receipt.phase !== expectedPhase ||
    !/^\d+$/.test(receipt.runId) ||
    !isPositiveInteger(receipt.attempt) ||
    receipt.headSha !== prereg.identities.adapterSourceSha ||
    receipt.treeSha !== prereg.identities.adapterSourceTreeSha ||
    receipt.behaviorBaseSha !== prereg.identities.behaviorSourceSha ||
    receipt.behaviorBaseTreeSha !== prereg.identities.behaviorSourceTreeSha ||
    receipt.runnerEnvironment !== "github-hosted" ||
    receipt.attestationPolicy.repository !== "0xNad/ProxyWar" ||
    receipt.attestationPolicy.signerWorkflow !==
      "0xNad/ProxyWar/.github/workflows/commander-xp-external-seal.yml" ||
    receipt.attestationPolicy.sourceRef !== "refs/heads/main" ||
    receipt.attestationPolicy.sourceDigest !== receipt.headSha ||
    receipt.attestationPolicy.signerDigest !== receipt.headSha ||
    receipt.attestationPolicy.denySelfHostedRunners !== true ||
    !isPositiveInteger(receipt.collector.artifactID) ||
    !isNonEmptyString(receipt.collector.artifactName) ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.collector.artifactDigest) ||
    !isPositiveInteger(receipt.collector.workflowRunID) ||
    !isPositiveInteger(receipt.collector.workflowRunAttempt) ||
    !isPositiveInteger(receipt.collector.workflowID) ||
    receipt.collector.workflowPath !==
      ".github/workflows/commander-xp-evidence.yml" ||
    receipt.collector.workflowName !==
      "Commander XP protected experiment evidence" ||
    receipt.collector.actor !== "0xNad" ||
    receipt.collector.headRepository !== "0xNad/ProxyWar" ||
    receipt.collector.event !== "workflow_dispatch" ||
    receipt.collector.ref !== "refs/heads/main" ||
    !Number.isFinite(Date.parse(receipt.completedAt)) ||
    Date.parse(receipt.completedAt) < Date.parse(prereg.createdAt) ||
    !/^\d+$/.test(receipt.evidenceArtifact.id) ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.evidenceArtifact.digest) ||
    !isSha256(receipt.evidenceArtifact.aggregateSha256) ||
    !isSha256(receipt.evidenceArtifact.attestedSubjectDigest) ||
    !isSha256(receipt.evidenceArtifact.localSealSha256) ||
    !/^\d+$/.test(receipt.receiptArtifact.id) ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.receiptArtifact.digest) ||
    !isSha256(receipt.receiptArtifact.receiptSha256) ||
    !isSha256(receipt.receiptArtifact.attestedSubjectDigest) ||
    ledgerSha256 !== sha256Canonical(body)
  ) {
    throw new VerificationFailure("PRIOR_PHASE_RECEIPT_INVALID");
  }
}

function verifyExternalLedgerPhaseBindings(
  receipt: ExternalPhaseReceipt,
  phase: ExternalPhaseReceipt["phase"],
): void {
  const preregistration = receipt.preregistrationReceipt;
  const provider = receipt.providerPreflightReceipt;
  const prior = receipt.priorPhaseReceipt;
  const canary = receipt.canaryReceipt;
  if (phase === "preregistration") {
    if (
      preregistration !== null ||
      provider !== null ||
      prior !== null ||
      canary !== null ||
      receipt.namespaceRegistry.priorRegistrySha256 !== null
    ) {
      throw new VerificationFailure("PRIOR_PHASE_CHAIN_INVALID");
    }
    return;
  }
  if (preregistration === null) {
    throw new VerificationFailure("PRIOR_PHASE_CHAIN_INVALID");
  }
  verifyPhaseReceiptBindingShape(preregistration, "preregistration");
  if (phase === "provider-preflight") {
    if (provider !== null || prior !== null || canary !== null) {
      throw new VerificationFailure("PRIOR_PHASE_CHAIN_INVALID");
    }
    if (
      receipt.namespaceRegistry.priorRegistrySha256 !==
      preregistration.namespaceRegistrySha256
    ) {
      throw new VerificationFailure("PRIOR_PHASE_REGISTRY_CHAIN_INVALID");
    }
    return;
  }
  if (provider === null || prior === null) {
    throw new VerificationFailure("PRIOR_PHASE_CHAIN_INVALID");
  }
  verifyPhaseReceiptBindingShape(provider, "provider-preflight");
  if (phase === "canary") {
    if (
      canary !== null ||
      sha256Canonical(provider) !== sha256Canonical(prior) ||
      receipt.namespaceRegistry.priorRegistrySha256 !==
        provider.namespaceRegistrySha256
    ) {
      throw new VerificationFailure("PRIOR_PHASE_CHAIN_INVALID");
    }
    return;
  }
  if (canary === null) {
    throw new VerificationFailure("PRIOR_PHASE_CHAIN_INVALID");
  }
  verifyPhaseReceiptBindingShape(canary, "canary");
  if (
    sha256Canonical(canary) !== sha256Canonical(prior) ||
    receipt.namespaceRegistry.priorRegistrySha256 !==
      canary.namespaceRegistrySha256
  ) {
    throw new VerificationFailure("PRIOR_PHASE_CHAIN_INVALID");
  }
}

function verifyConfirmatoryActivation(
  prereg: CommanderXpPreRegistrationV2,
  receipt: ExternalPhaseReceipt,
  activation: ConfirmatoryActivation,
): void {
  exactRecord(
    activation,
    [
      "schemaVersion",
      "experimentID",
      "phase",
      "createdAt",
      "preRegistrationSha256",
      "priorCanaryLedgerSha256",
      "priorCanaryRunId",
      "priorCanaryAttempt",
      "priorCanaryEvidenceArtifact",
      "priorCanaryReceiptArtifact",
      "priorCanaryLocalSealSha256",
      "confirmatoryRequestPlanSha256",
      "activationSha256",
    ],
    "CONFIRMATORY_ACTIVATION_SCHEMA_MISMATCH",
  );
  const { activationSha256, ...body } = activation;
  exactRecord(
    activation.priorCanaryEvidenceArtifact,
    [
      "id",
      "digest",
      "aggregateSha256",
      "attestedSubjectDigest",
      "localSealSha256",
    ],
    "CONFIRMATORY_EVIDENCE_ARTIFACT_SCHEMA_MISMATCH",
  );
  exactRecord(
    activation.priorCanaryReceiptArtifact,
    ["id", "digest", "receiptSha256", "attestedSubjectDigest"],
    "CONFIRMATORY_RECEIPT_ARTIFACT_SCHEMA_MISMATCH",
  );
  const confirmatoryRequests = prereg.requests.filter(
    (request) => request.phase === "confirmatory",
  );
  if (
    activation.schemaVersion !== 2 ||
    activation.experimentID !== prereg.experimentID ||
    activation.phase !== "confirmatory" ||
    activation.preRegistrationSha256 !== prereg.preRegistrationSha256 ||
    activation.priorCanaryLedgerSha256 !== receipt.ledgerSha256 ||
    activation.priorCanaryRunId !== receipt.runId ||
    activation.priorCanaryAttempt !== receipt.attempt ||
    sha256Canonical(activation.priorCanaryEvidenceArtifact) !==
      sha256Canonical(receipt.evidenceArtifact) ||
    sha256Canonical(activation.priorCanaryReceiptArtifact) !==
      sha256Canonical(receipt.receiptArtifact) ||
    activation.priorCanaryLocalSealSha256 !==
      receipt.evidenceArtifact.localSealSha256 ||
    activation.confirmatoryRequestPlanSha256 !==
      sha256Canonical(confirmatoryRequests) ||
    !Number.isFinite(Date.parse(activation.createdAt)) ||
    Date.parse(activation.createdAt) < Date.parse(receipt.completedAt) ||
    activationSha256 !== sha256Canonical(body)
  ) {
    throw new VerificationFailure("CONFIRMATORY_ACTIVATION_INVALID");
  }
}

function verifyPreRegistration(prereg: CommanderXpPreRegistrationV2): void {
  const { preRegistrationSha256, ...input } = prereg;
  if (
    prereg.schemaVersion !== 2 ||
    prereg.experimentKind !== "strategic-commander-xp-matched-v2" ||
    !isSha256(preRegistrationSha256) ||
    sha256Canonical(input) !== preRegistrationSha256
  ) {
    throw new VerificationFailure("PREREGISTRATION_INVALID");
  }
  const rebuilt = buildCommanderXpPreRegistration({
    experimentID: prereg.experimentID,
    createdAt: prereg.createdAt,
    behaviorSourceSha: prereg.identities.behaviorSourceSha,
    behaviorSourceTreeSha: prereg.identities.behaviorSourceTreeSha,
    adapterSourceSha: prereg.identities.adapterSourceSha,
    adapterSourceTreeSha: prereg.identities.adapterSourceTreeSha,
    sourceDiffManifestSha256: prereg.identities.sourceDiffManifestSha256,
    sourceProvenanceSha256: prereg.identities.sourceProvenanceSha256,
    policyBuildProvenanceDigest: prereg.identities.policyBuildProvenanceDigest,
    gameBuildProvenanceDigest: prereg.identities.gameBuildProvenanceDigest,
    coworldID: prereg.identities.coworldID,
    coworldVersion: prereg.identities.coworldVersion,
    coworldManifestSha256: prereg.identities.coworldManifestSha256,
    coworldGameImageID: prereg.identities.coworldGameImageID,
    coworldGameImageDigest: prereg.identities.coworldGameImageDigest,
    canonicalLeagueBindingSnapshotSha256:
      prereg.identities.canonicalLeagueBindingSnapshotSha256,
    imageDigest: prereg.identities.imageDigest,
    bedrockModel: prereg.identities.bedrockModel,
    xpOpenApiSha256: prereg.identities.xpOpenApiSha256,
    armPolicyVersionIDs: prereg.identities.armPolicyVersionIDs,
    opponentPolicyVersionIDs: prereg.identities.opponentPolicyVersionIDs,
  } satisfies CommanderXpPlanInput);
  if (rebuilt.preRegistrationSha256 !== prereg.preRegistrationSha256) {
    throw new VerificationFailure("PREREGISTRATION_REBUILD_MISMATCH");
  }
}

function verifyIndexAndSeal(
  prereg: CommanderXpPreRegistrationV2,
  index: EvidenceIndex,
  seal: EvidenceSeal,
): void {
  exactRecord(
    index,
    [
      "schemaVersion",
      "experimentID",
      "phase",
      "preRegistrationSha256",
      "xpOpenApiSha256",
      "canarySealSha256",
      "namespaceRegistry",
      "artifacts",
    ],
    "EVIDENCE_INDEX_SCHEMA_MISMATCH",
  );
  exactRecord(
    seal,
    [
      "schemaVersion",
      "experimentID",
      "phase",
      "status",
      "indexSha256",
      "sealedAt",
      "sealSha256",
    ],
    "EVIDENCE_SEAL_SCHEMA_MISMATCH",
  );
  if (
    index.schemaVersion !== 2 ||
    ![
      "preregistration",
      "provider-preflight",
      "canary",
      "confirmatory",
    ].includes(index.phase) ||
    index.experimentID !== prereg.experimentID ||
    index.preRegistrationSha256 !== prereg.preRegistrationSha256 ||
    index.xpOpenApiSha256 !== prereg.identities.xpOpenApiSha256 ||
    !Array.isArray(index.artifacts)
  ) {
    throw new VerificationFailure("EVIDENCE_INDEX_INVALID");
  }
  if (index.phase === "confirmatory" && !isSha256(index.canarySealSha256)) {
    throw new VerificationFailure("CONFIRMATORY_CANARY_SEAL_MISSING");
  }
  if (index.phase !== "confirmatory" && index.canarySealSha256 !== null) {
    throw new VerificationFailure("UNEXPECTED_CANARY_SEAL_REFERENCE");
  }
  const { sealSha256, ...sealBody } = seal;
  if (
    seal.schemaVersion !== 2 ||
    seal.status !== "complete" ||
    seal.experimentID !== prereg.experimentID ||
    seal.phase !== index.phase ||
    !Number.isFinite(Date.parse(seal.sealedAt)) ||
    seal.indexSha256 !== sha256Canonical(index) ||
    sealSha256 !== sha256Canonical(sealBody)
  ) {
    throw new VerificationFailure("EVIDENCE_SEAL_INVALID");
  }
}

async function verifyIndexedArtifacts(
  root: string,
  index: EvidenceIndex,
): Promise<Set<string>> {
  const paths = new Set<string>();
  for (const artifact of index.artifacts) {
    exactRecord(
      artifact,
      ["path", "sha256"],
      "EVIDENCE_ARTIFACT_ENTRY_SCHEMA_MISMATCH",
    );
    if (
      !isRecord(artifact) ||
      typeof artifact.path !== "string" ||
      !safeRelativePath(artifact.path) ||
      !isSha256(artifact.sha256) ||
      paths.has(artifact.path)
    ) {
      throw new VerificationFailure("EVIDENCE_ARTIFACT_ENTRY_INVALID");
    }
    paths.add(artifact.path);
    const absolute = await containedFile(root, artifact.path);
    const actual = sha256(await fs.readFile(absolute));
    if (actual !== artifact.sha256) {
      throw new VerificationFailure(
        "EVIDENCE_ARTIFACT_HASH_MISMATCH",
        artifact.path,
      );
    }
  }
  return paths;
}

async function verifyEvidenceTreeAllowlist(
  root: string,
  indexedPaths: ReadonlySet<string>,
): Promise<void> {
  const allowed = new Set([
    ...indexedPaths,
    "commander-xp-evidence-index-v2.json",
    "commander-xp-evidence-seal-v2.json",
  ]);
  const files: string[] = [];
  const visit = async (absolute: string, prefix: string): Promise<void> => {
    for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new VerificationFailure("EVIDENCE_TREE_SYMLINK", relative);
      }
      if (entry.isDirectory()) {
        await visit(path.join(absolute, entry.name), relative);
      } else if (entry.isFile()) {
        files.push(relative);
      } else {
        throw new VerificationFailure("EVIDENCE_TREE_SPECIAL_FILE", relative);
      }
    }
  };
  await visit(root, "");
  if (files.some((entry) => !allowed.has(entry))) {
    throw new VerificationFailure(
      "EVIDENCE_TREE_UNINDEXED_FILE",
      files.find((entry) => !allowed.has(entry)) ?? null,
    );
  }
  const missing = [...indexedPaths].find((entry) => !files.includes(entry));
  if (missing !== undefined) {
    throw new VerificationFailure(
      "EVIDENCE_TREE_INDEXED_FILE_MISSING",
      missing,
    );
  }
}

async function verifyAuthorityTree(
  authorityRoot: string,
  phase: CommanderXpEvidencePhase,
  prereg: CommanderXpPreRegistrationV2,
  index: EvidenceIndex,
  seal: EvidenceSeal,
): Promise<{
  preregistrationReceipt: PhaseReceiptBinding | null;
  providerPreflightReceipt: PhaseReceiptBinding | null;
  priorPhaseReceipt: PhaseReceiptBinding | null;
  canaryReceipt: PhaseReceiptBinding | null;
}> {
  const files = await fs.readdir(authorityRoot, { withFileTypes: true });
  if (
    files.length !== 1 ||
    !files[0]!.isFile() ||
    files[0]!.name !== "commander-xp-external-seal-request-v1.json"
  ) {
    throw new VerificationFailure("AUTHORITY_TREE_MISMATCH");
  }
  const request = await readJson<Record<string, unknown>>(
    authorityRoot,
    "commander-xp-external-seal-request-v1.json",
  );
  exactRecord(
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
    "AUTHORITY_REQUEST_SCHEMA_MISMATCH",
  );
  const sourceCI = exactRecord(
    request.sourceCI,
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
    "AUTHORITY_SOURCE_CI_SCHEMA_MISMATCH",
  );
  const sourceArtifact = exactRecord(
    request.sourceArtifact,
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
    "AUTHORITY_SOURCE_ARTIFACT_SCHEMA_MISMATCH",
  );
  const source = exactRecord(
    request.source,
    [
      "behaviorBaseSha",
      "behaviorBaseTreeSha",
      "workflowSourceSha",
      "workflowSourceTreeSha",
      "sourceAllowlist",
    ],
    "AUTHORITY_SOURCE_SCHEMA_MISMATCH",
  );
  const evidence = exactRecord(
    request.evidence,
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
    "AUTHORITY_EVIDENCE_SCHEMA_MISMATCH",
  );
  const evidenceRoot = await canonicalDirectory(
    path.join(authorityRoot, "..", "evidence"),
  );
  const boundFiles = [
    [evidence.preRegistrationPath, evidence.preRegistrationSha256],
    [evidence.localIndexPath, evidence.localIndexSha256],
    [evidence.localSealPath, evidence.localSealFileSha256],
    [evidence.aggregatePath, evidence.aggregateSha256],
  ] as const;
  for (const [relativePath, expectedSha] of boundFiles) {
    if (
      typeof relativePath !== "string" ||
      !safeRelativePath(relativePath) ||
      typeof expectedSha !== "string" ||
      normalizeSha256(expectedSha) !==
        sha256(
          await fs.readFile(await containedFile(evidenceRoot, relativePath)),
        )
    ) {
      throw new VerificationFailure("AUTHORITY_EVIDENCE_BINDING_MISMATCH");
    }
  }
  if (
    request.schemaVersion !== 1 ||
    request.experimentID !== prereg.experimentID ||
    request.phase !== phase ||
    sourceCI.workflowPath !== ".github/workflows/ci.yml" ||
    !isPositiveInteger(sourceCI.workflowID) ||
    !isPositiveInteger(sourceCI.runID) ||
    !isPositiveInteger(sourceCI.runAttempt) ||
    sourceCI.headSha !== prereg.identities.adapterSourceSha ||
    sourceCI.actor !== "0xNad" ||
    sourceCI.triggeringActor !== "0xNad" ||
    sourceCI.headRepository !== "0xNad/ProxyWar" ||
    !["push", "workflow_dispatch"].includes(String(sourceCI.event)) ||
    sourceCI.ref !== "refs/heads/main" ||
    sourceArtifact.workflowPath !==
      ".github/workflows/commander-xp-evidence.yml" ||
    sourceArtifact.workflowName !==
      "Commander XP protected experiment evidence" ||
    sourceArtifact.actor !== "0xNad" ||
    sourceArtifact.triggeringActor !== "0xNad" ||
    sourceArtifact.headRepository !== "0xNad/ProxyWar" ||
    sourceArtifact.event !== "workflow_dispatch" ||
    sourceArtifact.ref !== "refs/heads/main" ||
    sourceArtifact.headSha !== prereg.identities.adapterSourceSha ||
    !isPositiveInteger(sourceArtifact.artifactID) ||
    !isPositiveInteger(sourceArtifact.workflowRunID) ||
    !isPositiveInteger(sourceArtifact.workflowRunAttempt) ||
    !isPositiveInteger(sourceArtifact.workflowID) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(sourceArtifact.artifactDigest)) ||
    source.behaviorBaseSha !== prereg.identities.behaviorSourceSha ||
    source.behaviorBaseTreeSha !== prereg.identities.behaviorSourceTreeSha ||
    source.workflowSourceSha !== prereg.identities.adapterSourceSha ||
    source.workflowSourceTreeSha !== prereg.identities.adapterSourceTreeSha ||
    !Array.isArray(source.sourceAllowlist) ||
    source.sourceAllowlist.length === 0 ||
    evidence.preRegistrationPath !== "commander-xp-preregistration-v2.json" ||
    evidence.localIndexPath !== "commander-xp-evidence-index-v2.json" ||
    evidence.localSealPath !== "commander-xp-evidence-seal-v2.json" ||
    normalizeSha256(String(evidence.localSealSha256)) !== seal.sealSha256 ||
    !authorityReceiptShapeMatchesPhase(request, phase)
  ) {
    throw new VerificationFailure("AUTHORITY_REQUEST_IDENTITY_MISMATCH");
  }
  return {
    preregistrationReceipt:
      request.preregistrationReceipt as PhaseReceiptBinding | null,
    providerPreflightReceipt:
      request.providerPreflightReceipt as PhaseReceiptBinding | null,
    priorPhaseReceipt: request.priorPhaseReceipt as PhaseReceiptBinding | null,
    canaryReceipt: request.canaryReceipt as PhaseReceiptBinding | null,
  };
}

function authorityReceiptShapeMatchesPhase(
  request: Record<string, unknown>,
  phase: CommanderXpEvidencePhase,
): boolean {
  const preregistrationReceipt = request.preregistrationReceipt;
  const providerPreflightReceipt = request.providerPreflightReceipt;
  const priorPhaseReceipt = request.priorPhaseReceipt;
  const canaryReceipt = request.canaryReceipt;
  if (phase === "preregistration") {
    return (
      preregistrationReceipt === null &&
      providerPreflightReceipt === null &&
      priorPhaseReceipt === null &&
      canaryReceipt === null
    );
  }
  if (preregistrationReceipt === null) return false;
  if (phase === "provider-preflight") {
    return (
      providerPreflightReceipt === null &&
      priorPhaseReceipt === null &&
      canaryReceipt === null
    );
  }
  if (providerPreflightReceipt === null || priorPhaseReceipt === null) {
    return false;
  }
  if (phase === "canary") return canaryReceipt === null;
  return (
    canaryReceipt !== null &&
    sha256Canonical(canaryReceipt) === sha256Canonical(priorPhaseReceipt)
  );
}

function normalizeSha256(value: string): string {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}

function verifyPolicyIdentities(
  prereg: CommanderXpPreRegistrationV2,
  receipt: PolicyIdentityReceipt,
  inspectTexts: Record<CommanderXpArm, string>,
): void {
  exactRecord(
    receipt,
    [
      "schemaVersion",
      "authority",
      "inspectedAt",
      "policyImageID",
      "platform",
      "policyBuildProvenanceDigest",
      "imageDigest",
      "bedrockModel",
      "arms",
    ],
    "POLICY_IDENTITY_SCHEMA_MISMATCH",
  );
  exactRecord(receipt.arms, ["A", "B", "C"], "POLICY_ARMS_SCHEMA_MISMATCH");
  if (
    receipt.schemaVersion !== 2 ||
    receipt.authority !== "coworld-0.1.42-policy-inspect-v1" ||
    !Number.isFinite(Date.parse(receipt.inspectedAt)) ||
    !/^img_[A-Za-z0-9_-]{8,}$/.test(receipt.policyImageID) ||
    receipt.platform !== "linux/amd64" ||
    receipt.policyBuildProvenanceDigest !==
      prereg.identities.policyBuildProvenanceDigest ||
    receipt.imageDigest !== prereg.identities.imageDigest ||
    receipt.bedrockModel !== prereg.identities.bedrockModel
  ) {
    throw new VerificationFailure("POLICY_IDENTITY_INVALID");
  }
  for (const arm of ["A", "B", "C"] as const) {
    const identity = receipt.arms?.[arm];
    exactRecord(
      identity,
      [
        "policyVersionID",
        "imageDigest",
        "useBedrock",
        "bedrockModel",
        "runArgv",
        "inspectResponseSha256",
      ],
      `POLICY_IDENTITY_${arm}_SCHEMA_MISMATCH`,
    );
    if (
      identity?.policyVersionID !==
        prereg.identities.armPolicyVersionIDs[arm] ||
      identity.imageDigest !== receipt.imageDigest ||
      identity.useBedrock !== true ||
      identity.bedrockModel !== receipt.bedrockModel ||
      sha256Canonical(identity.runArgv) !==
        sha256Canonical(prereg.identities.runArgv[arm]) ||
      !isSha256(identity.inspectResponseSha256) ||
      identity.inspectResponseSha256 !== sha256(inspectTexts[arm])
    ) {
      throw new VerificationFailure(`POLICY_IDENTITY_${arm}_MISMATCH`);
    }
  }
  const argv = receipt.arms;
  if (
    sha256Canonical(argv.A.runArgv.slice(0, -1)) !==
      sha256Canonical(argv.B.runArgv.slice(0, -1)) ||
    sha256Canonical(argv.B.runArgv.slice(0, -1)) !==
      sha256Canonical(argv.C.runArgv.slice(0, -1))
  ) {
    throw new VerificationFailure("POLICY_ARGV_NON_ARM_DIFFERENCE");
  }
}

function verifyEvalCoworldIdentity(
  prereg: CommanderXpPreRegistrationV2,
  receipt: EvalCoworldIdentityReceipt,
  manifestText: string,
  inspectText: string,
): void {
  verifyEvalCoworldManifest(prereg, manifestText);
  exactRecord(
    receipt,
    [
      "schemaVersion",
      "authority",
      "inspectedAt",
      "inspectResponseSha256",
      "evalOnly",
      "publicLeagueBound",
      "coworldName",
      "coworldID",
      "coworldVersion",
      "manifestSha256",
      "gameImageID",
      "gameImageDigest",
      "gameBuildProvenanceDigest",
      "gameRunnableEnv",
      "canonicalProduct",
      "receiptSha256",
    ],
    "EVAL_COWORLD_RECEIPT_SCHEMA_MISMATCH",
  );
  const canonical = exactRecord(
    receipt.canonicalProduct,
    [
      "coworldID",
      "coworldVersion",
      "leagueBindingBeforeSha256",
      "leagueBindingAfterSha256",
    ],
    "EVAL_COWORLD_CANONICAL_SCHEMA_MISMATCH",
  );
  const { receiptSha256, ...body } = receipt;
  const expectedEnv = {
    PROXYWAR_COMMANDER_XP_GAME_EVIDENCE: "1",
    PROXYWAR_TUNE_STRUCTURED_DEALS: "1",
    PROXYWAR_TUNE_FREETEXT_MESSAGES: "1",
    PROXYWAR_TUNE_SPATIAL_OBSERVATION: "0",
    PROXYWAR_TUNE_SPATIAL_MINIMAP: "0",
  };
  if (
    receipt.schemaVersion !== 2 ||
    receipt.authority !== "coworld-0.1.42-coworld-inspect-v1" ||
    !Number.isFinite(Date.parse(receipt.inspectedAt)) ||
    receipt.inspectResponseSha256 !== sha256(inspectText) ||
    receipt.evalOnly !== true ||
    receipt.publicLeagueBound !== false ||
    receipt.coworldName !== prereg.identities.coworldName ||
    receipt.coworldID !== prereg.identities.coworldID ||
    receipt.coworldVersion !== prereg.identities.coworldVersion ||
    receipt.manifestSha256 !== prereg.identities.coworldManifestSha256 ||
    sha256(manifestText) !== receipt.manifestSha256 ||
    receipt.gameImageID !== prereg.identities.coworldGameImageID ||
    receipt.gameImageDigest !== prereg.identities.coworldGameImageDigest ||
    receipt.gameBuildProvenanceDigest !==
      prereg.identities.gameBuildProvenanceDigest ||
    sha256Canonical(receipt.gameRunnableEnv) !== sha256Canonical(expectedEnv) ||
    canonical.coworldID !== prereg.identities.canonicalCoworldID ||
    canonical.coworldVersion !== prereg.identities.canonicalCoworldVersion ||
    canonical.leagueBindingBeforeSha256 !==
      prereg.identities.canonicalLeagueBindingSnapshotSha256 ||
    canonical.leagueBindingAfterSha256 !==
      prereg.identities.canonicalLeagueBindingSnapshotSha256 ||
    receiptSha256 !== sha256Canonical(body)
  ) {
    throw new VerificationFailure("EVAL_COWORLD_IDENTITY_MISMATCH");
  }
}

function verifyEvalCoworldManifest(
  prereg: CommanderXpPreRegistrationV2,
  manifestText: string,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch {
    throw new VerificationFailure("EVAL_COWORLD_MANIFEST_JSON_INVALID");
  }
  const manifest = exactRecord(
    parsed,
    [
      "$schema",
      "tags",
      "game",
      "variants",
      "certification",
      "episode_timeout_minutes",
      "commissioner",
      "player",
      "reporter",
      "grader",
      "diagnoser",
      "optimizer",
    ],
    "EVAL_COWORLD_MANIFEST_SCHEMA_MISMATCH",
  );
  const game = exactRecord(
    manifest.game,
    [
      "name",
      "version",
      "description",
      "owner",
      "config_schema",
      "results_schema",
      "protocols",
      "runnable",
    ],
    "EVAL_COWORLD_GAME_SCHEMA_MISMATCH",
  );
  const runnable = exactRecord(
    game.runnable,
    ["type", "image", "run", "env"],
    "EVAL_COWORLD_RUNNABLE_SCHEMA_MISMATCH",
  );
  const expectedEnv = {
    PROXYWAR_COMMANDER_XP_GAME_EVIDENCE: "1",
    PROXYWAR_TUNE_STRUCTURED_DEALS: "1",
    PROXYWAR_TUNE_FREETEXT_MESSAGES: "1",
    PROXYWAR_TUNE_SPATIAL_OBSERVATION: "0",
    PROXYWAR_TUNE_SPATIAL_MINIMAP: "0",
  };
  if (!Array.isArray(manifest.variants) || manifest.variants.length !== 1) {
    throw new VerificationFailure("EVAL_COWORLD_VARIANT_SET_MISMATCH");
  }
  const variant = exactRecord(
    manifest.variants[0],
    ["id", "name", "game_config", "description"],
    "EVAL_COWORLD_VARIANT_SCHEMA_MISMATCH",
  );
  const config = exactRecord(
    variant.game_config,
    [
      "players",
      "max_decision_steps",
      "turns_per_decision_step",
      "max_decision_ms",
      "map",
      "map_size",
      "difficulty",
      "replay_tail_turns",
      "player_connect_timeout_seconds",
      "num_agents",
      "episode_timeout_seconds",
      "commander_xp_phase",
      "commander_xp_run_key",
    ],
    "EVAL_COWORLD_VARIANT_CONFIG_SCHEMA_MISMATCH",
  );
  const emptyRoleArrays = [
    manifest.commissioner,
    manifest.player,
    manifest.reporter,
    manifest.grader,
    manifest.diagnoser,
    manifest.optimizer,
  ];
  const configSchema = exactRecordSubset(
    game.config_schema,
    ["$schema", "type", "required", "properties", "additionalProperties"],
    "EVAL_COWORLD_CONFIG_SCHEMA_MISMATCH",
  );
  const configProperties = isRecord(configSchema.properties)
    ? configSchema.properties
    : {};
  const phaseSchema = exactRecord(
    configProperties.commander_xp_phase,
    ["type", "enum"],
    "EVAL_COWORLD_PHASE_SCHEMA_MISMATCH",
  );
  const runKeySchema = exactRecord(
    configProperties.commander_xp_run_key,
    ["type", "pattern"],
    "EVAL_COWORLD_RUN_KEY_SCHEMA_MISMATCH",
  );
  const players = Array.isArray(config.players) ? config.players : [];
  const expectedGameArgv = [
    "node",
    "--max-old-space-size=640",
    "--import",
    "tsx/esm",
    "/app/integration/src/no-docker-coworld-episode.ts",
  ];
  if (
    manifest.tags === undefined ||
    sha256Canonical(manifest.tags) !== sha256Canonical(["evaluation"]) ||
    game.name !== prereg.identities.coworldName ||
    game.version !== prereg.identities.coworldVersion ||
    runnable.type !== "game" ||
    typeof runnable.image !== "string" ||
    !String(runnable.image).endsWith(
      `@${prereg.identities.coworldGameImageDigest}`,
    ) ||
    sha256Canonical(runnable.run) !== sha256Canonical(expectedGameArgv) ||
    sha256Canonical(runnable.env) !== sha256Canonical(expectedEnv) ||
    variant.id !== prereg.identities.variantID ||
    config.max_decision_steps !== 360 ||
    config.turns_per_decision_step !== 100 ||
    config.max_decision_ms !== 15_000 ||
    config.episode_timeout_seconds !== 6_000 ||
    config.commander_xp_phase !== "canary" ||
    config.commander_xp_run_key !==
      "commander-xp-v2/manifest-default/canary/r00/A" ||
    config.map !== "Pangaea" ||
    config.map_size !== "Compact" ||
    config.difficulty !== "Easy" ||
    config.replay_tail_turns !== 500 ||
    config.player_connect_timeout_seconds !== 120 ||
    config.num_agents !== 4 ||
    players.length !== 4 ||
    players.some((player) => {
      const entry = exactRecord(
        player,
        ["name"],
        "EVAL_COWORLD_PLAYER_SCHEMA_MISMATCH",
      );
      return !isNonEmptyString(entry.name);
    }) ||
    manifest.episode_timeout_minutes !== 100 ||
    emptyRoleArrays.some(
      (roles) => !Array.isArray(roles) || roles.length !== 0,
    ) ||
    !Array.isArray(configSchema.required) ||
    !configSchema.required.includes("commander_xp_phase") ||
    !configSchema.required.includes("commander_xp_run_key") ||
    phaseSchema.type !== "string" ||
    sha256Canonical(phaseSchema.enum) !==
      sha256Canonical(["provider-preflight", "canary", "confirmatory"]) ||
    runKeySchema.type !== "string" ||
    runKeySchema.pattern !==
      "^commander-xp-v2/[A-Za-z0-9._-]+/(provider-preflight|canary|confirmatory)/r[0-9]{2}/(A|B|C)$"
  ) {
    throw new VerificationFailure("EVAL_COWORLD_MANIFEST_MISMATCH");
  }
}

async function verifyRun(
  root: string,
  prereg: CommanderXpPreRegistrationV2,
  planned: CommanderXpPlannedRequest,
  providerPreflightCompletedAt: string,
  sealedAt: string,
): Promise<{
  xp: CollectedXpEvidence;
  decisionRequestIDs: string[];
  providerRequestIDs: string[];
  seed: number;
  gameID: string;
  submittedAt: string;
}> {
  const directory = runDirectory(planned);
  const xp = await readJson<CollectedXpEvidence>(
    root,
    `${directory}/xp-evidence.json`,
  );
  const submitted = await readJson<SubmittedRequestEvidence>(
    root,
    `${directory}/submitted-request.json`,
  );
  const createResponse = await readJson<CreateResponseEvidence>(
    root,
    `${directory}/create-response.json`,
  );
  const requestedReadback = await readJson<NormalizedRequestReadback>(
    root,
    `${directory}/normalized-request-readback.json`,
  );
  const replay = await readJson<ReplayEvidence>(
    root,
    `${directory}/replay-evidence.json`,
  );
  const bundleReceipt = await readJson<CoworldBundleReceipt>(
    root,
    `${directory}/coworld-bundle-receipt.json`,
  );
  const results = await readJson<EpisodeResultsEvidence>(
    root,
    `${directory}/episode-results.json`,
  );
  const manifest = await readJson<PlayerRuntimeManifest>(
    root,
    `${directory}/player-artifact/runtime-manifest.json`,
  );
  const hashes = await readJson<{
    schemaVersion: 2;
    runtimeManifestSha256: string;
    traceSha256: string;
    traceRecords: number;
  }>(root, `${directory}/player-artifact/hashes.json`);
  const traceText = await readText(
    root,
    `${directory}/player-artifact/trace.jsonl`,
  );
  const gameEvidenceText = await readText(
    root,
    `${directory}/game-evidence.jsonl`,
  );
  exactRecord(
    hashes,
    ["schemaVersion", "runtimeManifestSha256", "traceSha256", "traceRecords"],
    "PLAYER_HASHES_SCHEMA_MISMATCH",
  );
  verifyXpIdentity(
    prereg,
    planned,
    xp,
    results,
    submitted,
    createResponse,
    requestedReadback,
    replay,
  );
  await verifyCoworldBundleReceipt(
    root,
    directory,
    planned,
    xp,
    bundleReceipt,
    replay,
    results,
    gameEvidenceText,
  );
  if (Date.parse(xp.completedAt) > Date.parse(sealedAt)) {
    throw new VerificationFailure("RUN_COMPLETED_AFTER_SEAL", directory);
  }
  if (
    Date.parse(submitted.submittedAt) <=
      Date.parse(providerPreflightCompletedAt) ||
    Date.parse(xp.xpRequestCreatedAt) <=
      Date.parse(providerPreflightCompletedAt)
  ) {
    throw new VerificationFailure(
      "GAMEPLAY_STARTED_BEFORE_PROVIDER_PREFLIGHT_COMPLETED",
      directory,
    );
  }
  verifyRuntimeManifest(prereg, planned, manifest);
  if (
    hashes.schemaVersion !== 2 ||
    hashes.runtimeManifestSha256 !==
      sha256(
        await readText(
          root,
          `${directory}/player-artifact/runtime-manifest.json`,
        ),
      ) ||
    hashes.traceSha256 !== sha256(traceText)
  ) {
    throw new VerificationFailure(
      "PLAYER_ARTIFACT_INTERNAL_HASH_MISMATCH",
      directory,
    );
  }
  const trace = parsePlayerTrace(traceText);
  if (hashes.traceRecords !== trace.length) {
    throw new VerificationFailure("PLAYER_TRACE_COUNT_MISMATCH", directory);
  }
  const gameEvidence = parseGameEvidence(gameEvidenceText);
  const joinedTrace = verifyJoinedTrace(
    prereg,
    planned,
    manifest,
    trace,
    gameEvidence,
    results.gameID,
  );
  verifyPrivacy(`${traceText}\n${gameEvidenceText}`, manifest);
  return {
    xp,
    decisionRequestIDs: joinedTrace.decisionRequestIDs,
    providerRequestIDs: joinedTrace.providerRequestIDs,
    seed: results.seed,
    gameID: results.gameID,
    submittedAt: submitted.submittedAt,
  };
}

async function verifyProviderPreflightRun(
  root: string,
  prereg: CommanderXpPreRegistrationV2,
  planned: CommanderXpPlannedRequest,
  sealedAt: string,
  preregistrationLedgerCompletedAt: string,
): Promise<{
  completedAt: string;
  xp: CollectedXpEvidence;
  providerRequestIDs: string[];
  submittedAt: string;
}> {
  const directory = runDirectory(planned);
  if (planned.phase !== "provider-preflight") {
    throw new VerificationFailure("PROVIDER_PREFLIGHT_PLAN_INVALID", directory);
  }
  const xp = await readJson<CollectedXpEvidence>(
    root,
    `${directory}/xp-evidence.json`,
  );
  const submitted = await readJson<SubmittedRequestEvidence>(
    root,
    `${directory}/submitted-request.json`,
  );
  const createResponse = await readJson<CreateResponseEvidence>(
    root,
    `${directory}/create-response.json`,
  );
  const requestedReadback = await readJson<NormalizedRequestReadback>(
    root,
    `${directory}/normalized-request-readback.json`,
  );
  const replay = await readJson<ReplayEvidence>(
    root,
    `${directory}/replay-evidence.json`,
  );
  const bundleReceipt = await readJson<CoworldBundleReceipt>(
    root,
    `${directory}/coworld-bundle-receipt.json`,
  );
  const manifestPath = `${directory}/player-artifact/runtime-manifest.json`;
  const tracePath = `${directory}/player-artifact/trace.jsonl`;
  const manifestText = await readText(root, manifestPath);
  const manifest = JSON.parse(manifestText) as PlayerRuntimeManifest;
  const traceText = await readText(root, tracePath);
  const hashes = await readJson<{
    schemaVersion: 2;
    runtimeManifestSha256: string;
    traceSha256: string;
    traceRecords: number;
  }>(root, `${directory}/player-artifact/hashes.json`);
  exactRecord(
    hashes,
    ["schemaVersion", "runtimeManifestSha256", "traceSha256", "traceRecords"],
    "PLAYER_HASHES_SCHEMA_MISMATCH",
  );
  verifyXpEnvelope(
    prereg,
    planned,
    xp,
    submitted,
    createResponse,
    requestedReadback,
    replay,
    null,
  );
  await verifyCoworldBundleReceipt(
    root,
    directory,
    planned,
    xp,
    bundleReceipt,
    replay,
    null,
    null,
  );
  if (Date.parse(xp.completedAt) > Date.parse(sealedAt)) {
    throw new VerificationFailure("PREFLIGHT_COMPLETED_AFTER_SEAL", directory);
  }
  if (
    Date.parse(submitted.submittedAt) <=
      Date.parse(preregistrationLedgerCompletedAt) ||
    Date.parse(xp.xpRequestCreatedAt) <=
      Date.parse(preregistrationLedgerCompletedAt)
  ) {
    throw new VerificationFailure(
      "PREFLIGHT_STARTED_BEFORE_PREREGISTRATION_LEDGER",
      directory,
    );
  }
  verifyRuntimeManifest(prereg, planned, manifest);
  if (
    hashes.schemaVersion !== 2 ||
    hashes.runtimeManifestSha256 !== sha256(manifestText) ||
    hashes.traceSha256 !== sha256(traceText)
  ) {
    throw new VerificationFailure(
      "PLAYER_ARTIFACT_INTERNAL_HASH_MISMATCH",
      directory,
    );
  }
  const trace = parsePlayerTrace(traceText);
  if (
    hashes.traceRecords !== trace.length ||
    trace.some(
      (entry) =>
        entry.recordType !== "provider" && entry.recordType !== "decision",
    )
  ) {
    throw new VerificationFailure("PLAYER_TRACE_COUNT_MISMATCH", directory);
  }
  const providers = trace.filter(
    (entry): entry is PlayerTraceProvider => entry.recordType === "provider",
  );
  const expectedPreflightRequestID = commanderXpProviderPreflightRequestID(
    planned.runKey,
  );
  const preflight = providers.filter(
    (entry) => entry.requestID === expectedPreflightRequestID,
  );
  if (preflight.length !== 1) {
    throw new VerificationFailure(
      "PROVIDER_PREFLIGHT_TRACE_MISSING",
      directory,
    );
  }
  for (const provider of providers) {
    verifyProviderRecord(prereg, planned, provider);
  }
  for (const decision of trace.filter(
    (entry): entry is PlayerTraceDecision => entry.recordType === "decision",
  )) {
    if (
      decision.schemaVersion !== 2 ||
      decision.arm !== planned.arm ||
      decision.fallbackUsed ||
      decision.llmPlannerDegraded ||
      decision.degradedCause !== null
    ) {
      throw new VerificationFailure(
        "PROVIDER_PREFLIGHT_RUNTIME_EXCLUSION",
        directory,
      );
    }
  }
  verifyPrivacy(traceText, manifest);
  return {
    completedAt: xp.completedAt,
    xp,
    providerRequestIDs: [...new Set(providers.map((entry) => entry.requestID))],
    submittedAt: submitted.submittedAt,
  };
}

function verifyXpIdentity(
  prereg: CommanderXpPreRegistrationV2,
  planned: CommanderXpPlannedRequest,
  xp: CollectedXpEvidence,
  results: EpisodeResultsEvidence,
  submitted: SubmittedRequestEvidence,
  createResponse: CreateResponseEvidence,
  requestedReadback: NormalizedRequestReadback,
  replay: ReplayEvidence,
): void {
  verifyXpEnvelope(
    prereg,
    planned,
    xp,
    submitted,
    createResponse,
    requestedReadback,
    replay,
    results,
  );
  exactRecord(
    results,
    [
      "schemaVersion",
      "xpRequestID",
      "episodeRequestID",
      "jobID",
      "episodeID",
      "gameID",
      "seed",
      "scores",
      "winnerSlot",
      "subjectWon",
      "turnCount",
      "tick",
      "decisionCount",
      "acceptedDecisionCount",
      "fallbackCount",
      "degradedCount",
      "players",
    ],
    "XP_RESULT_SCHEMA_MISMATCH",
  );
  if (
    results.schemaVersion !== 2 ||
    results.xpRequestID !== xp.xpRequestID ||
    results.episodeRequestID !== xp.episodeRequestID ||
    results.jobID !== xp.jobID ||
    results.episodeID !== xp.episodeID ||
    results.gameID !== coworldEpisodeIdentity(planned.seed).gameId ||
    results.seed !== planned.seed ||
    !Number.isInteger(results.winnerSlot) ||
    results.winnerSlot < 0 ||
    results.winnerSlot > 3 ||
    results.subjectWon !== (results.winnerSlot === planned.subjectSeat) ||
    !Number.isInteger(results.turnCount) ||
    results.turnCount < 1 ||
    results.turnCount > 36_400 ||
    !Number.isInteger(results.tick) ||
    results.tick < 1 ||
    results.tick > 36_400 ||
    !Array.isArray(results.scores) ||
    results.scores.length !== 4 ||
    results.scores.some(
      (score, slot) => score !== (slot === results.winnerSlot ? 1 : 0),
    ) ||
    results.decisionCount < 1 ||
    results.acceptedDecisionCount !== results.decisionCount ||
    results.fallbackCount !== 0 ||
    results.degradedCount !== 0 ||
    !Array.isArray(results.players) ||
    results.players.length !== 4
  ) {
    throw new VerificationFailure("XP_RESULT_EXCLUSION", runDirectory(planned));
  }
  const slots = new Set<number>();
  for (const player of results.players) {
    exactRecord(
      player,
      ["slot", "name", "score", "tilesOwned", "isAlive"],
      "XP_RESULT_PLAYER_SCHEMA_MISMATCH",
    );
    if (
      !Number.isInteger(player.slot) ||
      player.slot < 0 ||
      player.slot > 3 ||
      slots.has(player.slot) ||
      !isNonEmptyString(player.name) ||
      player.score !== results.scores[player.slot] ||
      !(
        player.tilesOwned === null || isNonNegativeInteger(player.tilesOwned)
      ) ||
      !(player.isAlive === null || typeof player.isAlive === "boolean")
    ) {
      throw new VerificationFailure(
        "XP_RESULT_PLAYER_MISMATCH",
        runDirectory(planned),
      );
    }
    slots.add(player.slot);
  }
  if (!slots.has(results.winnerSlot)) {
    throw new VerificationFailure(
      "XP_RESULT_WINNER_NOT_IN_ROSTER",
      runDirectory(planned),
    );
  }
}

function verifyXpEnvelope(
  prereg: CommanderXpPreRegistrationV2,
  planned: CommanderXpPlannedRequest,
  xp: CollectedXpEvidence,
  submitted: SubmittedRequestEvidence,
  createResponse: CreateResponseEvidence,
  requestedReadback: NormalizedRequestReadback,
  replay: ReplayEvidence,
  results: EpisodeResultsEvidence | null,
): void {
  exactRecord(
    xp,
    [
      "schemaVersion",
      "xpRequestID",
      "xpRequestCreatedAt",
      "xpRequestStartedAt",
      "xpRequestCompletedAt",
      "episodeCount",
      "pendingCount",
      "submittedCount",
      "runningCount",
      "completedCount",
      "failedCount",
      "episodeRequestID",
      "jobID",
      "status",
      "coworldID",
      "coworldVersion",
      "variantID",
      "episodeID",
      "replayPath",
      "replayURLSha256",
      "episodeCreatedAt",
      "dispatchedAt",
      "runningAt",
      "completedAt",
      "participants",
      "gameConfig",
    ],
    "XP_EPISODE_SCHEMA_MISMATCH",
  );
  verifySubmittedRequest(
    prereg,
    planned,
    submitted,
    createResponse,
    requestedReadback,
  );
  if (
    xp.schemaVersion !== 2 ||
    createResponse.xpRequestID !== xp.xpRequestID ||
    createResponse.createdAt !== xp.xpRequestCreatedAt ||
    !/^xreq_/.test(xp.xpRequestID) ||
    !/^ereq_/.test(xp.episodeRequestID) ||
    !isNonEmptyString(xp.jobID) ||
    xp.status !== "completed" ||
    xp.episodeCount !== 1 ||
    xp.pendingCount !== 0 ||
    xp.submittedCount !== 0 ||
    xp.runningCount !== 0 ||
    xp.completedCount !== 1 ||
    xp.failedCount !== 0 ||
    xp.coworldID !== prereg.identities.coworldID ||
    xp.coworldVersion !== prereg.identities.coworldVersion ||
    xp.variantID !== prereg.identities.variantID ||
    xp.episodeID.trim() === "" ||
    !xp.replayPath.endsWith(`/${xp.jobID}.replay`) ||
    !isSha256(xp.replayURLSha256) ||
    !monotonicTimestamps([
      xp.xpRequestCreatedAt,
      xp.xpRequestStartedAt,
      xp.xpRequestCompletedAt,
    ]) ||
    !monotonicTimestamps([
      xp.episodeCreatedAt,
      xp.dispatchedAt,
      xp.runningAt,
      xp.completedAt,
    ]) ||
    Date.parse(xp.episodeCreatedAt) < Date.parse(xp.xpRequestCreatedAt) ||
    Date.parse(xp.completedAt) > Date.parse(xp.xpRequestCompletedAt)
  ) {
    throw new VerificationFailure(
      "XP_EPISODE_IDENTITY_MISMATCH",
      runDirectory(planned),
    );
  }
  const expectedParticipants = planned.requestBody.roster.map((entry) => ({
    position: entry.slot,
    policyVersionID: entry.player.policy_ref,
  }));
  if (
    sha256Canonical(xp.participants) !== sha256Canonical(expectedParticipants)
  ) {
    throw new VerificationFailure(
      "XP_PARTICIPANT_IDENTITY_MISMATCH",
      runDirectory(planned),
    );
  }
  verifyResolvedGameConfig(planned, xp.gameConfig, requestedReadback);
  verifyReplayEvidence(planned, xp, replay, results);
}

function verifySubmittedRequest(
  prereg: CommanderXpPreRegistrationV2,
  planned: CommanderXpPlannedRequest,
  submitted: SubmittedRequestEvidence,
  createResponse: CreateResponseEvidence,
  requestedReadback: NormalizedRequestReadback,
): void {
  exactRecord(
    submitted,
    [
      "schemaVersion",
      "coworldClient",
      "submittedAt",
      "requestBody",
      "requestBodySha256",
      "submittedRequestSha256",
    ],
    "SUBMITTED_REQUEST_SCHEMA_MISMATCH",
  );
  exactRecord(
    createResponse,
    [
      "schemaVersion",
      "coworldClient",
      "xpRequestID",
      "createdAt",
      "status",
      "receivedAt",
      "submittedRequestSha256",
      "createResponseSha256",
    ],
    "CREATE_RESPONSE_SCHEMA_MISMATCH",
  );
  exactRecord(
    requestedReadback,
    ["schemaVersion", "notes", "numEpisodes", "roster"],
    "REQUEST_READBACK_SCHEMA_MISMATCH",
  );
  const { submittedRequestSha256, ...submittedBody } = submitted;
  const { createResponseSha256, ...createBody } = createResponse;
  if (
    submitted.schemaVersion !== 2 ||
    submitted.coworldClient !== "0.1.42" ||
    submitted.requestBodySha256 !== planned.requestBodySha256 ||
    sha256Canonical(submitted.requestBody) !== planned.requestBodySha256 ||
    sha256Canonical(submittedBody) !== submittedRequestSha256 ||
    !Number.isFinite(Date.parse(submitted.submittedAt)) ||
    createResponse.schemaVersion !== 2 ||
    createResponse.coworldClient !== "0.1.42" ||
    createResponse.submittedRequestSha256 !== submittedRequestSha256 ||
    sha256Canonical(createBody) !== createResponseSha256 ||
    !/^xreq_[A-Za-z0-9-]+$/.test(createResponse.xpRequestID) ||
    !Number.isFinite(Date.parse(createResponse.createdAt)) ||
    !Number.isFinite(Date.parse(createResponse.receivedAt)) ||
    Date.parse(prereg.createdAt) > Date.parse(submitted.submittedAt) ||
    Date.parse(submitted.submittedAt) > Date.parse(createResponse.createdAt) ||
    Date.parse(createResponse.createdAt) >
      Date.parse(createResponse.receivedAt) ||
    requestedReadback.schemaVersion !== 2 ||
    requestedReadback.notes !== planned.requestBody.notes ||
    requestedReadback.numEpisodes !== 1 ||
    !Array.isArray(requestedReadback.roster) ||
    requestedReadback.roster.length !== 4
  ) {
    throw new VerificationFailure(
      "SUBMITTED_REQUEST_IDENTITY_MISMATCH",
      runDirectory(planned),
    );
  }
  for (const [index, entry] of requestedReadback.roster.entries()) {
    exactRecord(entry, ["slot", "policy"], "REQUEST_ROSTER_SCHEMA_MISMATCH");
    if (
      entry.slot !== index ||
      !isNonEmptyString(entry.policy) ||
      entry.policy.length > 200
    ) {
      throw new VerificationFailure(
        "REQUEST_ROSTER_READBACK_MISMATCH",
        runDirectory(planned),
      );
    }
  }
}

function verifyResolvedGameConfig(
  planned: CommanderXpPlannedRequest,
  value: Record<string, unknown>,
  requestedReadback: NormalizedRequestReadback,
): void {
  void requestedReadback;
  const expectedKeys = [
    ...Object.keys(planned.requestBody.game_config_overrides),
    "players",
    "player_connect_timeout_seconds",
  ];
  const actual = exactRecord(
    value,
    expectedKeys,
    "XP_GAME_CONFIG_SCHEMA_MISMATCH",
  );
  const players = actual.players;
  if (
    Object.entries(planned.requestBody.game_config_overrides).some(
      ([key, expected]) =>
        sha256Canonical(actual[key]) !== sha256Canonical(expected),
    ) ||
    actual.player_connect_timeout_seconds !== 120 ||
    !Array.isArray(players) ||
    players.length !== 4 ||
    players.some((entry) => {
      const player = exactRecord(
        entry,
        ["name"],
        "XP_GAME_CONFIG_PLAYER_SCHEMA_MISMATCH",
      );
      return !isNonEmptyString(player.name) || String(player.name).length > 200;
    })
  ) {
    throw new VerificationFailure(
      "XP_GAME_CONFIG_MISMATCH",
      runDirectory(planned),
    );
  }
}

function verifyReplayEvidence(
  planned: CommanderXpPlannedRequest,
  xp: CollectedXpEvidence,
  replay: ReplayEvidence,
  results: EpisodeResultsEvidence | null,
): void {
  exactRecord(
    replay,
    [
      "schemaVersion",
      "xpRequestID",
      "episodeRequestID",
      "jobID",
      "episodeID",
      "replayPath",
      "replayURLSha256",
      "contentSha256",
      "byteLength",
      "sourceSchemaVersion",
      "replayKind",
      "runID",
      "matchID",
      "config",
      "configSha256",
      "results",
      "resultsSha256",
    ],
    "REPLAY_EVIDENCE_SCHEMA_MISMATCH",
  );
  const expectedGameID = coworldEpisodeIdentity(planned.seed).gameId;
  const expectedReplayConfig = {
    ...xp.gameConfig,
    player_count: 4,
  };
  if (
    replay.schemaVersion !== 2 ||
    replay.xpRequestID !== xp.xpRequestID ||
    replay.episodeRequestID !== xp.episodeRequestID ||
    replay.jobID !== xp.jobID ||
    replay.episodeID !== xp.episodeID ||
    replay.replayPath !== xp.replayPath ||
    replay.replayURLSha256 !== xp.replayURLSha256 ||
    !isSha256(replay.contentSha256) ||
    !isPositiveInteger(replay.byteLength) ||
    !isPositiveInteger(replay.sourceSchemaVersion) ||
    !isNonEmptyString(replay.replayKind) ||
    !isNonEmptyString(replay.runID) ||
    replay.matchID !== expectedGameID ||
    replay.configSha256 !== sha256Canonical(replay.config) ||
    sha256Canonical(replay.config) !== sha256Canonical(expectedReplayConfig)
  ) {
    throw new VerificationFailure(
      "REPLAY_IDENTITY_MISMATCH",
      runDirectory(planned),
    );
  }
  if (results === null) {
    if (replay.results !== null || replay.resultsSha256 !== null) {
      throw new VerificationFailure(
        "PREFLIGHT_REPLAY_RESULTS_PRESENT",
        runDirectory(planned),
      );
    }
    return;
  }
  if (
    replay.results === null ||
    replay.resultsSha256 !== sha256Canonical(replay.results) ||
    !isSha256(replay.resultsSha256)
  ) {
    throw new VerificationFailure(
      "REPLAY_RESULTS_MISSING",
      runDirectory(planned),
    );
  }
  const expectedReplayResults = {
    schemaVersion: 2,
    gameID: results.gameID,
    seed: results.seed,
    scores: results.scores,
    winnerSlot: results.winnerSlot,
    turnCount: results.turnCount,
    tick: results.tick,
    decisionCount: results.decisionCount,
    acceptedDecisionCount: results.acceptedDecisionCount,
    fallbackCount: results.fallbackCount,
    degradedCount: results.degradedCount,
    players: results.players,
  };
  if (
    sha256Canonical(replay.results) !== sha256Canonical(expectedReplayResults)
  ) {
    throw new VerificationFailure(
      "REPLAY_RESULTS_MISMATCH",
      runDirectory(planned),
    );
  }
}

async function verifyCoworldBundleReceipt(
  root: string,
  directory: string,
  planned: CommanderXpPlannedRequest,
  xp: CollectedXpEvidence,
  receipt: CoworldBundleReceipt,
  replay: ReplayEvidence,
  results: EpisodeResultsEvidence | null,
  gameEvidenceText: string | null,
): Promise<void> {
  exactRecord(
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
    "COWORLD_BUNDLE_RECEIPT_SCHEMA_MISMATCH",
  );
  exactRecord(
    receipt.projections,
    [
      "episodeResultsSha256",
      "gameEvidenceSha256",
      "replayEvidenceSha256",
      "commandReceiptsSha256",
    ],
    "COWORLD_BUNDLE_PROJECTION_SCHEMA_MISMATCH",
  );
  const expectedMembers = [
    "logs/game.log",
    "manifest.json",
    "replay",
    "results.json",
  ];
  const expectedProjectionHashes = {
    episodeResultsSha256:
      results === null
        ? null
        : sha256(
            await fs.readFile(
              await containedFile(root, `${directory}/episode-results.json`),
            ),
          ),
    gameEvidenceSha256:
      gameEvidenceText === null
        ? null
        : sha256(
            await fs.readFile(
              await containedFile(root, `${directory}/game-evidence.jsonl`),
            ),
          ),
    replayEvidenceSha256: sha256(
      await fs.readFile(
        await containedFile(root, `${directory}/replay-evidence.json`),
      ),
    ),
    commandReceiptsSha256: sha256(
      await fs.readFile(
        await containedFile(root, `${directory}/command-receipts.json`),
      ),
    ),
  };
  const commandReceipts = await readJson<CoworldCommandReceipts>(
    root,
    `${directory}/command-receipts.json`,
  );
  verifyCommandReceipts(planned, xp, receipt, commandReceipts);
  if (
    receipt.schemaVersion !== 2 ||
    receipt.authority !== "coworld-authenticated-bundle-projection-v2" ||
    !Number.isFinite(Date.parse(receipt.downloadedAt)) ||
    receipt.xpRequestID !== xp.xpRequestID ||
    receipt.episodeRequestID !== xp.episodeRequestID ||
    receipt.jobID !== xp.jobID ||
    receipt.episodeID !== xp.episodeID ||
    receipt.gameID !== coworldEpisodeIdentity(planned.seed).gameId ||
    receipt.seed !== planned.seed ||
    receipt.coworldID !== xp.coworldID ||
    receipt.coworldVersion !== xp.coworldVersion ||
    receipt.variantID !== xp.variantID ||
    sha256Canonical(receipt.include) !==
      sha256Canonical(["results", "replay", "game_logs"]) ||
    !isSha256(receipt.manifestSha256) ||
    !isSha256(receipt.outerBundleSha256) ||
    !Array.isArray(receipt.members) ||
    receipt.members.length !== expectedMembers.length ||
    receipt.members.some((member, index) => {
      const exact = exactRecord(
        member,
        ["path", "bytes", "sha256"],
        "COWORLD_BUNDLE_MEMBER_SCHEMA_MISMATCH",
      );
      return (
        exact.path !== expectedMembers[index] ||
        !isPositiveInteger(exact.bytes) ||
        !isSha256(exact.sha256)
      );
    }) ||
    receipt.manifestSha256 !==
      receipt.members.find((member) => member.path === "manifest.json")
        ?.sha256 ||
    replay.contentSha256 !==
      receipt.members.find((member) => member.path === "replay")?.sha256 ||
    receipt.projections.episodeResultsSha256 !==
      expectedProjectionHashes.episodeResultsSha256 ||
    receipt.projections.gameEvidenceSha256 !==
      expectedProjectionHashes.gameEvidenceSha256 ||
    receipt.projections.replayEvidenceSha256 !==
      expectedProjectionHashes.replayEvidenceSha256 ||
    receipt.projections.commandReceiptsSha256 !==
      expectedProjectionHashes.commandReceiptsSha256
  ) {
    throw new VerificationFailure(
      "COWORLD_BUNDLE_RECEIPT_MISMATCH",
      runDirectory(planned),
    );
  }
}

function verifyCommandReceipts(
  planned: CommanderXpPlannedRequest,
  xp: CollectedXpEvidence,
  receipt: CoworldBundleReceipt,
  commandReceipts: CoworldCommandReceipts,
): void {
  exactRecord(
    commandReceipts,
    ["schemaVersion", "coworldClient", "commands"],
    "COWORLD_COMMAND_RECEIPTS_SCHEMA_MISMATCH",
  );
  const expectedCommands = [
    ["xp-request", "get", xp.xpRequestID, "--json"],
    ["commander-xp-episode-bundle", xp.episodeRequestID],
    [
      "episode-logs",
      xp.episodeRequestID,
      "--agent",
      String(planned.subjectSeat),
      "--artifact",
    ],
  ];
  if (
    commandReceipts.schemaVersion !== 2 ||
    commandReceipts.coworldClient !== "0.1.42" ||
    !Array.isArray(commandReceipts.commands) ||
    commandReceipts.commands.length !== expectedCommands.length ||
    commandReceipts.commands.some((entry, index) => {
      exactRecord(
        entry,
        ["command", "resultSha256"],
        "COWORLD_COMMAND_RECEIPT_SCHEMA_MISMATCH",
      );
      return (
        sha256Canonical(entry.command) !==
          sha256Canonical(expectedCommands[index]) ||
        !isSha256(entry.resultSha256)
      );
    }) ||
    commandReceipts.commands[1]?.resultSha256 !== receipt.outerBundleSha256
  ) {
    throw new VerificationFailure(
      "COWORLD_COMMAND_RECEIPTS_MISMATCH",
      runDirectory(planned),
    );
  }
}

function verifyRuntimeManifest(
  prereg: CommanderXpPreRegistrationV2,
  planned: CommanderXpPlannedRequest,
  manifest: PlayerRuntimeManifest,
): void {
  exactRecord(
    manifest,
    [
      "schemaVersion",
      "artifactKind",
      "arm",
      "gameID",
      "runKey",
      "behaviorSourceSha",
      "behaviorSourceTreeSha",
      "adapterSourceSha",
      "adapterSourceTreeSha",
      "sourceProvenanceSha256",
      "imageDigest",
      "policyVersionID",
      "policyIdentityAuthority",
      "requestedModel",
      "runArgv",
      "flags",
      "providerPreflight",
    ],
    "PLAYER_RUNTIME_MANIFEST_SCHEMA_MISMATCH",
  );
  exactRecord(
    manifest.flags,
    [
      "STRUCTURED_DEALS",
      "FREETEXT_MESSAGES",
      "SPATIAL_OBSERVATION",
      "SPATIAL_MINIMAP",
      "KEYSTONE_PROFILE",
      "LLM_TIMEOUT_MS",
    ],
    "PLAYER_RUNTIME_FLAGS_SCHEMA_MISMATCH",
  );
  exactRecord(
    manifest.providerPreflight,
    [
      "required",
      "status",
      "requestID",
      "requestedModel",
      "responseModel",
      "succeeded",
    ],
    "PLAYER_RUNTIME_PREFLIGHT_SCHEMA_MISMATCH",
  );
  if (
    manifest.schemaVersion !== 2 ||
    manifest.artifactKind !== "commander-xp-policy-evidence" ||
    manifest.arm !== planned.arm ||
    manifest.gameID !== coworldEpisodeIdentity(planned.seed).gameId ||
    manifest.runKey !== planned.runKey ||
    manifest.behaviorSourceSha !== prereg.identities.behaviorSourceSha ||
    manifest.behaviorSourceTreeSha !==
      prereg.identities.behaviorSourceTreeSha ||
    manifest.adapterSourceSha !== prereg.identities.adapterSourceSha ||
    manifest.adapterSourceTreeSha !== prereg.identities.adapterSourceTreeSha ||
    manifest.sourceProvenanceSha256 !==
      prereg.identities.sourceProvenanceSha256 ||
    manifest.imageDigest !== null ||
    manifest.policyVersionID !== null ||
    manifest.policyIdentityAuthority !==
      "external-policy-inspect-and-xp-participant-metadata" ||
    manifest.requestedModel !== prereg.identities.bedrockModel ||
    sha256Canonical(manifest.runArgv) !==
      sha256Canonical(prereg.identities.runArgv[planned.arm]) ||
    sha256Canonical(manifest.flags) !== sha256Canonical(prereg.fixedFlags) ||
    manifest.providerPreflight.required !== true ||
    manifest.providerPreflight.status !== "succeeded" ||
    manifest.providerPreflight.requestID !==
      commanderXpProviderPreflightRequestID(planned.runKey) ||
    manifest.providerPreflight.requestedModel !==
      prereg.identities.bedrockModel ||
    !manifest.providerPreflight.succeeded ||
    manifest.providerPreflight.responseModel !== prereg.identities.bedrockModel
  ) {
    throw new VerificationFailure(
      "PLAYER_RUNTIME_IDENTITY_MISMATCH",
      runDirectory(planned),
    );
  }
}

type NamespaceName = keyof NamespaceRegistry["namespaces"];
type NamespaceSets = Record<NamespaceName, Set<string>>;

function emptyNamespaceSets(): NamespaceSets {
  return {
    decisionRequestID: new Set(),
    episodeID: new Set(),
    episodeRequestID: new Set(),
    jobID: new Set(),
    providerRequestID: new Set(),
    replayPath: new Set(),
    replayURLSha256: new Set(),
    runKey: new Set(),
    xpRequestID: new Set(),
  };
}

function verifyNamespaceRegistry(registry: NamespaceRegistry): void {
  exactRecord(
    registry,
    [
      "schemaVersion",
      "mode",
      "priorRegistrySha256",
      "namespaces",
      "registrySha256",
    ],
    "NAMESPACE_REGISTRY_SCHEMA_MISMATCH",
  );
  exactRecord(
    registry.namespaces,
    [
      "decisionRequestID",
      "episodeID",
      "episodeRequestID",
      "jobID",
      "providerRequestID",
      "replayPath",
      "replayURLSha256",
      "runKey",
      "xpRequestID",
    ],
    "NAMESPACE_REGISTRY_NAMESPACES_SCHEMA_MISMATCH",
  );
  const { registrySha256, ...body } = registry;
  if (
    registry.schemaVersion !== 2 ||
    registry.mode !== "cumulative-per-namespace" ||
    !(
      registry.priorRegistrySha256 === null ||
      isSha256(registry.priorRegistrySha256)
    ) ||
    registrySha256 !== sha256ExternalCanonical(body)
  ) {
    throw new VerificationFailure("NAMESPACE_REGISTRY_HASH_MISMATCH");
  }
  for (const [namespace, values] of Object.entries(registry.namespaces)) {
    if (
      !Array.isArray(values) ||
      values.some((value) => !isNonEmptyString(value)) ||
      new Set(values).size !== values.length ||
      [...values].sort().some((value, index) => value !== values[index]) ||
      (namespace === "replayURLSha256" &&
        values.some((value) => !isSha256(value)))
    ) {
      throw new VerificationFailure("NAMESPACE_REGISTRY_VALUE_INVALID");
    }
  }
}

function namespaceSetsFromRegistry(registry: NamespaceRegistry): NamespaceSets {
  verifyNamespaceRegistry(registry);
  return Object.fromEntries(
    Object.entries(registry.namespaces).map(([key, values]) => [
      key,
      new Set(values),
    ]),
  ) as NamespaceSets;
}

function namespaceRegistryFromSets(
  priorRegistry: NamespaceRegistry | null,
  priorSets: NamespaceSets,
  currentSets: NamespaceSets,
): NamespaceRegistry {
  const merged = Object.fromEntries(
    Object.keys(priorSets).map((key) => {
      const namespace = key as NamespaceName;
      return [
        namespace,
        new Set([...priorSets[namespace], ...currentSets[namespace]]),
      ];
    }),
  ) as NamespaceSets;
  const body = {
    schemaVersion: 2 as const,
    mode: "cumulative-per-namespace" as const,
    priorRegistrySha256: priorRegistry?.registrySha256 ?? null,
    namespaces: Object.fromEntries(
      Object.entries(merged).map(([key, values]) => [key, [...values].sort()]),
    ) as NamespaceRegistry["namespaces"],
  };
  return { ...body, registrySha256: sha256ExternalCanonical(body) };
}

function namespaceRegistryIsEmpty(registry: NamespaceRegistry): boolean {
  verifyNamespaceRegistry(registry);
  return Object.values(registry.namespaces).every(
    (values) => values.length === 0,
  );
}

function assertRegistryMatchesSets(
  registry: NamespaceRegistry,
  priorRegistry: NamespaceRegistry,
  priorSets: NamespaceSets,
  currentSets: NamespaceSets,
): void {
  if (
    sha256Canonical(registry) !==
    sha256Canonical(
      namespaceRegistryFromSets(priorRegistry, priorSets, currentSets),
    )
  ) {
    throw new VerificationFailure("NAMESPACE_REGISTRY_PHASE_MISMATCH");
  }
}

function registerNamespaceIdentity(
  prior: NamespaceSets,
  current: NamespaceSets,
  namespace: NamespaceName,
  value: string,
  code: string,
): void {
  if (prior[namespace].has(value) || current[namespace].has(value)) {
    throw new VerificationFailure(code);
  }
  current[namespace].add(value);
}

function registerUniqueXpIdentity(
  prior: NamespaceSets,
  current: NamespaceSets,
  xp: CollectedXpEvidence,
): void {
  for (const [namespace, value, code] of [
    ["xpRequestID", xp.xpRequestID, "GLOBAL_XP_REQUEST_DUPLICATE"],
    [
      "episodeRequestID",
      xp.episodeRequestID,
      "GLOBAL_EPISODE_REQUEST_DUPLICATE",
    ],
    ["episodeID", xp.episodeID, "GLOBAL_EPISODE_DUPLICATE"],
    ["jobID", xp.jobID, "GLOBAL_JOB_DUPLICATE"],
    ["replayPath", xp.replayPath, "GLOBAL_REPLAY_PATH_DUPLICATE"],
    ["replayURLSha256", xp.replayURLSha256, "GLOBAL_REPLAY_URL_DUPLICATE"],
  ] as const) {
    registerNamespaceIdentity(prior, current, namespace, value, code);
  }
}

function verifyMatchedRequestOrder(
  phase: "canary" | "confirmatory",
  runs: readonly {
    replicaIndex: number;
    orderIndex: number;
    submittedAt: string;
    createdAt: string;
    completedAt: string;
  }[],
): void {
  const expectedPerGroup = phase === "canary" ? 3 : 2;
  const groups = new Map<number, typeof runs>();
  for (const run of runs) {
    groups.set(run.replicaIndex, [
      ...(groups.get(run.replicaIndex) ?? []),
      run,
    ]);
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort(
      (left, right) => left.orderIndex - right.orderIndex,
    );
    if (
      ordered.length !== expectedPerGroup ||
      ordered.some((entry, index) => entry.orderIndex !== index)
    ) {
      throw new VerificationFailure("MATCHED_REQUEST_ORDER_INDEX_MISMATCH");
    }
    for (let index = 1; index < ordered.length; index += 1) {
      const prior = ordered[index - 1]!;
      const current = ordered[index]!;
      if (
        Date.parse(prior.submittedAt) >= Date.parse(current.submittedAt) ||
        Date.parse(prior.createdAt) >= Date.parse(current.createdAt) ||
        (phase === "confirmatory" &&
          (Date.parse(prior.completedAt) > Date.parse(current.submittedAt) ||
            Date.parse(prior.completedAt) >= Date.parse(current.completedAt)))
      ) {
        throw new VerificationFailure(
          "MATCHED_REQUEST_TIMESTAMP_ORDER_MISMATCH",
        );
      }
    }
  }
}

function verifyPreflightRequestOrder(
  runs: readonly {
    orderIndex: number;
    submittedAt: string;
    createdAt: string;
    completedAt: string;
  }[],
): void {
  const ordered = [...runs].sort(
    (left, right) => left.orderIndex - right.orderIndex,
  );
  if (
    ordered.length !== 3 ||
    ordered.some((entry, index) => entry.orderIndex !== index)
  ) {
    throw new VerificationFailure("PREFLIGHT_REQUEST_ORDER_INDEX_MISMATCH");
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const prior = ordered[index - 1]!;
    const current = ordered[index]!;
    if (
      Date.parse(prior.submittedAt) >= Date.parse(current.submittedAt) ||
      Date.parse(prior.createdAt) >= Date.parse(current.createdAt)
    ) {
      throw new VerificationFailure(
        "PREFLIGHT_REQUEST_TIMESTAMP_ORDER_MISMATCH",
      );
    }
  }
}

function verifyJoinedTrace(
  prereg: CommanderXpPreRegistrationV2,
  planned: CommanderXpPlannedRequest,
  manifest: PlayerRuntimeManifest,
  trace: PlayerTrace[],
  gameEvidence: CommanderXpGameEvidence[],
  expectedGameID: string,
): { decisionRequestIDs: string[]; providerRequestIDs: string[] } {
  const providers = trace.filter(
    (entry): entry is PlayerTraceProvider => entry.recordType === "provider",
  );
  const decisions = trace.filter(
    (entry): entry is PlayerTraceDecision => entry.recordType === "decision",
  );
  const preflightProviders = providers.filter(
    (entry) => entry.stage === "preflight",
  );
  const gameplayProviders = providers.filter(
    (entry) => entry.stage !== "preflight",
  );
  if (preflightProviders.length !== 1) {
    throw new VerificationFailure(
      "PROVIDER_PREFLIGHT_TRACE_MISSING",
      runDirectory(planned),
    );
  }
  const expectedPreflightRequestID = commanderXpProviderPreflightRequestID(
    planned.runKey,
  );
  if (preflightProviders[0]?.requestID !== expectedPreflightRequestID) {
    throw new VerificationFailure(
      "PROVIDER_PREFLIGHT_IDENTITY_MISMATCH",
      runDirectory(planned),
    );
  }
  if (planned.arm === "B" && gameplayProviders.length !== 0) {
    throw new VerificationFailure(
      "ARM_B_GAMEPLAY_PROVIDER_CALL_PRESENT",
      runDirectory(planned),
    );
  }
  for (const provider of providers) {
    verifyProviderRecord(prereg, planned, provider);
  }
  const providerComposite = new Set<string>();
  for (const provider of providers) {
    const key = `${provider.requestID}:${provider.stage}:${provider.sequence}`;
    if (providerComposite.has(key)) {
      throw new VerificationFailure(
        "PROVIDER_STAGE_SEQUENCE_DUPLICATE",
        runDirectory(planned),
      );
    }
    providerComposite.add(key);
  }
  const decisionByID = uniqueByRequestID(
    decisions,
    "PLAYER_TRACE_REQUEST_DUPLICATE",
  );
  const gameByID = groupByRequestID(gameEvidence);
  if (!sameSet(new Set(decisionByID.keys()), new Set(gameByID.keys()))) {
    throw new VerificationFailure(
      "POLICY_GAME_REQUEST_JOIN_MISMATCH",
      runDirectory(planned),
    );
  }
  let commanderEligible = 0;
  let commanderAligned = 0;
  let armAExternalPlannerDecisions = 0;
  let armCPlan: CommanderPlanContinuity | null = null;
  for (const [requestID, decision] of decisionByID) {
    const games = gameByID
      .get(requestID)!
      .sort((left, right) => left.sequence - right.sequence);
    const selectedIDs = games.map((entry) => entry.chosen.id);
    if (
      sha256Canonical(selectedIDs) !==
        sha256Canonical(decision.selectedLegalActionIDs) ||
      selectedIDs[0] !== decision.selectedLegalActionID
    ) {
      throw new VerificationFailure(
        "BATCH_EXECUTION_JOIN_MISMATCH",
        runDirectory(planned),
      );
    }
    for (const game of games) {
      if (
        decision.schemaVersion !== 2 ||
        decision.arm !== planned.arm ||
        decision.fallbackUsed ||
        decision.llmPlannerDegraded ||
        decision.degradedCause !== null ||
        game.schemaVersion !== 2 ||
        game.runKey !== planned.runKey ||
        game.gameID !== expectedGameID ||
        game.coworldSlot !== planned.subjectSeat ||
        game.result.accepted !== true ||
        !["confirmed", "not_applicable"].includes(String(game.audit.status)) ||
        !decision.selectedLegalActionIDs.includes(game.chosen.id) ||
        !game.legalActions.some(
          (action) =>
            action.id === game.chosen.id && action.kind === game.chosen.kind,
        ) ||
        sha256Canonical(game.legalActions) !==
          sha256Canonical(decision.offeredLegalActions) ||
        game.offeredLegalActionSetSha256 !==
          decision.offeredLegalActionSetSha256 ||
        !decision.offeredLegalActions.some(
          (action) => action.id === decision.selectedLegalActionID,
        ) ||
        sha256Canonical(game.generatedIntent) !==
          sha256Canonical(game.result.submittedIntent)
      ) {
        throw new VerificationFailure(
          "DECISION_EXECUTION_EXCLUSION",
          runDirectory(planned),
        );
      }
    }
    const spawn = games.find((entry) => entry.spawn !== null)?.spawn ?? null;
    const spawnRequired =
      decision.spawnPreferenceLegalActionIDs.length > 0 ||
      games.some((entry) => entry.chosen.kind === "spawn");
    if (
      (spawnRequired && spawn === null) ||
      (!spawnRequired && spawn !== null) ||
      (spawn !== null &&
        (!spawn.ballotValid ||
          spawn.stageFallbackUsed ||
          spawn.stageDegraded ||
          spawn.assignedActionID !== decision.selectedLegalActionID ||
          sha256Canonical(spawn.submittedBallotActionIDs) !==
            sha256Canonical(decision.spawnPreferenceLegalActionIDs)))
    ) {
      throw new VerificationFailure(
        "SPAWN_EXECUTION_EXCLUSION",
        runDirectory(planned),
      );
    }
    const dealGame = games.find((entry) => entry.deal !== null);
    if (
      (decision.selectedDealActionID === null && dealGame !== undefined) ||
      (decision.selectedDealActionID !== null &&
        (dealGame?.deal?.requestedActionID !== decision.selectedDealActionID ||
          !dealGame.deal.validation.accepted ||
          dealGame.deal.validation.actionID !== decision.selectedDealActionID ||
          !dealGame.deal.application.attempted ||
          dealGame.deal.application.accepted !== true))
    ) {
      throw new VerificationFailure(
        "DEAL_SLOT_JOIN_MISMATCH",
        runDirectory(planned),
      );
    }
    const commsGame = games.find((entry) => entry.comms.actionID !== null);
    if (
      (decision.selectedMessageActionID === null && commsGame !== undefined) ||
      (decision.selectedMessageActionID !== null &&
        (commsGame?.comms.actionID !== decision.selectedMessageActionID ||
          commsGame.comms.accepted !== true ||
          commsGame.comms.rejected === true))
    ) {
      throw new VerificationFailure(
        "COMMS_SLOT_JOIN_MISMATCH",
        runDirectory(planned),
      );
    }
    armCPlan = verifyArmRuntime(
      prereg,
      planned,
      decision,
      gameplayProviders,
      armCPlan,
    );
    if (
      planned.arm === "A" &&
      decision.commander.externalPlannerCall === true
    ) {
      armAExternalPlannerDecisions += 1;
    }
    const spawnOnly = decision.offeredLegalActions.every(
      (action) => action.kind === "spawn",
    );
    if ((planned.arm === "B" || planned.arm === "C") && !spawnOnly) {
      commanderEligible += 1;
      const fidelity = decision.commander.commanderFidelity;
      if (fidelity === "aligned_primary" || fidelity === "aligned_support") {
        commanderAligned += 1;
      }
    }
  }
  if (
    (planned.arm === "B" || planned.arm === "C") &&
    (commanderEligible === 0 ||
      commanderAligned / commanderEligible <
        prereg.exclusionPolicy.commanderFidelityMinimum)
  ) {
    throw new VerificationFailure(
      "COMMANDER_FIDELITY_BELOW_95_PERCENT",
      runDirectory(planned),
    );
  }
  if (planned.arm === "C" && gameplayProviders.length === 0) {
    throw new VerificationFailure(
      "ARM_C_SELECTOR_PROVIDER_UNUSED",
      runDirectory(planned),
    );
  }
  if (planned.arm === "A" && armAExternalPlannerDecisions === 0) {
    throw new VerificationFailure(
      "ARM_A_GAMEPLAY_PLANNER_UNUSED",
      runDirectory(planned),
    );
  }
  if (
    manifest.providerPreflight.required &&
    !providers.some(
      (provider) =>
        provider.requestID === expectedPreflightRequestID && provider.succeeded,
    )
  ) {
    throw new VerificationFailure(
      "PROVIDER_PREFLIGHT_TRACE_MISSING",
      runDirectory(planned),
    );
  }
  return {
    decisionRequestIDs: [...decisionByID.keys()],
    providerRequestIDs: [...new Set(providers.map((entry) => entry.requestID))],
  };
}

function groupByRequestID<T extends { requestID: string; sequence: number }>(
  entries: readonly T[],
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  const sequences = new Set<number>();
  for (const entry of entries) {
    if (
      !isNonEmptyString(entry.requestID) ||
      !isNonNegativeInteger(entry.sequence) ||
      sequences.has(entry.sequence)
    ) {
      throw new VerificationFailure("GAME_EVIDENCE_SEQUENCE_DUPLICATE");
    }
    sequences.add(entry.sequence);
    const group = result.get(entry.requestID) ?? [];
    group.push(entry);
    result.set(entry.requestID, group);
  }
  if (result.size === 0) {
    throw new VerificationFailure("GAME_EVIDENCE_MISSING");
  }
  return result;
}

interface CommanderPlanContinuity {
  planID: string;
  fingerprint: string;
  age: number;
}

function verifyArmRuntime(
  prereg: CommanderXpPreRegistrationV2,
  planned: CommanderXpPlannedRequest,
  decision: PlayerTraceDecision,
  providers: readonly PlayerTraceProvider[],
  priorPlan: CommanderPlanContinuity | null,
): CommanderPlanContinuity | null {
  const commander = decision.commander;
  if (typeof commander.externalPlannerCall !== "boolean") {
    throw new VerificationFailure(
      `ARM_${planned.arm}_PLANNER_CALL_FLAG_MISSING`,
      runDirectory(planned),
    );
  }
  const externalPlannerCall = commander.externalPlannerCall === true;
  const joined = providers.filter(
    (provider) => provider.requestID === decision.requestID,
  );
  if (planned.arm === "A") {
    if (
      decision.runtimeMode !== "llm-policy-planner" ||
      commander.plannerSource !== "real-llm" ||
      commander.executorSource !== "frontier-policy-executor" ||
      commander.actionSelectionSource !== "local-policy-executor" ||
      joined.some((provider) => provider.stage !== "planner") ||
      (externalPlannerCall ? joined.length < 1 : joined.length !== 0)
    ) {
      throw new VerificationFailure(
        "ARM_A_RUNTIME_MISMATCH",
        runDirectory(planned),
      );
    }
    return null;
  }
  const expectedSelector = planned.arm === "B" ? "deterministic" : "llm";
  if (
    decision.runtimeMode !== "commander-v0-selector" ||
    commander.plannerSource !== "strategic-commander-v0" ||
    commander.executorSource !== "strategic-option-executor-v0" ||
    commander.actionSelectionSource !== "strategic-option-binding" ||
    commander.commanderPrimarySelectorSource !== expectedSelector ||
    ![expectedSelector, "none"].includes(
      String(commander.commanderSelectorSource),
    )
  ) {
    throw new VerificationFailure(
      `ARM_${planned.arm}_RUNTIME_MISMATCH`,
      runDirectory(planned),
    );
  }
  if (planned.arm === "B") {
    if (
      externalPlannerCall ||
      joined.length !== 0 ||
      commander.commanderSelectorProvider !== null ||
      commander.commanderSelectorModel !== null
    ) {
      throw new VerificationFailure(
        "ARM_B_SELECTOR_MISMATCH",
        runDirectory(planned),
      );
    }
    return null;
  }
  const eligibleOptionIDs = commander.commanderEligibleOptionIds;
  if (typeof eligibleOptionIDs !== "string") {
    throw new VerificationFailure(
      "ARM_C_ELIGIBLE_OPTIONS_MISSING",
      runDirectory(planned),
    );
  }
  const selectorSource = commander.commanderSelectorSource;
  const planID = commander.planID;
  const previousPlanID = commander.commanderPreviousPlanID;
  const fingerprint = commander.commanderFingerprint;
  const planInstalled = commander.commanderPlanInstalled;
  const planAge = commander.commanderPlanAgeDecisions;
  if (externalPlannerCall) {
    if (
      eligibleOptionIDs.length === 0 ||
      joined.length !== 1 ||
      joined[0]?.stage !== "selector" ||
      commander.commanderSelectorProvider !== "custom" ||
      commander.commanderSelectorModel !== prereg.identities.bedrockModel ||
      selectorSource !== "llm" ||
      !isNonEmptyString(planID) ||
      !isNonEmptyString(fingerprint) ||
      planInstalled !== true ||
      planAge !== 0 ||
      previousPlanID !== (priorPlan?.planID ?? null)
    ) {
      throw new VerificationFailure(
        "ARM_C_SELECTOR_MISMATCH",
        runDirectory(planned),
      );
    }
    return { planID, fingerprint, age: 0 };
  }
  if (
    joined.length !== 0 ||
    commander.commanderSelectorProvider !== null ||
    commander.commanderSelectorModel !== null
  ) {
    throw new VerificationFailure(
      "ARM_C_SELECTOR_MISMATCH",
      runDirectory(planned),
    );
  }
  if (selectorSource === "none") {
    if (
      planID !== null ||
      fingerprint !== null ||
      planInstalled !== false ||
      planAge !== 0 ||
      !(previousPlanID === null || previousPlanID === priorPlan?.planID)
    ) {
      throw new VerificationFailure(
        "ARM_C_EMPTY_PLAN_MISMATCH",
        runDirectory(planned),
      );
    }
    return null;
  }
  if (
    selectorSource !== "llm" ||
    priorPlan === null ||
    planID !== priorPlan.planID ||
    fingerprint !== priorPlan.fingerprint ||
    previousPlanID !== null ||
    planInstalled !== false ||
    planAge !== priorPlan.age + 1 ||
    commander.commanderReplanReason !== "within_horizon"
  ) {
    throw new VerificationFailure(
      "ARM_C_PLAN_CONTINUITY_MISMATCH",
      runDirectory(planned),
    );
  }
  return { ...priorPlan, age: planAge };
}

function verifyProviderRecord(
  prereg: CommanderXpPreRegistrationV2,
  planned: CommanderXpPlannedRequest,
  provider: PlayerTraceProvider,
): void {
  if (
    provider.schemaVersion !== 2 ||
    provider.requestedModel !== prereg.identities.bedrockModel ||
    provider.responseModel !== prereg.identities.bedrockModel ||
    provider.succeeded !== true ||
    provider.failureKind !== null ||
    (provider.stage === "preflight"
      ? provider.requestID !==
        commanderXpProviderPreflightRequestID(planned.runKey)
      : provider.requestID ===
          commanderXpProviderPreflightRequestID(planned.runKey) ||
        (planned.arm === "A"
          ? provider.stage !== "planner"
          : provider.stage !== "selector")) ||
    !isSha256(provider.promptSha256) ||
    !isSha256(provider.outputSha256)
  ) {
    throw new VerificationFailure(
      "PROVIDER_FIDELITY_EXCLUSION",
      runDirectory(planned),
    );
  }
}

function verifyPrivacy(
  traceText: string,
  manifest: PlayerRuntimeManifest,
): void {
  verifyPrivacyText(`${traceText}\n${JSON.stringify(manifest)}`);
}

function verifyPrivacyText(text: string): void {
  for (const forbidden of [
    "messageText",
    "commsSlotText",
    "externalRawOutput",
    "rawProviderOutput",
    "rawPrompt",
    "presigned",
    "AWS_",
    "COWORLD_PLAYER_ARTIFACT_UPLOAD_URL",
  ]) {
    if (text.includes(forbidden)) {
      throw new VerificationFailure(`PRIVACY_FORBIDDEN_${forbidden}`);
    }
  }
}

function requiredArtifactPaths(
  requests: readonly CommanderXpPlannedRequest[],
): Set<string> {
  const paths = new Set<string>();
  for (const request of requests) {
    const directory = runDirectory(request);
    for (const suffix of [
      "xp-evidence.json",
      "submitted-request.json",
      "create-response.json",
      "normalized-request-readback.json",
      "replay-evidence.json",
      "coworld-bundle-receipt.json",
      "episode-results.json",
      "game-evidence.jsonl",
      "command-receipts.json",
      "player-artifact/runtime-manifest.json",
      "player-artifact/trace.jsonl",
      "player-artifact/hashes.json",
    ]) {
      paths.add(`${directory}/${suffix}`);
    }
  }
  return paths;
}

function requiredPreflightArtifactPaths(
  requests: readonly CommanderXpPlannedRequest[],
): Set<string> {
  return new Set(
    requests.flatMap((request) => {
      const directory = runDirectory(request);
      return [
        "xp-evidence.json",
        "submitted-request.json",
        "create-response.json",
        "normalized-request-readback.json",
        "replay-evidence.json",
        "coworld-bundle-receipt.json",
        "command-receipts.json",
        "player-artifact/runtime-manifest.json",
        "player-artifact/trace.jsonl",
        "player-artifact/hashes.json",
      ].map((suffix) => `${directory}/${suffix}`);
    }),
  );
}

function runDirectory(request: CommanderXpPlannedRequest): string {
  return `runs/${request.phase}/r${String(request.replicaIndex).padStart(2, "0")}/${request.arm}`;
}

function uniqueByRequestID<T extends { requestID: string }>(
  entries: readonly T[],
  code: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const entry of entries) {
    if (
      typeof entry.requestID !== "string" ||
      entry.requestID.trim() === "" ||
      result.has(entry.requestID)
    ) {
      throw new VerificationFailure(code);
    }
    result.set(entry.requestID, entry);
  }
  if (result.size === 0) throw new VerificationFailure(code);
  return result;
}

function parsePlayerTrace(text: string): PlayerTrace[] {
  const records = parseJsonLines<unknown>(text, "PLAYER_TRACE_INVALID");
  for (const entry of records) {
    const record = exactRecord(
      entry,
      (entry as { recordType?: unknown })?.recordType === "provider"
        ? [
            "recordType",
            "schemaVersion",
            "requestID",
            "stage",
            "sequence",
            "provider",
            "requestedModel",
            "responseModel",
            "promptSha256",
            "promptCharacters",
            "outputSha256",
            "outputCharacters",
            "succeeded",
            "failureKind",
          ]
        : [
            "recordType",
            "schemaVersion",
            "requestID",
            "sequence",
            "arm",
            "offeredLegalActions",
            "offeredLegalActionSetSha256",
            "selectedLegalActionID",
            "selectedLegalActionIDs",
            "selectedDealActionID",
            "selectedMessageActionID",
            "spawnPreferenceLegalActionIDs",
            "runtimeMode",
            "fallbackUsed",
            "llmPlannerDegraded",
            "degradedCause",
            "commander",
          ],
      "PLAYER_TRACE_EXACT_SCHEMA_MISMATCH",
    );
    if (record.recordType === "provider") {
      if (
        record.provider !== "bedrock-sidecar" ||
        !["preflight", "planner", "selector"].includes(String(record.stage)) ||
        !isNonEmptyString(record.requestID) ||
        !isNonNegativeInteger(record.sequence) ||
        !isNonEmptyString(record.requestedModel) ||
        !(
          record.responseModel === null ||
          isNonEmptyString(record.responseModel)
        ) ||
        !isSha256(record.promptSha256) ||
        !isNonNegativeInteger(record.promptCharacters) ||
        !(record.outputSha256 === null || isSha256(record.outputSha256)) ||
        !(
          record.outputCharacters === null ||
          isNonNegativeInteger(record.outputCharacters)
        ) ||
        typeof record.succeeded !== "boolean" ||
        ![null, "transport", "timeout", "model-mismatch"].includes(
          record.failureKind as null | string,
        )
      ) {
        throw new VerificationFailure("PLAYER_TRACE_VALUE_INVALID");
      }
      continue;
    }
    if (record.recordType !== "decision") {
      throw new VerificationFailure("PLAYER_TRACE_RECORD_TYPE_INVALID");
    }
    if (
      !isNonEmptyString(record.requestID) ||
      !isNonNegativeInteger(record.sequence) ||
      !["A", "B", "C"].includes(String(record.arm)) ||
      !isLegalActionArray(record.offeredLegalActions) ||
      !isSha256(record.offeredLegalActionSetSha256) ||
      record.offeredLegalActionSetSha256 !==
        sha256Canonical(record.offeredLegalActions) ||
      !isNonEmptyString(record.selectedLegalActionID) ||
      !isUniqueStringArray(record.selectedLegalActionIDs, false) ||
      !(
        record.selectedDealActionID === null ||
        isNonEmptyString(record.selectedDealActionID)
      ) ||
      !(
        record.selectedMessageActionID === null ||
        isNonEmptyString(record.selectedMessageActionID)
      ) ||
      !isUniqueStringArray(record.spawnPreferenceLegalActionIDs, true) ||
      !(
        record.runtimeMode === null || typeof record.runtimeMode === "string"
      ) ||
      typeof record.fallbackUsed !== "boolean" ||
      typeof record.llmPlannerDegraded !== "boolean" ||
      !(
        record.degradedCause === null ||
        typeof record.degradedCause === "string"
      )
    ) {
      throw new VerificationFailure("PLAYER_TRACE_VALUE_INVALID");
    }
    const commander = exactRecordSubset(
      record.commander,
      COMMANDER_XP_COMMANDER_METADATA_ALLOWLIST,
      "PLAYER_COMMANDER_SCHEMA_MISMATCH",
    );
    if (
      Object.values(commander).some(
        (value) =>
          value !== null &&
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean",
      )
    ) {
      throw new VerificationFailure("PLAYER_COMMANDER_VALUE_INVALID");
    }
  }
  const sequences = records.map(
    (entry) => (entry as { sequence: number }).sequence,
  );
  if (
    sequences.some((value, index) => value !== index) ||
    new Set(sequences).size !== sequences.length
  ) {
    throw new VerificationFailure("PLAYER_TRACE_SEQUENCE_MISMATCH");
  }
  return records as PlayerTrace[];
}

function parseGameEvidence(text: string): CommanderXpGameEvidence[] {
  const records = parseJsonLines<unknown>(text, "GAME_EVIDENCE_INVALID");
  for (const entry of records) {
    const record = exactRecord(
      entry,
      [
        "schemaVersion",
        "runKey",
        "requestID",
        "sequence",
        "gameID",
        "coworldSlot",
        "agentID",
        "turnNumber",
        "legalActions",
        "offeredLegalActionSetSha256",
        "chosen",
        "generatedIntent",
        "result",
        "audit",
        "spawn",
        "deal",
        "comms",
      ],
      "GAME_EVIDENCE_EXACT_SCHEMA_MISMATCH",
    );
    const chosen = exactRecord(
      record.chosen,
      ["id", "kind"],
      "GAME_CHOSEN_SCHEMA_MISMATCH",
    );
    const result = exactRecord(
      record.result,
      ["accepted", "submittedIntent"],
      "GAME_RESULT_SCHEMA_MISMATCH",
    );
    const audit = exactRecord(
      record.audit,
      ["status", "reasonSha256"],
      "GAME_AUDIT_SCHEMA_MISMATCH",
    );
    const comms = exactRecord(
      record.comms,
      ["requestedID", "actionID", "recipientID", "accepted", "rejected"],
      "GAME_COMMS_SCHEMA_MISMATCH",
    );
    if (
      record.schemaVersion !== 2 ||
      !isNonEmptyString(record.runKey) ||
      !isNonEmptyString(record.requestID) ||
      !isNonNegativeInteger(record.sequence) ||
      !isNonEmptyString(record.gameID) ||
      !isNonNegativeInteger(record.coworldSlot) ||
      !isNonEmptyString(record.agentID) ||
      !isNonNegativeInteger(record.turnNumber) ||
      !isLegalActionArray(record.legalActions) ||
      !isSha256(record.offeredLegalActionSetSha256) ||
      record.offeredLegalActionSetSha256 !==
        sha256Canonical(record.legalActions) ||
      !isNonEmptyString(chosen.id) ||
      !isLegalActionKind(chosen.kind) ||
      !isIntentEvidence(record.generatedIntent) ||
      typeof result.accepted !== "boolean" ||
      !isIntentEvidence(result.submittedIntent) ||
      ![null, "confirmed", "unknown", "failed", "not_applicable"].includes(
        audit.status as null | string,
      ) ||
      !(audit.reasonSha256 === null || isSha256(audit.reasonSha256)) ||
      !isNullableString(comms.requestedID) ||
      !isNullableString(comms.actionID) ||
      !isNullableString(comms.recipientID) ||
      !(comms.accepted === null || typeof comms.accepted === "boolean") ||
      !(comms.rejected === null || typeof comms.rejected === "boolean")
    ) {
      throw new VerificationFailure("GAME_EVIDENCE_VALUE_INVALID");
    }
    validateSpawnEvidence(record.spawn);
    validateDealEvidence(record.deal);
  }
  return records as CommanderXpGameEvidence[];
}

function validateSpawnEvidence(value: unknown): void {
  if (value === null) return;
  const spawn = exactRecord(
    value,
    [
      "algorithmVersion",
      "offeredActionIDs",
      "ballotSource",
      "submittedBallotActionIDs",
      "submittedBallotCount",
      "submittedBallotTruncated",
      "normalizedBallotActionIDs",
      "ballotValid",
      "ballotInvalidReason",
      "defaultReason",
      "priorityRank",
      "assignedActionID",
      "assignedPreferenceRank",
      "assignedSubmittedPreferenceRank",
      "stageFallbackUsed",
      "stageDegraded",
    ],
    "GAME_SPAWN_SCHEMA_MISMATCH",
  );
  if (
    !isNonEmptyString(spawn.algorithmVersion) ||
    !isStringArray(spawn.offeredActionIDs) ||
    !isNonEmptyString(spawn.ballotSource) ||
    !Array.isArray(spawn.submittedBallotActionIDs) ||
    spawn.submittedBallotActionIDs.some(
      (value) => value !== null && !isNonEmptyString(value),
    ) ||
    !isNonNegativeInteger(spawn.submittedBallotCount) ||
    typeof spawn.submittedBallotTruncated !== "boolean" ||
    !isStringArray(spawn.normalizedBallotActionIDs) ||
    typeof spawn.ballotValid !== "boolean" ||
    !isNullableString(spawn.ballotInvalidReason) ||
    !isNullableString(spawn.defaultReason) ||
    !isPositiveInteger(spawn.priorityRank) ||
    !isNonEmptyString(spawn.assignedActionID) ||
    !isPositiveInteger(spawn.assignedPreferenceRank) ||
    !(
      spawn.assignedSubmittedPreferenceRank === null ||
      isPositiveInteger(spawn.assignedSubmittedPreferenceRank)
    ) ||
    typeof spawn.stageFallbackUsed !== "boolean" ||
    typeof spawn.stageDegraded !== "boolean"
  ) {
    throw new VerificationFailure("GAME_SPAWN_VALUE_INVALID");
  }
}

function validateDealEvidence(value: unknown): void {
  if (value === null) return;
  const deal = exactRecord(
    value,
    ["requestedActionID", "validation", "application"],
    "GAME_DEAL_SCHEMA_MISMATCH",
  );
  const validation = exactRecord(
    deal.validation,
    ["accepted", "actionID", "actionKind"],
    "GAME_DEAL_VALIDATION_SCHEMA_MISMATCH",
  );
  const application = exactRecord(
    deal.application,
    ["attempted", "accepted"],
    "GAME_DEAL_APPLICATION_SCHEMA_MISMATCH",
  );
  if (
    !isNonEmptyString(deal.requestedActionID) ||
    typeof validation.accepted !== "boolean" ||
    !isNullableString(validation.actionID) ||
    !isNullableString(validation.actionKind) ||
    typeof application.attempted !== "boolean" ||
    !(
      application.accepted === null || typeof application.accepted === "boolean"
    )
  ) {
    throw new VerificationFailure("GAME_DEAL_VALUE_INVALID");
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !sameSet(new Set(Object.keys(value)), new Set(keys))
  ) {
    throw new VerificationFailure(code);
  }
  return value;
}

function exactRecordSubset(
  value: unknown,
  allowedKeys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !allowedKeys.includes(key))
  ) {
    throw new VerificationFailure(code);
  }
  return value;
}

function isLegalActionArray(value: unknown): boolean {
  if (
    !(
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((entry) => {
        const action = exactRecord(
          entry,
          ["id", "kind"],
          "LEGAL_ACTION_SCHEMA_MISMATCH",
        );
        return isNonEmptyString(action.id) && isLegalActionKind(action.kind);
      })
    )
  ) {
    return false;
  }
  return (
    new Set(value.map((entry) => (entry as { id: string }).id)).size ===
    value.length
  );
}

function isIntentEvidence(value: unknown): boolean {
  if (value === null) return true;
  const intent = exactRecord(
    value,
    ["type", "sha256"],
    "GAME_INTENT_SCHEMA_MISMATCH",
  );
  return isNonEmptyString(intent.type) && isSha256(intent.sha256);
}

function isLegalActionKind(value: unknown): boolean {
  return typeof value === "string" && legalActionKinds.includes(value as never);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isUniqueStringArray(
  value: unknown,
  allowEmpty: boolean,
): value is string[] {
  return (
    isStringArray(value) &&
    (allowEmpty || value.length > 0) &&
    new Set(value).size === value.length
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
}

function monotonicTimestamps(values: readonly string[]): boolean {
  const parsed = values.map((value) => Date.parse(value));
  return (
    parsed.every(Number.isFinite) &&
    parsed.every((value, index) => index === 0 || parsed[index - 1]! <= value)
  );
}

function parseJsonLines<T>(text: string, code: string): T[] {
  try {
    const lines = text.split(/\r?\n/).filter((line) => line !== "");
    return lines.map((line) => JSON.parse(line) as T);
  } catch {
    throw new VerificationFailure(code);
  }
}

async function canonicalDirectory(requested: string): Promise<string> {
  try {
    const real = await fs.realpath(path.resolve(requested));
    if (!(await fs.stat(real)).isDirectory()) throw new Error("not directory");
    return real;
  } catch {
    throw new VerificationFailure("ROOT_INVALID");
  }
}

async function readJson<T>(root: string, relativePath: string): Promise<T> {
  try {
    return JSON.parse(await readText(root, relativePath)) as T;
  } catch (error) {
    if (error instanceof VerificationFailure) throw error;
    throw new VerificationFailure("JSON_INVALID", relativePath);
  }
}

async function readText(root: string, relativePath: string): Promise<string> {
  return await fs.readFile(await containedFile(root, relativePath), "utf8");
}

async function containedFile(
  root: string,
  relativePath: string,
): Promise<string> {
  if (!safeRelativePath(relativePath)) {
    throw new VerificationFailure("ARTIFACT_PATH_INVALID", relativePath);
  }
  const requested = path.join(root, relativePath);
  let real: string;
  try {
    real = await fs.realpath(requested);
  } catch {
    throw new VerificationFailure("ARTIFACT_MISSING", relativePath);
  }
  if (
    !real.startsWith(`${root}${path.sep}`) ||
    !(await fs.stat(real)).isFile()
  ) {
    throw new VerificationFailure("ARTIFACT_PATH_INVALID", relativePath);
  }
  const lstat = await fs.lstat(requested);
  if (lstat.isSymbolicLink()) {
    throw new VerificationFailure("ARTIFACT_SYMLINK_REJECTED", relativePath);
  }
  return real;
}

function safeRelativePath(value: string): boolean {
  return (
    value !== "" &&
    !path.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    path.normalize(value) === value
  );
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return (
    left.size === right.size && [...left].every((entry) => right.has(entry))
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256ExternalCanonical(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (isRecord(entry)) {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, sort(entry[key])]),
      );
    }
    return entry;
  };
  return sha256(`${JSON.stringify(sort(value))}\n`);
}
