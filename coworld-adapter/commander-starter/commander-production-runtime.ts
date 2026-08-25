import type {
  AgentBrain,
  AgentDecision,
  AgentStrategyProfile,
} from "../../src/server/agents/AgentTypes";
import type {
  LlmCompletionOptions,
  LlmProvider,
} from "../../src/server/agents/LlmProvider";

export const PRODUCTION_COMMANDER_MODEL =
  "us.anthropic.claude-sonnet-4-6" as const;
export const PRODUCTION_COMMANDER_MAX_TOKENS = 1_024 as const;

/**
 * Coworld league episodes are asynchronous hosted jobs. Their gameplay
 * variants give policies a 60-second response window, so the Commander may
 * spend up to 55 seconds on inference while retaining five seconds for
 * parsing, deterministic fallback, validation, serialization, and transport.
 */
export const PRODUCTION_COMMANDER_SELECTOR_TIMEOUT_MS = 55_000;
export const PRODUCTION_COMMANDER_DECISION_BUDGET_MS = 60_000;

interface BedrockResponse {
  id?: unknown;
  model?: unknown;
  content?: Array<{ text?: unknown }>;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
}

export interface CommanderProviderEvidence {
  provider: "bedrock-sidecar";
  requestedModel: typeof PRODUCTION_COMMANDER_MODEL;
  responseModel?: string;
  requestID?: string;
  inputTokens?: number;
  outputTokens?: number;
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
  model: typeof PRODUCTION_COMMANDER_MODEL;
  max_tokens: typeof PRODUCTION_COMMANDER_MAX_TOKENS;
  messages: Array<{ role: "user"; content: string }>;
} {
  return {
    model: PRODUCTION_COMMANDER_MODEL,
    max_tokens: PRODUCTION_COMMANDER_MAX_TOKENS,
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
  profile: AgentStrategyProfile = "aggressive",
): {
  profile: AgentStrategyProfile;
  region: string;
  endpoint: string;
} {
  if (
    env.USE_BEDROCK !== "true" ||
    env.BEDROCK_MODEL !== PRODUCTION_COMMANDER_MODEL
  ) {
    throw new Error("Commander requires the exact Coworld Bedrock model");
  }
  const region = env.AWS_REGION?.trim();
  if (!region) throw new Error("Commander Bedrock region is missing");
  return {
    profile,
    region,
    endpoint: commanderBedrockSidecarEndpoint(env),
  };
}

export class CommanderBedrockProvider implements LlmProvider {
  readonly providerType = "custom" as const;
  readonly cancellationBehavior = "settles-after-abort" as const;
  readonly model = PRODUCTION_COMMANDER_MODEL;
  private client: BedrockClient | null = null;
  private successfulResponseSequence = 0;
  private lastSuccessfulEvidence:
    | { sequence: number; evidence: CommanderProviderEvidence }
    | undefined;

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
        timeout: PRODUCTION_COMMANDER_SELECTOR_TIMEOUT_MS,
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
    this.successfulResponseSequence += 1;
    this.lastSuccessfulEvidence = {
      sequence: this.successfulResponseSequence,
      evidence: commanderProviderEvidenceFromResponse(response),
    };
    return output;
  }

  evidenceCursor(): number {
    return this.successfulResponseSequence;
  }

  providerEvidenceAfter(cursor: number): CommanderProviderEvidence | undefined {
    const latest = this.lastSuccessfulEvidence;
    return latest !== undefined && latest.sequence > cursor
      ? { ...latest.evidence }
      : undefined;
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

export function commanderProviderEvidenceFromResponse(
  response: BedrockResponse,
): CommanderProviderEvidence {
  const responseModel = boundedEvidenceString(response.model, 200);
  const requestID = boundedEvidenceString(response.id, 200);
  const inputTokens = boundedTokenCount(response.usage?.input_tokens);
  const outputTokens = boundedTokenCount(response.usage?.output_tokens);
  return {
    provider: "bedrock-sidecar",
    requestedModel: PRODUCTION_COMMANDER_MODEL,
    ...(responseModel === undefined ? {} : { responseModel }),
    ...(requestID === undefined ? {} : { requestID }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function boundedEvidenceString(
  value: unknown,
  maxLength: number,
): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[\x20-\x7e]+$/.test(value)
    ? value
    : undefined;
}

function boundedTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

export function withCommanderProviderEvidence(
  response: Record<string, unknown>,
  decision: AgentDecision,
  evidence: CommanderProviderEvidence | undefined,
): Record<string, unknown> {
  return decision.metadata?.llmPlannerDegraded !== true &&
    evidence !== undefined
    ? { providerEvidence: evidence, ...response }
    : response;
}

export async function createProductionCommanderBrain(input: {
  repoRoot: string;
  provider: LlmProvider;
  profile: AgentStrategyProfile;
}): Promise<AgentBrain> {
  const path = await import("node:path");
  const { pathToFileURL } = await import("node:url");
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
    timeoutMs: PRODUCTION_COMMANDER_SELECTOR_TIMEOUT_MS,
  });
  return new brain.StrategicCommanderBrain(
    new caller.StrategicCommanderCaller(
      selector,
      PRODUCTION_COMMANDER_SELECTOR_TIMEOUT_MS,
    ),
    new rule.RuleAgentBrain(input.profile),
  );
}
