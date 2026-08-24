import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRunRuntime,
  bindResumedRequests,
  buildRequests,
  renderMarkdown,
  summarizeRuns,
  summarizeTrace,
} from "./commander-coworld-triplet.mjs";

const ids = {
  coworldID: "cow_e478e2b6-549d-4670-8a4a-32c48b8e75a2",
  policies: {
    A: "83d474da-ed73-4552-bbd4-6aaca8c6db4f",
    B: "460324d5-c965-497c-bb6a-8ec669d555ea",
    C: "e36110ed-1b32-4d51-a812-513978329029",
  },
  opponentPolicy: "5fc92e96-6f19-4612-b5df-f1fe287c11f2",
};

test("builds matched direct Coworld requests without a routing override", () => {
  const requests = buildRequests({
    ...ids,
    seeds: [18, 19],
    subjectSeats: [1, 2],
    runID: "functional-20260824",
  });
  assert.equal(requests.length, 6);
  for (const tripletIndex of [0, 1]) {
    const triplet = requests.filter(
      (request) => request.tripletIndex === tripletIndex,
    );
    assert.deepEqual(
      triplet.map((request) => request.arm),
      ["A", "B", "C"],
    );
    assert.equal(new Set(triplet.map((request) => request.seed)).size, 1);
    assert.equal(
      new Set(triplet.map((request) => request.subjectSeat)).size,
      1,
    );
    assert.equal(
      new Set(
        triplet.map((request) =>
          JSON.stringify(request.body.game_config_overrides),
        ),
      ).size,
      3,
      "run key is the intentional per-arm config difference",
    );
    for (const request of triplet) {
      assert.equal("llm_routing_override" in request.body, false);
      assert.equal(
        request.body.roster[request.subjectSeat].player.policy_ref,
        ids.policies[request.arm],
      );
      assert.equal(request.body.game_config_overrides.max_decision_steps, 360);
      assert.equal(
        request.body.game_config_overrides.turns_per_decision_step,
        100,
      );
      assert.equal(request.body.game_config_overrides.max_decision_ms, 15_000);
    }
  }
});

test("the runner invokes Coworld with a request path rather than a removed --file flag", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(
      new URL("./commander-coworld-triplet.mjs", import.meta.url),
      "utf8",
    ),
  );
  assert.doesNotMatch(source, /"create",\s*"--file"/);
  assert.match(source, /"create",\s*requestPath,\s*"--json"/);
});

test("the hosted selector budget stays inside the working Coworld deadline", async () => {
  const { readFile } = await import("node:fs/promises");
  const [runtime, dockerfile] = await Promise.all([
    readFile(
      new URL(
        "../../src/server/agents/CommanderCoworldRuntime.ts",
        import.meta.url,
      ),
      "utf8",
    ),
    readFile(new URL("../Dockerfile.commander-xp", import.meta.url), "utf8"),
  ]);
  assert.match(runtime, /COMMANDER_COWORLD_MAX_DECISION_MS = 15_000/);
  assert.match(runtime, /timeoutMs: 13_500/);
  assert.match(runtime, /maxTokens: 1_024/);
  assert.match(dockerfile, /PROXYWAR_LLM_TIMEOUT_MS=13500/);
});

test("resumes only an exact created-request manifest without another create", () => {
  const requests = buildRequests({
    ...ids,
    seeds: [18],
    subjectSeats: [1],
    runID: "functional-20260824",
  });
  const persisted = requests.map((request, index) => ({
    ...request,
    xreqID: `xreq_00000000-0000-4000-8000-00000000000${index}`,
  }));
  assert.deepEqual(
    bindResumedRequests(requests, persisted).map((entry) => entry.xreqID),
    persisted.map((entry) => entry.xreqID),
  );
  const tampered = structuredClone(persisted);
  tampered[0].body.game_config_overrides.seed = 19;
  assert.throws(
    () => bindResumedRequests(requests, tampered),
    /Resume manifest mismatch/,
  );
});

test("summarizes provider and Commander runtime evidence", () => {
  const trace = [
    { recordType: "provider", stage: "preflight", succeeded: true },
    { recordType: "provider", stage: "selector", succeeded: true },
    {
      recordType: "decision",
      selectedLegalActionID: "expand:terra-nullius:20",
      fallbackUsed: false,
      llmPlannerDegraded: false,
      commander: {
        plannerSource: "strategic-commander-v0",
        externalPlannerCall: true,
        commanderSelectorSource: "llm",
        commanderSelectedOptionFamily: "expand",
        commanderFidelity: "aligned_primary",
      },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  const summary = summarizeTrace(`${trace}\n`);
  assert.equal(summary.recordCount, 3);
  assert.equal(summary.decisionCount, 1);
  assert.equal(summary.providerCalls.selector.succeeded, 1);
  assert.equal(summary.llmSelectorDecisions, 1);
  assert.equal(summary.alignedPrimaryDecisions, 1);
  assert.equal(summary.fallbackCount, 0);
  assert.deepEqual(summary.degradedCauses, {});
  assert.equal(summary.activeNonHoldDecisions, 1);
});

test("retains active Commander evidence when a transient selector call falls back", () => {
  assert.doesNotThrow(() =>
    assertRunRuntime({
      arm: "C",
      runKey: "commander-xp-v2/fixture/canary/r00/C",
      trace: {
        providerFailures: 1,
        fallbackCount: 3,
        degradedCount: 3,
        providerCalls: {
          preflight: { count: 1, succeeded: 1 },
          planner: { count: 0, succeeded: 0 },
          selector: { count: 13, succeeded: 12 },
        },
        externalPlannerCalls: 13,
        deterministicSelectorDecisions: 0,
        llmSelectorDecisions: 12,
        activeNonHoldDecisions: 40,
        activeNonSurviveDecisions: 37,
      },
    }),
  );
  assert.throws(
    () =>
      assertRunRuntime({
        arm: "C",
        runKey: "commander-xp-v2/fixture/canary/r00/C",
        trace: {
          providerFailures: 1,
          fallbackCount: 40,
          degradedCount: 40,
          providerCalls: {
            preflight: { count: 1, succeeded: 1 },
            planner: { count: 0, succeeded: 0 },
            selector: { count: 1, succeeded: 0 },
          },
          externalPlannerCalls: 1,
          deterministicSelectorDecisions: 0,
          llmSelectorDecisions: 0,
          activeNonHoldDecisions: 40,
          activeNonSurviveDecisions: 40,
        },
      }),
    /does not prove its declared arm/,
  );
});

test("renders an explicitly bounded functional report", () => {
  const summary = summarizeRuns([
    {
      tripletIndex: 0,
      arm: "A",
      seed: 18,
      subjectSeat: 1,
      winnerSlot: 1,
      subjectWon: true,
      costUsd: 0.03,
      trace: traceSummary({ planner: 2 }),
    },
    {
      tripletIndex: 0,
      arm: "B",
      seed: 18,
      subjectSeat: 1,
      winnerSlot: 3,
      subjectWon: false,
      costUsd: 0.02,
      trace: traceSummary(),
    },
    {
      tripletIndex: 0,
      arm: "C",
      seed: 18,
      subjectSeat: 1,
      winnerSlot: 3,
      subjectWon: false,
      costUsd: 0.04,
      trace: traceSummary({ selector: 1 }),
    },
  ]);
  const markdown = renderMarkdown({
    runID: "fixture",
    status: "passed",
    claimBoundary: "No statistical claim.",
    summary,
    runs: [
      {
        tripletIndex: 0,
        arm: "B",
        subjectSeat: 1,
        winnerSlot: 3,
        subjectWon: false,
        trace: {
          decisionCount: 360,
          providerCalls: {
            preflight: { count: 1, succeeded: 1 },
            planner: { count: 0, succeeded: 0 },
            selector: { count: 0, succeeded: 0 },
          },
          providerFailures: 0,
          fallbackCount: 0,
          degradedCount: 0,
        },
      },
    ],
  });
  assert.match(markdown, /Subject losses are retained/);
  assert.match(markdown, /\| 0 \| B \| 1 \| 3 \| false \|/);
  assert.match(markdown, /subject wins A\/B\/C: 1\/0\/0/);
});

function traceSummary(overrides = {}) {
  return {
    decisionCount: 1,
    providerCalls: {
      preflight: { count: 1, succeeded: 1 },
      planner: {
        count: overrides.planner ?? 0,
        succeeded: overrides.planner ?? 0,
      },
      selector: {
        count: overrides.selector ?? 0,
        succeeded: overrides.selector ?? 0,
      },
    },
    providerFailures: 0,
    fallbackCount: 0,
    degradedCount: 0,
  };
}
