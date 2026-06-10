// Proxy War Coworld KEYSTONE policy player.
//
// Runs the in-house Commander–Executor v2 agent (PlannerExecutorAgentBrain with
// binding directives) as a Coworld websocket policy. The decision path is the
// canonical one: the game offers AgentObservation + LegalAction[] over the
// /player websocket and this player only ever answers with one offered
// LegalAction.id — the game side re-validates through AgentDecisionValidator.
// No raw intents, no second validator, no new runner.
//
// In-clock guarantee: the executor answers every decision_request from the
// current Strategic Directive without awaiting any LLM call. Commander (LLM)
// refreshes run in the background between decisions (DeferredAgentPlanner), so
// Coworld's max_decision_ms reject-on-timeout is structurally satisfied.
//
// Known v1 limitation: the Coworld wire protocol carries ONE
// selectedLegalActionId per decision, so executor cascade batches
// (AgentDecision.actionIDs) degrade to their primary action here.
//
// Modes (PROXYWAR_KEYSTONE_MODE; DEFAULT = the LLM Commander — bedrock when
// USE_BEDROCK=true, otherwise claude-cli; "the agent" IS the LLM brain):
//   claude-cli local default — Claude CLI subscription via AI_LEAGUE_CLAUDE_*.
//              Fails loud if the CLI is missing/logged out (no silent rule bot).
//   bedrock    hosted default under --use-bedrock pods (USE_BEDROCK=true) —
//              Claude on Bedrock, inference on Softmax's service account
//              (payer confirmed 2026-06-10).
//   mock       MockLlmPlanner protocol-test plumbing only. Never a seat.
//
// There is deliberately NO deterministic/executor mode. Operator rule
// (2026-06-10, permanent): never run, default to, or suggest a deterministic
// executor as the agent or a seat. LLM failures must be loud (thrown or
// llmPlannerDegraded on the wire), never silently absorbed by a rule bot.
//
// Env (all optional unless noted):
//   COWORLD_PLAYER_WS_URL        required at runtime (set by the platform)
//   PROXYWAR_REPO                repo root inside the pod (default /app/proxywar)
//   PROXYWAR_KEYSTONE_MODE       see above (default: LLM Commander)
//   PROXYWAR_KEYSTONE_PROFILE    strategy profile (default "aggressive")
//   PROXYWAR_KEYSTONE_PLAN_EVERY Commander cadence in decision steps (default 3)
//   PROXYWAR_LLM_MODEL_ID / AWS_REGION / PROXYWAR_LLM_TIMEOUT_MS  bedrock mode

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  AgentBrain,
  AgentBrainInput,
  AgentDecision,
  AgentObservation,
  AgentStrategyProfile,
  LegalAction,
} from "../../src/server/agents/AgentTypes";
import type {
  AgentPlanDecision,
  AgentPlanner,
  StrategicPlan,
} from "../../src/server/agents/AgentPlannerExecutor";
import type { LlmProvider } from "../../src/server/agents/LlmProvider";

type PlannerExecutorModule =
  typeof import("../../src/server/agents/AgentPlannerExecutor");
type ClaudeCliModule =
  typeof import("../../src/server/agents/ClaudeCliLlmProvider");

export interface KeystoneModules {
  plannerExecutor: PlannerExecutorModule;
  claudeCli: ClaudeCliModule;
}

export type KeystoneMode = "mock" | "claude-cli" | "bedrock";

export interface KeystoneBrainOptions {
  mode: KeystoneMode;
  profile: AgentStrategyProfile;
  planEveryDecisionSteps?: number;
  providerTimeoutMs?: number;
  /** Override the LLM provider (tests / future transports). */
  provider?: LlmProvider;
}

// Mirrors the league-smoke planner-claude-cli executor settings so local play
// and the Coworld seat run the same tuned executor.
const KEYSTONE_EXECUTOR_SETTINGS = {
  territoryFirstNeutralLandEnabled: true,
  maxActionsPerDecision: 5,
  siloTileShareRatio: 0.14,
  samTileShareRatio: 0.14,
} as const;

const RESPONSE_REASON_MAX_LENGTH = 500;

export function keystoneModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KeystoneMode {
  const raw = env.PROXYWAR_KEYSTONE_MODE?.trim().toLowerCase() ?? "";
  if (raw === "mock" || raw === "claude-cli" || raw === "bedrock") {
    return raw;
  }
  if (raw !== "") {
    throw new Error(
      `Unknown PROXYWAR_KEYSTONE_MODE "${raw}" (expected mock|claude-cli|bedrock; ` +
        `there is no deterministic mode by design — the agent is the LLM brain)`,
    );
  }
  // Default = the LLM Commander. "The agent" IS the LLM brain (operator
  // standing rule, permanent) — there is no deterministic mode to fall back
  // to. Hosted --use-bedrock pods set USE_BEDROCK=true (inference on
  // Softmax's service account, payer confirmed 2026-06-10); everywhere else
  // the Claude CLI subscription is the default and fails loud if unavailable.
  return env.USE_BEDROCK === "true" ? "bedrock" : "claude-cli";
}

/**
 * Loads the repo agent modules from PROXYWAR_REPO at runtime. The adapter and
 * the repo live in different directories inside the pod (/app/integration vs
 * /app/proxywar), so these imports must stay dynamic; the type-only imports
 * above are erased by tsx and never resolve at runtime.
 */
export async function loadKeystoneModules(
  repoRoot: string,
): Promise<KeystoneModules> {
  const agentsDir = path.join(repoRoot, "src", "server", "agents");
  const plannerExecutor = (await import(
    pathToFileURL(path.join(agentsDir, "AgentPlannerExecutor.ts")).href
  )) as PlannerExecutorModule;
  const claudeCli = (await import(
    pathToFileURL(path.join(agentsDir, "ClaudeCliLlmProvider.ts")).href
  )) as ClaudeCliModule;
  return { plannerExecutor, claudeCli };
}

/**
 * Reconstructs the canonical AgentBrainInput from the wire payload the game
 * built with buildExternalAgentRequestPayload. The observation passes through
 * verbatim; legal actions arrive without their server-side intent (the runner
 * keeps intents — policies never see or emit raw intents), so intent is null
 * here and the brain selects purely by id/kind/risk/metadata.
 */
export function requestToBrainInput(request: unknown): AgentBrainInput {
  const record = request as {
    observation?: AgentObservation;
    legalActions?: Array<{
      id?: unknown;
      kind?: unknown;
      label?: unknown;
      risk?: LegalAction["risk"];
      metadata?: LegalAction["metadata"];
    }>;
  };
  if (record === null || typeof record !== "object" || !record.observation) {
    throw new Error("decision_request payload is missing observation");
  }
  const rawActions = Array.isArray(record.legalActions)
    ? record.legalActions
    : [];
  if (rawActions.length === 0) {
    throw new Error("decision_request payload contained no legalActions");
  }
  const legalActions: LegalAction[] = rawActions.map((action) => ({
    id: String(action.id ?? ""),
    kind: String(action.kind ?? "hold") as LegalAction["kind"],
    label: String(action.label ?? ""),
    intent: null,
    risk: action.risk ?? { level: "medium", score: 0.5 },
    metadata: action.metadata,
  }));
  return { observation: record.observation, legalActions };
}

export function decisionToResponse(
  requestID: string,
  decision: AgentDecision,
): Record<string, unknown> {
  const rawConfidence = decision.metadata?.confidence;
  const confidence =
    typeof rawConfidence === "number" &&
    rawConfidence >= 0 &&
    rawConfidence <= 1
      ? rawConfidence
      : 0.7;
  // Degradation flags travel on the wire so the game-side artifacts can
  // record them — a dead/degraded LLM brain must never look healthy in
  // replays (the hosted proxywar-bedrock seat failed silently for 60+ rounds
  // because the transport had no loudness channel).
  const llmPlannerDegraded = decision.metadata?.llmPlannerDegraded === true;
  const plannerFallbackUsed = decision.metadata?.plannerFallbackUsed === true;
  return {
    type: "decision_response",
    requestID,
    selectedLegalActionId: decision.actionID,
    reason: decision.reason.slice(0, RESPONSE_REASON_MAX_LENGTH),
    confidence,
    ...(llmPlannerDegraded ? { llmPlannerDegraded: true } : {}),
    ...(plannerFallbackUsed ? { fallbackUsed: true } : {}),
  };
}

/**
 * In-clock Commander adapter. plan() never awaits the wrapped LLM planner:
 * it returns the freshest completed background refresh if one landed,
 * otherwise carries the current directive (or a rule bootstrap plan before the
 * first refresh lands) and kicks the real refresh off in the background.
 * LLM failures surface loudly via llmPlannerDegraded on the next plan() —
 * never a silent degrade.
 */
export class DeferredAgentPlanner implements AgentPlanner {
  readonly plannerType: StrategicPlan["plannerSource"];
  private inFlight = false;
  private completed: AgentPlanDecision | null = null;
  private lastKnownPlan: StrategicPlan | null = null;

  constructor(
    private readonly inner: AgentPlanner,
    private readonly bootstrap: AgentPlanner,
  ) {
    this.plannerType = inner.plannerType;
  }

  async plan(
    input: AgentBrainInput,
    previousPlan: StrategicPlan | null,
  ): Promise<AgentPlanDecision> {
    if (this.completed !== null) {
      const landed = this.completed;
      this.completed = null;
      this.lastKnownPlan = landed.plan;
      return landed;
    }
    const carriedPlan = previousPlan ?? this.lastKnownPlan;
    this.startBackgroundRefresh(input, carriedPlan);
    if (carriedPlan !== null) {
      return {
        plan: carriedPlan,
        reason:
          "Commander refresh in flight; executing the standing directive in-clock.",
        latencyMs: 0,
        fallbackUsed: false,
      };
    }
    const bootstrapDecision = await this.bootstrap.plan(input, previousPlan);
    this.lastKnownPlan = bootstrapDecision.plan;
    return {
      ...bootstrapDecision,
      reason: `Bootstrap plan while the first Commander refresh is in flight: ${bootstrapDecision.reason}`,
    };
  }

  private startBackgroundRefresh(
    input: AgentBrainInput,
    carriedPlan: StrategicPlan | null,
  ): void {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    void this.inner
      .plan(input, carriedPlan)
      .then((decision) => {
        this.completed = decision;
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`keystone Commander refresh failed: ${message}`);
        const fallback =
          carriedPlan !== null
            ? null
            : await this.bootstrap.plan(input, null).catch(() => null);
        const plan = carriedPlan ?? fallback?.plan ?? null;
        if (plan !== null) {
          this.completed = {
            plan,
            reason: `Commander refresh failed (${message}); continuing on the standing directive.`,
            latencyMs: 0,
            fallbackUsed: true,
            llmPlannerDegraded: true,
          };
        }
      })
      .finally(() => {
        this.inFlight = false;
      });
  }
}

/**
 * Bedrock model-id candidates, tried in order until one answers. The original
 * single pin (anthropic.claude-3-5-sonnet-20240620-v1:0) reached end-of-life
 * on Bedrock and the hosted seat silently failed every call for 60+ rounds —
 * autodetect makes a retired/disabled id self-healing instead of fatal.
 * PROXYWAR_LLM_MODEL_ID (when set) is always tried first.
 */
export function bedrockModelCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    ...(env.PROXYWAR_LLM_MODEL_ID ? [env.PROXYWAR_LLM_MODEL_ID] : []),
    "us.anthropic.claude-sonnet-4-6",
    "anthropic.claude-sonnet-4-6",
    "us.anthropic.claude-haiku-4-5",
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  ];
}

/**
 * True when the error means "this model id is unusable on this account" —
 * retired, unknown, disabled, or needs an inference profile. Anything else
 * (auth, throttle, timeout) is NOT a reason to switch models.
 */
export function isModelUnavailableError(message: unknown): boolean {
  const text = String(message ?? "").toLowerCase();
  return (
    text.includes("end of its life") ||
    text.includes("model identifier is invalid") ||
    text.includes("provided model identifier") ||
    text.includes("on-demand throughput") ||
    text.includes("not found") ||
    text.includes("not_found") ||
    text.includes("access to the model") ||
    text.includes("not authorized to invoke this model") ||
    text.includes("model is not supported") ||
    text.includes("use case details")
  );
}

type BedrockClientLike = {
  messages: {
    create: (
      body: Record<string, unknown>,
      options: { timeout: number },
    ) => Promise<{ content?: Array<{ text?: unknown }> }>;
  };
};

function createBedrockProvider(
  env: NodeJS.ProcessEnv = process.env,
): LlmProvider {
  const candidates = bedrockModelCandidates(env);
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-west-2";
  const timeoutMs = Number(env.PROXYWAR_LLM_TIMEOUT_MS ?? 12000);
  let client: BedrockClientLike | null = null;
  let lockedIndex: number | null = null;
  return {
    providerType: "custom",
    async complete(prompt: string): Promise<string> {
      if (client === null) {
        // Resolved at pod runtime only (adapter dependency); kept opaque so
        // vite/vitest never try to bundle it.
        const bedrockSpecifier = "@anthropic-ai/bedrock-sdk";
        const mod = (await import(/* @vite-ignore */ bedrockSpecifier)) as {
          default?: new (options: { awsRegion: string }) => BedrockClientLike;
          AnthropicBedrock?: new (options: {
            awsRegion: string;
          }) => BedrockClientLike;
        };
        const AnthropicBedrock = mod.default ?? mod.AnthropicBedrock;
        if (AnthropicBedrock === undefined) {
          throw new Error("@anthropic-ai/bedrock-sdk did not export a client");
        }
        client = new AnthropicBedrock({ awsRegion: region });
      }
      const startIndex = lockedIndex ?? 0;
      let lastError: unknown = null;
      for (let i = startIndex; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        try {
          const response = await client.messages.create(
            {
              model: candidate,
              max_tokens: 1024,
              messages: [{ role: "user", content: prompt }],
            },
            { timeout: timeoutMs },
          );
          if (lockedIndex !== i) {
            lockedIndex = i;
            console.log(`keystone bedrock model locked: ${candidate}`);
          }
          return (response?.content ?? [])
            .map((block) => (typeof block?.text === "string" ? block.text : ""))
            .join("")
            .trim();
        } catch (error) {
          lastError = error;
          const message = error instanceof Error ? error.message : error;
          if (isModelUnavailableError(message)) {
            console.error(
              `keystone bedrock model unavailable, trying next: ${candidate} -> ${String(message).slice(0, 160)}`,
            );
            continue;
          }
          throw error;
        }
      }
      throw new Error(
        `No Bedrock model candidate is usable on this account (tried ${candidates.join(", ")}): ${String(
          lastError instanceof Error ? lastError.message : lastError,
        ).slice(0, 200)}`,
      );
    },
  };
}

export function createKeystoneBrain(
  modules: KeystoneModules,
  options: KeystoneBrainOptions,
): AgentBrain {
  const {
    PlannerExecutorAgentBrain,
    RuleAgentPlanner,
    MockLlmPlanner,
    LlmAgentPlanner,
    FrontierPolicyExecutor,
  } = modules.plannerExecutor;
  const planEveryDecisionSteps = options.planEveryDecisionSteps ?? 3;
  const executor = new FrontierPolicyExecutor(options.profile, {
    settings: { ...KEYSTONE_EXECUTOR_SETTINGS },
  });

  let planner: AgentPlanner;
  if (options.mode === "mock") {
    planner = new MockLlmPlanner(options.profile);
  } else {
    const provider =
      options.provider ??
      (options.mode === "claude-cli"
        ? modules.claudeCli.createClaudeCliLlmProviderFromEnv()
        : createBedrockProvider());
    planner = new DeferredAgentPlanner(
      new LlmAgentPlanner({
        provider,
        profile: options.profile,
        providerTimeoutMs: options.providerTimeoutMs,
        plannerType: "real-llm",
      }),
      new RuleAgentPlanner(options.profile),
    );
  }

  return new PlannerExecutorAgentBrain({
    profile: options.profile,
    planner,
    executor,
    planEveryDecisionSteps,
  });
}

function redactPlayerUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has("token")) {
      parsed.searchParams.set("token", "***");
    }
    return parsed.toString();
  } catch {
    return "<unparseable player url>";
  }
}

async function main(): Promise<void> {
  const url = process.env.COWORLD_PLAYER_WS_URL;
  if (!url) {
    throw new Error("COWORLD_PLAYER_WS_URL is required");
  }
  const repoRoot = process.env.PROXYWAR_REPO ?? "/app/proxywar";
  const mode = keystoneModeFromEnv();
  const profile = (process.env.PROXYWAR_KEYSTONE_PROFILE?.trim() ||
    "aggressive") as AgentStrategyProfile;
  const planEveryRaw = Number(process.env.PROXYWAR_KEYSTONE_PLAN_EVERY ?? "3");
  const planEveryDecisionSteps =
    Number.isFinite(planEveryRaw) && planEveryRaw >= 1
      ? Math.floor(planEveryRaw)
      : 3;

  const modules = await loadKeystoneModules(repoRoot);
  const brain = createKeystoneBrain(modules, {
    mode,
    profile,
    planEveryDecisionSteps,
  });

  const require = createRequire(import.meta.url);
  const { WebSocket } = require(`${repoRoot}/node_modules/ws`);
  const socket = new WebSocket(url);

  socket.on("open", () => {
    console.log(
      `keystone connected ${redactPlayerUrl(url)} (mode=${mode}, profile=${profile}, planEvery=${planEveryDecisionSteps})`,
    );
  });

  socket.on("message", async (data: unknown) => {
    let message: {
      type?: unknown;
      requestID?: unknown;
      request?: unknown;
    };
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.type === "final") {
      console.log("episode final; exiting");
      socket.close();
      return;
    }
    if (message.type !== "decision_request") {
      return;
    }
    const requestID = String(message.requestID ?? "");
    const startedAt = Date.now();
    let response: Record<string, unknown>;
    try {
      const input = requestToBrainInput(message.request);
      const decision = await brain.decide(input);
      response = decisionToResponse(requestID, decision);
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : String(error);
      console.error(`keystone decide failed: ${messageText}`);
      // Last-resort: never stall the match — pick any offered legal action.
      const actions =
        (message.request as { legalActions?: Array<{ id?: unknown }> })
          ?.legalActions ?? [];
      response = {
        type: "decision_response",
        requestID,
        selectedLegalActionId: String(actions[0]?.id ?? ""),
        reason: "keystone transport fallback",
        confidence: 0.3,
      };
    }
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > 5000) {
      console.warn(
        `keystone decision took ${elapsedMs}ms — investigate before the clock bites`,
      );
    }
    socket.send(JSON.stringify(response));
  });

  socket.on("close", () => {
    process.exit(0);
  });

  socket.on("error", (error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

const isMain = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
