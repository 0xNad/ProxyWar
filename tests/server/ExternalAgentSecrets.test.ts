import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  normalizeExternalAgentTokenInput,
  resolveExternalAgentToken,
  storeExternalAgentTokenSecret,
  validateExternalAgentTokenReference,
} from "../../src/server/agents/ExternalAgentSecrets";

describe("ExternalAgentSecrets", () => {
  it("normalizes direct tokens and env token references", () => {
    expect(normalizeExternalAgentTokenInput(" secret ")).toEqual({
      token: "secret",
    });
    expect(
      normalizeExternalAgentTokenInput("env:PROXYWAR_AGENT_TOKEN"),
    ).toEqual({
      tokenEnv: "PROXYWAR_AGENT_TOKEN",
    });
    expect(normalizeExternalAgentTokenInput("secret:agent_abc12345")).toEqual({
      tokenSecret: "agent_abc12345",
    });
    expect(normalizeExternalAgentTokenInput("")).toEqual({});
  });

  it("rejects unsafe env reference names and mixed token inputs", () => {
    expect(() => normalizeExternalAgentTokenInput("env:bad-name")).toThrow(
      /env reference/,
    );
    expect(() => normalizeExternalAgentTokenInput("secret:bad")).toThrow(
      /secret reference/,
    );
    expect(() =>
      validateExternalAgentTokenReference(
        { token: "secret", tokenEnv: "PROXYWAR_AGENT_TOKEN" },
        "manifest",
      ),
    ).toThrow(/only one/);
  });

  it("resolves env token references without exposing the value in manifests", () => {
    expect(
      resolveExternalAgentToken(
        { tokenEnv: "PROXYWAR_AGENT_TOKEN" },
        { PROXYWAR_AGENT_TOKEN: " resolved-secret " },
      ),
    ).toBe("resolved-secret");
    expect(() =>
      resolveExternalAgentToken(
        { tokenEnv: "PROXYWAR_AGENT_TOKEN" },
        {},
      ),
    ).toThrow(/not configured/);
  });

  it("stores and resolves local secret references outside saved manifests", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "of-secret-"));
    const storePath = path.join(rootDir, "external-agent-tokens.json");
    try {
      const reference = await storeExternalAgentTokenSecret(" stored-secret ", {
        storePath,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        label: "Remote Frontier",
      });

      expect(reference.tokenSecret).toMatch(/^agent_/);
      expect(
        resolveExternalAgentToken(reference, {}, { storePath }),
      ).toBe("stored-secret");
      const stored = JSON.parse(await fs.readFile(storePath, "utf8")) as {
        secrets: Record<string, { token: string; label: string }>;
      };
      expect(stored.secrets[reference.tokenSecret ?? ""]?.token).toBe(
        "stored-secret",
      );
      expect(stored.secrets[reference.tokenSecret ?? ""]?.label).toBe(
        "Remote Frontier",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
