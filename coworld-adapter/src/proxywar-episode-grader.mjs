import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const GRADER_ID = "proxywar-episode-grader";

const bundleUri = requiredEnv("COGAME_EPISODE_BUNDLE_URI");
const gradeUri = requiredEnv("COGAME_GRADE_URI");
const bundle = await JSZip.loadAsync(await readUriBuffer(bundleUri));
const bundleManifest = JSON.parse(await readZipText(bundle, "manifest.json"));
const results = JSON.parse(await readZipText(bundle, bundleManifest.files.results));
const replay = JSON.parse(await readZipText(bundle, bundleManifest.files.replay));
const decisions = await readDecisionRows(bundle, bundleManifest);

const grade = buildGrade({ bundleManifest, results, replay, decisions });
await writeUri(gradeUri, `${JSON.stringify(grade, null, 2)}\n`, "application/json");

console.log(
  JSON.stringify(
    {
      ok: true,
      grader_id: GRADER_ID,
      bundleUri,
      gradeUri,
      score: grade.score,
      components: grade.components,
    },
    null,
    2,
  ),
);

function buildGrade({ bundleManifest, results, replay, decisions }) {
  const decisionCount = decisions.length;
  const acceptedDecisionCount = decisions.filter(
    (decision) => decision.result?.accepted === true,
  ).length;
  const fallbackCount = decisions.filter(
    (decision) => decision.decisionMetadata?.fallbackUsed === true,
  ).length;
  const postSpawnNonHoldCount = decisions.filter(
    (decision) =>
      decision.selectedActionKind !== "spawn" &&
      decision.selectedActionKind !== "hold",
  ).length;
  const scoreValues = Array.isArray(results.scores) ? results.scores : [];
  const scoreSum = scoreValues.reduce((sum, score) => sum + score, 0);
  const scoreSpread =
    scoreValues.length === 0
      ? 1
      : Math.max(...scoreValues) - Math.min(...scoreValues);

  const components = {
    legal_action_integrity:
      decisionCount === 0 ? 0 : acceptedDecisionCount / decisionCount,
    no_fallbacks: decisionCount === 0 ? 0 : 1 - fallbackCount / decisionCount,
    post_spawn_agency: Math.min(1, postSpawnNonHoldCount / Math.max(1, scoreValues.length)),
    scoring_integrity:
      scoreValues.every((score) => Number.isFinite(score)) &&
      (Math.abs(scoreSum - 1) < 1e-9 || scoreSum === 0)
        ? 1
        : 0,
    replay_integrity:
      replay.replayKind === "proxywar-coworld-local-poc" &&
      Number.isInteger(replay.spectatorSnapshotCount) &&
      replay.spectatorSnapshotCount > 0
        ? 1
        : 0,
    competitive_signal: Math.max(0, Math.min(1, scoreSpread)),
  };

  const weights = {
    legal_action_integrity: 0.3,
    no_fallbacks: 0.2,
    post_spawn_agency: 0.2,
    scoring_integrity: 0.15,
    replay_integrity: 0.1,
    competitive_signal: 0.05,
  };

  const score = roundScore(
    Object.entries(weights).reduce(
      (sum, [key, weight]) => sum + components[key] * weight,
      0,
    ),
  );

  return {
    grader_id: GRADER_ID,
    score,
    scale: "0..1",
    contract_status: "coworld-grader-contract-defined-runtime-pending-local-proof",
    interpretation:
      "Higher scores mean the episode is more useful for local Proxy War Coworld POC triage: legal actions were accepted, no fallbacks were needed, post-spawn agency occurred, scoring/replay artifacts were valid, and the episode produced some competitive signal.",
    components,
    weights,
    summary: {
      bundle_status: bundleManifest.status,
      player_count: scoreValues.length,
      scores: scoreValues,
      score_sum: scoreSum,
      winner_slot: results.winner_slot,
      turn_count: results.turn_count,
      decision_count: decisionCount,
      accepted_decision_count: acceptedDecisionCount,
      fallback_count: fallbackCount,
      post_spawn_non_hold_decision_count: postSpawnNonHoldCount,
      replay_kind: replay.replayKind,
      spectator_snapshot_count: replay.spectatorSnapshotCount,
    },
  };
}

function roundScore(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

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
