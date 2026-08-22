import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildBundle,
  buildTreeDiffManifest,
  BUNDLE_MANIFEST_FILE,
  canonicalJson,
  createExternalPhaseLedger,
  createExternalReceipt,
  EXTERNAL_PHASE_LEDGER_FILE,
  EXTERNAL_RECEIPT_FILE,
  loadAndVerifySealRequest,
  safeRelativePath,
  safeSourcePath,
  scanPrivacyAndInventory,
  SEAL_REQUEST_FILE,
  SealFailure,
  sha256Bytes,
  sha256File,
  verifyArtifactMetadata,
  verifyBundle,
  verifyEvidenceBindings,
  verifyExternalPhaseLedger,
  verifyExternalReceipt,
} from "./commander-xp-external-seal-lib.mjs";

const execFileAsync = promisify(execFile);
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW = path.resolve(
  THIS_DIR,
  "../workflows/commander-xp-external-seal.yml",
);

test("path contracts separate evidence from protected .github source", () => {
  assert.equal(safeRelativePath("runs/canary/r00/A/xp-evidence.json"), true);
  assert.equal(safeRelativePath(".github/workflows/seal.yml"), false);
  assert.equal(safeSourcePath(".github/workflows/seal.yml"), true);
  assert.equal(safeSourcePath(".env"), false);
  assert.equal(safeSourcePath("../outside"), false);
  assert.equal(safeRelativePath("runs/../secret.json"), false);
});

test("workflow is manual, GitHub-hosted, full-SHA pinned, immutable, and attested", async () => {
  const workflow = await fs.readFile(WORKFLOW, "utf8");
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /\bpull_request\b|\bpush:\s*$/m);
  assert.doesNotMatch(workflow, /runs-on:\s*(?:self-hosted|\[.*self-hosted)/);
  assert.equal([...workflow.matchAll(/uses:\s*([^\s#]+)/g)].length, 15);
  for (const match of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
    assert.match(match[1], /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
  }
  assert.equal((workflow.match(/retention-days:\s*90/g) ?? []).length, 5);
  assert.equal((workflow.match(/overwrite:\s*false/g) ?? []).length, 5);
  assert.match(
    workflow,
    /artifact-ids:\s*\$\{\{ inputs\.evidence_artifact_id \}\}/,
  );
  assert.match(
    workflow,
    /artifact-ids:\s*\$\{\{ needs\.normalize\.outputs\.artifact_id \}\}/,
  );
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}/);
  assert.equal((workflow.match(/gh attestation verify/g) ?? []).length, 6);
  assert.equal((workflow.match(/--deny-self-hosted-runners/g) ?? []).length, 6);
  assert.equal((workflow.match(/--cert-identity/g) ?? []).length, 6);
  assert.equal(
    (workflow.match(/npm-ci-with-retry\.mjs --ignore-scripts/g) ?? []).length,
    2,
  );
  assert.equal(
    (workflow.match(/npm run --silent agent:commander:xp:verify/g) ?? [])
      .length,
    2,
  );
  assert.match(workflow, /\.canaryReceipt\.\$\{KIND\}Artifact\.id/);
  assert.match(workflow, /\.expired .* = "false"/);
  assert.match(workflow, /bound canary artifact is expired/);
  assert.match(workflow, /commander-xp-terminal-authority-index-v1\.json/);
  assert.match(
    workflow,
    /authorityArtifact:\{id:\$authorityArtifactID,digest:\$authorityArtifactDigest/,
  );
  assert.match(workflow, /test "\$GITHUB_ACTOR" = "0xNad"/);
  assert.equal(
    (workflow.match(/test "\$GITHUB_TRIGGERING_ACTOR" = "0xNad"/g) ?? [])
      .length,
    2,
  );
  assert.equal(
    (workflow.match(/branches\/main" --jq \.protected/g) ?? []).length,
    2,
  );
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(workflow, /test "\$GITHUB_SHA" = "\$SOURCE_SHA"/);
});

test("tree diff records exact blobs, modes, and content hashes", async (t) => {
  const fixture = await gitFixture(t);
  await fs.writeFile(path.join(fixture.root, "base.txt"), "head\n");
  await fs.mkdir(path.join(fixture.root, ".github", "scripts"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(fixture.root, ".github", "scripts", "seal.mjs"),
    "export const seal = true;\n",
  );
  await git(fixture.root, ["add", "."]);
  await git(fixture.root, ["commit", "-m", "seal"]);
  const headSha = await git(fixture.root, ["rev-parse", "HEAD"]);
  const source = {
    behaviorBaseSha: fixture.baseSha,
    behaviorBaseTreeSha: fixture.baseTreeSha,
    workflowSourceSha: headSha,
    workflowSourceTreeSha: await git(fixture.root, [
      "rev-parse",
      "HEAD^{tree}",
    ]),
    sourceAllowlist: [".github/scripts/seal.mjs", "base.txt"],
  };
  const manifest = await buildTreeDiffManifest({
    repository: fixture.root,
    source,
  });
  assert.deepEqual(
    manifest.entries.map((entry) => [entry.status, entry.path, entry.headMode]),
    [
      ["A", ".github/scripts/seal.mjs", "100644"],
      ["M", "base.txt", "100644"],
    ],
  );
  assert.equal(manifest.entries[0].baseBlob, null);
  assert.equal(
    manifest.entries[1].contentSha256,
    sha256Bytes(Buffer.from("head\n")),
  );
});

test("tree diff fails closed on dirty, out-of-allowlist, deletion, and symlink", async (t) => {
  const fixture = await gitFixture(t);
  await fs.writeFile(path.join(fixture.root, "allowed.txt"), "new\n");
  await git(fixture.root, ["add", "allowed.txt"]);
  await git(fixture.root, ["commit", "-m", "add"]);
  const source = await sourceIdentity(fixture, ["allowed.txt"]);

  await fs.writeFile(path.join(fixture.root, "dirty.txt"), "dirty\n");
  await assert.rejects(
    buildTreeDiffManifest({ repository: fixture.root, source }),
    hasCode("SOURCE_WORKTREE_DIRTY"),
  );
  await fs.unlink(path.join(fixture.root, "dirty.txt"));

  await assert.rejects(
    buildTreeDiffManifest({
      repository: fixture.root,
      source: { ...source, sourceAllowlist: ["base.txt"] },
    }),
    hasCode("SOURCE_DIFF_ALLOWLIST_MISMATCH"),
  );

  await fs.unlink(path.join(fixture.root, "base.txt"));
  await git(fixture.root, ["add", "-A"]);
  await git(fixture.root, ["commit", "-m", "delete"]);
  const deletedSource = await sourceIdentity(fixture, ["allowed.txt"]);
  await assert.rejects(
    buildTreeDiffManifest({ repository: fixture.root, source: deletedSource }),
    hasCode("SOURCE_DIFF_STATUS_FORBIDDEN"),
  );

  const symlinkFixture = await gitFixture(t);
  await fs.symlink("base.txt", path.join(symlinkFixture.root, "link.txt"));
  await git(symlinkFixture.root, ["add", "link.txt"]);
  await git(symlinkFixture.root, ["commit", "-m", "link"]);
  const symlinkSource = await sourceIdentity(symlinkFixture, ["link.txt"]);
  await assert.rejects(
    buildTreeDiffManifest({
      repository: symlinkFixture.root,
      source: symlinkSource,
    }),
    hasCode("SOURCE_DIFF_OBJECT_TYPE_FORBIDDEN"),
  );
});

test("privacy inventory rejects raw provider material, tokens, binary, and links", async (t) => {
  const root = await temporaryDirectory(t);
  const runRoot = path.join(root, "runs", "canary", "r00", "A");
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(
    path.join(runRoot, "game-evidence.jsonl"),
    '{"promptSha256":"abc"}\n',
  );
  await fs.writeFile(
    path.join(runRoot, "episode-results-raw.json"),
    '{"game_id":"game-1","winner_slot":0}\n',
  );
  await fs.writeFile(
    path.join(runRoot, "game-logs-raw.txt"),
    'COMMANDER_XP_GAME_EVIDENCE {"offeredIDs":["a"]}\n',
  );
  await fs.writeFile(
    path.join(runRoot, "command-receipts.json"),
    '{"schemaVersion":2,"coworldClient":"0.1.42","commands":[]}\n',
  );
  assert.equal((await scanPrivacyAndInventory(root)).fileCount, 4);

  await fs.writeFile(
    path.join(runRoot, "xp-evidence.json"),
    '{"rawPrompt":"private"}\n',
  );
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("PRIVACY_TEXT_FORBIDDEN"),
  );
  await fs.unlink(path.join(runRoot, "xp-evidence.json"));

  await fs.writeFile(
    path.join(runRoot, "game-logs-raw.txt"),
    "private messageText leaked\n",
  );
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("PRIVACY_TEXT_FORBIDDEN"),
  );
  await fs.writeFile(
    path.join(runRoot, "game-logs-raw.txt"),
    'COMMANDER_XP_GAME_EVIDENCE {"offeredIDs":["a"]}\n',
  );

  await fs.writeFile(
    path.join(root, "commander-xp-preregistration-v2.json"),
    '{"password":"nope","modelTranscript":"private"}\n',
  );
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("PRIVACY_KEY_FORBIDDEN"),
  );
  await fs.unlink(path.join(root, "commander-xp-preregistration-v2.json"));

  await fs.writeFile(
    path.join(runRoot, "replay-evidence.json"),
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\n",
  );
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("PRIVACY_VALUE_FORBIDDEN"),
  );
  await fs.unlink(path.join(runRoot, "replay-evidence.json"));

  await fs.writeFile(path.join(runRoot, "replay.json"), Buffer.from([0xff]));
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("EVIDENCE_UTF8_INVALID"),
  );
  await fs.unlink(path.join(runRoot, "replay.json"));

  await fs.symlink("game-evidence.jsonl", path.join(runRoot, "trace.jsonl"));
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("EVIDENCE_SYMLINK_FORBIDDEN"),
  );
});

test("end-to-end bundle and receipt bind exact source, evidence, artifact, and fail closed", async (t) => {
  const fixture = await gitFixture(t);
  await fs.writeFile(
    path.join(fixture.root, "commander.mjs"),
    "export const xp = 2;\n",
  );
  await git(fixture.root, ["add", "commander.mjs"]);
  await git(fixture.root, ["commit", "-m", "commander"]);
  const source = await sourceIdentity(fixture, ["commander.mjs"]);
  const evidenceRoot = await temporaryDirectory(t);
  const experimentID = "commander-xp-canary-test";
  const prereg = {
    schemaVersion: 2,
    experimentID,
    identities: {
      behaviorSourceSha: source.behaviorBaseSha,
      behaviorSourceTreeSha: source.behaviorBaseTreeSha,
      adapterSourceSha: source.workflowSourceSha,
      adapterSourceTreeSha: source.workflowSourceTreeSha,
    },
  };
  const index = {
    schemaVersion: 2,
    experimentID,
    phase: "canary",
    artifacts: [],
  };
  const localSeal = {
    schemaVersion: 2,
    experimentID,
    phase: "canary",
    status: "complete",
    sealSha256: "1".repeat(64),
  };
  const aggregate = {
    schemaVersion: 2,
    integrityVerified: true,
    experimentUsable: false,
    phase: "canary",
    performanceClaimAuthorized: false,
    authenticity: {
      verified: false,
      status: "external-seal-receipt-required",
      sealSha256: "1".repeat(64),
    },
  };
  for (const [name, value] of [
    ["commander-xp-preregistration-v2.json", prereg],
    ["commander-xp-evidence-index-v2.json", index],
    ["commander-xp-evidence-seal-v2.json", localSeal],
    ["commander-xp-local-verification-v2.json", aggregate],
  ]) {
    await fs.writeFile(path.join(evidenceRoot, name), canonicalJson(value));
  }
  const sourceArtifact = {
    artifactID: 111,
    artifactName: "commander-xp-evidence-222-1",
    artifactDigest: `sha256:${"a".repeat(64)}`,
    workflowRunID: 222,
    workflowRunAttempt: 1,
    workflowID: 999,
    workflowPath: ".github/workflows/commander-xp-evidence.yml",
    workflowName: "Commander XP protected experiment evidence",
    actor: "0xNad",
    headRepository: "0xNad/ProxyWar",
    event: "workflow_dispatch",
    ref: "refs/heads/main",
  };
  const sourceCI = {
    workflowID: 123,
    workflowPath: ".github/workflows/ci.yml",
    runID: 200,
    runAttempt: 1,
    headSha: source.workflowSourceSha,
  };
  const request = {
    schemaVersion: 1,
    experimentID,
    phase: "canary",
    sourceCI,
    sourceArtifact,
    source,
    evidence: {
      preRegistrationPath: "commander-xp-preregistration-v2.json",
      preRegistrationSha256: await sha256File(
        path.join(evidenceRoot, "commander-xp-preregistration-v2.json"),
      ),
      localIndexPath: "commander-xp-evidence-index-v2.json",
      localIndexSha256: await sha256File(
        path.join(evidenceRoot, "commander-xp-evidence-index-v2.json"),
      ),
      localSealPath: "commander-xp-evidence-seal-v2.json",
      localSealFileSha256: await sha256File(
        path.join(evidenceRoot, "commander-xp-evidence-seal-v2.json"),
      ),
      localSealSha256: "1".repeat(64),
      aggregatePath: "commander-xp-local-verification-v2.json",
      aggregateSha256: await sha256File(
        path.join(evidenceRoot, "commander-xp-local-verification-v2.json"),
      ),
    },
    canaryReceipt: null,
  };
  const authorityRoot = await temporaryDirectory(t);
  await fs.writeFile(
    path.join(authorityRoot, SEAL_REQUEST_FILE),
    canonicalJson(request),
  );
  const requestSha = await sha256File(
    path.join(authorityRoot, SEAL_REQUEST_FILE),
  );
  const supportRoot = await temporaryDirectory(t);
  const verifierAggregatePath = path.join(supportRoot, "rerun.json");
  await fs.writeFile(verifierAggregatePath, JSON.stringify(aggregate));
  const metadata = artifactMetadata(sourceArtifact, source.workflowSourceSha);
  await assert.rejects(
    verifyArtifactMetadata(
      artifactMetadata(sourceArtifact, source.workflowSourceSha, {
        status: "in_progress",
        conclusion: null,
      }),
      sourceArtifact,
    ),
    hasCode("ARTIFACT_METADATA_IDENTITY_MISMATCH"),
  );
  const metadataPath = path.join(supportRoot, "metadata.json");
  await fs.writeFile(metadataPath, canonicalJson(metadata));
  const sourceCIMetadataPath = path.join(supportRoot, "source-ci.json");
  await fs.writeFile(
    sourceCIMetadataPath,
    canonicalJson(sourceCIMetadata(sourceCI)),
  );

  const outputRoot = path.join(await temporaryDirectory(t), "bundle");
  await withProcessEnvironment(
    { GITHUB_RUN_ID: "333", GITHUB_RUN_ATTEMPT: "2" },
    () =>
      buildBundle({
        repository: fixture.root,
        evidenceRoot,
        sealRequestRoot: authorityRoot,
        outputRoot,
        expectedRequestSha256: requestSha,
        sourceArtifactMetadataPath: metadataPath,
        sourceCIMetadataPath,
        verifierAggregatePath,
        createdAt: "2026-08-22T14:00:00Z",
      }),
  );
  const manifest = await verifyBundle(outputRoot, {
    repository: fixture.root,
    sourceSha: source.workflowSourceSha,
    workflowRunID: 333,
    workflowRunAttempt: 2,
  });
  assert.equal(manifest.verifier.externalSealRequired, true);
  assert.equal(manifest.verifier.experimentUsable, false);
  assert.equal(manifest.files.length, 4);
  assert.ok(await fs.stat(path.join(outputRoot, BUNDLE_MANIFEST_FILE)));

  await fs.writeFile(
    path.join(
      outputRoot,
      "evidence",
      "commander-xp-local-verification-v2.json",
    ),
    '{"tampered":true}\n',
  );
  await assert.rejects(
    verifyBundle(outputRoot),
    hasCode("BUNDLE_FILE_HASH_MISMATCH"),
  );
  await fs.writeFile(
    path.join(
      outputRoot,
      "evidence",
      "commander-xp-local-verification-v2.json",
    ),
    canonicalJson(aggregate),
  );

  const bundleArtifact = {
    artifactID: 444,
    artifactName: "commander-xp-seal-canary-test",
    artifactDigest: `sha256:${"b".repeat(64)}`,
    workflowRunID: 333,
    workflowRunAttempt: 2,
  };
  const bundleMetadataPath = path.join(supportRoot, "bundle-metadata.json");
  await fs.writeFile(
    bundleMetadataPath,
    canonicalJson(
      artifactMetadata(bundleArtifact, source.workflowSourceSha, {
        status: "in_progress",
        conclusion: null,
      }),
    ),
  );
  const receiptPath = path.join(
    await temporaryDirectory(t),
    EXTERNAL_RECEIPT_FILE,
  );
  const sealedBundlePath = path.join(supportRoot, "sealed-bundle.tgz");
  await fs.writeFile(sealedBundlePath, "sealed bundle bytes\n");
  await withProcessEnvironment(
    {
      GITHUB_RUN_ID: "333",
      GITHUB_RUN_ATTEMPT: "2",
      BUNDLE_ARTIFACT_ID: "444",
      BUNDLE_ARTIFACT_NAME: bundleArtifact.artifactName,
      BUNDLE_ARTIFACT_DIGEST: bundleArtifact.artifactDigest,
    },
    () =>
      createExternalReceipt({
        bundleRoot: outputRoot,
        sealedBundlePath,
        outputPath: receiptPath,
        bundleArtifactMetadataPath: bundleMetadataPath,
        completedAt: "2026-08-22T14:30:00Z",
      }),
  );
  const receipt = await verifyExternalReceipt(receiptPath, {
    experimentID,
    phase: "canary",
  });
  assert.equal(receipt.bundleArtifact.artifactID, 444);
  assert.equal(receipt.performanceClaimAuthorized, false);

  const receiptArtifact = {
    artifactID: 445,
    artifactName: "commander-xp-seal-receipt-subject-canary-test-333-2",
    artifactDigest: `sha256:${"c".repeat(64)}`,
    workflowRunID: 333,
    workflowRunAttempt: 2,
  };
  const receiptMetadataPath = path.join(supportRoot, "receipt-metadata.json");
  await fs.writeFile(
    receiptMetadataPath,
    canonicalJson(
      artifactMetadata(receiptArtifact, source.workflowSourceSha, {
        status: "in_progress",
        conclusion: null,
      }),
    ),
  );
  const ledgerPath = path.join(supportRoot, EXTERNAL_PHASE_LEDGER_FILE);
  await withProcessEnvironment(
    {
      GITHUB_RUN_ID: "333",
      GITHUB_RUN_ATTEMPT: "2",
      RECEIPT_ARTIFACT_ID: "445",
      RECEIPT_ARTIFACT_NAME: receiptArtifact.artifactName,
      RECEIPT_ARTIFACT_DIGEST: receiptArtifact.artifactDigest,
    },
    () =>
      createExternalPhaseLedger({
        bundleRoot: outputRoot,
        receiptPath,
        receiptArtifactMetadataPath: receiptMetadataPath,
        outputPath: ledgerPath,
        completedAt: "2026-08-22T14:35:00Z",
      }),
  );
  const ledger = await verifyExternalPhaseLedger(ledgerPath, {
    phase: "canary",
    headSha: source.workflowSourceSha,
    treeSha: source.workflowSourceTreeSha,
  });
  assert.equal(ledger.experimentID, experimentID);
  assert.equal(ledger.behaviorBaseSha, source.behaviorBaseSha);
  assert.equal(ledger.evidenceArtifact.localSealSha256, "1".repeat(64));
  await assert.rejects(
    verifyExternalPhaseLedger(ledgerPath, { experimentID: "other-experiment" }),
    hasCode("EXTERNAL_PHASE_LEDGER_INVALID"),
  );

  const confirmRoot = await temporaryDirectory(t);
  const canaryBinding = {
    path: "commander-xp-prior-phase-ledger-v2.json",
    sha256: await sha256File(ledgerPath),
    ledgerSha256: ledger.ledgerSha256,
    runId: ledger.runId,
    attempt: ledger.attempt,
    evidenceArtifact: ledger.evidenceArtifact,
    receiptArtifact: ledger.receiptArtifact,
    localSealSha256: ledger.evidenceArtifact.localSealSha256,
    workflowPath: ledger.workflowPath,
    experimentID,
    behaviorBaseSha: source.behaviorBaseSha,
    behaviorBaseTreeSha: source.behaviorBaseTreeSha,
    headSha: source.workflowSourceSha,
    treeSha: source.workflowSourceTreeSha,
  };
  const confirmPrereg = structuredClone(prereg);
  const confirmIndex = {
    schemaVersion: 2,
    experimentID,
    phase: "confirmatory",
    canarySealSha256: ledger.evidenceArtifact.localSealSha256,
  };
  const confirmSeal = {
    schemaVersion: 2,
    experimentID,
    phase: "confirmatory",
    status: "complete",
    sealSha256: "2".repeat(64),
  };
  const confirmAggregate = {
    ...aggregate,
    phase: "confirmatory",
    authenticity: { ...aggregate.authenticity, sealSha256: "2".repeat(64) },
  };
  for (const [name, value] of [
    ["commander-xp-preregistration-v2.json", confirmPrereg],
    ["commander-xp-evidence-index-v2.json", confirmIndex],
    ["commander-xp-evidence-seal-v2.json", confirmSeal],
    ["commander-xp-local-verification-v2.json", confirmAggregate],
  ]) {
    await fs.writeFile(path.join(confirmRoot, name), canonicalJson(value));
  }
  await fs.copyFile(ledgerPath, path.join(confirmRoot, canaryBinding.path));
  const confirmRequest = {
    ...request,
    phase: "confirmatory",
    canaryReceipt: canaryBinding,
    evidence: {
      preRegistrationPath: "commander-xp-preregistration-v2.json",
      preRegistrationSha256: await sha256File(
        path.join(confirmRoot, "commander-xp-preregistration-v2.json"),
      ),
      localIndexPath: "commander-xp-evidence-index-v2.json",
      localIndexSha256: await sha256File(
        path.join(confirmRoot, "commander-xp-evidence-index-v2.json"),
      ),
      localSealPath: "commander-xp-evidence-seal-v2.json",
      localSealFileSha256: await sha256File(
        path.join(confirmRoot, "commander-xp-evidence-seal-v2.json"),
      ),
      localSealSha256: "2".repeat(64),
      aggregatePath: "commander-xp-local-verification-v2.json",
      aggregateSha256: await sha256File(
        path.join(confirmRoot, "commander-xp-local-verification-v2.json"),
      ),
    },
  };
  const confirmVerifierAggregate = await writeSupportJson(t, confirmAggregate);
  await verifyEvidenceBindings({
    evidenceRoot: confirmRoot,
    request: confirmRequest,
    verifierAggregatePath: confirmVerifierAggregate,
  });
  confirmIndex.canarySealSha256 = "9".repeat(64);
  await fs.writeFile(
    path.join(confirmRoot, "commander-xp-evidence-index-v2.json"),
    canonicalJson(confirmIndex),
  );
  confirmRequest.evidence.localIndexSha256 = await sha256File(
    path.join(confirmRoot, "commander-xp-evidence-index-v2.json"),
  );
  await assert.rejects(
    verifyEvidenceBindings({
      evidenceRoot: confirmRoot,
      request: confirmRequest,
      verifierAggregatePath: confirmVerifierAggregate,
    }),
    hasCode("CONFIRMATORY_CANARY_LOCAL_SEAL_MISMATCH"),
  );
});

test("seal request hash and exact schema reject substitution and extra fields", async (t) => {
  const root = await temporaryDirectory(t);
  const invalid = {
    schemaVersion: 1,
    experimentID: "x",
    phase: "canary",
    sourceArtifact: {},
    source: {},
    evidence: {},
    canaryReceipt: null,
    unexpected: true,
  };
  await fs.writeFile(
    path.join(root, SEAL_REQUEST_FILE),
    canonicalJson(invalid),
  );
  await assert.rejects(
    loadAndVerifySealRequest(root, "0".repeat(64)),
    hasCode("SEAL_REQUEST_HASH_MISMATCH"),
  );
  const actual = await sha256File(path.join(root, SEAL_REQUEST_FILE));
  await assert.rejects(
    loadAndVerifySealRequest(root, actual),
    hasCode("SEAL_REQUEST_SCHEMA_INVALID"),
  );
});

function artifactMetadata(
  binding,
  headSha,
  { status = "completed", conclusion = "success" } = {},
) {
  return {
    artifact: {
      id: binding.artifactID,
      name: binding.artifactName,
      digest: binding.artifactDigest,
      expired: false,
      created_at: "2026-08-22T14:00:00Z",
      expires_at: "2026-11-20T14:00:00Z",
      archive_download_url: "https://api.github.test/artifact.zip",
      workflow_run: {
        id: binding.workflowRunID,
        head_sha: headSha,
        head_repository_id: 77,
      },
    },
    workflowRun: {
      id: binding.workflowRunID,
      run_attempt: binding.workflowRunAttempt,
      status,
      conclusion,
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: headSha,
      workflow_id: binding.workflowID ?? 555,
      path:
        binding.workflowPath ??
        ".github/workflows/commander-xp-external-seal.yml",
      actor: { login: binding.actor ?? "0xNad" },
      head_repository: {
        id: 77,
        full_name: binding.headRepository ?? "0xNad/ProxyWar",
      },
    },
    repository: {
      full_name: "0xNad/ProxyWar",
      visibility: "public",
    },
  };
}

function sourceCIMetadata(binding) {
  return {
    id: binding.runID,
    run_attempt: binding.runAttempt,
    workflow_id: binding.workflowID,
    path: binding.workflowPath,
    head_sha: binding.headSha,
    head_repository: { full_name: "0xNad/ProxyWar" },
    repository: { full_name: "0xNad/ProxyWar" },
    actor: { login: "0xNad" },
    status: "completed",
    conclusion: "success",
    event: "push",
  };
}

async function gitFixture(t) {
  const root = await temporaryDirectory(t);
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "user.name", "Seal Test"]);
  await fs.writeFile(path.join(root, "base.txt"), "base\n");
  await git(root, ["add", "base.txt"]);
  await git(root, ["commit", "-m", "base"]);
  return {
    root,
    baseSha: await git(root, ["rev-parse", "HEAD"]),
    baseTreeSha: await git(root, ["rev-parse", "HEAD^{tree}"]),
  };
}

async function sourceIdentity(fixture, sourceAllowlist) {
  return {
    behaviorBaseSha: fixture.baseSha,
    behaviorBaseTreeSha: fixture.baseTreeSha,
    workflowSourceSha: await git(fixture.root, ["rev-parse", "HEAD"]),
    workflowSourceTreeSha: await git(fixture.root, [
      "rev-parse",
      "HEAD^{tree}",
    ]),
    sourceAllowlist: [...sourceAllowlist].sort(),
  };
}

async function temporaryDirectory(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "commander-xp-seal-test-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSupportJson(t, value) {
  const root = await temporaryDirectory(t);
  const filePath = path.join(root, "verification.json");
  await fs.writeFile(filePath, canonicalJson(value));
  return filePath;
}

async function git(root, args) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

function hasCode(code) {
  return (error) => error instanceof SealFailure && error.code === code;
}

async function withProcessEnvironment(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
