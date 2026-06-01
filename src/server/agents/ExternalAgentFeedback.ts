import fs from "fs/promises";
import path from "path";
import { AgentObjectiveScorecard } from "./AgentObjectiveScorecard";
import {
  AgentActionAuditStatus,
  AgentBrainType,
  AgentDecisionRecord,
  AgentStrategyProfile,
  LegalActionKind,
  legalActionKinds,
} from "./AgentTypes";

export interface ExternalAgentFeedbackInput {
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: AgentBrainType;
  records: AgentDecisionRecord[];
  scorecard?: AgentObjectiveScorecard;
}

export interface ExternalAgentFeedbackAgent {
  agentID: string;
  username: string;
  profile: AgentStrategyProfile;
  brainType: AgentBrainType;
  decisionCount: number;
  postSpawnDecisionCount: number;
  nonHoldCount: number;
  acceptedCount: number;
  rejectedCount: number;
  fallbackCount: number;
  parserFailureCount: number;
  confirmedAuditCount: number;
  unknownAuditCount: number;
  failedAuditCount: number;
  notApplicableAuditCount: number;
  externalActionCallCount: number;
  externalPlannerCallCount: number;
  repeatedActionKindCount: number;
  repeatedExactActionCount: number;
  actionCounts: Partial<Record<LegalActionKind, number>>;
  acceptedRate: number;
  nonHoldRate: number;
  auditedEffectRate: number;
  objectiveScore?: number;
  objectiveGrade?: string;
  strengths: string[];
  warnings: string[];
  improvementSuggestions: string[];
  iterationCoach: ExternalAgentIterationCoach;
  summary: string;
}

export interface ExternalAgentCoachingExample {
  sequence: number;
  username: string;
  issue: string;
  observationSummary: string;
  chosenActionID: string;
  chosenActionKind: LegalActionKind;
  recommendedActionKinds: LegalActionKind[];
  offeredActionIDs: string[];
  policyHint: string;
}

export interface ExternalAgentIterationCoach {
  status: "ready" | "needs_contract_fix" | "needs_strategy_iteration";
  priorityFixes: string[];
  exampleTurns: ExternalAgentCoachingExample[];
  practicePrompts: string[];
}

export interface ExternalAgentFeedback {
  schemaVersion: 1;
  runID: string;
  matchID: string;
  scenario: string;
  brainMode: AgentBrainType;
  generatedAt: string;
  aggregate: {
    externalAgentCount: number;
    decisionCount: number;
    postSpawnDecisionCount: number;
    nonHoldCount: number;
    acceptedCount: number;
    rejectedCount: number;
    fallbackCount: number;
    parserFailureCount: number;
    confirmedAuditCount: number;
    unknownAuditCount: number;
    failedAuditCount: number;
    externalActionCallCount: number;
    externalPlannerCallCount: number;
    nonHoldRate: number;
    acceptedRate: number;
    auditedEffectRate: number;
    readyForDeveloperReview: boolean;
    summary: string;
    topSuggestions: string[];
    iterationCoach: ExternalAgentIterationCoach;
  };
  agents: ExternalAgentFeedbackAgent[];
}

export interface ExternalAgentFeedbackPaths {
  jsonPath: string;
  markdownPath: string;
}

export function buildExternalAgentFeedback(
  input: ExternalAgentFeedbackInput,
): ExternalAgentFeedback {
  const externalRecords = input.records.filter(isExternalRecord);
  const grouped = groupByAgent(externalRecords);
  const agents = [...grouped.values()].map((records) =>
    feedbackForAgent(records, input.scorecard),
  );
  const aggregate = feedbackAggregate(agents);

  return {
    schemaVersion: 1,
    runID: input.runID,
    matchID: input.matchID,
    scenario: input.scenario,
    brainMode: input.brainMode,
    generatedAt: new Date().toISOString(),
    aggregate,
    agents,
  };
}

export async function writeExternalAgentFeedbackArtifacts(input: {
  feedback: ExternalAgentFeedback;
  directory: string;
}): Promise<ExternalAgentFeedbackPaths> {
  const jsonPath = path.join(input.directory, "external-agent-feedback.json");
  const markdownPath = path.join(input.directory, "external-agent-feedback.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(input.feedback, null, 2)}\n`);
  await fs.writeFile(markdownPath, externalAgentFeedbackMarkdown(input.feedback));
  return { jsonPath, markdownPath };
}

export function externalAgentFeedbackMarkdown(
  feedback: ExternalAgentFeedback,
): string {
  return [
    `# External Agent Feedback ${feedback.runID}`,
    "",
    "## Summary",
    "",
    `- Match id: ${feedback.matchID}`,
    `- Scenario: ${feedback.scenario}`,
    `- Brain mode: ${feedback.brainMode}`,
    `- External agents: ${feedback.aggregate.externalAgentCount}`,
    `- Decisions: ${feedback.aggregate.decisionCount}`,
    `- Accepted: ${feedback.aggregate.acceptedCount}`,
    `- Rejected: ${feedback.aggregate.rejectedCount}`,
    `- Fallbacks: ${feedback.aggregate.fallbackCount}`,
    `- Parser failures: ${feedback.aggregate.parserFailureCount}`,
    `- Post-spawn non-hold rate: ${percent(feedback.aggregate.nonHoldRate)}`,
    `- Audited effect rate: ${percent(feedback.aggregate.auditedEffectRate)}`,
    `- Ready for developer review: ${feedback.aggregate.readyForDeveloperReview ? "yes" : "no"}`,
    "",
    feedback.aggregate.summary,
    "",
    "## Top Suggestions",
    "",
    ...(feedback.aggregate.topSuggestions.length === 0
      ? ["- No external-agent-specific suggestions were generated."]
      : feedback.aggregate.topSuggestions.map((suggestion) => `- ${suggestion}`)),
    "",
    "## Iteration Coach",
    "",
    `- Status: ${feedback.aggregate.iterationCoach.status}`,
    "",
    "**Priority fixes**",
    "",
    ...(feedback.aggregate.iterationCoach.priorityFixes.length === 0
      ? ["- No priority fixes. Test against longer and stronger matches."]
      : feedback.aggregate.iterationCoach.priorityFixes.map((fix) => `- ${fix}`)),
    "",
    "**Example turns to debug**",
    "",
    ...(feedback.aggregate.iterationCoach.exampleTurns.length === 0
      ? ["- No specific weak turns were detected in this short run."]
      : feedback.aggregate.iterationCoach.exampleTurns.map(
          (example) =>
            `- Turn ${example.sequence} (${example.username}): ${example.issue}. Chose \`${example.chosenActionID}\`; consider ${example.recommendedActionKinds.join(", ") || "a higher-impact legal action"}. Hint: ${example.policyHint}`,
        )),
    "",
    "**Copy into your next policy pass**",
    "",
    ...feedback.aggregate.iterationCoach.practicePrompts.map(
      (prompt) => `- ${prompt}`,
    ),
    "",
    "## Per-Agent Feedback",
    "",
    feedback.agents.length === 0
      ? "No external-http agents were present in this run."
      : markdownTable(
          [
            "Agent",
            "Profile",
            "Decisions",
            "Accepted",
            "Non-hold",
            "Fallbacks",
            "Parser",
            "Audits C/U/F",
            "Top suggestion",
          ],
          feedback.agents.map((agent) => [
            agent.username,
            agent.profile,
            String(agent.decisionCount),
            `${agent.acceptedCount}/${agent.decisionCount} (${percent(agent.acceptedRate)})`,
            `${agent.nonHoldCount}/${agent.postSpawnDecisionCount} (${percent(agent.nonHoldRate)})`,
            String(agent.fallbackCount),
            String(agent.parserFailureCount),
            `${agent.confirmedAuditCount}/${agent.unknownAuditCount}/${agent.failedAuditCount}`,
            agent.improvementSuggestions[0] ?? "Keep testing longer matches.",
          ]),
        ),
    "",
    "## Agent Details",
    "",
    ...feedback.agents.flatMap((agent) => [
      `### ${agent.username}`,
      "",
      agent.summary,
      "",
      `- Action counts: ${JSON.stringify(agent.actionCounts)}`,
      `- Repeated action-kind count: ${agent.repeatedActionKindCount}`,
      `- Repeated exact-action count: ${agent.repeatedExactActionCount}`,
      ...(agent.objectiveScore === undefined
        ? []
        : [`- Objective score: ${agent.objectiveScore}/100 (${agent.objectiveGrade ?? "unknown"})`]),
      "",
      "**Strengths**",
      "",
      ...(agent.strengths.length === 0
        ? ["- No clear strengths yet; run more decision cycles."]
        : agent.strengths.map((strength) => `- ${strength}`)),
      "",
      "**Warnings**",
      "",
      ...(agent.warnings.length === 0
        ? ["- No external-agent warnings in this run."]
        : agent.warnings.map((warning) => `- ${warning}`)),
      "",
      "**Suggested Improvements**",
      "",
      ...(agent.improvementSuggestions.length === 0
        ? ["- Keep the current policy and test against stronger rosters."]
        : agent.improvementSuggestions.map((suggestion) => `- ${suggestion}`)),
      "",
      "**Iteration Coach**",
      "",
      `- Status: ${agent.iterationCoach.status}`,
      ...(agent.iterationCoach.priorityFixes.length === 0
        ? ["- No agent-specific priority fixes."]
        : agent.iterationCoach.priorityFixes.map((fix) => `- ${fix}`)),
      ...(agent.iterationCoach.exampleTurns.length === 0
        ? ["- No specific weak turns were detected."]
        : agent.iterationCoach.exampleTurns.map(
            (example) =>
              `- Turn ${example.sequence}: ${example.issue}. Chose \`${example.chosenActionID}\`; offered ${example.offeredActionIDs.slice(0, 6).join(", ")}. ${example.policyHint}`,
          )),
      "",
    ]),
    "## How To Use This",
    "",
    "- Fix parser failures and fallbacks before tuning strategy; they mean the endpoint is not reliably choosing offered LegalAction.id values.",
    "- Repeated action warnings usually mean the policy is ignoring memory or treating expansion/embargo/build as always-good.",
    "- Unknown audits are not failures, but they are not proof either. Prefer actions whose effects show up clearly while debugging.",
    "- Once this feedback is clean, run longer rendered matches and inspect whether the agent remains active after early expansion.",
    "",
  ].join("\n");
}

function feedbackForAgent(
  records: AgentDecisionRecord[],
  scorecard?: AgentObjectiveScorecard,
): ExternalAgentFeedbackAgent {
  const first = records[0]!;
  const metrics = metricsFor(records);
  const score = scorecard?.agents.find((agent) => agent.agentID === first.agentID);
  const strengths = strengthsFor(metrics, score);
  const warnings = warningsFor(metrics);
  const improvementSuggestions = suggestionsFor(first, metrics);
  const iterationCoach = iterationCoachFor(records, metrics, improvementSuggestions);

  return {
    agentID: first.agentID,
    username: first.username,
    profile: first.profile,
    brainType: first.brainType,
    ...metrics,
    objectiveScore: score?.totalObjectiveScore,
    objectiveGrade: score?.grade,
    strengths,
    warnings,
    improvementSuggestions,
    iterationCoach,
    summary: `${first.username} made ${metrics.decisionCount} external decision(s), accepted ${metrics.acceptedCount}, used fallback ${metrics.fallbackCount} time(s), and selected non-hold actions for ${percent(metrics.nonHoldRate)} of post-spawn turns.`,
  };
}

function feedbackAggregate(agents: ExternalAgentFeedbackAgent[]): ExternalAgentFeedback["aggregate"] {
  const totals = agents.reduce(
    (sum, agent) => ({
      decisionCount: sum.decisionCount + agent.decisionCount,
      postSpawnDecisionCount:
        sum.postSpawnDecisionCount + agent.postSpawnDecisionCount,
      nonHoldCount: sum.nonHoldCount + agent.nonHoldCount,
      acceptedCount: sum.acceptedCount + agent.acceptedCount,
      rejectedCount: sum.rejectedCount + agent.rejectedCount,
      fallbackCount: sum.fallbackCount + agent.fallbackCount,
      parserFailureCount: sum.parserFailureCount + agent.parserFailureCount,
      confirmedAuditCount: sum.confirmedAuditCount + agent.confirmedAuditCount,
      unknownAuditCount: sum.unknownAuditCount + agent.unknownAuditCount,
      failedAuditCount: sum.failedAuditCount + agent.failedAuditCount,
      externalActionCallCount:
        sum.externalActionCallCount + agent.externalActionCallCount,
      externalPlannerCallCount:
        sum.externalPlannerCallCount + agent.externalPlannerCallCount,
    }),
    {
      decisionCount: 0,
      postSpawnDecisionCount: 0,
      nonHoldCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      fallbackCount: 0,
      parserFailureCount: 0,
      confirmedAuditCount: 0,
      unknownAuditCount: 0,
      failedAuditCount: 0,
      externalActionCallCount: 0,
      externalPlannerCallCount: 0,
    },
  );
  const nonHoldRate = rate(totals.nonHoldCount, totals.postSpawnDecisionCount);
  const acceptedRate = rate(totals.acceptedCount, totals.decisionCount);
  const auditedEffectRate = rate(
    totals.confirmedAuditCount,
    totals.confirmedAuditCount + totals.unknownAuditCount + totals.failedAuditCount,
  );
  const topSuggestions = unique(
    agents.flatMap((agent) => agent.improvementSuggestions).slice(0, 6),
  );
  const iterationCoach = aggregateIterationCoach(agents);
  const readyForDeveloperReview =
    agents.length > 0 &&
    totals.rejectedCount === 0 &&
    totals.fallbackCount === 0 &&
    totals.parserFailureCount === 0 &&
    totals.failedAuditCount === 0;

  return {
    externalAgentCount: agents.length,
    ...totals,
    nonHoldRate,
    acceptedRate,
    auditedEffectRate,
    readyForDeveloperReview,
    summary:
      agents.length === 0
        ? "This run did not include external-http agents."
        : `External agents accepted ${totals.acceptedCount}/${totals.decisionCount} decision(s), used ${totals.fallbackCount} fallback(s), and produced ${totals.nonHoldCount} post-spawn non-hold action(s).`,
    topSuggestions,
    iterationCoach,
  };
}

function metricsFor(records: AgentDecisionRecord[]) {
  const postSpawn = records.filter(
    (record) => record.turnNumber > 0 && record.chosenActionKind !== "spawn",
  );
  const actionCounts = countActionKinds(records);
  const audits = records.map((record) => auditStatus(record));
  const repeated = repeatedCounts(postSpawn);
  const decisionCount = records.length;
  const acceptedCount = records.filter((record) => record.result.accepted).length;
  const confirmedAuditCount = audits.filter((status) => status === "confirmed").length;
  const unknownAuditCount = audits.filter((status) => status === "unknown").length;
  const failedAuditCount = audits.filter((status) => status === "failed").length;
  const notApplicableAuditCount = audits.filter(
    (status) => status === "not_applicable",
  ).length;

  return {
    decisionCount,
    postSpawnDecisionCount: postSpawn.length,
    nonHoldCount: postSpawn.filter((record) => record.chosenActionKind !== "hold")
      .length,
    acceptedCount,
    rejectedCount: decisionCount - acceptedCount,
    fallbackCount: records.filter((record) => fallbackUsed(record)).length,
    parserFailureCount: records.filter((record) => parserFailed(record)).length,
    confirmedAuditCount,
    unknownAuditCount,
    failedAuditCount,
    notApplicableAuditCount,
    externalActionCallCount: records.filter((record) => externalActionCall(record))
      .length,
    externalPlannerCallCount: records.filter((record) => externalPlannerCall(record))
      .length,
    repeatedActionKindCount: repeated.kind,
    repeatedExactActionCount: repeated.exact,
    actionCounts,
    acceptedRate: rate(acceptedCount, decisionCount),
    nonHoldRate: rate(
      postSpawn.filter((record) => record.chosenActionKind !== "hold").length,
      postSpawn.length,
    ),
    auditedEffectRate: rate(
      confirmedAuditCount,
      confirmedAuditCount + unknownAuditCount + failedAuditCount,
    ),
  };
}

function suggestionsFor(
  first: AgentDecisionRecord,
  metrics: ReturnType<typeof metricsFor>,
): string[] {
  const suggestions: string[] = [];
  if (metrics.parserFailureCount > 0) {
    suggestions.push(
      "Return strict JSON selecting exactly one offered LegalAction.id; parser failures trigger local fallback.",
    );
  }
  if (metrics.fallbackCount > 0) {
    suggestions.push(
      "Reduce timeouts/errors so your own policy controls the decision instead of the local fallback brain.",
    );
  }
  if (metrics.rejectedCount > 0) {
    suggestions.push(
      "Only choose ids from legalActions[].id; rejected intents are visible in reports and do not help the nation.",
    );
  }
  if (metrics.postSpawnDecisionCount > 0 && metrics.nonHoldRate < 0.5) {
    suggestions.push(
      "Prefer useful non-hold actions after spawn when expansion, builds, alliances, or pressure are offered.",
    );
  }
  if (metrics.repeatedExactActionCount > 1 || metrics.repeatedActionKindCount > 3) {
    suggestions.push(
      "Use observation.memory and recent action counts to break repeated low-value action loops.",
    );
  }
  const expansionCount = metrics.actionCounts.attack ?? 0;
  const buildCount = metrics.actionCounts.build ?? 0;
  if (expansionCount >= 4 && buildCount === 0) {
    suggestions.push(
      "Add economy timing: after early expansion, choose City or Factory actions when safe and legal.",
    );
  }
  if (buildCount >= 3 && expansionCount === 0) {
    suggestions.push(
      "Avoid overbuilding; keep expanding or pressuring rivals when the map still offers tempo actions.",
    );
  }
  if (metrics.actionCounts.embargo !== undefined && metrics.actionCounts.attack === undefined) {
    suggestions.push(
      "Use embargo as support for pressure, not as a replacement for favorable attacks or expansion.",
    );
  }
  if (first.profile === "diplomatic" && (metrics.actionCounts.alliance_request ?? 0) === 0) {
    suggestions.push(
      "Diplomatic agents should consider alliance_request when it creates a buffer or lowers early risk.",
    );
  }
  if (metrics.unknownAuditCount > metrics.confirmedAuditCount) {
    suggestions.push(
      "Inspect unknown audits in the visual report; accepted actions worked through GameServer, but their effects were not provable from the current mirror snapshot.",
    );
  }
  if (metrics.failedAuditCount > 0) {
    suggestions.push(
      "Investigate failed audits before tuning strategy; they mean an accepted action did not show the expected state effect.",
    );
  }
  return unique(suggestions);
}

function iterationCoachFor(
  records: AgentDecisionRecord[],
  metrics: ReturnType<typeof metricsFor>,
  suggestions: string[],
): ExternalAgentIterationCoach {
  const priorityFixes: string[] = [];
  if (metrics.parserFailureCount > 0 || metrics.rejectedCount > 0) {
    priorityFixes.push(
      "Fix the response contract before strategy: strict JSON, one offered LegalAction.id, no invented ids.",
    );
  }
  if (metrics.fallbackCount > 0) {
    priorityFixes.push(
      "Reduce endpoint latency/errors so the external policy, not fallback, controls the nation.",
    );
  }

  const examples = coachingExamplesFor(records);
  if (examples.some((example) => example.issue.includes("Held"))) {
    priorityFixes.push(
      "Add a branch that avoids hold when safe non-hold actions are offered.",
    );
  }
  if (
    examples.some((example) =>
      example.issue.toLowerCase().includes("repeated"),
    )
  ) {
    priorityFixes.push(
      "Use observation memory to rotate away from repeated low-value actions.",
    );
  }
  if (examples.some((example) => example.issue.includes("Defense Post"))) {
    priorityFixes.push(
      "Gate Defense Posts on frontier metadata: border distance, enemy count, and defensive value.",
    );
  }
  if (examples.some((example) => example.issue.includes("economy"))) {
    priorityFixes.push(
      "Add economy timing after early expansion: prefer City/Factory when safe and legal.",
    );
  }

  const status =
    metrics.parserFailureCount > 0 ||
    metrics.rejectedCount > 0 ||
    metrics.fallbackCount > 0
      ? "needs_contract_fix"
      : priorityFixes.length > 0 || suggestions.length > 0 || examples.length > 0
        ? "needs_strategy_iteration"
        : "ready";

  return {
    status,
    priorityFixes: unique(priorityFixes).slice(0, 5),
    exampleTurns: examples.slice(0, 5),
    practicePrompts: practicePromptsFor(status, examples, suggestions),
  };
}

function aggregateIterationCoach(
  agents: ExternalAgentFeedbackAgent[],
): ExternalAgentIterationCoach {
  const examples = agents.flatMap((agent) => agent.iterationCoach.exampleTurns);
  const priorityFixes = unique(
    agents.flatMap((agent) => agent.iterationCoach.priorityFixes),
  ).slice(0, 7);
  const statuses = agents.map((agent) => agent.iterationCoach.status);
  const status = statuses.includes("needs_contract_fix")
    ? "needs_contract_fix"
    : statuses.includes("needs_strategy_iteration")
      ? "needs_strategy_iteration"
      : "ready";

  return {
    status,
    priorityFixes,
    exampleTurns: examples.slice(0, 8),
    practicePrompts: practicePromptsFor(
      status,
      examples,
      agents.flatMap((agent) => agent.improvementSuggestions),
    ),
  };
}

function coachingExamplesFor(
  records: AgentDecisionRecord[],
): ExternalAgentCoachingExample[] {
  const examples: ExternalAgentCoachingExample[] = [];
  const postSpawn = records.filter((record) => record.chosenActionKind !== "spawn");

  for (const record of postSpawn) {
    if (!record.result.accepted || parserFailed(record) || fallbackUsed(record)) {
      examples.push(
        coachingExample(
          record,
          "Contract failure blocked useful strategy",
          legalKindsOffered(record),
          "Start by making this decision parse, validate, and avoid fallback before changing gameplay heuristics.",
        ),
      );
      continue;
    }

    const offeredNonHold = legalKindsOffered(record).filter(
      (kind) => kind !== "hold" && kind !== "spawn",
    );
    if (record.chosenActionKind === "hold" && offeredNonHold.length > 0) {
      examples.push(
        coachingExample(
          record,
          "Held while useful non-hold legal actions were offered",
          offeredNonHold,
          "Choose hold only when every non-hold option is unsafe or strategically stale.",
        ),
      );
      continue;
    }

    if (isBadDefensePost(record)) {
      examples.push(
        coachingExample(
          record,
          "Defense Post looked like an interior or low-frontier build",
          ["build"],
          "Only build Defense Posts near hostile borders, vulnerable edges, or incoming pressure; otherwise prefer City, Factory, expansion, or pressure.",
        ),
      );
      continue;
    }
  }

  for (let index = 1; index < postSpawn.length; index += 1) {
    const previous = postSpawn[index - 1]!;
    const current = postSpawn[index]!;
    if (
      current.chosenActionKind !== "hold" &&
      current.chosenActionKind === previous.chosenActionKind
    ) {
      const offered = legalKindsOffered(current).filter(
        (kind) => kind !== current.chosenActionKind && kind !== "hold",
      );
      examples.push(
        coachingExample(
          current,
          `Repeated ${current.chosenActionKind} while alternatives were available`,
          offered.length > 0 ? offered : legalKindsOffered(current),
          "Check observation.memory and add a repetition penalty before repeating the same action kind.",
        ),
      );
    }
  }

  const attackCount = postSpawn.filter(
    (record) => record.chosenActionKind === "attack",
  ).length;
  const buildCount = postSpawn.filter(
    (record) => record.chosenActionKind === "build",
  ).length;
  if (attackCount >= 3 && buildCount === 0) {
    const buildOffered = postSpawn.find(
      (record) => (record.legalActionIDsByKind.build?.length ?? 0) > 0,
    );
    if (buildOffered !== undefined) {
      examples.push(
        coachingExample(
          buildOffered,
          "Expansion loop ignored an economy build opportunity",
          ["build"],
          "After early neutral expansion, add a City/Factory timing rule when build metadata says the tile is safe and economic.",
        ),
      );
    }
  }

  return uniqueExamples(examples);
}

function coachingExample(
  record: AgentDecisionRecord,
  issue: string,
  recommendedActionKinds: LegalActionKind[],
  policyHint: string,
): ExternalAgentCoachingExample {
  return {
    sequence: record.sequence,
    username: record.username,
    issue,
    observationSummary: record.observationSummary,
    chosenActionID: record.chosenActionID,
    chosenActionKind: record.chosenActionKind,
    recommendedActionKinds: uniqueKinds(recommendedActionKinds),
    offeredActionIDs: record.legalActionIDs.slice(0, 12),
    policyHint,
  };
}

function legalKindsOffered(record: AgentDecisionRecord): LegalActionKind[] {
  return legalActionKinds.filter(
    (kind) => (record.legalActionIDsByKind[kind]?.length ?? 0) > 0,
  );
}

function isBadDefensePost(record: AgentDecisionRecord): boolean {
  if (record.chosenActionKind !== "build") {
    return false;
  }
  const metadata = record.chosenActionMetadata;
  if (metadata === undefined || metadata === null) {
    return false;
  }
  const unit = String(metadata.unit ?? "");
  if (unit !== "DefensePost") {
    return false;
  }
  const isBorderBuild = metadata.isBorderBuild === true;
  const nearbyEnemyCount =
    typeof metadata.nearbyEnemyCount === "number" ? metadata.nearbyEnemyCount : 0;
  const defensiveValue =
    typeof metadata.defensiveValue === "number" ? metadata.defensiveValue : 0;
  return !isBorderBuild && nearbyEnemyCount === 0 && defensiveValue < 0.4;
}

function practicePromptsFor(
  status: ExternalAgentIterationCoach["status"],
  examples: ExternalAgentCoachingExample[],
  suggestions: string[],
): string[] {
  const prompts: string[] = [];
  if (status === "needs_contract_fix") {
    prompts.push(
      "Before selecting strategy, verify the chosen id is included in legalActions[].id and return JSON only.",
    );
  }
  if (
    examples.some((example) => {
      const issue = example.issue.toLowerCase();
      return issue.includes("held") || issue.includes("repeated");
    })
  ) {
    prompts.push(
      "If observation.memory shows the same recent action kind twice, prefer a different high-scoring legal action unless the repeated action is clearly urgent.",
    );
  }
  if (examples.some((example) => example.issue.includes("economy"))) {
    prompts.push(
      "After two safe expansions, if City or Factory is offered with safe/economic metadata, choose it before another neutral expansion.",
    );
  }
  if (examples.some((example) => example.issue.includes("Defense Post"))) {
    prompts.push(
      "Choose Defense Post only when build metadata says isBorderBuild=true, nearbyEnemyCount>0, or defensiveValue is high.",
    );
  }
  if (prompts.length === 0 && suggestions.length > 0) {
    prompts.push(...suggestions.slice(0, 3));
  }
  if (prompts.length === 0) {
    prompts.push(
      "Keep the LegalAction.id contract and test longer matches with stronger opposition.",
    );
  }
  return unique(prompts).slice(0, 5);
}

function strengthsFor(
  metrics: ReturnType<typeof metricsFor>,
  score?: AgentObjectiveScorecard["agents"][number],
): string[] {
  const strengths: string[] = [];
  if (metrics.decisionCount > 0 && metrics.acceptedRate === 1) {
    strengths.push("Every selected action was accepted by the validator/GameServer path.");
  }
  if (metrics.parserFailureCount === 0 && metrics.externalActionCallCount > 0) {
    strengths.push("The endpoint returned parseable LegalAction.id decisions.");
  }
  if (metrics.fallbackCount === 0 && metrics.externalActionCallCount > 0) {
    strengths.push("No local fallback was needed for external decisions.");
  }
  if (metrics.postSpawnDecisionCount > 0 && metrics.nonHoldRate >= 0.75) {
    strengths.push("The agent stayed active after spawn instead of mostly holding.");
  }
  if (score !== undefined && score.totalObjectiveScore >= 70) {
    strengths.push(`Objective score is ${score.totalObjectiveScore}/100 (${score.grade}).`);
  }
  return strengths;
}

function warningsFor(metrics: ReturnType<typeof metricsFor>): string[] {
  const warnings: string[] = [];
  if (metrics.rejectedCount > 0) {
    warnings.push(`${metrics.rejectedCount} rejected decision(s)`);
  }
  if (metrics.fallbackCount > 0) {
    warnings.push(`${metrics.fallbackCount} fallback decision(s)`);
  }
  if (metrics.parserFailureCount > 0) {
    warnings.push(`${metrics.parserFailureCount} parser failure(s)`);
  }
  if (metrics.failedAuditCount > 0) {
    warnings.push(`${metrics.failedAuditCount} failed audit(s)`);
  }
  if (metrics.unknownAuditCount > 0) {
    warnings.push(`${metrics.unknownAuditCount} audit-unknown effect(s)`);
  }
  if (metrics.repeatedActionKindCount > 3) {
    warnings.push(`${metrics.repeatedActionKindCount} repeated action-kind step(s)`);
  }
  if (metrics.repeatedExactActionCount > 1) {
    warnings.push(`${metrics.repeatedExactActionCount} repeated exact action(s)`);
  }
  return warnings;
}

function isExternalRecord(record: AgentDecisionRecord): boolean {
  return (
    record.brainType === "external-http" ||
    externalActionCall(record) ||
    externalPlannerCall(record)
  );
}

function externalActionCall(record: AgentDecisionRecord): boolean {
  return record.decisionMetadata?.externalActionCall === true;
}

function externalPlannerCall(record: AgentDecisionRecord): boolean {
  return record.decisionMetadata?.externalPlannerCall === true;
}

function fallbackUsed(record: AgentDecisionRecord): boolean {
  return (
    record.decisionMetadata?.fallbackUsed === true ||
    record.decisionMetadata?.plannerFallbackUsed === true
  );
}

function parserFailed(record: AgentDecisionRecord): boolean {
  return (
    record.decisionMetadata?.parseSuccess === false ||
    record.decisionMetadata?.llmParseOk === false ||
    record.decisionMetadata?.plannerParseOk === false
  );
}

function auditStatus(record: AgentDecisionRecord): AgentActionAuditStatus {
  if (record.audit !== undefined) {
    return record.audit.auditStatus;
  }
  if (!record.result.accepted) {
    return "not_applicable";
  }
  if (record.intent === null || record.chosenActionKind === "hold") {
    return "not_applicable";
  }
  return "unknown";
}

function groupByAgent(records: AgentDecisionRecord[]): Map<string, AgentDecisionRecord[]> {
  const grouped = new Map<string, AgentDecisionRecord[]>();
  for (const record of records) {
    const group = grouped.get(record.agentID) ?? [];
    group.push(record);
    grouped.set(record.agentID, group);
  }
  return grouped;
}

function countActionKinds(
  records: AgentDecisionRecord[],
): Partial<Record<LegalActionKind, number>> {
  const counts: Partial<Record<LegalActionKind, number>> = {};
  for (const kind of legalActionKinds) {
    const count = records.filter((record) => record.chosenActionKind === kind).length;
    if (count > 0) {
      counts[kind] = count;
    }
  }
  return counts;
}

function repeatedCounts(records: AgentDecisionRecord[]): { kind: number; exact: number } {
  let kind = 0;
  let exact = 0;
  for (let index = 1; index < records.length; index += 1) {
    const previous = records[index - 1]!;
    const current = records[index]!;
    if (
      current.chosenActionKind !== "hold" &&
      current.chosenActionKind === previous.chosenActionKind
    ) {
      kind += 1;
    }
    if (
      current.chosenActionID !== "hold" &&
      current.chosenActionID === previous.chosenActionID
    ) {
      exact += 1;
    }
  }
  return { kind, exact };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function uniqueKinds(values: LegalActionKind[]): LegalActionKind[] {
  return [...new Set(values)];
}

function uniqueExamples(
  values: ExternalAgentCoachingExample[],
): ExternalAgentCoachingExample[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.sequence}:${value.issue}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeMarkdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`),
  ].join("\n");
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}
