import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("canonical Coworld starter supply chain", () => {
  const starter = path.join(
    process.cwd(),
    "coworld-adapter",
    "tester-starter-llm",
  );

  it("pins direct packages and commits a matching npm lockfile", async () => {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(starter, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    const lock = JSON.parse(
      await fs.readFile(path.join(starter, "package-lock.json"), "utf8"),
    ) as {
      lockfileVersion: number;
      packages: Record<string, { dependencies?: Record<string, string> }>;
    };

    expect(packageJson.dependencies).toEqual({
      ws: "8.21.3",
      "@anthropic-ai/bedrock-sdk": "0.33.1",
    });
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""]?.dependencies).toEqual(packageJson.dependencies);
  });

  it("pins the base image and installs only from the lockfile", async () => {
    const dockerfile = await fs.readFile(
      path.join(starter, "Dockerfile"),
      "utf8",
    );

    expect(dockerfile).toMatch(
      /^FROM node:24-bookworm-slim@sha256:[a-f0-9]{64}$/m,
    );
    expect(dockerfile).toContain("COPY package.json package-lock.json ./");
    expect(dockerfile).toContain("RUN npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).not.toMatch(/\b(?:npm|pnpm|yarn) install\b/);
  });

  it("pins hosted CLIs and never executes a mutable remote installer", async () => {
    const launch = await fs.readFile(path.join(starter, "launch.sh"), "utf8");

    expect(launch).toContain('COWORLD_PACKAGE="coworld==0.1.42"');
    expect(launch).toContain('SOFTMAX_CLI_PACKAGE="softmax-cli==0.26.30"');
    expect(launch).not.toMatch(/curl[^\n|]*\|\s*(?:sh|bash)/);
    expect(launch).not.toMatch(/uvx\s+(?:coworld|softmax)\b/);
  });
});
