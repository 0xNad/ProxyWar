import { createHash } from "node:crypto";

import {
  COMMANDER_XP_BEHAVIOR_SOURCE_SHA,
  COMMANDER_XP_BEHAVIOR_SOURCE_TREE_SHA,
} from "./CommanderXpBehaviorIdentity";

export {
  COMMANDER_XP_BEHAVIOR_SOURCE_SHA,
  COMMANDER_XP_BEHAVIOR_SOURCE_TREE_SHA,
} from "./CommanderXpBehaviorIdentity";

export const COMMANDER_XP_PROTOCOL_SCHEMA_VERSION = 2;
export const COMMANDER_XP_VARIANT_ID = "tournament-4p-pangaea";
export const COMMANDER_XP_EVAL_COWORLD_NAME = "proxywar-commander-xp-eval";
export const COMMANDER_XP_CANONICAL_COWORLD_ID =
  "cow_f58621db-4a09-47de-bb13-24d61050a837";
export const COMMANDER_XP_CANONICAL_COWORLD_VERSION = "0.1.54";
export const COMMANDER_XP_SEED_MAX_EXCLUSIVE = 11_881_376;
export const COMMANDER_XP_GAMEPLAY_MAX_DECISION_STEPS = 360;
export const COMMANDER_XP_TURNS_PER_DECISION_STEP = 100;
export const COMMANDER_XP_SPAWN_EXIT_TICK = 400;
export const COMMANDER_XP_TERMINAL_TIEBREAK_TICK = 36_300;
export const COMMANDER_XP_SEED_DERIVATION =
  "sha256-u32be-rejection-mod-11881376-collision-v1";
export const COMMANDER_XP_CANARY_SEED_BASE = "strategic-commander-xp-canary-v1";
export const COMMANDER_XP_CONFIRMATORY_SEED_BASE =
  "strategic-commander-xp-confirmatory-v1";
export const COMMANDER_XP_PROVIDER_PREFLIGHT_SEED_BASE =
  "strategic-commander-xp-provider-preflight-v1";
export const COMMANDER_XP_OPENAPI_SHA256 =
  "13204636cff43a3725d0886f2a43c8d9e45a1e859add15f2fcad336129e4409d";
export const COMMANDER_XP_CREATE_REQUEST_SCHEMA_SHA256 =
  "3d1b9e7969455eb92f2ee97164ce153517a1d6909bcbb1031b6141bb5050b25a";
export const COMMANDER_XP_ROSTER_SCHEMAS_SHA256 =
  "edfa02dc9fcd7513ce91d4f5bbc6517f1a56d086da32ca37590ab2c29cf255c1";
export const COMMANDER_XP_COMMANDER_PROMPT_VERSION =
  "strategic-commander-v0-stage2";
export const COMMANDER_XP_COMMANDER_PROMPT_VERSION_SHA256 =
  "00db34a7939d9d27a3370decf1e3f3f5895b0a3e3676c2e043ec426b5e199094";
export const COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT = {
  provider: "bedrock-sidecar",
  routingAuthority: "coworld-xp-llm-routing-override-bedrock-v1",
  endpointAuthority: "coworld-injected-loopback-bedrock-runtime-sidecar-v1",
  modelID: "us.anthropic.claude-sonnet-4-6",
  responseModelID: "claude-sonnet-4-6",
  region: "us-west-2",
  sdkPackage: "@anthropic-ai/bedrock-sdk",
  sdkVersion: "0.29.2",
  timeoutMs: 12_000,
  maxTokens: 1_024,
  backendRevision: "unattested-provider-residual",
} as const;
export const COMMANDER_XP_CANARY_ORDERS = [
  ["A", "B", "C"],
  ["A", "C", "B"],
  ["B", "A", "C"],
  ["C", "A", "B"],
] as const;
export const COMMANDER_XP_CONFIRMATORY_ORDER_CYCLE = [
  ["B", "C"],
  ["C", "B"],
  ["B", "C"],
  ["B", "C"],
  ["C", "B"],
  ["C", "B"],
] as const;
export const COMMANDER_XP_COMMANDER_METADATA_ALLOWLIST = [
  "runtimeMode",
  "plannerSource",
  "executorSource",
  "actionSelectionSource",
  "externalPlannerCall",
  "plannerRan",
  "plannerLatencyMs",
  "plannerFallbackUsed",
  "plannerParseOk",
  "llmPlannerDegraded",
  "degradedCause",
  "commanderSelectorSource",
  "commanderPrimarySelectorSource",
  "planID",
  "planObjective",
  "commanderSelectedOptionID",
  "commanderSelectedOptionFamily",
  "commanderPreviousPlanID",
  "commanderFingerprint",
  "commanderEligibleOptionIds",
  "commanderOptionSurfaceSha256",
  "commanderExposedOptionIds",
  "commanderOmittedOptions",
  "commanderFidelity",
  "commanderBatchFidelities",
  "commanderReplanReason",
  "commanderResponseDisposition",
  "commanderRejectionCode",
  "commanderPlanInstalled",
  "commanderHorizonDecisions",
  "commanderPlanAgeDecisions",
  "commanderEmergencyCondition",
  "commanderBlockedReason",
  "commanderImmediateReplan",
  "commanderDeterministicPreferredOptionId",
  "commanderDeterministicPreferredOptionAbsent",
  "commanderPromptCharacters",
  "commanderSelectionFailureKind",
  "commanderSelectorProvider",
  "commanderSelectorModel",
  "commanderPromptVersion",
  "commanderPromptSha256",
  "batchIndex",
  "batchSize",
  "batchActionIDs",
] as const;

export type CommanderXpArm = "A" | "B" | "C";
export type CommanderXpProtocolPhase =
  | "provider-preflight"
  | "canary"
  | "confirmatory";

export interface CommanderXpPlanInput {
  experimentID: string;
  createdAt: string;
  behaviorSourceSha: string;
  behaviorSourceTreeSha: string;
  adapterSourceSha: string;
  adapterSourceTreeSha: string;
  sourceDiffManifestSha256: string;
  sourceProvenanceSha256: string;
  policyBuildProvenanceDigest: string;
  gameBuildProvenanceDigest: string;
  coworldID: string;
  coworldVersion: string;
  coworldManifestSha256: string;
  coworldHostedManifestSha256: string;
  coworldGameImageID: string;
  coworldGameImageDigest: string;
  canonicalLeagueBindingSnapshotSha256: string;
  imageDigest: string;
  bedrockModel: string;
  xpOpenApiSha256: string;
  armPolicyVersionIDs: Record<CommanderXpArm, string>;
  opponentPolicyVersionIDs: [string, string, string];
}

export interface CommanderXpRosterParticipant {
  player: { policy_ref: string };
  slot: number;
}

export interface CommanderXpRequestBody {
  idempotency_key: string;
  llm_routing_override: "bedrock";
  target: { coworld_id: string; variant_id: typeof COMMANDER_XP_VARIANT_ID };
  roster: CommanderXpRosterParticipant[];
  num_episodes: 1;
  game_config_overrides: {
    commander_xp_phase: CommanderXpProtocolPhase;
    commander_xp_run_key: string;
    max_decision_steps: number;
    turns_per_decision_step: number;
    max_decision_ms: 15000;
    map: "Pangaea";
    map_size: "Compact";
    difficulty: "Easy";
    seed: number;
    episodeIndex: number;
    replay_tail_turns: 500;
    num_agents: 4;
    episode_timeout_seconds: number;
  };
  execution_backend: "k8s";
  notes: string;
}

export interface CommanderXpPlannedRequest {
  phase: CommanderXpProtocolPhase;
  replicaIndex: number;
  arm: CommanderXpArm;
  orderIndex: number;
  subjectSeat: number;
  episodeIndex: number;
  seed: number;
  runKey: string;
  subjectPolicyVersionID: string;
  requestBody: CommanderXpRequestBody;
  requestBodySha256: string;
}

export interface CommanderXpPreRegistrationV2 {
  schemaVersion: 2;
  experimentKind: "strategic-commander-xp-matched-v2";
  experimentID: string;
  createdAt: string;
  status: "plan-only-no-requests-created";
  causalContract: {
    armA: "planner-executor-bedrock-baseline";
    armB: "strategic-commander-deterministic-selector";
    armC: "strategic-commander-bedrock-selector";
    bcDifference: "selector-and-provider-only";
    canary: "4-complete-abc-triplets";
    confirmatory: "48-complete-bc-pairs";
  };
  featureScope: {
    evaluatedFeature: "selector-only-b-vs-c";
    hardEmergencyOverride: "excluded-empty-v0-set";
    hardEmergencyEvidence: "forbidden-zero-observed";
    fullStage5CompletionClaim: "not-authorized";
  };
  identities: {
    behaviorSourceSha: string;
    behaviorSourceTreeSha: string;
    adapterSourceSha: string;
    adapterSourceTreeSha: string;
    sourceDiffManifestSha256: string;
    sourceProvenanceSha256: string;
    policyBuildProvenanceDigest: string;
    gameBuildProvenanceDigest: string;
    policyPlatform: "linux/amd64";
    coworldID: string;
    coworldVersion: string;
    coworldName: typeof COMMANDER_XP_EVAL_COWORLD_NAME;
    coworldManifestSha256: string;
    coworldHostedManifestSha256: string;
    coworldGameImageID: string;
    coworldGameImageDigest: string;
    canonicalCoworldID: typeof COMMANDER_XP_CANONICAL_COWORLD_ID;
    canonicalCoworldVersion: typeof COMMANDER_XP_CANONICAL_COWORLD_VERSION;
    canonicalLeagueBindingSnapshotSha256: string;
    variantID: typeof COMMANDER_XP_VARIANT_ID;
    imageDigest: string;
    bedrockModel: typeof COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT.modelID;
    providerContract: typeof COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT;
    commanderPromptVersion: typeof COMMANDER_XP_COMMANDER_PROMPT_VERSION;
    commanderPromptVersionSha256: typeof COMMANDER_XP_COMMANDER_PROMPT_VERSION_SHA256;
    xpOpenApiSha256: string;
    xpCreateRequestSchemaSha256: typeof COMMANDER_XP_CREATE_REQUEST_SCHEMA_SHA256;
    xpRosterSchemasSha256: typeof COMMANDER_XP_ROSTER_SCHEMAS_SHA256;
    armPolicyVersionIDs: Record<CommanderXpArm, string>;
    opponentPolicyVersionIDs: [string, string, string];
    runArgv: Record<CommanderXpArm, string[]>;
  };
  fixedFlags: {
    STRUCTURED_DEALS: "0";
    FREETEXT_MESSAGES: "0";
    SPATIAL_OBSERVATION: "0";
    SPATIAL_MINIMAP: "0";
    KEYSTONE_PROFILE: "aggressive";
    LLM_TIMEOUT_MS: "12000";
  };
  exclusionPolicy: {
    fallback: "fatal";
    degraded: "fatal";
    autopilot: "fatal";
    providerFailure: "fatal";
    parseFailure: "fatal";
    timeout: "fatal";
    rejection: "fatal";
    subjectLoss: "retained-valid-outcome";
    winnerless: "fatal";
    invalidRosterWinner: "fatal";
    missingReplayOrResult: "fatal";
    missingOrUnjoinedEvidence: "fatal";
    identityOrConfigMismatch: "fatal";
    commanderFidelityMinimum: 0.95;
    missingPairs: "fatal";
  };
  privacyContract: {
    promptBodiesRetained: false;
    providerBodiesRetained: false;
    inboundCommsBodiesRetained: false;
    outboundCommsBodiesRetained: false;
    uploadUrlsRetained: false;
    environmentValuesRetained: false;
    promptAndOutputHashesOnly: true;
  };
  schedule: {
    seedDerivation: typeof COMMANDER_XP_SEED_DERIVATION;
    preflightRequestCount: 3;
    preflightSeeds: [number, number, number];
    canaryOrders: Array<CommanderXpArm[]>;
    confirmatoryOrderCycle: Array<Array<"B" | "C">>;
    canaryRequestCount: 12;
    confirmatoryRequestCount: 96;
    confirmatoryPairCount: 48;
    canarySeeds: number[];
    confirmatorySeeds: number[];
  };
  analysis: {
    analysisID: "strategic-commander-xp-b-vs-c-paired-v3";
    population: "48-complete-preregistered-bc-pairs";
    alternative: "C-superior-to-B";
    alpha: 0.05;
    confidenceLevel: 0.95;
    missingnessPolicy: "no-missing-pairs";
    primaryEndpoint: "subject-win";
    scoreRole: "redundant-descriptive-only";
    multiplicityPolicy: "single-primary-no-adjustment";
    minimumWinRateEffectCMinusB: 0.1;
    winMethod: "exact-two-sided-mcnemar";
    intervalMethod: "seeded-paired-bootstrap-percentile";
    resamplingSeed: "strategic-commander-xp-b-vs-c-analysis-v3";
    bootstrapIterations: 4096;
    decisionRule: "all-48-complete-and-integrity-green-and-win-estimate-gt-minimum-and-p-lte-alpha-and-ci-lower-gt-minimum";
    canaryClaimGate: "never";
    performanceClaimGate: "external-seal-independent-review-required";
  };
  providerPreflightRequests: [
    CommanderXpPlannedRequest,
    CommanderXpPlannedRequest,
    CommanderXpPlannedRequest,
  ];
  requests: CommanderXpPlannedRequest[];
  preRegistrationSha256: string;
}

const POLICY_RUN_ARGV_BASE = [
  "node",
  "--import",
  "tsx",
  "/app/proxywar/coworld-adapter/src/commander-xp-player.ts",
] as const;

export function buildCommanderXpPreRegistration(
  input: CommanderXpPlanInput,
): CommanderXpPreRegistrationV2 {
  assertPlanInput(input);
  const canarySeeds = deriveCommanderXpSeeds(COMMANDER_XP_CANARY_SEED_BASE, 4);
  const confirmatorySeeds = deriveCommanderXpSeeds(
    COMMANDER_XP_CONFIRMATORY_SEED_BASE,
    48,
  );
  const preflightSeeds = deriveCommanderXpSeeds(
    COMMANDER_XP_PROVIDER_PREFLIGHT_SEED_BASE,
    3,
  ) as [number, number, number];
  if (
    new Set([...preflightSeeds, ...canarySeeds, ...confirmatorySeeds]).size !==
    55
  ) {
    throw new Error("Commander XP seed sets overlap");
  }
  const providerPreflightRequests = (["A", "B", "C"] as const).map(
    (arm, orderIndex) =>
      plannedRequest({
        input,
        phase: "provider-preflight",
        replicaIndex: 0,
        arm,
        orderIndex,
        seed: preflightSeeds[orderIndex]!,
      }),
  ) as CommanderXpPreRegistrationV2["providerPreflightRequests"];
  const requests: CommanderXpPlannedRequest[] = [];
  for (let replicaIndex = 0; replicaIndex < 4; replicaIndex += 1) {
    const order = COMMANDER_XP_CANARY_ORDERS[replicaIndex]!;
    for (const [orderIndex, arm] of order.entries()) {
      requests.push(
        plannedRequest({
          input,
          phase: "canary",
          replicaIndex,
          arm,
          orderIndex,
          seed: canarySeeds[replicaIndex]!,
        }),
      );
    }
  }
  for (let replicaIndex = 0; replicaIndex < 48; replicaIndex += 1) {
    const order =
      COMMANDER_XP_CONFIRMATORY_ORDER_CYCLE[
        replicaIndex % COMMANDER_XP_CONFIRMATORY_ORDER_CYCLE.length
      ]!;
    for (const [orderIndex, arm] of order.entries()) {
      requests.push(
        plannedRequest({
          input,
          phase: "confirmatory",
          replicaIndex,
          arm,
          orderIndex,
          seed: confirmatorySeeds[replicaIndex]!,
        }),
      );
    }
  }
  const withoutHash = {
    schemaVersion: COMMANDER_XP_PROTOCOL_SCHEMA_VERSION,
    experimentKind: "strategic-commander-xp-matched-v2",
    experimentID: input.experimentID,
    createdAt: input.createdAt,
    status: "plan-only-no-requests-created",
    causalContract: {
      armA: "planner-executor-bedrock-baseline",
      armB: "strategic-commander-deterministic-selector",
      armC: "strategic-commander-bedrock-selector",
      bcDifference: "selector-and-provider-only",
      canary: "4-complete-abc-triplets",
      confirmatory: "48-complete-bc-pairs",
    },
    featureScope: {
      evaluatedFeature: "selector-only-b-vs-c",
      hardEmergencyOverride: "excluded-empty-v0-set",
      hardEmergencyEvidence: "forbidden-zero-observed",
      fullStage5CompletionClaim: "not-authorized",
    },
    identities: {
      behaviorSourceSha: input.behaviorSourceSha,
      behaviorSourceTreeSha: input.behaviorSourceTreeSha,
      adapterSourceSha: input.adapterSourceSha,
      adapterSourceTreeSha: input.adapterSourceTreeSha,
      sourceDiffManifestSha256: input.sourceDiffManifestSha256,
      sourceProvenanceSha256: input.sourceProvenanceSha256,
      policyBuildProvenanceDigest: input.policyBuildProvenanceDigest,
      gameBuildProvenanceDigest: input.gameBuildProvenanceDigest,
      policyPlatform: "linux/amd64",
      coworldID: input.coworldID,
      coworldVersion: input.coworldVersion,
      coworldName: COMMANDER_XP_EVAL_COWORLD_NAME,
      coworldManifestSha256: input.coworldManifestSha256,
      coworldHostedManifestSha256: input.coworldHostedManifestSha256,
      coworldGameImageID: input.coworldGameImageID,
      coworldGameImageDigest: input.coworldGameImageDigest,
      canonicalCoworldID: COMMANDER_XP_CANONICAL_COWORLD_ID,
      canonicalCoworldVersion: COMMANDER_XP_CANONICAL_COWORLD_VERSION,
      canonicalLeagueBindingSnapshotSha256:
        input.canonicalLeagueBindingSnapshotSha256,
      variantID: COMMANDER_XP_VARIANT_ID,
      imageDigest: input.imageDigest,
      bedrockModel: COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT.modelID,
      providerContract: structuredClone(COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT),
      commanderPromptVersion: COMMANDER_XP_COMMANDER_PROMPT_VERSION,
      commanderPromptVersionSha256:
        COMMANDER_XP_COMMANDER_PROMPT_VERSION_SHA256,
      xpOpenApiSha256: input.xpOpenApiSha256,
      xpCreateRequestSchemaSha256: COMMANDER_XP_CREATE_REQUEST_SCHEMA_SHA256,
      xpRosterSchemasSha256: COMMANDER_XP_ROSTER_SCHEMAS_SHA256,
      armPolicyVersionIDs: { ...input.armPolicyVersionIDs },
      opponentPolicyVersionIDs: [...input.opponentPolicyVersionIDs] as [
        string,
        string,
        string,
      ],
      runArgv: Object.fromEntries(
        (["A", "B", "C"] as const).map((arm) => [
          arm,
          [...POLICY_RUN_ARGV_BASE, `--arm=${arm}`],
        ]),
      ) as Record<CommanderXpArm, string[]>,
    },
    // Freeze Stage-5 selector-only scope. Production social features remain
    // unchanged; this eval excludes them identically from A/B/C.
    fixedFlags: {
      STRUCTURED_DEALS: "0",
      FREETEXT_MESSAGES: "0",
      SPATIAL_OBSERVATION: "0",
      SPATIAL_MINIMAP: "0",
      KEYSTONE_PROFILE: "aggressive",
      LLM_TIMEOUT_MS: "12000",
    },
    exclusionPolicy: {
      fallback: "fatal",
      degraded: "fatal",
      autopilot: "fatal",
      providerFailure: "fatal",
      parseFailure: "fatal",
      timeout: "fatal",
      rejection: "fatal",
      subjectLoss: "retained-valid-outcome",
      winnerless: "fatal",
      invalidRosterWinner: "fatal",
      missingReplayOrResult: "fatal",
      missingOrUnjoinedEvidence: "fatal",
      identityOrConfigMismatch: "fatal",
      commanderFidelityMinimum: 0.95,
      missingPairs: "fatal",
    },
    privacyContract: {
      promptBodiesRetained: false,
      providerBodiesRetained: false,
      inboundCommsBodiesRetained: false,
      outboundCommsBodiesRetained: false,
      uploadUrlsRetained: false,
      environmentValuesRetained: false,
      promptAndOutputHashesOnly: true,
    },
    schedule: {
      seedDerivation: COMMANDER_XP_SEED_DERIVATION,
      preflightRequestCount: 3,
      preflightSeeds,
      canaryOrders: COMMANDER_XP_CANARY_ORDERS.map((order) => [...order]),
      confirmatoryOrderCycle: COMMANDER_XP_CONFIRMATORY_ORDER_CYCLE.map(
        (order) => [...order],
      ),
      canaryRequestCount: 12,
      confirmatoryRequestCount: 96,
      confirmatoryPairCount: 48,
      canarySeeds,
      confirmatorySeeds,
    },
    analysis: {
      analysisID: "strategic-commander-xp-b-vs-c-paired-v3",
      population: "48-complete-preregistered-bc-pairs",
      alternative: "C-superior-to-B",
      alpha: 0.05,
      confidenceLevel: 0.95,
      missingnessPolicy: "no-missing-pairs",
      primaryEndpoint: "subject-win",
      scoreRole: "redundant-descriptive-only",
      multiplicityPolicy: "single-primary-no-adjustment",
      minimumWinRateEffectCMinusB: 0.1,
      winMethod: "exact-two-sided-mcnemar",
      intervalMethod: "seeded-paired-bootstrap-percentile",
      resamplingSeed: "strategic-commander-xp-b-vs-c-analysis-v3",
      bootstrapIterations: 4096,
      decisionRule:
        "all-48-complete-and-integrity-green-and-win-estimate-gt-minimum-and-p-lte-alpha-and-ci-lower-gt-minimum",
      canaryClaimGate: "never",
      performanceClaimGate: "external-seal-independent-review-required",
    },
    providerPreflightRequests,
    requests,
  } as const;
  return {
    ...withoutHash,
    preRegistrationSha256: sha256Canonical(withoutHash),
  };
}

export function deriveCommanderXpSeeds(base: string, count: number): number[] {
  if (base.trim() === "" || !Number.isInteger(count) || count < 1) {
    throw new Error("Commander XP seed derivation input is invalid");
  }
  const acceptedLimit =
    Math.floor(2 ** 32 / COMMANDER_XP_SEED_MAX_EXCLUSIVE) *
    COMMANDER_XP_SEED_MAX_EXCLUSIVE;
  const result: number[] = [];
  const used = new Set<number>();
  for (let replicaIndex = 0; replicaIndex < count; replicaIndex += 1) {
    let attempt = 0;
    while (attempt < 10_000) {
      const material = `${base}\0r${String(replicaIndex).padStart(4, "0")}\0a${attempt}`;
      const value = createHash("sha256")
        .update(material)
        .digest()
        .readUInt32BE(0);
      attempt += 1;
      if (value >= acceptedLimit) continue;
      const seed = value % COMMANDER_XP_SEED_MAX_EXCLUSIVE;
      if (used.has(seed)) continue;
      used.add(seed);
      result.push(seed);
      break;
    }
    if (result.length !== replicaIndex + 1) {
      throw new Error("Commander XP seed derivation exhausted attempts");
    }
  }
  return result;
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function commanderXpProviderPreflightRequestID(runKey: string): string {
  if (
    !/^commander-xp-v2\/[A-Za-z0-9._-]+\/(?:provider-preflight|canary|confirmatory)\/r\d{2}\/(?:A|B|C)$/.test(
      runKey,
    )
  ) {
    throw new Error("Commander XP preflight run key is invalid");
  }
  return `provider-preflight-${createHash("sha256")
    .update(runKey)
    .digest("hex")
    .slice(0, 24)}`;
}

function plannedRequest(input: {
  input: CommanderXpPlanInput;
  phase: CommanderXpProtocolPhase;
  replicaIndex: number;
  arm: CommanderXpArm;
  orderIndex: number;
  seed: number;
}): CommanderXpPlannedRequest {
  const subjectSeat = input.replicaIndex % 4;
  const episodeIndex = Math.floor(input.replicaIndex / 4) % 4;
  const subjectPolicyVersionID = input.input.armPolicyVersionIDs[input.arm];
  const roster = rosterForSubject({
    subjectSeat,
    subjectPolicyVersionID,
    opponentPolicyVersionIDs: input.input.opponentPolicyVersionIDs,
  });
  const runKey = [
    "commander-xp-v2",
    input.input.experimentID,
    input.phase,
    `r${String(input.replicaIndex).padStart(2, "0")}`,
    input.arm,
  ].join("/");
  const requestBody: CommanderXpRequestBody = {
    idempotency_key: runKey,
    llm_routing_override: "bedrock",
    target: {
      coworld_id: input.input.coworldID,
      variant_id: COMMANDER_XP_VARIANT_ID,
    },
    roster,
    num_episodes: 1,
    game_config_overrides: {
      commander_xp_phase: input.phase,
      commander_xp_run_key: runKey,
      max_decision_steps:
        input.phase === "provider-preflight"
          ? 1
          : COMMANDER_XP_GAMEPLAY_MAX_DECISION_STEPS,
      turns_per_decision_step:
        input.phase === "provider-preflight"
          ? 1
          : COMMANDER_XP_TURNS_PER_DECISION_STEP,
      max_decision_ms: 15000,
      map: "Pangaea",
      map_size: "Compact",
      difficulty: "Easy",
      seed: input.seed,
      episodeIndex,
      replay_tail_turns: 500,
      num_agents: 4,
      episode_timeout_seconds:
        input.phase === "provider-preflight" ? 2400 : 6000,
    },
    execution_backend: "k8s",
    notes: `commander-xp/${input.phase}/${input.replicaIndex}/${input.arm}`,
  };
  return {
    phase: input.phase,
    replicaIndex: input.replicaIndex,
    arm: input.arm,
    orderIndex: input.orderIndex,
    subjectSeat,
    episodeIndex,
    seed: input.seed,
    runKey,
    subjectPolicyVersionID,
    requestBody,
    requestBodySha256: sha256Canonical(requestBody),
  };
}

function rosterForSubject(input: {
  subjectSeat: number;
  subjectPolicyVersionID: string;
  opponentPolicyVersionIDs: readonly [string, string, string];
}): CommanderXpRosterParticipant[] {
  let opponentIndex = 0;
  return Array.from({ length: 4 }, (_, slot) => {
    const policyRef =
      slot === input.subjectSeat
        ? input.subjectPolicyVersionID
        : input.opponentPolicyVersionIDs[opponentIndex++]!;
    return { player: { policy_ref: policyRef }, slot };
  });
}

function assertPlanInput(input: CommanderXpPlanInput): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{4,80}$/.test(input.experimentID)) {
    throw new Error("Commander XP experimentID is invalid");
  }
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("Commander XP createdAt is invalid");
  }
  if (input.behaviorSourceSha !== COMMANDER_XP_BEHAVIOR_SOURCE_SHA) {
    throw new Error(
      "Commander XP behavior source is not the frozen a691 baseline",
    );
  }
  if (input.behaviorSourceTreeSha !== COMMANDER_XP_BEHAVIOR_SOURCE_TREE_SHA) {
    throw new Error(
      "Commander XP behavior source tree is not the frozen a691 tree",
    );
  }
  for (const [label, value] of Object.entries({
    behaviorSourceTreeSha: input.behaviorSourceTreeSha,
    adapterSourceSha: input.adapterSourceSha,
    adapterSourceTreeSha: input.adapterSourceTreeSha,
  })) {
    if (!/^[0-9a-f]{40}$/.test(value)) {
      throw new Error(`Commander XP ${label} is not an exact Git identity`);
    }
  }
  for (const [label, value] of Object.entries({
    sourceDiffManifestSha256: input.sourceDiffManifestSha256,
    sourceProvenanceSha256: input.sourceProvenanceSha256,
  })) {
    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`Commander XP ${label} is invalid`);
    }
  }
  for (const [label, value] of Object.entries({
    policyBuildProvenanceDigest: input.policyBuildProvenanceDigest,
    gameBuildProvenanceDigest: input.gameBuildProvenanceDigest,
  })) {
    if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
      throw new Error(`Commander XP ${label} is invalid`);
    }
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.imageDigest)) {
    throw new Error("Commander XP image digest is invalid");
  }
  if (
    !/^[0-9a-f]{64}$/.test(input.coworldManifestSha256) ||
    !/^[0-9a-f]{64}$/.test(input.coworldHostedManifestSha256) ||
    !/^img_[A-Za-z0-9_-]{8,}$/.test(input.coworldGameImageID) ||
    !/^sha256:[0-9a-f]{64}$/.test(input.coworldGameImageDigest) ||
    !/^[0-9a-f]{64}$/.test(input.canonicalLeagueBindingSnapshotSha256)
  ) {
    throw new Error("Commander XP eval Coworld identity is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(input.xpOpenApiSha256)) {
    throw new Error("Commander XP OpenAPI schema hash is invalid");
  }
  if (input.xpOpenApiSha256 !== COMMANDER_XP_OPENAPI_SHA256) {
    throw new Error("Commander XP OpenAPI document is not the frozen schema");
  }
  if (
    input.coworldID.trim() === "" ||
    input.coworldID === COMMANDER_XP_CANONICAL_COWORLD_ID ||
    input.coworldVersion.trim() === "" ||
    input.bedrockModel !== COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT.modelID
  ) {
    throw new Error("Commander XP hosted identity is incomplete");
  }
  const policyIDs = [
    input.armPolicyVersionIDs.A,
    input.armPolicyVersionIDs.B,
    input.armPolicyVersionIDs.C,
    ...input.opponentPolicyVersionIDs,
  ];
  if (
    policyIDs.some((id) => id.trim() === "") ||
    new Set(policyIDs).size !== 6
  ) {
    throw new Error("Commander XP policies must be six distinct exact refs");
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}
