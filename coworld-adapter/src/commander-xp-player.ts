/**
 * Eval-only Coworld policy for the hosted StrategicCommander XP experiment.
 *
 * One image contains all three arms. Policy versions must use byte-identical
 * argv except for the final `--arm=A|B|C` token. Every arm receives the same
 * exact Bedrock model/sidecar configuration; Arm B constructs no provider call.
 * This file reuses the Keystone websocket/social boundary, but Arm B/C execute
 * the actual StrategicCommander binding-first brain rather than treating
 * Keystone as a performance proxy. All three immutable policy arms perform
 * the same exact-model provider preflight; Arm B makes no provider call during
 * gameplay.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  AgentBrain,
  AgentBrainInput,
  AgentDecision,
  AgentStrategyProfile,
} from "../../src/server/agents/AgentTypes";
import {
  COMMANDER_COWORLD_BEDROCK_PROVIDER,
  COMMANDER_COWORLD_BEHAVIOR_SOURCE_SHA,
  COMMANDER_COWORLD_BEHAVIOR_SOURCE_TREE_SHA,
  COMMANDER_COWORLD_PROMPT_VERSION,
  COMMANDER_COWORLD_PROMPT_VERSION_SHA256,
  commanderCoworldPreflightRequestID,
  commanderCoworldSha256Canonical,
} from "../../src/server/agents/CommanderCoworldRuntime";
import type {
  LlmCompletionOptions,
  LlmProvider,
} from "../../src/server/agents/LlmProvider";
import {
  CommanderXpTraceCollector,
  uploadCommanderXpPlayerArtifact,
  type CommanderXpArm,
  type CommanderXpRuntimeManifest,
} from "./commander-xp-artifact";
import { finalizeCommanderXpPlayer } from "./commander-xp-finalization";
import {
  createKeystoneBrain,
  decisionToResponse,
  keystoneTunableFlagSummary,
  loadKeystoneModules,
  requestToBrainInput,
  spawnPreferenceDecision,
  transportFallbackResponse,
  wireMaxActionsPerDecision,
  wireMaxSpawnPreferences,
  withoutKeystoneTreatyBreaches,
} from "./keystone-player";

type CommanderBrainModule =
  typeof import("../../src/server/agents/StrategicCommanderBrain");
type CommanderCallerModule =
  typeof import("../../src/server/agents/StrategicCommanderCaller");
type CommanderSelectorModule =
  typeof import("../../src/server/agents/StrategicOptionSelectors");
type CommanderLlmSelectorModule =
  typeof import("../../src/server/agents/LlmOptionSelector");
type RuleBrainModule = typeof import("../../src/server/agents/RuleAgentBrain");

const REQUIRED_FLAGS = {
  PROXYWAR_TUNE_STRUCTURED_DEALS: "0",
  PROXYWAR_TUNE_FREETEXT_MESSAGES: "0",
  PROXYWAR_TUNE_SPATIAL_OBSERVATION: "0",
  PROXYWAR_TUNE_SPATIAL_MINIMAP: "0",
  PROXYWAR_KEYSTONE_PROFILE: "aggressive",
  PROXYWAR_LLM_TIMEOUT_MS: "13500",
} as const;
const PROVIDER_PREFLIGHT_PROMPT =
  "Return exactly the single uppercase token OK and nothing else.";

export function commanderXpProviderPreflightRequired(
  _arm: CommanderXpArm,
): true {
  return true;
}

export function withoutCommanderXpSocialSlots(
  decision: AgentDecision,
): AgentDecision {
  const {
    dealActionID: _dealActionID,
    messageActionID: _messageActionID,
    messageText: _messageText,
    ...ordinaryDecision
  } = decision;
  return ordinaryDecision;
}

interface BedrockResponse {
  model?: unknown;
  content?: Array<{ text?: unknown }>;
}

interface BedrockClient {
  messages: {
    create(
      body: Record<string, unknown>,
      options: { timeout: number; signal?: AbortSignal },
    ): Promise<BedrockResponse>;
  };
}

class ExactBedrockProvider implements LlmProvider {
  readonly providerType = "custom" as const;
  readonly cancellationBehavior = "settles-after-abort" as const;
  readonly model: typeof COMMANDER_COWORLD_BEDROCK_PROVIDER.modelID;
  private client: BedrockClient | null = null;
  private currentRequestID = "uninitialized-preflight";
  private currentStage: "preflight" | "planner" | "selector" = "preflight";
  private readonly active = new Set<Promise<unknown>>();

  constructor(
    model: typeof COMMANDER_COWORLD_BEDROCK_PROVIDER.modelID,
    private readonly arm: CommanderXpArm,
    private readonly collector: CommanderXpTraceCollector,
    private readonly timeoutMs: number,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.model = model;
  }

  setRequestID(requestID: string): void {
    this.currentRequestID = requestID;
    this.currentStage = requestID.startsWith("provider-preflight-")
      ? "preflight"
      : this.arm === "A"
        ? "planner"
        : "selector";
  }

  async complete(
    prompt: string,
    options: LlmCompletionOptions = {},
  ): Promise<string> {
    const requestID = this.currentRequestID;
    const promptSha256 = sha256(prompt);
    const providerContractSha256 = commanderCoworldSha256Canonical(
      COMMANDER_COWORLD_BEDROCK_PROVIDER,
    );
    const promptVersion =
      this.currentStage === "selector"
        ? COMMANDER_COWORLD_PROMPT_VERSION
        : null;
    const promptVersionSha256 =
      this.currentStage === "selector"
        ? COMMANDER_COWORLD_PROMPT_VERSION_SHA256
        : null;
    const operation = this.completeInternal(prompt, options);
    this.active.add(operation);
    try {
      const response = await operation;
      const responseModel =
        typeof response.model === "string" ? response.model : null;
      if (
        responseModel !== COMMANDER_COWORLD_BEDROCK_PROVIDER.responseModelID
      ) {
        this.collector.provider({
          requestID,
          stage: this.currentStage,
          provider: "bedrock-sidecar",
          providerContractSha256,
          promptVersion,
          promptVersionSha256,
          requestedModel: this.model,
          responseModel,
          promptSha256,
          promptCharacters: prompt.length,
          outputSha256: null,
          outputCharacters: null,
          succeeded: false,
          failureKind: "model-mismatch",
        });
        throw new Error("bedrock-model-mismatch");
      }
      const output = (response.content ?? [])
        .map((block) => (typeof block.text === "string" ? block.text : ""))
        .join("")
        .trim();
      this.collector.provider({
        requestID,
        stage: this.currentStage,
        provider: "bedrock-sidecar",
        providerContractSha256,
        promptVersion,
        promptVersionSha256,
        requestedModel: this.model,
        responseModel,
        promptSha256,
        promptCharacters: prompt.length,
        outputSha256: sha256(output),
        outputCharacters: output.length,
        succeeded: true,
        failureKind: null,
      });
      return output;
    } catch (error) {
      if (
        !(error instanceof Error && error.message === "bedrock-model-mismatch")
      ) {
        this.collector.provider({
          requestID,
          stage: this.currentStage,
          provider: "bedrock-sidecar",
          providerContractSha256,
          promptVersion,
          promptVersionSha256,
          requestedModel: this.model,
          responseModel: null,
          promptSha256,
          promptCharacters: prompt.length,
          outputSha256: null,
          outputCharacters: null,
          succeeded: false,
          failureKind:
            options.signal?.aborted === true ? "timeout" : "transport",
        });
      }
      throw new Error(
        options.signal?.aborted === true
          ? "bedrock-selector-timeout"
          : "bedrock-provider-failure",
        { cause: error },
      );
    } finally {
      this.active.delete(operation);
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }

  private async completeInternal(
    prompt: string,
    options: LlmCompletionOptions,
  ): Promise<BedrockResponse> {
    const client = await this.bedrockClient();
    return await client.messages.create(
      commanderXpBedrockRequest(this.model, prompt),
      { timeout: this.timeoutMs, signal: options.signal },
    );
  }

  private async bedrockClient(): Promise<BedrockClient> {
    if (this.client !== null) return this.client;
    const baseURL = commanderXpBedrockSidecarEndpoint(this.env);
    const runtimeRegion = this.env.AWS_REGION?.trim();
    if (!runtimeRegion) {
      throw new Error("bedrock-sidecar-region-missing");
    }
    const specifier = "@anthropic-ai/bedrock-sdk";
    const imported = (await import(/* @vite-ignore */ specifier)) as {
      default?: new (options: Record<string, unknown>) => BedrockClient;
      AnthropicBedrock?: new (
        options: Record<string, unknown>,
      ) => BedrockClient;
    };
    const Constructor = imported.default ?? imported.AnthropicBedrock;
    if (Constructor === undefined) {
      throw new Error("bedrock-sidecar-client-missing");
    }
    this.client = new Constructor({
      awsRegion: runtimeRegion,
      baseURL,
    });
    return this.client;
  }
}

export function commanderXpArmFromArgv(
  args: readonly string[],
): CommanderXpArm {
  if (args.length !== 1 || !/^--arm=[ABC]$/.test(args[0] ?? "")) {
    throw new Error(
      "Commander XP policy requires exactly one --arm=A|B|C argument",
    );
  }
  return args[0]!.slice(-1) as CommanderXpArm;
}

export function assertCommanderXpEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  resolvedSdkVersion = commanderXpResolvedBedrockSdkVersion(),
): {
  model: typeof COMMANDER_COWORLD_BEDROCK_PROVIDER.modelID;
  profile: AgentStrategyProfile;
  timeoutMs: number;
} {
  for (const [key, expected] of Object.entries(REQUIRED_FLAGS)) {
    if (env[key] !== expected) {
      throw new Error(`Commander XP requires ${key}=${expected}`);
    }
  }
  const model = env.BEDROCK_MODEL?.trim();
  if (model !== COMMANDER_COWORLD_BEDROCK_PROVIDER.modelID) {
    throw new Error("Commander XP requires the exact Bedrock model ID");
  }
  const runtimeRegion = env.AWS_REGION?.trim();
  if (
    !runtimeRegion ||
    (env.AWS_DEFAULT_REGION !== undefined &&
      env.AWS_DEFAULT_REGION !== runtimeRegion)
  ) {
    throw new Error(
      "Commander XP requires a consistent Coworld Bedrock region",
    );
  }
  commanderXpBedrockSidecarEndpoint(env);
  if (resolvedSdkVersion !== COMMANDER_COWORLD_BEDROCK_PROVIDER.sdkVersion) {
    throw new Error("Commander XP requires the exact Bedrock SDK version");
  }
  return {
    model,
    profile: "aggressive",
    timeoutMs: COMMANDER_COWORLD_BEDROCK_PROVIDER.timeoutMs,
  };
}

export function commanderXpBedrockRequest(
  model: typeof COMMANDER_COWORLD_BEDROCK_PROVIDER.modelID,
  prompt: string,
): {
  model: typeof COMMANDER_COWORLD_BEDROCK_PROVIDER.modelID;
  max_tokens: 1024;
  messages: Array<{ role: "user"; content: string }>;
} {
  return {
    model,
    max_tokens: COMMANDER_COWORLD_BEDROCK_PROVIDER.maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
}

function commanderXpErrorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    messages.push(current.message.slice(0, 240));
    current = current.cause;
  }
  return messages.join(" <- ") || "unknown error";
}

export function commanderXpResolvedBedrockSdkVersion(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve(COMMANDER_COWORLD_BEDROCK_PROVIDER.sdkPackage);
  const parsed = JSON.parse(
    readFileSync(path.join(path.dirname(entry), "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error("Commander XP Bedrock SDK package metadata is invalid");
  }
  return parsed.version;
}

export function commanderXpBedrockSidecarEndpoint(
  env: NodeJS.ProcessEnv,
): string {
  const raw = env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME?.trim();
  if (raw === undefined || raw.length === 0) {
    throw new Error("bedrock-sidecar-endpoint-missing");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("bedrock-sidecar-endpoint-invalid");
  }
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.port === ""
  ) {
    throw new Error("bedrock-sidecar-endpoint-invalid");
  }
  return endpoint.toString().replace(/\/$/, "");
}

async function loadStrategicModules(repoRoot: string) {
  const agents = path.join(repoRoot, "src", "server", "agents");
  const [brain, caller, deterministic, llm, rule] = await Promise.all([
    import(
      pathToFileURL(path.join(agents, "StrategicCommanderBrain.ts")).href
    ) as Promise<CommanderBrainModule>,
    import(
      pathToFileURL(path.join(agents, "StrategicCommanderCaller.ts")).href
    ) as Promise<CommanderCallerModule>,
    import(
      pathToFileURL(path.join(agents, "StrategicOptionSelectors.ts")).href
    ) as Promise<CommanderSelectorModule>,
    import(
      pathToFileURL(path.join(agents, "LlmOptionSelector.ts")).href
    ) as Promise<CommanderLlmSelectorModule>,
    import(
      pathToFileURL(path.join(agents, "RuleAgentBrain.ts")).href
    ) as Promise<RuleBrainModule>,
  ]);
  return { brain, caller, deterministic, llm, rule };
}

export async function createCommanderXpBrain(input: {
  arm: CommanderXpArm;
  repoRoot: string;
  provider: LlmProvider;
  profile: AgentStrategyProfile;
  timeoutMs: number;
}): Promise<AgentBrain> {
  if (input.arm === "A") {
    return createKeystoneBrain(await loadKeystoneModules(input.repoRoot), {
      mode: "bedrock",
      profile: input.profile,
      planEveryDecisionSteps: 3,
      providerTimeoutMs: input.timeoutMs,
      provider: input.provider,
      blocking: true,
    });
  }
  const modules = await loadStrategicModules(input.repoRoot);
  const selector =
    input.arm === "B"
      ? new modules.deterministic.DeterministicOptionSelector()
      : new modules.llm.LlmOptionSelector({
          provider: input.provider,
          timeoutMs: input.timeoutMs,
        });
  return new modules.brain.StrategicCommanderBrain(
    new modules.caller.StrategicCommanderCaller(selector, input.timeoutMs),
    new modules.rule.RuleAgentBrain(input.profile),
  );
}

async function main(): Promise<void> {
  const arm = commanderXpArmFromArgv(process.argv.slice(2));
  const { model, profile, timeoutMs } = assertCommanderXpEnvironment();
  const url = requiredEnv("COWORLD_PLAYER_WS_URL");
  const uploadURL = requiredEnv("COWORLD_PLAYER_ARTIFACT_UPLOAD_URL");
  const repoRoot = process.env.PROXYWAR_REPO ?? "/app/proxywar";
  const collector = new CommanderXpTraceCollector();
  const provider = new ExactBedrockProvider(model, arm, collector, timeoutMs);
  let preflightResponseModel: string | null = null;
  let preflightRequestID: string | null = null;
  let observedRunKey: string | null = null;
  const brain = await createCommanderXpBrain({
    arm,
    repoRoot,
    provider,
    profile,
    timeoutMs,
  });
  const require = createRequire(import.meta.url);
  const { WebSocket } = require(`${repoRoot}/node_modules/ws`) as {
    WebSocket: new (url: string) => {
      on(event: string, listener: (...args: any[]) => void): void;
      send(body: string): void;
      close(): void;
    };
  };
  const socket = new WebSocket(url);
  let decisionChain: Promise<void> = Promise.resolve();
  let sawFinal = false;
  let finalizationAcknowledged = false;
  let observedGameID: string | null = null;
  socket.on("open", () => {
    console.log(
      `commander-xp connected (arm=${arm}, model=${model}, profile=${profile}, ${keystoneTunableFlagSummary()})`,
    );
  });
  socket.on("message", (data: unknown) => {
    let message: {
      type?: unknown;
      requestID?: unknown;
      request?: unknown;
      protocol?: unknown;
      commanderXpRunKey?: unknown;
    };
    try {
      message = JSON.parse(String(data));
    } catch {
      console.error("commander-xp invalid websocket frame");
      return;
    }
    if (message.type === "final") {
      sawFinal = true;
      decisionChain = decisionChain.then(async () => {
        if (
          observedGameID === null ||
          observedRunKey === null ||
          preflightRequestID === null ||
          preflightResponseModel === null
        ) {
          throw new Error("Commander XP received incomplete runtime identity");
        }
        const finalGameID = observedGameID;
        const finalRunKey = observedRunKey;
        const finalPreflightRequestID = preflightRequestID;
        const finalPreflightResponseModel = preflightResponseModel;
        await finalizeCommanderXpPlayer({
          drain: () => provider.drain(),
          upload: async () => {
            await uploadCommanderXpPlayerArtifact({
              uploadURL,
              manifest: runtimeManifest({
                arm,
                gameID: finalGameID,
                runKey: finalRunKey,
                model,
                preflightRequestID: finalPreflightRequestID,
                preflightResponseModel: finalPreflightResponseModel,
              }),
              trace: collector.records(),
            });
          },
          acknowledge: (acknowledgement) => {
            socket.send(JSON.stringify(acknowledgement));
            finalizationAcknowledged = true;
          },
        });
      });
      return;
    }
    if (message.type === "finalization_complete") {
      decisionChain = decisionChain.then(() => {
        if (!sawFinal || !finalizationAcknowledged) {
          throw new Error(
            "Commander XP finalization completed without acknowledgement",
          );
        }
        socket.close();
      });
      return;
    }
    if (message.type !== "decision_request") return;
    decisionChain = decisionChain.then(async () => {
      const requestID = String(message.requestID ?? "");
      try {
        const runKey = commanderXpRunKeyFromMessage(
          message.commanderXpRunKey,
          arm,
        );
        if (observedRunKey !== null && observedRunKey !== runKey) {
          throw new Error("Commander XP run identity changed mid-episode");
        }
        observedRunKey = runKey;
        if (preflightRequestID === null) {
          preflightRequestID = commanderCoworldPreflightRequestID(runKey);
          provider.setRequestID(preflightRequestID);
          await provider.complete(PROVIDER_PREFLIGHT_PROMPT);
          const preflight = [...collector.records()]
            .reverse()
            .find(
              (entry) =>
                entry.recordType === "provider" &&
                entry.requestID === preflightRequestID,
            );
          if (
            preflight?.recordType !== "provider" ||
            !preflight.succeeded ||
            preflight.responseModel !==
              COMMANDER_COWORLD_BEDROCK_PROVIDER.responseModelID
          ) {
            throw new Error("Commander XP Bedrock preflight failed");
          }
          preflightResponseModel = preflight.responseModel;
        }
        provider.setRequestID(requestID);
        const input: AgentBrainInput = requestToBrainInput(
          message.request,
          profile,
        );
        const requestGameID = input.observation.gameID;
        if (
          typeof requestGameID !== "string" ||
          requestGameID.length === 0 ||
          (observedGameID !== null && observedGameID !== requestGameID)
        ) {
          throw new Error("Commander XP game identity changed mid-episode");
        }
        observedGameID = requestGameID;
        const spawnDecision = spawnPreferenceDecision(
          input,
          wireMaxSpawnPreferences(message),
        );
        let decision: AgentDecision;
        if (spawnDecision !== null) {
          decision = spawnDecision;
        } else {
          let compliantActions = input.legalActions;
          try {
            compliantActions = withoutKeystoneTreatyBreaches(
              input.legalActions,
              input.observation,
            );
          } catch {
            console.error("commander-xp treaty menu guard failed");
          }
          decision = withoutCommanderXpSocialSlots(
            await brain.decide({
              ...input,
              legalActions: compliantActions,
            }),
          );
        }
        const response = decisionToResponse(
          requestID,
          decision,
          wireMaxActionsPerDecision(message),
          wireMaxSpawnPreferences(message),
        );
        collector.decision({
          requestID,
          arm,
          preSelectorObservationSha256: commanderCoworldSha256Canonical(
            commanderXpSelectorRelevantObservation(input.observation),
          ),
          preSelectorLegalActionSurfaceSha256: commanderCoworldSha256Canonical(
            input.legalActions,
          ),
          legalActions: input.legalActions,
          decision,
          response,
        });
        socket.send(JSON.stringify(response));
      } catch (error) {
        console.error(
          "commander-xp decision failed",
          commanderXpErrorChain(error),
        );
        socket.send(
          JSON.stringify(
            transportFallbackResponse(
              requestID,
              message.request,
              "commander-xp-policy-failure",
            ),
          ),
        );
      }
    });
  });
  socket.on("close", () => {
    void decisionChain.then(
      () => process.exit(sawFinal && finalizationAcknowledged ? 0 : 1),
      () => process.exit(1),
    );
  });
  socket.on("error", () => {
    console.error("commander-xp websocket error");
    process.exit(1);
  });
}

/**
 * Exact pre-selector observation surface. The game has already normalized the
 * seat username; retaining it here is deliberate because CommanderStateBuilder
 * serializes it as `self.name` into the C-arm prompt. Only the transport-local
 * client ID is excluded. Matched B/C verification compares this full hash
 * before either selector runs.
 */
export function commanderXpSelectorRelevantObservation(
  observation: AgentBrainInput["observation"],
): Omit<AgentBrainInput["observation"], "clientID"> {
  const { clientID: _transportIdentity, ...selectorInput } = observation;
  return selectorInput;
}

function runtimeManifest(input: {
  arm: CommanderXpArm;
  gameID: string;
  runKey: string;
  model: string;
  preflightRequestID: string;
  preflightResponseModel: string;
}): CommanderXpRuntimeManifest {
  return {
    schemaVersion: 2,
    artifactKind: "commander-xp-policy-evidence",
    arm: input.arm,
    gameID: input.gameID,
    runKey: input.runKey,
    behaviorSourceSha: COMMANDER_COWORLD_BEHAVIOR_SOURCE_SHA,
    behaviorSourceTreeSha: COMMANDER_COWORLD_BEHAVIOR_SOURCE_TREE_SHA,
    adapterSourceSha: requiredEnv("COMMANDER_XP_ADAPTER_SOURCE_SHA"),
    adapterSourceTreeSha: requiredEnv("COMMANDER_XP_ADAPTER_SOURCE_TREE_SHA"),
    sourceProvenanceSha256: requiredEnv(
      "COMMANDER_XP_SOURCE_PROVENANCE_SHA256",
    ),
    // Coworld 0.1.42 assigns the pvid after upload and exposes no ordinary
    // runtime metadata injection. These identities are therefore bound only by
    // the sealed policy-inspect and XP-participant receipts, never self-labeled.
    imageDigest: null,
    policyVersionID: null,
    policyIdentityAuthority:
      "external-policy-inspect-and-xp-participant-metadata",
    requestedModel: input.model,
    providerContract: structuredClone(COMMANDER_COWORLD_BEDROCK_PROVIDER),
    commanderPromptVersion: COMMANDER_COWORLD_PROMPT_VERSION,
    commanderPromptVersionSha256: COMMANDER_COWORLD_PROMPT_VERSION_SHA256,
    runArgv: [
      "node",
      "--import",
      "tsx",
      "/app/proxywar/coworld-adapter/src/commander-xp-player.ts",
      `--arm=${input.arm}`,
    ],
    flags: {
      STRUCTURED_DEALS: "0",
      FREETEXT_MESSAGES: "0",
      SPATIAL_OBSERVATION: "0",
      SPATIAL_MINIMAP: "0",
      KEYSTONE_PROFILE: "aggressive",
      LLM_TIMEOUT_MS: "13500",
    },
    providerPreflight: {
      required: true,
      status: "succeeded",
      requestID: input.preflightRequestID,
      requestedModel: input.model,
      responseModel: input.preflightResponseModel,
      succeeded: true,
    },
  };
}

function commanderXpRunKeyFromMessage(
  value: unknown,
  arm: CommanderXpArm,
): string {
  if (
    typeof value !== "string" ||
    !/^commander-xp-v2\/[A-Za-z0-9._-]+\/(?:provider-preflight|canary|confirmatory)\/r\d{2}\/(?:A|B|C)$/.test(
      value,
    ) ||
    !value.endsWith(`/${arm}`)
  ) {
    throw new Error("Commander XP decision envelope run identity is invalid");
  }
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`Commander XP requires ${name}`);
  }
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "commander-xp fatal",
    );
    process.exit(1);
  });
}
