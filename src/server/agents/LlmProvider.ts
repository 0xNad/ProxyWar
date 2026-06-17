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
  complete(prompt: string): Promise<string>;
}
