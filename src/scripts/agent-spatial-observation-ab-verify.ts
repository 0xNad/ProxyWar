import fs from "node:fs/promises";
import path from "node:path";

const OFF_RUN_ID = "spatial-ab-off";
const ON_RUN_ID = "spatial-ab-on";
const ARTIFACT_ROOT = path.resolve(
  process.cwd(),
  "artifacts/ai-league-benchmarks",
);
const BEHAVIOR_FIELDS = [
  "sequence",
  "turnNumber",
  "chosenActionID",
  "chosenActionKind",
  "legalActionIDs",
  "legalActionIDsByKind",
  "intent",
  "result",
  "audit",
] as const;

interface ArmSummary {
  config: {
    runID: string;
    runs: number;
    startIndex: number;
    [key: string]: unknown;
  };
  attribution: {
    sourceCommit: string;
    sourceTreeState: "clean" | "dirty" | "unavailable";
    spatialObservationEnabled: boolean;
    spatialMinimapEnabled: boolean;
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

function comparableConfig(summary: ArmSummary): Record<string, unknown> {
  const { runID: _runID, ...config } = summary.config;
  return config;
}

function comparableRecords(records: Array<Record<string, unknown>>) {
  return records.map((record) =>
    Object.fromEntries(BEHAVIOR_FIELDS.map((field) => [field, record[field]])),
  );
}

const offSummary = await readJson<ArmSummary>(
  path.join(ARTIFACT_ROOT, OFF_RUN_ID, "benchmark-summary.json"),
);
const onSummary = await readJson<ArmSummary>(
  path.join(ARTIFACT_ROOT, ON_RUN_ID, "benchmark-summary.json"),
);
const sourceCommit = offSummary.attribution.sourceCommit;
const attributionChecks = {
  sameSourceCommit:
    /^[0-9a-f]{40}$/.test(sourceCommit) &&
    onSummary.attribution.sourceCommit === sourceCommit,
  cleanSourceTrees:
    offSummary.attribution.sourceTreeState === "clean" &&
    onSummary.attribution.sourceTreeState === "clean",
  offFlags:
    offSummary.attribution.spatialObservationEnabled === false &&
    offSummary.attribution.spatialMinimapEnabled === false,
  onFlags:
    onSummary.attribution.spatialObservationEnabled === true &&
    onSummary.attribution.spatialMinimapEnabled === false,
  equivalentConfig:
    JSON.stringify(comparableConfig(offSummary)) ===
    JSON.stringify(comparableConfig(onSummary)),
};

const runResults: Array<{
  runIndex: number;
  recordsOff: number;
  recordsOn: number;
  behaviorEqual: boolean;
}> = [];
let totalDecisionsPerArm = 0;
for (
  let index = offSummary.config.startIndex;
  index < offSummary.config.startIndex + offSummary.config.runs;
  index++
) {
  const offRecords = await readJson<Array<Record<string, unknown>>>(
    path.join(ARTIFACT_ROOT, OFF_RUN_ID, `run-${index}.records.json`),
  );
  const onRecords = await readJson<Array<Record<string, unknown>>>(
    path.join(ARTIFACT_ROOT, ON_RUN_ID, `run-${index}.records.json`),
  );
  const behaviorEqual =
    JSON.stringify(comparableRecords(offRecords)) ===
    JSON.stringify(comparableRecords(onRecords));
  runResults.push({
    runIndex: index,
    recordsOff: offRecords.length,
    recordsOn: onRecords.length,
    behaviorEqual,
  });
  totalDecisionsPerArm += offRecords.length;
}

const report = {
  schemaVersion: 1,
  sourceCommit,
  arms: {
    off: offSummary.attribution,
    on: onSummary.attribution,
  },
  comparedBehaviorFields: BEHAVIOR_FIELDS,
  attributionChecks,
  runResults,
  totalDecisionsPerArm,
  targetMet:
    Object.values(attributionChecks).every(Boolean) &&
    runResults.length >= 3 &&
    runResults.every(
      (run) =>
        run.recordsOff > 0 &&
        run.behaviorEqual &&
        run.recordsOff === run.recordsOn,
    ),
};
const outputPath = path.join(
  ARTIFACT_ROOT,
  "spatial-observation-ab-report.json",
);
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, outputPath }, null, 2));
if (!report.targetMet) process.exitCode = 1;
