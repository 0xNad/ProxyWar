export {
  agentSkillPrompt,
  buildAntiStallGuidance,
  buildDecisionBriefing,
  buildLlmPrompt,
  buildProfileRepairGuidance,
  createAgentCardMarkdown,
  createFrontierMemory,
  createHealthResponse,
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
    "The Open Frontier starter agent requires an LLM brain. Use createStarterAgent({ llmComplete }).decide(payload), set OPEN_FRONTIER_AGENT_LLM_PROVIDER/OPEN_FRONTIER_AGENT_LLM_COMMAND, or set OPENROUTER_API_KEY.",
  );
}
