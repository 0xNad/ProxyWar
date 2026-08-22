import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import {
  CommanderXpTraceCollector,
  uploadCommanderXpPlayerArtifact,
  type CommanderXpRuntimeManifest,
} from "./commander-xp-artifact";

const manifest: CommanderXpRuntimeManifest = {
  schemaVersion: 2,
  artifactKind: "commander-xp-policy-evidence",
  arm: "C",
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
  runArgv: ["node", "commander-xp-player.ts", "--arm=C"],
  flags: {
    STRUCTURED_DEALS: "1",
    FREETEXT_MESSAGES: "1",
    SPATIAL_OBSERVATION: "0",
    SPATIAL_MINIMAP: "0",
  },
  providerPreflight: {
    required: true,
    requestID: "provider-preflight",
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
      requestedModel: manifest.requestedModel,
      responseModel: manifest.requestedModel,
      promptSha256: "1".repeat(64),
      promptCharacters: 100,
      outputSha256: "2".repeat(64),
      outputCharacters: 40,
      succeeded: true,
      failureKind: null,
    });
    collector.decision({
      requestID: "req-1",
      arm: "C",
      legalActions: [
        { id: "hold:1", kind: "hold" },
        { id: "message:2", kind: "message" },
      ],
      decision: {
        actionID: "hold:1",
        actionIDs: ["hold:1", "unsent:3"],
        messageActionID: "message:2",
        messageText: "PRIVATE BODY",
        metadata: {
          runtimeMode: "commander-v0-selector",
          commanderFidelity: "aligned_primary",
          externalRawOutput: "PRIVATE RAW",
        },
      },
      response: {
        type: "decision_response",
        requestID: "req-1",
        selectedLegalActionId: "hold:1",
        selectedMessageActionId: "message:2",
        messageText: "PRIVATE BODY",
        runtimeMode: "commander-v0-selector",
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
    expect(trace).not.toContain("PRIVATE");
    expect(trace).not.toContain("messageText");
    expect(trace).not.toContain("externalRawOutput");
    expect(trace).not.toContain("unsent:3");
    vi.unstubAllGlobals();
  });
});
