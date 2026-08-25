#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

import {
  assertMapResourceFixtures,
  assertMapRotationContract,
  assertTemplateRebuildsReplayViewer,
  extractSourceSha,
  stampManifest,
} from "./coworld-release-policy.mjs";

const MAP_CONTRACT_PATH =
  "coworld-adapter/commissioner/commissioners/ruleset_strategy_commissioner/configs/proxywar-map-rotation.json";

const [command, path] = process.argv.slice(2);
if (!command || !path)
  throw new Error("usage: coworld-manifest.mjs verify-template|stamp <path>");
const manifest = JSON.parse(readFileSync(path, "utf8"));
const mapContract = JSON.parse(readFileSync(MAP_CONTRACT_PATH, "utf8"));
const mapSummary = assertMapRotationContract(manifest, mapContract);
assertMapResourceFixtures(mapSummary);

if (command === "verify-template") {
  assertTemplateRebuildsReplayViewer(manifest);
  process.stdout.write(
    `Coworld template uses the canonical replay-viewer build hook and ${mapSummary.scheduledVariantIds.length} release-pinned map variants.\n`,
  );
} else if (command === "stamp") {
  const sourceSha = process.env.SOURCE_SHA;
  const stamped = stampManifest(manifest, sourceSha, {
    pr: process.env.PR_NUMBER,
    author: process.env.PR_AUTHOR,
    tested_head_sha: process.env.TESTED_HEAD_SHA,
    merge_sha: process.env.MERGE_SHA,
    batch_prs: process.env.BATCH_PRS,
    batch_queue_issues: process.env.BATCH_QUEUE_ISSUES,
    batch_merge_shas: process.env.BATCH_MERGE_SHAS,
    main_ci_run_id: process.env.MAIN_CI_RUN_ID,
  });
  writeFileSync(path, `${JSON.stringify(stamped, null, 2)}\n`);
  if (extractSourceSha(stamped) !== sourceSha)
    throw new Error("source provenance stamp did not round-trip");
  process.stdout.write(`Stamped Coworld provenance for ${sourceSha}.\n`);
} else {
  throw new Error(`unknown command: ${command}`);
}
