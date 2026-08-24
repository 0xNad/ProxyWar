import { createHash } from "node:crypto";

import { withDeferredDecisionTimeout } from "./AgentDecisionTimeout";
import { buildCommanderPrompt } from "./CommanderPromptBuilder";
import { parseCommanderResponse } from "./CommanderResponseParser";
import type { LlmProvider } from "./LlmProvider";
import type {
  CommanderState,
  ExposedStrategicOption,
} from "./StrategicCommanderTypes";
import type {
  StrategicOptionSelectionAttempt,
  StrategicOptionSelectionFailureKind,
  StrategicOptionSelector,
  StrategicOptionSelectorTelemetry,
} from "./StrategicOptionSelectors";
import { strategicOptionSelectionFailureDescriptions } from "./StrategicOptionSelectors";

import { COMMANDER_COWORLD_PROMPT_VERSION } from "./CommanderCoworldRuntime";

export const COMMANDER_PROMPT_VERSION = COMMANDER_COWORLD_PROMPT_VERSION;
export const DEFAULT_LLM_OPTION_SELECTOR_TIMEOUT_MS = 12_000;

export interface LlmOptionSelectorOptions {
  provider: LlmProvider;
  timeoutMs?: number;
}

/**
 * Arm C's complete provider boundary. It receives only the Stage 2 state and
 * exposed options from the typed selector seam. It has no deterministic
 * selector dependency, so Arm B's answer can never enter the prompt.
 */
export class LlmOptionSelector implements StrategicOptionSelector {
  readonly selectorSource = "llm" as const;
  readonly timeoutMs: number;
  private readonly providerLabel: string;
  private readonly modelLabel: string | null;

  constructor(private readonly options: LlmOptionSelectorOptions) {
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_LLM_OPTION_SELECTOR_TIMEOUT_MS;
    this.providerLabel = options.provider.providerType ?? "custom";
    const trimmedModelLabel = options.provider.model?.trim();
    this.modelLabel =
      trimmedModelLabel === undefined || trimmedModelLabel === ""
        ? null
        : trimmedModelLabel;
  }

  async select(
    state: CommanderState,
    options: readonly ExposedStrategicOption[],
  ): Promise<StrategicOptionSelectionAttempt> {
    assertExactLockedSurface(state, options);
    const prompt = buildCommanderPrompt(state);
    const promptSha256 = createHash("sha256").update(prompt).digest("hex");
    const startedAt = Date.now();
    const controller = new AbortController();
    const providerPromise = Promise.resolve().then(() =>
      this.options.provider.complete(prompt, {
        signal: controller.signal,
      }),
    );
    let raw: string;
    try {
      raw = await withDeferredDecisionTimeout(
        providerPromise,
        this.timeoutMs,
        () =>
          new Error(`Commander provider timed out after ${this.timeoutMs}ms`),
        () => controller.abort(),
      ).promise;
    } catch (error) {
      // A selector timeout must not return a fallback while a provider is still
      // tearing down behind its process-wide lock. The Claude transport
      // resolves/rejects only after its killed subprocess closes, so awaiting
      // the original request here prevents one slow call from cascading into
      // queued selector timeouts in later decisions.
      if (
        controller.signal.aborted &&
        this.options.provider.cancellationBehavior === "settles-after-abort"
      ) {
        await providerPromise.catch(() => undefined);
      }
      const failureKind =
        error instanceof Error && /timed out/i.test(error.message)
          ? "timeout"
          : "transport";
      return failureAttempt(
        failureKind,
        strategicOptionSelectionFailureDescriptions[failureKind],
        telemetry({
          promptCharacters: prompt.length,
          planningLatencyMs: elapsed(startedAt),
          rawOutputPresent: false,
          parseOk: false,
          provider: this.providerLabel,
          model: this.modelLabel,
          promptSha256,
        }),
      );
    }

    const parsed = parseCommanderResponse(
      raw,
      options.map((option) => option.id),
    );
    if (!parsed.ok) {
      const failureKind: StrategicOptionSelectionFailureKind =
        /locked option set/.test(parsed.reason) ? "invalid-option" : "parse";
      return failureAttempt(
        failureKind,
        strategicOptionSelectionFailureDescriptions[failureKind],
        telemetry({
          promptCharacters: prompt.length,
          planningLatencyMs: elapsed(startedAt),
          rawOutputPresent: raw.length > 0,
          parseOk: false,
          provider: this.providerLabel,
          model: this.modelLabel,
          promptSha256,
        }),
      );
    }

    return {
      ok: true,
      selection: {
        selectedStrategicOptionId: parsed.selectedStrategicOptionId,
        horizonDecisions: parsed.horizonDecisions,
        intent: parsed.intent,
        replanTriggers: parsed.replanTriggers,
      },
      telemetry: telemetry({
        promptCharacters: prompt.length,
        planningLatencyMs: elapsed(startedAt),
        rawOutputPresent: raw.length > 0,
        parseOk: true,
        provider: this.providerLabel,
        model: this.modelLabel,
        promptSha256,
      }),
    };
  }
}

function assertExactLockedSurface(
  state: CommanderState,
  options: readonly ExposedStrategicOption[],
): void {
  if (options !== state.options) {
    throw new Error(
      "LLM selector requires the exact locked state option surface",
    );
  }
}

function failureAttempt(
  failureKind: StrategicOptionSelectionFailureKind,
  failureDetail: string,
  base: StrategicOptionSelectorTelemetry,
): StrategicOptionSelectionAttempt {
  return {
    ok: false,
    selection: null,
    telemetry: { ...base, failureKind, failureDetail },
  };
}

function telemetry(input: {
  promptCharacters: number;
  planningLatencyMs: number;
  rawOutputPresent: boolean;
  parseOk: boolean;
  provider: string;
  model: string | null;
  promptSha256: string;
}): StrategicOptionSelectorTelemetry {
  return {
    providerCalled: true,
    promptCharacters: input.promptCharacters,
    planningLatencyMs: input.planningLatencyMs,
    rawOutputPresent: input.rawOutputPresent,
    parseOk: input.parseOk,
    failureKind: null,
    failureDetail: null,
    provider: input.provider,
    model: input.model,
    promptVersion: COMMANDER_PROMPT_VERSION,
    promptSha256: input.promptSha256,
  };
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}
