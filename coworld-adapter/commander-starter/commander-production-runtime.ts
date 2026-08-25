import type {
  AgentBrain,
  AgentDecision,
  AgentStrategyProfile,
} from "../../src/server/agents/AgentTypes";
import type {
  LlmCompletionOptions,
  LlmProvider,
} from "../../src/server/agents/LlmProvider";
import type { CoworldProviderEvidence } from "../src/coworld-decision-wire";

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

export interface CommanderProviderEvidence extends CoworldProviderEvidence {
  provider: "bedrock-sidecar";
  callKind: "planner";
  requestedModel: typeof PRODUCTION_COMMANDER_MODEL;
  attemptedModels: Array<typeof PRODUCTION_COMMANDER_MODEL>;
}

type CommanderProviderAttempt = {
  sequence: number;
  status: "in-flight" | "completed" | "failed" | "timed-out";
  responseModel?: string;
  requestID?: string;
  inputTokens?: number;
  outputTokens?: number;
  rawOutputPresent: boolean;
};

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
  private providerCallSequence = 0;
  private readonly providerAttempts: CommanderProviderAttempt[] = [];

  constructor(
    private readonly region: string,
    private readonly endpoint: string,
  ) {}

  async complete(
    prompt: string,
    options: LlmCompletionOptions = {},
  ): Promise<string> {
    const client = await this.bedrockClient();
    const attempt = this.beginProviderAttempt();
    let response: BedrockResponse;
    try {
      response = await client.messages.create(commanderBedrockRequest(prompt), {
        timeout: PRODUCTION_COMMANDER_SELECTOR_TIMEOUT_MS,
        signal: options.signal,
      });
    } catch (error) {
      attempt.status = isCommanderProviderTimeoutError(error)
        ? "timed-out"
        : "failed";
      throw error;
    }

    // A returned SDK response is a completed provider attempt even when later
    // parsing, validation, or Commander response handling fails. Record its
    // bounded identity/usage before touching the response body so an outer
    // transport fallback cannot erase a real provider call.
    Object.assign(attempt, boundedCommanderResponseEvidence(response), {
      status: "completed" as const,
      rawOutputPresent: commanderResponseHasRawOutput(response),
    });
    const output = (response.content ?? [])
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join("")
      .trim();
    if (output.length === 0) {
      throw new Error("Commander Bedrock response was empty");
    }
    return output;
  }

  evidenceCursor(): number {
    return this.providerCallSequence;
  }

  providerEvidenceAfter(cursor: number): CommanderProviderEvidence | undefined {
    const terminalAttempts = this.providerAttempts.filter(
      (attempt) => attempt.sequence > cursor && attempt.status !== "in-flight",
    );
    if (terminalAttempts.length === 0) return undefined;
    return commanderProviderEvidenceFromAttempts(terminalAttempts);
  }

  private beginProviderAttempt(): CommanderProviderAttempt {
    this.providerCallSequence += 1;
    const attempt: CommanderProviderAttempt = {
      sequence: this.providerCallSequence,
      status: "in-flight",
      rawOutputPresent: false,
    };
    this.providerAttempts.push(attempt);
    // One Commander decision currently makes at most one provider call. Keep a
    // bounded eight-attempt history so a future bounded retry loop can still
    // produce the exact aggregate accepted by the Coworld wire contract.
    if (this.providerAttempts.length > 8) this.providerAttempts.shift();
    return attempt;
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
      // Evidence counts actual provider attempts. Disable opaque SDK retries so
      // one recorded attempt cannot conceal multiple billed HTTP invocations.
      maxRetries: 0,
    });
    return this.client;
  }
}

export function commanderProviderEvidenceFromResponse(
  response: BedrockResponse,
): CommanderProviderEvidence {
  const responseEvidence = boundedCommanderResponseEvidence(response);
  return {
    provider: "bedrock-sidecar",
    callKind: "planner",
    requestedModel: PRODUCTION_COMMANDER_MODEL,
    attemptedModels: [PRODUCTION_COMMANDER_MODEL],
    attemptCount: 1,
    completedAttemptCount: 1,
    failedAttemptCount: 0,
    timedOutAttemptCount: 0,
    ...responseEvidence,
    rawOutputPresent: commanderResponseHasRawOutput(response),
  };
}

function commanderProviderEvidenceFromAttempts(
  attempts: CommanderProviderAttempt[],
): CommanderProviderEvidence {
  const completedAttempts = attempts.filter(
    (attempt) => attempt.status === "completed",
  );
  const latestCompleted = completedAttempts.at(-1);
  const inputTokens = boundedTokenTotal(
    completedAttempts.map((attempt) => attempt.inputTokens),
  );
  const outputTokens = boundedTokenTotal(
    completedAttempts.map((attempt) => attempt.outputTokens),
  );
  return {
    provider: "bedrock-sidecar",
    callKind: "planner",
    requestedModel: PRODUCTION_COMMANDER_MODEL,
    attemptedModels: attempts.map(() => PRODUCTION_COMMANDER_MODEL),
    attemptCount: attempts.length,
    completedAttemptCount: completedAttempts.length,
    failedAttemptCount: attempts.filter(
      (attempt) => attempt.status === "failed",
    ).length,
    timedOutAttemptCount: attempts.filter(
      (attempt) => attempt.status === "timed-out",
    ).length,
    ...(latestCompleted?.responseModel === undefined
      ? {}
      : { responseModel: latestCompleted.responseModel }),
    ...(completedAttempts.length === 1 &&
    latestCompleted?.requestID !== undefined
      ? { requestID: latestCompleted.requestID }
      : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    rawOutputPresent: completedAttempts.some(
      (attempt) => attempt.rawOutputPresent,
    ),
  };
}

function boundedCommanderResponseEvidence(
  response: BedrockResponse,
): Pick<
  CommanderProviderEvidence,
  "responseModel" | "requestID" | "inputTokens" | "outputTokens"
> {
  const responseModel = boundedEvidenceString(response.model, 160);
  const requestID = boundedEvidenceString(response.id, 160);
  const inputTokens = boundedTokenCount(response.usage?.input_tokens);
  const outputTokens = boundedTokenCount(response.usage?.output_tokens);
  return {
    ...(responseModel === undefined ? {} : { responseModel }),
    ...(requestID === undefined ? {} : { requestID }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function commanderResponseHasRawOutput(response: BedrockResponse): boolean {
  return (
    Array.isArray(response.content) &&
    response.content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        typeof block.text === "string" &&
        block.text.length > 0,
    )
  );
}

export function isCommanderProviderTimeoutError(error: unknown): boolean {
  const candidate = error as
    | { name?: unknown; code?: unknown; message?: unknown }
    | undefined;
  const name = String(candidate?.name ?? "").toUpperCase();
  const code = String(candidate?.code ?? "").toUpperCase();
  const message = String(candidate?.message ?? error);
  return (
    name === "ABORTERROR" ||
    name === "TIMEOUTERROR" ||
    code === "ABORT_ERR" ||
    code === "ETIMEDOUT" ||
    /timed?\s*out|timeout/i.test(message)
  );
}

function boundedEvidenceString(
  value: unknown,
  maxLength: number,
): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9._:/-]+$/.test(value)
    ? value
    : undefined;
}

function boundedTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= 1_000_000_000
    ? Number(value)
    : undefined;
}

function boundedTokenTotal(
  values: Array<number | undefined>,
): number | undefined {
  const observed = values.filter(
    (value): value is number => value !== undefined,
  );
  if (observed.length === 0) return undefined;
  const total = observed.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) && total <= 1_000_000_000
    ? total
    : undefined;
}

export function withCommanderProviderEvidence(
  response: Record<string, unknown>,
  _decision: AgentDecision,
  evidence: CommanderProviderEvidence | undefined,
): Record<string, unknown> {
  return evidence !== undefined
    ? { ...response, providerEvidence: evidence }
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
