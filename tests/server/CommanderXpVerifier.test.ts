import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The manifest builder is an executable ESM helper without a
// declaration file; its own focused test verifies the same exported function.
import { commanderXpEvalManifest } from "../../coworld-adapter/scripts/prepare-commander-xp-eval-manifest.mjs";
// @ts-expect-error The protected external-seal helper is executable ESM without a declaration file.
import * as externalSealLib from "../../.github/scripts/commander-xp-external-seal-lib.mjs";
import { coworldEpisodeIdentity } from "../../coworld-adapter/src/coworld-seed";
import { buildCommanderXpAuthorityRequest } from "../../src/scripts/ai-agent-commander-xp-authority-request";
import {
  buildCommanderXpPreRegistration,
  commanderXpProviderPreflightRequestID,
  sha256Canonical,
  type CommanderXpPlanInput,
} from "../../src/server/agents/CommanderXpProtocol";
import {
  assertCommanderXpExternalPhaseReceiptDocument,
  verifyCommanderXpCoworldBundleProjection,
  verifyCommanderXpEvidence,
  verifyCommanderXpJoinedGameplayEvidence,
  type CommanderXpExternalPhaseReceipt,
  type PlayerRuntimeManifest,
} from "../../src/server/agents/CommanderXpVerifier";

const temporaryRoots: string[] = [];
const { scanPrivacyAndInventory, verifyExternalPhaseLedger } = externalSealLib;

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("Commander XP evidence verifier v2", () => {
  it("accepts a complete no-run preregistration evidence tree before authority upload", async () => {
    const fixture = await buildPreregistrationFixture();

    await expect(
      verifyCommanderXpEvidence(fixture.evidenceRoot),
    ).resolves.toEqual(
      expect.objectContaining({
        integrityVerified: true,
        experimentUsable: false,
        phase: "preregistration",
        verifiedRunCount: 0,
        performanceClaimAuthorized: false,
        diagnostics: [
          { code: "EXTERNAL_IMMUTABLE_SEAL_RECEIPT_REQUIRED", path: null },
        ],
      }),
    );
    await expect(
      scanPrivacyAndInventory(fixture.evidenceRoot),
    ).resolves.toEqual(
      expect.objectContaining({ fileCount: expect.any(Number) }),
    );
  });

  it("accepts the separately stored authority request after evidence upload", async () => {
    const fixture = await buildPreregistrationFixture();
    const authorityPath = path.join(
      fixture.envelopeRoot,
      "authority/commander-xp-external-seal-request-v1.json",
    );

    await expect(
      verifyCommanderXpEvidence(fixture.evidenceRoot, authorityPath),
    ).resolves.toMatchObject({
      integrityVerified: true,
      experimentUsable: false,
      phase: "preregistration",
    });
  });

  it("builds the authority artifact only after the evidence index and seal exist", async () => {
    const fixture = await buildPreregistrationFixture();
    const authorityDirectory = path.join(fixture.envelopeRoot, "authority");
    const original = JSON.parse(
      await fs.readFile(
        path.join(
          authorityDirectory,
          "commander-xp-external-seal-request-v1.json",
        ),
        "utf8",
      ),
    );
    await fs.rm(authorityDirectory, { recursive: true });

    const built = await buildCommanderXpAuthorityRequest(
      {
        schemaVersion: 1,
        phase: "preregistration",
        sourceCI: original.sourceCI,
        sourceArtifact: original.sourceArtifact,
        sourceAllowlist: original.source.sourceAllowlist,
        preregistrationReceipt: null,
        providerPreflightReceipt: null,
        priorPhaseReceipt: null,
        canaryReceipt: null,
      },
      fixture.evidenceRoot,
      authorityDirectory,
    );
    const request = JSON.parse(await fs.readFile(built.requestPath, "utf8"));
    expect(request.evidence).toEqual({
      preRegistrationPath: "commander-xp-preregistration-v2.json",
      preRegistrationSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      localIndexPath: "commander-xp-evidence-index-v2.json",
      localIndexSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      localSealPath: "commander-xp-evidence-seal-v2.json",
      localSealFileSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      localSealSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(built.requestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects extra files in the separate authority artifact", async () => {
    const fixture = await buildPreregistrationFixture();
    const authorityPath = path.join(
      fixture.envelopeRoot,
      "authority/commander-xp-external-seal-request-v1.json",
    );
    await fs.writeFile(
      path.join(path.dirname(authorityPath), "unexpected.json"),
      "{}\n",
      { flag: "wx" },
    );

    const verification = await verifyCommanderXpEvidence(
      fixture.evidenceRoot,
      authorityPath,
    );
    expect(verification).toMatchObject({
      integrityVerified: false,
      diagnostics: [{ code: "AUTHORITY_TREE_MISMATCH" }],
    });
  });

  it("rejects unindexed run material in a preregistration envelope", async () => {
    const fixture = await buildPreregistrationFixture();
    const injected = path.join(fixture.evidenceRoot, "runs/injected.json");
    await fs.mkdir(path.dirname(injected), { recursive: true });
    await fs.writeFile(injected, "{}\n", { flag: "wx" });

    const verification = await verifyCommanderXpEvidence(fixture.evidenceRoot);
    expect(verification).toMatchObject({
      integrityVerified: false,
      experimentUsable: false,
      phase: "preregistration",
      diagnostics: [{ code: "EVIDENCE_TREE_UNINDEXED_FILE" }],
    });
  });

  it("rejects a preregistration authority request that carries a prior receipt", async () => {
    const fixture = await buildPreregistrationFixture();
    const authorityPath = path.join(
      fixture.envelopeRoot,
      "authority/commander-xp-external-seal-request-v1.json",
    );
    const authority = JSON.parse(await fs.readFile(authorityPath, "utf8"));
    authority.preregistrationReceipt = {
      path: "commander-xp-prereg-ledger-v2.json",
      sha256: "f".repeat(64),
    };
    await fs.writeFile(authorityPath, JSON.stringify(authority));

    const verification = await verifyCommanderXpEvidence(
      fixture.evidenceRoot,
      authorityPath,
    );
    expect(verification).toMatchObject({
      integrityVerified: false,
      experimentUsable: false,
      phase: "preregistration",
      diagnostics: [{ code: "AUTHORITY_REQUEST_IDENTITY_MISMATCH" }],
    });
  });

  it("accepts B exact-model preflight while forbidding B gameplay providers", async () => {
    const { preregistration } = await buildPreregistrationFixture();
    const fixture = gameplayJoinFixture(preregistration, "B");
    expect(verifyCommanderXpJoinedGameplayEvidence(fixture)).toEqual([
      fixture.requestID,
    ]);

    const tampered = gameplayJoinFixture(preregistration, "B", {
      injectGameplayProvider: true,
    });
    expect(() => verifyCommanderXpJoinedGameplayEvidence(tampered)).toThrow(
      /ARM_B_GAMEPLAY_PROVIDER_CALL_PRESENT/,
    );
  });

  it("joins C provider calls and accepts only proven cached-plan continuations", async () => {
    const { preregistration } = await buildPreregistrationFixture();
    const fixture = gameplayJoinFixture(preregistration, "C", {
      includeCachedContinuation: true,
    });
    expect(verifyCommanderXpJoinedGameplayEvidence(fixture)).toEqual([
      fixture.requestID,
      `${fixture.requestID}-cached`,
    ]);

    const tampered = gameplayJoinFixture(preregistration, "C", {
      omitEligibleSelectorProvider: true,
    });
    expect(() => verifyCommanderXpJoinedGameplayEvidence(tampered)).toThrow(
      /ARM_C_SELECTOR_MISMATCH/,
    );

    const forged = gameplayJoinFixture(preregistration, "C", {
      includeCachedContinuation: true,
      breakCachedPlanChain: true,
    });
    expect(() => verifyCommanderXpJoinedGameplayEvidence(forged)).toThrow(
      /ARM_C_PLAN_CONTINUITY_MISMATCH/,
    );
  });

  it("round-trips the exact Coworld projection receipt and rejects a hash swap", async () => {
    const { preregistration } = await buildPreregistrationFixture();
    const plannedRequest = preregistration.requests.find(
      (request) =>
        request.phase === "canary" &&
        request.replicaIndex === 0 &&
        request.arm === "C",
    )!;
    const fixture = await buildCoworldProjectionFixture(plannedRequest);
    await expect(
      verifyCommanderXpCoworldBundleProjection({
        evidenceRoot: fixture.root,
        runDirectory: fixture.runDirectory,
        plannedRequest,
      }),
    ).resolves.toBeUndefined();

    const gameEvidenceSha256 = fixture.receipt.projections.gameEvidenceSha256;
    fixture.receipt.projections.gameEvidenceSha256 = "f".repeat(64);
    await writeJson(
      path.join(
        fixture.root,
        fixture.runDirectory,
        "coworld-bundle-receipt.json",
      ),
      fixture.receipt,
    );
    await expect(
      verifyCommanderXpCoworldBundleProjection({
        evidenceRoot: fixture.root,
        runDirectory: fixture.runDirectory,
        plannedRequest,
      }),
    ).rejects.toThrow(/COWORLD_BUNDLE_RECEIPT_MISMATCH/);

    fixture.receipt.projections.gameEvidenceSha256 = gameEvidenceSha256;
    fixture.receipt.manifestSha256 = "f".repeat(64);
    await writeJson(
      path.join(
        fixture.root,
        fixture.runDirectory,
        "coworld-bundle-receipt.json",
      ),
      fixture.receipt,
    );
    await expect(
      verifyCommanderXpCoworldBundleProjection({
        evidenceRoot: fixture.root,
        runDirectory: fixture.runDirectory,
        plannedRequest,
      }),
    ).rejects.toThrow(/COWORLD_BUNDLE_RECEIPT_MISMATCH/);
  });

  it("consumes the external-seal preregistration and provider ledger schema exactly", async () => {
    const { preregistration } = await buildPreregistrationFixture();
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "proxywar-commander-xp-ledger-golden-"),
    );
    temporaryRoots.push(root);
    const preregistrationReceipt = externalPhaseLedgerFixture(
      preregistration,
      "preregistration",
    );
    const preregistrationPath = path.join(root, "preregistration.json");
    await fs.writeFile(
      preregistrationPath,
      externalCanonicalJson(preregistrationReceipt),
    );
    await expect(
      verifyExternalPhaseLedger(preregistrationPath, {
        phase: "preregistration",
        experimentID: preregistration.experimentID,
      }),
    ).resolves.toMatchObject({ phase: "preregistration" });
    expect(() =>
      assertCommanderXpExternalPhaseReceiptDocument(
        preregistration,
        preregistrationReceipt,
        "preregistration",
      ),
    ).not.toThrow();

    const preregistrationBinding = externalPhaseReceiptBinding(
      preregistrationReceipt,
      "commander-xp-prereg-ledger-v2.json",
    );
    const providerReceipt = externalPhaseLedgerFixture(
      preregistration,
      "provider-preflight",
      preregistrationBinding,
    );
    const providerPath = path.join(root, "provider-preflight.json");
    await fs.writeFile(providerPath, externalCanonicalJson(providerReceipt));
    await expect(
      verifyExternalPhaseLedger(providerPath, {
        phase: "provider-preflight",
        experimentID: preregistration.experimentID,
      }),
    ).resolves.toMatchObject({ phase: "provider-preflight" });
    expect(() =>
      assertCommanderXpExternalPhaseReceiptDocument(
        preregistration,
        providerReceipt,
        "provider-preflight",
      ),
    ).not.toThrow();

    const collapsed = structuredClone(providerReceipt);
    collapsed.preregistrationReceipt!.authorityArtifact.id =
      collapsed.preregistrationReceipt!.ledgerArtifact.id;
    expect(() =>
      assertCommanderXpExternalPhaseReceiptDocument(
        preregistration,
        collapsed,
        "provider-preflight",
      ),
    ).toThrow(/PRIOR_PHASE_BINDING_ARTIFACT_CHAIN_INVALID/);
  });
});

function externalPhaseLedgerFixture(
  preregistration: ReturnType<typeof buildCommanderXpPreRegistration>,
  phase: "preregistration" | "provider-preflight",
  preregistrationReceipt: Record<string, any> | null = null,
): CommanderXpExternalPhaseReceipt {
  const registryBody = {
    schemaVersion: 2,
    mode: "cumulative-per-namespace",
    priorRegistrySha256:
      phase === "preregistration"
        ? null
        : preregistrationReceipt!.namespaceRegistrySha256,
    namespaces: {
      decisionRequestID: [],
      episodeID: [],
      episodeRequestID: [],
      jobID: [],
      providerRequestID:
        phase === "provider-preflight"
          ? preregistration.providerPreflightRequests
              .map((request) =>
                commanderXpProviderPreflightRequestID(request.runKey),
              )
              .sort()
          : [],
      replayPath: [],
      replayURLSha256: [],
      runKey:
        phase === "provider-preflight"
          ? preregistration.providerPreflightRequests.map(
              (request) => request.runKey,
            )
          : [],
      xpRequestID: [],
    },
  };
  const namespaceRegistry = {
    ...registryBody,
    registrySha256: sha256(externalCanonicalJson(registryBody)),
  };
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
    experimentID: preregistration.experimentID,
    preRegistrationSha256: preregistration.preRegistrationSha256,
    behaviorBaseSha: preregistration.identities.behaviorSourceSha,
    behaviorBaseTreeSha: preregistration.identities.behaviorSourceTreeSha,
    runnerEnvironment: "github-hosted",
    attestationPolicy: {
      repository: "0xNad/ProxyWar",
      signerWorkflow:
        "0xNad/ProxyWar/.github/workflows/commander-xp-external-seal.yml",
      sourceRef: "refs/heads/main",
      sourceDigest: preregistration.identities.adapterSourceSha,
      signerDigest: preregistration.identities.adapterSourceSha,
      denySelfHostedRunners: true,
    },
    collector: {
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
      headSha: preregistration.identities.adapterSourceSha,
    },
    runId: phase === "preregistration" ? "700" : "701",
    attempt: 1,
    headSha: preregistration.identities.adapterSourceSha,
    treeSha: preregistration.identities.adapterSourceTreeSha,
    phase,
    completedAt:
      phase === "preregistration"
        ? "2026-08-22T13:30:00.000Z"
        : "2026-08-22T13:40:00.000Z",
    preregistrationReceipt,
    providerPreflightReceipt: null,
    priorPhaseReceipt: null,
    canaryReceipt: null,
    namespaceRegistry,
    evidenceArtifact: {
      id: phase === "preregistration" ? "701" : "711",
      digest: `sha256:${"b".repeat(64)}`,
      aggregateSha256: "c".repeat(64),
      attestedSubjectDigest: "d".repeat(64),
      localSealSha256: "e".repeat(64),
      platformRefetchSha256: "0".repeat(64),
    },
    receiptArtifact: {
      id: phase === "preregistration" ? "702" : "712",
      digest: `sha256:${"f".repeat(64)}`,
      receiptSha256: "1".repeat(64),
      attestedSubjectDigest: "1".repeat(64),
    },
  };
  return {
    ...body,
    ledgerSha256: sha256(externalCanonicalJson(body)),
  } as CommanderXpExternalPhaseReceipt;
}

function externalPhaseReceiptBinding(
  ledger: Record<string, any>,
  relativePath: string,
): Record<string, any> {
  const artifactPrefix = `${ledger.phase}-${ledger.headSha}-${ledger.runId}-${ledger.attempt}`;
  return {
    path: relativePath,
    sha256: sha256(externalCanonicalJson(ledger)),
    ledgerSha256: ledger.ledgerSha256,
    runId: ledger.runId,
    attempt: ledger.attempt,
    evidenceArtifact: ledger.evidenceArtifact,
    receiptArtifact: ledger.receiptArtifact,
    ledgerArtifact: {
      id: "703",
      name: `commander-xp-phase-ledger-${artifactPrefix}`,
      digest: `sha256:${"2".repeat(64)}`,
      ledgerSha256: ledger.ledgerSha256,
      attestationID: "803",
    },
    authorityArtifact: {
      id: "704",
      name: `commander-xp-authority-${artifactPrefix}`,
      digest: `sha256:${"3".repeat(64)}`,
      receiptSha256: "4".repeat(64),
      attestationID: "804",
    },
    terminalArtifact: {
      id: "705",
      name: `commander-xp-terminal-authority-${artifactPrefix}`,
      digest: `sha256:${"5".repeat(64)}`,
      envelopeSha256: "6".repeat(64),
      subjectSha256: "7".repeat(64),
    },
    localSealSha256: ledger.evidenceArtifact.localSealSha256,
    namespaceRegistrySha256: ledger.namespaceRegistry.registrySha256,
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

async function buildPreregistrationFixture(): Promise<{
  envelopeRoot: string;
  evidenceRoot: string;
  preregistration: ReturnType<typeof buildCommanderXpPreRegistration>;
}> {
  const envelopeRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "proxywar-commander-xp-verifier-"),
  );
  temporaryRoots.push(envelopeRoot);
  const evidenceRoot = path.join(envelopeRoot, "evidence");
  const authorityRoot = path.join(envelopeRoot, "authority");
  await fs.mkdir(evidenceRoot, { recursive: true });
  await fs.mkdir(authorityRoot, { recursive: true });

  const gameDigest = `sha256:${"7".repeat(64)}`;
  const baseManifest = JSON.parse(
    await fs.readFile(
      path.resolve(
        process.cwd(),
        "coworld-adapter/coworld/coworld_manifest.json",
      ),
      "utf8",
    ),
  );
  const evalManifest = commanderXpEvalManifest(baseManifest, {
    image: `proxywar-coworld-commander-xp-eval@${gameDigest}`,
    version: "0.0.1",
  });
  const evalManifestText = JSON.stringify(evalManifest);
  const adapterSourceSha = "2".repeat(40);
  const adapterSourceTreeSha = "3".repeat(40);
  const sourceTreeDiffText = JSON.stringify({
    schemaVersion: 1,
    behaviorBaseSha: "a69175a30577b3e516f09a2cb0960d4d129b3f33",
    behaviorBaseTreeSha: "b1b88e4a447acb885ed554592d3865af0178314f",
    workflowSourceSha: adapterSourceSha,
    workflowSourceTreeSha: adapterSourceTreeSha,
    allowlistMode: "exact",
    entries: [
      {
        status: "M",
        path: "src/server/agents/CommanderXpVerifier.ts",
        baseMode: "100644",
        headMode: "100644",
        baseBlob: "4".repeat(40),
        headBlob: "5".repeat(40),
        contentSha256: "6".repeat(64),
        bytes: 100,
      },
    ],
  });
  const sourceProvenanceBody = {
    schemaVersion: 2,
    authority: "clean-exact-git-archive-v1",
    repository: "0xNad/ProxyWar",
    behaviorBaseSha: "a69175a30577b3e516f09a2cb0960d4d129b3f33",
    behaviorBaseTreeSha: "b1b88e4a447acb885ed554592d3865af0178314f",
    sourceSha: adapterSourceSha,
    sourceTreeSha: adapterSourceTreeSha,
    sourceAllowlist: ["src/server/agents/CommanderXpVerifier.ts"],
    treeDiffSha256: sha256(sourceTreeDiffText),
    sourceArchiveSha256: "7".repeat(64),
    platform: "linux/amd64",
  };
  const sourceProvenance = {
    ...sourceProvenanceBody,
    provenanceSha256: sha256Canonical(sourceProvenanceBody),
  };
  const sourceProvenanceText = JSON.stringify(sourceProvenance);
  const planInput: CommanderXpPlanInput = {
    experimentID: "commander-xp-v2-verifier-fixture",
    createdAt: "2026-08-22T13:00:00.000Z",
    behaviorSourceSha: "a69175a30577b3e516f09a2cb0960d4d129b3f33",
    behaviorSourceTreeSha: "b1b88e4a447acb885ed554592d3865af0178314f",
    adapterSourceSha,
    adapterSourceTreeSha,
    sourceDiffManifestSha256: sha256(sourceTreeDiffText),
    sourceProvenanceSha256: sourceProvenance.provenanceSha256,
    policyBuildProvenanceDigest: `sha256:${"b".repeat(64)}`,
    gameBuildProvenanceDigest: `sha256:${"c".repeat(64)}`,
    coworldID: "cow_commander_xp_eval_fixture",
    coworldVersion: "0.0.1",
    coworldManifestSha256: sha256(evalManifestText),
    coworldHostedManifestSha256: "6".repeat(64),
    coworldGameImageID: "img_eval_game_fixture",
    coworldGameImageDigest: gameDigest,
    canonicalLeagueBindingSnapshotSha256: "8".repeat(64),
    imageDigest: `sha256:${"4".repeat(64)}`,
    bedrockModel: "us.anthropic.claude-sonnet-4-6",
    xpOpenApiSha256:
      "dc32022f7e2850e65232c6f51c7490011483e8948269e975bc177d71f29a3e4f",
    armPolicyVersionIDs: { A: "pvid-a", B: "pvid-b", C: "pvid-c" },
    opponentPolicyVersionIDs: ["pvid-o1", "pvid-o2", "pvid-o3"],
  };
  const prereg = buildCommanderXpPreRegistration(planInput);

  const policyImage = {
    id: "img_policy_fixture",
    name: "proxywar-commander-xp-policy-fixture",
    version: 1,
    client_hash: "fixture-client-hash",
    status: "ready",
    image_uri: "registry.example/policy@fixture",
    image_digest: planInput.imageDigest,
    public_image_uri: "registry.example/public/policy@fixture",
  };
  const policyInspects = Object.fromEntries(
    (["A", "B", "C"] as const).map((arm, index) => {
      const name = `proxywar-commander-xp-fixture-${arm.toLowerCase()}`;
      const completionPayload = {
        name,
        container_image_id: policyImage.id,
        run: prereg.identities.runArgv[arm],
        tags: { purpose: "commander-xp-v2", role: arm },
        environmentAttached: true,
      };
      const completionResponse = {
        id: planInput.armPolicyVersionIDs[arm],
        name,
        version: index + 1,
        pools: null,
        submit_error: null,
      };
      const readback = {
        id: completionResponse.id,
        name,
        version: completionResponse.version,
      };
      const requestPayload = {
        name: policyImage.name,
        client_hash: policyImage.client_hash,
      };
      const uploadBody = {
        schemaVersion: 2,
        authority: "coworld-0.1.42-policy-upload-readback-v2",
        inspectedAt: "2026-08-22T13:01:00.000Z",
        platform: "linux/amd64",
        sourceSha: planInput.adapterSourceSha,
        sourceTreeSha: planInput.adapterSourceTreeSha,
        sourceProvenanceDigest: `sha256:${planInput.sourceProvenanceSha256}`,
        buildProvenanceDigest: planInput.policyBuildProvenanceDigest,
        ociImage: "ghcr.io/0xnad/proxywar-commander-xp-policy",
        ociDigest: planInput.imageDigest,
        containerImage: policyImage,
        imageUpload: {
          requestPayload,
          requestPayloadSha256: sha256Canonical(requestPayload),
          responseSha256: "d".repeat(64),
          responseBytes: 123,
          responseProjection: { image: policyImage, uploadRequired: true },
          completePayload: { id: policyImage.id },
          completePayloadSha256: sha256Canonical({ id: policyImage.id }),
          completeResponseSha256: "e".repeat(64),
          completeResponseBytes: 124,
          image: policyImage,
        },
        policy: {
          name,
          role: arm,
          runArgv: prereg.identities.runArgv[arm],
          useBedrock: true,
          bedrockModel: planInput.bedrockModel,
          environmentConfiguration: {
            attached: true,
            keys: ["BEDROCK_MODEL", "USE_BEDROCK"],
            valuesSha256: sha256Canonical({
              BEDROCK_MODEL: planInput.bedrockModel,
              USE_BEDROCK: "true",
            }),
            attachmentResponseSha256: "f".repeat(64),
          },
          completionPayloadProjection: completionPayload,
          completionPayloadSha256: "6".repeat(64),
          completionResponse,
          completionResponseSha256: "1".repeat(64),
          completionResponseBytes: 125,
          readback,
          readbackSha256: sha256Canonical(readback),
        },
      };
      return [
        arm,
        { ...uploadBody, receiptSha256: sha256Canonical(uploadBody) },
      ];
    }),
  ) as unknown as Record<"A" | "B" | "C", Record<string, unknown>>;
  const policyInspectTexts = {
    A: JSON.stringify(policyInspects.A),
    B: JSON.stringify(policyInspects.B),
    C: JSON.stringify(policyInspects.C),
  };
  const policyReceiptBody = {
    schemaVersion: 2,
    authority: "coworld-0.1.42-policy-provision-v2",
    inspectedAt: "2026-08-22T13:01:00.000Z",
    platform: "linux/amd64",
    sourceSha: planInput.adapterSourceSha,
    sourceTreeSha: planInput.adapterSourceTreeSha,
    sourceProvenanceDigest: `sha256:${planInput.sourceProvenanceSha256}`,
    policyBuildProvenanceDigest: planInput.policyBuildProvenanceDigest,
    ociImage: "ghcr.io/0xnad/proxywar-commander-xp-policy",
    ociDigest: planInput.imageDigest,
    policyImageID: policyImage.id,
    imageDigest: planInput.imageDigest,
    bedrockModel: planInput.bedrockModel,
    arms: Object.fromEntries(
      (["A", "B", "C"] as const).map((arm) => [
        arm,
        {
          policyVersionID: planInput.armPolicyVersionIDs[arm],
          imageDigest: planInput.imageDigest,
          useBedrock: true,
          bedrockModel: planInput.bedrockModel,
          runArgv: prereg.identities.runArgv[arm],
          inspectResponseSha256: sha256(policyInspectTexts[arm]),
        },
      ]),
    ),
    opponentPolicyVersionIDs: planInput.opponentPolicyVersionIDs,
  };
  const policyReceipt = {
    ...policyReceiptBody,
    receiptSha256: sha256Canonical(policyReceiptBody),
  };
  const hostedEvalManifest = structuredClone(evalManifest);
  hostedEvalManifest.game.runnable.image = planInput.coworldGameImageID;
  for (const player of hostedEvalManifest.player) {
    player.image = planInput.coworldGameImageID;
  }
  const evalInspectText = JSON.stringify({
    coworld: {
      id: planInput.coworldID,
      name: "proxywar-commander-xp-eval",
      version: planInput.coworldVersion,
      manifest_hash: `sha256:${planInput.coworldHostedManifestSha256}`,
      canonical: false,
      manifest: hostedEvalManifest,
    },
    certification: { state: "certified" },
  });
  const terminalProofBody = {
    schemaVersion: 2,
    authority: "exact-image-coworld-0.1.42-run-episode-v1",
    imageDigest: planInput.coworldGameImageDigest,
    variantID: "tournament-4p-pangaea",
    winnerSlot: 2,
    turnCount: 36_400,
    tick: 36_400,
    rosterSlots: [0, 1, 2, 3],
    gameID: coworldEpisodeIdentity(17).gameId,
    seed: 17,
  };
  const terminalProofText = JSON.stringify({
    ...terminalProofBody,
    proofSha256: sha256Canonical(terminalProofBody),
  });
  const evalReceiptBody = {
    schemaVersion: 2,
    authority: "coworld-0.1.42-coworld-inspect-v1",
    inspectedAt: "2026-08-22T13:01:00.000Z",
    inspectResponseSha256: sha256(evalInspectText),
    evalOnly: true,
    publicLeagueBound: false,
    coworldName: prereg.identities.coworldName,
    coworldID: planInput.coworldID,
    coworldVersion: planInput.coworldVersion,
    manifestSha256: planInput.coworldManifestSha256,
    hostedManifestSha256: planInput.coworldHostedManifestSha256,
    gameImageID: planInput.coworldGameImageID,
    gameImageDigest: planInput.coworldGameImageDigest,
    gameBuildProvenanceDigest: planInput.gameBuildProvenanceDigest,
    gameRunnableEnv: {
      PROXYWAR_COMMANDER_XP_GAME_EVIDENCE: "1",
      PROXYWAR_TUNE_STRUCTURED_DEALS: "1",
      PROXYWAR_TUNE_FREETEXT_MESSAGES: "1",
      PROXYWAR_TUNE_SPATIAL_OBSERVATION: "0",
      PROXYWAR_TUNE_SPATIAL_MINIMAP: "0",
    },
    canonicalProduct: {
      coworldID: prereg.identities.canonicalCoworldID,
      coworldVersion: prereg.identities.canonicalCoworldVersion,
      leagueBindingBeforeSha256: planInput.canonicalLeagueBindingSnapshotSha256,
      leagueBindingAfterSha256: planInput.canonicalLeagueBindingSnapshotSha256,
    },
    terminalProofSha256: sha256(terminalProofText),
  };
  const localVerification = {
    schemaVersion: 2,
    verifierSchemaVersion: 2,
    phase: "preregistration",
    integrityExpected: true,
    experimentUsable: false,
    authenticity: "external-seal-receipt-required",
  };

  const artifacts = new Map<string, string>([
    ["commander-xp-preregistration-v2.json", JSON.stringify(prereg)],
    ["commander-xp-source-provenance-v2.json", sourceProvenanceText],
    ["commander-xp-source-tree-diff-v1.json", sourceTreeDiffText],
    ["policy-identities-v2.json", JSON.stringify(policyReceipt)],
    ["policy-inspect/A.json", policyInspectTexts.A],
    ["policy-inspect/B.json", policyInspectTexts.B],
    ["policy-inspect/C.json", policyInspectTexts.C],
    [
      "eval-coworld-identity-v2.json",
      JSON.stringify({
        ...evalReceiptBody,
        receiptSha256: sha256Canonical(evalReceiptBody),
      }),
    ],
    ["eval-coworld-inspect.json", evalInspectText],
    ["eval-coworld-manifest-v2.json", evalManifestText],
    ["eval-coworld-terminal-proof-v2.json", terminalProofText],
    [
      "xp-openapi.sha256",
      `${planInput.xpOpenApiSha256}  https://softmax.com/api/observatory/openapi.json\n`,
    ],
    [
      "commander-xp-local-verification-v2.json",
      JSON.stringify(localVerification),
    ],
  ]);
  for (const [relative, contents] of artifacts) {
    const destination = path.join(evidenceRoot, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents, { flag: "wx" });
  }
  const namespaceBody = {
    schemaVersion: 2 as const,
    mode: "cumulative-per-namespace" as const,
    priorRegistrySha256: null,
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
  const index = {
    schemaVersion: 2,
    experimentID: prereg.experimentID,
    phase: "preregistration",
    preRegistrationSha256: prereg.preRegistrationSha256,
    xpOpenApiSha256: prereg.identities.xpOpenApiSha256,
    canarySealSha256: null,
    namespaceRegistry: {
      ...namespaceBody,
      registrySha256: sha256(externalCanonicalJson(namespaceBody)),
    },
    artifacts: [...artifacts.entries()]
      .map(([relative, contents]) => ({
        path: relative,
        sha256: sha256(contents),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  const sealBody = {
    schemaVersion: 2,
    experimentID: prereg.experimentID,
    phase: "preregistration",
    status: "complete",
    indexSha256: sha256Canonical(index),
    sealedAt: "2026-08-22T13:02:00.000Z",
  };
  await fs.writeFile(
    path.join(evidenceRoot, "commander-xp-evidence-index-v2.json"),
    JSON.stringify(index),
    { flag: "wx" },
  );
  const seal = { ...sealBody, sealSha256: sha256Canonical(sealBody) };
  await fs.writeFile(
    path.join(evidenceRoot, "commander-xp-evidence-seal-v2.json"),
    JSON.stringify(seal),
    { flag: "wx" },
  );
  const preregText = artifacts.get("commander-xp-preregistration-v2.json")!;
  const authority = {
    schemaVersion: 1,
    experimentID: prereg.experimentID,
    phase: "preregistration",
    sourceCI: {
      workflowID: 1,
      workflowPath: ".github/workflows/ci.yml",
      runID: 2,
      runAttempt: 1,
      headSha: prereg.identities.adapterSourceSha,
      actor: "0xNad",
      triggeringActor: "0xNad",
      headRepository: "0xNad/ProxyWar",
      event: "push",
      ref: "refs/heads/main",
    },
    sourceArtifact: {
      artifactID: 3,
      artifactName: "commander-xp-preregistration",
      artifactDigest: `sha256:${"d".repeat(64)}`,
      workflowRunID: 4,
      workflowRunAttempt: 1,
      workflowID: 5,
      workflowPath: ".github/workflows/commander-xp-evidence.yml",
      workflowName: "Commander XP protected experiment evidence",
      actor: "0xNad",
      triggeringActor: "0xNad",
      headRepository: "0xNad/ProxyWar",
      event: "workflow_dispatch",
      ref: "refs/heads/main",
      headSha: prereg.identities.adapterSourceSha,
    },
    source: {
      behaviorBaseSha: prereg.identities.behaviorSourceSha,
      behaviorBaseTreeSha: prereg.identities.behaviorSourceTreeSha,
      workflowSourceSha: prereg.identities.adapterSourceSha,
      workflowSourceTreeSha: prereg.identities.adapterSourceTreeSha,
      sourceAllowlist: ["src/server/agents/CommanderXpVerifier.ts"],
    },
    evidence: {
      preRegistrationPath: "commander-xp-preregistration-v2.json",
      preRegistrationSha256: sha256(preregText),
      localIndexPath: "commander-xp-evidence-index-v2.json",
      localIndexSha256: sha256(JSON.stringify(index)),
      localSealPath: "commander-xp-evidence-seal-v2.json",
      localSealFileSha256: sha256(JSON.stringify(seal)),
      localSealSha256: seal.sealSha256,
    },
    preregistrationReceipt: null,
    providerPreflightReceipt: null,
    priorPhaseReceipt: null,
    canaryReceipt: null,
  };
  await fs.writeFile(
    path.join(authorityRoot, "commander-xp-external-seal-request-v1.json"),
    JSON.stringify(authority),
    { flag: "wx" },
  );
  return { envelopeRoot, evidenceRoot, preregistration: prereg };
}

function gameplayJoinFixture(
  preregistration: ReturnType<typeof buildCommanderXpPreRegistration>,
  arm: "B" | "C",
  options: {
    injectGameplayProvider?: boolean;
    omitEligibleSelectorProvider?: boolean;
    includeCachedContinuation?: boolean;
    breakCachedPlanChain?: boolean;
  } = {},
): Parameters<typeof verifyCommanderXpJoinedGameplayEvidence>[0] & {
  requestID: string;
} {
  const plannedRequest = preregistration.requests.find(
    (request) =>
      request.phase === "canary" &&
      request.replicaIndex === 0 &&
      request.arm === arm,
  )!;
  const expectedGameID = coworldEpisodeIdentity(plannedRequest.seed).gameId;
  const requestID = `decision-${arm.toLowerCase()}-fixture`;
  const provider = (input: {
    requestID: string;
    stage: "preflight" | "selector";
    sequence: number;
  }) => ({
    recordType: "provider",
    schemaVersion: 2,
    requestID: input.requestID,
    stage: input.stage,
    sequence: input.sequence,
    provider: "bedrock-sidecar",
    requestedModel: preregistration.identities.bedrockModel,
    responseModel: preregistration.identities.bedrockModel,
    promptSha256: "1".repeat(64),
    promptCharacters: 20,
    outputSha256: "2".repeat(64),
    outputCharacters: 2,
    succeeded: true,
    failureKind: null,
  });
  const trace: Array<Record<string, unknown>> = [
    provider({
      requestID: commanderXpProviderPreflightRequestID(plannedRequest.runKey),
      stage: "preflight",
      sequence: 0,
    }),
  ];
  if (
    (arm === "C" && !options.omitEligibleSelectorProvider) ||
    options.injectGameplayProvider
  ) {
    trace.push(
      provider({ requestID, stage: "selector", sequence: trace.length }),
    );
  }
  const legalActions = [{ id: "hold:fixture", kind: "hold" }];
  trace.push({
    recordType: "decision",
    schemaVersion: 2,
    requestID,
    sequence: trace.length,
    arm,
    offeredLegalActions: legalActions,
    offeredLegalActionSetSha256: sha256Canonical(legalActions),
    selectedLegalActionID: "hold:fixture",
    selectedLegalActionIDs: ["hold:fixture"],
    selectedDealActionID: null,
    selectedMessageActionID: null,
    spawnPreferenceLegalActionIDs: [],
    runtimeMode: "commander-v0-selector",
    fallbackUsed: false,
    llmPlannerDegraded: false,
    degradedCause: null,
    commander: {
      plannerSource: "strategic-commander-v0",
      executorSource: "strategic-option-executor-v0",
      actionSelectionSource: "strategic-option-binding",
      externalPlannerCall: arm === "C",
      commanderPrimarySelectorSource: arm === "B" ? "deterministic" : "llm",
      commanderSelectorSource: arm === "B" ? "deterministic" : "llm",
      commanderSelectorProvider: arm === "B" ? null : "custom",
      commanderSelectorModel:
        arm === "B" ? null : preregistration.identities.bedrockModel,
      commanderEligibleOptionIds: "option:fixture",
      commanderFidelity: "aligned_primary",
      planID: arm === "C" ? "plan-c-fixture" : "plan-b-fixture",
      commanderPreviousPlanID: null,
      commanderFingerprint: "options:state",
      commanderPlanInstalled: true,
      commanderPlanAgeDecisions: 0,
      commanderReplanReason: "initial",
    },
  });
  const gameEvidence: Array<Record<string, unknown>> = [
    {
      schemaVersion: 2,
      runKey: plannedRequest.runKey,
      requestID,
      sequence: 0,
      gameID: expectedGameID,
      coworldSlot: plannedRequest.subjectSeat,
      agentID: `agent-${arm.toLowerCase()}`,
      turnNumber: 1,
      legalActions,
      offeredLegalActionSetSha256: sha256Canonical(legalActions),
      chosen: { id: "hold:fixture", kind: "hold" },
      generatedIntent: null,
      result: { accepted: true, submittedIntent: null },
      audit: { status: "not_applicable", reasonSha256: null },
      spawn: null,
      deal: null,
      comms: {
        requestedID: null,
        actionID: null,
        recipientID: null,
        accepted: null,
        rejected: null,
      },
    },
  ];
  if (arm === "C" && options.includeCachedContinuation) {
    const cachedRequestID = `${requestID}-cached`;
    trace.push({
      recordType: "decision",
      schemaVersion: 2,
      requestID: cachedRequestID,
      sequence: trace.length,
      arm,
      offeredLegalActions: legalActions,
      offeredLegalActionSetSha256: sha256Canonical(legalActions),
      selectedLegalActionID: "hold:fixture",
      selectedLegalActionIDs: ["hold:fixture"],
      selectedDealActionID: null,
      selectedMessageActionID: null,
      spawnPreferenceLegalActionIDs: [],
      runtimeMode: "commander-v0-selector",
      fallbackUsed: false,
      llmPlannerDegraded: false,
      degradedCause: null,
      commander: {
        plannerSource: "strategic-commander-v0",
        executorSource: "strategic-option-executor-v0",
        actionSelectionSource: "strategic-option-binding",
        externalPlannerCall: false,
        commanderPrimarySelectorSource: "llm",
        commanderSelectorSource: "llm",
        commanderSelectorProvider: null,
        commanderSelectorModel: null,
        commanderEligibleOptionIds: "option:fixture",
        commanderFidelity: "aligned_primary",
        planID: options.breakCachedPlanChain
          ? "plan-c-forged"
          : "plan-c-fixture",
        commanderPreviousPlanID: null,
        commanderFingerprint: "options:state",
        commanderPlanInstalled: false,
        commanderPlanAgeDecisions: 1,
        commanderReplanReason: "within_horizon",
      },
    });
    gameEvidence.push({
      ...gameEvidence[0],
      requestID: cachedRequestID,
      sequence: 1,
      turnNumber: 2,
    });
  }
  const runtimeManifest: PlayerRuntimeManifest = {
    schemaVersion: 2,
    artifactKind: "commander-xp-policy-evidence",
    arm,
    gameID: expectedGameID,
    runKey: plannedRequest.runKey,
    behaviorSourceSha: preregistration.identities.behaviorSourceSha,
    behaviorSourceTreeSha: preregistration.identities.behaviorSourceTreeSha,
    adapterSourceSha: preregistration.identities.adapterSourceSha,
    adapterSourceTreeSha: preregistration.identities.adapterSourceTreeSha,
    sourceProvenanceSha256: preregistration.identities.sourceProvenanceSha256,
    imageDigest: null,
    policyVersionID: null,
    policyIdentityAuthority:
      "external-policy-inspect-and-xp-participant-metadata",
    requestedModel: preregistration.identities.bedrockModel,
    runArgv: preregistration.identities.runArgv[arm],
    flags: preregistration.fixedFlags,
    providerPreflight: {
      required: true,
      status: "succeeded",
      requestID: commanderXpProviderPreflightRequestID(plannedRequest.runKey),
      requestedModel: preregistration.identities.bedrockModel,
      responseModel: preregistration.identities.bedrockModel,
      succeeded: true,
    },
  };
  return {
    preregistration,
    plannedRequest,
    runtimeManifest,
    playerTraceJsonl: `${trace.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    gameEvidenceJsonl: `${gameEvidence.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    expectedGameID,
    requestID,
  };
}

async function buildCoworldProjectionFixture(
  plannedRequest: ReturnType<
    typeof buildCommanderXpPreRegistration
  >["requests"][number],
): Promise<{
  root: string;
  runDirectory: string;
  receipt: Record<string, any>;
}> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "proxywar-commander-xp-coworld-receipt-"),
  );
  temporaryRoots.push(root);
  const runDirectory = `runs/canary/r00/${plannedRequest.arm}`;
  const directory = path.join(root, runDirectory);
  await fs.mkdir(directory, { recursive: true });
  const xp = {
    xpRequestID: "xreq_receipt_fixture",
    episodeRequestID: "ereq_receipt_fixture",
    jobID: "job_receipt_fixture",
    episodeID: "episode_receipt_fixture",
    coworldID: "cow_receipt_fixture",
    coworldVersion: "0.0.1",
    variantID: "tournament-4p-pangaea",
  };
  const replayMemberSha256 = "4".repeat(64);
  const replay = { contentSha256: replayMemberSha256 };
  const results = { schemaVersion: 2 };
  const commandReceipts = {
    schemaVersion: 2,
    coworldClient: "0.1.42",
    commands: [
      {
        command: ["xp-request", "get", xp.xpRequestID, "--json"],
        resultSha256: "1".repeat(64),
      },
      {
        command: ["commander-xp-episode-bundle", xp.episodeRequestID],
        resultSha256: "2".repeat(64),
      },
      {
        command: [
          "episode-logs",
          xp.episodeRequestID,
          "--agent",
          String(plannedRequest.subjectSeat),
          "--artifact",
        ],
        resultSha256: "3".repeat(64),
      },
    ],
  };
  const xpText = await writeJson(path.join(directory, "xp-evidence.json"), xp);
  const replayText = await writeJson(
    path.join(directory, "replay-evidence.json"),
    replay,
  );
  const resultsText = await writeJson(
    path.join(directory, "episode-results.json"),
    results,
  );
  const gameEvidenceText = "{}\n";
  await fs.writeFile(
    path.join(directory, "game-evidence.jsonl"),
    gameEvidenceText,
  );
  const commandText = await writeJson(
    path.join(directory, "command-receipts.json"),
    commandReceipts,
  );
  const receipt = {
    schemaVersion: 2,
    authority: "coworld-authenticated-bundle-projection-v2",
    downloadedAt: "2026-08-22T13:05:00.000Z",
    xpRequestID: xp.xpRequestID,
    episodeRequestID: xp.episodeRequestID,
    jobID: xp.jobID,
    episodeID: xp.episodeID,
    gameID: coworldEpisodeIdentity(plannedRequest.seed).gameId,
    seed: plannedRequest.seed,
    coworldID: xp.coworldID,
    coworldVersion: xp.coworldVersion,
    variantID: xp.variantID,
    include: ["results", "replay", "game_logs"],
    manifestSha256: "5".repeat(64),
    outerBundleSha256: "2".repeat(64),
    members: [
      { path: "logs/game.log", bytes: 10, sha256: "6".repeat(64) },
      { path: "manifest.json", bytes: 10, sha256: "5".repeat(64) },
      { path: "replay", bytes: 10, sha256: replayMemberSha256 },
      { path: "results.json", bytes: 10, sha256: "8".repeat(64) },
    ],
    projections: {
      episodeResultsSha256: sha256(resultsText),
      gameEvidenceSha256: sha256(gameEvidenceText),
      replayEvidenceSha256: sha256(replayText),
      commandReceiptsSha256: sha256(commandText),
    },
  };
  await writeJson(path.join(directory, "coworld-bundle-receipt.json"), receipt);
  void xpText;
  return { root, runDirectory, receipt };
}

async function writeJson(target: string, value: unknown): Promise<string> {
  const text = `${JSON.stringify(value)}\n`;
  await fs.writeFile(target, text);
  return text;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function externalCanonicalJson(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.keys(entry as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((entry as Record<string, unknown>)[key])]),
      );
    }
    return entry;
  };
  return `${JSON.stringify(sort(value))}\n`;
}
