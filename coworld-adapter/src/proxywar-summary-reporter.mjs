import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const REPORTER_ID = "proxywar-summary-reporter";

const bundleUri = requiredEnv("COGAME_EPISODE_BUNDLE_URI");
const reportUri = requiredEnv("COGAME_REPORT_URI");
const bundle = await JSZip.loadAsync(await readUriBuffer(bundleUri));
const bundleManifest = JSON.parse(await readZipText(bundle, "manifest.json"));
const results = JSON.parse(await readZipText(bundle, bundleManifest.files.results));
const replay = JSON.parse(await readZipText(bundle, bundleManifest.files.replay));
const decisions = await readDecisionRows(bundle, bundleManifest);

const summary = {
  reporter_id: REPORTER_ID,
  status: bundleManifest.status,
  scores: results.scores,
  winner_slot: results.winner_slot,
  turn_count: results.turn_count,
  decision_count: results.decision_count,
  accepted_decision_count: results.accepted_decision_count,
  fallback_count: results.fallback_count,
  replay_kind: replay.replayKind,
  spectator_snapshot_count: replay.spectatorSnapshotCount,
  decision_kinds: countBy(decisions, (decision) => decision.selectedActionKind ?? "unknown"),
};

const report = new JSZip();
report.file(
  "manifest.json",
  `${JSON.stringify(
    {
      reporter_id: REPORTER_ID,
      render: "summary.md",
      trace: "summary.json",
    },
    null,
    2,
  )}\n`,
);
report.file("summary.json", `${JSON.stringify(summary, null, 2)}\n`);
report.file("summary.md", renderSummary(summary));

await writeUri(reportUri, await report.generateAsync({ type: "nodebuffer" }));

console.log(
  JSON.stringify(
    {
      ok: true,
      reporter_id: REPORTER_ID,
      bundleUri,
      reportUri,
      summary,
    },
    null,
    2,
  ),
);

async function readDecisionRows(bundle, manifest) {
  const decisionsPath = manifest.files.proxywar_artifacts?.["decisions.jsonl"];
  if (!decisionsPath) {
    return [];
  }
  const raw = await readZipText(bundle, decisionsPath);
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function renderSummary(summary) {
  return [
    "# Proxy War Coworld Episode Summary",
    "",
    `Reporter: ${summary.reporter_id}`,
    `Scores: ${summary.scores.join(", ")}`,
    `Winner slot: ${summary.winner_slot ?? "none"}`,
    `Turns: ${summary.turn_count ?? "unknown"}`,
    `Decisions: ${summary.decision_count}`,
    `Accepted decisions: ${summary.accepted_decision_count}`,
    `Fallback decisions: ${summary.fallback_count}`,
    `Replay kind: ${summary.replay_kind}`,
    `Spectator snapshots: ${summary.spectator_snapshot_count}`,
    "",
    "## Decision Kinds",
    "",
    ...Object.entries(summary.decision_kinds).map(([kind, count]) => `- ${kind}: ${count}`),
    "",
  ].join("\n");
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values) {
    const key = keyFn(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function readZipText(zip, fileName) {
  const file = zip.file(fileName);
  if (!file) {
    throw new Error(`Bundle is missing ${fileName}`);
  }
  return await file.async("string");
}

async function readUriBuffer(uri) {
  if (uri.startsWith("file://")) {
    return await fs.readFile(new URL(uri));
  }
  if (/^https?:\/\//.test(uri)) {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`${uri} returned HTTP ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return await fs.readFile(uri);
}

async function writeUri(uri, body) {
  if (uri.startsWith("file://")) {
    const filePath = new URL(uri);
    await fs.mkdir(path.dirname(filePath.pathname), { recursive: true });
    await fs.writeFile(filePath, body);
    return;
  }
  if (/^https?:\/\//.test(uri)) {
    const response = await fetch(uri, {
      method: "PUT",
      headers: { "content-type": "application/zip" },
      body,
    });
    if (!response.ok) {
      throw new Error(`${uri} returned HTTP ${response.status}`);
    }
    return;
  }
  await fs.mkdir(path.dirname(uri), { recursive: true });
  await fs.writeFile(uri, body);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
