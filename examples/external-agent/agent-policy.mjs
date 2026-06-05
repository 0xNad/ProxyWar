export {
  agentSkillPrompt,
  buildAntiStallGuidance,
  buildDecisionBriefing,
  buildLlmPrompt,
  buildProfileRepairGuidance,
  createAgentCardMarkdown,
  createFrontierMemory,
  createHealthResponse,
  defaultClaudeCommandArgs,
  createLlmCompleteFromEnv,
  createStarterAgent,
  decisionForPayloadWithFramework,
  describeLlmProviderFromEnv,
  groupLegalActionsByKind,
  openRouterCompleteFromEnv,
  publicBaseUrlFromRequest,
  rankLegalActions,
  selectSafeFallbackAction,
  validateDecisionOutput,
  validateDecisionPayload,
} from "./starter-framework.mjs";

export function decisionForPayload() {
  throw new Error(
    "The Proxy War starter agent requires an LLM brain. Use createStarterAgent({ llmComplete }).decide(payload), set PROXYWAR_AGENT_LLM_PROVIDER/PROXYWAR_AGENT_LLM_COMMAND, or set OPENROUTER_API_KEY.",
  );
}
