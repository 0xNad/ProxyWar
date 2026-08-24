#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PREFIX = "PROXYWAR_SPATIAL_GATE ";
const ARMS = ["off", "structured", "full"];

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : null;
}

function rounded(value, digits = 4) {
  return value === null ? null : Number(value.toFixed(digits));
}

function parseArgs(argv) {
  const output = argv.find((arg) => arg.startsWith("--output="))?.slice(9);
  const files = argv.filter((arg) => !arg.startsWith("--"));
  if (files.length === 0) {
    throw new Error(
      "usage: node analyze-spatial-probes.mjs [--output=report.json] log...",
    );
  }
  return { files, output };
}

async function readEvents(files) {
  const events = [];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    for (const [lineIndex, line] of text.split(/\r?\n/u).entries()) {
      const marker = line.indexOf(PREFIX);
      if (marker < 0) continue;
      let event;
      try {
        event = JSON.parse(line.slice(marker + PREFIX.length));
      } catch (error) {
        throw new Error(
          `invalid probe JSON ${file}:${lineIndex + 1}: ${error.message}`,
          { cause: error },
        );
      }
      events.push({ ...event, evidenceFile: path.resolve(file) });
    }
  }
  return events;
}

function uniqueBy(events, keyFor) {
  const byKey = new Map();
  const conflicting = [];
  for (const event of events) {
    const key = keyFor(event);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, event);
      continue;
    }
    if (JSON.stringify(previous) !== JSON.stringify(event)) {
      conflicting.push(key);
    }
  }
  return { events: [...byKey.values()], conflicting };
}

function gate1ArmReport(events, arm) {
  const selected = events.filter((event) => event.arm === arm && event.gate1);
  const unique = uniqueBy(
    selected,
    (event) => `${event.arm}:${event.gate1.scenarioID}`,
  );
  const shared = unique.events.filter(
    (event) => event.gate1.visibilityRequirement === "structured",
  );
  const minimap = unique.events.filter(
    (event) => event.gate1.visibilityRequirement === "minimap",
  );
  const correct = (rows) => rows.filter((event) => event.gate1.correct).length;
  return {
    rawEvents: selected.length,
    uniqueScenarios: unique.events.length,
    duplicateEvents: selected.length - unique.events.length,
    conflictingDuplicates: unique.conflicting,
    providerSuccess: rounded(
      ratio(
        unique.events.filter((event) => event.providerOK).length,
        unique.events.length,
      ),
    ),
    parseSuccess: rounded(
      ratio(
        unique.events.filter((event) => event.parseOK).length,
        unique.events.length,
      ),
    ),
    overallAccuracy: rounded(
      ratio(correct(unique.events), unique.events.length),
    ),
    structuredCases: shared.length,
    structuredAccuracy: rounded(ratio(correct(shared), shared.length)),
    minimapCases: minimap.length,
    minimapAccuracy: rounded(ratio(correct(minimap), minimap.length)),
    inputTokens: unique.events.reduce(
      (sum, event) => sum + (Number(event.inputTokens) || 0),
      0,
    ),
    outputTokens: unique.events.reduce(
      (sum, event) => sum + (Number(event.outputTokens) || 0),
      0,
    ),
    meanInputTokens: rounded(
      mean(unique.events.map((event) => Number(event.inputTokens))),
      2,
    ),
    meanLatencyMs: rounded(
      mean(unique.events.map((event) => Number(event.latencyMs))),
      2,
    ),
  };
}

function gate1Report(events) {
  const arms = Object.fromEntries(
    ARMS.map((arm) => [arm, gate1ArmReport(events, arm)]),
  );
  const cardinalityPass = ARMS.every(
    (arm) =>
      arms[arm].uniqueScenarios === 200 &&
      arms[arm].structuredCases === 160 &&
      arms[arm].minimapCases === 40 &&
      arms[arm].conflictingDuplicates.length === 0,
  );
  const reliabilityPass = ARMS.every(
    (arm) =>
      arms[arm].providerSuccess !== null &&
      arms[arm].providerSuccess >= 0.99 &&
      arms[arm].parseSuccess !== null &&
      arms[arm].parseSuccess >= 0.99,
  );
  const structuredPass =
    cardinalityPass &&
    reliabilityPass &&
    arms.off.overallAccuracy >= 0.9 &&
    arms.structured.structuredAccuracy >= 0.9 &&
    arms.structured.minimapAccuracy >= 0.9 &&
    arms.full.structuredAccuracy >= arms.structured.structuredAccuracy - 0.02;
  const minimapPass =
    structuredPass &&
    arms.full.minimapAccuracy !== null &&
    arms.full.minimapAccuracy >= 0.85;
  return {
    arms,
    cardinalityPass,
    reliabilityPass,
    structuredPass,
    minimapPass,
  };
}

function gate2Key(event) {
  return [
    event.gameID,
    event.turnNumber,
    event.activeIndex,
    event.gate2?.taskClass,
    event.gate2?.metric,
    event.gate2?.candidateActionIDs?.join("\u0000"),
  ].join("|");
}

function gate2Report(events) {
  const selected = events.filter((event) => event.gate2);
  const byArm = Object.fromEntries(ARMS.map((arm) => [arm, new Map()]));
  for (const event of selected) {
    if (!byArm[event.arm]) continue;
    byArm[event.arm].set(gate2Key(event), event);
  }
  const keys = [...byArm.off.keys()].filter(
    (key) => byArm.structured.has(key) && byArm.full.has(key),
  );
  const unmatched = Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      [...byArm[arm].keys()].filter((key) => !keys.includes(key)).length,
    ]),
  );
  const joined = [];
  for (const key of keys) {
    const triplet = Object.fromEntries(
      ARMS.map((arm) => [arm, byArm[arm].get(key)]),
    );
    const menusMatch =
      new Set(ARMS.map((arm) => triplet[arm].offeredMenuSHA256)).size === 1;
    const carriersMatch =
      new Set(ARMS.map((arm) => triplet[arm].carrierActionID)).size === 1;
    const fidelity = ARMS.every(
      (arm) =>
        triplet[arm].carrierActionOffered === true &&
        triplet[arm].gate2.candidatesOffered === true,
    );
    const reliable = ARMS.every(
      (arm) =>
        triplet[arm].providerOK === true && triplet[arm].parseOK === true,
    );
    const taskClass = triplet.full.gate2.taskClass;
    const truth =
      taskClass === "structured_target"
        ? triplet.structured.gate2.expected
        : triplet.full.gate2.expected;
    const truthAvailable = typeof truth === "string" && truth !== "unknown";
    const answerCorrect = Object.fromEntries(
      ARMS.map((arm) => [arm, triplet[arm].gate2.answer === truth]),
    );
    joined.push({
      key,
      taskClass,
      truth,
      truthAvailable,
      menusMatch,
      carriersMatch,
      fidelity,
      reliable,
      answerCorrect,
    });
  }
  const eligible = joined.filter(
    (row) =>
      row.truthAvailable &&
      row.menusMatch &&
      row.carriersMatch &&
      row.fidelity &&
      row.reliable,
  );
  const structuredRows = eligible.filter(
    (row) => row.taskClass === "structured_target",
  );
  const minimapRows = eligible.filter(
    (row) => row.taskClass === "minimap_tile",
  );
  const accuracy = (rows, arm) =>
    rounded(
      ratio(rows.filter((row) => row.answerCorrect[arm]).length, rows.length),
    );
  const structuredAccuracy = Object.fromEntries(
    ARMS.map((arm) => [arm, accuracy(structuredRows, arm)]),
  );
  const minimapAccuracy = Object.fromEntries(
    ARMS.map((arm) => [arm, accuracy(minimapRows, arm)]),
  );
  const providerParseSuccess = rounded(
    ratio(
      selected.filter((event) => event.providerOK && event.parseOK).length,
      selected.length,
    ),
  );
  const fidelityPass = joined.every(
    (row) => row.menusMatch && row.carriersMatch && row.fidelity,
  );
  const structuredPass =
    structuredRows.length >= 40 &&
    providerParseSuccess !== null &&
    providerParseSuccess >= 0.99 &&
    fidelityPass &&
    structuredAccuracy.structured >= 0.8 &&
    structuredAccuracy.structured - structuredAccuracy.off >= 0.15 &&
    structuredAccuracy.full >= structuredAccuracy.structured - 0.03;
  const minimapPass =
    minimapRows.length >= 20 &&
    providerParseSuccess !== null &&
    providerParseSuccess >= 0.99 &&
    fidelityPass &&
    minimapAccuracy.full >= 0.75 &&
    minimapAccuracy.full - minimapAccuracy.structured >= 0.15;
  return {
    rawEvents: selected.length,
    joinedTasks: joined.length,
    unmatched,
    providerParseSuccess,
    fidelityPass,
    structuredTasks: structuredRows.length,
    minimapTasks: minimapRows.length,
    structuredAccuracy,
    minimapAccuracy,
    structuredPass,
    minimapPass,
    excluded: {
      missingTruth: joined.filter((row) => !row.truthAvailable).length,
      menuMismatch: joined.filter((row) => !row.menusMatch).length,
      carrierMismatch: joined.filter((row) => !row.carriersMatch).length,
      fidelityFailure: joined.filter((row) => !row.fidelity).length,
      providerOrParseFailure: joined.filter((row) => !row.reliable).length,
    },
  };
}

export function analyzeSpatialProbeEvents(events) {
  const probes = events.filter(
    (event) => event.schemaVersion === 1 && event.event === "probe",
  );
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    evidenceFiles: [
      ...new Set(events.map((event) => event.evidenceFile)),
    ].sort(),
    probeEvents: probes.length,
    models: [...new Set(probes.map((event) => event.model))].sort(),
    responseModels: [
      ...new Set(probes.map((event) => event.responseModel).filter(Boolean)),
    ].sort(),
    gate1: gate1Report(probes),
    gate2: gate2Report(probes),
  };
}

async function main() {
  const { files, output } = parseArgs(process.argv.slice(2));
  const report = analyzeSpatialProbeEvents(await readEvents(files));
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await fs.writeFile(output, rendered, "utf8");
  process.stdout.write(rendered);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
