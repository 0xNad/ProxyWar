import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSpatialXpManifest,
  SPATIAL_XP_ARM_DESCRIPTIONS,
  SPATIAL_XP_GAME_NAMES,
  SPATIAL_XP_IMAGE_AUTHORITY_PAGE_ID,
  spatialXpPackageVersion,
  SPATIAL_XP_UNVERIFIED_AUTHORITY_TEXT,
  SPATIAL_XP_UNVERIFIED_README_SECTION,
  SPATIAL_XP_UPLOAD_BLOCKED_DESCRIPTION,
} from "./build-spatial-xp-manifest.mjs";

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const RAW_SHA256 = /^[0-9a-f]{64}$/u;
const IMAGE_ID =
  /^img_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const FETCHED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;
const COWORLD_CLIENT_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const ROLES = Object.freeze(["game", "runnables", "commissioner"]);
const ARMS = Object.freeze(["off", "structured", "on"]);
const ROLE_TITLES = Object.freeze({
  game: "proxywar-spatial-xp",
  runnables: "proxywar-spatial-runnables",
  commissioner: "proxywar-spatial-commissioner",
});
const COWORLD_RESPONSE_KEYS = Object.freeze([
  "id",
  "name",
  "version",
  "client_hash",
  "status",
  "image_uri",
  "image_digest",
  "public_image_uri",
]);
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const CANONICAL_TEMPLATE_RELATIVE_PATH =
  "coworld-adapter/coworld/coworld_manifest_template.json";
const CANONICAL_TEMPLATE_PATH = path.join(
  REPOSITORY_ROOT,
  CANONICAL_TEMPLATE_RELATIVE_PATH,
);
const SPATIAL_XP_IMAGE_TAG_SHA_LENGTH = 9;

export const SPATIAL_XP_VERIFIED_AUTHORITY_STATUS = "verified";
export const SPATIAL_XP_VERIFIED_UPLOAD_BLOCKED = false;

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    throw new Error(`${label} fields do not match the authority schema`);
  }
}

function boundedString(value, maximum = 500) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  );
}

function sha256(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function gitBlobSha(raw) {
  const bytes = Buffer.from(raw, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
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

function parseHashedJson(raw, expectedSha256, label) {
  if (typeof raw !== "string") {
    throw new Error(`${label} must be supplied as exact UTF-8 text`);
  }
  if (!RAW_SHA256.test(expectedSha256)) {
    throw new Error(`${label} expected SHA-256 must be 64 lowercase hex`);
  }
  if (sha256(raw) !== expectedSha256) {
    throw new Error(`${label} SHA-256 mismatch`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function validateCoworldClientVersion(raw, expectedSha256) {
  if (!RAW_SHA256.test(expectedSha256)) {
    throw new Error("Coworld client version response SHA-256 is malformed");
  }
  if (typeof raw !== "string" || sha256(raw) !== expectedSha256) {
    throw new Error("Coworld client version response SHA-256 mismatch");
  }
  const version = raw.trim();
  if (!COWORLD_CLIENT_VERSION.test(version)) {
    throw new Error("Coworld client version is malformed");
  }
  return version;
}

function replaceExactCount(raw, placeholder, value, expectedCount) {
  if (raw.split(placeholder).length - 1 !== expectedCount) {
    throw new Error(
      `canonical template must contain exactly ${expectedCount} ${placeholder} placeholder(s)`,
    );
  }
  return raw.replaceAll(placeholder, value);
}

export function renderCanonicalManifest(templateRaw, expectedSourceSha) {
  const imageTagRevision = expectedSourceSha.slice(
    0,
    SPATIAL_XP_IMAGE_TAG_SHA_LENGTH,
  );
  let rendered = replaceExactCount(
    templateRaw,
    "{{GAME_IMAGE}}",
    `proxywar-spatial-xp:${imageTagRevision}`,
    1,
  );
  rendered = replaceExactCount(
    rendered,
    "{{RUNNABLES_IMAGE}}",
    `proxywar-spatial-runnables:${imageTagRevision}`,
    2,
  );
  rendered = replaceExactCount(
    rendered,
    "{{COMMISSIONER_IMAGE}}",
    `proxywar-spatial-commissioner:${imageTagRevision}`,
    1,
  );
  rendered = replaceExactCount(
    rendered,
    "{{SOURCE_SHA}}",
    expectedSourceSha,
    1,
  );
  if (/\{\{[^}]+\}\}/u.test(rendered)) {
    throw new Error("canonical template contains an unresolved placeholder");
  }
  let manifest;
  try {
    manifest = JSON.parse(rendered);
  } catch {
    throw new Error("canonical template is not valid JSON after rendering");
  }
  const game = record(manifest.game, "rendered canonical manifest.game");
  game.version = spatialXpPackageVersion(expectedSourceSha);
  return {
    imageTagRevision,
    manifest,
    raw: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

function manifestImages(manifest) {
  const game = record(manifest.game, "manifest.game");
  const gameRunnable = record(game.runnable, "manifest.game.runnable");
  if (!boundedString(gameRunnable.image, 300)) {
    throw new Error("manifest game image is missing or malformed");
  }
  const roleImages = (key) => {
    const entries = manifest[key];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`manifest ${key} runnables are missing`);
    }
    return entries.map((entry, index) => {
      const runnable = record(entry, `manifest.${key}[${index}]`);
      if (!boundedString(runnable.image, 300)) {
        throw new Error(`manifest ${key}[${index}] image is malformed`);
      }
      return runnable.image;
    });
  };
  return {
    game: [gameRunnable.image],
    runnables: [...roleImages("player"), ...roleImages("optimizer")],
    commissioner: roleImages("commissioner"),
  };
}

function immutableDockerReference(localTag, dockerID) {
  if (!SHA256.test(dockerID)) {
    throw new Error("immutable Docker reference requires an exact image id");
  }
  const lastSlash = localTag.lastIndexOf("/");
  const tagSeparator = localTag.lastIndexOf(":");
  if (tagSeparator <= lastSlash || tagSeparator === localTag.length - 1) {
    throw new Error("local Docker tag is not an exact tagged repository");
  }
  const repository = localTag.slice(0, tagSeparator);
  if (!boundedString(repository, 250) || repository.includes("@")) {
    throw new Error("local Docker repository is malformed");
  }
  return `${repository}@${dockerID}`;
}

function validateBlockedManifest(manifest, expectedSourceSha, expectedArm) {
  const game = record(manifest.game, "manifest.game");
  if (game.name !== SPATIAL_XP_GAME_NAMES[expectedArm]) {
    throw new Error(`manifest is not the exact ${expectedArm} spatial XP arm`);
  }
  if (
    typeof game.description !== "string" ||
    game.description.split(SPATIAL_XP_UPLOAD_BLOCKED_DESCRIPTION).length !== 2
  ) {
    throw new Error("manifest description is not exactly upload-blocked");
  }
  const runnable = record(game.runnable, "manifest.game.runnable");
  const env = record(runnable.env ?? {}, "manifest.game.runnable.env");
  const observation = env.PROXYWAR_TUNE_SPATIAL_OBSERVATION;
  const minimap = env.PROXYWAR_TUNE_SPATIAL_MINIMAP;
  const armEnvironmentIsExact =
    (expectedArm === "off" &&
      observation === undefined &&
      minimap === undefined) ||
    (expectedArm === "structured" &&
      observation === "1" &&
      minimap === undefined) ||
    (expectedArm === "on" && observation === "1" && minimap === "1");
  if (!armEnvironmentIsExact) {
    throw new Error("manifest spatial arm environment is not exact");
  }
  const docs = record(game.docs, "manifest.game.docs");
  const readme = record(docs.readme, "manifest.game.docs.readme");
  if (
    typeof readme.value !== "string" ||
    !readme.value.endsWith(SPATIAL_XP_UNVERIFIED_README_SECTION)
  ) {
    throw new Error("manifest readme is not the exact unverified candidate");
  }
  if (!Array.isArray(docs.pages)) {
    throw new Error("manifest docs pages are missing");
  }
  const authorityPages = docs.pages.filter(
    (page) =>
      page !== null &&
      typeof page === "object" &&
      page.id === SPATIAL_XP_IMAGE_AUTHORITY_PAGE_ID,
  );
  if (authorityPages.length !== 1) {
    throw new Error("manifest must contain one image authority gate");
  }
  const authorityPage = record(authorityPages[0], "image authority page");
  const authorityContent = record(
    authorityPage.content,
    "image authority page content",
  );
  if (
    authorityPage.title !== "Spatial XP image authority gate" ||
    authorityContent.type !== "text" ||
    authorityContent.value !== SPATIAL_XP_UNVERIFIED_AUTHORITY_TEXT
  ) {
    throw new Error("manifest image authority gate is not the exact hard stop");
  }
  const provenancePages = docs.pages.filter(
    (page) =>
      page !== null &&
      typeof page === "object" &&
      page.id === "proxywar-release-provenance",
  );
  if (provenancePages.length !== 1) {
    throw new Error("manifest must contain one release provenance page");
  }
  const provenanceContent = record(
    provenancePages[0].content,
    "release provenance content",
  );
  const sourceShas =
    provenanceContent.type === "text" &&
    typeof provenanceContent.value === "string"
      ? [
          ...provenanceContent.value.matchAll(
            /(?:^|\n)source_sha=([0-9a-f]{40})(?=\n|$)/gu,
          ),
        ].map((match) => match[1])
      : [];
  if (sourceShas.length !== 1 || sourceShas[0] !== expectedSourceSha) {
    throw new Error(
      `manifest source provenance must exactly match ${expectedSourceSha}`,
    );
  }
  return { authorityPage, images: manifestImages(manifest), readme };
}

function normalizedArmManifest(
  manifest,
  arm,
  authorityDescription = SPATIAL_XP_UPLOAD_BLOCKED_DESCRIPTION,
) {
  const normalized = structuredClone(manifest);
  const game = normalized.game;
  const descriptionSuffix =
    ` [NONCANONICAL XP ${arm.toUpperCase()}: ` +
    `${SPATIAL_XP_ARM_DESCRIPTIONS[arm]}; ` +
    `${authorityDescription}; never league-bind.]`;
  if (!game.description.endsWith(descriptionSuffix)) {
    throw new Error(`${arm} manifest description is not exact`);
  }
  game.name = "<SPATIAL_XP_ARM>";
  game.description = game.description.slice(0, -descriptionSuffix.length);
  delete game.runnable.env.PROXYWAR_TUNE_SPATIAL_OBSERVATION;
  delete game.runnable.env.PROXYWAR_TUNE_SPATIAL_MINIMAP;
  const armReadmeText = `This package is the ${arm} arm and must never replace or bind the canonical Proxy War league package.`;
  if (game.docs.readme.value.split(armReadmeText).length !== 2) {
    throw new Error(`${arm} manifest readme arm marker is not exact`);
  }
  game.docs.readme.value = game.docs.readme.value.replace(
    armReadmeText,
    "This package is the <SPATIAL_XP_ARM> arm and must never replace or bind the canonical Proxy War league package.",
  );
  return normalized;
}

export function validateSpatialXpArmParity(manifests, expectedSourceSha) {
  const armSet = record(manifests, "spatial XP manifest set");
  exactKeys(armSet, ARMS, "spatial XP manifest set");
  const validations = {};
  const normalized = {};
  for (const arm of ARMS) {
    const manifest = record(armSet[arm], `${arm} spatial XP manifest`);
    validations[arm] = validateBlockedManifest(
      manifest,
      expectedSourceSha,
      arm,
    );
    normalized[arm] = normalizedArmManifest(manifest, arm);
  }
  const offRaw = JSON.stringify(normalized.off);
  for (const arm of ["structured", "on"]) {
    if (JSON.stringify(normalized[arm]) !== offRaw) {
      throw new Error(
        `spatial XP ${arm} arm differs from OFF outside the exact spatial treatment`,
      );
    }
  }
  return validations;
}

function validateCoworldResponse(raw, expectedSha256, role) {
  const response = record(
    parseHashedJson(raw, expectedSha256, `${role} Coworld response`),
    `${role} Coworld response`,
  );
  exactKeys(response, COWORLD_RESPONSE_KEYS, `${role} Coworld response`);
  if (
    !IMAGE_ID.test(response.id) ||
    response.name !== ROLE_TITLES[role] ||
    !Number.isSafeInteger(response.version) ||
    response.version < 1 ||
    response.status !== "ready" ||
    !SHA256.test(response.client_hash) ||
    !SHA256.test(response.image_digest) ||
    (response.image_uri !== null && !boundedString(response.image_uri, 500)) ||
    (response.public_image_uri !== null &&
      !boundedString(response.public_image_uri, 500))
  ) {
    throw new Error(
      `${role} Coworld authority response is not ready and exact`,
    );
  }
  return response;
}

function validateDockerInspect(
  raw,
  expectedSha256,
  role,
  expectedReference,
  expectedSourceSha,
) {
  const parsed = parseHashedJson(raw, expectedSha256, `${role} Docker inspect`);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`${role} Docker inspect must contain exactly one image`);
  }
  const inspect = record(parsed[0], `${role} Docker inspect image`);
  const config = record(inspect.Config, `${role} Docker inspect Config`);
  const labels = record(config.Labels, `${role} Docker inspect labels`);
  const referenceList = expectedReference.includes("@")
    ? inspect.RepoDigests
    : inspect.RepoTags;
  if (
    !SHA256.test(inspect.Id) ||
    inspect.Os !== "linux" ||
    inspect.Architecture !== "amd64" ||
    !Array.isArray(referenceList) ||
    !referenceList.includes(expectedReference) ||
    labels["org.opencontainers.image.revision"] !== expectedSourceSha ||
    labels["org.opencontainers.image.source"] !==
      "https://github.com/0xNad/ProxyWar" ||
    labels["org.opencontainers.image.title"] !== ROLE_TITLES[role]
  ) {
    throw new Error(`${role} Docker inspect source/platform/tag join failed`);
  }
  return inspect;
}

function validateEvidence(
  evidence,
  expectedSourceSha,
  manifestImageMap,
  fetchedAt,
  requestedCoworldImageIDs,
) {
  if (!FETCHED_AT.test(fetchedAt)) {
    throw new Error("authority fetch time must be exact UTC seconds");
  }
  if (evidence === null || typeof evidence !== "object") {
    throw new Error("authority evidence must contain the three exact roles");
  }
  exactKeys(evidence, ROLES, "authority evidence");
  const verified = new Map();
  for (const role of ROLES) {
    const roleEvidence = record(evidence[role], `${role} evidence`);
    exactKeys(
      roleEvidence,
      [
        "coworldRaw",
        "coworldSha256",
        "immutableInspectRaw",
        "immutableInspectSha256",
        "inspectRaw",
        "inspectSha256",
      ],
      `${role} evidence`,
    );
    const expectedTags = manifestImageMap[role];
    if (new Set(expectedTags).size !== 1) {
      throw new Error(`manifest ${role} images are not one exact tag`);
    }
    const localTag = expectedTags[0];
    const coworld = validateCoworldResponse(
      roleEvidence.coworldRaw,
      roleEvidence.coworldSha256,
      role,
    );
    if (coworld.id !== requestedCoworldImageIDs[role]) {
      throw new Error(`${role} Coworld response id does not match the request`);
    }
    const inspect = validateDockerInspect(
      roleEvidence.inspectRaw,
      roleEvidence.inspectSha256,
      role,
      localTag,
      expectedSourceSha,
    );
    if (inspect.Id !== coworld.client_hash) {
      throw new Error(
        `${role} local Docker id does not match Coworld client hash`,
      );
    }
    const immutableLocalReference = immutableDockerReference(
      localTag,
      inspect.Id,
    );
    const immutableInspect = validateDockerInspect(
      roleEvidence.immutableInspectRaw,
      roleEvidence.immutableInspectSha256,
      role,
      immutableLocalReference,
      expectedSourceSha,
    );
    if (immutableInspect.Id !== inspect.Id) {
      throw new Error(
        `${role} immutable Docker reference does not resolve to the verified id`,
      );
    }
    verified.set(role, {
      role,
      localTag,
      platform: "linux/amd64",
      ociRevision: expectedSourceSha,
      localDockerID: inspect.Id,
      immutableLocalReference,
      coworldImageID: coworld.id,
      coworldName: coworld.name,
      coworldVersion: coworld.version,
      coworldStatus: coworld.status,
      coworldClientHash: coworld.client_hash,
      coworldImageDigest: coworld.image_digest,
      coworldResponseSha256: roleEvidence.coworldSha256,
      coworldResponseArtifact: `${role}-coworld-image.json`,
      localInspectSha256: roleEvidence.inspectSha256,
      localInspectArtifact: `${role}-docker-inspect.json`,
      localInspectCommand: ["docker", "image", "inspect", localTag],
      immutableInspectSha256: roleEvidence.immutableInspectSha256,
      immutableInspectArtifact: `${role}-docker-immutable-inspect.json`,
      immutableInspectCommand: [
        "docker",
        "image",
        "inspect",
        immutableLocalReference,
      ],
    });
  }
  const ids = [...verified.values()].map((entry) => entry.coworldImageID);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Coworld image ids must be unique across all three roles");
  }
  return verified;
}

function buildReceipt(
  sourceSha,
  sourceTree,
  manifestAuthority,
  fetchedAt,
  coworldClientVersion,
  coworldClientVersionSha256,
  images,
) {
  return {
    schemaVersion: "proxywar-spatial-verified-image-receipt-v1",
    generatedFrom: {
      coworldAuthority: "exact raw coworld images <id> --json response bytes",
      localAuthority: "exact raw docker image inspect response bytes",
      join: "local Docker Id equals Coworld client_hash",
      coworldClient: {
        package: "coworld",
        version: coworldClientVersion,
        versionCommand: [
          "uvx",
          "--from",
          "coworld",
          "python",
          "-c",
          'import importlib.metadata as m; print(m.version("coworld"))',
        ],
        versionResponseArtifact: "coworld-client-version.txt",
        versionResponseSha256: coworldClientVersionSha256,
      },
      sourceCheckout: {
        revision: sourceSha,
        tree: sourceTree,
        trackedStatus: "clean",
        revisionCommand: ["git", "rev-parse", "HEAD"],
        treeCommand: ["git", "rev-parse", "HEAD^{tree}"],
        statusCommand: [
          "git",
          "status",
          "--porcelain=v1",
          "--untracked-files=no",
        ],
        templateBlobCommand: [
          "git",
          "rev-parse",
          `HEAD:${CANONICAL_TEMPLATE_RELATIVE_PATH}`,
        ],
      },
    },
    fetchedAt,
    sourceSha,
    sourceTree,
    manifestAuthority,
    canonicalPackageOrLeagueMutation: false,
    images: ROLES.map((role) => ({
      ...images.get(role),
      coworldFetchCommand: [
        "uvx",
        "--from",
        `coworld==${coworldClientVersion}`,
        "coworld",
        "images",
        images.get(role).coworldImageID,
        "--json",
      ],
    })),
  };
}

function authorityText(receipt, receiptSha256) {
  const lines = [
    `status=${SPATIAL_XP_VERIFIED_AUTHORITY_STATUS}`,
    `upload_blocked=${String(SPATIAL_XP_VERIFIED_UPLOAD_BLOCKED)}`,
    `source_sha=${receipt.sourceSha}`,
    `source_tree=${receipt.sourceTree}`,
    `canonical_template_git_blob=${receipt.manifestAuthority.templateGitBlob}`,
    `canonical_template_sha256=${receipt.manifestAuthority.templateSha256}`,
    `rendered_canonical_sha256=${receipt.manifestAuthority.renderedCanonicalSha256}`,
    `receipt_sha256=${receiptSha256}`,
    `receipt_fetched_at=${receipt.fetchedAt}`,
    `coworld_client_version=${receipt.generatedFrom.coworldClient.version}`,
    `coworld_client_version_response_sha256=${receipt.generatedFrom.coworldClient.versionResponseSha256}`,
    "authority_split=coworld:id_status_client_hash_image_digest;local_docker:platform_revision_tag",
  ];
  for (const arm of ARMS) {
    lines.push(
      `${arm}_blocked_manifest_sha256=${receipt.manifestAuthority.blockedManifestSha256[arm]}`,
    );
  }
  for (const image of receipt.images) {
    lines.push(
      `${image.role}_image_id=${image.coworldImageID}`,
      `${image.role}_client_hash=${image.coworldClientHash}`,
      `${image.role}_image_digest=${image.coworldImageDigest}`,
      `${image.role}_immutable_local_reference=${image.immutableLocalReference}`,
      `${image.role}_coworld_response_sha256=${image.coworldResponseSha256}`,
      `${image.role}_local_inspect_sha256=${image.localInspectSha256}`,
      `${image.role}_immutable_inspect_sha256=${image.immutableInspectSha256}`,
    );
  }
  return lines.join("\n");
}

function verifiedReadmeSection(receipt, receiptSha256) {
  const lines = [
    "## Image Authority Receipt",
    "",
    `Authority evidence was fetched at ${receipt.fetchedAt} with Coworld client ${receipt.generatedFrom.coworldClient.version}; the exact generated receipt SHA-256 is ${receiptSha256}.`,
    `The exact clean source revision is ${receipt.sourceSha} with Git tree ${receipt.sourceTree}. The checked-in canonical template Git blob is ${receipt.manifestAuthority.templateGitBlob}, and the deterministically rendered canonical SHA-256 is ${receipt.manifestAuthority.renderedCanonicalSha256}; all three blocked-arm hashes are recorded in the receipt and differ only by the declared spatial treatment. Coworld proves each image ID, ready status, client hash, and immutable digest; local Docker proves linux/amd64, exact tag, and OCI revision. The join is exact equality of local Docker Id and Coworld client_hash.`,
  ];
  for (const image of receipt.images) {
    lines.push(
      `${image.role}: ${image.coworldImageID}; client hash ${image.coworldClientHash}; immutable digest ${image.coworldImageDigest}; finalized local reference ${image.immutableLocalReference}; Coworld-response SHA-256 ${image.coworldResponseSha256}; tag-inspect SHA-256 ${image.localInspectSha256}; immutable-inspect SHA-256 ${image.immutableInspectSha256}.`,
    );
  }
  lines.push(
    "This package remains noncanonical, eval-only, and must never replace or bind the canonical Proxy War league package.",
    "",
  );
  return lines.join("\n");
}

function validateAuthorityContext(authorityContext, expectedSourceSha) {
  if (!SHA40.test(expectedSourceSha)) {
    throw new Error("expected source SHA must be 40 lowercase hex");
  }
  const context = record(authorityContext, "authority context");
  exactKeys(
    context,
    [
      "coworldClientVersionRaw",
      "coworldClientVersionSha256",
      "fetchedAt",
      "requestedCoworldImageIDs",
      "sourceTree",
      "templateGitBlob",
    ],
    "authority context",
  );
  if (!FETCHED_AT.test(context.fetchedAt)) {
    throw new Error("authority fetch time must be exact UTC seconds");
  }
  if (!SHA40.test(context.sourceTree)) {
    throw new Error("source tree must be 40 lowercase hex");
  }
  if (!SHA40.test(context.templateGitBlob)) {
    throw new Error("canonical template Git blob must be 40 lowercase hex");
  }
  const coworldClientVersion = validateCoworldClientVersion(
    context.coworldClientVersionRaw,
    context.coworldClientVersionSha256,
  );
  const requestedCoworldImageIDs = record(
    context.requestedCoworldImageIDs,
    "requested Coworld image ids",
  );
  exactKeys(requestedCoworldImageIDs, ROLES, "requested Coworld image ids");
  for (const role of ROLES) {
    if (!IMAGE_ID.test(requestedCoworldImageIDs[role])) {
      throw new Error(`${role} requested Coworld image id is malformed`);
    }
  }
  if (new Set(Object.values(requestedCoworldImageIDs)).size !== ROLES.length) {
    throw new Error("requested Coworld image ids must be unique");
  }
  return { context, coworldClientVersion, requestedCoworldImageIDs };
}

function replaceManifestImageReference(entry, image, label) {
  const runnable = record(entry, label);
  if (runnable.image !== image.localTag) {
    throw new Error(`${label} does not match the verified local tag`);
  }
  runnable.image = image.immutableLocalReference;
}

function applyImmutableManifestImages(manifest, receipt) {
  const images = new Map(receipt.images.map((image) => [image.role, image]));
  replaceManifestImageReference(
    manifest.game.runnable,
    images.get("game"),
    "verified manifest game runnable",
  );
  for (const [key, role] of [
    ["player", "runnables"],
    ["optimizer", "runnables"],
    ["commissioner", "commissioner"],
  ]) {
    const entries = manifest[key];
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`verified manifest ${key} entries are missing`);
    }
    for (const [index, entry] of entries.entries()) {
      replaceManifestImageReference(
        entry,
        images.get(role),
        `verified manifest ${key}[${index}]`,
      );
    }
  }
}

function applyVerifiedReceipt(
  blockedManifest,
  validation,
  receipt,
  receiptSha256,
) {
  const finalized = structuredClone(blockedManifest);
  const finalizedGame = finalized.game;
  finalizedGame.description = finalizedGame.description.replace(
    SPATIAL_XP_UPLOAD_BLOCKED_DESCRIPTION,
    `IMAGE AUTHORITY VERIFIED by receipt sha256:${receiptSha256}`,
  );
  finalizedGame.docs.readme.value =
    validation.readme.value.slice(
      0,
      -SPATIAL_XP_UNVERIFIED_README_SECTION.length,
    ) + verifiedReadmeSection(receipt, receiptSha256);
  const finalizedAuthorityPage = finalizedGame.docs.pages.find(
    (page) => page.id === validation.authorityPage.id,
  );
  finalizedAuthorityPage.title = "Spatial XP image authority receipt";
  finalizedAuthorityPage.content.value = authorityText(receipt, receiptSha256);
  applyImmutableManifestImages(finalized, receipt);
  return finalized;
}

export function validateVerifiedSpatialXpArmParity(
  manifests,
  receipt,
  receiptSha256,
) {
  const armSet = record(manifests, "verified spatial XP manifest set");
  exactKeys(armSet, ARMS, "verified spatial XP manifest set");
  const receiptRecord = record(receipt, "spatial XP authority receipt");
  const receiptImages = new Map(
    receiptRecord.images.map((image) => [image.role, image]),
  );
  const normalized = {};
  const authorityDescription = `IMAGE AUTHORITY VERIFIED by receipt sha256:${receiptSha256}`;
  for (const arm of ARMS) {
    const manifest = record(armSet[arm], `${arm} verified spatial XP manifest`);
    const game = record(manifest.game, `${arm} verified manifest.game`);
    if (game.name !== SPATIAL_XP_GAME_NAMES[arm]) {
      throw new Error(`${arm} verified manifest name is not exact`);
    }
    const env = record(
      game.runnable?.env ?? {},
      `${arm} verified manifest.game.runnable.env`,
    );
    const observation = env.PROXYWAR_TUNE_SPATIAL_OBSERVATION;
    const minimap = env.PROXYWAR_TUNE_SPATIAL_MINIMAP;
    const environmentIsExact =
      (arm === "off" && observation === undefined && minimap === undefined) ||
      (arm === "structured" && observation === "1" && minimap === undefined) ||
      (arm === "on" && observation === "1" && minimap === "1");
    if (!environmentIsExact) {
      throw new Error(
        `${arm} verified manifest spatial environment is not exact`,
      );
    }
    const manifestImageMap = manifestImages(manifest);
    for (const role of ROLES) {
      const expectedReference = receiptImages.get(role).immutableLocalReference;
      if (
        new Set(manifestImageMap[role]).size !== 1 ||
        manifestImageMap[role][0] !== expectedReference
      ) {
        throw new Error(
          `${arm} verified manifest ${role} image is not immutable and exact`,
        );
      }
    }
    normalized[arm] = normalizedArmManifest(
      manifest,
      arm,
      authorityDescription,
    );
  }
  const offRaw = JSON.stringify(normalized.off);
  for (const arm of ["structured", "on"]) {
    if (JSON.stringify(normalized[arm]) !== offRaw) {
      throw new Error(
        `verified spatial XP ${arm} arm differs from OFF outside the exact spatial treatment`,
      );
    }
  }
}

export function deriveVerifiedSpatialXpManifestSet(
  blockedManifests,
  receipt,
  receiptSha256,
) {
  const validations = validateSpatialXpArmParity(
    blockedManifests,
    receipt.sourceSha,
  );
  const manifests = Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      applyVerifiedReceipt(
        blockedManifests[arm],
        validations[arm],
        receipt,
        receiptSha256,
      ),
    ]),
  );
  validateVerifiedSpatialXpArmParity(manifests, receipt, receiptSha256);
  return manifests;
}

export function validateVerifiedSpatialXpReceiptTransition(
  blockedManifests,
  manifests,
  receipt,
  receiptSha256,
) {
  const derived = deriveVerifiedSpatialXpManifestSet(
    blockedManifests,
    receipt,
    receiptSha256,
  );
  for (const arm of ARMS) {
    if (JSON.stringify(manifests[arm]) !== JSON.stringify(derived[arm])) {
      throw new Error(
        `${arm} verified manifest is not the deterministic receipt transition`,
      );
    }
  }
  return derived;
}

export function finalizeSpatialXpManifestSet(
  canonicalTemplateRaw,
  evidence,
  expectedSourceSha,
  authorityContext,
) {
  if (typeof canonicalTemplateRaw !== "string") {
    throw new Error("canonical template must be supplied as exact UTF-8 text");
  }
  const { context, coworldClientVersion, requestedCoworldImageIDs } =
    validateAuthorityContext(authorityContext, expectedSourceSha);
  if (gitBlobSha(canonicalTemplateRaw) !== context.templateGitBlob) {
    throw new Error(
      "canonical template bytes do not match the clean checkout Git blob",
    );
  }
  const canonical = renderCanonicalManifest(
    canonicalTemplateRaw,
    expectedSourceSha,
  );
  const blockedManifests = {};
  const blockedManifestRaw = {};
  for (const arm of ARMS) {
    blockedManifests[arm] = buildSpatialXpManifest(
      canonical.manifest,
      arm,
      expectedSourceSha,
    );
    blockedManifestRaw[arm] =
      `${JSON.stringify(blockedManifests[arm], null, 2)}\n`;
  }
  const validations = validateSpatialXpArmParity(
    blockedManifests,
    expectedSourceSha,
  );
  const images = validateEvidence(
    evidence,
    expectedSourceSha,
    validations.off.images,
    context.fetchedAt,
    requestedCoworldImageIDs,
  );
  const manifestAuthority = {
    templatePath: CANONICAL_TEMPLATE_RELATIVE_PATH,
    templateGitBlob: context.templateGitBlob,
    templateSha256: sha256(canonicalTemplateRaw),
    renderedCanonicalSha256: sha256(canonical.raw),
    imageTagRevision: canonical.imageTagRevision,
    causalContract:
      "all three manifests are deterministic derivatives of one canonical input and differ only by exact arm name, description, spatial env, and readme arm marker",
    blockedManifestSha256: Object.fromEntries(
      ARMS.map((arm) => [arm, sha256(blockedManifestRaw[arm])]),
    ),
  };
  const receipt = buildReceipt(
    expectedSourceSha,
    context.sourceTree,
    manifestAuthority,
    context.fetchedAt,
    coworldClientVersion,
    context.coworldClientVersionSha256,
    images,
  );
  const receiptRaw = `${JSON.stringify(receipt, null, 2)}\n`;
  const receiptSha256 = sha256(receiptRaw);
  const manifests = deriveVerifiedSpatialXpManifestSet(
    blockedManifests,
    receipt,
    receiptSha256,
  );
  validateVerifiedSpatialXpReceiptTransition(
    blockedManifests,
    manifests,
    receipt,
    receiptSha256,
  );
  return {
    blockedManifests,
    blockedManifestRaw,
    canonicalManifest: canonical.manifest,
    canonicalManifestRaw: canonical.raw,
    manifests,
    receipt,
    receiptRaw,
    receiptSha256,
  };
}

function parseArgs(args) {
  const keys = [
    "output-dir",
    "evidence-dir",
    "source-sha",
    ...ROLES.map((role) => `coworld-${role}-id`),
  ];
  const parsed = {};
  for (const arg of args) {
    const match = /^--([a-z0-9-]+)=(.+)$/u.exec(arg);
    if (
      match === null ||
      !keys.includes(match[1]) ||
      Object.hasOwn(parsed, match[1])
    ) {
      throw new Error("invalid or duplicate spatial XP finalizer argument");
    }
    parsed[match[1]] = match[2];
  }
  if (keys.some((key) => parsed[key] === undefined)) {
    throw new Error(
      "spatial XP finalizer requires output-dir/evidence-dir/source-sha and exact Coworld image ids for game, runnables, and commissioner",
    );
  }
  return parsed;
}

function runExactCommand(command, args, label) {
  const result = spawnSync(command, args, {
    encoding: "buffer",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  if (result.signal !== null || result.status !== 0) {
    throw new Error(`${label} failed with status ${String(result.status)}`);
  }
  const raw = exactUtf8Text(result.stdout, label);
  return { raw, sha256: sha256(result.stdout) };
}

function exactUtcSeconds() {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
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
  const outputDirectory = path.resolve(options["output-dir"]);
  const evidenceDirectory = path.resolve(options["evidence-dir"]);
  const receiptOutput = path.join(
    outputDirectory,
    "image-authority-receipt.json",
  );
  const blockedOutputPaths = Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      path.join(outputDirectory, `proxywar-spatial-xp-${arm}-blocked.json`),
    ]),
  );
  const verifiedOutputPaths = Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      path.join(outputDirectory, `proxywar-spatial-xp-${arm}-verified.json`),
    ]),
  );
  const evidencePaths = [
    path.join(evidenceDirectory, "coworld-client-version.txt"),
    ...ROLES.flatMap((role) => [
      path.join(evidenceDirectory, `${role}-coworld-image.json`),
      path.join(evidenceDirectory, `${role}-docker-inspect.json`),
      path.join(evidenceDirectory, `${role}-docker-immutable-inspect.json`),
    ]),
  ];
  if (
    pathIsInside(evidenceDirectory, CANONICAL_TEMPLATE_PATH) ||
    pathIsInside(outputDirectory, CANONICAL_TEMPLATE_PATH) ||
    pathIsInside(evidenceDirectory, outputDirectory) ||
    pathIsInside(outputDirectory, evidenceDirectory)
  ) {
    throw new Error(
      "spatial XP finalizer template, output directory, and evidence directory must be separate",
    );
  }
  await requireMissing(outputDirectory, "spatial XP output directory");
  await requireMissing(evidenceDirectory, "authority evidence directory");
  if (!SHA40.test(options["source-sha"])) {
    throw new Error("expected source SHA must be 40 lowercase hex");
  }
  const sourceRevisionEvidence = runExactCommand(
    "git",
    ["-C", REPOSITORY_ROOT, "rev-parse", "HEAD"],
    "source revision verification",
  );
  const sourceRevision = sourceRevisionEvidence.raw.trim();
  if (sourceRevision !== options["source-sha"]) {
    throw new Error(
      "running checkout HEAD does not match the expected source SHA",
    );
  }
  const sourceTreeEvidence = runExactCommand(
    "git",
    ["-C", REPOSITORY_ROOT, "rev-parse", "HEAD^{tree}"],
    "source tree verification",
  );
  const sourceTree = sourceTreeEvidence.raw.trim();
  if (!SHA40.test(sourceTree)) {
    throw new Error("running checkout tree is malformed");
  }
  const sourceStatusEvidence = runExactCommand(
    "git",
    ["-C", REPOSITORY_ROOT, "status", "--porcelain=v1", "--untracked-files=no"],
    "source checkout status verification",
  );
  if (sourceStatusEvidence.raw !== "") {
    throw new Error("running checkout has tracked changes");
  }
  const templateHeadBlobEvidence = runExactCommand(
    "git",
    [
      "-C",
      REPOSITORY_ROOT,
      "rev-parse",
      `HEAD:${CANONICAL_TEMPLATE_RELATIVE_PATH}`,
    ],
    "canonical template HEAD blob verification",
  );
  const templateGitBlob = templateHeadBlobEvidence.raw.trim();
  if (!SHA40.test(templateGitBlob)) {
    throw new Error("canonical template HEAD blob is malformed");
  }
  const canonicalTemplateBytes = await fs.readFile(CANONICAL_TEMPLATE_PATH);
  const canonicalTemplateRaw = exactUtf8Text(
    canonicalTemplateBytes,
    "canonical template",
  );
  if (gitBlobSha(canonicalTemplateRaw) !== templateGitBlob) {
    throw new Error(
      "canonical template bytes do not match the clean checkout Git blob",
    );
  }
  const canonical = renderCanonicalManifest(
    canonicalTemplateRaw,
    options["source-sha"],
  );
  const blockedManifests = Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      buildSpatialXpManifest(canonical.manifest, arm, options["source-sha"]),
    ]),
  );
  const validations = validateSpatialXpArmParity(
    blockedManifests,
    options["source-sha"],
  );
  const manifestImageMap = validations.off.images;
  const requestedCoworldImageIDs = {};
  for (const role of ROLES) {
    const imageID = options[`coworld-${role}-id`];
    if (!IMAGE_ID.test(imageID)) {
      throw new Error(`${role} Coworld image id is malformed`);
    }
    requestedCoworldImageIDs[role] = imageID;
  }
  if (new Set(Object.values(requestedCoworldImageIDs)).size !== ROLES.length) {
    throw new Error("requested Coworld image ids must be unique");
  }
  const clientVersionEvidence = runExactCommand(
    "uvx",
    [
      "--from",
      "coworld",
      "python",
      "-c",
      'import importlib.metadata as m; print(m.version("coworld"))',
    ],
    "Coworld client version fetch",
  );
  const coworldClientVersion = validateCoworldClientVersion(
    clientVersionEvidence.raw,
    clientVersionEvidence.sha256,
  );
  const coworldPackageSpec = `coworld==${coworldClientVersion}`;
  const evidence = {};
  for (const role of ROLES) {
    const coworld = runExactCommand(
      "uvx",
      [
        "--from",
        coworldPackageSpec,
        "coworld",
        "images",
        requestedCoworldImageIDs[role],
        "--json",
      ],
      `${role} Coworld image fetch`,
    );
    const expectedTags = manifestImageMap[role];
    if (new Set(expectedTags).size !== 1) {
      throw new Error(`manifest ${role} images are not one exact tag`);
    }
    const inspect = runExactCommand(
      "docker",
      ["image", "inspect", expectedTags[0]],
      `${role} Docker image inspect`,
    );
    const validatedInspect = validateDockerInspect(
      inspect.raw,
      inspect.sha256,
      role,
      expectedTags[0],
      options["source-sha"],
    );
    const immutableReference = immutableDockerReference(
      expectedTags[0],
      validatedInspect.Id,
    );
    const immutableInspect = runExactCommand(
      "docker",
      ["image", "inspect", immutableReference],
      `${role} immutable Docker image inspect`,
    );
    evidence[role] = {
      coworldRaw: coworld.raw,
      coworldSha256: coworld.sha256,
      immutableInspectRaw: immutableInspect.raw,
      immutableInspectSha256: immutableInspect.sha256,
      inspectRaw: inspect.raw,
      inspectSha256: inspect.sha256,
    };
  }
  const fetchedAt = exactUtcSeconds();
  const finalized = finalizeSpatialXpManifestSet(
    canonicalTemplateRaw,
    evidence,
    options["source-sha"],
    {
      coworldClientVersionRaw: clientVersionEvidence.raw,
      coworldClientVersionSha256: clientVersionEvidence.sha256,
      fetchedAt,
      requestedCoworldImageIDs,
      sourceTree,
      templateGitBlob,
    },
  );
  await fs.mkdir(path.dirname(evidenceDirectory), { recursive: true });
  await fs.mkdir(evidenceDirectory);
  await fs.writeFile(evidencePaths[0], clientVersionEvidence.raw, {
    flag: "wx",
  });
  for (const [index, role] of ROLES.entries()) {
    await fs.writeFile(
      evidencePaths[1 + index * 3],
      evidence[role].coworldRaw,
      {
        flag: "wx",
      },
    );
    await fs.writeFile(
      evidencePaths[2 + index * 3],
      evidence[role].inspectRaw,
      { flag: "wx" },
    );
    await fs.writeFile(
      evidencePaths[3 + index * 3],
      evidence[role].immutableInspectRaw,
      { flag: "wx" },
    );
  }
  await fs.mkdir(path.dirname(outputDirectory), { recursive: true });
  await fs.mkdir(outputDirectory);
  await fs.writeFile(
    path.join(outputDirectory, "canonical-rendered.json"),
    finalized.canonicalManifestRaw,
    { flag: "wx" },
  );
  for (const arm of ARMS) {
    await fs.writeFile(
      blockedOutputPaths[arm],
      finalized.blockedManifestRaw[arm],
      {
        flag: "wx",
      },
    );
    await fs.writeFile(
      verifiedOutputPaths[arm],
      `${JSON.stringify(finalized.manifests[arm], null, 2)}\n`,
      {
        flag: "wx",
      },
    );
  }
  await fs.writeFile(receiptOutput, finalized.receiptRaw, {
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({ canonicalTemplate: CANONICAL_TEMPLATE_PATH, templateGitBlob, templateSha256: finalized.receipt.manifestAuthority.templateSha256, renderedCanonicalSha256: finalized.receipt.manifestAuthority.renderedCanonicalSha256, outputDirectory, receiptOutput, evidenceDirectory, blockedManifestSha256: finalized.receipt.manifestAuthority.blockedManifestSha256, sourceSha: options["source-sha"], sourceTree, fetchedAt, coworldClientVersion, receiptSha256: finalized.receiptSha256, imageAuthorityStatus: SPATIAL_XP_VERIFIED_AUTHORITY_STATUS, uploadBlocked: SPATIAL_XP_VERIFIED_UPLOAD_BLOCKED })}\n`,
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
