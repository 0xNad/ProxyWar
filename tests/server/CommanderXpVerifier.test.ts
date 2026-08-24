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
  buildCommanderXpConfirmatoryAnalysisEvidence,
  renderCommanderXpConfirmatoryAnalysisMarkdown,
  type CommanderXpVerifiedOutcome,
} from "../../src/server/agents/CommanderXpAnalysis";
import {
  buildCommanderXpPreRegistration,
  COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT,
  COMMANDER_XP_COMMANDER_METADATA_ALLOWLIST,
  COMMANDER_XP_OPENAPI_SHA256,
  commanderXpProviderPreflightRequestID,
  sha256Canonical,
  type CommanderXpPlanInput,
} from "../../src/server/agents/CommanderXpProtocol";
import {
  assertCommanderXpExternalPhaseReceiptDocument,
  verifyCommanderXpConfirmatoryAnalysisArtifacts,
  verifyCommanderXpCoworldBundleProjection,
  verifyCommanderXpEvidence,
  verifyCommanderXpJoinedGameplayEvidence,
  verifyCommanderXpJoinedGameplayEvidenceAudit,
  verifyCommanderXpMatchedInitialSelectorSurfaces,
  verifyCommanderXpMatchedRequestOrder,
  verifyCommanderXpServerAuthorizationChronology,
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
  it("requires server-created XP requests to follow the sealed phase authority", () => {
    expect(() =>
      verifyCommanderXpServerAuthorizationChronology(
        "provider-preflight",
        "2026-08-22T14:00:00.000Z",
        "2026-08-22T14:00:00.000Z",
      ),
    ).not.toThrow();
    expect(() =>
      verifyCommanderXpServerAuthorizationChronology(
        "provider-preflight",
        "2026-08-22T14:00:00.000Z",
        "2026-08-22T13:59:59.999Z",
      ),
    ).toThrow(/PREFLIGHT_STARTED_BEFORE_PREREGISTRATION_LEDGER/);
    expect(() =>
      verifyCommanderXpServerAuthorizationChronology(
        "gameplay",
        "2026-08-22T15:00:00.000Z",
        "2026-08-22T14:59:59.999Z",
      ),
    ).toThrow(/GAMEPLAY_STARTED_BEFORE_PROVIDER_PREFLIGHT_COMPLETED/);
  });

  it("uses server timestamps for pair chronology despite runner clock skew", () => {
    expect(() =>
      verifyCommanderXpMatchedRequestOrder("confirmatory", [
        {
          replicaIndex: 0,
          orderIndex: 0,
          submittedAt: "2026-08-22T14:05:00.000Z",
          createdAt: "2026-08-22T14:00:00.000Z",
          completedAt: "2026-08-22T14:01:00.000Z",
        },
        {
          replicaIndex: 0,
          orderIndex: 1,
          submittedAt: "2026-08-22T13:55:00.000Z",
          createdAt: "2026-08-22T14:02:00.000Z",
          completedAt: "2026-08-22T14:03:00.000Z",
        },
      ]),
    ).not.toThrow();
    expect(() =>
      verifyCommanderXpMatchedRequestOrder("confirmatory", [
        {
          replicaIndex: 0,
          orderIndex: 0,
          submittedAt: "2026-08-22T14:00:00.000Z",
          createdAt: "2026-08-22T14:00:00.000Z",
          completedAt: "2026-08-22T14:03:00.000Z",
        },
        {
          replicaIndex: 0,
          orderIndex: 1,
          submittedAt: "2026-08-22T14:01:00.000Z",
          createdAt: "2026-08-22T14:02:00.000Z",
          completedAt: "2026-08-22T14:04:00.000Z",
        },
      ]),
    ).toThrow(/MATCHED_REQUEST_TIMESTAMP_ORDER_MISMATCH/);
  });

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

  it("accepts an exact policy adopted from authoritative current readback", async () => {
    const fixture = await buildPreregistrationFixture({
      adoptedPolicyArm: "A",
    });
    await expect(
      verifyCommanderXpEvidence(fixture.evidenceRoot),
    ).resolves.toEqual(
      expect.objectContaining({
        integrityVerified: true,
        phase: "preregistration",
      }),
    );
  });

  it("rejects a self-consistent Coworld runtime receipt for the wrong locked graph", async () => {
    const fixture = await buildPreregistrationFixture();
    const receiptPath = path.join(
      fixture.evidenceRoot,
      "coworld-runtime-inventory-v1.json",
    );
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    receipt.packageCount = 49;
    delete receipt.receiptSha256;
    const body = { ...receipt };
    receipt.receiptSha256 = sha256Canonical(body);
    const receiptText = `${JSON.stringify(receipt)}\n`;
    await fs.writeFile(receiptPath, receiptText);
    const indexPath = path.join(
      fixture.evidenceRoot,
      "commander-xp-evidence-index-v2.json",
    );
    const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
    index.artifacts.find(
      (artifact: { path: string }) =>
        artifact.path === "coworld-runtime-inventory-v1.json",
    ).sha256 = sha256(receiptText);
    await fs.writeFile(indexPath, JSON.stringify(index));
    const sealPath = path.join(
      fixture.evidenceRoot,
      "commander-xp-evidence-seal-v2.json",
    );
    const seal = JSON.parse(await fs.readFile(sealPath, "utf8"));
    seal.indexSha256 = sha256Canonical(index);
    delete seal.sealSha256;
    seal.sealSha256 = sha256Canonical(seal);
    await fs.writeFile(sealPath, JSON.stringify(seal));

    await expect(
      verifyCommanderXpEvidence(fixture.evidenceRoot),
    ).resolves.toMatchObject({
      integrityVerified: false,
      diagnostics: [{ code: "COWORLD_RUNTIME_INVENTORY_MISMATCH", path: null }],
    });
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
      fixture.spawnRequestID,
    ]);

    const tampered = gameplayJoinFixture(preregistration, "B", {
      injectGameplayProvider: true,
    });
    expect(() => verifyCommanderXpJoinedGameplayEvidence(tampered)).toThrow(
      /ARM_B_GAMEPLAY_PROVIDER_CALL_PRESENT/,
    );

    const continued = gameplayJoinFixture(preregistration, "B", {
      includeCachedContinuation: true,
    });
    expect(verifyCommanderXpJoinedGameplayEvidence(continued)).toEqual([
      continued.requestID,
      `${continued.requestID}-cached`,
      continued.spawnRequestID,
    ]);
    const switched = gameplayJoinFixture(preregistration, "B", {
      includeCachedContinuation: true,
      breakCachedPlanChain: true,
    });
    expect(() => verifyCommanderXpJoinedGameplayEvidence(switched)).toThrow(
      /ARM_B_PLAN_CONTINUITY_MISMATCH/,
    );
  });

  it("rejects every model, region, routing, endpoint, SDK and token-limit contract mismatch", async () => {
    const { preregistration } = await buildPreregistrationFixture();
    for (const [key, value] of [
      ["modelID", "anthropic.claude-sonnet-4-6"],
      ["region", "us-east-1"],
      ["routingAuthority", "direct-aws"],
      ["endpointAuthority", "public-bedrock-runtime"],
      ["sdkVersion", "0.29.1"],
      ["maxTokens", 2048],
    ] as const) {
      const fixture = gameplayJoinFixture(preregistration, "B");
      (fixture.runtimeManifest.providerContract as Record<string, unknown>)[
        key
      ] = value;
      expect(
        () => verifyCommanderXpJoinedGameplayEvidence(fixture),
        key,
      ).toThrow(/PLAYER_RUNTIME_IDENTITY_MISMATCH/);
    }
    const promptVersion = gameplayJoinFixture(preregistration, "C");
    promptVersion.runtimeManifest.commanderPromptVersion =
      "strategic-commander-unreviewed";
    expect(() =>
      verifyCommanderXpJoinedGameplayEvidence(promptVersion),
    ).toThrow(/PLAYER_RUNTIME_IDENTITY_MISMATCH/);
  });

  it("joins the exact C prompt hash and provider contract to game-owned execution evidence", async () => {
    const { preregistration } = await buildPreregistrationFixture();
    const fixture = gameplayJoinFixture(preregistration, "C");
    expect(() =>
      verifyCommanderXpJoinedGameplayEvidence(fixture),
    ).not.toThrow();

    const trace = fixture.playerTraceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const selectorProvider = trace.find(
      (entry) => entry.recordType === "provider" && entry.stage === "selector",
    )!;
    selectorProvider.providerContractSha256 = "0".repeat(64);
    fixture.playerTraceJsonl = `${trace
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    expect(() => verifyCommanderXpJoinedGameplayEvidence(fixture)).toThrow(
      /PROVIDER_FIDELITY_EXCLUSION/,
    );

    const promptTamper = gameplayJoinFixture(preregistration, "C");
    const promptTrace = promptTamper.playerTraceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const decision = promptTrace.find(
      (entry) =>
        entry.recordType === "decision" &&
        entry.runtimeMode === "commander-v0-selector",
    )!;
    decision.commander.commanderPromptSha256 = "9".repeat(64);
    decision.commanderExecutionSha256 = sha256Canonical(decision.commander);
    const games = promptTamper.gameEvidenceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const game = games.find((entry) => entry.chosen.kind !== "spawn")!;
    game.commander.commanderPromptSha256 = "9".repeat(64);
    game.commander.commanderExecutionSha256 = decision.commanderExecutionSha256;
    game.commander.commanderSelectionSha256 = commanderSelectionSha256(
      decision.commander,
    );
    promptTamper.playerTraceJsonl = `${promptTrace
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    promptTamper.gameEvidenceJsonl = `${games
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    expect(() => verifyCommanderXpJoinedGameplayEvidence(promptTamper)).toThrow(
      /ARM_C_SELECTOR_MISMATCH/,
    );
  });

  it("rejects a self-stamped aligned hold without canonical option identity", async () => {
    const { preregistration } = await buildPreregistrationFixture();
    const fixture = gameplayJoinFixture(preregistration, "B");
    const trace = fixture.playerTraceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const decision = trace.find((entry) => entry.recordType === "decision")!;
    decision.commander.planObjective = null;
    decision.commanderExecutionSha256 = sha256Canonical(decision.commander);
    const games = fixture.gameEvidenceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    games[0].commander.planObjective = null;
    games[0].commander.commanderExecutionSha256 =
      decision.commanderExecutionSha256;
    fixture.playerTraceJsonl = `${trace
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    fixture.gameEvidenceJsonl = `${games
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;

    expect(() => verifyCommanderXpJoinedGameplayEvidence(fixture)).toThrow(
      /ARM_B_OPTION_IDENTITY_MISMATCH/,
    );
  });

  it("forbids hard-emergency evidence in the preregistered selector-only scope", async () => {
    const { preregistration } = await buildPreregistrationFixture();
    expect(preregistration.featureScope).toEqual({
      evaluatedFeature: "selector-only-b-vs-c",
      hardEmergencyOverride: "excluded-empty-v0-set",
      hardEmergencyEvidence: "forbidden-zero-observed",
      fullStage5CompletionClaim: "not-authorized",
    });
    const fixture = gameplayJoinFixture(preregistration, "B");
    const trace = fixture.playerTraceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const decision = trace.find(
      (entry) =>
        entry.recordType === "decision" &&
        entry.runtimeMode === "commander-v0-selector",
    )!;
    decision.commander.commanderEmergencyCondition = "home_attacked";
    decision.commander.commanderFidelity = "hard_emergency_override";
    decision.commander.commanderBatchFidelities = JSON.stringify({
      "hold:fixture": "hard_emergency_override",
    });
    decision.commanderExecutionSha256 = sha256Canonical(decision.commander);
    const games = fixture.gameEvidenceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const game = games.find((entry) => entry.chosen.kind !== "spawn")!;
    game.commander.commanderExecutionSha256 = decision.commanderExecutionSha256;
    game.commander.commanderEmergencyCondition = "home_attacked";
    game.commander.commanderFidelity = "hard_emergency_override";
    fixture.playerTraceJsonl = `${trace
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    fixture.gameEvidenceJsonl = `${games
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;

    expect(() => verifyCommanderXpJoinedGameplayEvidence(fixture)).toThrow(
      /COMMANDER_FIDELITY_RECOMPUTATION_MISMATCH/,
    );
  });

  it("rejects player-authored Commander metadata that diverges from game-owned wire evidence", async () => {
    const { preregistration } = await buildPreregistrationFixture();
    const fixture = gameplayJoinFixture(preregistration, "C");
    const trace = fixture.playerTraceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const decision = trace.find((entry) => entry.recordType === "decision")!;
    decision.commander.planObjective = "pressure_rival:forged";
    decision.commander.commanderSelectedOptionID = "pressure_rival:forged";
    decision.commander.commanderSelectedOptionFamily = "pressure_rival";
    decision.commander.commanderEligibleOptionIds = "pressure_rival:forged";
    decision.commander.commanderExposedOptionIds = "pressure_rival:forged";
    decision.commander.commanderDeterministicPreferredOptionId =
      "pressure_rival:forged";
    decision.commander.commanderDeterministicPreferredOptionAbsent = false;
    decision.commanderExecutionSha256 = sha256Canonical(decision.commander);
    fixture.playerTraceJsonl = `${trace
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;

    expect(() => verifyCommanderXpJoinedGameplayEvidence(fixture)).toThrow(
      /COMMANDER_EXECUTION_WIRE_JOIN_MISMATCH/,
    );
  });

  it("requires matched B/C pre-selector surfaces while preserving distinct hosted pvids", () => {
    const surface = {
      observationSha256: "a".repeat(64),
      legalActionSurfaceSha256: "b".repeat(64),
      optionSurfaceSha256: "c".repeat(64),
      spawnAssignmentSha256: "e".repeat(64),
    };
    const matched = [
      {
        replicaIndex: 0,
        arm: "B" as const,
        subjectPolicyVersionID: "pvid_commander_b",
        surface,
      },
      {
        replicaIndex: 0,
        arm: "C" as const,
        subjectPolicyVersionID: "pvid_commander_c",
        surface: structuredClone(surface),
      },
    ];
    expect(() =>
      verifyCommanderXpMatchedInitialSelectorSurfaces(matched),
    ).not.toThrow();

    for (const key of [
      "observationSha256",
      "legalActionSurfaceSha256",
      "optionSurfaceSha256",
      "spawnAssignmentSha256",
    ] as const) {
      const tampered = structuredClone(matched);
      tampered[1]!.surface[key] = "d".repeat(64);
      expect(() =>
        verifyCommanderXpMatchedInitialSelectorSurfaces(tampered),
      ).toThrow(/MATCHED_INITIAL_SURFACE_MISMATCH/);
    }
    const aliasedPolicy = structuredClone(matched);
    aliasedPolicy[1]!.subjectPolicyVersionID = "pvid_commander_b";
    expect(() =>
      verifyCommanderXpMatchedInitialSelectorSurfaces(aliasedPolicy),
    ).toThrow(/MATCHED_INITIAL_SURFACE_MISMATCH/);
  });

  it("binds selected option identity and audits an eligible deterministic preference omitted from exposure", async () => {
    const { preregistration } = await buildPreregistrationFixture();
    const fixture = gameplayJoinFixture(preregistration, "C");
    const trace = fixture.playerTraceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const decision = trace.find(
      (entry) =>
        entry.recordType === "decision" &&
        entry.runtimeMode === "commander-v0-selector",
    )!;
    decision.commander.commanderEligibleOptionIds = "survive,expand";
    decision.commander.commanderExposedOptionIds = "survive";
    decision.commander.commanderDeterministicPreferredOptionId = "expand";
    decision.commander.commanderDeterministicPreferredOptionAbsent = true;
    decision.commanderExecutionSha256 = sha256Canonical(decision.commander);
    const games = fixture.gameEvidenceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const game = games.find((entry) => entry.chosen.kind !== "spawn")!;
    game.commander.commanderExecutionSha256 = decision.commanderExecutionSha256;
    game.commander.commanderDeterministicPreferredOptionId = "expand";
    game.commander.commanderDeterministicPreferredOptionAbsent = true;
    game.commander.commanderSelectionSha256 = commanderSelectionSha256(
      decision.commander,
    );
    fixture.playerTraceJsonl = `${trace
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    fixture.gameEvidenceJsonl = `${games
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    expect(() =>
      verifyCommanderXpJoinedGameplayEvidence(fixture),
    ).not.toThrow();
    expect(
      verifyCommanderXpJoinedGameplayEvidenceAudit(fixture).selectorAudit,
    ).toEqual({
      installedPlanCount: 1,
      selectedOptionDistribution: { survive: 1 },
      selectedOptionFamilyDistribution: { survive: 1 },
      deterministicPreferredAbsent: { count: 1, opportunities: 1 },
      selectorDisagreement: { count: 1, opportunities: 1 },
    });

    game.commander.commanderDeterministicPreferredOptionId = "develop_economy";
    fixture.gameEvidenceJsonl = `${games
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    expect(() => verifyCommanderXpJoinedGameplayEvidence(fixture)).toThrow(
      /COMMANDER_FIDELITY_INPUT_JOIN_MISMATCH/,
    );

    const falseAbsence = gameplayJoinFixture(preregistration, "C");
    const falseTrace = falseAbsence.playerTraceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const falseDecision = falseTrace.find(
      (entry) =>
        entry.recordType === "decision" &&
        entry.runtimeMode === "commander-v0-selector",
    )!;
    falseDecision.commander.commanderDeterministicPreferredOptionAbsent = true;
    falseDecision.commanderExecutionSha256 = sha256Canonical(
      falseDecision.commander,
    );
    const falseGames = falseAbsence.gameEvidenceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const falseGame = falseGames.find(
      (entry) => entry.chosen.kind !== "spawn",
    )!;
    falseGame.commander.commanderExecutionSha256 =
      falseDecision.commanderExecutionSha256;
    falseGame.commander.commanderSelectionSha256 = commanderSelectionSha256(
      falseDecision.commander,
    );
    falseGame.commander.commanderDeterministicPreferredOptionAbsent = true;
    falseAbsence.playerTraceJsonl = `${falseTrace
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    falseAbsence.gameEvidenceJsonl = `${falseGames
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    expect(() => verifyCommanderXpJoinedGameplayEvidence(falseAbsence)).toThrow(
      /ARM_C_OPTION_IDENTITY_MISMATCH/,
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
      fixture.spawnRequestID,
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

    const beyondHorizon = gameplayJoinFixture(preregistration, "C", {
      includeCachedContinuation: true,
    });
    const trace = beyondHorizon.playerTraceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const games = beyondHorizon.gameEvidenceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    let traceTemplate = [...trace]
      .reverse()
      .find(
        (entry) =>
          entry.recordType === "decision" &&
          entry.runtimeMode === "commander-v0-selector",
      )!;
    let gameTemplate = [...games]
      .reverse()
      .find((entry) => entry.chosen.kind !== "spawn")!;
    for (let age = 2; age <= 6; age += 1) {
      const nextTrace = {
        ...structuredClone(traceTemplate),
        requestID: `${beyondHorizon.requestID}-cached-${age}`,
        sequence: Math.max(...trace.map((entry) => entry.sequence)) + 1,
        commander: {
          ...structuredClone(traceTemplate.commander),
          commanderPlanAgeDecisions: age,
        },
      };
      nextTrace.commanderExecutionSha256 = sha256Canonical(nextTrace.commander);
      trace.push(nextTrace);
      const nextGame = {
        ...structuredClone(gameTemplate),
        requestID: `${beyondHorizon.requestID}-cached-${age}`,
        sequence: Math.max(...games.map((entry) => entry.sequence)) + 1,
        turnNumber: gameTemplate.turnNumber + 1,
        commander: {
          ...structuredClone(gameTemplate.commander),
          commanderPlanAgeDecisions: age,
        },
      };
      nextGame.commander.commanderExecutionSha256 =
        nextTrace.commanderExecutionSha256;
      games.push(nextGame);
      traceTemplate = nextTrace;
      gameTemplate = nextGame;
    }
    beyondHorizon.playerTraceJsonl = `${trace
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    beyondHorizon.gameEvidenceJsonl = `${games
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    expect(() =>
      verifyCommanderXpJoinedGameplayEvidence(beyondHorizon),
    ).toThrow(/ARM_C_PLAN_CONTINUITY_MISMATCH/);
  });

  it("validates every batch stamp while gating fidelity per primary cycle", async () => {
    const { preregistration } = await buildPreregistrationFixture();
    const fixture = gameplayJoinFixture(preregistration, "B");
    const trace = fixture.playerTraceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const decision = trace.find((entry) => entry.recordType === "decision");
    const targetID = "RIVAL001";
    const legalActions = [
      { id: "attack:fixture", kind: "attack" },
      { id: "embargo:followup", kind: "embargo" },
    ];
    decision.offeredLegalActions = legalActions;
    decision.offeredLegalActionSetSha256 = sha256Canonical(legalActions);
    decision.selectedLegalActionID = "attack:fixture";
    decision.selectedLegalActionIDs = ["attack:fixture", "embargo:followup"];
    decision.commander.planObjective = `pressure_rival:${targetID}`;
    decision.commander.commanderSelectedOptionID = `pressure_rival:${targetID}`;
    decision.commander.commanderSelectedOptionFamily = "pressure_rival";
    decision.commander.commanderEligibleOptionIds = `pressure_rival:${targetID}`;
    decision.commander.commanderExposedOptionIds = `pressure_rival:${targetID}`;
    decision.commander.commanderDeterministicPreferredOptionId = `pressure_rival:${targetID}`;
    decision.commander.batchIndex = 0;
    decision.commander.batchSize = 2;
    decision.commander.batchActionIDs = "attack:fixture,embargo:followup";
    decision.commander.commanderBatchFidelities = JSON.stringify({
      "attack:fixture": "aligned_primary",
      "embargo:followup": "aligned_support",
    });
    const games = fixture.gameEvidenceJsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const gameplayGames = games.filter(
      (entry) => entry.requestID === fixture.requestID,
    );
    gameplayGames[0].legalActions = legalActions;
    gameplayGames[0].offeredLegalActionSetSha256 =
      sha256Canonical(legalActions);
    gameplayGames[0].chosen = {
      id: "attack:fixture",
      kind: "attack",
      metadata: { targetID, expansion: false },
    };
    const attackIntent = { type: "attack", targetID, troops: 10 };
    gameplayGames[0].generatedIntent = {
      type: "attack",
      sha256: sha256Canonical(attackIntent),
      canonical: attackIntent,
    };
    gameplayGames[0].result.submittedIntent = structuredClone(
      gameplayGames[0].generatedIntent,
    );
    gameplayGames[0].commander = {
      ...gameplayGames[0].commander,
      planObjective: `pressure_rival:${targetID}`,
      commanderSelectedOptionID: `pressure_rival:${targetID}`,
      commanderSelectedOptionFamily: "pressure_rival",
      commanderDeterministicPreferredOptionId: `pressure_rival:${targetID}`,
      commanderDeterministicPreferredOptionAbsent: false,
      commanderFidelity: "aligned_primary",
      batchIndex: 0,
      batchSize: 2,
      batchActionIDs: "attack:fixture,embargo:followup",
    };
    const embargoIntent = { type: "embargo", targetID, action: "start" };
    const supportGame = {
      ...structuredClone(gameplayGames[0]),
      sequence: Math.max(...games.map((entry) => entry.sequence)) + 1,
      chosen: {
        id: "embargo:followup",
        kind: "embargo",
        metadata: { targetID, action: "start" },
      },
      generatedIntent: {
        type: "embargo",
        sha256: sha256Canonical(embargoIntent),
        canonical: embargoIntent,
      },
      result: {
        accepted: true,
        submittedIntent: {
          type: "embargo",
          sha256: sha256Canonical(embargoIntent),
          canonical: embargoIntent,
        },
      },
      commander: {
        ...structuredClone(gameplayGames[0].commander),
        commanderFidelity: "aligned_support",
        batchIndex: 1,
      },
    };
    games.push(supportGame);
    gameplayGames.push(supportGame);
    const syncExecutionHash = () => {
      decision.commanderExecutionSha256 = sha256Canonical(decision.commander);
      for (const game of gameplayGames) {
        game.commander.commanderExecutionSha256 =
          decision.commanderExecutionSha256;
        game.commander.commanderSelectionSha256 = commanderSelectionSha256(
          decision.commander,
        );
      }
      fixture.playerTraceJsonl = `${trace
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`;
      fixture.gameEvidenceJsonl = `${games
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`;
    };
    syncExecutionHash();
    fixture.playerTraceJsonl = `${trace
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    fixture.gameEvidenceJsonl = `${games
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    expect(verifyCommanderXpJoinedGameplayEvidence(fixture)).toEqual([
      fixture.requestID,
      fixture.spawnRequestID,
    ]);

    decision.commander.commanderBatchFidelities = JSON.stringify({
      "attack:fixture": "aligned_primary",
    });
    syncExecutionHash();
    fixture.playerTraceJsonl = `${trace
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    expect(() => verifyCommanderXpJoinedGameplayEvidence(fixture)).toThrow(
      /COMMANDER_BATCH_FIDELITY_MISMATCH/,
    );

    decision.commander.commanderBatchFidelities = JSON.stringify({
      "attack:fixture": "aligned_primary",
      "embargo:followup": "hold_plan_blocked",
    });
    syncExecutionHash();
    fixture.playerTraceJsonl = `${trace
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    expect(() => verifyCommanderXpJoinedGameplayEvidence(fixture)).toThrow(
      /COMMANDER_FIDELITY_RECOMPUTATION_MISMATCH/,
    );

    decision.commander.commanderBatchFidelities = JSON.stringify({
      "attack:fixture": "aligned_primary",
      "embargo:followup": "invented_fidelity_class",
    });
    syncExecutionHash();
    fixture.playerTraceJsonl = `${trace
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    expect(() => verifyCommanderXpJoinedGameplayEvidence(fixture)).toThrow(
      /COMMANDER_BATCH_FIDELITY_MISMATCH/,
    );

    decision.commander.commanderFidelity = "aligned_primary";
    decision.commander.commanderBatchFidelities = JSON.stringify({
      "attack:fixture": "aligned_primary",
      "embargo:followup": "aligned_support",
    });
    syncExecutionHash();
    const forgedIntent = {
      type: "build_unit",
      unit: "City",
      tile: 1,
    };
    const forgedLegalActions = [
      legalActions[0],
      { id: "embargo:followup", kind: "build" },
    ];
    decision.offeredLegalActions = forgedLegalActions;
    decision.offeredLegalActionSetSha256 = sha256Canonical(forgedLegalActions);
    for (const game of gameplayGames) {
      game.legalActions = forgedLegalActions;
      game.offeredLegalActionSetSha256 = sha256Canonical(forgedLegalActions);
    }
    gameplayGames[1].chosen = {
      id: "embargo:followup",
      kind: "build",
      metadata: { unit: "City", role: "economic" },
    };
    gameplayGames[1].generatedIntent = {
      type: "build_unit",
      sha256: sha256Canonical(forgedIntent),
      canonical: forgedIntent,
    };
    gameplayGames[1].result.submittedIntent = structuredClone(
      gameplayGames[1].generatedIntent,
    );
    fixture.gameEvidenceJsonl = `${games
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    fixture.playerTraceJsonl = `${trace
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    expect(() => verifyCommanderXpJoinedGameplayEvidence(fixture)).toThrow(
      /COMMANDER_FIDELITY_RECOMPUTATION_MISMATCH/,
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

  it("recomputes the exact 48-pair analysis and rejects identity, outcome, JSON, and Markdown tampering", async () => {
    const { preregistration } = await buildPreregistrationFixture();
    const outcomes = confirmatoryAnalysisOutcomes(preregistration);
    expect(outcomes.some((outcome) => !outcome.subjectWon)).toBe(true);
    const analysis = buildCommanderXpConfirmatoryAnalysisEvidence(
      preregistration,
      outcomes,
    );
    const markdown = renderCommanderXpConfirmatoryAnalysisMarkdown(analysis);
    expect(() =>
      verifyCommanderXpConfirmatoryAnalysisArtifacts(
        preregistration,
        outcomes,
        analysis,
        markdown,
      ),
    ).not.toThrow();
    expect(() =>
      verifyCommanderXpConfirmatoryAnalysisArtifacts(
        preregistration,
        structuredClone(outcomes).reverse(),
        analysis,
        markdown,
      ),
    ).not.toThrow();

    expect(() =>
      buildCommanderXpConfirmatoryAnalysisEvidence(
        preregistration,
        outcomes.slice(0, -1),
      ),
    ).toThrow(/outcomes are invalid/);
    expect(() =>
      buildCommanderXpConfirmatoryAnalysisEvidence(preregistration, [
        ...outcomes,
        structuredClone(outcomes[0]!),
      ]),
    ).toThrow(/outcomes are invalid/);

    const duplicatePair = structuredClone(outcomes);
    duplicatePair[3] = structuredClone(duplicatePair[1]!);
    expect(() =>
      buildCommanderXpConfirmatoryAnalysisEvidence(
        preregistration,
        duplicatePair,
      ),
    ).toThrow(/duplicated|incomplete|reused/);

    const duplicateID = structuredClone(outcomes);
    duplicateID[2]!.xpRequestID = duplicateID[0]!.xpRequestID;
    expect(() =>
      buildCommanderXpConfirmatoryAnalysisEvidence(
        preregistration,
        duplicateID,
      ),
    ).toThrow(/identity is reused/);

    const seedMismatch = structuredClone(outcomes);
    seedMismatch[1]!.seed += 1;
    expect(() =>
      buildCommanderXpConfirmatoryAnalysisEvidence(
        preregistration,
        seedMismatch,
      ),
    ).toThrow(/pair is incomplete/);

    const seedReuse = structuredClone(outcomes);
    seedReuse[2]!.seed = seedReuse[0]!.seed;
    seedReuse[3]!.seed = seedReuse[0]!.seed;
    expect(() =>
      buildCommanderXpConfirmatoryAnalysisEvidence(preregistration, seedReuse),
    ).toThrow(/pair seed is reused/);

    const subjectWonMismatch = structuredClone(outcomes);
    subjectWonMismatch[0]!.subjectWon = !subjectWonMismatch[0]!.subjectWon;
    expect(() =>
      buildCommanderXpConfirmatoryAnalysisEvidence(
        preregistration,
        subjectWonMismatch,
      ),
    ).toThrow(/outcomes are invalid/);

    const scoreTamper = structuredClone(outcomes);
    scoreTamper[0]!.score += 0.5;
    expect(() =>
      verifyCommanderXpConfirmatoryAnalysisArtifacts(
        preregistration,
        scoreTamper,
        analysis,
        markdown,
      ),
    ).toThrow(/CONFIRMATORY_ANALYSIS_ARTIFACT_MISMATCH/);

    const jsonTamper = structuredClone(analysis);
    jsonTamper.pairs[0]!.B.score += 1;
    expect(() =>
      verifyCommanderXpConfirmatoryAnalysisArtifacts(
        preregistration,
        outcomes,
        jsonTamper,
        markdown,
      ),
    ).toThrow(/CONFIRMATORY_ANALYSIS_ARTIFACT_MISMATCH/);
    const jsonHashTamper = structuredClone(analysis);
    jsonHashTamper.analysisSha256 = "f".repeat(64);
    expect(() =>
      verifyCommanderXpConfirmatoryAnalysisArtifacts(
        preregistration,
        outcomes,
        jsonHashTamper,
        markdown,
      ),
    ).toThrow(/CONFIRMATORY_ANALYSIS_ARTIFACT_MISMATCH/);
    const missingJsonPair = structuredClone(analysis);
    missingJsonPair.pairs.pop();
    expect(() =>
      verifyCommanderXpConfirmatoryAnalysisArtifacts(
        preregistration,
        outcomes,
        missingJsonPair,
        markdown,
      ),
    ).toThrow(/CONFIRMATORY_ANALYSIS_ARTIFACT_MISMATCH/);
    const extraJsonPair = structuredClone(analysis);
    extraJsonPair.pairs.push(structuredClone(extraJsonPair.pairs[0]!));
    expect(() =>
      verifyCommanderXpConfirmatoryAnalysisArtifacts(
        preregistration,
        outcomes,
        extraJsonPair,
        markdown,
      ),
    ).toThrow(/CONFIRMATORY_ANALYSIS_ARTIFACT_MISMATCH/);
    expect(() =>
      verifyCommanderXpConfirmatoryAnalysisArtifacts(
        preregistration,
        outcomes,
        analysis,
        `${markdown}tampered\n`,
      ),
    ).toThrow(/CONFIRMATORY_ANALYSIS_ARTIFACT_MISMATCH/);
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
    preregistrationReceipt.signerSourceSha = "9".repeat(40);
    preregistrationReceipt.attestationPolicy.sourceDigest =
      preregistrationReceipt.signerSourceSha;
    preregistrationReceipt.attestationPolicy.signerDigest =
      preregistrationReceipt.signerSourceSha;
    preregistrationReceipt.ledgerSha256 = sha256(
      externalCanonicalJson(
        Object.fromEntries(
          Object.entries(preregistrationReceipt).filter(
            ([key]) => key !== "ledgerSha256",
          ),
        ),
      ),
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
    signerSourceSha: preregistration.identities.adapterSourceSha,
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
    confirmatoryAnalysis: null,
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
    integrityVerified: true as const,
    experimentUsable: false,
    performanceClaimAuthorized: false,
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

async function buildPreregistrationFixture(
  options: {
    adoptedPolicyArm?: "A" | "B" | "C";
  } = {},
): Promise<{
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
  const policyDigest = `sha256:${"4".repeat(64)}`;
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
    gameImage: `proxywar-coworld-commander-xp-game@${gameDigest}`,
    playerImage: `ghcr.io/0xnad/proxywar-commander-xp-policy@${policyDigest}`,
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
    imageDigest: policyDigest,
    bedrockModel: "us.anthropic.claude-sonnet-4-6",
    xpOpenApiSha256: COMMANDER_XP_OPENAPI_SHA256,
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
      const adopted = options.adoptedPolicyArm === arm;
      const requestPayload = {
        name: policyImage.name,
        client_hash: policyImage.client_hash,
      };
      const uploadBody = {
        schemaVersion: 3,
        authority: "coworld-0.1.42-policy-upload-readback-v3",
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
            keys: ["providerRegion", "modelID", "providerEnabled"],
            valuesSha256: sha256Canonical({
              AWS_REGION: COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT.region,
              BEDROCK_MODEL: planInput.bedrockModel,
              USE_BEDROCK: "true",
            }),
            attachmentResponseSha256: adopted ? null : "f".repeat(64),
          },
          creationMode: adopted
            ? "adopted-after-remote-success"
            : "immediate-response",
          plannedCompletionPayloadProjection: completionPayload,
          completionPayloadSha256: sha256Canonical(completionPayload),
          completionPayloadAuthority: adopted
            ? "source-and-fence-planned-recovery-v1"
            : "coworld-request-sent-and-responded-v1",
          completionResponse: adopted ? readback : completionResponse,
          completionResponseAuthority: adopted
            ? "coworld-current-policy-version-readback-v1"
            : "coworld-immediate-completion-response-v1",
          completionResponseSha256: adopted
            ? sha256Canonical(readback)
            : "1".repeat(64),
          completionResponseBytes: adopted
            ? Buffer.byteLength(JSON.stringify(readback))
            : 125,
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
    schemaVersion: 3,
    authority: "coworld-0.1.42-policy-provision-v3",
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
    player.image = policyImage.id;
  }
  const evalInspectText = JSON.stringify({
    coworld: {
      id: planInput.coworldID,
      name: "proxywar-commander-xp-eval",
      version: planInput.coworldVersion,
      manifest_hash: `sha256:${planInput.coworldHostedManifestSha256}`,
      canonical: true,
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
      PROXYWAR_TUNE_STRUCTURED_DEALS: "0",
      PROXYWAR_TUNE_FREETEXT_MESSAGES: "0",
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
  const openApiContractBody = {
    schemaVersion: 2,
    authority: "softmax-public-openapi-exact-bytes-v1",
    url: "https://softmax.com/api/observatory/openapi.json",
    fetchedAt: "2026-08-22T13:00:30.000Z",
    byteLength: 418_415,
    rawSha256: prereg.identities.xpOpenApiSha256,
    coworldClientVersion: "0.1.42",
    createRequestSchema: {
      name: "V2CreateExperienceRequestRequest",
      encoding: "jq-cS-utf8-compact-sorted-json-with-terminal-lf",
      sha256: prereg.identities.xpCreateRequestSchemaSha256,
    },
    rosterSchemas: {
      names: ["V2RosterParticipant", "V2RosterPlayer"],
      encoding:
        "ordered-concatenation-of-two-jq-cS-utf8-records-with-terminal-lf",
      sha256: prereg.identities.xpRosterSchemasSha256,
    },
  };
  const coworldRuntimeInventoryBody = {
    schemaVersion: 1,
    authority: "hash-locked-coworld-runtime-inventory-v1",
    sourceSha: prereg.identities.adapterSourceSha,
    sourceTreeSha: prereg.identities.adapterSourceTreeSha,
    coworldClientVersion: "0.1.42",
    uvVersion: "0.8.12",
    pythonVersion: "3.12",
    platform: "linux/amd64",
    requirementsInputSha256:
      "181df809f108068868fe32e487111ca5cfb45477d25f997fa1a8933ad15934ac",
    requirementsLockSha256:
      "5e83207f5ae2c16871e6dc12077058c8dc8b47ffcce6d81901e2beae69b6a9a2",
    inventorySha256:
      "796a8827eedc1ce1529003aabc3d6695a5bf34c036c7b23360ca93c6df46e98d",
    packageCount: 50,
  };

  const artifacts = new Map<string, string>([
    ["commander-xp-preregistration-v2.json", JSON.stringify(prereg)],
    ["commander-xp-source-provenance-v2.json", sourceProvenanceText],
    ["commander-xp-source-tree-diff-v1.json", sourceTreeDiffText],
    [
      "coworld-runtime-inventory-v1.json",
      JSON.stringify({
        ...coworldRuntimeInventoryBody,
        receiptSha256: sha256Canonical(coworldRuntimeInventoryBody),
      }),
    ],
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
      "xp-openapi-contract-v2.json",
      JSON.stringify({
        ...openApiContractBody,
        receiptSha256: sha256Canonical(openApiContractBody),
      }),
    ],
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

function exactCommanderWireMetadata(
  overrides: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    COMMANDER_XP_COMMANDER_METADATA_ALLOWLIST.map((key) => [
      key,
      overrides[key] ?? null,
    ]),
  );
}

function commanderSelectionSha256(commander: Record<string, unknown>): string {
  return sha256Canonical({
    planID: commander.planID ?? null,
    selectedOptionID: commander.commanderSelectedOptionID ?? null,
    selectedOptionFamily: commander.commanderSelectedOptionFamily ?? null,
    selectorSource: commander.commanderSelectorSource ?? null,
    deterministicPreferredOptionID:
      commander.commanderDeterministicPreferredOptionId ?? null,
    deterministicPreferredOptionAbsent:
      commander.commanderDeterministicPreferredOptionAbsent ?? null,
  });
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
  spawnRequestID: string;
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
    providerContractSha256: sha256Canonical(
      preregistration.identities.providerContract,
    ),
    promptVersion:
      arm === "C" && input.stage === "selector"
        ? preregistration.identities.commanderPromptVersion
        : null,
    promptVersionSha256:
      arm === "C" && input.stage === "selector"
        ? preregistration.identities.commanderPromptVersionSha256
        : null,
    requestedModel: preregistration.identities.bedrockModel,
    responseModel: preregistration.identities.providerContract.responseModelID,
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
  const initialObservationSha256 = sha256Canonical({
    gameID: expectedGameID,
    subjectSeat: plannedRequest.subjectSeat,
    phase: "active",
  });
  const initialLegalActionSurfaceSha256 = sha256Canonical([
    {
      id: "hold:fixture",
      kind: "hold",
      label: "Hold",
      intent: null,
      risk: { level: "none" },
    },
  ]);
  const optionSurfaceSha256 = sha256Canonical({
    candidates: [{ id: "survive", primaryActionIDs: ["hold:fixture"] }],
  });
  const primaryCommander = exactCommanderWireMetadata({
    runtimeMode: "commander-v0-selector",
    plannerSource: "strategic-commander-v0",
    executorSource: "strategic-option-executor-v0",
    actionSelectionSource: "strategic-option-binding",
    externalPlannerCall: arm === "C",
    commanderPrimarySelectorSource: arm === "B" ? "deterministic" : "llm",
    commanderSelectorSource: arm === "B" ? "deterministic" : "llm",
    commanderSelectorProvider: arm === "B" ? null : "custom",
    commanderSelectorModel:
      arm === "B" ? null : preregistration.identities.bedrockModel,
    commanderPromptVersion:
      arm === "C" ? preregistration.identities.commanderPromptVersion : null,
    commanderPromptSha256: arm === "C" ? "1".repeat(64) : null,
    commanderEligibleOptionIds: "survive",
    commanderExposedOptionIds: "survive",
    commanderOptionSurfaceSha256: optionSurfaceSha256,
    commanderFidelity: "aligned_primary",
    commanderBatchFidelities: JSON.stringify({
      "hold:fixture": "aligned_primary",
    }),
    planID: arm === "C" ? "plan-c-fixture" : "plan-b-fixture",
    planObjective: "survive",
    commanderSelectedOptionID: "survive",
    commanderSelectedOptionFamily: "survive",
    commanderPreviousPlanID: null,
    commanderFingerprint: "options:state",
    commanderPlanInstalled: true,
    commanderHorizonDecisions: 3,
    commanderPlanAgeDecisions: 0,
    commanderReplanReason: "no_active_plan",
    commanderEmergencyCondition: null,
    commanderDeterministicPreferredOptionId: "survive",
    commanderDeterministicPreferredOptionAbsent: false,
    batchIndex: 0,
    batchSize: 1,
    batchActionIDs: "hold:fixture",
  });
  const commanderExecutionSha256 = sha256Canonical(primaryCommander);
  trace.push({
    recordType: "decision",
    schemaVersion: 2,
    requestID,
    sequence: trace.length,
    arm,
    preSelectorObservationSha256: initialObservationSha256,
    preSelectorLegalActionSurfaceSha256: initialLegalActionSurfaceSha256,
    commanderExecutionSha256,
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
    commander: primaryCommander,
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
      chosen: { id: "hold:fixture", kind: "hold", metadata: {} },
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
      commander: {
        commanderExecutionSha256,
        commanderSelectionSha256: commanderSelectionSha256(primaryCommander),
        planID: arm === "C" ? "plan-c-fixture" : "plan-b-fixture",
        planObjective: "survive",
        commanderSelectedOptionID: "survive",
        commanderSelectedOptionFamily: "survive",
        commanderOptionSurfaceSha256: optionSurfaceSha256,
        commanderPreviousPlanID: null,
        commanderReplanReason: "no_active_plan",
        commanderPlanAgeDecisions: 0,
        commanderEmergencyCondition: null,
        commanderPromptVersion:
          arm === "C"
            ? preregistration.identities.commanderPromptVersion
            : null,
        commanderPromptSha256: arm === "C" ? "1".repeat(64) : null,
        commanderDeterministicPreferredOptionId: "survive",
        commanderDeterministicPreferredOptionAbsent: false,
        commanderFidelity: "aligned_primary",
        batchIndex: 0,
        batchSize: 1,
        batchActionIDs: "hold:fixture",
      },
    },
  ];
  if (options.includeCachedContinuation) {
    const cachedRequestID = `${requestID}-cached`;
    const cachedCommander = exactCommanderWireMetadata({
      ...primaryCommander,
      externalPlannerCall: false,
      commanderSelectorProvider: null,
      commanderSelectorModel: null,
      planID: options.breakCachedPlanChain
        ? `plan-${arm.toLowerCase()}-forged`
        : `plan-${arm.toLowerCase()}-fixture`,
      commanderPlanInstalled: false,
      commanderPlanAgeDecisions: 1,
      commanderReplanReason: "within_horizon",
      commanderPromptVersion: null,
      commanderPromptSha256: null,
    });
    const cachedExecutionSha256 = sha256Canonical(cachedCommander);
    trace.push({
      recordType: "decision",
      schemaVersion: 2,
      requestID: cachedRequestID,
      sequence: trace.length,
      arm,
      preSelectorObservationSha256: sha256Canonical({
        prior: initialObservationSha256,
        turn: 2,
      }),
      preSelectorLegalActionSurfaceSha256: initialLegalActionSurfaceSha256,
      commanderExecutionSha256: cachedExecutionSha256,
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
      commander: cachedCommander,
    });
    gameEvidence.push({
      ...gameEvidence[0],
      requestID: cachedRequestID,
      sequence: 1,
      turnNumber: 2,
      commander: {
        ...structuredClone(
          gameEvidence[0]!.commander as Record<string, unknown>,
        ),
        commanderExecutionSha256: cachedExecutionSha256,
        commanderSelectionSha256: commanderSelectionSha256(cachedCommander),
        planID: options.breakCachedPlanChain
          ? `plan-${arm.toLowerCase()}-forged`
          : `plan-${arm.toLowerCase()}-fixture`,
        commanderReplanReason: "within_horizon",
        commanderPlanAgeDecisions: 1,
        commanderPromptVersion: null,
        commanderPromptSha256: null,
      },
    });
  }
  const spawnRequestID = `${requestID}-spawn`;
  const spawnLegalActions = [{ id: "spawn:fixture", kind: "spawn" }];
  trace.push({
    recordType: "decision",
    schemaVersion: 2,
    requestID: spawnRequestID,
    sequence: trace.length,
    arm,
    preSelectorObservationSha256: sha256Canonical({
      gameID: expectedGameID,
      subjectSeat: plannedRequest.subjectSeat,
      phase: "spawn",
    }),
    preSelectorLegalActionSurfaceSha256: sha256Canonical(spawnLegalActions),
    commanderExecutionSha256: null,
    offeredLegalActions: spawnLegalActions,
    offeredLegalActionSetSha256: sha256Canonical(spawnLegalActions),
    selectedLegalActionID: "spawn:fixture",
    selectedLegalActionIDs: ["spawn:fixture"],
    selectedDealActionID: null,
    selectedMessageActionID: null,
    spawnPreferenceLegalActionIDs: ["spawn:fixture"],
    runtimeMode: null,
    fallbackUsed: false,
    llmPlannerDegraded: false,
    degradedCause: null,
    commander: {},
  });
  gameEvidence.push({
    schemaVersion: 2,
    runKey: plannedRequest.runKey,
    requestID: spawnRequestID,
    sequence: gameEvidence.length,
    gameID: expectedGameID,
    coworldSlot: plannedRequest.subjectSeat,
    agentID: `agent-${arm.toLowerCase()}`,
    turnNumber: 0,
    legalActions: spawnLegalActions,
    offeredLegalActionSetSha256: sha256Canonical(spawnLegalActions),
    chosen: { id: "spawn:fixture", kind: "spawn", metadata: {} },
    generatedIntent: null,
    result: { accepted: true, submittedIntent: null },
    audit: { status: "not_applicable", reasonSha256: null },
    spawn: {
      algorithmVersion: "sealed-ranked-v1",
      offeredActionIDs: ["spawn:fixture"],
      ballotSource: "submitted",
      submittedBallotActionIDs: ["spawn:fixture"],
      submittedBallotCount: 1,
      submittedBallotTruncated: false,
      normalizedBallotActionIDs: ["spawn:fixture"],
      ballotValid: true,
      ballotInvalidReason: null,
      defaultReason: null,
      priorityRank: 2,
      assignedActionID: "spawn:fixture",
      assignedPreferenceRank: 1,
      assignedSubmittedPreferenceRank: 1,
      stageFallbackUsed: false,
      stageDegraded: false,
    },
    deal: null,
    comms: {
      requestedID: null,
      actionID: null,
      recipientID: null,
      accepted: null,
      rejected: null,
    },
    commander: {
      commanderExecutionSha256: null,
      commanderSelectionSha256: null,
      planID: null,
      planObjective: null,
      commanderSelectedOptionID: null,
      commanderSelectedOptionFamily: null,
      commanderOptionSurfaceSha256: null,
      commanderPreviousPlanID: null,
      commanderReplanReason: null,
      commanderPlanAgeDecisions: null,
      commanderEmergencyCondition: null,
      commanderPromptVersion: null,
      commanderPromptSha256: null,
      commanderDeterministicPreferredOptionId: null,
      commanderDeterministicPreferredOptionAbsent: null,
      commanderFidelity: null,
      batchIndex: null,
      batchSize: null,
      batchActionIDs: null,
    },
  });
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
    providerContract: structuredClone(COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT),
    commanderPromptVersion: preregistration.identities.commanderPromptVersion,
    commanderPromptVersionSha256:
      preregistration.identities.commanderPromptVersionSha256,
    runArgv: preregistration.identities.runArgv[arm],
    flags: preregistration.fixedFlags,
    providerPreflight: {
      required: true,
      status: "succeeded",
      requestID: commanderXpProviderPreflightRequestID(plannedRequest.runKey),
      requestedModel: preregistration.identities.bedrockModel,
      responseModel:
        preregistration.identities.providerContract.responseModelID,
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
    spawnRequestID,
  };
}

function confirmatoryAnalysisOutcomes(
  preregistration: ReturnType<typeof buildCommanderXpPreRegistration>,
): CommanderXpVerifiedOutcome[] {
  return preregistration.requests
    .filter((request) => request.phase === "confirmatory")
    .map((request) => {
      const subjectWon =
        request.arm === "B"
          ? request.replicaIndex % 4 === 0
          : request.replicaIndex % 3 === 0;
      return {
        replicaIndex: request.replicaIndex,
        arm: request.arm,
        seed: request.seed,
        xpRequestID: `xreq_analysis-${request.arm}-${request.replicaIndex}`,
        episodeRequestID: `ereq_analysis-${request.arm}-${request.replicaIndex}`,
        jobID: `job_analysis-${request.arm}-${request.replicaIndex}`,
        episodeID: `episode_analysis-${request.arm}-${request.replicaIndex}`,
        subjectSeat: request.subjectSeat,
        winnerSlot: subjectWon
          ? request.subjectSeat
          : (request.subjectSeat + 1) % 4,
        subjectWon,
        score: subjectWon ? 1 : 0,
        selectorAudit: {
          installedPlanCount: 1,
          selectedOptionDistribution: { survive: 1 },
          selectedOptionFamilyDistribution: { survive: 1 },
          deterministicPreferredAbsent: { count: 0, opportunities: 1 },
          selectorDisagreement: {
            count: 0,
            opportunities: request.arm === "C" ? 1 : 0,
          },
        },
      };
    });
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
