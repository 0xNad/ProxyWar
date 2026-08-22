import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The manifest builder is an executable ESM helper without a
// declaration file; its own focused test verifies the same exported function.
import { commanderXpEvalManifest } from "../../coworld-adapter/scripts/prepare-commander-xp-eval-manifest.mjs";
import {
  buildCommanderXpPreRegistration,
  sha256Canonical,
  type CommanderXpPlanInput,
} from "../../src/server/agents/CommanderXpProtocol";
import { verifyCommanderXpEvidence } from "../../src/server/agents/CommanderXpVerifier";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("Commander XP evidence verifier v2", () => {
  it("accepts a complete no-run preregistration envelope", async () => {
    const fixture = await buildPreregistrationFixture();

    await expect(verifyCommanderXpEvidence(fixture.evidenceRoot)).resolves.toEqual(
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

    const verification = await verifyCommanderXpEvidence(fixture.evidenceRoot);
    expect(verification).toMatchObject({
      integrityVerified: false,
      experimentUsable: false,
      phase: "preregistration",
      diagnostics: [{ code: "AUTHORITY_REQUEST_IDENTITY_MISMATCH" }],
    });
  });
});

async function buildPreregistrationFixture(): Promise<{
  envelopeRoot: string;
  evidenceRoot: string;
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
  const planInput: CommanderXpPlanInput = {
    experimentID: "commander-xp-v2-verifier-fixture",
    createdAt: "2026-08-22T13:00:00.000Z",
    behaviorSourceSha: "a69175a30577b3e516f09a2cb0960d4d129b3f33",
    behaviorSourceTreeSha: "b1b88e4a447acb885ed554592d3865af0178314f",
    adapterSourceSha: "2".repeat(40),
    adapterSourceTreeSha: "3".repeat(40),
    sourceDiffManifestSha256: "9".repeat(64),
    sourceProvenanceSha256: "a".repeat(64),
    policyBuildProvenanceDigest: `sha256:${"b".repeat(64)}`,
    gameBuildProvenanceDigest: `sha256:${"c".repeat(64)}`,
    coworldID: "cow_commander_xp_eval_fixture",
    coworldVersion: "0.0.1",
    coworldManifestSha256: sha256(evalManifestText),
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

  const policyInspectTexts = {
    A: JSON.stringify({ policyVersionID: "pvid-a", arm: "A" }),
    B: JSON.stringify({ policyVersionID: "pvid-b", arm: "B" }),
    C: JSON.stringify({ policyVersionID: "pvid-c", arm: "C" }),
  };
  const policyReceipt = {
    schemaVersion: 2,
    authority: "coworld-0.1.42-policy-inspect-v1",
    inspectedAt: "2026-08-22T13:01:00.000Z",
    policyImageID: "img_policy_fixture",
    platform: "linux/amd64",
    policyBuildProvenanceDigest: planInput.policyBuildProvenanceDigest,
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
  };
  const evalInspectText = JSON.stringify({
    coworldID: planInput.coworldID,
    manifestSha256: planInput.coworldManifestSha256,
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
      leagueBindingBeforeSha256:
        planInput.canonicalLeagueBindingSnapshotSha256,
      leagueBindingAfterSha256:
        planInput.canonicalLeagueBindingSnapshotSha256,
    },
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
      .map(([relative, contents]) => ({ path: relative, sha256: sha256(contents) }))
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
      headRepository: "0xNad/ProxyWar",
      event: "workflow_dispatch",
      ref: "refs/heads/main",
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
      aggregatePath: "commander-xp-preregistration-v2.json",
      aggregateSha256: sha256(preregText),
    },
    preregistrationReceipt: null,
    canaryReceipt: null,
  };
  await fs.writeFile(
    path.join(authorityRoot, "commander-xp-external-seal-request-v1.json"),
    JSON.stringify(authority),
    { flag: "wx" },
  );
  return { envelopeRoot, evidenceRoot };
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
