import { createHash } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SAFE = /^[A-Za-z0-9._/-]+$/;
const ROLES = ["A", "B", "C", "opponent-1", "opponent-2", "opponent-3"];
const STAGES = new Set([
  "fence-intent",
  "ghcr",
  "policies-partial",
  "policies",
  "terminal-proof",
  "eval-partial",
  "eval-upload",
]);

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort());
const requireInteger = (value) => Number.isSafeInteger(value) && value > 0;
const requireHashes = (value) =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === "string" && SHA.test(entry)) &&
  new Set(value).size === value.length;

function readJson(file) {
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes.toString("utf8"));
  return { bytes, value };
}

function validateState(state, bytes, expected) {
  if (
    !exact(state, [
      "schemaVersion",
      "authority",
      "repository",
      "workflowPath",
      "sourceSha",
      "sourceTreeSha",
      "evalVersion",
      "namePrefix",
      "fenceRef",
      "stage",
      "createdAt",
      "priorStateSha256",
      "priorStateSha256s",
      "files",
      "stateSha256",
    ]) ||
    state.schemaVersion !== 3 ||
    state.authority !== "github-actions-provision-recovery-v3" ||
    state.repository !== "0xNad/ProxyWar" ||
    state.workflowPath !== ".github/workflows/commander-xp-provision.yml" ||
    state.sourceSha !== expected.sourceSha ||
    state.sourceTreeSha !== expected.sourceTreeSha ||
    state.evalVersion !== expected.evalVersion ||
    state.namePrefix !== expected.namePrefix ||
    state.fenceRef !== expected.fenceRef ||
    state.stage !== "eval-upload" ||
    !Number.isFinite(Date.parse(state.createdAt)) ||
    !requireHashes(state.priorStateSha256s) ||
    state.priorStateSha256 !== (state.priorStateSha256s.at(-1) ?? null) ||
    !Array.isArray(state.files) ||
    !SHA.test(state.stateSha256)
  ) {
    throw new Error("Commander XP final provision recovery state is invalid");
  }
  const { stateSha256, ...body } = state;
  if (stateSha256 !== sha(JSON.stringify(canonical(body)))) {
    throw new Error(
      "Commander XP final provision recovery state hash mismatch",
    );
  }
  return { stateSha256, stateFileSha256: sha(bytes) };
}

function validateLineage(lineage, state, stateBytes, expected) {
  if (
    !exact(lineage, [
      "schemaVersion",
      "authority",
      "repository",
      "workflowPath",
      "sourceSha",
      "sourceTreeSha",
      "evalVersion",
      "namePrefix",
      "fenceRef",
      "mode",
      "inputBoundary",
      "finalBoundary",
      "remoteAdoption",
      "lineageSha256",
    ]) ||
    lineage.schemaVersion !== 1 ||
    lineage.authority !== "github-actions-provision-recovery-lineage-v1" ||
    lineage.repository !== "0xNad/ProxyWar" ||
    lineage.workflowPath !== ".github/workflows/commander-xp-provision.yml" ||
    lineage.sourceSha !== expected.sourceSha ||
    lineage.sourceTreeSha !== expected.sourceTreeSha ||
    lineage.evalVersion !== expected.evalVersion ||
    lineage.namePrefix !== expected.namePrefix ||
    lineage.fenceRef !== expected.fenceRef ||
    !["fresh", "recovered"].includes(lineage.mode) ||
    !SHA.test(lineage.lineageSha256)
  ) {
    throw new Error("Commander XP provision recovery lineage is invalid");
  }
  const { lineageSha256, ...body } = lineage;
  if (lineageSha256 !== sha(JSON.stringify(canonical(body)))) {
    throw new Error("Commander XP provision recovery lineage hash mismatch");
  }
  const stateIdentity = validateState(state, stateBytes, expected);
  if (
    !exact(lineage.finalBoundary, [
      "stage",
      "stateSha256",
      "stateFileSha256",
      "priorStateSha256s",
    ]) ||
    lineage.finalBoundary.stage !== "eval-upload" ||
    lineage.finalBoundary.stateSha256 !== stateIdentity.stateSha256 ||
    lineage.finalBoundary.stateFileSha256 !== stateIdentity.stateFileSha256 ||
    JSON.stringify(lineage.finalBoundary.priorStateSha256s) !==
      JSON.stringify(state.priorStateSha256s)
  ) {
    throw new Error("Commander XP final provision recovery lineage mismatch");
  }
  if (
    !exact(lineage.remoteAdoption, [
      "policyImage",
      "gameImage",
      "policyRoles",
      "evalCoworld",
    ]) ||
    typeof lineage.remoteAdoption.policyImage !== "boolean" ||
    typeof lineage.remoteAdoption.gameImage !== "boolean" ||
    typeof lineage.remoteAdoption.evalCoworld !== "boolean" ||
    !Array.isArray(lineage.remoteAdoption.policyRoles) ||
    JSON.stringify(lineage.remoteAdoption.policyRoles) !==
      JSON.stringify(
        [...new Set(lineage.remoteAdoption.policyRoles)].sort(
          (left, right) => ROLES.indexOf(left) - ROLES.indexOf(right),
        ),
      ) ||
    lineage.remoteAdoption.policyRoles.some((role) => !ROLES.includes(role))
  ) {
    throw new Error("Commander XP remote adoption lineage is invalid");
  }
  if (lineage.mode === "fresh") {
    if (
      lineage.inputBoundary !== null ||
      lineage.remoteAdoption.policyImage ||
      lineage.remoteAdoption.gameImage ||
      lineage.remoteAdoption.evalCoworld ||
      lineage.remoteAdoption.policyRoles.length !== 0
    ) {
      throw new Error(
        "Commander XP fresh provision cannot claim recovery adoption",
      );
    }
  } else {
    const input = lineage.inputBoundary;
    if (
      !exact(input, [
        "artifactID",
        "name",
        "digest",
        "workflowRunID",
        "workflowRunAttempt",
        "stage",
        "stateSha256",
        "priorStateSha256s",
      ]) ||
      !requireInteger(input.artifactID) ||
      !SAFE.test(input.name) ||
      !DIGEST.test(input.digest) ||
      !requireInteger(input.workflowRunID) ||
      !requireInteger(input.workflowRunAttempt) ||
      !STAGES.has(input.stage) ||
      !SHA.test(input.stateSha256) ||
      !requireHashes(input.priorStateSha256s)
    ) {
      throw new Error(
        "Commander XP provision input recovery boundary is invalid",
      );
    }
    const prefix = [...input.priorStateSha256s, input.stateSha256];
    if (
      JSON.stringify(state.priorStateSha256s.slice(0, prefix.length)) !==
      JSON.stringify(prefix)
    ) {
      throw new Error(
        "Commander XP provision recovery state lineage is discontinuous",
      );
    }
  }
  return lineage;
}

export function sealLineage(draft, state, stateBytes, expected) {
  const stateIdentity = validateState(state, stateBytes, expected);
  const body = {
    ...draft,
    finalBoundary: {
      stage: "eval-upload",
      stateSha256: stateIdentity.stateSha256,
      stateFileSha256: stateIdentity.stateFileSha256,
      priorStateSha256s: state.priorStateSha256s,
    },
  };
  const lineage = {
    ...body,
    lineageSha256: sha(JSON.stringify(canonical(body))),
  };
  return validateLineage(lineage, state, stateBytes, expected);
}

export { validateLineage };

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [mode, lineageOrDraft, statePath, outputOrSource, ...rest] =
    process.argv.slice(2);
  if (mode === "seal") {
    const output = outputOrSource;
    const [sourceSha, sourceTreeSha, evalVersion, namePrefix, fenceRef] = rest;
    const draft = readJson(lineageOrDraft).value;
    const state = readJson(statePath);
    const lineage = sealLineage(draft, state.value, state.bytes, {
      sourceSha,
      sourceTreeSha,
      evalVersion,
      namePrefix,
      fenceRef,
    });
    fs.writeFileSync(output, `${JSON.stringify(lineage, null, 2)}\n`, {
      flag: "wx",
    });
  } else if (mode === "validate") {
    const sourceSha = outputOrSource;
    const [sourceTreeSha, evalVersion, namePrefix, fenceRef] = rest;
    const lineage = readJson(lineageOrDraft).value;
    const state = readJson(statePath);
    validateLineage(lineage, state.value, state.bytes, {
      sourceSha,
      sourceTreeSha,
      evalVersion,
      namePrefix,
      fenceRef,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, lineage })}\n`);
  } else {
    throw new Error(
      "usage: seal|validate lineage state [output] source tree version prefix fence",
    );
  }
}
