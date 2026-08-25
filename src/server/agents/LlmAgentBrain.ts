import { withDeferredDecisionTimeout } from "./AgentDecisionTimeout";
import { OpponentModelLedger } from "./AgentPlannerExecutor";
import {
  AgentBrain,
  AgentBrainDecision,
  AgentBrainInput,
  AgentBrainType,
  AgentDecision,
  AgentPrimaryActionValidationPolicy,
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
  // Theory-of-mind perception: the action-selector has no planner, so it owns its own
  // per-rival belief ledger and folds each tick into observation.opponentModel before the
  // prompt is built. Without this the LLM-first agent sees no opponent model at all.
  private readonly opponentModelLedger = new OpponentModelLedger();

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

  primaryActionValidationPolicy(
    input: AgentBrainInput,
  ): AgentPrimaryActionValidationPolicy {
    return this.promptBuilder.primaryActionValidationPolicy({
      ...input,
      personality: this.options.personality,
    });
  }

  decide(input: AgentBrainInput): AgentBrainDecision {
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
          // No provider invocation occurs on this branch.
          externalActionCall: false,
          rawProviderOutputPresent: false,
          llmParseOk: false,
          llmParseFailureReason: "no legal actions offered",
          fallbackUsed: true,
        },
      };
    }

    let prompt: string;
    try {
      // Populate theory-of-mind perception before building the prompt.
      input.observation.opponentModel = this.opponentModelLedger.update(input);
      prompt = this.promptBuilder.build({
        observation: input.observation,
        legalActions: input.legalActions,
        personality: this.options.personality,
      });
    } catch (error) {
      return Promise.reject(error);
    }

    let providerPromise: Promise<string>;
    try {
      providerPromise = Promise.resolve(this.options.provider.complete(prompt));
    } catch (error) {
      providerPromise = Promise.reject(error);
    }
    const providerTimeoutMs = this.options.providerTimeoutMs ?? 15_000;
    const timedProvider = withDeferredDecisionTimeout(
      providerPromise,
      providerTimeoutMs,
      () => new Error(`LLM provider timed out after ${providerTimeoutMs}ms`),
    );
    return this.decideFromProvider(input, prompt, timedProvider.promise);
  }

  private async decideFromProvider(
    input: AgentBrainInput,
    prompt: string,
    providerPromise: Promise<string>,
  ): Promise<AgentDecision> {
    let rawOutput: string;
    try {
      rawOutput = await providerPromise;
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
        // Optional action batch (parser-normalized: scalar-first, deduped,
        // capped); absent for single-action replies.
        ...(parsed.selectedLegalActionIds !== undefined
          ? { actionIDs: parsed.selectedLegalActionIds }
          : {}),
        // Spawn preferences are allocation input for one eventual spawn,
        // never an executable action batch.
        ...(parsed.spawnPreferenceLegalActionIds !== undefined
          ? {
              spawnPreferenceActionIDs: parsed.spawnPreferenceLegalActionIds,
            }
          : {}),
        // Optional diplomacy slot, forwarded for parity with the external
        // brains. The parser only returns it while the structured-deal flag
        // is on; the runner's validator remains the sole authority over it.
        ...(parsed.selectedDealActionId !== undefined
          ? { dealActionID: parsed.selectedDealActionId }
          : {}),
        // Comms slot (flag-gated at the parser): forwarded as a PAIR or not
        // at all, so the id can never reach the validator without the body it
        // must be judged with. Without this pass-through the in-house lane
        // silently dropped what the parser had just accepted — found during
        // the 2026-08-16 free-text UI demo; AgentLeagueMatch reads
        // decision.messageActionID.
        ...(parsed.selectedMessageActionId !== undefined &&
        parsed.messageText !== undefined
          ? {
              messageActionID: parsed.selectedMessageActionId,
              messageText: parsed.messageText,
            }
          : {}),
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
          ...(providerIsExternal(this.options.provider)
            ? {
                providerEvidenceSource: "trusted-in-process",
                providerCallKind: "action",
              }
            : {}),
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

  /**
   * 2026-08-01 P0 fix (see `docs/project-state/known-problems.md`): this path
   * used to fold the provider/parse failure text into `AgentDecision.reason`
   * — `reason: "LLM decision rejected (${parsed.reason}); fallback:
   * ${fallbackDecision.reason}"` — the SAME field a genuine stated reason
   * uses, with no distinction recorded at write time. A downstream
   * sanitizer (`AgentDecisiveMoments.sanitizeStatedReason`) now filters raw
   * error text at output time, but that is a defense, not the fix; the
   * record itself was wrong. The LLM brain produced no stated reason here —
   * either the provider call failed or its response didn't parse — so
   * `reason` is `null` (see `AgentDecision.reason`'s doc). The failure text
   * (`parsed.reason`) already has a distinct home in
   * `metadata.llmParseFailureReason`; the substituted fallback brain's own
   * genuine reason (not an error — a real rule-brain rationale) gets its
   * own distinct field, `metadata.fallbackReason`, alongside the existing
   * `fallbackUsed`/`fallbackActionID` degradation flags, rather than being
   * discarded or re-mixed into `reason`.
   */
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
      // Preserve the rule/custom fallback's spawn ballot. It remains input to
      // one allocation, never an executable batch; dropping it would turn a
      // deliberately ranked fallback into an unrelated legacy scalar reply.
      ...(fallbackDecision.spawnPreferenceActionIDs !== undefined
        ? {
            spawnPreferenceActionIDs: fallbackDecision.spawnPreferenceActionIDs,
          }
        : {}),
      reason: null,
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
        ...(providerIsExternal(this.options.provider)
          ? {
              providerEvidenceSource: "trusted-in-process",
              providerCallKind: "action",
            }
          : {}),
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
        fallbackReason: fallbackDecision.reason,
      },
    };
  }
}

function providerIsExternal(provider: LlmProvider): boolean {
  return provider.providerType !== "mock";
}
