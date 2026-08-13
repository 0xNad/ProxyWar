import assert from "node:assert/strict";
import test from "node:test";

import { workflowRunCandidates } from "../../.github/scripts/trusted-pr-events.mjs";

const SHA = "a".repeat(40);

function workflowRun(overrides = {}) {
  return {
    event: "pull_request",
    head_sha: SHA,
    head_branch: "agent/faster-observations",
    head_repository: { full_name: "johomax/ProxyWar" },
    pull_requests: [],
    ...overrides,
  };
}

function pull(overrides = {}) {
  return {
    number: 91,
    head: {
      sha: SHA,
      ref: "agent/faster-observations",
      repo: { full_name: "johomax/ProxyWar" },
    },
    ...overrides,
  };
}

test("resolves an empty workflow_run pull list by exact repository, branch, and SHA", () => {
  assert.deepEqual(workflowRunCandidates(workflowRun(), [pull()]), [
    { number: 91, expectedHeadSha: SHA },
  ]);
});

test("rejects stale, lookalike, and incomplete workflow_run head metadata", () => {
  const candidates = [
    pull({ head: { ...pull().head, sha: "b".repeat(40) } }),
    pull({ head: { ...pull().head, ref: "agent/faster-observations-copy" } }),
    pull({
      head: {
        ...pull().head,
        repo: { full_name: "lookalike/ProxyWar" },
      },
    }),
  ];
  assert.deepEqual(workflowRunCandidates(workflowRun(), candidates), []);
  assert.deepEqual(
    workflowRunCandidates(workflowRun({ event: "workflow_dispatch" }), [
      pull(),
    ]),
    [],
  );
  assert.deepEqual(
    workflowRunCandidates(workflowRun({ head_sha: "not-a-sha" }), [pull()]),
    [],
  );
});

test("uses the workflow run SHA when GitHub supplies direct PR metadata", () => {
  assert.deepEqual(
    workflowRunCandidates(
      workflowRun({ pull_requests: [{ number: 93, head: {} }] }),
    ),
    [{ number: 93, expectedHeadSha: SHA }],
  );
});
