import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import JSZip from "jszip";

// Speaks the platform's real reporter protocol: one COGAME_REPORT_REQUEST env var
// (a JSON-encoded ReportRequest -- request_id, episodes[], report_uri), artifacts
// referenced by file://.../https://... ReporterArtifactRef, output written as a
// report.zip containing a manifest.json {reporter_id, render?, event_log?, trace?}.
// See packages/coworld/src/coworld/reporter_protocol.py and report.py in metta for
// the authoritative schema; there was no prior JS implementation to pattern-match,
// this is a straight port of the Python reference (paint_arena_summarizer.py).

const REPORTER_ID = "proxywar-summary-reporter";
const ZIP_ENTRY_DATE = new Date(1980, 0, 1); // deterministic zip output, matches the platform's own writer

async function main() {
  const request = JSON.parse(requiredEnv("COGAME_REPORT_REQUEST"));
  const episodeSummaries = [];
  for (const episode of request.episodes) {
    episodeSummaries.push(await summarizeEpisode(episode));
  }
  const summary = episodeSummaries.length === 1 ? episodeSummaries[0] : { episodes: episodeSummaries };

  const report = new JSZip();
  report.file(
    "manifest.json",
    `${JSON.stringify({ reporter_id: REPORTER_ID, render: "summary.md", trace: "summary.json" }, null, 2)}\n`,
    { date: ZIP_ENTRY_DATE },
  );
  report.file("summary.json", `${JSON.stringify(summary, null, 2)}\n`, { date: ZIP_ENTRY_DATE });
  report.file("summary.md", renderSummary(summary), { date: ZIP_ENTRY_DATE });

  const reportBytes = await report.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "UNIX" });
  await writeUri(request.report_uri, reportBytes, "application/zip");

  console.log(
    JSON.stringify(
      { ok: true, reporter_id: REPORTER_ID, request_id: request.request_id, report_uri: request.report_uri, summary },
      null,
      2,
    ),
  );
}

async function summarizeEpisode(episode) {
  if (episode.status !== "success") {
    return {
      reporter_id: REPORTER_ID,
      status: episode.status,
      error: episode.inline_json?.error_info ?? null,
    };
  }

  const results = await readJsonArtifact(episode.artifacts.results);
  const replay = await readJsonArtifact(episode.artifacts.replay);
  const decisions = parseDecisionRows(replay);

  return {
    reporter_id: REPORTER_ID,
    status: episode.status,
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
}

// Per-decision rows aren't a separate certifier-provided artifact -- the game engine
// (no-docker-coworld-episode.ts) embeds them as a decisions.jsonl string inside the
// replay payload's inlineRunArtifacts, so they ride along with the replay fetch above
// rather than needing their own bundle entry.
function parseDecisionRows(replay) {
  const raw = replay?.inlineRunArtifacts?.["decisions.jsonl"];
  if (!raw) {
    return [];
  }
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function renderSummary(summary) {
  if (summary.episodes) {
    return [
      "# Proxy War Coworld Episode Summary",
      "",
      `${summary.episodes.length} episodes in this report.`,
      "",
      ...summary.episodes.flatMap((episode, index) => [`## Episode ${index + 1}`, "", ...renderEpisodeLines(episode), ""]),
    ].join("\n");
  }
  return ["# Proxy War Coworld Episode Summary", "", ...renderEpisodeLines(summary), ""].join("\n");
}

function renderEpisodeLines(summary) {
  if (summary.status !== "success") {
    return [`Status: ${summary.status}`, `Error: ${summary.error?.error ?? "unknown"}`];
  }
  return [
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
  ];
}

function countBy(values, keyFn) {
  const counts = {};
  for (const value of values) {
    const key = keyFn(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function readJsonArtifact(ref) {
  const bytes = await readUriBytes(ref.uri);
  const decoded = ref.encoding === "zlib" ? zlib.inflateSync(bytes) : bytes;
  return JSON.parse(decoded.toString("utf8"));
}

async function readUriBytes(uri) {
  if (uri.startsWith("file://")) {
    return await fs.readFile(new URL(uri));
  }
  if (/^https?:\/\//.test(uri)) {
    return await fetchWithRetry(uri);
  }
  return await fs.readFile(uri);
}

async function fetchWithRetry(uri, attempts = 5) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(uri);
    if (response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }
    lastError = new Error(`${uri} returned HTTP ${response.status}`);
    if (response.status !== 429 && (response.status < 500 || response.status >= 600)) {
      throw lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 500 * 2 ** attempt)));
  }
  throw lastError;
}

async function writeUri(uri, body, contentType) {
  if (uri.startsWith("file://")) {
    const filePath = new URL(uri);
    await fs.mkdir(path.dirname(filePath.pathname), { recursive: true });
    await fs.writeFile(filePath, body);
    return;
  }
  if (/^https?:\/\//.test(uri)) {
    const response = await fetch(uri, {
      method: "PUT",
      headers: { "content-type": contentType },
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

await main();
