#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STATE_FILE = "commander-xp-provision-recovery-v2.json";
const stages = new Set([
  "fence-intent",
  "ghcr",
  "policies-partial",
  "policies",
  "terminal-proof",
  "eval-partial",
  "eval-upload",
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
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
const canonicalHash = (value) => sha256(JSON.stringify(canonical(value)));

function exactRelativeFile(relative) {
  return (
    relative === "fence-intent.json" ||
    relative === "ghcr.json" ||
    relative === "attestations/policy.jsonl" ||
    relative === "attestations/game.jsonl" ||
    /^policy-receipts\/(?:image|A|B|C|opponent-[123]|policy-identities-v2)\.json$/.test(
      relative,
    ) ||
    relative === "eval/eval-coworld-manifest-v2.json" ||
    relative === "eval/eval-coworld-terminal-proof-v2.json" ||
    relative === "eval/eval-coworld-inspect.json"
  );
}

function inventory(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (relative === STATE_FILE) continue;
      const metadata = fs.lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Commander XP provision recovery link: ${relative}`);
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && exactRelativeFile(relative)) {
        result.push({
          path: relative,
          bytes: metadata.size,
          sha256: sha256(fs.readFileSync(absolute)),
        });
      } else {
        throw new Error(`Commander XP provision recovery path: ${relative}`);
      }
    }
  };
  visit(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function assertStage(stage, paths) {
  const fence = ["fence-intent.json"];
  const ghcr = [
    "ghcr.json",
    "attestations/policy.jsonl",
    "attestations/game.jsonl",
  ];
  const policyImage = ["policy-receipts/image.json"];
  const rolePaths = [
    "policy-receipts/A.json",
    "policy-receipts/B.json",
    "policy-receipts/C.json",
    "policy-receipts/opponent-1.json",
    "policy-receipts/opponent-2.json",
    "policy-receipts/opponent-3.json",
  ];
  const policySummary = ["policy-receipts/policy-identities-v2.json"];
  const terminal = [
    "eval/eval-coworld-manifest-v2.json",
    "eval/eval-coworld-terminal-proof-v2.json",
  ];
  const inspect = ["eval/eval-coworld-inspect.json"];
  const requireExact = (expected) => {
    if (
      JSON.stringify([...paths].sort()) !== JSON.stringify([...expected].sort())
    ) {
      throw new Error(
        `Commander XP provision recovery ${stage} inventory invalid`,
      );
    }
  };
  if (stage === "fence-intent") return requireExact(fence);
  if (stage === "ghcr") return requireExact([...fence, ...ghcr]);
  if (stage === "policies-partial") {
    const allowed = new Set([...fence, ...ghcr, ...policyImage, ...rolePaths]);
    const completedRoles = rolePaths.filter((relative) => paths.has(relative));
    if (
      !paths.has("policy-receipts/image.json") ||
      [...paths].some((relative) => !allowed.has(relative)) ||
      JSON.stringify(completedRoles) !==
        JSON.stringify(rolePaths.slice(0, completedRoles.length))
    ) {
      throw new Error("Commander XP partial policy recovery inventory invalid");
    }
    return;
  }
  const policies = [
    ...fence,
    ...ghcr,
    ...policyImage,
    ...rolePaths,
    ...policySummary,
  ];
  if (stage === "policies") return requireExact(policies);
  if (stage === "terminal-proof")
    return requireExact([...policies, ...terminal]);
  return requireExact([...policies, ...terminal, ...inspect]);
}

function exactIdentity(
  sourceSha,
  sourceTreeSha,
  evalVersion,
  namePrefix,
  fenceRef,
) {
  if (
    !/^[0-9a-f]{40}$/.test(sourceSha) ||
    !/^[0-9a-f]{40}$/.test(sourceTreeSha) ||
    !/^0\.[0-9]+\.[0-9]+(?:[+-][A-Za-z0-9.-]+)?$/.test(evalVersion) ||
    !/^[a-z0-9][a-z0-9-]{7,119}$/.test(namePrefix) ||
    !/^refs\/tags\/commander-xp-provision-v2\/[0-9a-f]{64}$/.test(fenceRef)
  ) {
    throw new Error("Commander XP provision recovery identity is invalid");
  }
}

function validate(root, identity) {
  const statePath = path.join(root, STATE_FILE);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const { stateSha256, ...body } = state;
  if (
    JSON.stringify(Object.keys(state).sort()) !==
      JSON.stringify(
        [
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
          "files",
          "stateSha256",
        ].sort(),
      ) ||
    state.schemaVersion !== 2 ||
    state.authority !== "github-actions-provision-recovery-v2" ||
    state.repository !== "0xNad/ProxyWar" ||
    state.workflowPath !== ".github/workflows/commander-xp-provision.yml" ||
    state.sourceSha !== identity.sourceSha ||
    state.sourceTreeSha !== identity.sourceTreeSha ||
    state.evalVersion !== identity.evalVersion ||
    state.namePrefix !== identity.namePrefix ||
    state.fenceRef !== identity.fenceRef ||
    !stages.has(state.stage) ||
    stateSha256 !== canonicalHash(body)
  ) {
    throw new Error("Commander XP provision recovery state is invalid");
  }
  const actualFiles = inventory(root);
  if (JSON.stringify(state.files) !== JSON.stringify(actualFiles)) {
    throw new Error("Commander XP provision recovery inventory mismatch");
  }
  assertStage(state.stage, new Set(actualFiles.map((file) => file.path)));
  return state;
}

const [command, rootInput, stageOrSource, ...tail] = process.argv.slice(2);
const root = path.resolve(rootInput ?? "");
if (!rootInput || !fs.statSync(root).isDirectory()) {
  throw new Error("Commander XP provision recovery root is invalid");
}

if (command === "build") {
  const stage = stageOrSource;
  const [sourceSha, sourceTreeSha, evalVersion, namePrefix, fenceRef] = tail;
  if (!stages.has(stage))
    throw new Error("Commander XP provision stage is invalid");
  exactIdentity(sourceSha, sourceTreeSha, evalVersion, namePrefix, fenceRef);
  const priorPath = path.join(root, STATE_FILE);
  let priorStateSha256 = null;
  if (fs.existsSync(priorPath)) {
    const prior = JSON.parse(fs.readFileSync(priorPath, "utf8"));
    priorStateSha256 = prior.stateSha256;
    if (!/^[0-9a-f]{64}$/.test(priorStateSha256 ?? "")) {
      throw new Error("Commander XP prior recovery state is invalid");
    }
    fs.rmSync(priorPath);
  }
  const files = inventory(root);
  assertStage(stage, new Set(files.map((file) => file.path)));
  const body = {
    schemaVersion: 2,
    authority: "github-actions-provision-recovery-v2",
    repository: "0xNad/ProxyWar",
    workflowPath: ".github/workflows/commander-xp-provision.yml",
    sourceSha,
    sourceTreeSha,
    evalVersion,
    namePrefix,
    fenceRef,
    stage,
    createdAt: new Date().toISOString(),
    priorStateSha256,
    files,
  };
  const state = { ...body, stateSha256: canonicalHash(body) };
  fs.writeFileSync(priorPath, `${JSON.stringify(state, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(JSON.stringify({ stage, stateSha256: state.stateSha256 }));
} else if (command === "validate") {
  const sourceSha = stageOrSource;
  const [sourceTreeSha, evalVersion, namePrefix, fenceRef] = tail;
  exactIdentity(sourceSha, sourceTreeSha, evalVersion, namePrefix, fenceRef);
  const state = validate(root, {
    sourceSha,
    sourceTreeSha,
    evalVersion,
    namePrefix,
    fenceRef,
  });
  console.log(
    JSON.stringify({ stage: state.stage, stateSha256: state.stateSha256 }),
  );
} else {
  throw new Error("Commander XP provision recovery command is invalid");
}
