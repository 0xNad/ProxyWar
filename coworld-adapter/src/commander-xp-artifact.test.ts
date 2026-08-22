import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import {
  COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT,
  COMMANDER_XP_COMMANDER_PROMPT_VERSION,
  COMMANDER_XP_COMMANDER_PROMPT_VERSION_SHA256,
  sha256Canonical,
} from "../../src/server/agents/CommanderXpProtocol";
import {
  CommanderXpTraceCollector,
  uploadCommanderXpPlayerArtifact,
  type CommanderXpRuntimeManifest,
} from "./commander-xp-artifact";
import { commanderExecutionEnvelope } from "./coworld-decision-wire";

const manifest: CommanderXpRuntimeManifest = {
  schemaVersion: 2,
  artifactKind: "commander-xp-policy-evidence",
  arm: "C",
  gameID: "PWSAAAAA",
  runKey: "commander-xp-v2/artifact-test/canary/r00/C",
  behaviorSourceSha: "a69175a30577b3e516f09a2cb0960d4d129b3f33",
  behaviorSourceTreeSha: "1".repeat(40),
  adapterSourceSha: "2".repeat(40),
  adapterSourceTreeSha: "3".repeat(40),
  sourceProvenanceSha256: "4".repeat(64),
  imageDigest: null,
  policyVersionID: null,
  policyIdentityAuthority:
    "external-policy-inspect-and-xp-participant-metadata",
  requestedModel: "us.anthropic.claude-sonnet-4-6",
  providerContract: structuredClone(COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT),
  commanderPromptVersion: COMMANDER_XP_COMMANDER_PROMPT_VERSION,
  commanderPromptVersionSha256: COMMANDER_XP_COMMANDER_PROMPT_VERSION_SHA256,
  runArgv: ["node", "commander-xp-player.ts", "--arm=C"],
  flags: {
    STRUCTURED_DEALS: "0",
    FREETEXT_MESSAGES: "0",
    SPATIAL_OBSERVATION: "0",
    SPATIAL_MINIMAP: "0",
    KEYSTONE_PROFILE: "aggressive",
    LLM_TIMEOUT_MS: "12000",
  },
  providerPreflight: {
    required: true,
    status: "succeeded",
    requestID: "provider-preflight-111111111111111111111111",
    requestedModel: "us.anthropic.claude-sonnet-4-6",
    responseModel: "us.anthropic.claude-sonnet-4-6",
    succeeded: true,
  },
};

describe("Commander XP player artifact", () => {
  it("stores only hashed provider material and omits message bodies", async () => {
    const collector = new CommanderXpTraceCollector();
    collector.provider({
      requestID: "req-1",
      stage: "selector",
      provider: "bedrock-sidecar",
      providerContractSha256: sha256Canonical(
        COMMANDER_XP_BEDROCK_PROVIDER_CONTRACT,
      ),
      promptVersion: COMMANDER_XP_COMMANDER_PROMPT_VERSION,
      promptVersionSha256: COMMANDER_XP_COMMANDER_PROMPT_VERSION_SHA256,
      requestedModel: manifest.requestedModel,
      responseModel: manifest.requestedModel,
      promptSha256: "1".repeat(64),
      promptCharacters: 100,
      outputSha256: "2".repeat(64),
      outputCharacters: 40,
      succeeded: true,
      failureKind: null,
    });
    const commanderMetadata = {
      runtimeMode: "commander-v0-selector",
      commanderFidelity: "aligned_primary",
      externalRawOutput: "PRIVATE RAW",
    };
    const commanderExecution = commanderExecutionEnvelope(commanderMetadata)!;
    collector.decision({
      requestID: "req-1",
      arm: "C",
      preSelectorObservationSha256: "3".repeat(64),
      preSelectorLegalActionSurfaceSha256: "4".repeat(64),
      legalActions: [
        { id: "hold:1", kind: "hold" },
        { id: "message:2", kind: "message" },
      ],
      decision: {
        actionID: "hold:1",
        actionIDs: ["hold:1", "unsent:3"],
        messageActionID: "message:2",
        messageText: "PRIVATE BODY",
        metadata: commanderMetadata,
      },
      response: {
        type: "decision_response",
        requestID: "req-1",
        selectedLegalActionId: "hold:1",
        selectedMessageActionId: "message:2",
        messageText: "PRIVATE BODY",
        runtimeMode: "commander-v0-selector",
        commanderExecution,
      },
    });
    let uploaded: Uint8Array | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        uploaded = init?.body as Uint8Array;
        return new Response("", { status: 200 });
      }),
    );
    await uploadCommanderXpPlayerArtifact({
      uploadURL: "https://upload.invalid/artifact",
      manifest,
      trace: collector.records(),
    });
    const zip = await JSZip.loadAsync(uploaded!);
    const trace = await zip.file("trace.jsonl")!.async("string");
    expect(trace).toContain("message:2");
    expect(trace).toContain(
      `"preSelectorObservationSha256":"${"3".repeat(64)}"`,
    );
    expect(trace).toContain(
      `"preSelectorLegalActionSurfaceSha256":"${"4".repeat(64)}"`,
    );
    expect(trace).not.toContain("PRIVATE");
    expect(trace).not.toContain("messageText");
    expect(trace).not.toContain("externalRawOutput");
    expect(trace).not.toContain("unsent:3");
    expect(trace).toContain(
      `"commanderExecutionSha256":"${commanderExecution.metadataSha256}"`,
    );
    vi.unstubAllGlobals();
  });

  it("rejects a wire Commander envelope that diverges from the authored decision", () => {
    const collector = new CommanderXpTraceCollector();
    const authored = {
      runtimeMode: "commander-v0-selector",
      planID: "plan-authored",
      planObjective: "survive",
    };
    const wire = commanderExecutionEnvelope({
      ...authored,
      planObjective: "pressure_rival:forged",
    });
    expect(() =>
      collector.decision({
        requestID: "req-diverged",
        arm: "C",
        preSelectorObservationSha256: "1".repeat(64),
        preSelectorLegalActionSurfaceSha256: "2".repeat(64),
        legalActions: [{ id: "hold:1", kind: "hold" }],
        decision: { actionID: "hold:1", metadata: authored },
        response: {
          selectedLegalActionId: "hold:1",
          commanderExecution: wire,
        },
      }),
    ).toThrow(/wire execution envelope diverged/);
  });
});
