#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const COWORLD_ID =
  /^cow_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_ID =
  /^img_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_COMMISSIONER_IMAGE =
  /^public\.ecr\.aws\/q5f4m8t9\/cogames@sha256:[0-9a-f]{64}$/;
const HOSTED_COMMISSIONER_IMAGE =
  /^(?:img_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|public\.ecr\.aws\/q5f4m8t9\/cogames@sha256:[0-9a-f]{64})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEAGUE_SEED_ID =
  /^lseed_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEAGUE_KEY = /^[a-z0-9][a-z0-9_-]{0,119}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE_LABEL = /^[A-Za-z0-9._:/-]{1,200}$/;
const LOCAL_COMMISSIONER_IMAGE =
  /^proxywar-commissioner-local:coworld-[0-9a-f]{12}$/;
const COMMISSIONER_WORKFLOW_PATH =
  ".github/workflows/coworld-commissioner-production.yml";
const MAX_MUTATION_RECEIPT_ARTIFACT_BYTES = 64 * 1024;
const CERTIFICATION_STATES = new Set([
  "pending",
  "queued",
  "running",
  "certified",
  "failed",
  "rejected",
  "error",
  "cancelled",
]);
const RESUMABLE_RUN_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);

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

function positiveId(value, label) {
  invariant(
    Number.isSafeInteger(value) && value > 0,
    `${label} must be a positive integer`,
  );
  return value;
}

function nonnegativeCount(value, label) {
  invariant(
    Number.isSafeInteger(value) && value >= 0,
    `${label} must be a nonnegative integer`,
  );
  return value;
}

export function buildLeagueSeedRebindPlan(seeds) {
  const matches = jsonArray(seeds, "Coworld league seeds").filter(
    (seed) =>
      seed?.coworld_name === COWORLD_NAME &&
      seed?.league_id === LEAGUE_ID &&
      seed?.enabled === true,
  );
  const seed = exactSingle(matches, "enabled ProxyWar league seed");
  invariant(
    LEAGUE_SEED_ID.test(seed?.id ?? ""),
    "ProxyWar league seed id is malformed",
  );
  invariant(
    LEAGUE_KEY.test(seed?.league_key ?? ""),
    "ProxyWar league seed key is malformed",
  );
  return {
    changes: [
      {
        seed_id: seed.id,
        coworld_name: COWORLD_NAME,
        league_key: seed.league_key,
      },
    ],
  };
}

function rebindCounts(value, label) {
  return {
    divisions: nonnegativeCount(value?.divisions, `${label} divisions`),
    memberships: nonnegativeCount(value?.memberships, `${label} memberships`),
    submissions: nonnegativeCount(value?.submissions, `${label} submissions`),
    activeRounds: nonnegativeCount(
      value?.active_rounds,
      `${label} active rounds`,
    ),
  };
}

export function validateLeagueSeedRebind({
  plan,
  response,
  expectedCoworldId,
  commit,
  dryRunProjection = null,
}) {
  invariant(
    COWORLD_ID.test(expectedCoworldId ?? ""),
    "rebind Coworld id is malformed",
  );
  const change = exactSingle(
    jsonArray(plan?.changes, "league rebind changes"),
    "league rebind change",
  );
  invariant(
    LEAGUE_SEED_ID.test(change?.seed_id ?? "") &&
      change?.coworld_name === COWORLD_NAME &&
      LEAGUE_KEY.test(change?.league_key ?? ""),
    "league rebind plan is malformed",
  );
  invariant(response?.dry_run === !commit, "league rebind mode mismatch");
  invariant(response?.applied === commit, "league rebind application mismatch");
  const result = exactSingle(
    jsonArray(response?.results, "league rebind results"),
    "league rebind result",
  );
  invariant(result?.seed_id === change.seed_id, "league rebind seed mismatch");
  invariant(result?.league_id === LEAGUE_ID, "league rebind league mismatch");
  invariant(
    result?.current?.coworld_name === COWORLD_NAME &&
      result?.current?.league_key === change.league_key &&
      result?.proposed?.coworld_name === COWORLD_NAME &&
      result?.proposed?.league_key === change.league_key,
    "league rebind binding mismatch",
  );
  invariant(
    result?.commissioner_key === "platform",
    "league rebind commissioner is not platform",
  );
  invariant(
    result?.canonical_coworld_id === expectedCoworldId,
    "league rebind canonical Coworld mismatch",
  );
  invariant(
    Array.isArray(result?.blocking_reasons) &&
      result.blocking_reasons.length === 0,
    "league rebind is blocked",
  );
  const counts = rebindCounts(result?.counts, "league rebind");
  const projection = {
    seedId: change.seed_id,
    leagueId: LEAGUE_ID,
    leagueKey: change.league_key,
    canonicalCoworldId: expectedCoworldId,
    commissionerKey: "platform",
    counts,
    applied: commit,
  };
  if (dryRunProjection !== null) {
    invariant(
      dryRunProjection?.applied === false,
      "league rebind dry-run projection is malformed",
    );
    invariant(
      isDeepStrictEqual({ ...dryRunProjection, applied: true }, projection),
      "league rebind changed between dry-run and commit",
    );
  }
  return projection;
}

function exactObjectKeys(value, expected, label) {
  invariant(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} has unexpected fields`,
  );
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

function successfulProductionRunCandidates(payload, expectedSourceSha) {
  const sha = sourceSha(expectedSourceSha);
  const matches = jsonArray(
    payload?.workflow_runs,
    "production workflow runs",
  ).filter(
    (run) =>
      run?.head_sha === sha &&
      run?.head_branch === "main" &&
      ["workflow_dispatch", "schedule"].includes(run?.event) &&
      run?.status === "completed" &&
      run?.conclusion === "success" &&
      Number.isSafeInteger(run?.id) &&
      run.id > 0,
  );
  invariant(
    matches.length > 0,
    `no successful exact-source Coworld production run exists for ${sha}`,
  );
  return [...matches].sort(
    (left, right) =>
      String(right.created_at ?? "").localeCompare(
        String(left.created_at ?? ""),
      ) || right.id - left.id,
  );
}

export function selectSuccessfulProductionRun(payload, expectedSourceSha) {
  const sha = sourceSha(expectedSourceSha);
  const selected = successfulProductionRunCandidates(payload, sha)[0];
  return { releaseRunId: selected.id, sourceSha: sha };
}

export function selectSuccessfulProductionRunCandidates(
  payload,
  expectedSourceSha,
) {
  const sha = sourceSha(expectedSourceSha);
  return {
    releaseRunIds: successfulProductionRunCandidates(payload, sha).map(
      (run) => run.id,
    ),
    sourceSha: sha,
  };
}

export function selectSuccessfulProductionRelease(
  runsPayload,
  artifactsByRunPayload,
  expectedSourceSha,
) {
  const sha = sourceSha(expectedSourceSha);
  const candidates = successfulProductionRunCandidates(runsPayload, sha);
  const artifactGroups = jsonArray(
    artifactsByRunPayload?.runs,
    "production artifact groups",
  );
  const artifactsByRun = new Map();
  for (const group of artifactGroups) {
    const runId = positiveId(group?.runId, "artifact group run id");
    invariant(
      !artifactsByRun.has(runId),
      "production artifact groups contain duplicate run ids",
    );
    artifactsByRun.set(
      runId,
      jsonArray(group?.artifacts, `artifacts for production run ${runId}`),
    );
  }

  const name = `coworld-release-${sha}`;
  for (const run of candidates) {
    invariant(
      artifactsByRun.has(run.id),
      `artifacts were not resolved for production run ${run.id}`,
    );
    const exactName = artifactsByRun
      .get(run.id)
      .filter((artifact) => artifact?.name === name);
    invariant(
      exactName.length <= 1,
      `${name} is ambiguous for production run ${run.id}`,
    );
    const artifact = exactName[0];
    if (
      artifact?.expired !== false ||
      !Number.isSafeInteger(artifact?.id) ||
      artifact.id <= 0 ||
      !Number.isSafeInteger(artifact?.size_in_bytes) ||
      artifact.size_in_bytes <= 0
    ) {
      continue;
    }
    return {
      releaseRunId: run.id,
      releaseArtifactId: artifact.id,
      releaseArtifactName: name,
      releaseArtifactBytes: artifact.size_in_bytes,
      sourceSha: sha,
    };
  }
  throw new Error(
    `no successful exact-source Coworld production run retains ${name}`,
  );
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

function compatibleCommissionerImageProjection(left, right) {
  if (left === right) return true;
  return (
    (IMAGE_ID.test(left ?? "") &&
      PUBLIC_COMMISSIONER_IMAGE.test(right ?? "")) ||
    (PUBLIC_COMMISSIONER_IMAGE.test(left ?? "") && IMAGE_ID.test(right ?? ""))
  );
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
    status?.coworld?.id === canonical.id,
    "status Coworld id does not match canonical inventory",
  );
  invariant(
    DIGEST.test(canonical?.manifest_hash ?? "") &&
      status?.coworld?.manifest_hash === canonical.manifest_hash,
    "status manifest hash does not match canonical inventory",
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
  const inventoryCommissioner = commissioner(
    canonical.manifest,
    HOSTED_COMMISSIONER_IMAGE,
  );
  const hostedCommissioner = commissioner(
    status.coworld.manifest,
    HOSTED_COMMISSIONER_IMAGE,
  );
  invariant(
    compatibleCommissionerImageProjection(
      inventoryCommissioner.image,
      hostedCommissioner.image,
    ),
    "status commissioner image does not match canonical inventory",
  );
  invariant(league?.id === LEAGUE_ID, "unexpected league id");
  invariant(
    league?.commissioner_key === "platform",
    "league commissioner key is not platform",
  );
  invariant(
    league?.rounds_paused_at === null,
    "league platform ladder is not enabled",
  );
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

function commissionerPatchComparableManifest(
  manifest,
  expectedCommissionerImage,
) {
  invariant(
    manifest !== null &&
      typeof manifest === "object" &&
      !Array.isArray(manifest),
    "manifest must be an object",
  );
  const comparable = structuredClone(manifest);
  semanticVersion(comparable?.game?.version, "manifest game version");
  comparable.game.version = "__PACKAGE_VERSION__";
  const runnable = commissioner(comparable, HOSTED_COMMISSIONER_IMAGE);
  invariant(
    runnable.image === expectedCommissionerImage,
    "manifest commissioner image does not match the expected identity",
  );
  runnable.image = "__COMMISSIONER_IMAGE__";
  return comparable;
}

export function validateCommissionerOnlyManifestPatch({
  sourceManifest,
  patchedManifest,
  sourceCommissionerImage,
  patchedCommissionerImage,
}) {
  const sourceComparable = commissionerPatchComparableManifest(
    sourceManifest,
    sourceCommissionerImage,
  );
  const patchedComparable = commissionerPatchComparableManifest(
    patchedManifest,
    patchedCommissionerImage,
  );
  invariant(
    isDeepStrictEqual(patchedComparable, sourceComparable),
    "patched manifest changed outside package version and commissioner image",
  );
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

function validateSourceProjection(value, expectedSourceSha) {
  const sha = sourceSha(expectedSourceSha);
  exactObjectKeys(
    value,
    [
      "sourceSha",
      "sourceCoworldId",
      "sourceCoworldVersion",
      "sourceCommissionerImageId",
      "commissionerRunnableId",
      "previousCommissionerMigrationVersion",
    ],
    "mutation source projection",
  );
  invariant(value.sourceSha === sha, "mutation source SHA mismatch");
  invariant(
    COWORLD_ID.test(value.sourceCoworldId ?? ""),
    "mutation source Coworld id is malformed",
  );
  semanticVersion(value.sourceCoworldVersion, "mutation source version");
  invariant(
    HOSTED_COMMISSIONER_IMAGE.test(value.sourceCommissionerImageId ?? ""),
    "mutation source commissioner image is malformed",
  );
  invariant(
    value.commissionerRunnableId === COMMISSIONER_RUNNABLE_ID,
    "mutation source commissioner runnable mismatch",
  );
  invariant(
    SAFE_LABEL.test(value.previousCommissionerMigrationVersion ?? ""),
    "mutation source migration identity is malformed",
  );
  return {
    sourceSha: sha,
    sourceCoworldId: value.sourceCoworldId,
    sourceCoworldVersion: value.sourceCoworldVersion,
    sourceCommissionerImageId: value.sourceCommissionerImageId,
    commissionerRunnableId: COMMISSIONER_RUNNABLE_ID,
    previousCommissionerMigrationVersion:
      value.previousCommissionerMigrationVersion,
  };
}

function validatePatchProjection(value, sourceVersion) {
  exactObjectKeys(
    value,
    [
      "patchedCoworldVersion",
      "patchedCoworldId",
      "patchedCommissionerImageId",
      "canonical",
    ],
    "mutation patch projection",
  );
  semanticVersion(value.patchedCoworldVersion, "mutation patched version");
  invariant(
    value.patchedCoworldVersion !== sourceVersion,
    "mutation patch did not allocate a new version",
  );
  invariant(
    COWORLD_ID.test(value.patchedCoworldId ?? ""),
    "mutation patched Coworld id is malformed",
  );
  invariant(
    IMAGE_ID.test(value.patchedCommissionerImageId ?? ""),
    "mutation patched commissioner image is malformed",
  );
  invariant(
    value.canonical === true,
    "mutation patch response was not canonical",
  );
  return {
    patchedCoworldVersion: value.patchedCoworldVersion,
    patchedCoworldId: value.patchedCoworldId,
    patchedCommissionerImageId: value.patchedCommissionerImageId,
    canonical: true,
  };
}

function validateImageProjection(value) {
  exactObjectKeys(
    value,
    ["localCommissionerImage", "localCommissionerImageId", "platform"],
    "mutation image projection",
  );
  invariant(
    LOCAL_COMMISSIONER_IMAGE.test(value.localCommissionerImage ?? ""),
    "mutation local commissioner image is malformed",
  );
  invariant(
    DIGEST.test(value.localCommissionerImageId ?? ""),
    "mutation local commissioner image id is malformed",
  );
  invariant(
    value.platform === "linux/amd64",
    "mutation commissioner image platform mismatch",
  );
  return {
    localCommissionerImage: value.localCommissionerImage,
    localCommissionerImageId: value.localCommissionerImageId,
    platform: "linux/amd64",
  };
}

function validateMutationContext(value, expectedSourceSha) {
  const sha = sourceSha(expectedSourceSha);
  exactObjectKeys(
    value,
    [
      "controlSha",
      "workflowRunId",
      "mainCiRunId",
      "releaseRunId",
      "releaseArtifactId",
      "releaseArtifactName",
      "releaseArtifactBytes",
    ],
    "mutation workflow context",
  );
  const controlSha = sourceSha(value.controlSha);
  const workflowRunId = positiveId(
    value.workflowRunId,
    "mutation workflow run id",
  );
  const mainCiRunId = positiveId(value.mainCiRunId, "mutation main CI run id");
  const releaseRunId = positiveId(
    value.releaseRunId,
    "mutation release run id",
  );
  const releaseArtifactId = positiveId(
    value.releaseArtifactId,
    "mutation release artifact id",
  );
  invariant(
    value.releaseArtifactName === `coworld-release-${sha}`,
    "mutation release artifact name mismatch",
  );
  const releaseArtifactBytes = positiveId(
    value.releaseArtifactBytes,
    "mutation release artifact bytes",
  );
  return {
    controlSha,
    workflowRunId,
    mainCiRunId,
    releaseRunId,
    releaseArtifactId,
    releaseArtifactName: value.releaseArtifactName,
    releaseArtifactBytes,
  };
}

function validateMutationTarget(value, sourceVersion) {
  exactObjectKeys(
    value,
    ["coworldName", "patchedCoworldVersion", "commissionerRunnableId"],
    "mutation target",
  );
  invariant(
    value.coworldName === COWORLD_NAME,
    "mutation Coworld name mismatch",
  );
  semanticVersion(value.patchedCoworldVersion, "allocated patched version");
  invariant(
    value.patchedCoworldVersion !== sourceVersion,
    "mutation target did not allocate a new version",
  );
  invariant(
    value.commissionerRunnableId === COMMISSIONER_RUNNABLE_ID,
    "mutation target commissioner runnable mismatch",
  );
  return {
    coworldName: COWORLD_NAME,
    patchedCoworldVersion: value.patchedCoworldVersion,
    commissionerRunnableId: COMMISSIONER_RUNNABLE_ID,
  };
}

function validateMutationIntentDocument(intent, expectedSourceSha) {
  const sha = sourceSha(expectedSourceSha);
  exactObjectKeys(
    intent,
    [
      "schemaVersion",
      "stage",
      "sourceSha",
      "controlSha",
      "workflowRunId",
      "mainCiRunId",
      "release",
      "source",
      "target",
      "image",
      "automaticRollback",
      "recoveryProcedure",
    ],
    "mutation intent",
  );
  invariant(intent.schemaVersion === 1, "mutation intent schema mismatch");
  invariant(
    intent.stage === "mutation-authorized",
    "mutation intent stage mismatch",
  );
  invariant(intent.sourceSha === sha, "mutation intent source SHA mismatch");
  invariant(
    intent.automaticRollback === false,
    "mutation intent made an automatic rollback claim",
  );
  invariant(
    typeof intent.recoveryProcedure === "string" &&
      intent.recoveryProcedure.length > 0 &&
      intent.recoveryProcedure.length <= 400,
    "mutation intent recovery procedure is malformed",
  );
  const source = validateSourceProjection(intent.source, sha);
  const target = validateMutationTarget(
    intent.target,
    source.sourceCoworldVersion,
  );
  const image = validateImageProjection(intent.image);
  exactObjectKeys(
    intent.release,
    ["runId", "artifactId", "artifactName", "artifactBytes"],
    "mutation intent release",
  );
  const releaseContext = validateMutationContext(
    {
      controlSha: intent.controlSha,
      workflowRunId: intent.workflowRunId,
      mainCiRunId: intent.mainCiRunId,
      releaseRunId: intent.release.runId,
      releaseArtifactId: intent.release.artifactId,
      releaseArtifactName: intent.release.artifactName,
      releaseArtifactBytes: intent.release.artifactBytes,
    },
    sha,
  );
  return { source, target, image, releaseContext };
}

export function buildMutationIntent({
  expectedSourceSha,
  context,
  source,
  targetVersion,
  image,
}) {
  const sha = sourceSha(expectedSourceSha);
  const boundedContext = validateMutationContext(context, sha);
  const boundedSource = validateSourceProjection(source, sha);
  const target = validateMutationTarget(
    {
      coworldName: COWORLD_NAME,
      patchedCoworldVersion: targetVersion,
      commissionerRunnableId: COMMISSIONER_RUNNABLE_ID,
    },
    boundedSource.sourceCoworldVersion,
  );
  const boundedImage = validateImageProjection(image);
  return {
    schemaVersion: 1,
    stage: "mutation-authorized",
    sourceSha: sha,
    controlSha: boundedContext.controlSha,
    workflowRunId: boundedContext.workflowRunId,
    mainCiRunId: boundedContext.mainCiRunId,
    release: {
      runId: boundedContext.releaseRunId,
      artifactId: boundedContext.releaseArtifactId,
      artifactName: boundedContext.releaseArtifactName,
      artifactBytes: boundedContext.releaseArtifactBytes,
    },
    source: boundedSource,
    target,
    image: boundedImage,
    automaticRollback: false,
    recoveryProcedure:
      "Resume with this exact failed workflow run and its unexpired pre-mutation authority artifact. Recovery discovers and validates only the allocated version; it never patches again or claims automatic rollback.",
  };
}

export function buildMutationReceipt({
  expectedSourceSha,
  context,
  source,
  patch,
  image,
}) {
  const sha = sourceSha(expectedSourceSha);
  const boundedContext = validateMutationContext(context, sha);
  const boundedSource = validateSourceProjection(source, sha);
  const boundedPatch = validatePatchProjection(
    patch,
    boundedSource.sourceCoworldVersion,
  );
  const boundedImage = validateImageProjection(image);
  return {
    schemaVersion: 1,
    stage: "mutation-returned",
    sourceSha: sha,
    controlSha: boundedContext.controlSha,
    workflowRunId: boundedContext.workflowRunId,
    mainCiRunId: boundedContext.mainCiRunId,
    release: {
      runId: boundedContext.releaseRunId,
      artifactId: boundedContext.releaseArtifactId,
      artifactName: boundedContext.releaseArtifactName,
      artifactBytes: boundedContext.releaseArtifactBytes,
    },
    source: boundedSource,
    patch: boundedPatch,
    image: boundedImage,
    automaticRollback: false,
    recoveryProcedure:
      "Use the pre-mutation authority artifact from this workflow to recover the exact allocated version. This post-mutation receipt is diagnostic only and does not authorize re-patching or automatic rollback.",
  };
}

export function validateResumeReference({
  expectedSourceSha,
  expectedWorkflowRunId,
  expectedArtifactId,
  workflowRun,
  artifact,
}) {
  const sha = sourceSha(expectedSourceSha);
  const runId = positiveId(expectedWorkflowRunId, "resume workflow run id");
  const artifactId = positiveId(
    expectedArtifactId,
    "resume mutation artifact id",
  );
  invariant(workflowRun?.id === runId, "resume workflow run identity mismatch");
  invariant(
    workflowRun?.path === COMMISSIONER_WORKFLOW_PATH,
    "resume workflow path mismatch",
  );
  invariant(
    workflowRun?.event === "workflow_dispatch" &&
      workflowRun?.head_branch === "main",
    "resume workflow was not an operator production dispatch",
  );
  sourceSha(workflowRun?.head_sha);
  invariant(
    workflowRun?.status === "completed" &&
      typeof workflowRun?.conclusion === "string" &&
      RESUMABLE_RUN_CONCLUSIONS.has(workflowRun.conclusion),
    "resume workflow must be a completed unsuccessful migration",
  );
  invariant(artifact?.id === artifactId, "resume artifact identity mismatch");
  invariant(
    artifact?.name === `coworld-commissioner-mutation-${sha}-${runId}`,
    "resume mutation artifact name mismatch",
  );
  invariant(artifact?.expired === false, "resume mutation artifact is expired");
  const artifactBytes = positiveId(
    artifact?.size_in_bytes,
    "resume mutation artifact bytes",
  );
  invariant(
    artifactBytes <= MAX_MUTATION_RECEIPT_ARTIFACT_BYTES,
    "resume mutation artifact exceeds its byte bound",
  );
  invariant(
    artifact?.workflow_run?.id === runId,
    "resume artifact is not bound to the previous workflow run",
  );
  if (artifact.workflow_run.head_sha !== undefined) {
    invariant(
      artifact.workflow_run.head_sha === workflowRun.head_sha,
      "resume artifact control SHA mismatch",
    );
  }
  return {
    sourceSha: sha,
    previousWorkflowRunId: runId,
    mutationAuthorityArtifactId: artifactId,
    previousDispatchSha: workflowRun.head_sha,
  };
}

export function validateResumeIntent({
  expectedSourceSha,
  expectedWorkflowRunId,
  expectedArtifactId,
  workflowRun,
  artifact,
  intent,
}) {
  const reference = validateResumeReference({
    expectedSourceSha,
    expectedWorkflowRunId,
    expectedArtifactId,
    workflowRun,
    artifact,
  });
  const validated = validateMutationIntentDocument(intent, reference.sourceSha);
  invariant(
    validated.releaseContext.workflowRunId === reference.previousWorkflowRunId,
    "mutation intent workflow run mismatch",
  );
  return { reference, ...validated };
}

export function validateResumeSourceStatus({
  expectedSourceSha,
  source,
  status,
}) {
  const boundedSource = validateSourceProjection(source, expectedSourceSha);
  invariant(
    status?.coworld?.id === boundedSource.sourceCoworldId,
    "resume source status Coworld id mismatch",
  );
  invariant(
    status?.coworld?.version === boundedSource.sourceCoworldVersion,
    "resume source status version mismatch",
  );
  invariant(
    status?.coworld?.manifest?.game?.version ===
      boundedSource.sourceCoworldVersion,
    "resume source manifest version mismatch",
  );
  invariant(
    extractSourceSha(status?.coworld?.manifest) === boundedSource.sourceSha,
    "resume source manifest provenance mismatch",
  );
  const sourceCommissioner = commissioner(
    status.coworld.manifest,
    HOSTED_COMMISSIONER_IMAGE,
  );
  invariant(
    sourceCommissioner.image === boundedSource.sourceCommissionerImageId,
    "resume source commissioner image mismatch",
  );
  return boundedSource;
}

export function selectAllocatedCommissionerMutationCandidate({
  expectedSourceSha,
  intent,
  coworlds,
  sourceStatus,
}) {
  const sha = sourceSha(expectedSourceSha);
  const validated = validateMutationIntentDocument(intent, sha);
  const source = validateResumeSourceStatus({
    expectedSourceSha: sha,
    source: validated.source,
    status: sourceStatus,
  });
  const candidate = exactSingle(
    jsonArray(coworlds, "Coworld inventory").filter(
      (entry) =>
        entry?.name === COWORLD_NAME &&
        entry?.version === validated.target.patchedCoworldVersion,
    ),
    "allocated commissioner mutation",
  );
  invariant(
    COWORLD_ID.test(candidate?.id ?? ""),
    "allocated mutation Coworld id is malformed",
  );
  invariant(
    candidate?.canonical === true,
    "allocated mutation Coworld is not canonical",
  );
  invariant(
    candidate?.manifest?.game?.version ===
      validated.target.patchedCoworldVersion,
    "allocated mutation manifest version mismatch",
  );
  invariant(
    extractSourceSha(candidate?.manifest) === sha,
    "allocated mutation provenance mismatch",
  );
  const hostedCommissioner = commissioner(candidate.manifest, IMAGE_ID);
  invariant(
    hostedCommissioner.image !== source.sourceCommissionerImageId,
    "allocated mutation did not change the commissioner image",
  );
  validateCommissionerOnlyManifestPatch({
    sourceManifest: sourceStatus?.coworld?.manifest,
    patchedManifest: candidate.manifest,
    sourceCommissionerImage: source.sourceCommissionerImageId,
    patchedCommissionerImage: hostedCommissioner.image,
  });
  return {
    patchedCoworldVersion: validated.target.patchedCoworldVersion,
    patchedCoworldId: candidate.id,
    patchedCommissionerImageId: hostedCommissioner.image,
    canonical: true,
  };
}

export function validateAuthorizedHostedCommissionerImage({
  expectedSourceSha,
  intent,
  patch,
  hostedImage,
}) {
  const sha = sourceSha(expectedSourceSha);
  const validated = validateMutationIntentDocument(intent, sha);
  const boundedPatch = validatePatchProjection(
    patch,
    validated.source.sourceCoworldVersion,
  );
  exactObjectKeys(
    hostedImage,
    [
      "id",
      "name",
      "version",
      "client_hash",
      "status",
      "image_uri",
      "image_digest",
      "public_image_uri",
    ],
    "hosted commissioner image",
  );
  invariant(
    hostedImage.id === boundedPatch.patchedCommissionerImageId,
    "hosted commissioner image id mismatch",
  );
  invariant(
    hostedImage.name === "proxywar-commissioner-local",
    "hosted commissioner image name mismatch",
  );
  positiveId(hostedImage.version, "hosted commissioner image version");
  invariant(
    hostedImage.client_hash === validated.image.localCommissionerImageId,
    "hosted commissioner image does not match the authorized local config digest",
  );
  invariant(
    SAFE_LABEL.test(hostedImage.status ?? ""),
    "hosted commissioner image status is malformed",
  );
  invariant(
    DIGEST.test(hostedImage.image_digest ?? ""),
    "hosted commissioner registry digest is malformed",
  );
  invariant(
    PUBLIC_COMMISSIONER_IMAGE.test(hostedImage.public_image_uri ?? ""),
    "hosted commissioner public image URI is malformed",
  );
  invariant(
    hostedImage.public_image_uri.endsWith(`@${hostedImage.image_digest}`),
    "hosted commissioner public image URI digest mismatch",
  );
  return {
    hostedCommissionerImageId: boundedPatch.patchedCommissionerImageId,
    authorizedLocalConfigDigest: validated.image.localCommissionerImageId,
    hostedImageDigest: hostedImage.image_digest,
    hostedCommissionerManifestImage: hostedImage.public_image_uri,
  };
}

export function discoverAllocatedCommissionerMutation({
  expectedSourceSha,
  intent,
  coworlds,
  sourceStatus,
  hostedImage,
}) {
  const patch = selectAllocatedCommissionerMutationCandidate({
    expectedSourceSha,
    intent,
    coworlds,
    sourceStatus,
  });
  validateAuthorizedHostedCommissionerImage({
    expectedSourceSha,
    intent,
    patch,
    hostedImage,
  });
  return patch;
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
  hostedImageBinding,
  sourceStatus,
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
    status?.coworld?.id === patch.patchedCoworldId,
    "patched status Coworld id mismatch",
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
  exactObjectKeys(
    hostedImageBinding,
    [
      "hostedCommissionerImageId",
      "authorizedLocalConfigDigest",
      "hostedImageDigest",
      "hostedCommissionerManifestImage",
    ],
    "hosted commissioner image binding",
  );
  invariant(
    hostedImageBinding.hostedCommissionerImageId ===
      patch.patchedCommissionerImageId,
    "hosted commissioner image binding id mismatch",
  );
  invariant(
    DIGEST.test(hostedImageBinding.authorizedLocalConfigDigest ?? ""),
    "authorized local commissioner digest is malformed",
  );
  invariant(
    DIGEST.test(hostedImageBinding.hostedImageDigest ?? ""),
    "hosted commissioner image digest is malformed",
  );
  invariant(
    PUBLIC_COMMISSIONER_IMAGE.test(
      hostedImageBinding.hostedCommissionerManifestImage ?? "",
    ) &&
      hostedImageBinding.hostedCommissionerManifestImage.endsWith(
        `@${hostedImageBinding.hostedImageDigest}`,
      ),
    "hosted commissioner manifest image binding is malformed",
  );
  const hostedCommissioner = commissioner(
    status.coworld.manifest,
    HOSTED_COMMISSIONER_IMAGE,
  );
  const expectedStatusCommissionerImage = IMAGE_ID.test(
    hostedCommissioner.image,
  )
    ? patch.patchedCommissionerImageId
    : hostedImageBinding.hostedCommissionerManifestImage;
  invariant(
    hostedCommissioner.image === expectedStatusCommissionerImage,
    "patched status commissioner image mismatch",
  );
  invariant(
    sourceStatus?.coworld?.id === preflight?.sourceCoworldId,
    "source status Coworld id mismatch",
  );
  invariant(
    sourceStatus?.coworld?.version === preflight?.sourceCoworldVersion,
    "source status Coworld version mismatch",
  );
  const sourceCommissioner = commissioner(
    sourceStatus?.coworld?.manifest,
    HOSTED_COMMISSIONER_IMAGE,
  );
  invariant(
    sourceCommissioner.image === preflight?.sourceCommissionerImageId,
    "source status commissioner image mismatch",
  );
  validateCommissionerOnlyManifestPatch({
    sourceManifest: sourceStatus?.coworld?.manifest,
    patchedManifest: status?.coworld?.manifest,
    sourceCommissionerImage: preflight?.sourceCommissionerImageId,
    patchedCommissionerImage: hostedCommissioner.image,
  });
  invariant(league?.id === LEAGUE_ID, "unexpected final league id");
  invariant(
    league?.commissioner_key === "platform",
    "final league commissioner key is not platform",
  );
  invariant(
    league?.rounds_paused_at === null,
    "final league platform ladder is not enabled",
  );
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

function safePattern(value, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function safeVersion(value) {
  return safePattern(value, SEMVER);
}

function safePositiveId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function safeSourceProjection(value, expectedSourceSha) {
  try {
    return validateSourceProjection(value, expectedSourceSha);
  } catch {
    return null;
  }
}

function safePatchProjection(value, sourceVersion) {
  if (sourceVersion === null) return null;
  try {
    return validatePatchProjection(value, sourceVersion);
  } catch {
    return null;
  }
}

function reconciliationStatusProjection(status) {
  let commissionerRunnableId = null;
  let commissionerImageId = null;
  try {
    const hosted = commissioner(
      status?.coworld?.manifest,
      HOSTED_COMMISSIONER_IMAGE,
    );
    commissionerRunnableId = hosted.id;
    commissionerImageId = hosted.image;
  } catch {
    // Reconciliation must retain a bounded diagnostic even for partial state.
  }
  const summary = status?.certification?.transcript_summary;
  const certificationPassed =
    Array.isArray(summary) && summary.length <= 100
      ? summary.filter((entry) => entry?.status === "pass").length
      : null;
  const state = status?.certification?.state;
  let observedSourceSha = null;
  try {
    observedSourceSha = extractSourceSha(status?.coworld?.manifest);
  } catch {
    // Malformed authenticated payloads are represented only as null fields.
  }
  return {
    coworldId: safePattern(status?.coworld?.id, COWORLD_ID),
    coworldVersion: safeVersion(status?.coworld?.version),
    canonical:
      typeof status?.coworld?.canonical === "boolean"
        ? status.coworld.canonical
        : null,
    sourceSha: observedSourceSha,
    manifestHash: safePattern(status?.coworld?.manifest_hash, DIGEST),
    replayBundle: safePattern(
      status?.coworld?.manifest?.game?.replay_viewer?.bundle,
      DIGEST,
    ),
    commissionerRunnableId,
    commissionerImageId,
    certificationState:
      typeof state === "string" && CERTIFICATION_STATES.has(state)
        ? state
        : null,
    certificationJobId: safePattern(
      status?.certification?.certification_job_id,
      UUID,
    ),
    certificationPassed,
  };
}

function reconciliationLeagueProjection(league) {
  return {
    leagueId: league?.id === LEAGUE_ID ? LEAGUE_ID : null,
    commissionerKey:
      league?.commissioner_key === "platform" ? "platform" : null,
    platformLadderEnabled: Object.hasOwn(league ?? {}, "rounds_paused_at")
      ? league.rounds_paused_at === null
      : null,
    boundCoworldId: safePattern(league?.game?.coworld_id, COWORLD_ID),
    commissionerMigrationVersion: safePattern(
      league?.commissioner_migration_version,
      SAFE_LABEL,
    ),
  };
}

function reconciliationExit(value, label) {
  invariant(
    value === "not-attempted" || /^(?:0|[1-9][0-9]{0,2})$/.test(value ?? ""),
    `${label} reconciliation exit is malformed`,
  );
  return value;
}

export function buildReconciliationState({
  expectedSourceSha,
  controlSha,
  workflowRunId,
  source,
  patch,
  observedStatus,
  observedLeague,
  statusExit,
  leagueExit,
  resumeWorkflowRunId = null,
  resumeArtifactId = null,
}) {
  const sha = sourceSha(expectedSourceSha);
  const boundedControlSha = sourceSha(controlSha);
  const boundedWorkflowRunId = positiveId(
    workflowRunId,
    "reconciliation workflow run id",
  );
  const sourceProjection = safeSourceProjection(source, sha);
  const patchProjection = safePatchProjection(
    patch,
    sourceProjection?.sourceCoworldVersion ?? null,
  );
  const hasResumeReference =
    resumeWorkflowRunId !== null || resumeArtifactId !== null;
  invariant(
    !hasResumeReference ||
      (safePositiveId(resumeWorkflowRunId) !== null &&
        safePositiveId(resumeArtifactId) !== null),
    "reconciliation resume reference is incomplete",
  );
  return {
    schemaVersion: 1,
    sourceSha: sha,
    controlSha: boundedControlSha,
    workflowRunId: boundedWorkflowRunId,
    source: sourceProjection,
    patch: patchProjection,
    observedStatus: reconciliationStatusProjection(observedStatus),
    observedLeague: reconciliationLeagueProjection(observedLeague),
    observationExit: {
      status: reconciliationExit(statusExit, "status"),
      league: reconciliationExit(leagueExit, "league"),
    },
    resumeReference: hasResumeReference
      ? {
          previousWorkflowRunId: resumeWorkflowRunId,
          mutationAuthorityArtifactId: resumeArtifactId,
        }
      : null,
    automaticRollback: false,
    recoveryProcedure:
      "Resume only with the exact previous workflow run and its unexpired pre-mutation authority artifact. Recovery discovers only the allocated version and never patches or rolls back automatically.",
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
  if (command === "resolve-release-candidates" && args.length === 2) {
    print(selectSuccessfulProductionRunCandidates(readJson(args[1]), args[0]));
    return;
  }
  if (command === "resolve-release" && args.length === 3) {
    print(
      selectSuccessfulProductionRelease(
        readJson(args[1]),
        readJson(args[2]),
        args[0],
      ),
    );
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
  if (command === "create-mutation-receipt" && args.length === 5) {
    print(
      buildMutationReceipt({
        expectedSourceSha: args[0],
        context: readJson(args[1]),
        source: readJson(args[2]),
        patch: readJson(args[3]),
        image: readJson(args[4]),
      }),
    );
    return;
  }
  if (command === "create-mutation-intent" && args.length === 5) {
    print(
      buildMutationIntent({
        expectedSourceSha: args[0],
        context: readJson(args[1]),
        source: readJson(args[2]),
        targetVersion: args[3],
        image: readJson(args[4]),
      }),
    );
    return;
  }
  if (command === "validate-resume-reference" && args.length === 5) {
    print(
      validateResumeReference({
        expectedSourceSha: args[0],
        expectedWorkflowRunId: Number(args[1]),
        expectedArtifactId: Number(args[2]),
        workflowRun: readJson(args[3]),
        artifact: readJson(args[4]),
      }),
    );
    return;
  }
  if (command === "validate-resume-intent" && args.length === 6) {
    print(
      validateResumeIntent({
        expectedSourceSha: args[0],
        expectedWorkflowRunId: Number(args[1]),
        expectedArtifactId: Number(args[2]),
        workflowRun: readJson(args[3]),
        artifact: readJson(args[4]),
        intent: readJson(args[5]),
      }),
    );
    return;
  }
  if (command === "validate-resume-source" && args.length === 3) {
    print(
      validateResumeSourceStatus({
        expectedSourceSha: args[0],
        source: readJson(args[1]),
        status: readJson(args[2]),
      }),
    );
    return;
  }
  if (command === "select-resume-candidate" && args.length === 4) {
    print(
      selectAllocatedCommissionerMutationCandidate({
        expectedSourceSha: args[0],
        intent: readJson(args[1]),
        coworlds: readJson(args[2]),
        sourceStatus: readJson(args[3]),
      }),
    );
    return;
  }
  if (command === "discover-resume-patch" && args.length === 5) {
    print(
      discoverAllocatedCommissionerMutation({
        expectedSourceSha: args[0],
        intent: readJson(args[1]),
        coworlds: readJson(args[2]),
        sourceStatus: readJson(args[3]),
        hostedImage: readJson(args[4]),
      }),
    );
    return;
  }
  if (command === "validate-commissioner-image-binding" && args.length === 4) {
    print(
      validateAuthorizedHostedCommissionerImage({
        expectedSourceSha: args[0],
        intent: readJson(args[1]),
        patch: readJson(args[2]),
        hostedImage: readJson(args[3]),
      }),
    );
    return;
  }
  if (command === "certification-state" && args.length === 1) {
    process.stdout.write(`${certificationState(readJson(args[0]))}\n`);
    return;
  }
  if (command === "build-league-rebind-plan" && args.length === 1) {
    print(buildLeagueSeedRebindPlan(readJson(args[0])));
    return;
  }
  if (
    command === "validate-league-rebind" &&
    args.length === 4 &&
    args[3] === "dry-run"
  ) {
    print(
      validateLeagueSeedRebind({
        plan: readJson(args[0]),
        response: readJson(args[1]),
        expectedCoworldId: args[2],
        commit: args[3] === "commit",
      }),
    );
    return;
  }
  if (command === "validate-league-rebind-commit" && args.length === 4) {
    print(
      validateLeagueSeedRebind({
        plan: readJson(args[0]),
        response: readJson(args[1]),
        expectedCoworldId: args[2],
        commit: true,
        dryRunProjection: readJson(args[3]),
      }),
    );
    return;
  }
  if (command === "validate-final" && args.length === 8) {
    print(
      validateFinalMigration({
        expectedSourceSha: args[0],
        expectedVersion: args[1],
        preflight: readJson(args[2]),
        patch: readJson(args[3]),
        hostedImageBinding: readJson(args[4]),
        sourceStatus: readJson(args[5]),
        status: readJson(args[6]),
        league: readJson(args[7]),
      }),
    );
    return;
  }
  if (command === "build-reconciliation" && args.length === 11) {
    print(
      buildReconciliationState({
        expectedSourceSha: args[0],
        controlSha: args[1],
        workflowRunId: Number(args[2]),
        source: readJson(args[3]),
        patch: readJson(args[4]),
        observedStatus: readJson(args[5]),
        observedLeague: readJson(args[6]),
        statusExit: args[7],
        leagueExit: args[8],
        resumeWorkflowRunId: args[9] === "" ? null : Number(args[9]),
        resumeArtifactId: args[10] === "" ? null : Number(args[10]),
      }),
    );
    return;
  }
  throw new Error("unsupported Coworld commissioner production command");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
