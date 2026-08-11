import { createHash } from "node:crypto";

import { assertReleaseRecordSafe, policy } from "./trusted-pr-policy.mjs";

const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const PROVENANCE_PAGE_ID = "proxywar-release-provenance";

export function provenanceText(sourceSha, metadata = {}) {
  if (!SHA.test(sourceSha))
    throw new Error("source SHA must be 40 lowercase hex characters");
  const entries = [`source_sha=${sourceSha}`];
  for (const [key, value] of Object.entries(metadata)) {
    if (value === null || value === undefined || value === "") continue;
    if (!/^[a-z][a-z0-9_]*$/.test(key))
      throw new Error(`invalid provenance key: ${key}`);
    if (!/^[A-Za-z0-9_.:/-]+$/.test(String(value)))
      throw new Error(`invalid provenance value for ${key}`);
    entries.push(`${key}=${value}`);
  }
  return entries.join("\n");
}

export function stampManifest(manifest, sourceSha, metadata = {}) {
  const clone = structuredClone(manifest);
  const pages = clone.game?.docs?.pages;
  if (!Array.isArray(pages))
    throw new Error("manifest game.docs.pages must be an array");
  const page = pages.find((entry) => entry.id === PROVENANCE_PAGE_ID);
  if (!page || page.content?.type !== "text") {
    throw new Error(`manifest is missing ${PROVENANCE_PAGE_ID} text page`);
  }
  page.content.value = provenanceText(sourceSha, metadata);
  return clone;
}

export function extractSourceSha(manifest) {
  const page = manifest?.game?.docs?.pages?.find(
    (entry) =>
      entry.id === PROVENANCE_PAGE_ID && entry.content?.type === "text",
  );
  const match = page?.content?.value?.match(
    /(?:^|\n)source_sha=([0-9a-f]{40})(?:\n|$)/,
  );
  return match?.[1] ?? null;
}

export function assertTemplateRebuildsReplayViewer(template) {
  const bundle = template?.game?.replay_viewer?.bundle;
  if (bundle !== "build/static-replay-viewer") {
    throw new Error(
      `template replay bundle must be build/static-replay-viewer, got ${bundle}`,
    );
  }
  if (String(bundle).startsWith("sha256:"))
    throw new Error("template contains a stale hosted replay bundle");
  return true;
}

export function findSourceRelease(coworlds, sourceSha) {
  const matches = (coworlds ?? []).filter(
    (entry) =>
      entry.name === policy.coworld.name &&
      extractSourceSha(entry.manifest) === sourceSha,
  );
  return (
    matches.sort((left, right) =>
      right.version.localeCompare(left.version, undefined, { numeric: true }),
    )[0] ?? null
  );
}

export function versionAllocationDecision(beforeBuild, beforeUpload) {
  if (!VERSION.test(beforeBuild) || !VERSION.test(beforeUpload)) {
    throw new Error("Coworld versions must be semantic x.y.z values");
  }
  return {
    version: beforeUpload,
    collision: beforeBuild !== beforeUpload,
    rebuildManifestAndRecertify: beforeBuild !== beforeUpload,
  };
}

export function certificationGate({
  candidateId,
  certified,
  uploadWasCanonical,
  previousCanonicalId,
  rollbackSupported,
}) {
  if (certified)
    return { action: "verify-canonical-and-league", healthy: false };
  if (!uploadWasCanonical)
    return {
      action: "leave-previous-canonical",
      healthy: false,
      previousCanonicalId,
    };
  if (rollbackSupported)
    return {
      action: "rollback",
      healthy: false,
      targetId: previousCanonicalId,
    };
  return {
    action: "manual-recovery-required",
    healthy: false,
    candidateId,
    previousCanonicalId,
    reason:
      "Coworld upload auto-promoted before certification and exposes no rollback endpoint",
  };
}

export function postPromotionDecision({
  leagueBound,
  replayVerified,
  rollbackSupported,
  previousCanonicalId,
}) {
  if (leagueBound && replayVerified)
    return { action: "complete", healthy: true };
  if (rollbackSupported)
    return {
      action: "rollback",
      healthy: false,
      targetId: previousCanonicalId,
    };
  return {
    action: "manual-recovery-required",
    healthy: false,
    previousCanonicalId,
    reason: !leagueBound ? "league-binding-failed" : "published-replay-failed",
  };
}

export function createReleaseRecord(input) {
  const record = {
    schemaVersion: 1,
    ...input,
  };
  return assertReleaseRecordSafe(record);
}

export function contentHash(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
