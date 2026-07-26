import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const workspace = path.resolve(import.meta.dirname, "..");
const runsRoot = path.join(workspace, "artifacts", "ai-league-runs");

function hash32(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .match(/[a-z][a-z0-9_-]{1,39}|\d{1,6}/g)
    ?.slice(0, 600) ?? [];
}

function offeredKinds(record) {
  return Object.entries(record.legalActionIDsByKind ?? {})
    .filter(([, ids]) => Array.isArray(ids) && ids.length > 0)
    .map(([kind]) => kind)
    .sort();
}

function menuSignature(record) {
  return Object.entries(record.legalActionIDsByKind ?? {})
    .filter(([, ids]) => Array.isArray(ids) && ids.length > 0)
    .map(([kind, ids]) => `${kind}:${Math.min(ids.length, 9)}`)
    .sort()
    .join("|");
}

function featureTokens(record, includePlan) {
  const result = tokens(record.observationSummary);
  result.push(`profile=${record.profile ?? "unknown"}`);
  for (const [kind, ids] of Object.entries(record.legalActionIDsByKind ?? {})) {
    if (!Array.isArray(ids) || ids.length === 0) continue;
    result.push(`offered=${kind}`);
    result.push(`offered_count=${kind}:${Math.min(ids.length, 9)}`);
  }
  if (includePlan) {
    result.push(...tokens(record.objectiveKind));
    result.push(...tokens(record.objectiveSummary));
    result.push(...tokens(record.planObjective));
    result.push(...tokens(record.strategicPriority));
    result.push(...tokens(record.strategicUrgency));
  }
  return result;
}

function isCleanExample(record) {
  return (
    record.brainType === "planner-executor" &&
    record.plannerSource === "real-llm" &&
    record.fallbackUsed === false &&
    record.plannerFallbackUsed === false &&
    record.plannerParseSuccess !== false &&
    typeof record.observationSummary === "string" &&
    typeof record.selectedActionKind === "string" &&
    typeof record.selectedLegalActionId === "string" &&
    offeredKinds(record).includes(record.selectedActionKind)
  );
}

async function decisionFiles(root) {
  const files = [];
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, "decisions.jsonl");
    try {
      const stat = await fs.promises.stat(candidate);
      if (stat.size > 0) files.push(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return files.sort();
}

async function loadExamples() {
  const examples = [];
  const files = await decisionFiles(runsRoot);
  for (const file of files) {
    const runID = path.basename(path.dirname(file));
    const split = hash32(runID) % 5 === 0 ? "test" : "train";
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
      if (!isCleanExample(record)) continue;
      examples.push({
        runID,
        split,
        label: record.selectedActionKind,
        offered: offeredKinds(record),
        signature: menuSignature(record),
        stateTokens: featureTokens(record, false),
        planTokens: featureTokens(record, true),
      });
    }
  }
  return examples;
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function trainNaiveBayes(examples, tokenField) {
  const classCounts = new Map();
  const tokenCounts = new Map();
  const classTokenTotals = new Map();
  const vocabulary = new Set();
  const signatureCounts = new Map();
  for (const example of examples) {
    increment(classCounts, example.label);
    const byToken = tokenCounts.get(example.label) ?? new Map();
    tokenCounts.set(example.label, byToken);
    for (const token of example[tokenField]) {
      vocabulary.add(token);
      increment(byToken, token);
      increment(classTokenTotals, example.label);
    }
    const byLabel = signatureCounts.get(example.signature) ?? new Map();
    signatureCounts.set(example.signature, byLabel);
    increment(byLabel, example.label);
  }
  return {
    classCounts,
    tokenCounts,
    classTokenTotals,
    vocabularySize: vocabulary.size,
    signatureCounts,
    total: examples.length,
  };
}

function bestAllowed(counts, allowed) {
  let best = null;
  let bestCount = -1;
  for (const label of allowed) {
    const count = counts.get(label) ?? 0;
    if (count > bestCount || (count === bestCount && label < best)) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}

function predict(model, example, tokenField) {
  const candidates = example.offered.filter((label) => model.classCounts.has(label));
  const allowed = candidates.length > 0 ? candidates : [...model.classCounts.keys()];
  const frequencies = new Map();
  for (const token of example[tokenField]) increment(frequencies, token);
  let best = allowed[0];
  let bestScore = -Infinity;
  const alpha = 0.25;
  for (const label of allowed) {
    const classCount = model.classCounts.get(label) ?? 0;
    let score = Math.log((classCount + 1) / (model.total + model.classCounts.size));
    const byToken = model.tokenCounts.get(label) ?? new Map();
    const denominator =
      (model.classTokenTotals.get(label) ?? 0) + alpha * model.vocabularySize;
    for (const [token, frequency] of frequencies) {
      score +=
        frequency * Math.log(((byToken.get(token) ?? 0) + alpha) / denominator);
    }
    if (score > bestScore) {
      best = label;
      bestScore = score;
    }
  }
  return best;
}

function evaluate(train, test, tokenField) {
  const model = trainNaiveBayes(train, tokenField);
  let globalCorrect = 0;
  let signatureCorrect = 0;
  let modelCorrect = 0;
  const truthCounts = new Map();
  const truePositive = new Map();
  const predictedCounts = new Map();
  for (const example of test) {
    const allowed = example.offered.filter((label) => model.classCounts.has(label));
    const candidates = allowed.length > 0 ? allowed : [...model.classCounts.keys()];
    const globalPrediction = bestAllowed(model.classCounts, candidates);
    const signaturePrediction = bestAllowed(
      model.signatureCounts.get(example.signature) ?? model.classCounts,
      candidates,
    );
    const modelPrediction = predict(model, example, tokenField);
    if (globalPrediction === example.label) globalCorrect++;
    if (signaturePrediction === example.label) signatureCorrect++;
    if (modelPrediction === example.label) {
      modelCorrect++;
      increment(truePositive, example.label);
    }
    increment(truthCounts, example.label);
    increment(predictedCounts, modelPrediction);
  }
  const f1s = [...truthCounts.keys()].map((label) => {
    const tp = truePositive.get(label) ?? 0;
    const precision = tp / Math.max(1, predictedCounts.get(label) ?? 0);
    const recall = tp / Math.max(1, truthCounts.get(label) ?? 0);
    return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  });
  return {
    mode: tokenField,
    trainExamples: train.length,
    testExamples: test.length,
    classes: model.classCounts.size,
    vocabulary: model.vocabularySize,
    constrainedGlobalAccuracy: globalCorrect / test.length,
    menuSignatureAccuracy: signatureCorrect / test.length,
    naiveBayesAccuracy: modelCorrect / test.length,
    naiveBayesMacroF1: f1s.reduce((sum, value) => sum + value, 0) / f1s.length,
  };
}

const examples = await loadExamples();
const train = examples.filter((example) => example.split === "train");
const test = examples.filter((example) => example.split === "test");
const trainRuns = new Set(train.map((example) => example.runID));
const testRuns = new Set(test.map((example) => example.runID));
if (train.length === 0 || test.length === 0) {
  throw new Error("The deterministic whole-run split produced an empty arm");
}

console.log(
  JSON.stringify(
    {
      probe: "proxywar-clean-real-llm-action-kind-signal/v1",
      interpretation:
        "Cheap learnability preflight only; this is not an SFT checkpoint or closed-loop policy evaluation.",
      examples: examples.length,
      trainRuns: trainRuns.size,
      testRuns: testRuns.size,
      overlapRuns: [...trainRuns].filter((runID) => testRuns.has(runID)).length,
      results: [
        evaluate(train, test, "stateTokens"),
        evaluate(train, test, "planTokens"),
      ],
    },
    null,
    2,
  ),
);
