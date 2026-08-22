export type LlmProviderType =
  | "mock"
  | "openai"
  | "openrouter"
  | "codex-cli"
  | "claude-cli"
  | "custom";

export class LlmProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmProviderConfigError";
  }
}

export interface LlmCompletionOptions {
  /**
   * Cancellation belongs at the provider boundary. Callers that stop waiting
   * must abort the underlying transport instead of leaving model work queued or
   * running behind a released decision slot.
   */
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly providerType?: LlmProviderType;
  /**
   * Declares that aborting the supplied signal makes complete() settle only
   * after its underlying transport has stopped. Selectors use this narrowly
   * to await cleanup without letting a non-cooperative provider defeat the
   * selector's own deadline.
   */
  readonly cancellationBehavior?: "settles-after-abort";
  /**
   * Exact configured model identity used by this provider instance. Null means
   * the provider delegates model choice to an external default, which is not
   * sufficient provenance for a matched performance claim.
   */
  readonly model?: string | null;
  complete(prompt: string, options?: LlmCompletionOptions): Promise<string>;
}
