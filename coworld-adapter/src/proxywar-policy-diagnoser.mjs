import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const DIAGNOSER_ID = "proxywar-policy-diagnoser";

const bundleUri = requiredEnv("COGAME_EPISODE_BUNDLE_URI");
const targetPolicyUri = process.env.COGAME_TARGET_POLICY_URI ?? "policy://unknown";
const diagnosisUri = requiredEnv("COGAME_DIAGNOSIS_URI");

const bundle = await JSZip.loadAsync(await readUriBuffer(bundleUri));
const bundleManifest = JSON.parse(await readZipText(bundle, "manifest.json"));
const results = JSON.parse(await readZipText(bundle, bundleManifest.files.results));
const decisions = await readDecisionRows(bundle, bundleManifest);
const feedback = await readOptionalZipText(
  bundle,
  bundleManifest.files.proxywar_artifacts?.["external-agent-feedback.md"],
);

const findings = buildFindings({ results, decisions, feedback, targetPolicyUri });
const diagnosis = new JSZip();
diagnosis.file(
  "manifest.json",
  `${JSON.stringify(
    {
      diagnoser_id: DIAGNOSER_ID,
      render: "diagnosis.md",
      findings: "findings.json",
      target_policy_uri: targetPolicyUri,
      contract_status: "coworld-diagnoser-reserved-local-proof",
    },
    null,
    2,
  )}\n`,
);
diagnosis.file("findings.json", `${JSON.stringify(findings, null, 2)}\n`);
diagnosis.file("diagnosis.md", renderDiagnosis(findings));

await writeUri(diagnosisUri, await diagnosis.generateAsync({ type: "nodebuffer" }));

console.log(
  JSON.stringify(
    {
      ok: true,
      diagnoser_id: DIAGNOSER_ID,
      bundleUri,
      targetPolicyUri,
      diagnosisUri,
      findingCount: findings.findings.length,
    },
    null,
    2,
  ),
);

function buildFindings({ results, decisions, feedback, targetPolicyUri }) {
  const rejected = decisions.filter((decision) => decision.result?.accepted !== true);
  const fallbacks = decisions.filter(
    (decision) => decision.decisionMetadata?.fallbackUsed === true,
  );
  const nonHold = decisions.filter(
    (decision) =>
      decision.selectedActionKind !== "hold" &&
      decision.selectedActionKind !== "spawn",
  );
  const findings = [];
  findings.push({
    id: "legal-action-integrity",
    severity: rejected.length === 0 ? "info" : "error",
    summary:
      rejected.length === 0
        ? "All selected LegalAction.id values were accepted by Proxy War."
        : `${rejected.length} selected actions were rejected by Proxy War.`,
    evidence: { rejected_decisions: rejected.length, decision_count: decisions.length },
  });
  findings.push({
    id: "fallback-rate",
    severity: fallbacks.length === 0 ? "info" : "warning",
    summary:
      fallbacks.length === 0
        ? "No fallback decisions were used."
        : `${fallbacks.length} fallback decisions were used.`,
    evidence: { fallback_count: fallbacks.length, decision_count: decisions.length },
  });
  findings.push({
    id: "post-spawn-agency",
    severity: nonHold.length > 0 ? "info" : "warning",
    summary:
      nonHold.length > 0
        ? "The policy made non-hold post-spawn decisions."
        : "The policy did not make non-hold post-spawn decisions in this episode.",
    evidence: { non_spawn_non_hold_decisions: nonHold.length },
  });
  return {
    diagnoser_id: DIAGNOSER_ID,
    target_policy_uri: targetPolicyUri,
    contract_status: "local proof against Coworld reserved/tentative diagnoser shape",
    scores: results.scores,
    winner_slot: results.winner_slot,
    decision_count: decisions.length,
    feedback_excerpt: feedback ? feedback.slice(0, 2000) : null,
    findings,
    recommendations: [
      "Keep selecting one offered LegalAction.id; do not synthesize action payloads.",
      "For stronger policy evaluation, run longer episodes and compare score trajectories across seeds.",
      "Wait for Softmax to stabilize COGAME_TARGET_POLICY_URI before treating this as hosted diagnoser compatibility.",
    ],
  };
}

function renderDiagnosis(findings) {
  return [
    "# Proxy War Policy Diagnosis",
    "",
    `Diagnoser: ${findings.diagnoser_id}`,
    `Target policy: ${findings.target_policy_uri}`,
    `Scores: ${findings.scores.join(", ")}`,
    `Decisions: ${findings.decision_count}`,
    "",
    "## Findings",
    "",
    ...findings.findings.map(
      (finding) => `- ${finding.severity}: ${finding.summary}`,
    ),
    "",
    "## Recommendations",
    "",
    ...findings.recommendations.map((recommendation) => `- ${recommendation}`),
    "",
  ].join("\n");
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

async function readOptionalZipText(zip, fileName) {
  if (!fileName) {
    return null;
  }
  const file = zip.file(fileName);
  return file ? await file.async("string") : null;
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
