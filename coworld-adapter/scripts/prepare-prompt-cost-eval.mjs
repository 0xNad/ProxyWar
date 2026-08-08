#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COWORLD_ID =
  /^cow_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_LABEL = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/i;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/i;
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,255}$/i;

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
}

function boundedInteger(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return parsed;
}

function alternatingRoster({
  baselinePolicy,
  candidatePolicy,
  seatCount,
  parity,
}) {
  return Array.from({ length: seatCount }, (_, slot) => {
    const candidateOnEven = parity === "candidate-even";
    const candidate = slot % 2 === 0 ? candidateOnEven : !candidateOnEven;
    return {
      player: { policy_ref: candidate ? candidatePolicy : baselinePolicy },
      slot,
    };
  });
}

function boundedRequestKey(parts) {
  const raw = parts.join("-");
  if (raw.length <= 200) return raw;
  const suffix = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  return `${raw.slice(0, 183)}-${suffix}`;
}

export function buildPromptCostEvalPlan(input) {
  const experiment = requiredString(input.experiment, "experiment");
  if (!SAFE_LABEL.test(experiment))
    throw new Error("experiment must be a lowercase safe label");
  const coworldId = requiredString(input.coworldId, "coworldId");
  if (!COWORLD_ID.test(coworldId)) throw new Error("coworldId is invalid");
  const baselinePolicy = requiredString(input.baselinePolicy, "baselinePolicy");
  const candidatePolicy = requiredString(
    input.candidatePolicy,
    "candidatePolicy",
  );
  if (!UUID.test(baselinePolicy) || !UUID.test(candidatePolicy))
    throw new Error("policy references must be immutable policy-version UUIDs");
  if (baselinePolicy.toLowerCase() === candidatePolicy.toLowerCase())
    throw new Error("baselinePolicy and candidatePolicy must differ");
  const sourceSha = requiredString(input.sourceSha, "sourceSha");
  if (!SOURCE_SHA.test(sourceSha))
    throw new Error("sourceSha must be a full 40-character Git SHA");
  const baselineImageDigest = requiredString(
    input.baselineImageDigest,
    "baselineImageDigest",
  );
  const candidateImageDigest = requiredString(
    input.candidateImageDigest,
    "candidateImageDigest",
  );
  if (
    !IMAGE_DIGEST.test(baselineImageDigest) ||
    !IMAGE_DIGEST.test(candidateImageDigest)
  )
    throw new Error("image digests must be immutable sha256 digests");
  if (baselineImageDigest.toLowerCase() === candidateImageDigest.toLowerCase())
    throw new Error("baseline and candidate image digests must differ");
  const model = requiredString(input.model, "model");
  if (!MODEL_ID.test(model)) throw new Error("model is invalid");
  const seatCount = boundedInteger(input.seatCount ?? 12, "seatCount", 2, 16);
  if (seatCount % 2 !== 0) throw new Error("seatCount must be even");
  const episodesPerRequest = boundedInteger(
    input.episodesPerRequest ?? 2,
    "episodesPerRequest",
    1,
    100,
  );
  const variants = Array.isArray(input.variants) ? input.variants : [];
  if (variants.length === 0)
    throw new Error("at least one variant is required");
  if (new Set(variants).size !== variants.length)
    throw new Error("variants must be unique");
  for (const variant of variants) {
    if (!SAFE_LABEL.test(variant))
      throw new Error(`invalid variant: ${variant}`);
  }

  const requests = [];
  for (const variant of variants) {
    for (const parity of ["candidate-even", "candidate-odd"]) {
      const roster = alternatingRoster({
        baselinePolicy,
        candidatePolicy,
        seatCount,
        parity,
      });
      const notes =
        `${experiment}; ${parity}; source=${sourceSha}; model=${model}; ` +
        `baseline=${baselinePolicy}@${baselineImageDigest},hardening=0,max=300,prefill=0; ` +
        `candidate=${candidatePolicy}@${candidateImageDigest},hardening=1,max=500,prefill=1; ` +
        "eval-only, never league-submit; compare outcomes, usage, latency, fallback, degradation, and social evidence";
      if (notes.length > 1000)
        throw new Error(
          "generated notes exceed the hosted 1000-character limit",
        );
      const payloadSha256 = createHash("sha256")
        .update(
          JSON.stringify({
            experiment,
            coworldId,
            variant,
            parity,
            baselinePolicy,
            candidatePolicy,
            sourceSha,
            baselineImageDigest,
            candidateImageDigest,
            model,
            seatCount,
            episodesPerRequest,
          }),
        )
        .digest("hex");
      const requestKey = boundedRequestKey([
        experiment,
        variant,
        parity,
        payloadSha256.slice(0, 16),
      ]);
      requests.push({
        requestKey,
        payloadSha256,
        variant,
        parity,
        treatmentBySlot: roster.map((entry) => ({
          slot: entry.slot,
          arm:
            entry.player.policy_ref === candidatePolicy
              ? "candidate"
              : "baseline",
        })),
        body: {
          idempotency_key: requestKey,
          coworld_id: coworldId,
          variant_id: variant,
          roster,
          num_episodes: episodesPerRequest,
          notes,
        },
      });
    }
  }

  const plan = {
    schemaVersion: 1,
    experiment,
    coworldId,
    baselinePolicy,
    candidatePolicy,
    sourceSha,
    model,
    arms: {
      baseline: {
        policyVersionId: baselinePolicy,
        imageDigest: baselineImageDigest,
        promptVariant: "full-baseline-telemetry-v1",
        promptHardening: false,
        maxTokens: 300,
        assistantPrefill: false,
      },
      candidate: {
        policyVersionId: candidatePolicy,
        imageDigest: candidateImageDigest,
        promptVariant: "full-hardened-telemetry-v2",
        promptHardening: true,
        maxTokens: 500,
        assistantPrefill: false,
      },
    },
    seatCount,
    episodesPerRequest,
    totalEpisodes: requests.length * episodesPerRequest,
    variants,
    requests,
    safety: {
      mutatesHostedState: false,
      hasExecutePath: false,
      policiesMustRemainUnsubmitted: true,
    },
  };
  return {
    ...plan,
    planSha256: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
  };
}

function parseArgs(argv) {
  const values = { variants: [] };
  for (const arg of argv) {
    if (!arg.startsWith("--") || !arg.includes("="))
      throw new Error(`expected --key=value, received: ${arg}`);
    const [key, ...rest] = arg.slice(2).split("=");
    const value = rest.join("=");
    if (key === "variant") values.variants.push(value);
    else if (key === "experiment") values.experiment = value;
    else if (key === "coworld-id") values.coworldId = value;
    else if (key === "baseline-policy") values.baselinePolicy = value;
    else if (key === "candidate-policy") values.candidatePolicy = value;
    else if (key === "source-sha") values.sourceSha = value;
    else if (key === "baseline-image-digest")
      values.baselineImageDigest = value;
    else if (key === "candidate-image-digest")
      values.candidateImageDigest = value;
    else if (key === "model") values.model = value;
    else if (key === "seat-count") values.seatCount = value;
    else if (key === "episodes-per-request") values.episodesPerRequest = value;
    else throw new Error(`unknown option: --${key}`);
  }
  return values;
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  try {
    process.stdout.write(
      `${JSON.stringify(buildPromptCostEvalPlan(parseArgs(process.argv.slice(2))), null, 2)}\n`,
    );
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 2;
  }
}
