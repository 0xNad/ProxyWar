import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSpatialXpManifest,
  SPATIAL_XP_GAME_NAMES,
} from "./build-spatial-xp-manifest.mjs";
import {
  renderCanonicalManifest,
  validateVerifiedSpatialXpArmParity,
  validateVerifiedSpatialXpReceiptTransition,
} from "./finalize-spatial-xp-manifest.mjs";

const ARMS = Object.freeze(["off", "structured", "on"]);
const ROLES = Object.freeze(["game", "runnables", "commissioner"]);
const COWORLD_IMAGE_RESPONSE_KEYS = Object.freeze([
  "id",
  "name",
  "version",
  "client_hash",
  "status",
  "image_uri",
  "image_digest",
  "public_image_uri",
]);
const ROLE_TITLES = Object.freeze({
  game: "proxywar-spatial-xp",
  runnables: "proxywar-spatial-runnables",
  commissioner: "proxywar-spatial-commissioner",
});
const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const RAW_SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_ID =
  /^img_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COWORLD_ID =
  /^cow_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const TEMPLATE_RELATIVE_PATH =
  "coworld-adapter/coworld/coworld_manifest_template.json";
const UPLOAD_RESULT_MARKER = "PROXYWAR_SPATIAL_UPLOAD_RESULT=";
const PRODUCTION_COWORLD = Object.freeze({
  id: "cow_f58621db-4a09-47de-bb13-24d61050a837",
  name: "proxywar",
  version: "0.1.54",
  manifestHash:
    "sha256:42e0d2e81685b495f663e7ce965f06de1a8f5d86af177cf72e67577753dfc304",
});
const PRODUCTION_LEAGUE_ID = "league_cb60d526-ecfd-4836-ab3a-81fc6cf7dc42";

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function sha256(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function exactUtf8Text(raw, label) {
  if (!Buffer.isBuffer(raw)) {
    throw new Error(`${label} did not return exact bytes`);
  }
  const text = raw.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(raw)) {
    throw new Error(`${label} is not valid UTF-8`);
  }
  return text;
}

export function captureExactCommand(
  command,
  args,
  label,
  maximumBytes = 16 * 1024 * 1024,
  environment = process.env,
  workingDirectory,
) {
  const result = spawnSync(command, args, {
    cwd: workingDirectory,
    encoding: "buffer",
    env: environment,
    maxBuffer: maximumBytes,
  });
  if (result.error !== undefined) {
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  const raw = exactUtf8Text(result.stdout, `${label} stdout`);
  const stderrRaw = exactUtf8Text(result.stderr, `${label} stderr`);
  return {
    raw,
    sha256: sha256(result.stdout),
    signal: result.signal,
    status: result.status,
    stderrRaw,
    stderrSha256: sha256(result.stderr),
  };
}

function runExactCommand(
  command,
  args,
  label,
  maximumBytes = 16 * 1024 * 1024,
  environment = process.env,
  workingDirectory,
) {
  const result = captureExactCommand(
    command,
    args,
    label,
    maximumBytes,
    environment,
    workingDirectory,
  );
  if (result.signal !== null || result.status !== 0) {
    const detail = result.stderrRaw.trim().slice(-4096);
    throw new Error(
      `${label} failed with status ${String(result.status)}${detail === "" ? "" : `: ${detail}`}`,
    );
  }
  return result;
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function parseArgs(args) {
  const keys = ["arm", "input-dir", "evidence-dir", "source-sha"];
  const parsed = {};
  for (const arg of args) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(arg);
    if (
      match === null ||
      !keys.includes(match[1]) ||
      Object.hasOwn(parsed, match[1])
    ) {
      throw new Error("invalid or duplicate spatial XP upload argument");
    }
    parsed[match[1]] = match[2];
  }
  if (
    keys.some((key) => parsed[key] === undefined) ||
    !ARMS.includes(parsed.arm) ||
    !SHA40.test(parsed["source-sha"])
  ) {
    throw new Error(
      "spatial XP upload requires arm/input-dir/evidence-dir/source-sha",
    );
  }
  return parsed;
}

function collectImageFields(value, output = []) {
  if (Array.isArray(value)) {
    for (const entry of value) collectImageFields(entry, output);
  } else if (value !== null && typeof value === "object") {
    if (Object.hasOwn(value, "image")) {
      if (typeof value.image !== "string") {
        throw new Error("Coworld manifest image field must be a string");
      }
      output.push(value);
    }
    for (const entry of Object.values(value)) collectImageFields(entry, output);
  }
  return output;
}

export function expectedStoredManifest(manifest, receipt) {
  const expected = structuredClone(manifest);
  const imageIDs = new Map(
    receipt.images.map((image) => [
      image.immutableLocalReference,
      image.coworldImageID,
    ]),
  );
  for (const field of collectImageFields(expected)) {
    const imageID = imageIDs.get(field.image);
    if (imageID === undefined) {
      throw new Error(
        "verified manifest contains an image absent from receipt",
      );
    }
    field.image = imageID;
  }
  const replayViewer = expected.game?.replay_viewer;
  if (replayViewer !== undefined) {
    replayViewer.bundle = "<UPLOADED_REPLAY_BUNDLE>";
  }
  // Coworld 0.1.42 materializes the schema defaults on commissioner entries
  // when it stores the uploaded manifest. Accept only those exact empty
  // defaults; the full stable-value comparison below still rejects any
  // non-empty command or environment mutation.
  if (Array.isArray(expected.commissioner)) {
    for (const commissioner of expected.commissioner) {
      if (
        commissioner !== null &&
        typeof commissioner === "object" &&
        !Array.isArray(commissioner)
      ) {
        commissioner.env ??= {};
        commissioner.run ??= [];
      }
    }
  }
  return expected;
}

export function normalizedStoredManifest(manifest) {
  const normalized = structuredClone(manifest);
  const replayViewer = normalized.game?.replay_viewer;
  if (replayViewer !== undefined) {
    if (!SHA256.test(replayViewer.bundle)) {
      throw new Error("stored Coworld replay bundle is not immutable");
    }
    replayViewer.bundle = "<UPLOADED_REPLAY_BUNDLE>";
  }
  return normalized;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function validateCoworldImageResponse(response, expected) {
  const image = record(response, `${expected.role} Coworld image response`);
  if (
    JSON.stringify(Object.keys(image).sort()) !==
    JSON.stringify([...COWORLD_IMAGE_RESPONSE_KEYS].sort())
  ) {
    throw new Error(
      `${expected.role} Coworld image response fields are not exact`,
    );
  }
  const ready = image.status === "ready" && image.public_image_uri === null;
  const published =
    image.status === "published" &&
    image.public_image_uri ===
      `public.ecr.aws/q5f4m8t9/cogames@${expected.coworldImageDigest}`;
  if (
    image.id !== expected.coworldImageID ||
    image.name !== expected.coworldName ||
    image.version !== expected.coworldVersion ||
    image.client_hash !== expected.coworldClientHash ||
    image.image_digest !== expected.coworldImageDigest ||
    image.image_uri !== null ||
    (!ready && !published)
  ) {
    throw new Error(
      `${expected.role} Coworld image response does not match the authority receipt`,
    );
  }
  return image.status;
}

function validateDockerDigestInspect(raw, expected) {
  const parsed = parseJson(raw, `${expected.role} Docker digest inspect`);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`${expected.role} Docker digest inspect is not exact`);
  }
  const inspect = record(parsed[0], `${expected.role} Docker digest image`);
  if (
    inspect.Id !== expected.localDockerID ||
    inspect.Os !== "linux" ||
    inspect.Architecture !== "amd64" ||
    !Array.isArray(inspect.RepoDigests) ||
    !inspect.RepoDigests.includes(expected.immutableLocalReference) ||
    inspect.Config?.Labels?.["org.opencontainers.image.revision"] !==
      expected.ociRevision
  ) {
    throw new Error(
      `${expected.role} immutable Docker reference changed before upload`,
    );
  }
}

export function validateUploadAuthorityReceipt(receipt, head, tree) {
  const value = record(receipt, "authority receipt");
  const coworldVersion = value.generatedFrom?.coworldClient?.version;
  const authority = record(
    value.manifestAuthority,
    "authority receipt manifest authority",
  );
  if (
    value.schemaVersion !== "proxywar-spatial-verified-image-receipt-v1" ||
    value.sourceSha !== head ||
    value.sourceTree !== tree ||
    value.canonicalPackageOrLeagueMutation !== false ||
    value.generatedFrom?.coworldClient?.package !== "coworld" ||
    typeof coworldVersion !== "string" ||
    coworldVersion.length > 64 ||
    !/^\d+\.\d+\.\d+(?:[a-z0-9.+-]*)$/u.test(coworldVersion) ||
    authority.templatePath !== TEMPLATE_RELATIVE_PATH ||
    !SHA40.test(authority.templateGitBlob) ||
    !RAW_SHA256.test(authority.templateSha256) ||
    !RAW_SHA256.test(authority.renderedCanonicalSha256) ||
    authority.imageTagRevision !== head.slice(0, 9) ||
    !ARMS.every((arm) =>
      RAW_SHA256.test(authority.blockedManifestSha256?.[arm]),
    ) ||
    !Array.isArray(value.images) ||
    value.images.length !== ROLES.length
  ) {
    throw new Error(
      "authority receipt does not match the clean source checkout",
    );
  }

  for (const [index, image] of value.images.entries()) {
    const role = ROLES[index];
    const expectedRepository = ROLE_TITLES[role];
    if (
      image.role !== role ||
      image.localTag !== `${expectedRepository}:${head.slice(0, 9)}` ||
      image.platform !== "linux/amd64" ||
      image.ociRevision !== head ||
      !SHA256.test(image.localDockerID) ||
      image.immutableLocalReference !==
        `${expectedRepository}@${image.localDockerID}` ||
      !IMAGE_ID.test(image.coworldImageID) ||
      image.coworldName !== expectedRepository ||
      !Number.isInteger(image.coworldVersion) ||
      image.coworldVersion < 1 ||
      image.coworldStatus !== "ready" ||
      !SHA256.test(image.coworldClientHash) ||
      image.localDockerID !== image.coworldClientHash ||
      !SHA256.test(image.coworldImageDigest) ||
      !RAW_SHA256.test(image.coworldResponseSha256) ||
      !RAW_SHA256.test(image.localInspectSha256) ||
      !RAW_SHA256.test(image.immutableInspectSha256)
    ) {
      throw new Error(`authority receipt ${role} image identity is malformed`);
    }
  }
  if (
    new Set(value.images.map((image) => image.coworldImageID)).size !==
      ROLES.length ||
    new Set(value.images.map((image) => image.immutableLocalReference)).size !==
      ROLES.length
  ) {
    throw new Error("authority receipt image identities must be unique");
  }
  return coworldVersion;
}

export function validateCanonicalUploadInputs(
  templateRaw,
  canonicalRaw,
  blockedManifestRaw,
  receipt,
  head,
) {
  const blockedRawSet = record(
    blockedManifestRaw,
    "blocked spatial XP manifest bytes",
  );
  const derivedCanonical = renderCanonicalManifest(templateRaw, head);
  if (
    sha256(templateRaw) !== receipt.manifestAuthority.templateSha256 ||
    canonicalRaw !== derivedCanonical.raw ||
    sha256(canonicalRaw) !== receipt.manifestAuthority.renderedCanonicalSha256
  ) {
    throw new Error(
      "rendered canonical manifest is not the exact checked-in-template rendering",
    );
  }
  const blockedManifests = {};
  for (const arm of ARMS) {
    const raw = blockedRawSet[arm];
    if (typeof raw !== "string") {
      throw new Error(`${arm} blocked manifest bytes are missing`);
    }
    const expected = buildSpatialXpManifest(
      derivedCanonical.manifest,
      arm,
      head,
    );
    if (
      raw !== `${JSON.stringify(expected, null, 2)}\n` ||
      sha256(raw) !== receipt.manifestAuthority.blockedManifestSha256[arm]
    ) {
      throw new Error(
        `${arm} blocked manifest is not the exact canonical derivative`,
      );
    }
    blockedManifests[arm] = parseJson(raw, `${arm} blocked manifest`);
  }
  return { blockedManifests, canonicalManifest: derivedCanonical.manifest };
}

export function validateStoredCoworldUpload(
  storedCoworld,
  uploadResult,
  manifest,
  receipt,
  arm,
) {
  const stored = record(storedCoworld, "stored Coworld package");
  const result = record(uploadResult, "Coworld upload result");
  if (
    !ARMS.includes(arm) ||
    stored.id !== result.id ||
    stored.name !== SPATIAL_XP_GAME_NAMES[arm] ||
    stored.version !== manifest.game.version ||
    stored.canonical !== false ||
    stored.manifest_hash !== result.manifest_hash ||
    !SHA256.test(stored.manifest_hash) ||
    JSON.stringify(stableValue(normalizedStoredManifest(stored.manifest))) !==
      JSON.stringify(stableValue(expectedStoredManifest(manifest, receipt)))
  ) {
    throw new Error(
      "stored Coworld manifest does not match the verified upload",
    );
  }
}

export function validateProductionState(coworldResponse, leagueResponse) {
  const coworld = record(coworldResponse, "production Coworld response");
  const league = record(leagueResponse, "production league response");
  if (
    coworld.id !== PRODUCTION_COWORLD.id ||
    coworld.name !== PRODUCTION_COWORLD.name ||
    coworld.version !== PRODUCTION_COWORLD.version ||
    coworld.manifest_hash !== PRODUCTION_COWORLD.manifestHash ||
    coworld.canonical !== true ||
    league.id !== PRODUCTION_LEAGUE_ID ||
    league.game?.coworld_id !== PRODUCTION_COWORLD.id ||
    league.game?.canonical_coworld_id !== PRODUCTION_COWORLD.id ||
    typeof league.rounds_paused_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(
      league.rounds_paused_at,
    )
  ) {
    throw new Error(
      "production Coworld package or paused league binding is not exact",
    );
  }
}

function fetchProductionState(coworldPackageSpec, label) {
  const coworld = runExactCommand(
    "uvx",
    [
      "--from",
      coworldPackageSpec,
      "coworld",
      "show",
      PRODUCTION_COWORLD.id,
      "--json",
    ],
    `${label} production Coworld fetch`,
  );
  const league = runExactCommand(
    "uvx",
    [
      "--from",
      coworldPackageSpec,
      "coworld",
      "leagues",
      PRODUCTION_LEAGUE_ID,
      "--json",
    ],
    `${label} production league fetch`,
  );
  const coworldValue = parseJson(coworld.raw, `${label} production Coworld`);
  const leagueValue = parseJson(league.raw, `${label} production league`);
  validateProductionState(coworldValue, leagueValue);
  return { coworld, coworldValue, league, leagueValue };
}

function uploadPython() {
  return [
    "import json,sys",
    "from pathlib import Path",
    "from coworld.upload import upload_coworld",
    "result=upload_coworld(Path(sys.argv[1]))",
    `print(${JSON.stringify(UPLOAD_RESULT_MARKER)}+json.dumps({"id":result.id,"name":result.name,"version":result.version,"manifest_hash":result.manifest_hash,"size_bytes":result.size_bytes,"canonical":result.canonical},sort_keys=True))`,
  ].join(";");
}

function parseUploadResult(raw) {
  const lines = raw.split(/\r?\n/u);
  const matches = lines.filter((line) => line.startsWith(UPLOAD_RESULT_MARKER));
  if (matches.length !== 1) {
    throw new Error("Coworld upload did not return one exact result marker");
  }
  const result = record(
    parseJson(
      matches[0].slice(UPLOAD_RESULT_MARKER.length),
      "Coworld upload result",
    ),
    "Coworld upload result",
  );
  if (!COWORLD_ID.test(result.id)) {
    throw new Error("Coworld upload result id is malformed");
  }
  return result;
}

async function requireMissing(target, label) {
  try {
    await fs.access(target);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`${label} already exists`);
}

async function main(args) {
  const options = parseArgs(args);
  const arm = options.arm;
  const inputDirectory = path.resolve(options["input-dir"]);
  const evidenceDirectory = path.resolve(options["evidence-dir"]);
  await requireMissing(evidenceDirectory, "upload evidence directory");

  const head = runExactCommand(
    "git",
    ["-C", REPOSITORY_ROOT, "rev-parse", "HEAD"],
    "source revision verification",
  ).raw.trim();
  const tree = runExactCommand(
    "git",
    ["-C", REPOSITORY_ROOT, "rev-parse", "HEAD^{tree}"],
    "source tree verification",
  ).raw.trim();
  const status = runExactCommand(
    "git",
    ["-C", REPOSITORY_ROOT, "status", "--porcelain=v1", "--untracked-files=no"],
    "source status verification",
  ).raw;
  if (head !== options["source-sha"] || !SHA40.test(tree) || status !== "") {
    throw new Error(
      "spatial XP upload requires the clean exact source checkout",
    );
  }
  const commonGitDirectory = runExactCommand(
    "git",
    [
      "-C",
      REPOSITORY_ROOT,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    "Git common directory verification",
  ).raw.trim();
  const canonicalRepositoryRoot = path.dirname(commonGitDirectory);
  const canonicalAdapterRoot = path.join(
    canonicalRepositoryRoot,
    "coworld-adapter",
  );
  const certificationTemporaryRoot = path.join(canonicalAdapterRoot, "tmp");
  if (!pathIsInside(certificationTemporaryRoot, evidenceDirectory)) {
    throw new Error(
      "upload evidence directory must be inside the canonical Coworld certification tmp root",
    );
  }

  const receiptPath = path.join(inputDirectory, "image-authority-receipt.json");
  const receiptBytes = await fs.readFile(receiptPath);
  const receiptRaw = exactUtf8Text(receiptBytes, "authority receipt");
  const receipt = record(
    parseJson(receiptRaw, "authority receipt"),
    "authority receipt",
  );
  const receiptSha256 = sha256(receiptBytes);
  const coworldVersion = validateUploadAuthorityReceipt(receipt, head, tree);

  const templateBytes = await fs.readFile(
    path.join(REPOSITORY_ROOT, TEMPLATE_RELATIVE_PATH),
  );
  const templateRaw = exactUtf8Text(templateBytes, "canonical template");
  const templateGitBlob = runExactCommand(
    "git",
    ["-C", REPOSITORY_ROOT, "rev-parse", `HEAD:${TEMPLATE_RELATIVE_PATH}`],
    "canonical template HEAD blob verification",
  ).raw.trim();
  if (
    templateGitBlob !== receipt.manifestAuthority.templateGitBlob ||
    sha256(templateBytes) !== receipt.manifestAuthority.templateSha256
  ) {
    throw new Error("authority receipt canonical template binding is stale");
  }

  const canonicalBytes = await fs.readFile(
    path.join(inputDirectory, "canonical-rendered.json"),
  );
  const canonicalRaw = exactUtf8Text(
    canonicalBytes,
    "rendered canonical manifest",
  );
  const blockedManifestRaw = {};
  for (const candidateArm of ARMS) {
    const blockedBytes = await fs.readFile(
      path.join(
        inputDirectory,
        `proxywar-spatial-xp-${candidateArm}-blocked.json`,
      ),
    );
    const blockedRaw = exactUtf8Text(
      blockedBytes,
      `${candidateArm} blocked manifest`,
    );
    blockedManifestRaw[candidateArm] = blockedRaw;
  }
  const { blockedManifests } = validateCanonicalUploadInputs(
    templateRaw,
    canonicalRaw,
    blockedManifestRaw,
    receipt,
    head,
  );
  const manifests = {};
  const verifiedManifestRaw = {};
  for (const candidateArm of ARMS) {
    const manifestPath = path.join(
      inputDirectory,
      `proxywar-spatial-xp-${candidateArm}-verified.json`,
    );
    const raw = exactUtf8Text(
      await fs.readFile(manifestPath),
      `${candidateArm} verified manifest`,
    );
    verifiedManifestRaw[candidateArm] = raw;
    manifests[candidateArm] = parseJson(
      raw,
      `${candidateArm} verified manifest`,
    );
  }
  const derivedManifests = validateVerifiedSpatialXpReceiptTransition(
    blockedManifests,
    manifests,
    receipt,
    receiptSha256,
  );
  for (const candidateArm of ARMS) {
    if (
      verifiedManifestRaw[candidateArm] !==
      `${JSON.stringify(derivedManifests[candidateArm], null, 2)}\n`
    ) {
      throw new Error(
        `${candidateArm} verified manifest is not the deterministic receipt transition`,
      );
    }
  }
  validateVerifiedSpatialXpArmParity(manifests, receipt, receiptSha256);
  const selectedManifestPath = path.join(
    inputDirectory,
    `proxywar-spatial-xp-${arm}-verified.json`,
  );
  if (manifests[arm].game.name !== SPATIAL_XP_GAME_NAMES[arm]) {
    throw new Error("selected spatial XP arm name is not exact");
  }

  const coworldPackageSpec = `coworld==${coworldVersion}`;
  const preUploadEvidence = {};
  for (const image of receipt.images) {
    const coworld = runExactCommand(
      "uvx",
      [
        "--from",
        coworldPackageSpec,
        "coworld",
        "images",
        image.coworldImageID,
        "--json",
      ],
      `${image.role} pre-upload Coworld image fetch`,
    );
    const imageStatus = validateCoworldImageResponse(
      parseJson(coworld.raw, "Coworld image"),
      image,
    );
    const inspect = runExactCommand(
      "docker",
      ["image", "inspect", image.immutableLocalReference],
      `${image.role} pre-upload immutable Docker inspect`,
    );
    validateDockerDigestInspect(inspect.raw, image);
    if (
      (imageStatus === "ready" &&
        coworld.sha256 !== image.coworldResponseSha256) ||
      inspect.sha256 !== image.immutableInspectSha256
    ) {
      throw new Error(
        `${image.role} current authority bytes do not match the receipt`,
      );
    }
    preUploadEvidence[image.role] = { coworld, inspect };
  }

  await fs.mkdir(path.dirname(evidenceDirectory), { recursive: true });
  await fs.mkdir(evidenceDirectory);
  for (const image of receipt.images) {
    await fs.writeFile(
      path.join(
        evidenceDirectory,
        `${image.role}-preupload-coworld-image.json`,
      ),
      preUploadEvidence[image.role].coworld.raw,
      { flag: "wx" },
    );
    await fs.writeFile(
      path.join(
        evidenceDirectory,
        `${image.role}-preupload-docker-inspect.json`,
      ),
      preUploadEvidence[image.role].inspect.raw,
      { flag: "wx" },
    );
  }

  const stagingDirectory = path.join(evidenceDirectory, "staging");
  const stagedManifestPath = path.join(stagingDirectory, "manifest.json");
  const replayViewerDirectory = path.join(
    stagingDirectory,
    "build",
    "static-replay-viewer",
  );
  await fs.mkdir(stagingDirectory);
  await fs.copyFile(
    selectedManifestPath,
    stagedManifestPath,
    fs.constants.COPYFILE_EXCL,
  );
  runExactCommand(
    "bash",
    [
      path.join(
        REPOSITORY_ROOT,
        "coworld-adapter/coworld/tools/build_replay_viewer.sh",
      ),
      replayViewerDirectory,
    ],
    "exact-source replay viewer build",
    64 * 1024 * 1024,
  );
  const certification = captureExactCommand(
    "uvx",
    [
      "--from",
      coworldPackageSpec,
      "coworld",
      "certify",
      stagedManifestPath,
      "--timeout-seconds",
      "300",
    ],
    `Coworld ${arm} immutable manifest certification`,
    64 * 1024 * 1024,
    { ...process.env, TMPDIR: certificationTemporaryRoot },
    canonicalAdapterRoot,
  );
  await fs.writeFile(
    path.join(evidenceDirectory, "certification-stdout.txt"),
    certification.raw,
    { flag: "wx" },
  );
  await fs.writeFile(
    path.join(evidenceDirectory, "certification-stderr.txt"),
    certification.stderrRaw,
    { flag: "wx" },
  );
  if (certification.signal !== null || certification.status !== 0) {
    const detail = certification.stderrRaw.trim().slice(-4096);
    throw new Error(
      `Coworld ${arm} immutable manifest certification failed with status ${String(certification.status)}${detail === "" ? "" : `: ${detail}`}`,
    );
  }

  const productionBefore = fetchProductionState(
    coworldPackageSpec,
    "immediate pre-upload",
  );
  await fs.writeFile(
    path.join(evidenceDirectory, "production-coworld-before.json"),
    productionBefore.coworld.raw,
    { flag: "wx" },
  );
  await fs.writeFile(
    path.join(evidenceDirectory, "production-league-before.json"),
    productionBefore.league.raw,
    { flag: "wx" },
  );

  const upload = runExactCommand(
    "uvx",
    [
      "--from",
      coworldPackageSpec,
      "python",
      "-c",
      uploadPython(),
      stagedManifestPath,
    ],
    `Coworld ${arm} package upload`,
    64 * 1024 * 1024,
  );
  await fs.writeFile(
    path.join(evidenceDirectory, "upload-stdout.txt"),
    upload.raw,
    { flag: "wx" },
  );
  const uploadResult = parseUploadResult(upload.raw);
  if (
    uploadResult.name !== SPATIAL_XP_GAME_NAMES[arm] ||
    uploadResult.version !== manifests[arm].game.version ||
    uploadResult.canonical !== false
  ) {
    throw new Error("Coworld upload result is not the exact noncanonical arm");
  }

  const stored = runExactCommand(
    "uvx",
    [
      "--from",
      coworldPackageSpec,
      "coworld",
      "show",
      uploadResult.id,
      "--json",
    ],
    "stored Coworld package fetch",
  );
  await fs.writeFile(
    path.join(evidenceDirectory, "stored-coworld.json"),
    stored.raw,
    { flag: "wx" },
  );
  const storedCoworld = record(
    parseJson(stored.raw, "stored Coworld package"),
    "stored Coworld package",
  );
  validateStoredCoworldUpload(
    storedCoworld,
    uploadResult,
    manifests[arm],
    receipt,
    arm,
  );

  const postUploadImages = {};
  for (const image of receipt.images) {
    const fetched = runExactCommand(
      "uvx",
      [
        "--from",
        coworldPackageSpec,
        "coworld",
        "images",
        image.coworldImageID,
        "--json",
      ],
      `${image.role} post-upload Coworld image fetch`,
    );
    validateCoworldImageResponse(
      parseJson(fetched.raw, "Coworld image"),
      image,
    );
    postUploadImages[image.role] = fetched;
    await fs.writeFile(
      path.join(
        evidenceDirectory,
        `${image.role}-postupload-coworld-image.json`,
      ),
      fetched.raw,
      { flag: "wx" },
    );
  }

  const productionAfter = fetchProductionState(
    coworldPackageSpec,
    "post-upload",
  );
  await fs.writeFile(
    path.join(evidenceDirectory, "production-coworld-after.json"),
    productionAfter.coworld.raw,
    { flag: "wx" },
  );
  await fs.writeFile(
    path.join(evidenceDirectory, "production-league-after.json"),
    productionAfter.league.raw,
    { flag: "wx" },
  );
  const canonicalPackageOrLeagueMutation =
    productionBefore.coworld.raw !== productionAfter.coworld.raw ||
    productionBefore.league.raw !== productionAfter.league.raw;
  if (canonicalPackageOrLeagueMutation) {
    throw new Error(
      "production Coworld package or league changed during eval upload",
    );
  }

  const transition = {
    schemaVersion: "proxywar-spatial-upload-transition-v1",
    arm,
    sourceSha: head,
    sourceTree: tree,
    authorityReceiptSha256: receiptSha256,
    coworldClientVersion: coworldVersion,
    immutableManifestCertificationSha256: certification.sha256,
    immutableManifestCertificationStderrSha256: certification.stderrSha256,
    uploadResult,
    storedCoworldResponseSha256: stored.sha256,
    productionBefore: {
      coworldResponseSha256: productionBefore.coworld.sha256,
      leagueResponseSha256: productionBefore.league.sha256,
    },
    productionAfter: {
      coworldResponseSha256: productionAfter.coworld.sha256,
      leagueResponseSha256: productionAfter.league.sha256,
    },
    preUpload: Object.fromEntries(
      receipt.images.map((image) => [
        image.role,
        {
          coworldResponseSha256: preUploadEvidence[image.role].coworld.sha256,
          immutableInspectSha256: preUploadEvidence[image.role].inspect.sha256,
        },
      ]),
    ),
    postUpload: Object.fromEntries(
      receipt.images.map((image) => [
        image.role,
        { coworldResponseSha256: postUploadImages[image.role].sha256 },
      ]),
    ),
    storedManifestImageIDsMatchReceipt: true,
    canonicalPackageOrLeagueMutation,
  };
  const transitionRaw = `${JSON.stringify(transition, null, 2)}\n`;
  await fs.writeFile(
    path.join(evidenceDirectory, "upload-transition-receipt.json"),
    transitionRaw,
    { flag: "wx" },
  );
  process.stdout.write(
    `${JSON.stringify({ arm, coworldID: uploadResult.id, authorityReceiptSha256: receiptSha256, uploadTransitionSha256: sha256(transitionRaw), storedManifestImageIDsMatchReceipt: true, nextGate: "hosted certification and smoke; no XP before both pass" })}\n`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
