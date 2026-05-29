import fs from "fs/promises";
import path from "path";

interface DecisionRecord {
  turnNumber?: number;
  chosenActionID?: string;
  chosenActionKind?: string;
  decisionLatencyMs?: number;
  reason?: string;
  decisionMetadata?: Record<string, unknown>;
}

interface BenchmarkSide {
  id: string;
  label: string;
  records: DecisionRecord[];
  reportText: string | null;
}

interface SideSummary {
  id: string;
  label: string;
  recordCount: number;
  externalPlannerCalls: number;
  rawProviderOutputs: number;
  plannerFallbacks: number;
  plannerParseFailures: number;
  averageDecisionLatencyMs: number;
  averageExternalPlannerLatencyMs: number;
  objectiveCounts: Record<string, number>;
  turnIntentCounts: Record<string, number>;
  selectedActionKindCounts: Record<string, number>;
  preferredActionKindCounts: Record<string, number>;
  reportOutcome: string | null;
}

interface PlannerDrift {
  turnNumber: number;
  baselineObjective: string;
  candidateObjective: string;
  baselineTurnIntent: string;
  candidateTurnIntent: string;
  baselineAction: string;
  candidateAction: string;
  baselinePreferred: string;
  candidatePreferred: string;
}

async function run() {
  const args = process.argv.slice(2);
  const baselineID = requiredStringArg(args, "--baseline-id=");
  const candidateID = requiredStringArg(args, "--candidate-id=");
  const baselineLabel = stringArg(args, "--baseline-label=") ?? "baseline";
  const candidateLabel = stringArg(args, "--candidate-label=") ?? "candidate";
  const outputID =
    stringArg(args, "--out-id=") ?? `${baselineID}-vs-${candidateID}`;
  const rootDir = path.resolve(process.cwd(), "artifacts/ai-league-benchmarks");
  const outputDir =
    stringArg(args, "--out-dir=") ??
    path.resolve(process.cwd(), "artifacts/ai-planner-comparisons", outputID);

  const baseline = await readBenchmarkSide(rootDir, baselineID, baselineLabel);
  const candidate = await readBenchmarkSide(
    rootDir,
    candidateID,
    candidateLabel,
  );
  const comparison = {
    baseline: summarizeSide(baseline),
    candidate: summarizeSide(candidate),
    drift: plannerDrift(baseline, candidate),
    candidatePlannerCalls: plannerCallRows(candidate),
  };

  await fs.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "planner-comparison.json");
  const markdownPath = path.join(outputDir, "planner-comparison.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`);
  await fs.writeFile(markdownPath, plannerComparisonMarkdown(comparison));

  console.log("Planner comparison complete", {
    comparisonID: outputID,
    report: markdownPath,
    json: jsonPath,
  });
}

async function readBenchmarkSide(
  rootDir: string,
  id: string,
  label: string,
): Promise<BenchmarkSide> {
  const dir = path.join(rootDir, id);
  const filenames = (await fs.readdir(dir))
    .filter((filename) => /^run-\d+\.records\.json$/.test(filename))
    .sort();
  const records = (
    await Promise.all(
      filenames.map(async (filename) =>
        JSON.parse(await fs.readFile(path.join(dir, filename), "utf8")),
      ),
    )
  ).flat() as DecisionRecord[];
  return {
    id,
    label,
    records,
    reportText: await readOptional(path.join(dir, "benchmark-report.md")),
  };
}

function summarizeSide(side: BenchmarkSide): SideSummary {
  const externalPlannerRecords = side.records.filter(
    (record) => metadataBoolean(record, "externalPlannerCall") === true,
  );
  return {
    id: side.id,
    label: side.label,
    recordCount: side.records.length,
    externalPlannerCalls: externalPlannerRecords.length,
    rawProviderOutputs: side.records.filter(
      (record) => metadataString(record, "plannerRawOutput") !== "",
    ).length,
    plannerFallbacks: side.records.filter(
      (record) => metadataBoolean(record, "plannerFallbackUsed") === true,
    ).length,
    plannerParseFailures: side.records.filter(
      (record) => metadataBoolean(record, "plannerParseOk") === false,
    ).length,
    averageDecisionLatencyMs: average(
      side.records.map((record) => record.decisionLatencyMs ?? 0),
    ),
    averageExternalPlannerLatencyMs: average(
      externalPlannerRecords.map((record) =>
        metadataNumber(record, "plannerLatencyMs"),
      ),
    ),
    objectiveCounts: countValues(
      side.records.map((record) => metadataString(record, "planObjective")),
    ),
    turnIntentCounts: countValues(
      side.records.map((record) => metadataString(record, "planTurnIntent")),
    ),
    selectedActionKindCounts: countValues(
      side.records.map((record) => record.chosenActionKind ?? "unknown"),
    ),
    preferredActionKindCounts: countValues(
      side.records.flatMap((record) =>
        splitMetadataList(metadataString(record, "planPreferredActionKinds")),
      ),
    ),
    reportOutcome: reportOutcome(side.reportText),
  };
}

function plannerDrift(
  baseline: BenchmarkSide,
  candidate: BenchmarkSide,
): PlannerDrift[] {
  const baselineByKey = recordsByTurnOccurrence(baseline.records);
  const candidateByKey = recordsByTurnOccurrence(candidate.records);
  const rows: PlannerDrift[] = [];
  for (const [key, candidateRecord] of candidateByKey) {
    const baselineRecord = baselineByKey.get(key);
    if (baselineRecord === undefined) {
      continue;
    }
    const baselineObjective = metadataString(baselineRecord, "planObjective");
    const candidateObjective = metadataString(candidateRecord, "planObjective");
    const baselineTurnIntent = metadataString(baselineRecord, "planTurnIntent");
    const candidateTurnIntent = metadataString(
      candidateRecord,
      "planTurnIntent",
    );
    const baselineAction = actionSummary(baselineRecord);
    const candidateAction = actionSummary(candidateRecord);
    const baselinePreferred = metadataString(
      baselineRecord,
      "planPreferredActionKinds",
    );
    const candidatePreferred = metadataString(
      candidateRecord,
      "planPreferredActionKinds",
    );
    if (
      baselineObjective !== candidateObjective ||
      baselineTurnIntent !== candidateTurnIntent ||
      baselineAction !== candidateAction ||
      baselinePreferred !== candidatePreferred
    ) {
      rows.push({
        turnNumber: candidateRecord.turnNumber ?? 0,
        baselineObjective,
        candidateObjective,
        baselineTurnIntent,
        candidateTurnIntent,
        baselineAction,
        candidateAction,
        baselinePreferred,
        candidatePreferred,
      });
    }
  }
  return rows.slice(0, 80);
}

function recordsByTurnOccurrence(
  records: DecisionRecord[],
): Map<string, DecisionRecord> {
  const turnCounts = new Map<number, number>();
  const keyed = new Map<string, DecisionRecord>();
  for (const record of records) {
    if (typeof record.turnNumber !== "number") {
      continue;
    }
    const occurrence = turnCounts.get(record.turnNumber) ?? 0;
    turnCounts.set(record.turnNumber, occurrence + 1);
    keyed.set(`${record.turnNumber}:${occurrence}`, record);
  }
  return keyed;
}

function plannerCallRows(side: BenchmarkSide) {
  return side.records
    .filter((record) => metadataBoolean(record, "externalPlannerCall") === true)
    .map((record) => ({
      turnNumber: record.turnNumber ?? null,
      objective: metadataString(record, "planObjective"),
      turnIntent: metadataString(record, "planTurnIntent"),
      preferredActionKinds: metadataString(record, "planPreferredActionKinds"),
      enabledModules: metadataString(record, "planEnabledModules"),
      targetPlayerId: metadataString(record, "planTargetPlayerId") || null,
      maxDecisionCycles: metadataNumber(record, "planMaxDecisionCycles"),
      plannerLatencyMs: metadataNumber(record, "plannerLatencyMs"),
      rationale: metadataString(record, "planRationale"),
      selectedAction: actionSummary(record),
    }));
}

function plannerComparisonMarkdown(input: {
  baseline: SideSummary;
  candidate: SideSummary;
  drift: PlannerDrift[];
  candidatePlannerCalls: ReturnType<typeof plannerCallRows>;
}): string {
  return [
    `# Planner Comparison ${input.baseline.id} vs ${input.candidate.id}`,
    "",
    "## Summary",
    summaryTable([input.baseline, input.candidate]),
    "",
    "## Objective Counts",
    countTable(
      "Objective",
      input.baseline.objectiveCounts,
      input.candidate.objectiveCounts,
    ),
    "",
    "## Turn Intent Counts",
    countTable(
      "Turn intent",
      input.baseline.turnIntentCounts,
      input.candidate.turnIntentCounts,
    ),
    "",
    "## Selected Action Kinds",
    countTable(
      "Action kind",
      input.baseline.selectedActionKindCounts,
      input.candidate.selectedActionKindCounts,
    ),
    "",
    "## Candidate Planner Calls",
    "| Turn | Objective | Intent | Preferred | Modules | Latency ms | Selected | Rationale |",
    "| ---: | --- | --- | --- | --- | ---: | --- | --- |",
    ...input.candidatePlannerCalls.map(
      (row) =>
        `| ${row.turnNumber ?? ""} | ${escapeCell(row.objective)} | ${escapeCell(row.turnIntent)} | ${escapeCell(row.preferredActionKinds)} | ${escapeCell(row.enabledModules)} | ${Math.round(row.plannerLatencyMs)} | ${escapeCell(row.selectedAction)} | ${escapeCell(row.rationale)} |`,
    ),
    "",
    "## Drift Examples",
    "| Turn | Baseline objective | Candidate objective | Baseline intent | Candidate intent | Baseline action | Candidate action |",
    "| ---: | --- | --- | --- | --- | --- | --- |",
    ...input.drift
      .slice(0, 40)
      .map(
        (row) =>
          `| ${row.turnNumber} | ${escapeCell(row.baselineObjective)} | ${escapeCell(row.candidateObjective)} | ${escapeCell(row.baselineTurnIntent)} | ${escapeCell(row.candidateTurnIntent)} | ${escapeCell(row.baselineAction)} | ${escapeCell(row.candidateAction)} |`,
      ),
    "",
  ].join("\n");
}

function summaryTable(sides: SideSummary[]): string {
  return [
    "| Side | Benchmark | Outcome | Records | External planner calls | Parse failures | Fallbacks | Avg decision ms | Avg planner ms |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...sides.map(
      (side) =>
        `| ${escapeCell(side.label)} | \`${side.id}\` | ${escapeCell(side.reportOutcome ?? "unknown")} | ${side.recordCount} | ${side.externalPlannerCalls} | ${side.plannerParseFailures} | ${side.plannerFallbacks} | ${Math.round(side.averageDecisionLatencyMs)} | ${Math.round(side.averageExternalPlannerLatencyMs)} |`,
    ),
  ].join("\n");
}

function countTable(
  label: string,
  baseline: Record<string, number>,
  candidate: Record<string, number>,
): string {
  const keys = [
    ...new Set([...Object.keys(baseline), ...Object.keys(candidate)]),
  ]
    .filter((key) => key !== "")
    .sort();
  return [
    `| ${label} | Baseline | Candidate | Delta |`,
    "| --- | ---: | ---: | ---: |",
    ...keys.map((key) => {
      const left = baseline[key] ?? 0;
      const right = candidate[key] ?? 0;
      return `| ${escapeCell(key)} | ${left} | ${right} | ${right - left >= 0 ? "+" : ""}${right - left} |`;
    }),
  ].join("\n");
}

function actionSummary(record: DecisionRecord): string {
  return `${record.chosenActionKind ?? "unknown"}/${record.chosenActionID ?? "unknown"}`;
}

function metadataString(record: DecisionRecord, key: string): string {
  const value = record.decisionMetadata?.[key];
  return typeof value === "string" ? value : "";
}

function metadataBoolean(record: DecisionRecord, key: string): boolean | null {
  const value = record.decisionMetadata?.[key];
  return typeof value === "boolean" ? value : null;
}

function metadataNumber(record: DecisionRecord, key: string): number {
  const value = record.decisionMetadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function splitMetadataList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function countValues(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    if (value === "") {
      return counts;
    }
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function average(values: number[]): number {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return 0;
  }
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function reportOutcome(reportText: string | null): string | null {
  if (reportText === null) {
    return null;
  }
  return reportText.match(/^Result: (.+)$/m)?.[1] ?? null;
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 260);
}

function stringArg(args: string[], prefix: string): string | null {
  return (
    args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
  );
}

function requiredStringArg(args: string[], prefix: string): string {
  const value = stringArg(args, prefix);
  if (value === null || value.trim() === "") {
    throw new Error(`Missing required ${prefix}<value>`);
  }
  return value;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
