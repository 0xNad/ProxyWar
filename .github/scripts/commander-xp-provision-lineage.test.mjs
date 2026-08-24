import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  sealLineage,
  validateLineage,
} from "./commander-xp-provision-lineage.mjs";

const sourceSha = "1".repeat(40);
const sourceTreeSha = "2".repeat(40);
const evalVersion = "0.0.7";
const namePrefix = "proxywar-commander-xp-abcdef123456-v007";
const fenceRef = `refs/tags/commander-xp-provision-v2/${"3".repeat(64)}`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
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

function state(priorStateSha256s) {
  const body = {
    schemaVersion: 3,
    authority: "github-actions-provision-recovery-v3",
    repository: "0xNad/ProxyWar",
    workflowPath: ".github/workflows/commander-xp-provision.yml",
    sourceSha,
    sourceTreeSha,
    evalVersion,
    namePrefix,
    fenceRef,
    stage: "eval-upload",
    createdAt: "2026-08-23T20:00:00.000Z",
    priorStateSha256: priorStateSha256s.at(-1) ?? null,
    priorStateSha256s,
    files: [{ path: "fence-intent.json", bytes: 1, sha256: "4".repeat(64) }],
  };
  const value = {
    ...body,
    stateSha256: sha(JSON.stringify(canonical(body))),
  };
  return { value, bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`) };
}

const expected = {
  sourceSha,
  sourceTreeSha,
  evalVersion,
  namePrefix,
  fenceRef,
};
const base = {
  schemaVersion: 1,
  authority: "github-actions-provision-recovery-lineage-v1",
  repository: "0xNad/ProxyWar",
  workflowPath: ".github/workflows/commander-xp-provision.yml",
  sourceSha,
  sourceTreeSha,
  evalVersion,
  namePrefix,
  fenceRef,
};

test("provision lineage binds an exact retained boundary through the final state", () => {
  const inputState = "5".repeat(64);
  const final = state(["6".repeat(64), inputState, "7".repeat(64)]);
  const lineage = sealLineage(
    {
      ...base,
      mode: "recovered",
      inputBoundary: {
        artifactID: 123,
        name: `commander-xp-provision-boundary-ghcr-${sourceSha}-${evalVersion}-11-2`,
        digest: `sha256:${"8".repeat(64)}`,
        workflowRunID: 11,
        workflowRunAttempt: 2,
        stage: "ghcr",
        stateSha256: inputState,
        priorStateSha256s: ["6".repeat(64)],
      },
      remoteAdoption: {
        policyImage: true,
        gameImage: false,
        policyRoles: ["A", "opponent-3"],
        evalCoworld: true,
      },
    },
    final.value,
    final.bytes,
    expected,
  );
  assert.equal(
    validateLineage(lineage, final.value, final.bytes, expected),
    lineage,
  );
});

test("provision lineage rejects discontinuity, substitution, and fresh adoption", () => {
  const final = state(["6".repeat(64)]);
  const fresh = sealLineage(
    {
      ...base,
      mode: "fresh",
      inputBoundary: null,
      remoteAdoption: {
        policyImage: false,
        gameImage: false,
        policyRoles: [],
        evalCoworld: false,
      },
    },
    final.value,
    final.bytes,
    expected,
  );
  assert.throws(
    () =>
      validateLineage(
        {
          ...fresh,
          remoteAdoption: { ...fresh.remoteAdoption, gameImage: true },
        },
        final.value,
        final.bytes,
        expected,
      ),
    /hash mismatch|fresh provision/,
  );
  const changed = Buffer.from(final.bytes);
  changed[0] ^= 1;
  assert.throws(
    () => validateLineage(fresh, final.value, changed, expected),
    /final provision recovery lineage mismatch/,
  );
});
