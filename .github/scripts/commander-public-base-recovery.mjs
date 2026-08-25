#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const STATE_FILE = "commander-public-base-recovery-v1.json";
const stages = new Set([
  "intent",
  "ghcr",
  "coworld-image",
  "coworld-policy",
  "complete",
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
    relative === "source-provenance.json" ||
    relative === "intent.json" ||
    relative === "ghcr.json" ||
    relative === "attestations/policy.jsonl" ||
    /^materialization\/(?:image|policy|summary)\.json$/.test(relative)
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
        throw new Error(`Commander public-base recovery link: ${relative}`);
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
        throw new Error(`Commander public-base recovery path: ${relative}`);
      }
    }
  };
  visit(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function assertStage(stage, paths) {
  const intent = ["source-provenance.json", "intent.json"];
  const ghcr = ["ghcr.json", "attestations/policy.jsonl"];
  const image = ["materialization/image.json"];
  const policy = ["materialization/policy.json"];
  const summary = ["materialization/summary.json"];
  const requireExact = (expected) => {
    if (
      JSON.stringify([...paths].sort()) !== JSON.stringify([...expected].sort())
    ) {
      throw new Error(
        `Commander public-base recovery ${stage} inventory invalid`,
      );
    }
  };
  if (stage === "intent") return requireExact(intent);
  if (stage === "ghcr") return requireExact([...intent, ...ghcr]);
  if (stage === "coworld-image")
    return requireExact([...intent, ...ghcr, ...image]);
  if (stage === "coworld-policy")
    return requireExact([...intent, ...ghcr, ...image, ...policy]);
  return requireExact([...intent, ...ghcr, ...image, ...policy, ...summary]);
}

function exactIdentity(sourceSha, sourceTreeSha, policyName, fenceRef) {
  if (
    !/^[0-9a-f]{40}$/.test(sourceSha) ||
    !/^[0-9a-f]{40}$/.test(sourceTreeSha) ||
    !/^proxywar-commander-public-base-[0-9a-f]{20}$/.test(policyName) ||
    !/^refs\/tags\/commander-public-base-v1\/[0-9a-f]{64}$/.test(fenceRef)
  ) {
    throw new Error("Commander public-base recovery identity is invalid");
  }
}

function validate(root, identity) {
  const statePath = path.join(root, STATE_FILE);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const { stateSha256, ...body } = state;
  const expectedKeys = [
    "schemaVersion",
    "authority",
    "repository",
    "workflowPath",
    "sourceSha",
    "sourceTreeSha",
    "policyName",
    "fenceRef",
    "stage",
    "createdAt",
    "priorStateSha256",
    "priorStateSha256s",
    "files",
    "stateSha256",
  ].sort();
  if (
    JSON.stringify(Object.keys(state).sort()) !==
      JSON.stringify(expectedKeys) ||
    state.schemaVersion !== 1 ||
    state.authority !== "github-actions-commander-public-base-recovery-v1" ||
    state.repository !== "0xNad/ProxyWar" ||
    state.workflowPath !== ".github/workflows/commander-public-base.yml" ||
    state.sourceSha !== identity.sourceSha ||
    state.sourceTreeSha !== identity.sourceTreeSha ||
    state.policyName !== identity.policyName ||
    state.fenceRef !== identity.fenceRef ||
    !stages.has(state.stage) ||
    !Array.isArray(state.priorStateSha256s) ||
    state.priorStateSha256s.some((value) => !/^[0-9a-f]{64}$/.test(value)) ||
    new Set(state.priorStateSha256s).size !== state.priorStateSha256s.length ||
    state.priorStateSha256 !== (state.priorStateSha256s.at(-1) ?? null) ||
    stateSha256 !== canonicalHash(body)
  ) {
    throw new Error("Commander public-base recovery state is invalid");
  }
  const actualFiles = inventory(root);
  if (JSON.stringify(state.files) !== JSON.stringify(actualFiles)) {
    throw new Error("Commander public-base recovery inventory mismatch");
  }
  assertStage(state.stage, new Set(actualFiles.map((file) => file.path)));
  return state;
}

const [command, rootInput, stageOrSource, ...tail] = process.argv.slice(2);
const root = path.resolve(rootInput ?? "");
if (!rootInput || !fs.statSync(root).isDirectory()) {
  throw new Error("Commander public-base recovery root is invalid");
}

if (command === "build") {
  const stage = stageOrSource;
  const [sourceSha, sourceTreeSha, policyName, fenceRef] = tail;
  if (!stages.has(stage)) {
    throw new Error("Commander public-base recovery stage is invalid");
  }
  exactIdentity(sourceSha, sourceTreeSha, policyName, fenceRef);
  const priorPath = path.join(root, STATE_FILE);
  let priorStateSha256 = null;
  let priorStateSha256s = [];
  if (fs.existsSync(priorPath)) {
    const prior = JSON.parse(fs.readFileSync(priorPath, "utf8"));
    priorStateSha256 = prior.stateSha256;
    if (
      !/^[0-9a-f]{64}$/.test(priorStateSha256 ?? "") ||
      !Array.isArray(prior.priorStateSha256s) ||
      prior.priorStateSha256s.some((value) => !/^[0-9a-f]{64}$/.test(value))
    ) {
      throw new Error("Commander public-base prior recovery state is invalid");
    }
    priorStateSha256s = [...prior.priorStateSha256s, priorStateSha256];
    fs.rmSync(priorPath);
  }
  const files = inventory(root);
  assertStage(stage, new Set(files.map((file) => file.path)));
  const body = {
    schemaVersion: 1,
    authority: "github-actions-commander-public-base-recovery-v1",
    repository: "0xNad/ProxyWar",
    workflowPath: ".github/workflows/commander-public-base.yml",
    sourceSha,
    sourceTreeSha,
    policyName,
    fenceRef,
    stage,
    createdAt: new Date().toISOString(),
    priorStateSha256,
    priorStateSha256s,
    files,
  };
  const state = { ...body, stateSha256: canonicalHash(body) };
  fs.writeFileSync(priorPath, `${JSON.stringify(state, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({ stage, stateSha256: state.stateSha256, priorStateSha256s })}\n`,
  );
} else if (command === "validate") {
  const sourceSha = stageOrSource;
  const [sourceTreeSha, policyName, fenceRef] = tail;
  exactIdentity(sourceSha, sourceTreeSha, policyName, fenceRef);
  const state = validate(root, {
    sourceSha,
    sourceTreeSha,
    policyName,
    fenceRef,
  });
  process.stdout.write(
    `${JSON.stringify({ stage: state.stage, stateSha256: state.stateSha256, priorStateSha256s: state.priorStateSha256s })}\n`,
  );
} else {
  throw new Error("Commander public-base recovery command is invalid");
}
