#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildBundle,
  createExternalPhaseLedger,
  createExternalReceipt,
  EXTERNAL_PHASE_LEDGER_FILE,
  EXTERNAL_RECEIPT_FILE,
  loadAndVerifySealRequest,
  readJsonFile,
  SealFailure,
  verifyBundle,
  verifyEvidenceBindings,
  verifyExternalPhaseLedger,
  verifyExternalReceipt,
  verifySourceCIMetadata,
} from "./commander-xp-external-seal-lib.mjs";

export async function runCommanderXpExternalSealCli(argv, env = process.env) {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  if (command === "prepare") {
    const manifest = await buildBundle({
      repository: requiredPath(options, "repository"),
      evidenceRoot: requiredPath(options, "evidence-root"),
      sealRequestRoot: requiredPath(options, "seal-request-root"),
      outputRoot: requiredPath(options, "output-root"),
      expectedRequestSha256: required(options, "expected-request-sha256"),
      sourceArtifactMetadataPath: requiredPath(
        options,
        "source-artifact-metadata",
      ),
      sourceCIMetadataPath: requiredPath(options, "source-ci-metadata"),
      verifierAggregatePath: requiredPath(options, "verifier-aggregate"),
      createdAt: required(options, "created-at"),
    });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return 0;
  }
  if (command === "verify-bundle") {
    const manifest = await verifyBundle(requiredPath(options, "bundle-root"), {
      repository: requiredPath(options, "repository"),
      sourceSha: required(options, "source-sha"),
      workflowRunID: positiveInteger(
        required(options, "workflow-run-id"),
        "workflow-run-id",
      ),
      workflowRunAttempt: positiveInteger(
        required(options, "workflow-run-attempt"),
        "workflow-run-attempt",
      ),
    });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return 0;
  }
  if (command === "verify-source-ci") {
    const metadata = await readJsonFile(requiredPath(options, "metadata"));
    const binding = await readJsonFile(requiredPath(options, "binding"));
    verifySourceCIMetadata(metadata, binding);
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    return 0;
  }
  if (command === "verify-evidence") {
    const evidenceRoot = requiredPath(options, "evidence-root");
    const { request } = await loadAndVerifySealRequest(
      requiredPath(options, "seal-request-root"),
      required(options, "expected-request-sha256"),
    );
    await verifyEvidenceBindings({
      evidenceRoot,
      request,
      verifierAggregatePath: requiredPath(options, "verifier-aggregate"),
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, experimentID: request.experimentID, phase: request.phase })}\n`,
    );
    return 0;
  }
  if (command === "receipt") {
    const outputPath = path.resolve(
      options.output ?? path.join(process.cwd(), EXTERNAL_RECEIPT_FILE),
    );
    const receipt = await withEnvironment(env, async () =>
      createExternalReceipt({
        bundleRoot: requiredPath(options, "bundle-root"),
        sealedBundlePath: requiredPath(options, "sealed-bundle"),
        outputPath,
        bundleArtifactMetadataPath: requiredPath(
          options,
          "bundle-artifact-metadata",
        ),
        completedAt: required(options, "completed-at"),
      }),
    );
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return 0;
  }
  if (command === "verify-receipt") {
    const receipt = await verifyExternalReceipt(
      requiredPath(options, "receipt"),
      {
        experimentID: options["experiment-id"],
        phase: options.phase,
      },
    );
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return 0;
  }
  if (command === "ledger") {
    const outputPath = path.resolve(
      options.output ?? path.join(process.cwd(), EXTERNAL_PHASE_LEDGER_FILE),
    );
    const ledger = await withEnvironment(env, async () =>
      createExternalPhaseLedger({
        bundleRoot: requiredPath(options, "bundle-root"),
        receiptPath: requiredPath(options, "receipt"),
        receiptArtifactMetadataPath: requiredPath(
          options,
          "receipt-artifact-metadata",
        ),
        outputPath,
        completedAt: required(options, "completed-at"),
      }),
    );
    process.stdout.write(`${JSON.stringify(ledger)}\n`);
    return 0;
  }
  if (command === "verify-ledger") {
    const ledger = await verifyExternalPhaseLedger(
      requiredPath(options, "ledger"),
      {
        phase: options.phase,
        experimentID: options["experiment-id"],
        behaviorBaseSha: options["behavior-base-sha"],
        behaviorBaseTreeSha: options["behavior-base-tree-sha"],
        headSha: options["source-sha"],
        treeSha: options["source-tree-sha"],
      },
    );
    process.stdout.write(`${JSON.stringify(ledger)}\n`);
    return 0;
  }
  throw new Error(
    "usage: commander-xp-external-seal.mjs <prepare|verify-source-ci|verify-evidence|verify-bundle|receipt|verify-receipt|ledger|verify-ledger> [--key=value]",
  );
}

function parseOptions(args) {
  const options = {};
  for (const argument of args) {
    const match = argument.match(/^--([a-z][a-z0-9-]*)=(.+)$/);
    if (!match || Object.hasOwn(options, match[1]))
      throw new Error(`invalid or duplicate option: ${argument}`);
    options[match[1]] = match[2];
  }
  return options;
}

function required(options, key) {
  const value = options[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`--${key} is required`);
  return value;
}

function requiredPath(options, key) {
  return path.resolve(required(options, key));
}

function positiveInteger(value, field) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1)
    throw new Error(`${field} must be a positive integer`);
  return numeric;
}

async function withEnvironment(env, callback) {
  const previous = {};
  for (const key of [
    "BUNDLE_ARTIFACT_ID",
    "BUNDLE_ARTIFACT_NAME",
    "BUNDLE_ARTIFACT_DIGEST",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "RECEIPT_ARTIFACT_ID",
    "RECEIPT_ARTIFACT_NAME",
    "RECEIPT_ARTIFACT_DIGEST",
  ]) {
    previous[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    process.exitCode = await runCommanderXpExternalSealCli(
      process.argv.slice(2),
    );
  } catch (error) {
    const body = {
      ok: false,
      code: error instanceof SealFailure ? error.code : "UNEXPECTED_ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
    process.stderr.write(`${JSON.stringify(body)}\n`);
    process.exitCode = 2;
  }
}
