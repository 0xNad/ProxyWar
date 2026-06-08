import { AgentObjectiveKind, LegalActionKind } from "./AgentTypes";
import { LlmProvider } from "./LlmProvider";

export type MockLlmProviderMode =
  | "valid"
  | "attack"
  | "build"
  | "support"
  | "non_hold"
  | "spawn_then_hold"
  | "unknown"
  | "malformed"
  | "fenced"
  | "empty"
  | "invalid_confidence";

export interface MockLlmProviderOptions {
  mode: MockLlmProviderMode;
  selectedLegalActionId?: string;
  preferKind?: LegalActionKind;
  reason?: string;
  confidence?: number;
}

interface PromptLegalAction {
  id: string;
  kind: LegalActionKind;
  metadata?: Record<string, string | number | boolean | null>;
}

interface PromptStrategicSkillScore {
  id: string;
  kind: LegalActionKind;
  totalScore: number;
  penalties?: string[];
}

export class MockLlmProvider implements LlmProvider {
  readonly providerType = "mock";
  readonly prompts: string[] = [];
  readonly responses: string[] = [];

  constructor(private readonly options: MockLlmProviderOptions) {}

  async complete(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    const response = this.responseFor(prompt);
    this.responses.push(response);
    return response;
  }

  private responseFor(prompt: string): string {
    switch (this.options.mode) {
      case "valid":
        return JSON.stringify(this.validDecision(prompt));
      case "attack":
        return JSON.stringify(this.validDecision(prompt, "attack"));
      case "build":
        return JSON.stringify(this.validDecision(prompt, "build"));
      case "support":
        return JSON.stringify({
          ...this.validDecision(prompt),
          selectedLegalActionId: this.supportLegalActionId(prompt),
        });
      case "non_hold":
        return JSON.stringify({
          ...this.validDecision(prompt),
          selectedLegalActionId: this.nonHoldLegalActionId(prompt),
        });
      case "spawn_then_hold":
        return JSON.stringify({
          ...this.validDecision(prompt),
          selectedLegalActionId: this.spawnThenHoldLegalActionId(prompt),
        });
      case "fenced":
        return `\`\`\`json\n${JSON.stringify(this.validDecision(prompt))}\n\`\`\``;
      case "unknown":
        return JSON.stringify({
          selectedLegalActionId: "unknown-legal-action",
          reason: "Testing unknown action handling.",
          confidence: 0.4,
        });
      case "malformed":
        return '{"selectedLegalActionId":';
      case "empty":
        return "";
      case "invalid_confidence":
        return JSON.stringify({
          ...this.validDecision(prompt),
          confidence: "very sure",
        });
    }
  }

  private validDecision(prompt: string, preferKind?: LegalActionKind) {
    return {
      selectedLegalActionId: this.selectedLegalActionId(prompt, preferKind),
      reason:
        this.options.reason ?? "Selected from the provided legal action list.",
      confidence: this.options.confidence ?? 0.72,
    };
  }

  private selectedLegalActionId(
    prompt: string,
    forcedPreferKind?: LegalActionKind,
  ): string {
    if (this.options.selectedLegalActionId !== undefined) {
      return this.options.selectedLegalActionId;
    }

    const actions = legalActionsFromPrompt(prompt);
    const preferKind = forcedPreferKind ?? this.options.preferKind;
    const preferred = preferKind
      ? actions.find((action) => action.kind === preferKind)
      : undefined;
    return (
      preferred?.id ??
      this.rankedCandidateLegalActionId(prompt, actions) ??
      this.objectiveLegalActionId(prompt, actions) ??
      this.nonHoldLegalActionId(prompt)
    );
  }

  private rankedCandidateLegalActionId(
    prompt: string,
    actions: PromptLegalAction[],
  ): string | null {
    const scores = rankedCandidatesFromPrompt(prompt);
    if (scores.length === 0) {
      return null;
    }
    const actionIDs = new Set(actions.map((action) => action.id));
    const ranked = scores
      .filter((score) => actionIDs.has(score.id))
      .sort((a, b) => b.totalScore - a.totalScore || a.id.localeCompare(b.id));
    return ranked.find((score) => score.kind !== "hold")?.id ?? ranked[0]?.id ?? null;
  }

  private objectiveLegalActionId(
    prompt: string,
    actions: PromptLegalAction[],
  ): string | null {
    const objective = objectiveKindFromPrompt(prompt);
    if (objective === null) {
      return null;
    }
    return (
      actions.find((action) => promptActionAlignsObjective(objective, action))
        ?.id ?? null
    );
  }

  private spawnThenHoldLegalActionId(prompt: string): string {
    const actions = legalActionsFromPrompt(prompt);
    return (
      actions.find((action) => action.kind === "spawn")?.id ??
      actions.find((action) => action.kind === "hold")?.id ??
      actions[0]?.id ??
      "hold"
    );
  }

  private supportLegalActionId(prompt: string): string {
    const actions = legalActionsFromPrompt(prompt);
    return (
      actions.find(
        (action) =>
          action.kind === "donate_troops" || action.kind === "donate_gold",
      )?.id ?? this.nonHoldLegalActionId(prompt)
    );
  }

  private nonHoldLegalActionId(prompt: string): string {
    const actions = legalActionsFromPrompt(prompt);
    return actions.find((action) => action.kind !== "hold")?.id ?? "hold";
  }
}

function legalActionsFromPrompt(prompt: string): PromptLegalAction[] {
  const match = prompt.match(
    /LEGAL_ACTIONS_JSON:\s*([\s\S]*?)\s*END_LEGAL_ACTIONS_JSON/,
  );
  if (match === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(match[1] ?? "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (action): action is PromptLegalAction =>
        typeof action?.id === "string" && typeof action?.kind === "string",
    );
  } catch {
    return [];
  }
}

function rankedCandidatesFromPrompt(prompt: string): PromptStrategicSkillScore[] {
  const match = prompt.match(
    /RANKED_CANDIDATES_JSON:\s*([\s\S]*?)\s*END_RANKED_CANDIDATES_JSON/,
  );
  if (match === null) {
    return [];
  }
  try {
    const parsed = JSON.parse(match[1] ?? "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (score): score is PromptStrategicSkillScore =>
        typeof score?.id === "string" &&
        typeof score?.kind === "string" &&
        typeof score?.totalScore === "number" &&
        Number.isFinite(score.totalScore),
    );
  } catch {
    return [];
  }
}

function objectiveKindFromPrompt(prompt: string): AgentObjectiveKind | null {
  const match = prompt.match(
    /OBSERVATION_JSON:\s*([\s\S]*?)\s*END_OBSERVATION_JSON/,
  );
  if (match === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1] ?? "{}");
    const objective = parsed?.objective;
    return isAgentObjectiveKind(objective?.kind) &&
      objective?.status === "active"
      ? objective.kind
      : null;
  } catch {
    return null;
  }
}

function promptActionAlignsObjective(
  objective: AgentObjectiveKind,
  action: PromptLegalAction,
): boolean {
  switch (objective) {
    case "choose_spawn":
      return action.kind === "spawn";
    case "expand_territory":
      return action.kind === "attack" && action.metadata?.expansion === true;
    case "secure_economy":
      return (
        action.kind === "build" &&
        (action.metadata?.role === "economic" ||
          action.metadata?.unit === "City" ||
          action.metadata?.unit === "Factory")
      );
    case "fortify_border":
      return (
        (action.kind === "build" && action.metadata?.role === "defensive") ||
        action.kind === "alliance_request"
      );
    case "pressure_rival":
      return (
        action.kind === "embargo" ||
        (action.kind === "attack" && action.metadata?.expansion !== true)
      );
    case "build_alliance":
      return (
        action.kind === "alliance_request" ||
        action.kind === "donate_gold" ||
        action.kind === "donate_troops"
      );
    case "survive":
      return (
        action.kind === "hold" ||
        (action.kind === "build" && action.metadata?.role === "defensive") ||
        action.kind === "alliance_request"
      );
  }
}

function isAgentObjectiveKind(value: unknown): value is AgentObjectiveKind {
  return (
    value === "choose_spawn" ||
    value === "expand_territory" ||
    value === "secure_economy" ||
    value === "fortify_border" ||
    value === "pressure_rival" ||
    value === "build_alliance" ||
    value === "survive"
  );
}
