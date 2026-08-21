import { describe, expect, it } from "vitest";
import { keystoneBedrockClientOptions } from "../../coworld-adapter/src/keystone-player";
// The competitive reference player is JavaScript by design.
// @ts-expect-error no declaration file is shipped for this policy entrypoint.
import { bedrockClientOptions } from "../../coworld-adapter/src/llm-player.mjs";

describe("Coworld Bedrock sidecar endpoint", () => {
  const sidecarEnv = {
    AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "  http://127.0.0.1:9100  ",
  };

  it("propagates the hosted sidecar endpoint in both policy clients", () => {
    const expected = {
      awsRegion: "us-east-1",
      baseURL: "http://127.0.0.1:9100",
    };
    expect(keystoneBedrockClientOptions("us-east-1", sidecarEnv)).toEqual(
      expected,
    );
    expect(bedrockClientOptions("us-east-1", sidecarEnv)).toEqual(expected);
  });

  it("preserves direct-AWS behavior when the endpoint is absent or blank", () => {
    for (const env of [{}, { AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "   " }]) {
      expect(keystoneBedrockClientOptions("us-west-2", env)).toEqual({
        awsRegion: "us-west-2",
      });
      expect(bedrockClientOptions("us-west-2", env)).toEqual({
        awsRegion: "us-west-2",
      });
    }
  });

  it("uses the caller's immutable env snapshot, not ambient process state", () => {
    const previous = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
    process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = "http://ambient.invalid";
    try {
      expect(keystoneBedrockClientOptions("eu-west-1", sidecarEnv)).toEqual({
        awsRegion: "eu-west-1",
        baseURL: "http://127.0.0.1:9100",
      });
      expect(bedrockClientOptions("eu-west-1", sidecarEnv)).toEqual({
        awsRegion: "eu-west-1",
        baseURL: "http://127.0.0.1:9100",
      });
    } finally {
      if (previous === undefined) {
        delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
      } else {
        process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = previous;
      }
    }
  });
});
