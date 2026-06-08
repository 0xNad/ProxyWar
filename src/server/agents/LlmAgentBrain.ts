import {
  AgentBrain,
  AgentBrainInput,
  AgentBrainType,
  AgentDecision,
  AgentRuntimeMode,
  AgentStrategyProfile,
} from "./AgentTypes";
import { LlmDecisionParser, LlmDecisionParseResult } from "./LlmDecisionParser";
import { LlmPromptBuilder } from "./LlmPromptBuilder";
import { LlmProvider } from "./LlmProvider";
import { RuleAgentBrain } from "./RuleAgentBrain";

export interface LlmAgentBrainOptions {
  provider: LlmProvider;
  promptBuilder?: LlmPromptBuilder;
  parser?: LlmDecisionParser;
  fallbackBrain?: AgentBrain;
  profile?: AgentStrategyProfile;
  personality?: string;
  brainType?: AgentBrainType;
  runtimeMode?: AgentRuntimeMode;
  providerTimeoutMs?: number;
  includePromptInMetadata?: boolean;
}

export class LlmAgentBrain implements AgentBrain {
  readonly brainType: AgentBrainType;
  private readonly promptBuilder: LlmPromptBuilder;
  private readonly parser: LlmDecisionParser;

  constructor(private readonly options: LlmAgentBrainOptions) {
    this.brainType =
      options.brainType ??
      (options.provider.providerType === "mock"
        ? "mock-llm"
        : options.provider.providerType === "codex-cli"
          ? "codex-cli"
          : "real-llm");
    this.promptBuilder = options.promptBuilder ?? new LlmPromptBuilder();
    // Robust parsing for the in-house agentic LLM (extract the decision from prose /
    // code fences / extra reasoning fields). External agents keep the strict default.
    this.parser = options.parser ?? new LlmDecisionParser({ strict: false });
  }

  async decide(input: AgentBrainInput): Promise<AgentDecision> {
    if (input.legalActions.length === 0) {
      return {
        actionID: "hold",
        reason: "No legal actions were offered; requested safe hold fallback.",
        metadata: {
          brain: "llm",
          brainType: this.brainType,
          runtimeMode: this.options.runtimeMode ?? "llm-action-selector",
          plannerSource: "none",
          executorSource: "llm-action-selector",
          actionSelectionSource: "llm-action-selector",
          externalPlannerCall: false,
          externalActionCall: providerIsExternal(this.options.provider),
          rawProviderOutputPresent: false,
          llmParseOk: false,
          llmParseFailureReason: "no legal actions offered",
          fallbackUsed: true,
        },
      };
    }

    const prompt = this.promptBuilder.build({
      observation: input.observation,
      legalActions: input.legalActions,
      personality: this.options.personality,
    });

    let rawOutput: string;
    try {
      rawOutput = await withTimeout(
        this.options.provider.complete(prompt),
        this.options.providerTimeoutMs ?? 15_000,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.fallback(input, prompt, "", {
        ok: false,
        reason: `LLM provider failed: ${reason}`,
        raw: "",
      });
    }

    const parsed = this.parser.parse(rawOutput, input.legalActions);
    if (parsed.ok) {
      return {
        actionID: parsed.selectedLegalActionId,
        reason: parsed.reason,
        metadata: {
          brain: "llm",
          brainType: this.brainType,
          runtimeMode: this.options.runtimeMode ?? "llm-action-selector",
          plannerSource: "none",
          executorSource: "llm-action-selector",
          actionSelectionSource: "llm-action-selector",
          externalPlannerCall: false,
          externalActionCall: providerIsExternal(this.options.provider),
          rawProviderOutputPresent:
            providerIsExternal(this.options.provider) &&
            rawOutput.trim().length > 0,
          promptLength: prompt.length,
          ...(this.options.includePromptInMetadata
            ? { llmPrompt: prompt }
            : {}),
          llmRawOutput: rawOutput,
          llmParseOk: true,
          llmConfidence: parsed.confidence ?? null,
          fallbackUsed: false,
        },
      };
    }

    return this.fallback(input, prompt, rawOutput, parsed);
  }

  private async fallback(
    input: AgentBrainInput,
    prompt: string,
    rawOutput: string,
    parsed: Extract<LlmDecisionParseResult, { ok: false }>,
  ): Promise<AgentDecision> {
    const fallbackBrain =
      this.options.fallbackBrain ??
      new RuleAgentBrain(this.options.profile ?? input.observation.profile);
    const fallbackDecision = await fallbackBrain.decide(input);
    return {
      actionID: fallbackDecision.actionID,
      reason: `LLM decision rejected (${parsed.reason}); fallback: ${fallbackDecision.reason}`,
      metadata: {
        ...fallbackDecision.metadata,
        brain: "llm",
        brainType: this.brainType,
        runtimeMode: this.options.runtimeMode ?? "llm-action-selector",
        plannerSource: "none",
        executorSource: "llm-action-selector",
        actionSelectionSource: "llm-action-selector",
        externalPlannerCall: false,
        externalActionCall: providerIsExternal(this.options.provider),
        rawProviderOutputPresent:
          providerIsExternal(this.options.provider) &&
          rawOutput.trim().length > 0,
        promptLength: prompt.length,
        ...(this.options.includePromptInMetadata ? { llmPrompt: prompt } : {}),
        llmRawOutput: rawOutput,
        llmParseOk: false,
        llmParseFailureReason: parsed.reason,
        fallbackUsed: true,
        fallbackActionID: fallbackDecision.actionID,
      },
    };
  }
}

function providerIsExternal(provider: LlmProvider): boolean {
  return provider.providerType !== "mock";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeoutID: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutID = setTimeout(() => {
          reject(new Error(`LLM provider timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutID !== undefined) {
      clearTimeout(timeoutID);
    }
  }
}
