import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The plan-only CLI is intentionally plain runtime JavaScript.
import { buildPromptCostEvalPlan } from "../../coworld-adapter/scripts/prepare-prompt-cost-eval.mjs";

type EvalRosterEntry = {
  player: { policy_ref: string };
  slot: number;
};
type EvalRequest = {
  variant: string;
  parity: string;
  payloadSha256: string;
  body: {
    idempotency_key: string;
    coworld_id: string;
    num_episodes: number;
    notes: string;
    roster: EvalRosterEntry[];
  };
};
type EvalPlan = {
  totalEpisodes: number;
  requests: EvalRequest[];
  planSha256: string;
  safety: Record<string, boolean>;
  sourceSha: string;
  model: string;
  arms: unknown;
};

const buildPlan = buildPromptCostEvalPlan as (
  input: Record<string, unknown>,
) => EvalPlan;

const BASELINE = "11111111-1111-4111-8111-111111111111";
const CANDIDATE = "22222222-2222-4222-8222-222222222222";
const COWORLD = "cow_33333333-3333-4333-8333-333333333333";
const SOURCE_SHA = "a".repeat(40);
const BASELINE_IMAGE = `sha256:${"b".repeat(64)}`;
const CANDIDATE_IMAGE = `sha256:${"c".repeat(64)}`;
const MODEL = "global.anthropic.claude-sonnet-4-6-v1";

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    experiment: "prompt-hardening-v1",
    coworldId: COWORLD,
    baselinePolicy: BASELINE,
    candidatePolicy: CANDIDATE,
    sourceSha: SOURCE_SHA,
    baselineImageDigest: BASELINE_IMAGE,
    candidateImageDigest: CANDIDATE_IMAGE,
    model: MODEL,
    variants: ["tournament-12p-pangaea"],
    ...overrides,
  };
}

describe("prompt-cost paired evaluation plan", () => {
  it("builds both seat parities for every variant without a hosted execution path", () => {
    const plan = buildPlan(
      validInput({
        variants: ["tournament-12p-pangaea", "tournament-12p-world"],
        seatCount: 12,
        episodesPerRequest: 2,
      }),
    );

    expect(plan.totalEpisodes).toBe(8);
    expect(plan.requests).toHaveLength(4);
    expect(plan.planSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.safety).toEqual({
      mutatesHostedState: false,
      hasExecutePath: false,
      policiesMustRemainUnsubmitted: true,
    });
    expect(plan.sourceSha).toBe(SOURCE_SHA);
    expect(plan.model).toBe(MODEL);
    expect(plan.arms).toEqual({
      baseline: {
        policyVersionId: BASELINE,
        imageDigest: BASELINE_IMAGE,
        promptVariant: "full-baseline-telemetry-v1",
        promptHardening: false,
        maxTokens: 300,
        assistantPrefill: false,
      },
      candidate: {
        policyVersionId: CANDIDATE,
        imageDigest: CANDIDATE_IMAGE,
        promptVariant: "full-hardened-telemetry-v2",
        promptHardening: true,
        maxTokens: 500,
        assistantPrefill: false,
      },
    });

    for (const request of plan.requests) {
      expect(request.body.coworld_id).toBe(COWORLD);
      expect(request.body.idempotency_key.length).toBeLessThanOrEqual(200);
      expect(request.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(request.body.num_episodes).toBe(2);
      expect(request.body.notes.length).toBeLessThanOrEqual(1000);
      expect(request.body.notes).toContain(`source=${SOURCE_SHA}`);
      expect(request.body.notes).toContain(`model=${MODEL}`);
      expect(request.body.notes).toContain("hardening=1,max=500,prefill=0");
      expect(request.body.notes).not.toContain("prefill=1");
      expect(request.body.roster).toHaveLength(12);
      expect(request.body.roster.map((entry) => entry.slot)).toEqual(
        Array.from({ length: 12 }, (_, index) => index),
      );
      expect(
        request.body.roster.filter(
          (entry) => entry.player.policy_ref === BASELINE,
        ),
      ).toHaveLength(6);
      expect(
        request.body.roster.filter(
          (entry) => entry.player.policy_ref === CANDIDATE,
        ),
      ).toHaveLength(6);
    }

    const even = plan.requests.find(
      (request) =>
        request.variant === "tournament-12p-pangaea" &&
        request.parity === "candidate-even",
    );
    const odd = plan.requests.find(
      (request) =>
        request.variant === "tournament-12p-pangaea" &&
        request.parity === "candidate-odd",
    );
    expect(even?.body.roster[0].player.policy_ref).toBe(CANDIDATE);
    expect(even?.body.roster[1].player.policy_ref).toBe(BASELINE);
    expect(odd?.body.roster[0].player.policy_ref).toBe(BASELINE);
    expect(odd?.body.roster[1].player.policy_ref).toBe(CANDIDATE);
  });

  it("is deterministic and rejects mutable or confounded inputs", () => {
    const input = validInput();
    expect(buildPlan(input).planSha256).toBe(buildPlan(input).planSha256);
    expect(() => buildPlan({ ...input, candidatePolicy: BASELINE })).toThrow(
      "must differ",
    );
    expect(() =>
      buildPlan({ ...input, baselinePolicy: "policy-name:v1" }),
    ).toThrow("immutable policy-version UUIDs");
    expect(() => buildPlan({ ...input, seatCount: 11 })).toThrow(
      "seatCount must be even",
    );
    expect(() => buildPlan({ ...input, sourceSha: "abc123" })).toThrow(
      "full 40-character Git SHA",
    );
    expect(() =>
      buildPlan({
        ...input,
        candidateImageDigest: BASELINE_IMAGE,
      }),
    ).toThrow("image digests must differ");
    expect(() => buildPlan({ ...input, model: "model with spaces" })).toThrow(
      "model is invalid",
    );
  });

  it("bounds long idempotency keys to the hosted API contract", () => {
    const plan = buildPlan(
      validInput({
        experiment: `e${"x".repeat(127)}`,
        variants: [`v${"y".repeat(127)}`],
      }),
    );
    expect(plan.requests[0].body.idempotency_key).toHaveLength(200);
    expect(plan.requests[1].body.idempotency_key).toHaveLength(200);
    expect(plan.requests[0].body.idempotency_key).not.toBe(
      plan.requests[1].body.idempotency_key,
    );
  });

  it("content-binds idempotency keys to immutable experiment provenance", () => {
    const original = buildPlan(validInput());
    const changedImage = buildPlan(
      validInput({
        candidateImageDigest: `sha256:${"d".repeat(64)}`,
      }),
    );
    const changedModel = buildPlan(
      validInput({ model: "global.anthropic.claude-haiku-4-5-v1" }),
    );
    expect(changedImage.requests[0].body.idempotency_key).not.toBe(
      original.requests[0].body.idempotency_key,
    );
    expect(changedModel.requests[0].body.idempotency_key).not.toBe(
      original.requests[0].body.idempotency_key,
    );
  });

  it("contains no network client, upload, submit, or execute option", async () => {
    const source = await fs.readFile(
      path.join(
        process.cwd(),
        "coworld-adapter",
        "scripts",
        "prepare-prompt-cost-eval.mjs",
      ),
      "utf8",
    );
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toContain("upload-policy");
    expect(source).not.toContain("coworld submit");
    expect(source).not.toContain("xp-request create");
    expect(source).not.toContain("--execute");
  });
});
