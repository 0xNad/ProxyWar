import fs from "fs/promises";
import path from "path";
import {
  CodexCliLlmProvider,
  DEFAULT_CODEX_RESEARCHER_MODEL,
  DEFAULT_CODEX_RESEARCHER_REASONING_EFFORT,
  resolveCodexCliCommand,
} from "../server/agents/CodexCliLlmProvider";

interface ResearcherConfig {
  benchmarkID: string;
  outputID: string;
  benchmarkDir: string;
  outputDir: string;
  dryRun: boolean;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  maxArtifactChars: number;
}

interface ResearcherProposal {
  summary: string;
  failurePattern: string;
  evidence: Array<{
    artifact: string;
    run?: string | null;
    turn?: number | null;
    selectedActionId?: string | null;
    metric?: string | null;
    claim: string;
  }>;
  hypothesis: string;
  plannerControls: {
    objective:
      | "choose_spawn"
      | "expand_territory"
      | "secure_economy"
      | "fortify_border"
      | "pressure_rival"
      | "build_alliance"
      | "survive"
      | null;
    preferredActionKinds: string[];
    enabledModules: string[];
    tacticalSettingsChange: string;
  };
  proposal: {
    title: string;
    change: string;
    allowedFiles: string[];
    expectedMetricMovement: string;
    rejectCriteria: string[];
  };
  abBenchmark: {
    baselineCommand: string;
    candidateCommand: string;
    metrics: string[];
  };
  canonicalCompliance: {
    usesExistingLegalActionIds: boolean;
    rawIntentPathRequired: boolean;
    newRunnerRequired: boolean;
    newActionSchemaRequired: boolean;
    newValidatorRequired: boolean;
    newObjectiveKindRequired: boolean;
    coreChangesRequired: boolean;
  };
  missingObservationFields: string[];
  riskNotes: string[];
}

async function run() {
  const config = await configFromArgs(process.argv.slice(2));
  await fs.mkdir(config.outputDir, { recursive: true });

  const prompt = await researcherPrompt(config);
  const promptPath = path.join(config.outputDir, "researcher-prompt.md");
  await fs.writeFile(promptPath, prompt);

  if (config.dryRun) {
    console.log("Post-match researcher dry run complete", {
      benchmarkID: config.benchmarkID,
      prompt: promptPath,
    });
    return;
  }

  const provider = new CodexCliLlmProvider({
    command: resolveCodexCliCommand(process.env),
    cwd: process.cwd(),
    timeoutMs: config.timeoutMs,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    outputSchema: "researcher",
  });
  try {
    const raw = await provider.complete(prompt);
    const proposal = parseResearcherProposal(raw);
    const jsonPath = path.join(config.outputDir, "research-proposal.json");
    const markdownPath = path.join(config.outputDir, "research-proposal.md");
    await fs.writeFile(jsonPath, `${JSON.stringify(proposal, null, 2)}\n`);
    await fs.writeFile(markdownPath, researcherProposalMarkdown(proposal));

    console.log("Post-match researcher complete", {
      benchmarkID: config.benchmarkID,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      report: markdownPath,
      json: jsonPath,
      prompt: promptPath,
    });
  } finally {
    provider.close();
  }
}

async function configFromArgs(args: string[]): Promise<ResearcherConfig> {
  const benchmarkRoot = path.resolve(
    process.cwd(),
    "artifacts/ai-league-benchmarks",
  );
  const benchmarkID =
    stringArg(args, "--benchmark-id=") ??
    (await latestBenchmarkID(benchmarkRoot));
  if (benchmarkID === null) {
    throw new Error(
      "No benchmark artifacts found under artifacts/ai-league-benchmarks",
    );
  }
  const outputID = stringArg(args, "--out-id=") ?? benchmarkID;
  return {
    benchmarkID,
    outputID,
    benchmarkDir: path.join(benchmarkRoot, benchmarkID),
    outputDir:
      stringArg(args, "--out-dir=") ??
      path.resolve(process.cwd(), "artifacts/ai-learning-research", outputID),
    dryRun: args.includes("--dry-run"),
    model:
      stringArg(args, "--model=") ??
      process.env.AI_LEAGUE_RESEARCHER_MODEL ??
      process.env.AI_LEAGUE_CODEX_RESEARCHER_MODEL ??
      DEFAULT_CODEX_RESEARCHER_MODEL,
    reasoningEffort:
      stringArg(args, "--reasoning-effort=") ??
      process.env.AI_LEAGUE_RESEARCHER_REASONING_EFFORT ??
      process.env.AI_LEAGUE_CODEX_RESEARCHER_REASONING_EFFORT ??
      DEFAULT_CODEX_RESEARCHER_REASONING_EFFORT,
    timeoutMs: positiveIntegerArg(args, "--timeout-ms=", 300_000),
    maxArtifactChars: positiveIntegerArg(args, "--max-artifact-chars=", 48_000),
  };
}

async function researcherPrompt(config: ResearcherConfig): Promise<string> {
  const artifacts = await artifactExcerpts(config);
  const decisionSamples = await interestingDecisionSamples(config.benchmarkDir);
  return [
    "# Proxy War Post-Match Researcher",
    "",
    "You are the offline researcher for the Proxy War Champion Agent.",
    "Goal: make the agent measurably stronger against built-in hard nations.",
    "",
    "Hard constraints:",
    "- Do not propose a second runner, action schema, validator, or raw-intent path.",
    "- Any in-match change must preserve AgentObservation -> LegalAction[] -> PlannerExecutor/AgentBrain -> AgentDecision selecting one LegalAction.id -> AgentDecisionValidator -> AgentRunner -> GameServer.",
    "- Do not propose LLM code inside src/core.",
    "- The live strategic brain may set objective, target, risk posture, preferred action kinds, and tactical settings only.",
    "- If the proposal touches the live planner, it must use an existing objective: choose_spawn, expand_territory, secure_economy, fortify_border, pressure_rival, build_alliance, or survive.",
    "- Do not invent new planner objective names, action kinds, validators, or raw game intents.",
    "- The final action must still be selected by the deterministic executor from existing LegalAction.id values.",
    "",
    "Return one small, bounded improvement proposal. Prefer a change that can be A/B tested in 3-10 hard-nation runs. The canonicalCompliance flags must truthfully say whether the proposal requires schema/core/runner/validator changes; prefer proposals where all those requirement flags are false.",
    "",
    `Benchmark ID: ${config.benchmarkID}`,
    `Researcher model target: ${config.model} / ${config.reasoningEffort}`,
    "",
    "## Artifact Excerpts",
    artifacts,
    "",
    "## Interesting Decision Samples",
    "```json",
    JSON.stringify(decisionSamples, null, 2),
    "```",
  ].join("\n");
}

async function artifactExcerpts(config: ResearcherConfig): Promise<string> {
  const names = [
    "benchmark-report.md",
    "performance-diagnosis.md",
    "learning-report.md",
    "frontier-summary.json",
    "learning-report.json",
  ];
  const sections: string[] = [];
  let remaining = config.maxArtifactChars;
  for (const name of names) {
    if (remaining <= 0) {
      break;
    }
    const content = await readOptionalFile(
      path.join(config.benchmarkDir, name),
    );
    if (content === null) {
      continue;
    }
    const excerpt = clip(content, Math.min(remaining, 16_000));
    remaining -= excerpt.length;
    sections.push([`### ${name}`, "```", excerpt, "```"].join("\n"));
  }
  return sections.join("\n\n");
}

async function interestingDecisionSamples(benchmarkDir: string) {
  const filenames = (await fs.readdir(benchmarkDir))
    .filter((filename) => /^run-\d+\.records\.json$/.test(filename))
    .sort((a, b) => runIndexFromFilename(a) - runIndexFromFilename(b));
  const samples: unknown[] = [];
  for (const filename of filenames) {
    const records = JSON.parse(
      await fs.readFile(path.join(benchmarkDir, filename), "utf8"),
    ) as Array<Record<string, unknown>>;
    for (const record of records) {
      if (!isInterestingRecord(record)) {
        continue;
      }
      samples.push({
        run: filename.replace(".records.json", ""),
        turnNumber: record.turnNumber,
        chosenActionID: record.chosenActionID,
        chosenActionKind: record.chosenActionKind,
        objectiveKind: record.objectiveKind,
        strategicPriority: record.strategicPriority,
        strategicUrgency: record.strategicUrgency,
        reason: clip(String(record.reason ?? ""), 700),
        tacticalAffordances: compactTacticalAffordances(
          record.tacticalAffordances,
        ),
      });
      if (samples.length >= 36) {
        return samples;
      }
    }
  }
  return samples;
}

function isInterestingRecord(record: Record<string, unknown>): boolean {
  const reason = String(record.reason ?? "");
  const chosenKind = String(record.chosenActionKind ?? "");
  const tactical = record.tacticalAffordances as
    | Record<string, Record<string, unknown>>
    | undefined;
  return (
    /attack-safety|transport|blocked|unexplained|finish|stale|leader/i.test(
      reason,
    ) ||
    chosenKind === "hold" ||
    tactical?.transportTroopBanking?.recommended === true ||
    tactical?.frontierConversionTiming?.recommended === true ||
    tactical?.frontierFinishPressure?.recommended === true
  );
}

function compactTacticalAffordances(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const tactical = value as Record<string, Record<string, unknown>>;
  return {
    transportTroopBanking: compactTactic(tactical.transportTroopBanking),
    frontierConversionTiming: compactTactic(tactical.frontierConversionTiming),
    frontierFinishPressure: compactTactic(tactical.frontierFinishPressure),
    openingExpansionTempo: compactTactic(tactical.openingExpansionTempo),
  };
}

function compactTactic(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const tactic = value as Record<string, unknown>;
  return {
    recommended: tactic.recommended,
    nearCap: tactic.nearCap,
    executorReady: tactic.executorReady,
    strategicWindow: tactic.strategicWindow,
    bestTargetName: tactic.bestTargetName,
    bestAttackID: tactic.bestAttackID,
    effectiveFutureTroopRatio: tactic.effectiveFutureTroopRatio,
    reasons: tactic.reasons,
  };
}

function parseResearcherProposal(raw: string): ResearcherProposal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const invalidJsonError = new Error(
      `Researcher output was not valid JSON: ${message}`,
    ) as Error & { cause?: unknown };
    invalidJsonError.cause = error;
    throw invalidJsonError;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Researcher output must be a JSON object");
  }
  const value = parsed as ResearcherProposal;
  for (const key of ["summary", "failurePattern", "hypothesis"] as const) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      throw new Error(`Researcher output missing ${key}`);
    }
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    throw new Error("Researcher output must include evidence");
  }
  if (
    value.proposal === undefined ||
    typeof value.proposal.title !== "string" ||
    typeof value.proposal.change !== "string"
  ) {
    throw new Error("Researcher output must include a proposal");
  }
  if (
    value.plannerControls === undefined ||
    (typeof value.plannerControls.objective !== "string" &&
      value.plannerControls.objective !== null)
  ) {
    throw new Error("Researcher output must include plannerControls");
  }
  if (
    value.canonicalCompliance === undefined ||
    value.canonicalCompliance.usesExistingLegalActionIds !== true
  ) {
    throw new Error(
      "Researcher output must confirm existing LegalAction.id usage",
    );
  }
  const disallowedCompatibilityFlags = [
    "rawIntentPathRequired",
    "newRunnerRequired",
    "newActionSchemaRequired",
    "newValidatorRequired",
    "newObjectiveKindRequired",
    "coreChangesRequired",
  ] as const;
  for (const key of disallowedCompatibilityFlags) {
    if (value.canonicalCompliance[key]) {
      throw new Error(
        `Researcher proposal is not canonical-compatible: ${key}=true`,
      );
    }
  }
  return value;
}

function researcherProposalMarkdown(proposal: ResearcherProposal): string {
  return [
    `# ${proposal.proposal.title}`,
    "",
    "## Summary",
    proposal.summary,
    "",
    "## Failure Pattern",
    proposal.failurePattern,
    "",
    "## Evidence",
    ...proposal.evidence.map((item) =>
      [
        `- ${item.artifact}${item.run ? ` ${item.run}` : ""}${item.turn !== null && item.turn !== undefined ? ` turn ${item.turn}` : ""}: ${item.claim}`,
        item.selectedActionId ? `  Selected: \`${item.selectedActionId}\`` : "",
        item.metric ? `  Metric: ${item.metric}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "",
    "## Hypothesis",
    proposal.hypothesis,
    "",
    "## Planner Controls",
    `Objective: ${proposal.plannerControls.objective ?? "none"}`,
    `Preferred actions: ${proposal.plannerControls.preferredActionKinds.join(", ") || "none"}`,
    `Enabled modules: ${proposal.plannerControls.enabledModules.join(", ") || "none"}`,
    `Tactical settings: ${proposal.plannerControls.tacticalSettingsChange}`,
    "",
    "## Proposed Change",
    proposal.proposal.change,
    "",
    `Allowed files: ${proposal.proposal.allowedFiles.map((file) => `\`${file}\``).join(", ")}`,
    "",
    "Expected metric movement:",
    proposal.proposal.expectedMetricMovement,
    "",
    "Reject criteria:",
    ...proposal.proposal.rejectCriteria.map((item) => `- ${item}`),
    "",
    "## A/B Benchmark",
    `Baseline: \`${proposal.abBenchmark.baselineCommand}\``,
    "",
    `Candidate: \`${proposal.abBenchmark.candidateCommand}\``,
    "",
    "Metrics:",
    ...proposal.abBenchmark.metrics.map((item) => `- ${item}`),
    "",
    "## Canonical Compliance",
    ...Object.entries(proposal.canonicalCompliance).map(
      ([key, value]) => `- ${key}: ${value}`,
    ),
    "",
    "## Missing Observation Fields",
    ...(proposal.missingObservationFields.length === 0
      ? ["- None"]
      : proposal.missingObservationFields.map((item) => `- ${item}`)),
    "",
    "## Risk Notes",
    ...(proposal.riskNotes.length === 0
      ? ["- None"]
      : proposal.riskNotes.map((item) => `- ${item}`)),
    "",
  ].join("\n");
}

async function latestBenchmarkID(rootDir: string): Promise<string | null> {
  let entries: Array<{ name: string; mtimeMs: number; isDirectory: boolean }>;
  try {
    entries = await Promise.all(
      (await fs.readdir(rootDir)).map(async (name) => {
        const stat = await fs.stat(path.join(rootDir, name));
        return { name, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory() };
      }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return (
    entries
      .filter((entry) => entry.isDirectory)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name ?? null
  );
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function stringArg(args: string[], prefix: string): string | null {
  return (
    args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
  );
}

function positiveIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
): number {
  const raw = args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${prefix}${raw} must be a positive integer`);
  }
  return value;
}

function runIndexFromFilename(filename: string): number {
  const match = /^run-(\d+)\.records\.json$/.exec(filename);
  return match === null ? 0 : Number(match[1]);
}

function clip(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  const head = Math.floor(maxLength * 0.7);
  const tail = Math.max(0, maxLength - head - 40);
  return `${value.slice(0, head)}\n\n[... clipped ...]\n\n${value.slice(-tail)}`;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
