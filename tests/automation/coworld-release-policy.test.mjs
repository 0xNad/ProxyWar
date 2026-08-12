import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isBatchQuiet,
  parseQueueIssue,
  selectQueueBatch,
  validateBatchAncestry,
} from "../../.github/scripts/coworld-queue.mjs";
import {
  assertTemplateRebuildsReplayViewer,
  certificationGate,
  createReleaseRecord,
  extractSourceSha,
  findSourceRelease,
  postPromotionDecision,
  stampManifest,
  versionAllocationDecision,
} from "../../.github/scripts/coworld-release-policy.mjs";

const SHA = "a".repeat(40);
const template = {
  game: {
    name: "proxywar",
    replay_viewer: { bundle: "build/static-replay-viewer" },
    docs: {
      pages: [
        {
          id: "proxywar-release-provenance",
          title: "Release provenance",
          content: { type: "text", value: "source_sha={{SOURCE_SHA}}" },
        },
      ],
    },
  },
};

test("every release template requires the canonical replay-viewer rebuild hook", () => {
  assert.equal(assertTemplateRebuildsReplayViewer(template), true);
  assert.throws(() =>
    assertTemplateRebuildsReplayViewer({
      game: { replay_viewer: { bundle: `sha256:${"b".repeat(64)}` } },
    }),
  );
});

test("non-game Node runnables do not reuse the oversized OpenFront game image", () => {
  const manifest = JSON.parse(
    readFileSync(
      "coworld-adapter/coworld/coworld_manifest_template.json",
      "utf8",
    ),
  );
  assert.equal(manifest.game.runnable.image, "{{GAME_IMAGE}}");
  assert.deepEqual(
    manifest.player.map((entry) => entry.image),
    ["{{RUNNABLES_IMAGE}}"],
  );
  assert.deepEqual(
    manifest.optimizer.map((entry) => entry.image),
    ["{{RUNNABLES_IMAGE}}"],
  );

  const compose = readFileSync("coworld-adapter/coworld_compose.yaml", "utf8");
  assert.match(compose, /^ {2}runnables:\n/m);
  assert.match(compose, /dockerfile: Dockerfile\.runnables/);
  assert.match(compose, /proxywar-runnables-local:latest/);

  const dockerfile = readFileSync(
    "coworld-adapter/Dockerfile.runnables",
    "utf8",
  );
  assert.match(
    dockerfile,
    /^FROM --platform=\$TARGETPLATFORM node:24-bookworm-slim@sha256:[0-9a-f]{64}$/m,
  );
  assert.match(
    dockerfile,
    /COPY src\/starter-player\.mjs src\/coworld-url\.mjs src\/proxywar-optimizer-plan\.mjs \.\/src\//,
  );
});

test("source provenance supports idempotent retry detection", () => {
  const manifest = stampManifest(template, SHA, {
    pr: 80,
    merge_sha: "b".repeat(40),
  });
  assert.equal(extractSourceSha(manifest), SHA);
  const found = findSourceRelease(
    [
      { name: "proxywar", version: "0.1.40", manifest },
      { name: "other", version: "9.9.9", manifest },
    ],
    SHA,
  );
  assert.equal(found.version, "0.1.40");
});

test("version allocation collision forces manifest rebuild and recertification", () => {
  assert.deepEqual(versionAllocationDecision("0.1.40", "0.1.41"), {
    version: "0.1.41",
    collision: true,
    rebuildManifestAndRecertify: true,
  });
  assert.equal(versionAllocationDecision("0.1.40", "0.1.40").collision, false);
});

test("failed certification leaves a staged candidate unpromoted", () => {
  assert.deepEqual(
    certificationGate({
      candidateId: "cow_new",
      certified: false,
      uploadWasCanonical: false,
      previousCanonicalId: "cow_old",
      rollbackSupported: false,
    }),
    {
      action: "leave-previous-canonical",
      healthy: false,
      previousCanonicalId: "cow_old",
    },
  );
});

test("current Coworld auto-promotion fails loudly when rollback is unavailable", () => {
  const result = certificationGate({
    candidateId: "cow_new",
    certified: false,
    uploadWasCanonical: true,
    previousCanonicalId: "cow_old",
    rollbackSupported: false,
  });
  assert.equal(result.action, "manual-recovery-required");
  assert.equal(result.candidateId, "cow_new");
  assert.equal(result.previousCanonicalId, "cow_old");
});

test("successful certification proceeds to canonical and league verification", () => {
  assert.equal(
    certificationGate({ candidateId: "cow_new", certified: true }).action,
    "verify-canonical-and-league",
  );
  assert.deepEqual(
    postPromotionDecision({ leagueBound: true, replayVerified: true }),
    { action: "complete", healthy: true },
  );
});

test("post-promotion failure invokes rollback when supported", () => {
  assert.deepEqual(
    postPromotionDecision({
      leagueBound: false,
      replayVerified: true,
      rollbackSupported: true,
      previousCanonicalId: "cow_old",
    }),
    { action: "rollback", healthy: false, targetId: "cow_old" },
  );
});

test("release records reject secret-shaped output", () => {
  assert.doesNotThrow(() =>
    createReleaseRecord({ sourceSha: SHA, manifestHash: "sha256:abc" }),
  );
  assert.throws(() => createReleaseRecord({ private_key: "forbidden" }));
});

test("durable queue batches every open labeled issue in merge order", () => {
  const issues = [
    {
      number: 2,
      state: "open",
      created_at: "2026-08-11T01:00:00Z",
      merge_order_at: "2026-08-11T02:00:00Z",
      labels: [{ name: "coworld-release-queued" }],
    },
    {
      number: 1,
      state: "open",
      created_at: "2026-08-11T02:00:00Z",
      merge_order_at: "2026-08-11T01:00:00Z",
      labels: [{ name: "coworld-release-queued" }],
    },
    {
      number: 3,
      state: "closed",
      created_at: "2026-08-11T00:00:00Z",
      merge_order_at: "2026-08-11T00:00:00Z",
      labels: [{ name: "coworld-release-queued" }],
    },
    {
      number: 4,
      state: "open",
      created_at: "2026-08-11T03:00:00Z",
      merge_order_at: "2026-08-11T03:00:00Z",
      labels: [
        { name: "coworld-release-queued" },
        { name: "coworld-release-batch-hold" },
      ],
    },
  ];
  assert.deepEqual(
    selectQueueBatch(issues).map((issue) => issue.number),
    [1, 2],
  );
  assert.deepEqual(
    selectQueueBatch(issues, 2).map((issue) => issue.number),
    [1, 2],
  );
});

test("batch waits for a quiet window after the newest included merge", () => {
  const batch = [
    { merge_order_at: "2026-08-12T10:00:00Z" },
    { merge_order_at: "2026-08-12T10:10:00Z" },
  ];
  assert.equal(isBatchQuiet(batch, new Date("2026-08-12T10:24:59Z")), false);
  assert.equal(isBatchQuiet(batch, new Date("2026-08-12T10:25:00Z")), true);
  assert.equal(isBatchQuiet([], new Date("2026-08-12T10:25:00Z")), false);
});

test("batch source must contain every earlier queued merge", () => {
  const records = [
    { mergeSha: "a".repeat(40) },
    { mergeSha: "b".repeat(40) },
    { mergeSha: "c".repeat(40) },
  ];
  assert.equal(
    validateBatchAncestry(records, [
      { status: "ahead", behind_by: 0 },
      { status: "ahead", behind_by: 0 },
    ]).mergeSha,
    "c".repeat(40),
  );
  assert.throws(() =>
    validateBatchAncestry(records, [
      { status: "ahead", behind_by: 0 },
      { status: "diverged", behind_by: 1 },
    ]),
  );
  assert.throws(() => validateBatchAncestry(records, []));
});

test("queue parser rejects spoofed issue authors", () => {
  const body = `<!-- proxywar-coworld-release-queue-v1 -->\n- PR: #80\n- Author: johomax\n- Tested head SHA: \`${SHA}\`\n- Merge SHA: \`${"b".repeat(40)}\``;
  assert.throws(() =>
    parseQueueIssue({
      number: 1,
      body,
      user: { login: "attacker", type: "User" },
    }),
  );
  assert.equal(
    parseQueueIssue({
      number: 1,
      body,
      user: { login: "github-actions[bot]", type: "Bot" },
    }).prNumber,
    80,
  );
});
