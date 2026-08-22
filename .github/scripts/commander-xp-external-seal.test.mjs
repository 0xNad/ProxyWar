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
  verifyPhaseReceiptBindingDocument,
  verifyRetainedPhaseAuthority,
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

test("workflow is completion-triggered, GitHub-hosted, full-SHA pinned, immutable, and attested", async () => {
  const workflow = await fs.readFile(WORKFLOW, "utf8");
  assert.match(workflow, /^on:\n {2}workflow_run:/m);
  assert.match(
    workflow,
    /workflows:\n\s+- Commander XP protected experiment evidence/,
  );
  assert.match(workflow, /types:\n\s+- completed/);
  assert.doesNotMatch(workflow, /\bpull_request\b|\bpush:\s*$/m);
  assert.doesNotMatch(workflow, /runs-on:\s*(?:self-hosted|\[.*self-hosted)/);
  assert.equal([...workflow.matchAll(/uses:\s*([^\s#]+)/g)].length, 20);
  for (const match of workflow.matchAll(/uses:\s*([^\s#]+)/g)) {
    assert.match(match[1], /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/);
  }
  assert.equal((workflow.match(/retention-days:\s*90/g) ?? []).length, 6);
  assert.equal((workflow.match(/overwrite:\s*false/g) ?? []).length, 6);
  assert.match(
    workflow,
    /artifact-ids:\s*\$\{\{ steps\.resolve\.outputs\.evidence_artifact_id \}\}/,
  );
  assert.match(
    workflow,
    /artifact-ids:\s*\$\{\{ steps\.resolve\.outputs\.authority_artifact_id \}\}/,
  );
  assert.match(
    workflow,
    /artifact-ids:\s*\$\{\{ steps\.resolve\.outputs\.handoff_artifact_id \}\}/,
  );
  assert.match(
    workflow,
    /path:\s*\$\{\{ runner\.temp \}\}\/commander-xp-envelope\/evidence/,
  );
  assert.match(
    workflow,
    /path:\s*\$\{\{ runner\.temp \}\}\/commander-xp-envelope\/authority/,
  );
  assert.match(
    workflow,
    /--authority-request \\\n\s+"\$RUNNER_TEMP\/commander-xp-envelope\/authority\/commander-xp-external-seal-request-v1\.json"/,
  );
  assert.match(
    workflow,
    /artifact-ids:\s*\$\{\{ needs\.normalize\.outputs\.artifact_id \}\}/,
  );
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}/);
  assert.equal((workflow.match(/gh attestation verify/g) ?? []).length, 9);
  assert.equal((workflow.match(/--deny-self-hosted-runners/g) ?? []).length, 9);
  assert.equal((workflow.match(/--cert-identity/g) ?? []).length, 9);
  assert.equal(
    (workflow.match(/--source-ref "refs\/heads\/main"/g) ?? []).length,
    9,
  );
  assert.equal(
    (workflow.match(/--source-digest "\$WORKFLOW_AUTHORIZATION_SHA"/g) ?? [])
      .length,
    7,
  );
  assert.equal(
    (workflow.match(/--signer-digest "\$WORKFLOW_AUTHORIZATION_SHA"/g) ?? [])
      .length,
    7,
  );
  assert.equal(
    (
      workflow.match(/--source-digest "\$PRIOR_WORKFLOW_AUTHORIZATION_SHA"/g) ??
      []
    ).length,
    2,
  );
  assert.equal(
    (
      workflow.match(/--signer-digest "\$PRIOR_WORKFLOW_AUTHORIZATION_SHA"/g) ??
      []
    ).length,
    2,
  );
  assert.equal(
    (workflow.match(/commander-xp-external-workflow-authorization\.mjs/g) ?? [])
      .length,
    2,
  );
  assert.match(workflow, /environment: coworld-production/);
  assert.match(workflow, /coworld==0\.1\.42/);
  assert.match(workflow, /version: "0\.8\.12"/);
  assert.match(workflow, /test "\$\(uv --version\)" = "uv 0\.8\.12"/);
  assert.match(workflow, /agent:commander:xp:external-refetch/);
  assert.match(workflow, /commander-xp-independent-platform-refetch-v2\.json/);
  assert.equal(
    (workflow.match(/npm-ci-with-retry\.mjs --ignore-scripts/g) ?? []).length,
    2,
  );
  assert.equal(
    (workflow.match(/npm run --silent agent:commander:xp:verify/g) ?? [])
      .length,
    2,
  );
  assert.match(workflow, /PRIOR_KEYS=\(preregistrationReceipt\)/);
  assert.match(
    workflow,
    /PRIOR_KEYS=\(preregistrationReceipt providerPreflightReceipt\)/,
  );
  assert.match(
    workflow,
    /PRIOR_KEYS=\(preregistrationReceipt providerPreflightReceipt canaryReceipt\)/,
  );
  assert.match(workflow, /\.\$\{PRIOR_KEY\}\.\$\{KIND\}Artifact\.id/);
  assert.match(
    workflow,
    /for KIND in evidence receipt ledger authority terminal/,
  );
  assert.match(workflow, /actions\/artifacts\/\$ARTIFACT_ID\/zip/);
  assert.match(workflow, /verify-prior-authority/);
  assert.match(
    workflow,
    /actions\/runs\/\$PRIOR_RUN_ID\/attempts\/\$PRIOR_ATTEMPT/,
  );
  assert.match(workflow, /\.expired .* = "false"/);
  assert.match(workflow, /bound prior artifact is expired/);
  assert.match(workflow, /commander-xp-terminal-authority-envelope-v2\.json/);
  assert.match(
    workflow,
    /confirmatoryAnalysis:\$ledger\[0\]\.confirmatoryAnalysis/,
  );
  assert.match(
    workflow,
    /confirmatoryAnalysis:\$receipt\[0\]\.confirmatoryAnalysis/,
  );
  assert.match(
    workflow,
    /performanceClaimAuthorized:\$ledger\[0\]\.performanceClaimAuthorized/,
  );
  assert.match(
    workflow,
    /performanceClaimAuthorized:\$receipt\[0\]\.performanceClaimAuthorized/,
  );
  assert.match(workflow, /envelopeSha256:\$envelopeSha256/);
  assert.equal((workflow.match(/check_artifact '/g) ?? []).length, 3);
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
  assert.doesNotMatch(workflow, /branches\/main" --jq \.protected/);
  assert.match(workflow, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.equal(
    (
      workflow.match(/test "\$GITHUB_SHA" = "\$WORKFLOW_AUTHORIZATION_SHA"/g) ??
      []
    ).length,
    2,
  );
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

test("privacy inventory seals exact Coworld projections and rejects raw bytes, private material, binary, and links", async (t) => {
  const root = await temporaryDirectory(t);
  const runRoot = path.join(root, "runs", "canary", "r00", "A");
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(
    path.join(runRoot, "game-evidence.jsonl"),
    '{"promptSha256":"abc","rawProviderOutputRecordCount":1204}\n',
  );
  await fs.writeFile(
    path.join(runRoot, "episode-results.json"),
    '{"gameID":"game-1","seed":42,"winner_slot":0}\n',
  );
  await fs.writeFile(
    path.join(runRoot, "xp-evidence.json"),
    '{"xpRequestID":"xreq_11111111-1111-4111-8111-111111111111","episodeRequestID":"ereq_22222222-2222-4222-8222-222222222222","jobID":"33333333-3333-4333-8333-333333333333","episodeID":"44444444-4444-4444-8444-444444444444","coworldID":"cow_eval-1","coworldVersion":"0.1.0","variantID":"tournament-4p-pangaea","gameConfig":{"seed":42}}\n',
  );
  await fs.writeFile(
    path.join(runRoot, "replay-evidence.json"),
    '{"xpRequestID":"xreq_11111111-1111-4111-8111-111111111111","episodeRequestID":"ereq_22222222-2222-4222-8222-222222222222","jobID":"33333333-3333-4333-8333-333333333333","episodeID":"44444444-4444-4444-8444-444444444444","matchID":"game-1","config":{"seed":42},"contentSha256":"d22465aa50b7fedb9ed1f4a664e7c39b81ea1c129fed3410dfbfb33a3d242a93"}\n',
  );
  await fs.writeFile(
    path.join(runRoot, "command-receipts.json"),
    '{"schemaVersion":2,"coworldClient":"0.1.42","commands":[]}\n',
  );
  await writeCoworldBundleReceipt(runRoot);

  const receiptPath = path.join(runRoot, "coworld-bundle-receipt.json");
  const wrongReplayMember = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  wrongReplayMember.members[0].sha256 =
    "d22465aa50b7fedb9ed1f4a664e7c39b81ea1c129fed3410dfbfb33a3d242a93";
  wrongReplayMember.members[2].sha256 = "7".repeat(64);
  await fs.writeFile(receiptPath, canonicalJson(wrongReplayMember));
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("COWORLD_REPLAY_MEMBER_HASH_MISMATCH"),
  );
  await writeCoworldBundleReceipt(runRoot);

  const wrongManifestMember = JSON.parse(
    await fs.readFile(receiptPath, "utf8"),
  );
  wrongManifestMember.manifestSha256 = "4".repeat(64);
  await fs.writeFile(receiptPath, canonicalJson(wrongManifestMember));
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("COWORLD_BUNDLE_MANIFEST_HASH_MISMATCH"),
  );
  await writeCoworldBundleReceipt(runRoot);

  const preflightRoot = path.join(
    root,
    "runs",
    "provider-preflight",
    "r00",
    "C",
  );
  await fs.mkdir(preflightRoot, { recursive: true });
  for (const name of [
    "xp-evidence.json",
    "replay-evidence.json",
    "command-receipts.json",
  ]) {
    await fs.copyFile(path.join(runRoot, name), path.join(preflightRoot, name));
  }
  await writeCoworldBundleReceipt(preflightRoot);
  const preflightInventory = await scanPrivacyAndInventory(root);
  assert.equal(
    preflightInventory.files.some((entry) =>
      entry.path.endsWith("provider-preflight/r00/C/episode-results.json"),
    ),
    false,
  );
  assert.equal((await scanPrivacyAndInventory(root)).fileCount, 10);

  const mismatchedReceipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  mismatchedReceipt.seed = 43;
  await fs.writeFile(receiptPath, canonicalJson(mismatchedReceipt));
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("COWORLD_BUNDLE_IDENTITY_JOIN_MISMATCH"),
  );
  await writeCoworldBundleReceipt(runRoot);

  await fs.writeFile(path.join(runRoot, "game-logs-raw.txt"), "private\n");
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("EVIDENCE_PATH_NOT_IN_PROTOCOL_ALLOWLIST"),
  );
  await fs.unlink(path.join(runRoot, "game-logs-raw.txt"));

  await fs.writeFile(
    path.join(runRoot, "episode-results-raw.json"),
    '{"game_id":"game-1"}\n',
  );
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("EVIDENCE_PATH_NOT_IN_PROTOCOL_ALLOWLIST"),
  );
  await fs.unlink(path.join(runRoot, "episode-results-raw.json"));

  const validXp = await fs.readFile(
    path.join(runRoot, "xp-evidence.json"),
    "utf8",
  );
  await fs.writeFile(
    path.join(runRoot, "xp-evidence.json"),
    '{"rawPrompt":"private"}\n',
  );
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("PRIVACY_TEXT_FORBIDDEN"),
  );
  await fs.writeFile(path.join(runRoot, "xp-evidence.json"), validXp);

  for (const forbiddenText of ["rawPrompt", "presigned"]) {
    await fs.writeFile(
      path.join(runRoot, "xp-evidence.json"),
      `${JSON.stringify({ note: `public-looking ${forbiddenText} body` })}\n`,
    );
    await assert.rejects(
      scanPrivacyAndInventory(root),
      hasCode("PRIVACY_TEXT_FORBIDDEN"),
    );
  }
  await fs.writeFile(path.join(runRoot, "xp-evidence.json"), validXp);

  await fs.writeFile(
    path.join(runRoot, "xp-evidence.json"),
    '{"COWORLD_PLAYER_ARTIFACT_UPLOAD_URL":"https://example.invalid/upload"}\n',
  );
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("PRIVACY_TEXT_FORBIDDEN"),
  );
  await fs.writeFile(path.join(runRoot, "xp-evidence.json"), validXp);

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
    path.join(root, "commander-xp-preregistration-v2.json"),
    `${JSON.stringify({
      privacyContract: {
        promptBodiesRetained: true,
        providerBodiesRetained: false,
        inboundCommsBodiesRetained: false,
        outboundCommsBodiesRetained: false,
        uploadUrlsRetained: false,
        environmentValuesRetained: false,
        promptAndOutputHashesOnly: true,
      },
    })}\n`,
  );
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("PRIVACY_CONTRACT_INVALID"),
  );
  await fs.unlink(path.join(root, "commander-xp-preregistration-v2.json"));

  const validReplay = await fs.readFile(
    path.join(runRoot, "replay-evidence.json"),
    "utf8",
  );
  await fs.writeFile(
    path.join(runRoot, "replay-evidence.json"),
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\n",
  );
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("PRIVACY_VALUE_FORBIDDEN"),
  );
  await fs.writeFile(path.join(runRoot, "replay-evidence.json"), validReplay);

  await fs.writeFile(
    path.join(runRoot, "replay.json"),
    '{"notes":"private"}\n',
  );
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("EVIDENCE_PATH_NOT_IN_PROTOCOL_ALLOWLIST"),
  );
  await fs.unlink(path.join(runRoot, "replay.json"));

  const receipt = JSON.parse(
    await fs.readFile(
      path.join(runRoot, "coworld-bundle-receipt.json"),
      "utf8",
    ),
  );
  receipt.projections.gameEvidenceSha256 = "9".repeat(64);
  await fs.writeFile(
    path.join(runRoot, "coworld-bundle-receipt.json"),
    canonicalJson(receipt),
  );
  await assert.rejects(
    scanPrivacyAndInventory(root),
    hasCode("COWORLD_BUNDLE_PROJECTION_HASH_MISMATCH"),
  );
  await writeCoworldBundleReceipt(runRoot);

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
  const workflowAuthorizationSha = "9".repeat(40);
  const evidenceRoot = await temporaryDirectory(t);
  const experimentID = "commander-xp-canary-test";
  const prereg = {
    schemaVersion: 2,
    experimentID,
    createdAt: "2026-08-22T13:00:00Z",
    identities: {
      behaviorSourceSha: source.behaviorBaseSha,
      behaviorSourceTreeSha: source.behaviorBaseTreeSha,
      adapterSourceSha: source.workflowSourceSha,
      adapterSourceTreeSha: source.workflowSourceTreeSha,
    },
    privacyContract: {
      promptBodiesRetained: false,
      providerBodiesRetained: false,
      inboundCommsBodiesRetained: false,
      outboundCommsBodiesRetained: false,
      uploadUrlsRetained: false,
      environmentValuesRetained: false,
      promptAndOutputHashesOnly: true,
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
    verifiedRunCount: 12,
    completePairCount: 0,
    diagnostics: [
      { code: "EXTERNAL_IMMUTABLE_SEAL_RECEIPT_REQUIRED", path: null },
    ],
    performanceClaimAuthorized: false,
    providerProvenance: {
      commanderPromptVersion: "strategic-commander-v0-stage2",
      commanderPromptVersionSha256:
        "00db34a7939d9d27a3370decf1e3f3f5895b0a3e3676c2e043ec426b5e199094",
      providerContractSha256:
        "6927ba56e53fb71300e708379b59b71b38c54b1656da826e2a786b9505fccaf4",
    },
    confirmatoryAnalysis: null,
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
    triggeringActor: "0xNad",
    headRepository: "0xNad/ProxyWar",
    event: "workflow_dispatch",
    ref: "refs/heads/main",
    headSha: source.workflowSourceSha,
  };
  const sourceCI = {
    workflowID: 123,
    workflowPath: ".github/workflows/ci.yml",
    runID: 200,
    runAttempt: 1,
    headSha: source.workflowSourceSha,
    actor: "0xNad",
    triggeringActor: "0xNad",
    headRepository: "0xNad/ProxyWar",
    event: "push",
    ref: "refs/heads/main",
  };
  const preregLedgerPath = path.join(
    evidenceRoot,
    "commander-xp-prereg-ledger-v2.json",
  );
  const preregLedger = externalLedgerFixture({
    experimentID,
    phase: "preregistration",
    source,
    sourceArtifact,
    completedAt: "2026-08-22T13:30:00Z",
    localSealSha256: "0".repeat(64),
    preRegistrationSha256: (
      await sha256File(
        path.join(evidenceRoot, "commander-xp-preregistration-v2.json"),
      )
    ).slice(7),
  });
  await fs.writeFile(preregLedgerPath, canonicalJson(preregLedger));
  const preregistrationReceipt = phaseReceiptBinding(
    preregLedger,
    "commander-xp-prereg-ledger-v2.json",
    await sha256File(preregLedgerPath),
  );
  const providerLedgerPath = path.join(
    evidenceRoot,
    "commander-xp-provider-preflight-ledger-v2.json",
  );
  const providerLedger = externalLedgerFixture({
    experimentID,
    phase: "provider-preflight",
    source,
    sourceArtifact,
    completedAt: "2026-08-22T13:40:00Z",
    localSealSha256: "8".repeat(64),
    preRegistrationSha256: preregLedger.preRegistrationSha256,
    preregistrationReceipt,
    namespaceRegistry: namespaceRegistryFixture(
      preregLedger.namespaceRegistry.registrySha256,
    ),
  });
  await fs.writeFile(providerLedgerPath, canonicalJson(providerLedger));
  const providerPreflightReceipt = phaseReceiptBinding(
    providerLedger,
    "commander-xp-provider-preflight-ledger-v2.json",
    await sha256File(providerLedgerPath),
  );
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
    },
    preregistrationReceipt,
    providerPreflightReceipt,
    priorPhaseReceipt: providerPreflightReceipt,
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
  const missingProviderRoot = await temporaryDirectory(t);
  const missingProvider = { ...request, providerPreflightReceipt: null };
  await fs.writeFile(
    path.join(missingProviderRoot, SEAL_REQUEST_FILE),
    canonicalJson(missingProvider),
  );
  await assert.rejects(
    loadAndVerifySealRequest(
      missingProviderRoot,
      await sha256File(path.join(missingProviderRoot, SEAL_REQUEST_FILE)),
    ),
    hasCode("PHASE_RECEIPT_BINDING_INVALID"),
  );
  const missingImmediatePriorRoot = await temporaryDirectory(t);
  await fs.writeFile(
    path.join(missingImmediatePriorRoot, SEAL_REQUEST_FILE),
    canonicalJson({ ...request, priorPhaseReceipt: null }),
  );
  await assert.rejects(
    loadAndVerifySealRequest(
      missingImmediatePriorRoot,
      await sha256File(path.join(missingImmediatePriorRoot, SEAL_REQUEST_FILE)),
    ),
    hasCode("PHASE_RECEIPT_BINDING_INVALID"),
  );
  const supportRoot = await temporaryDirectory(t);
  const verifierAggregatePath = path.join(supportRoot, "rerun.json");
  await fs.writeFile(verifierAggregatePath, JSON.stringify(aggregate));
  await verifyEvidenceBindings({
    evidenceRoot,
    request,
    verifierAggregatePath,
  });
  const privateAggregatePath = path.join(supportRoot, "private-aggregate.json");
  await fs.writeFile(
    privateAggregatePath,
    JSON.stringify({
      ...aggregate,
      renamedEnvelope: {
        password: "private",
        modelTranscript: "provider prose",
      },
    }),
  );
  await assert.rejects(
    verifyEvidenceBindings({
      evidenceRoot,
      request,
      verifierAggregatePath: privateAggregatePath,
    }),
    hasCode("PRIVACY_KEY_FORBIDDEN"),
  );
  const substitutedProviderProvenancePath = path.join(
    supportRoot,
    "substituted-provider-provenance.json",
  );
  await fs.writeFile(
    substitutedProviderProvenancePath,
    JSON.stringify({
      ...aggregate,
      providerProvenance: {
        ...aggregate.providerProvenance,
        commanderPromptVersionSha256: "f".repeat(64),
      },
    }),
  );
  await assert.rejects(
    verifyEvidenceBindings({
      evidenceRoot,
      request,
      verifierAggregatePath: substitutedProviderProvenancePath,
    }),
    hasCode("VERIFIER_AGGREGATE_PROVIDER_PROVENANCE_INVALID"),
  );
  for (const encodedPath of [
    '{"password":"private"}',
    '{"modelTranscript":"provider prose"}',
  ]) {
    const encodedAggregatePath = path.join(
      supportRoot,
      `encoded-${sha256Bytes(Buffer.from(encodedPath)).slice(-8)}.json`,
    );
    await fs.writeFile(
      encodedAggregatePath,
      JSON.stringify({
        ...aggregate,
        diagnostics: [{ code: "PRIVATE_ENVELOPE", path: encodedPath }],
      }),
    );
    await assert.rejects(
      verifyEvidenceBindings({
        evidenceRoot,
        request,
        verifierAggregatePath: encodedAggregatePath,
      }),
      hasCode("INLINE_NESTED_JSON_ENVELOPE_FORBIDDEN"),
    );
  }
  const earlyPreregLedger = externalLedgerFixture({
    experimentID,
    phase: "preregistration",
    source,
    sourceArtifact,
    completedAt: "2026-08-22T12:59:59Z",
    localSealSha256: "0".repeat(64),
    preRegistrationSha256: request.evidence.preRegistrationSha256.slice(7),
  });
  await fs.writeFile(preregLedgerPath, canonicalJson(earlyPreregLedger));
  request.preregistrationReceipt = phaseReceiptBinding(
    earlyPreregLedger,
    "commander-xp-prereg-ledger-v2.json",
    await sha256File(preregLedgerPath),
  );
  await assert.rejects(
    verifyEvidenceBindings({ evidenceRoot, request, verifierAggregatePath }),
    hasCode("PREREGISTRATION_LEDGER_CHRONOLOGY_INVALID"),
  );
  await fs.writeFile(preregLedgerPath, canonicalJson(preregLedger));
  request.preregistrationReceipt = preregistrationReceipt;

  const preregEvidenceRoot = await temporaryDirectory(t);
  const preregIndex = { ...index, phase: "preregistration", artifacts: [] };
  const preregSeal = { ...localSeal, phase: "preregistration" };
  const preregAggregate = {
    ...aggregate,
    phase: "preregistration",
  };
  for (const [name, value] of [
    ["commander-xp-preregistration-v2.json", prereg],
    ["commander-xp-evidence-index-v2.json", preregIndex],
    ["commander-xp-evidence-seal-v2.json", preregSeal],
  ]) {
    await fs.writeFile(
      path.join(preregEvidenceRoot, name),
      canonicalJson(value),
    );
  }
  const preregRequest = {
    ...request,
    phase: "preregistration",
    preregistrationReceipt: null,
    providerPreflightReceipt: null,
    priorPhaseReceipt: null,
    canaryReceipt: null,
    evidence: {
      preRegistrationPath: "commander-xp-preregistration-v2.json",
      preRegistrationSha256: await sha256File(
        path.join(preregEvidenceRoot, "commander-xp-preregistration-v2.json"),
      ),
      localIndexPath: "commander-xp-evidence-index-v2.json",
      localIndexSha256: await sha256File(
        path.join(preregEvidenceRoot, "commander-xp-evidence-index-v2.json"),
      ),
      localSealPath: "commander-xp-evidence-seal-v2.json",
      localSealFileSha256: await sha256File(
        path.join(preregEvidenceRoot, "commander-xp-evidence-seal-v2.json"),
      ),
      localSealSha256: preregSeal.sealSha256,
    },
  };
  const preregVerifierAggregate = await writeSupportJson(t, preregAggregate);
  const preregAuthorityRoot = await temporaryDirectory(t);
  await fs.writeFile(
    path.join(preregAuthorityRoot, SEAL_REQUEST_FILE),
    canonicalJson(preregRequest),
  );
  const loadedPrereg = await loadAndVerifySealRequest(
    preregAuthorityRoot,
    await sha256File(path.join(preregAuthorityRoot, SEAL_REQUEST_FILE)),
  );
  assert.equal(loadedPrereg.request.phase, "preregistration");
  await verifyEvidenceBindings({
    evidenceRoot: preregEvidenceRoot,
    request: preregRequest,
    verifierAggregatePath: preregVerifierAggregate,
  });
  preregIndex.artifacts.push({ path: "runs/canary/r00/A/xp-evidence.json" });
  await fs.writeFile(
    path.join(preregEvidenceRoot, "commander-xp-evidence-index-v2.json"),
    canonicalJson(preregIndex),
  );
  preregRequest.evidence.localIndexSha256 = await sha256File(
    path.join(preregEvidenceRoot, "commander-xp-evidence-index-v2.json"),
  );
  await assert.rejects(
    verifyEvidenceBindings({
      evidenceRoot: preregEvidenceRoot,
      request: preregRequest,
      verifierAggregatePath: preregVerifierAggregate,
    }),
    hasCode("PREREGISTRATION_RUN_EVIDENCE_FORBIDDEN"),
  );
  preregIndex.artifacts = [];
  await fs.writeFile(
    path.join(preregEvidenceRoot, "commander-xp-evidence-index-v2.json"),
    canonicalJson(preregIndex),
  );
  preregRequest.evidence.localIndexSha256 = await sha256File(
    path.join(preregEvidenceRoot, "commander-xp-evidence-index-v2.json"),
  );
  const hiddenRun = path.join(preregEvidenceRoot, "runs", "canary", "r00", "A");
  await fs.mkdir(hiddenRun, { recursive: true });
  await fs.writeFile(path.join(hiddenRun, "xp-evidence.json"), "{}\n");
  await assert.rejects(
    verifyEvidenceBindings({
      evidenceRoot: preregEvidenceRoot,
      request: preregRequest,
      verifierAggregatePath: preregVerifierAggregate,
    }),
    hasCode("PREREGISTRATION_RUN_EVIDENCE_FORBIDDEN"),
  );
  const metadata = artifactMetadata(sourceArtifact, source.workflowSourceSha);
  const wrongTriggeringActor = structuredClone(metadata);
  wrongTriggeringActor.workflowRun.triggering_actor.login = "collaborator";
  await assert.rejects(
    verifyArtifactMetadata(wrongTriggeringActor, sourceArtifact),
    hasCode("ARTIFACT_METADATA_IDENTITY_MISMATCH"),
  );
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
        workflowAuthorizationSha,
        createdAt: "2026-08-22T14:00:00Z",
      }),
  );
  const manifest = await verifyBundle(outputRoot, {
    repository: fixture.root,
    sourceSha: source.workflowSourceSha,
    workflowAuthorizationSha,
    workflowRunID: 333,
    workflowRunAttempt: 2,
  });
  assert.equal(manifest.verifier.externalSealRequired, true);
  assert.equal(manifest.verifier.experimentUsable, false);
  assert.equal(manifest.files.length, 5);
  assert.ok(await fs.stat(path.join(outputRoot, BUNDLE_MANIFEST_FILE)));
  assert.equal("aggregatePath" in request.evidence, false);
  assert.equal("aggregateSha256" in request.evidence, false);

  const divergentRerunPath = path.join(supportRoot, "divergent-rerun.json");
  await fs.writeFile(
    divergentRerunPath,
    JSON.stringify({ ...aggregate, completePairCount: 1 }),
  );
  await assert.rejects(
    verifyEvidenceBindings({
      evidenceRoot,
      request,
      verifierAggregatePath: divergentRerunPath,
      boundVerifierAggregatePath: path.join(
        outputRoot,
        "authority",
        "commander-xp-verifier-aggregate-v2.json",
      ),
    }),
    hasCode("VERIFIER_AGGREGATE_RERUN_MISMATCH"),
  );

  const sealedAggregatePath = path.join(
    outputRoot,
    "authority",
    "commander-xp-verifier-aggregate-v2.json",
  );
  const sealedAggregateBytes = await fs.readFile(sealedAggregatePath);
  await fs.writeFile(sealedAggregatePath, JSON.stringify(aggregate, null, 2));
  await assert.rejects(
    verifyBundle(outputRoot),
    hasCode("BUNDLE_VERIFIER_AGGREGATE_HASH_MISMATCH"),
  );
  await fs.writeFile(sealedAggregatePath, sealedAggregateBytes);

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
      artifactMetadata(bundleArtifact, workflowAuthorizationSha, {
        status: "in_progress",
        conclusion: null,
        event: "workflow_run",
      }),
    ),
  );
  const receiptPath = path.join(
    await temporaryDirectory(t),
    EXTERNAL_RECEIPT_FILE,
  );
  const sealedBundlePath = path.join(supportRoot, "sealed-bundle.tgz");
  await fs.writeFile(sealedBundlePath, "sealed bundle bytes\n");
  const refetchBody = {
    schemaVersion: 2,
    authority: "independent-coworld-0.1.42-refetch-v2",
    experimentID,
    phase: "canary",
    preRegistrationSha256: manifest.evidence.preRegistrationSha256,
    verifiedAt: "2026-08-22T14:29:00Z",
    runCount: 12,
    runs: Array.from({ length: 4 }, (_, replicaIndex) =>
      ["A", "B", "C"].map((arm) => ({
        runPath: `runs/canary/r${String(replicaIndex).padStart(2, "0")}/${arm}`,
        xpRequestID: `xreq_${replicaIndex}${arm}`,
        episodeRequestID: `ereq_${replicaIndex}${arm}`,
        memberSetSha256: "1".repeat(64),
        xpEvidenceSha256: "2".repeat(64),
        normalizedReadbackSha256: "3".repeat(64),
        replayEvidenceSha256: "4".repeat(64),
        episodeResultsSha256: "5".repeat(64),
        gameEvidenceSha256: "6".repeat(64),
        playerArtifactSha256: "7".repeat(64),
      })),
    ).flat(),
  };
  const platformRefetchPath = path.join(
    supportRoot,
    "commander-xp-independent-platform-refetch-v2.json",
  );
  await fs.writeFile(
    platformRefetchPath,
    canonicalJson({
      ...refetchBody,
      refetchSha256: sha256Bytes(Buffer.from(canonicalJson(refetchBody))).slice(
        7,
      ),
    }),
  );
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
        platformRefetchPath,
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
  assert.equal(receipt.workflow.authorizationSha, workflowAuthorizationSha);
  assert.equal(
    receipt.evidence.platformRefetchSha256,
    await sha256File(platformRefetchPath),
  );
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
      artifactMetadata(receiptArtifact, workflowAuthorizationSha, {
        status: "in_progress",
        conclusion: null,
        event: "workflow_run",
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
  assert.equal(ledger.signerSourceSha, workflowAuthorizationSha);
  assert.equal(ledger.behaviorBaseSha, source.behaviorBaseSha);
  assert.equal(ledger.evidenceArtifact.localSealSha256, "1".repeat(64));
  assert.equal(
    ledger.evidenceArtifact.platformRefetchSha256,
    (await sha256File(platformRefetchPath)).slice(7),
  );
  await assert.rejects(
    verifyExternalPhaseLedger(ledgerPath, { experimentID: "other-experiment" }),
    hasCode("EXTERNAL_PHASE_LEDGER_INVALID"),
  );

  const confirmRoot = await temporaryDirectory(t);
  const canaryBinding = phaseReceiptBinding(
    ledger,
    "commander-xp-canary-ledger-v2.json",
    await sha256File(ledgerPath),
  );
  const retained = await retainedAuthorityFixture(
    await temporaryDirectory(t),
    ledgerPath,
    ledger,
    canaryBinding,
  );
  assert.equal(
    verifyPhaseReceiptBindingDocument(retained.binding, "canary").phase,
    "canary",
  );
  await verifyRetainedPhaseAuthority({
    ledgerPath: retained.ledgerPath,
    authorityReceiptPath: retained.authorityPath,
    terminalEnvelopePath: retained.terminalPath,
    binding: retained.binding,
    phase: "canary",
  });
  const collapsedBinding = structuredClone(retained.binding);
  collapsedBinding.authorityArtifact.id = collapsedBinding.ledgerArtifact.id;
  collapsedBinding.authorityArtifact.digest =
    collapsedBinding.ledgerArtifact.digest;
  collapsedBinding.authorityArtifact.attestationID =
    collapsedBinding.ledgerArtifact.attestationID;
  collapsedBinding.terminalArtifact.id = collapsedBinding.ledgerArtifact.id;
  collapsedBinding.terminalArtifact.digest =
    collapsedBinding.ledgerArtifact.digest;
  await assert.rejects(
    verifyRetainedPhaseAuthority({
      ledgerPath: retained.ledgerPath,
      authorityReceiptPath: retained.authorityPath,
      terminalEnvelopePath: retained.terminalPath,
      binding: collapsedBinding,
      phase: "canary",
    }),
    hasCode("PHASE_RECEIPT_ARTIFACT_CHAIN_INVALID"),
  );
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
    verifiedRunCount: 96,
    completePairCount: 48,
    confirmatoryAnalysis: {
      analysisSha256: "3".repeat(64),
      jsonSha256: "4".repeat(64),
      markdownSha256: "5".repeat(64),
      ruleSatisfied: true,
      eligibleForExternalReview: true,
    },
    authenticity: { ...aggregate.authenticity, sealSha256: "2".repeat(64) },
  };
  for (const [name, value] of [
    ["commander-xp-preregistration-v2.json", confirmPrereg],
    ["commander-xp-evidence-index-v2.json", confirmIndex],
    ["commander-xp-evidence-seal-v2.json", confirmSeal],
  ]) {
    await fs.writeFile(path.join(confirmRoot, name), canonicalJson(value));
  }
  await fs.copyFile(
    preregLedgerPath,
    path.join(confirmRoot, "commander-xp-prereg-ledger-v2.json"),
  );
  await fs.copyFile(
    providerLedgerPath,
    path.join(confirmRoot, "commander-xp-provider-preflight-ledger-v2.json"),
  );
  await fs.copyFile(ledgerPath, path.join(confirmRoot, canaryBinding.path));
  const confirmAnalysisJsonPath = path.join(
    confirmRoot,
    "commander-xp-confirmatory-analysis-v2.json",
  );
  const confirmAnalysisMarkdownPath = path.join(
    confirmRoot,
    "commander-xp-confirmatory-analysis-v2.md",
  );
  await fs.writeFile(
    confirmAnalysisJsonPath,
    canonicalJson({ schemaVersion: 2, ruleSatisfied: true }),
  );
  await fs.writeFile(
    confirmAnalysisMarkdownPath,
    "# Confirmatory analysis\n\nRule satisfied.\n",
  );
  confirmAggregate.confirmatoryAnalysis.jsonSha256 = (
    await sha256File(confirmAnalysisJsonPath)
  ).slice(7);
  confirmAggregate.confirmatoryAnalysis.markdownSha256 = (
    await sha256File(confirmAnalysisMarkdownPath)
  ).slice(7);
  const confirmRequest = {
    ...request,
    phase: "confirmatory",
    priorPhaseReceipt: canaryBinding,
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
    },
  };
  const confirmVerifierAggregate = await writeSupportJson(t, confirmAggregate);
  await verifyEvidenceBindings({
    evidenceRoot: confirmRoot,
    request: confirmRequest,
    verifierAggregatePath: confirmVerifierAggregate,
  });
  const confirmAuthorityRoot = await temporaryDirectory(t);
  await fs.writeFile(
    path.join(confirmAuthorityRoot, SEAL_REQUEST_FILE),
    canonicalJson(confirmRequest),
  );
  const confirmRequestSha = await sha256File(
    path.join(confirmAuthorityRoot, SEAL_REQUEST_FILE),
  );
  const confirmBundleRoot = path.join(
    await temporaryDirectory(t),
    "confirm-bundle",
  );
  await withProcessEnvironment(
    { GITHUB_RUN_ID: "333", GITHUB_RUN_ATTEMPT: "2" },
    () =>
      buildBundle({
        repository: fixture.root,
        evidenceRoot: confirmRoot,
        sealRequestRoot: confirmAuthorityRoot,
        outputRoot: confirmBundleRoot,
        expectedRequestSha256: confirmRequestSha,
        sourceArtifactMetadataPath: metadataPath,
        sourceCIMetadataPath,
        verifierAggregatePath: confirmVerifierAggregate,
        workflowAuthorizationSha,
        createdAt: "2026-08-22T15:00:00Z",
      }),
  );
  const confirmManifest = await verifyBundle(confirmBundleRoot);
  assert.deepEqual(
    confirmManifest.verifier.confirmatoryAnalysis,
    confirmAggregate.confirmatoryAnalysis,
  );
  const confirmRefetchBody = {
    ...refetchBody,
    phase: "confirmatory",
    verifiedAt: "2026-08-22T15:29:00Z",
    runCount: 96,
    runs: Array.from({ length: 48 }, (_unused, replicaIndex) =>
      ["B", "C"].map((arm) => ({
        runPath: `runs/confirmatory/r${String(replicaIndex).padStart(2, "0")}/${arm}`,
        xpRequestID: `xreq_confirm_${replicaIndex}${arm}`,
        episodeRequestID: `ereq_confirm_${replicaIndex}${arm}`,
        memberSetSha256: "1".repeat(64),
        xpEvidenceSha256: "2".repeat(64),
        normalizedReadbackSha256: "3".repeat(64),
        replayEvidenceSha256: "4".repeat(64),
        episodeResultsSha256: "5".repeat(64),
        gameEvidenceSha256: "6".repeat(64),
        playerArtifactSha256: "7".repeat(64),
      })),
    ).flat(),
  };
  const confirmPlatformRefetchPath = path.join(
    supportRoot,
    "commander-xp-confirmatory-platform-refetch-v2.json",
  );
  await fs.writeFile(
    confirmPlatformRefetchPath,
    canonicalJson({
      ...confirmRefetchBody,
      refetchSha256: sha256Bytes(
        Buffer.from(canonicalJson(confirmRefetchBody)),
      ).slice(7),
    }),
  );
  const confirmReceiptPath = path.join(
    await temporaryDirectory(t),
    EXTERNAL_RECEIPT_FILE,
  );
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
        bundleRoot: confirmBundleRoot,
        sealedBundlePath,
        platformRefetchPath: confirmPlatformRefetchPath,
        outputPath: confirmReceiptPath,
        bundleArtifactMetadataPath: bundleMetadataPath,
        completedAt: "2026-08-22T15:30:00Z",
      }),
  );
  const confirmReceipt = await verifyExternalReceipt(confirmReceiptPath, {
    experimentID,
    phase: "confirmatory",
  });
  assert.equal(confirmReceipt.experimentUsable, true);
  assert.equal(confirmReceipt.performanceClaimAuthorized, true);
  assert.equal(
    confirmReceipt.status,
    "sealed-confirmatory-analysis-performance-authorized",
  );
  const createConfirmatoryLedger = async (
    receiptPath,
    bundleRoot,
    artifactID,
    completedAt,
  ) => {
    const receiptArtifact = {
      artifactID,
      artifactName: `commander-xp-confirmatory-receipt-${artifactID}`,
      artifactDigest: `sha256:${String(artifactID).padStart(64, "0")}`,
      workflowRunID: 333,
      workflowRunAttempt: 2,
    };
    const metadataPath = await writeSupportJson(
      t,
      artifactMetadata(receiptArtifact, workflowAuthorizationSha, {
        status: "in_progress",
        conclusion: null,
        event: "workflow_run",
      }),
    );
    const ledgerPath = path.join(
      await temporaryDirectory(t),
      EXTERNAL_PHASE_LEDGER_FILE,
    );
    await withProcessEnvironment(
      {
        GITHUB_RUN_ID: "333",
        GITHUB_RUN_ATTEMPT: "2",
        RECEIPT_ARTIFACT_ID: String(artifactID),
        RECEIPT_ARTIFACT_NAME: receiptArtifact.artifactName,
        RECEIPT_ARTIFACT_DIGEST: receiptArtifact.artifactDigest,
      },
      () =>
        createExternalPhaseLedger({
          bundleRoot,
          receiptPath,
          receiptArtifactMetadataPath: metadataPath,
          outputPath: ledgerPath,
          completedAt,
        }),
    );
    return { ledgerPath, ledger: await verifyExternalPhaseLedger(ledgerPath) };
  };
  const confirmedLedger = await createConfirmatoryLedger(
    confirmReceiptPath,
    confirmBundleRoot,
    446,
    "2026-08-22T15:35:00Z",
  );
  assert.equal(confirmedLedger.ledger.experimentUsable, true);
  assert.equal(confirmedLedger.ledger.performanceClaimAuthorized, true);
  assert.deepEqual(
    confirmedLedger.ledger.confirmatoryAnalysis,
    confirmReceipt.confirmatoryAnalysis,
  );
  const tamperedConfirmReceipt = structuredClone(confirmReceipt);
  tamperedConfirmReceipt.performanceClaimAuthorized = false;
  const tamperedConfirmReceiptPath = await writeSupportJson(
    t,
    tamperedConfirmReceipt,
  );
  await assert.rejects(
    verifyExternalReceipt(tamperedConfirmReceiptPath),
    hasCode("EXTERNAL_RECEIPT_ANALYSIS_AUTHORIZATION_INVALID"),
  );
  const adverseAggregate = {
    ...confirmAggregate,
    confirmatoryAnalysis: {
      ...confirmAggregate.confirmatoryAnalysis,
      ruleSatisfied: false,
      eligibleForExternalReview: false,
    },
  };
  const adverseAggregatePath = await writeSupportJson(t, adverseAggregate);
  const adverseBundleRoot = path.join(
    await temporaryDirectory(t),
    "adverse-confirm-bundle",
  );
  await withProcessEnvironment(
    { GITHUB_RUN_ID: "333", GITHUB_RUN_ATTEMPT: "2" },
    () =>
      buildBundle({
        repository: fixture.root,
        evidenceRoot: confirmRoot,
        sealRequestRoot: confirmAuthorityRoot,
        outputRoot: adverseBundleRoot,
        expectedRequestSha256: confirmRequestSha,
        sourceArtifactMetadataPath: metadataPath,
        sourceCIMetadataPath,
        verifierAggregatePath: adverseAggregatePath,
        workflowAuthorizationSha,
        createdAt: "2026-08-22T15:40:00Z",
      }),
  );
  const adverseReceiptPath = path.join(
    await temporaryDirectory(t),
    EXTERNAL_RECEIPT_FILE,
  );
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
        bundleRoot: adverseBundleRoot,
        sealedBundlePath,
        platformRefetchPath: confirmPlatformRefetchPath,
        outputPath: adverseReceiptPath,
        bundleArtifactMetadataPath: bundleMetadataPath,
        completedAt: "2026-08-22T15:45:00Z",
      }),
  );
  const adverseReceipt = await verifyExternalReceipt(adverseReceiptPath);
  assert.equal(adverseReceipt.experimentUsable, true);
  assert.equal(adverseReceipt.performanceClaimAuthorized, false);
  assert.equal(
    adverseReceipt.status,
    "sealed-confirmatory-analysis-performance-unauthorized",
  );
  const adverseLedger = await createConfirmatoryLedger(
    adverseReceiptPath,
    adverseBundleRoot,
    447,
    "2026-08-22T15:50:00Z",
  );
  assert.equal(adverseLedger.ledger.experimentUsable, true);
  assert.equal(adverseLedger.ledger.performanceClaimAuthorized, false);
  const tamperedLedger = structuredClone(adverseLedger.ledger);
  tamperedLedger.confirmatoryAnalysis.jsonSha256 = "0".repeat(64);
  const tamperedLedgerPath = await writeSupportJson(t, tamperedLedger);
  await assert.rejects(
    verifyExternalPhaseLedger(tamperedLedgerPath),
    hasCode("EXTERNAL_PHASE_LEDGER_INVALID"),
  );
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
    preregistrationReceipt: null,
    providerPreflightReceipt: null,
    priorPhaseReceipt: null,
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

async function writeCoworldBundleReceipt(runRoot) {
  const projection = async (name) =>
    (await sha256File(path.join(runRoot, name))).slice(7);
  const isPreflight = runRoot.includes(
    `${path.sep}provider-preflight${path.sep}`,
  );
  const receipt = {
    schemaVersion: 2,
    authority: "coworld-authenticated-bundle-projection-v2",
    downloadedAt: "2026-08-22T13:30:00Z",
    xpRequestID: "xreq_11111111-1111-4111-8111-111111111111",
    episodeRequestID: "ereq_22222222-2222-4222-8222-222222222222",
    jobID: "33333333-3333-4333-8333-333333333333",
    episodeID: "44444444-4444-4444-8444-444444444444",
    gameID: "game-1",
    seed: 42,
    coworldID: "cow_eval-1",
    coworldVersion: "0.1.0",
    variantID: "tournament-4p-pangaea",
    include: ["results", "replay", "game_logs"],
    manifestSha256: "8".repeat(64),
    outerBundleSha256: "5".repeat(64),
    members: [
      { path: "logs/game.log", bytes: 84, sha256: "7".repeat(64) },
      { path: "manifest.json", bytes: 96, sha256: "8".repeat(64) },
      {
        path: "replay",
        bytes: 128,
        sha256:
          "d22465aa50b7fedb9ed1f4a664e7c39b81ea1c129fed3410dfbfb33a3d242a93",
      },
      { path: "results.json", bytes: 42, sha256: "6".repeat(64) },
    ],
    projections: {
      replayEvidenceSha256: await projection("replay-evidence.json"),
      episodeResultsSha256: isPreflight
        ? null
        : await projection("episode-results.json"),
      gameEvidenceSha256: isPreflight
        ? null
        : await projection("game-evidence.jsonl"),
      commandReceiptsSha256: await projection("command-receipts.json"),
    },
  };
  await fs.writeFile(
    path.join(runRoot, "coworld-bundle-receipt.json"),
    canonicalJson(receipt),
  );
}

function externalLedgerFixture({
  experimentID,
  phase,
  source,
  sourceArtifact,
  completedAt,
  localSealSha256,
  preRegistrationSha256,
  preregistrationReceipt = null,
  providerPreflightReceipt = null,
  priorPhaseReceipt = null,
  canaryReceipt = null,
  namespaceRegistry = namespaceRegistryFixture(null),
}) {
  const body = {
    schemaVersion: 2,
    authority: "github-actions-attested-ledger-v1",
    repository: "0xNad/ProxyWar",
    workflowPath: ".github/workflows/commander-xp-external-seal.yml",
    workflowID: "777",
    workflowName: "Commander XP external seal",
    actor: "0xNad",
    triggeringActor: "0xNad",
    event: "workflow_run",
    ref: "refs/heads/main",
    experimentID,
    preRegistrationSha256,
    behaviorBaseSha: source.behaviorBaseSha,
    behaviorBaseTreeSha: source.behaviorBaseTreeSha,
    runnerEnvironment: "github-hosted",
    attestationPolicy: {
      repository: "0xNad/ProxyWar",
      signerWorkflow:
        "0xNad/ProxyWar/.github/workflows/commander-xp-external-seal.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: source.workflowSourceSha,
      signerDigest: source.workflowSourceSha,
      denySelfHostedRunners: true,
    },
    collector: sourceArtifact,
    runId: "700",
    attempt: 1,
    signerSourceSha: source.workflowSourceSha,
    headSha: source.workflowSourceSha,
    treeSha: source.workflowSourceTreeSha,
    phase,
    completedAt,
    preregistrationReceipt,
    providerPreflightReceipt,
    priorPhaseReceipt,
    canaryReceipt,
    namespaceRegistry,
    confirmatoryAnalysis: null,
    evidenceArtifact: {
      id: "701",
      digest: `sha256:${"a".repeat(64)}`,
      aggregateSha256: "b".repeat(64),
      attestedSubjectDigest: "c".repeat(64),
      localSealSha256,
      platformRefetchSha256: "f".repeat(64),
    },
    receiptArtifact: {
      id: "702",
      digest: `sha256:${"d".repeat(64)}`,
      receiptSha256: "e".repeat(64),
      attestedSubjectDigest: "e".repeat(64),
    },
    integrityVerified: true,
    experimentUsable: false,
    performanceClaimAuthorized: false,
  };
  return {
    ...body,
    ledgerSha256: sha256Bytes(Buffer.from(canonicalJson(body))).slice(7),
  };
}

function phaseReceiptBinding(ledger, relativePath, fileSha256) {
  return {
    path: relativePath,
    sha256: fileSha256,
    ledgerSha256: ledger.ledgerSha256,
    runId: ledger.runId,
    attempt: ledger.attempt,
    evidenceArtifact: ledger.evidenceArtifact,
    receiptArtifact: ledger.receiptArtifact,
    ledgerArtifact: {
      id: "703",
      name: `commander-xp-phase-ledger-${ledger.phase}-${ledger.headSha}-${ledger.runId}-${ledger.attempt}`,
      digest: `sha256:${"f".repeat(64)}`,
      ledgerSha256: ledger.ledgerSha256,
      attestationID: "803",
    },
    authorityArtifact: {
      id: "704",
      name: `commander-xp-authority-${ledger.phase}-${ledger.headSha}-${ledger.runId}-${ledger.attempt}`,
      digest: `sha256:${"1".repeat(64)}`,
      receiptSha256: "2".repeat(64),
      attestationID: "804",
    },
    terminalArtifact: {
      id: "705",
      name: `commander-xp-terminal-authority-${ledger.phase}-${ledger.headSha}-${ledger.runId}-${ledger.attempt}`,
      digest: `sha256:${"3".repeat(64)}`,
      envelopeSha256: "4".repeat(64),
      subjectSha256: "5".repeat(64),
    },
    localSealSha256: ledger.evidenceArtifact.localSealSha256,
    namespaceRegistrySha256: ledger.namespaceRegistry.registrySha256,
    signerSourceSha: ledger.signerSourceSha,
    workflowPath: ledger.workflowPath,
    workflowID: ledger.workflowID,
    workflowName: ledger.workflowName,
    actor: ledger.actor,
    triggeringActor: ledger.triggeringActor,
    event: ledger.event,
    ref: ledger.ref,
    phase: ledger.phase,
    experimentID: ledger.experimentID,
    behaviorBaseSha: ledger.behaviorBaseSha,
    behaviorBaseTreeSha: ledger.behaviorBaseTreeSha,
    headSha: ledger.headSha,
    treeSha: ledger.treeSha,
  };
}

function namespaceRegistryFixture(priorRegistrySha256) {
  const body = {
    schemaVersion: 2,
    mode: "cumulative-per-namespace",
    priorRegistrySha256,
    namespaces: {
      decisionRequestID: [],
      episodeID: [],
      episodeRequestID: [],
      jobID: [],
      providerRequestID: [],
      replayPath: [],
      replayURLSha256: [],
      runKey: [],
      xpRequestID: [],
    },
  };
  return {
    ...body,
    registrySha256: sha256Bytes(Buffer.from(canonicalJson(body))).slice(7),
  };
}

async function retainedAuthorityFixture(root, ledgerPath, ledger, binding) {
  const authority = {
    schemaVersion: 1,
    authority: "github-actions-protected-main-public-sigstore-v1",
    repository: ledger.repository,
    workflowPath: ledger.workflowPath,
    workflowID: ledger.workflowID,
    workflowName: ledger.workflowName,
    actor: ledger.actor,
    triggeringActor: ledger.triggeringActor,
    event: ledger.event,
    workflowRef: ledger.ref,
    experimentID: ledger.experimentID,
    runId: ledger.runId,
    attempt: ledger.attempt,
    signerSourceSha: ledger.signerSourceSha,
    headSha: ledger.headSha,
    treeSha: ledger.treeSha,
    behaviorBaseSha: ledger.behaviorBaseSha,
    behaviorBaseTreeSha: ledger.behaviorBaseTreeSha,
    localSealSha256: ledger.evidenceArtifact.localSealSha256,
    phase: ledger.phase,
    sourceCI: { runID: 12 },
    collectorArtifact: ledger.collector,
    bundleArtifact: {
      id: ledger.evidenceArtifact.id,
      digest: ledger.evidenceArtifact.digest,
    },
    receiptArtifact: {
      id: ledger.receiptArtifact.id,
      digest: ledger.receiptArtifact.digest,
    },
    ledgerArtifact: {
      id: binding.ledgerArtifact.id,
      digest: binding.ledgerArtifact.digest,
      ledgerSha256: ledger.ledgerSha256,
    },
    attestations: {
      subject: {
        id: "901",
        bundleSha256: "a".repeat(64),
        provenanceSha256s: ["b".repeat(64)],
      },
      ledger: {
        id: binding.ledgerArtifact.attestationID,
        bundleSha256: "c".repeat(64),
        provenanceSha256: "d".repeat(64),
      },
    },
    confirmatoryAnalysis: ledger.confirmatoryAnalysis,
    integrityVerified: ledger.integrityVerified,
    experimentUsable: ledger.experimentUsable,
    performanceClaimAuthorized: ledger.performanceClaimAuthorized,
  };
  const authorityPath = path.join(root, "authority.json");
  await fs.writeFile(authorityPath, canonicalJson(authority));
  binding.authorityArtifact.receiptSha256 = await sha256File(authorityPath);
  const terminalBody = {
    schemaVersion: 2,
    authority: "github-actions-terminal-authority-envelope-v2",
    repository: authority.repository,
    workflowPath: authority.workflowPath,
    workflowID: authority.workflowID,
    workflowName: authority.workflowName,
    actor: authority.actor,
    triggeringActor: authority.triggeringActor,
    event: authority.event,
    workflowRef: authority.workflowRef,
    experimentID: authority.experimentID,
    runId: authority.runId,
    attempt: authority.attempt,
    signerSourceSha: authority.signerSourceSha,
    headSha: authority.headSha,
    treeSha: authority.treeSha,
    behaviorBaseSha: authority.behaviorBaseSha,
    behaviorBaseTreeSha: authority.behaviorBaseTreeSha,
    localSealSha256: authority.localSealSha256,
    phase: authority.phase,
    sourceCI: authority.sourceCI,
    collectorArtifact: authority.collectorArtifact,
    bundleArtifact: authority.bundleArtifact,
    receiptArtifact: authority.receiptArtifact,
    ledgerArtifact: authority.ledgerArtifact,
    subjectAttestation: authority.attestations.subject,
    ledgerAttestation: authority.attestations.ledger,
    authorityArtifact: {
      id: binding.authorityArtifact.id,
      digest: binding.authorityArtifact.digest,
      receiptSha256: binding.authorityArtifact.receiptSha256,
    },
    authorityAttestation: {
      id: binding.authorityArtifact.attestationID,
      bundleSha256: "e".repeat(64),
      provenanceSha256: "f".repeat(64),
    },
    confirmatoryAnalysis: authority.confirmatoryAnalysis,
    integrityVerified: authority.integrityVerified,
    experimentUsable: authority.experimentUsable,
    performanceClaimAuthorized: authority.performanceClaimAuthorized,
  };
  const terminal = {
    ...terminalBody,
    envelopeSha256: sha256Bytes(Buffer.from(canonicalJson(terminalBody))),
  };
  const terminalPath = path.join(root, "terminal.json");
  await fs.writeFile(terminalPath, canonicalJson(terminal));
  binding.terminalArtifact.envelopeSha256 = terminal.envelopeSha256;
  binding.terminalArtifact.subjectSha256 = await sha256File(terminalPath);
  return { ledgerPath, authorityPath, terminalPath, binding };
}

function artifactMetadata(
  binding,
  headSha,
  {
    status = "completed",
    conclusion = "success",
    event = "workflow_dispatch",
  } = {},
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
      event,
      head_branch: "main",
      head_sha: headSha,
      workflow_id: binding.workflowID ?? 555,
      path:
        binding.workflowPath ??
        ".github/workflows/commander-xp-external-seal.yml",
      actor: { login: binding.actor ?? "0xNad" },
      triggering_actor: { login: binding.triggeringActor ?? "0xNad" },
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
    head_branch: "main",
    head_repository: { full_name: "0xNad/ProxyWar" },
    repository: { full_name: "0xNad/ProxyWar" },
    actor: { login: "0xNad" },
    triggering_actor: { login: "0xNad" },
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
