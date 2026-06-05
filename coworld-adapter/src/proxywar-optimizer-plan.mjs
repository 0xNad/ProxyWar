import fs from "node:fs/promises";
import path from "node:path";

const OPTIMIZER_ID = "proxywar-optimizer-plan";

const outputUri = requiredEnv("COGAME_OPTIMIZER_OUTPUT_URI");
const manifestUri = process.env.COGAME_COWORLD_MANIFEST_URI;
const diagnosisUris = uriList("COGAME_DIAGNOSER_OUTPUT_URIS");
const reportUris = uriList("COGAME_REPORT_URIS");
const graderUris = uriList("COGAME_GRADER_OUTPUT_URIS");

const manifest = manifestUri ? JSON.parse((await readUriBuffer(manifestUri)).toString("utf8")) : null;
const diagnoses = await Promise.all(diagnosisUris.map(readMaybeZipManifest));
const reports = await Promise.all(reportUris.map(readMaybeZipManifest));
const grades = await Promise.all(graderUris.map(readMaybeJson));

const plan = {
  optimizer_id: OPTIMIZER_ID,
  contract_status: "local proof; Coworld optimizer role is reserved/tentative",
  coworld_name: manifest?.game?.name ?? null,
  manifest_version: manifest?.game?.version ?? null,
  input_counts: {
    diagnoses: diagnoses.length,
    reports: reports.length,
    grades: grades.length,
  },
  recommendations: [
    "Use the legal-action decision log as the first policy-iteration signal.",
    "Promote scoring from short smoke episodes to longer seeded FFA batches before league submission.",
    "Keep optimizer output as an advisory plan until Softmax stabilizes optimizer handoff semantics.",
  ],
  next_candidate_tests: [
    "Run 5-10 parallel local Coworld episodes after every player-policy change.",
    "Compare normalized territory-share scores across multiple seeds.",
    "Check that fallback_count remains zero and every selected LegalAction.id remains offered.",
  ],
  inputs: {
    manifest_uri: manifestUri ?? null,
    diagnosis_uris: diagnosisUris,
    report_uris: reportUris,
    grader_output_uris: graderUris,
    diagnosis_manifests: diagnoses,
    report_manifests: reports,
    grades,
  },
};

await writeUri(outputUri, `${JSON.stringify(plan, null, 2)}\n`, "application/json");

console.log(
  JSON.stringify(
    {
      ok: true,
      optimizer_id: OPTIMIZER_ID,
      outputUri,
      input_counts: plan.input_counts,
    },
    null,
    2,
  ),
);

async function readMaybeZipManifest(uri) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await readUriBuffer(uri));
  const manifestFile = zip.file("manifest.json");
  return manifestFile ? JSON.parse(await manifestFile.async("string")) : null;
}

async function readMaybeJson(uri) {
  return JSON.parse((await readUriBuffer(uri)).toString("utf8"));
}

function uriList(name) {
  const value = process.env[name];
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
