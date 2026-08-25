#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const COWORLD_ID =
  /^cow_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_ID =
  /^img_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_LABEL = /^[A-Za-z0-9._:/-]{1,200}$/;
const LOCAL_COMMISSIONER_IMAGE =
  /^proxywar-commissioner-local:coworld-[0-9a-f]{12}$/;

export const COWORLD_NAME = "proxywar";
export const LEAGUE_ID = "league_cb60d526-ecfd-4836-ab3a-81fc6cf7dc42";
export const COMMISSIONER_RUNNABLE_ID = "proxywar-ladder-commissioner";
const PROVENANCE_PAGE_ID = "proxywar-release-provenance";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sourceSha(value) {
  invariant(
    SOURCE_SHA.test(value ?? ""),
    "source SHA must be 40 lowercase hex characters",
  );
  return value;
}

function semanticVersion(value, label = "version") {
  invariant(
    SEMVER.test(value ?? ""),
    `${label} must be a semantic x.y.z version`,
  );
  return value;
}

function jsonArray(value, label) {
  invariant(Array.isArray(value), `${label} must be an array`);
  return value;
}

function exactSingle(values, label) {
  invariant(values.length === 1, `${label} must resolve exactly once`);
  return values[0];
}

function latestByCreatedAt(values) {
  return [...values].sort((left, right) =>
    String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")),
  )[0];
}

export function extractSourceSha(manifest) {
  const page = manifest?.game?.docs?.pages?.find(
    (entry) =>
      entry?.id === PROVENANCE_PAGE_ID && entry?.content?.type === "text",
  );
  const match = page?.content?.value?.match(
    /(?:^|\n)source_sha=([0-9a-f]{40})(?:\n|$)/,
  );
  return match?.[1] ?? null;
}

export function selectSuccessfulMainCiRun(payload, expectedSourceSha) {
  const sha = sourceSha(expectedSourceSha);
  const matches = jsonArray(payload?.workflow_runs, "CI workflow runs").filter(
    (run) =>
      run?.head_sha === sha &&
      run?.head_branch === "main" &&
      ["push", "workflow_dispatch"].includes(run?.event) &&
      run?.status === "completed" &&
      run?.conclusion === "success" &&
      Number.isSafeInteger(run?.id) &&
      run.id > 0,
  );
  invariant(
    matches.length > 0,
    `no successful exact-source main CI exists for ${sha}`,
  );
  const selected = latestByCreatedAt(matches);
  return { mainCiRunId: selected.id, sourceSha: sha };
}

export function selectSuccessfulProductionRun(payload, expectedSourceSha) {
  const sha = sourceSha(expectedSourceSha);
  const matches = jsonArray(
    payload?.workflow_runs,
    "production workflow runs",
  ).filter(
    (run) =>
      run?.head_sha === sha &&
      run?.head_branch === "main" &&
      run?.event === "workflow_dispatch" &&
      run?.status === "completed" &&
      run?.conclusion === "success" &&
      run?.display_title === `Coworld production ${sha}` &&
      Number.isSafeInteger(run?.id) &&
      run.id > 0,
  );
  invariant(
    matches.length > 0,
    `no successful exact-source Coworld production run exists for ${sha}`,
  );
  const selected = latestByCreatedAt(matches);
  return { releaseRunId: selected.id, sourceSha: sha };
}

export function selectImmutableReleaseArtifact(payload, expectedSourceSha) {
  const sha = sourceSha(expectedSourceSha);
  const name = `coworld-release-${sha}`;
  const artifact = exactSingle(
    jsonArray(payload?.artifacts, "release artifacts").filter(
      (entry) => entry?.name === name,
    ),
    name,
  );
  invariant(
    artifact.expired === false,
    "exact-source release artifact is expired",
  );
  invariant(
    Number.isSafeInteger(artifact.id) && artifact.id > 0,
    "release artifact id is invalid",
  );
  invariant(
    Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0,
    "release artifact is empty",
  );
  return {
    releaseArtifactId: artifact.id,
    releaseArtifactName: name,
    releaseArtifactBytes: artifact.size_in_bytes,
    sourceSha: sha,
  };
}

function certifiedTenOfTen(status) {
  const summary = status?.certification?.transcript_summary;
  return (
    status?.certification?.state === "certified" &&
    Array.isArray(summary) &&
    summary.length === 10 &&
    summary.every((entry) => entry?.status === "pass")
  );
}

function commissioner(manifest, expectedImagePattern) {
  const runnable = exactSingle(
    jsonArray(manifest?.commissioner, "manifest commissioner runnables"),
    "commissioner runnable",
  );
  invariant(
    runnable?.id === COMMISSIONER_RUNNABLE_ID,
    `commissioner runnable id must be ${COMMISSIONER_RUNNABLE_ID}`,
  );
  invariant(
    expectedImagePattern.test(runnable?.image ?? ""),
    "commissioner image identity is malformed",
  );
  return runnable;
}

export function validateCanonicalSourceRelease({
  coworlds,
  status,
  league,
  expectedSourceSha,
}) {
  const sha = sourceSha(expectedSourceSha);
  const canonical = exactSingle(
    jsonArray(coworlds, "Coworld inventory").filter(
      (entry) => entry?.name === COWORLD_NAME && entry?.canonical === true,
    ),
    "canonical ProxyWar Coworld",
  );
  invariant(
    COWORLD_ID.test(canonical?.id ?? ""),
    "canonical Coworld id is malformed",
  );
  semanticVersion(canonical?.version, "canonical Coworld version");
  invariant(
    extractSourceSha(canonical?.manifest) === sha,
    "canonical Coworld provenance does not match source SHA",
  );
  invariant(
    status?.coworld?.canonical === true,
    "source Coworld is not canonical",
  );
  invariant(
    status?.coworld?.version === canonical.version,
    "status version does not match canonical inventory",
  );
  invariant(
    status?.coworld?.manifest?.game?.version === canonical.version,
    "status manifest version does not match canonical inventory",
  );
  invariant(
    extractSourceSha(status?.coworld?.manifest) === sha,
    "status provenance does not match source SHA",
  );
  invariant(certifiedTenOfTen(status), "source Coworld is not certified 10/10");
  const hostedCommissioner = commissioner(status.coworld.manifest, IMAGE_ID);
  invariant(league?.id === LEAGUE_ID, "unexpected league id");
  invariant(
    league?.game?.coworld_id === canonical.id,
    "league is not bound to the canonical source Coworld",
  );
  invariant(
    SAFE_LABEL.test(league?.commissioner_migration_version ?? ""),
    "league commissioner migration version is missing or malformed",
  );
  return {
    sourceSha: sha,
    sourceCoworldId: canonical.id,
    sourceCoworldVersion: canonical.version,
    sourceCommissionerImageId: hostedCommissioner.image,
    commissionerRunnableId: hostedCommissioner.id,
    previousCommissionerMigrationVersion: league.commissioner_migration_version,
  };
}

function manifestImageValues(manifest) {
  const values = [
    manifest?.game?.runnable?.image,
    ...["player", "commissioner", "optimizer"].flatMap((section) =>
      (manifest?.[section] ?? []).map((entry) => entry?.image),
    ),
  ];
  invariant(
    values.every((value) => typeof value === "string" && value.length > 0),
    "manifest contains an invalid image reference",
  );
  return [...new Set(values)].sort();
}

export function validateReleaseArtifact({
  releaseMetadata,
  manifest,
  imageList,
  expectedSourceSha,
  expectedVersion,
}) {
  const sha = sourceSha(expectedSourceSha);
  const version = semanticVersion(expectedVersion, "expected release version");
  invariant(
    releaseMetadata?.source_sha === sha,
    "release metadata source SHA mismatch",
  );
  invariant(
    releaseMetadata?.version === version,
    "release metadata version mismatch",
  );
  invariant(
    manifest?.game?.version === version,
    "release manifest version mismatch",
  );
  invariant(
    extractSourceSha(manifest) === sha,
    "release manifest provenance mismatch",
  );
  const localCommissioner = commissioner(manifest, LOCAL_COMMISSIONER_IMAGE);
  const expectedImages = manifestImageValues(manifest);
  invariant(Array.isArray(imageList), "release image list must be an array");
  invariant(
    JSON.stringify(imageList) === JSON.stringify(expectedImages),
    "release image inventory does not exactly match the release manifest",
  );
  return {
    commissionerRunnableId: localCommissioner.id,
    localCommissionerImage: localCommissioner.image,
    sourceSha: sha,
    sourceCoworldVersion: version,
  };
}

export function validateCommissionerImageInspection({ image, inspection }) {
  invariant(
    LOCAL_COMMISSIONER_IMAGE.test(image ?? ""),
    "local commissioner image reference is malformed",
  );
  const entry = exactSingle(
    jsonArray(inspection, "Docker image inspection"),
    "Docker image inspection entry",
  );
  invariant(
    DIGEST.test(entry?.Id ?? ""),
    "commissioner Docker image id is malformed",
  );
  invariant(
    entry?.Os === "linux" && entry?.Architecture === "amd64",
    "commissioner image must be linux/amd64",
  );
  invariant(
    Array.isArray(entry?.RepoTags) && entry.RepoTags.includes(image),
    "commissioner image tag is absent from Docker inspection",
  );
  return {
    localCommissionerImage: image,
    localCommissionerImageId: entry.Id,
    platform: "linux/amd64",
  };
}

function exactOutputValue(text, prefix, pattern) {
  const matches = String(text)
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  const value = exactSingle(matches, prefix.trim());
  invariant(pattern.test(value), `${prefix.trim()} output is malformed`);
  return value;
}

export function parsePatchCommissionerOutput(text) {
  const patched = exactOutputValue(
    text,
    "Patched commissioner: ",
    /^proxywar:(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/,
  );
  const canonical = exactOutputValue(text, "Canonical: ", /^yes$/);
  invariant(canonical === "yes", "patched Coworld was not canonical");
  return {
    patchedCoworldVersion: patched.slice(`${COWORLD_NAME}:`.length),
    patchedCoworldId: exactOutputValue(text, "Coworld: ", COWORLD_ID),
    patchedCommissionerImageId: exactOutputValue(
      text,
      "Commissioner image: ",
      IMAGE_ID,
    ),
    canonical: true,
  };
}

export function certificationState(status) {
  const state = status?.certification?.state;
  if (certifiedTenOfTen(status) && status?.coworld?.canonical === true)
    return "ready";
  if (["failed", "rejected", "error", "cancelled"].includes(state))
    return "failed";
  return "pending";
}

export function validateFinalMigration({
  expectedSourceSha,
  expectedVersion,
  preflight,
  patch,
  status,
  league,
}) {
  const sha = sourceSha(expectedSourceSha);
  const version = semanticVersion(expectedVersion, "expected patched version");
  invariant(
    patch?.patchedCoworldVersion === version,
    "patched Coworld version mismatch",
  );
  invariant(
    COWORLD_ID.test(patch?.patchedCoworldId ?? ""),
    "patched Coworld id is malformed",
  );
  invariant(
    IMAGE_ID.test(patch?.patchedCommissionerImageId ?? ""),
    "patched commissioner image id is malformed",
  );
  invariant(patch?.canonical === true, "patch response was not canonical");
  invariant(
    status?.coworld?.canonical === true,
    "patched Coworld is not canonical",
  );
  invariant(
    status?.coworld?.version === version,
    "patched status version mismatch",
  );
  invariant(
    status?.coworld?.manifest?.game?.version === version,
    "patched status manifest version mismatch",
  );
  invariant(
    extractSourceSha(status?.coworld?.manifest) === sha,
    "patched Coworld provenance mismatch",
  );
  invariant(
    certifiedTenOfTen(status),
    "patched Coworld is not certified 10/10",
  );
  const hostedCommissioner = commissioner(status.coworld.manifest, IMAGE_ID);
  invariant(
    hostedCommissioner.image === patch.patchedCommissionerImageId,
    "patched status commissioner image mismatch",
  );
  invariant(league?.id === LEAGUE_ID, "unexpected final league id");
  invariant(
    league?.game?.coworld_id === patch.patchedCoworldId,
    "league did not bind the patched Coworld",
  );
  invariant(
    SAFE_LABEL.test(league?.commissioner_migration_version ?? ""),
    "final commissioner migration version is missing or malformed",
  );
  invariant(
    league.commissioner_migration_version !==
      preflight?.previousCommissionerMigrationVersion,
    "league commissioner migration version did not change",
  );
  invariant(
    DIGEST.test(status?.coworld?.manifest_hash ?? ""),
    "patched manifest hash is malformed",
  );
  invariant(
    DIGEST.test(status?.coworld?.manifest?.game?.replay_viewer?.bundle ?? ""),
    "patched replay bundle is malformed",
  );
  invariant(
    UUID.test(status?.certification?.certification_job_id ?? ""),
    "patched certification job id is malformed",
  );
  return {
    schemaVersion: 1,
    sourceSha: sha,
    sourceCoworldId: preflight.sourceCoworldId,
    sourceCoworldVersion: preflight.sourceCoworldVersion,
    sourceCommissionerImageId: preflight.sourceCommissionerImageId,
    patchedCoworldId: patch.patchedCoworldId,
    patchedCoworldVersion: version,
    commissionerRunnableId: hostedCommissioner.id,
    commissionerImageId: patch.patchedCommissionerImageId,
    commissionerMigrationVersionBefore:
      preflight.previousCommissionerMigrationVersion,
    commissionerMigrationVersionAfter: league.commissioner_migration_version,
    manifestHash: status.coworld.manifest_hash,
    replayBundle: status.coworld.manifest.game.replay_viewer.bundle,
    certificationJobId: status.certification.certification_job_id,
    certificationPassed: 10,
    canonical: true,
    leagueId: LEAGUE_ID,
    leagueBoundCoworldId: league.game.coworld_id,
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === "resolve-ci" && args.length === 2) {
    print(selectSuccessfulMainCiRun(readJson(args[1]), args[0]));
    return;
  }
  if (command === "resolve-release-run" && args.length === 2) {
    print(selectSuccessfulProductionRun(readJson(args[1]), args[0]));
    return;
  }
  if (command === "resolve-release-artifact" && args.length === 2) {
    print(selectImmutableReleaseArtifact(readJson(args[1]), args[0]));
    return;
  }
  if (command === "validate-source" && args.length === 4) {
    print(
      validateCanonicalSourceRelease({
        expectedSourceSha: args[0],
        coworlds: readJson(args[1]),
        status: readJson(args[2]),
        league: readJson(args[3]),
      }),
    );
    return;
  }
  if (command === "validate-artifact" && args.length === 5) {
    print(
      validateReleaseArtifact({
        expectedSourceSha: args[0],
        expectedVersion: args[1],
        releaseMetadata: readJson(args[2]),
        manifest: readJson(args[3]),
        imageList: readFileSync(args[4], "utf8").split("\n").filter(Boolean),
      }),
    );
    return;
  }
  if (command === "validate-image" && args.length === 2) {
    print(
      validateCommissionerImageInspection({
        image: args[0],
        inspection: readJson(args[1]),
      }),
    );
    return;
  }
  if (command === "parse-patch" && args.length === 1) {
    print(parsePatchCommissionerOutput(readFileSync(args[0], "utf8")));
    return;
  }
  if (command === "certification-state" && args.length === 1) {
    process.stdout.write(`${certificationState(readJson(args[0]))}\n`);
    return;
  }
  if (command === "validate-final" && args.length === 6) {
    print(
      validateFinalMigration({
        expectedSourceSha: args[0],
        expectedVersion: args[1],
        preflight: readJson(args[2]),
        patch: readJson(args[3]),
        status: readJson(args[4]),
        league: readJson(args[5]),
      }),
    );
    return;
  }
  throw new Error("unsupported Coworld commissioner production command");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
