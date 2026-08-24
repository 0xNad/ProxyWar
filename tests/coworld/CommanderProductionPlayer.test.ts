import { describe, expect, it } from "vitest";

import {
  commanderBedrockRequest,
  commanderBedrockSidecarEndpoint,
  commanderRuntimeEnvironment,
} from "../../coworld-adapter/commander-starter/commander-player";

describe("Commander production player", () => {
  it("locks the provider request to the canary model and token cap", () => {
    expect(commanderBedrockRequest("choose")).toEqual({
      model: "us.anthropic.claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "choose" }],
    });
  });

  it.each([
    "https://127.0.0.1:1234",
    "http://bedrock.internal:1234",
    "http://127.0.0.1:1234/path",
    "http://user@127.0.0.1:1234",
    "http://127.0.0.1",
  ])("rejects a non-loopback or ambiguous Bedrock endpoint: %s", (endpoint) => {
    expect(() =>
      commanderBedrockSidecarEndpoint({
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: endpoint,
      }),
    ).toThrow("Commander Bedrock sidecar endpoint is invalid");
  });

  it("accepts only the exact Coworld Bedrock model and returns the fixed profile", () => {
    expect(
      commanderRuntimeEnvironment({
        USE_BEDROCK: "true",
        BEDROCK_MODEL: "us.anthropic.claude-sonnet-4-6",
        AWS_REGION: "us-east-1",
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "http://127.0.0.1:4567",
      }),
    ).toEqual({
      profile: "aggressive",
      region: "us-east-1",
      endpoint: "http://127.0.0.1:4567",
    });
  });

  it("rejects a different model", () => {
    expect(() =>
      commanderRuntimeEnvironment({
        USE_BEDROCK: "true",
        BEDROCK_MODEL: "different-model",
        AWS_REGION: "us-east-1",
        AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "http://127.0.0.1:4567",
      }),
    ).toThrow("Commander requires the exact Coworld Bedrock model");
  });
});
