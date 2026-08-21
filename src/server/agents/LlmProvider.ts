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

export interface LlmProvider {
  readonly providerType?: LlmProviderType;
  /**
   * Exact configured model identity used by this provider instance. Null means
   * the provider delegates model choice to an external default, which is not
   * sufficient provenance for a matched performance claim.
   */
  readonly model?: string | null;
  complete(prompt: string): Promise<string>;
}
