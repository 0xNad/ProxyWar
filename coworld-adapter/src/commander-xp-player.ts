/**
 * Eval-only Coworld policy for the hosted StrategicCommander XP experiment.
 *
 * One image contains all three arms. Policy versions must use byte-identical
 * argv except for the final `--arm=A|B|C` token. Every arm receives the same
 * exact Bedrock model/sidecar configuration; Arm B constructs no provider call.
 * This file reuses the Keystone websocket/social boundary, but Arm B/C execute
 * the actual StrategicCommander binding-first brain rather than treating
 * Keystone as a performance proxy.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  AgentBrain,
  AgentBrainInput,
  AgentDecision,
  AgentStrategyProfile,
} from "../../src/server/agents/AgentTypes";
import type {
  LlmCompletionOptions,
  LlmProvider,
} from "../../src/server/agents/LlmProvider";
import {
  COMMANDER_XP_BEHAVIOR_SOURCE_SHA,
  COMMANDER_XP_BEHAVIOR_SOURCE_TREE_SHA,
} from "../../src/server/agents/CommanderXpBehaviorIdentity";
import {
  CommanderXpTraceCollector,
  uploadCommanderXpPlayerArtifact,
  type CommanderXpArm,
  type CommanderXpRuntimeManifest,
} from "./commander-xp-artifact";
import {
  chooseKeystoneDealMove,
  chooseKeystoneMessageMove,
  createKeystoneBrain,
  decisionToResponse,
  keystoneTunableFlagSummary,
  loadKeystoneModules,
  requestToBrainInput,
  spawnPreferenceDecision,
  transportFallbackResponse,
  wireMaxActionsPerDecision,
  wireMaxSpawnPreferences,
  withKeystoneDeal,
  withKeystoneMessage,
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
  PROXYWAR_TUNE_STRUCTURED_DEALS: "1",
  PROXYWAR_TUNE_FREETEXT_MESSAGES: "1",
  PROXYWAR_TUNE_SPATIAL_OBSERVATION: "0",
  PROXYWAR_TUNE_SPATIAL_MINIMAP: "0",
} as const;
const PROVIDER_PREFLIGHT_REQUEST_ID = "provider-preflight";
const PROVIDER_PREFLIGHT_PROMPT =
  "Return exactly the single uppercase token OK and nothing else.";

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
  readonly model: string;
  private client: BedrockClient | null = null;
  private currentRequestID = PROVIDER_PREFLIGHT_REQUEST_ID;
  private currentStage: "preflight" | "planner" | "selector" = "preflight";
  private readonly active = new Set<Promise<unknown>>();

  constructor(
    model: string,
    private readonly arm: CommanderXpArm,
    private readonly collector: CommanderXpTraceCollector,
    private readonly timeoutMs: number,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.model = model;
  }

  setRequestID(requestID: string): void {
    this.currentRequestID = requestID;
    this.currentStage = requestID === PROVIDER_PREFLIGHT_REQUEST_ID
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
    const operation = this.completeInternal(prompt, options);
    this.active.add(operation);
    try {
      const response = await operation;
      const responseModel =
        typeof response.model === "string" ? response.model : null;
      if (responseModel !== this.model) {
        this.collector.provider({
          requestID,
          stage: this.currentStage,
          provider: "bedrock-sidecar",
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
      {
        model: this.model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: this.timeoutMs, signal: options.signal },
    );
  }

  private async bedrockClient(): Promise<BedrockClient> {
    if (this.client !== null) return this.client;
    const baseURL = this.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME?.trim();
    if (baseURL === undefined || !/^https?:\/\//.test(baseURL)) {
      throw new Error("bedrock-sidecar-endpoint-missing");
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
      awsRegion:
        this.env.AWS_REGION ?? this.env.AWS_DEFAULT_REGION ?? "us-west-2",
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
): { model: string; profile: AgentStrategyProfile; timeoutMs: number } {
  for (const [key, expected] of Object.entries(REQUIRED_FLAGS)) {
    if (env[key] !== expected) {
      throw new Error(`Commander XP requires ${key}=${expected}`);
    }
  }
  const model = env.BEDROCK_MODEL?.trim();
  if (model === undefined || model.length < 8 || /\s/.test(model)) {
    throw new Error("Commander XP requires one exact BEDROCK_MODEL");
  }
  const timeoutMs = Number(env.PROXYWAR_LLM_TIMEOUT_MS ?? "12000");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 119000) {
    throw new Error("Commander XP provider timeout is invalid");
  }
  const configuredProfile = env.PROXYWAR_KEYSTONE_PROFILE?.trim();
  return {
    model,
    profile: (configuredProfile === undefined || configuredProfile === ""
      ? "aggressive"
      : configuredProfile) as AgentStrategyProfile,
    timeoutMs,
  };
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
  if (arm !== "B") {
    provider.setRequestID(PROVIDER_PREFLIGHT_REQUEST_ID);
    await provider.complete(PROVIDER_PREFLIGHT_PROMPT);
    const preflight = [...collector.records()]
      .reverse()
      .find(
        (entry) =>
          entry.recordType === "provider" &&
          entry.requestID === PROVIDER_PREFLIGHT_REQUEST_ID,
      );
    if (
      preflight?.recordType !== "provider" ||
      !preflight.succeeded ||
      preflight.responseModel !== model
    ) {
      throw new Error("Commander XP Bedrock preflight failed");
    }
    preflightResponseModel = preflight.responseModel;
  }
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
  const answeredMessages = new Set<string>();
  const proposedDeals = new Set<string>();
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
        await provider.drain();
        await uploadCommanderXpPlayerArtifact({
          uploadURL,
          manifest: runtimeManifest({
            arm,
            model,
            preflightResponseModel,
          }),
          trace: collector.records(),
        });
        socket.close();
      });
      return;
    }
    if (message.type !== "decision_request") return;
    decisionChain = decisionChain.then(async () => {
      const requestID = String(message.requestID ?? "");
      provider.setRequestID(requestID);
      try {
        const input: AgentBrainInput = requestToBrainInput(
          message.request,
          profile,
        );
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
          const decided = await brain.decide({
            ...input,
            legalActions: compliantActions,
          });
          decision = withKeystoneDeal(
            withKeystoneMessage(
              decided,
              chooseKeystoneMessageMove(
                input.legalActions,
                input.observation,
                answeredMessages,
              ),
            ),
            chooseKeystoneDealMove({
              observation: input.observation,
              legalActions: input.legalActions,
              proposed: proposedDeals,
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
          legalActions: input.legalActions,
          decision,
          response,
        });
        socket.send(JSON.stringify(response));
      } catch {
        console.error("commander-xp decision failed");
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
    process.exit(sawFinal ? 0 : 1);
  });
  socket.on("error", () => {
    console.error("commander-xp websocket error");
    process.exit(1);
  });
}

function runtimeManifest(input: {
  arm: CommanderXpArm;
  model: string;
  preflightResponseModel: string | null;
}): CommanderXpRuntimeManifest {
  return {
    schemaVersion: 2,
    artifactKind: "commander-xp-policy-evidence",
    arm: input.arm,
    behaviorSourceSha: COMMANDER_XP_BEHAVIOR_SOURCE_SHA,
    behaviorSourceTreeSha: COMMANDER_XP_BEHAVIOR_SOURCE_TREE_SHA,
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
    runArgv: [
      "node",
      "--import",
      "tsx",
      "/app/proxywar/coworld-adapter/src/commander-xp-player.ts",
      `--arm=${input.arm}`,
    ],
    flags: {
      STRUCTURED_DEALS: "1",
      FREETEXT_MESSAGES: "1",
      SPATIAL_OBSERVATION: "0",
      SPATIAL_MINIMAP: "0",
    },
    providerPreflight: {
      required: input.arm !== "B",
      requestID: PROVIDER_PREFLIGHT_REQUEST_ID,
      requestedModel: input.model,
      responseModel: input.preflightResponseModel,
      succeeded:
        input.arm === "B" || input.preflightResponseModel === input.model,
    },
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`Commander XP requires ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" ? null : value;
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
