import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const workspace = path.resolve(import.meta.dirname, "..");
const runsRoot = path.join(workspace, "artifacts", "ai-league-runs");
const outputRoot = path.join(workspace, "tmp", "proxywar-sft-mini-data");

function hash32(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function offeredKinds(record) {
  return Object.entries(record.legalActionIDsByKind ?? {})
    .filter(([, ids]) => Array.isArray(ids) && ids.length > 0)
    .map(([kind, ids]) => ({ kind, count: ids.length }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

function splitForRun(runID) {
  const bucket = hash32(runID) % 10;
  if (bucket === 0) return "test";
  if (bucket === 1) return "valid";
  return "train";
}

function isClean(record) {
  const offered = offeredKinds(record).map(({ kind }) => kind);
  return (
    record.brainType === "planner-executor" &&
    record.plannerSource === "real-llm" &&
    record.fallbackUsed === false &&
    record.plannerFallbackUsed === false &&
    record.plannerParseSuccess !== false &&
    typeof record.observationSummary === "string" &&
    typeof record.selectedActionKind === "string" &&
    offered.includes(record.selectedActionKind)
  );
}

function promptFor(record) {
  const menu = offeredKinds(record)
    .map(({ kind, count }) => `${kind}(${count})`)
    .join(", ");
  const state = record.observationSummary.replaceAll(/\s+/g, " ").slice(0, 1400);
  return [
    "You are selecting one ProxyWar action kind.",
    "Choose only from the offered kinds and return exactly the kind name, with no explanation.",
    `Profile: ${record.profile ?? "unknown"}`,
    `State: ${state}`,
    `Offered: ${menu}`,
  ].join("\n");
}

const candidates = { train: [], valid: [], test: [] };
const files = (await fs.promises.readdir(runsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(runsRoot, entry.name, "decisions.jsonl"))
  .sort();

for (const file of files) {
  const runID = path.basename(path.dirname(file));
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  if (stat.size === 0) continue;
  const split = splitForRun(runID);
  const stream = fs.createReadStream(file, "utf8");
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isClean(record)) continue;
    const sequence = Number(record.sequence ?? 0);
    candidates[split].push({
      order: hash32(`${runID}:${sequence}:${record.selectedActionKind}`),
      runID,
      label: record.selectedActionKind,
      row: {
        messages: [
          { role: "user", content: promptFor(record) },
          { role: "assistant", content: record.selectedActionKind },
        ],
      },
    });
  }
}

const limits = { train: 5000, valid: 500, test: 500 };
await fs.promises.mkdir(outputRoot, { recursive: true });
const metadata = {
  schema: "proxywar-mini-sft-action-kind/v1",
  purpose:
    "Tiny offline imitation-signal probe only; not a transition dataset or gameplay proof.",
  splits: {},
};
for (const split of ["train", "valid", "test"]) {
  const selected = candidates[split]
    .sort((left, right) => left.order - right.order)
    .slice(0, limits[split]);
  const output = selected.map(({ row }) => JSON.stringify(row)).join("\n") + "\n";
  await fs.promises.writeFile(path.join(outputRoot, `${split}.jsonl`), output);
  const labelCounts = {};
  for (const example of selected) {
    labelCounts[example.label] = (labelCounts[example.label] ?? 0) + 1;
  }
  metadata.splits[split] = {
    available: candidates[split].length,
    written: selected.length,
    runs: new Set(selected.map(({ runID }) => runID)).size,
    labelCounts,
  };
}
await fs.promises.writeFile(
  path.join(outputRoot, "metadata.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
);
console.log(JSON.stringify(metadata, null, 2));
