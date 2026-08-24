/**
 * Production Coworld entrypoint for the LLM Strategic Commander.
 *
 * This deliberately omits the eval-only run key, provider preflight, and
 * artifact-finalization handshake used by commander-xp-player.ts. It accepts
 * the ordinary production player websocket contract and still preserves the
 * same state -> locked option -> private binding -> exact offered action path.
 */
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
  decisionToResponse,
  requestToBrainInput,
  spawnPreferenceDecision,
  transportFallbackResponse,
  wireMaxActionsPerDecision,
  wireMaxSpawnPreferences,
  withoutKeystoneTreatyBreaches,
} from "../src/keystone-player";

const MODEL = "us.anthropic.claude-sonnet-4-6" as const;
const MAX_TOKENS = 1024 as const;
const SELECTOR_TIMEOUT_MS = 12_000;

interface BedrockResponse {
  content?: Array<{ text?: unknown }>;
}

interface BedrockClient {
  messages: {
    create(
      body: ReturnType<typeof commanderBedrockRequest>,
      options: { timeout: number; signal?: AbortSignal },
    ): Promise<BedrockResponse>;
  };
}

export function commanderBedrockRequest(prompt: string): {
  model: typeof MODEL;
  max_tokens: typeof MAX_TOKENS;
  messages: Array<{ role: "user"; content: string }>;
} {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  };
}

export function commanderBedrockSidecarEndpoint(
  env: NodeJS.ProcessEnv,
): string {
  const raw = env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME?.trim();
  if (!raw) throw new Error("Commander Bedrock sidecar endpoint is missing");
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("Commander Bedrock sidecar endpoint is invalid");
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
    throw new Error("Commander Bedrock sidecar endpoint is invalid");
  }
  return endpoint.toString().replace(/\/$/, "");
}

export function commanderRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): {
  profile: AgentStrategyProfile;
  region: string;
  endpoint: string;
} {
  if (env.USE_BEDROCK !== "true" || env.BEDROCK_MODEL !== MODEL) {
    throw new Error("Commander requires the exact Coworld Bedrock model");
  }
  const region = env.AWS_REGION?.trim();
  if (!region) throw new Error("Commander Bedrock region is missing");
  return {
    profile: "aggressive",
    region,
    endpoint: commanderBedrockSidecarEndpoint(env),
  };
}

class CommanderBedrockProvider implements LlmProvider {
  readonly providerType = "custom" as const;
  readonly cancellationBehavior = "settles-after-abort" as const;
  readonly model = MODEL;
  private client: BedrockClient | null = null;

  constructor(
    private readonly region: string,
    private readonly endpoint: string,
  ) {}

  async complete(
    prompt: string,
    options: LlmCompletionOptions = {},
  ): Promise<string> {
    const client = await this.bedrockClient();
    const response = await client.messages.create(
      commanderBedrockRequest(prompt),
      {
        timeout: SELECTOR_TIMEOUT_MS,
        signal: options.signal,
      },
    );
    const output = (response.content ?? [])
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join("")
      .trim();
    if (output.length === 0) {
      throw new Error("Commander Bedrock response was empty");
    }
    return output;
  }

  private async bedrockClient(): Promise<BedrockClient> {
    if (this.client !== null) return this.client;
    const specifier = "@anthropic-ai/bedrock-sdk";
    const imported = (await import(/* @vite-ignore */ specifier)) as {
      default?: new (options: Record<string, unknown>) => BedrockClient;
      AnthropicBedrock?: new (
        options: Record<string, unknown>,
      ) => BedrockClient;
    };
    const Constructor = imported.default ?? imported.AnthropicBedrock;
    if (Constructor === undefined) {
      throw new Error("Commander Bedrock SDK client is unavailable");
    }
    this.client = new Constructor({
      awsRegion: this.region,
      baseURL: this.endpoint,
    });
    return this.client;
  }
}

export async function createProductionCommanderBrain(input: {
  repoRoot: string;
  provider: LlmProvider;
  profile: AgentStrategyProfile;
}): Promise<AgentBrain> {
  const agents = path.join(input.repoRoot, "src", "server", "agents");
  const [brain, caller, llm, rule] = await Promise.all([
    import(pathToFileURL(path.join(agents, "StrategicCommanderBrain.ts")).href),
    import(
      pathToFileURL(path.join(agents, "StrategicCommanderCaller.ts")).href
    ),
    import(pathToFileURL(path.join(agents, "LlmOptionSelector.ts")).href),
    import(pathToFileURL(path.join(agents, "RuleAgentBrain.ts")).href),
  ]);
  const selector = new llm.LlmOptionSelector({
    provider: input.provider,
    timeoutMs: SELECTOR_TIMEOUT_MS,
  });
  return new brain.StrategicCommanderBrain(
    new caller.StrategicCommanderCaller(selector, SELECTOR_TIMEOUT_MS),
    new rule.RuleAgentBrain(input.profile),
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const url = requiredEnv("COWORLD_PLAYER_WS_URL");
  const repoRoot = process.env.PROXYWAR_REPO ?? "/app/proxywar";
  const runtime = commanderRuntimeEnvironment();
  const provider = new CommanderBedrockProvider(
    runtime.region,
    runtime.endpoint,
  );
  const brain = await createProductionCommanderBrain({
    repoRoot,
    provider,
    profile: runtime.profile,
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

  socket.on("open", () => {
    console.log(
      `commander connected (model=${MODEL}, profile=${runtime.profile})`,
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
    } catch (error) {
      console.error(
        `commander dropped an invalid frame: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (message.type === "final") {
      sawFinal = true;
      void decisionChain.finally(() => socket.close());
      return;
    }
    if (message.type !== "decision_request") return;

    decisionChain = decisionChain.then(async () => {
      const requestID = String(message.requestID ?? "");
      try {
        const input: AgentBrainInput = requestToBrainInput(
          message.request,
          runtime.profile,
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
          } catch (error) {
            console.error(
              `commander treaty guard skipped: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          decision = await brain.decide({
            ...input,
            legalActions: compliantActions,
          });
        }
        socket.send(
          JSON.stringify(
            decisionToResponse(
              requestID,
              decision,
              wireMaxActionsPerDecision(message),
              wireMaxSpawnPreferences(message),
            ),
          ),
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`commander decision failed: ${reason}`);
        socket.send(
          JSON.stringify(
            transportFallbackResponse(requestID, message.request, reason),
          ),
        );
      }
    });
  });
  socket.on("close", () => process.exit(sawFinal ? 0 : 1));
  socket.on("error", (error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
