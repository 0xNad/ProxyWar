import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

describe("Open Frontier public beta onboarding docs", () => {
  it("keeps start-here, external-agent examples, and asset audit available", async () => {
    const root = process.cwd();
    const [
      packageJson,
      startHere,
      externalApi,
      publicDemo,
      operatorRunbook,
      remoteBeta,
      assetAudit,
      exampleReadme,
      exampleAgentCard,
      exampleAgent,
      exampleSmokeTest,
      examplePolicy,
      starterFramework,
      exampleManifest,
      examplePackage,
      exampleEnv,
      exampleLicense,
      exampleSkill,
    ] = await Promise.all([
      fs.readFile(path.join(root, "package.json"), "utf8"),
      fs.readFile(path.join(root, "docs", "OPEN_FRONTIER_START_HERE.md"), "utf8"),
      fs.readFile(
        path.join(root, "docs", "OPEN_FRONTIER_EXTERNAL_AGENT_API.md"),
        "utf8",
      ),
      fs.readFile(path.join(root, "docs", "OPEN_FRONTIER_PUBLIC_DEMO.md"), "utf8"),
      fs.readFile(
        path.join(root, "docs", "OPEN_FRONTIER_OPERATOR_RUNBOOK.md"),
        "utf8",
      ),
      fs.readFile(path.join(root, "docs", "REMOTE_FRIENDS_BETA.md"), "utf8"),
      fs.readFile(
        path.join(root, "docs", "OPEN_FRONTIER_ASSET_AND_LICENSE_AUDIT.md"),
        "utf8",
      ),
      fs.readFile(path.join(root, "examples", "external-agent", "README.md"), "utf8"),
      fs.readFile(
        path.join(root, "examples", "external-agent", "OPEN_FRONTIER_AGENT_CARD.md"),
        "utf8",
      ),
      fs.readFile(
        path.join(root, "examples", "external-agent", "simple-agent.mjs"),
        "utf8",
      ),
      fs.readFile(
        path.join(root, "examples", "external-agent", "smoke-test.mjs"),
        "utf8",
      ),
      fs.readFile(
        path.join(root, "examples", "external-agent", "agent-policy.mjs"),
        "utf8",
      ),
      fs.readFile(
        path.join(root, "examples", "external-agent", "starter-framework.mjs"),
        "utf8",
      ),
      fs.readFile(
        path.join(root, "examples", "external-agent", "manifest.example.json"),
        "utf8",
      ),
      fs.readFile(
        path.join(root, "examples", "external-agent", "package.json"),
        "utf8",
      ),
      fs.readFile(
        path.join(root, "examples", "external-agent", ".env.example"),
        "utf8",
      ),
      fs.readFile(
        path.join(root, "examples", "external-agent", "LICENSE"),
        "utf8",
      ),
      fs.readFile(
        path.join(root, "examples", "external-agent", "AGENT_SKILL.md"),
        "utf8",
      ),
    ]);

    const scripts = (JSON.parse(packageJson) as { scripts: Record<string, string> })
      .scripts;

    expect(scripts["agent:external-agent:dry-run"]).toContain(
      "open-frontier-external-agent-dry-run.ts",
    );
    expect(scripts["agent:public-readiness"]).toContain(
      "open-frontier-public-readiness.ts",
    );
    expect(startHere).toContain("npm run agent:demo-server");
    expect(startHere).toContain("/api/public-readiness");
    expect(startHere).toContain("agent:public-readiness:strict");
    expect(startHere).toContain("npm run agent:external-agent:dry-run");
    expect(startHere).toContain("LegalAction.id");
    expect(externalApi).toContain("examples/external-agent/simple-agent.mjs");
    expect(externalApi).toContain("Agent Card");
    expect(externalApi).toContain("createHealthResponse");
    expect(externalApi).toContain("unknown JSON field: actionId");
    expect(externalApi).toContain("npm run self-test");
    expect(externalApi).toContain("npm run agent:external-agent:dry-run");
    expect(publicDemo).toContain("OPEN_FRONTIER_START_HERE.md");
    expect(publicDemo).toContain("/examples/external-agent/simple-agent.mjs");
    expect(publicDemo).toContain("agent:external-agent:dry-run");
    expect(publicDemo).toContain("raw run-directory serving is restricted");
    expect(publicDemo).toContain("/api/public-readiness");
    expect(publicDemo).toContain("agent:public-readiness:strict");
    expect(operatorRunbook).toContain("Release Candidate Checklist");
    expect(operatorRunbook).toContain("/api/public-readiness");
    expect(operatorRunbook).toContain("agent:public-readiness:strict");
    expect(operatorRunbook).toContain("Test Endpoint");
    expect(operatorRunbook).toContain("Run Saved-Roster Match");
    expect(remoteBeta).toContain("Connect With One Link");
    expect(remoteBeta).toContain("allowlisted artifact names");
    expect(remoteBeta).toContain("/examples/external-agent/AGENT_SKILL.md");
    expect(remoteBeta).toContain("npm run self-test");
    expect(remoteBeta).toContain("agent:external-agent:dry-run");
    expect(remoteBeta).toContain("agent:public-readiness:strict");
    expect(assetAudit).toContain("AGPL v3");
    expect(assetAudit).toContain("LICENSE-ASSETS");
    expect(exampleReadme).toMatch(/Test\s+Endpoint/);
    expect(exampleReadme).toContain("OPEN_FRONTIER_AGENT_CARD.md");
    expect(exampleReadme).toContain("npm run agent:external-agent:dry-run");
    expect(exampleReadme).toContain("starter-framework.mjs");
    expect(exampleReadme).toContain("Template Package Readiness");
    expect(exampleReadme).toContain("/agent-card.md");
    expect(exampleReadme).toContain("URL Map");
    expect(exampleReadme).toContain("unknown JSON field: actionId");
    expect(exampleReadme).toContain("OPEN_FRONTIER_AGENT_PUBLIC_URL");
    expect(exampleReadme).toContain("LLM-backed");
    expect(exampleReadme).toContain("Codex CLI");
    expect(exampleReadme).toContain("Claude/Cowork");
    expect(exampleReadme).toContain("npm run self-test");
    expect(exampleAgentCard).toContain("endpointUrl");
    expect(exampleAgentCard).toContain("/agent-card.md");
    expect(exampleAgentCard).not.toContain("endpointToken:");
    expect(exampleAgent).toContain("createStarterAgent");
    expect(exampleAgent).toContain("createAgentCardMarkdown");
    expect(exampleAgent).toContain("/health");
    expect(exampleAgent).toContain("/agent-card.md");
    expect(exampleAgent).toContain("loadEnvFileIfPresent");
    expect(exampleSmokeTest).toContain("health-check:expand");
    expect(exampleSmokeTest).toContain("selectedLegalActionId");
    expect(exampleSmokeTest).toContain("OPEN_FRONTIER_AGENT_TEST_ENDPOINT_URL");
    expect(examplePolicy).toContain("createStarterAgent");
    expect(examplePolicy).toContain("createAgentCardMarkdown");
    expect(examplePolicy).toContain("createHealthResponse");
    expect(starterFramework).toContain("selectedLegalActionId");
    expect(starterFramework).toContain("createAgentCardMarkdown");
    expect(starterFramework).toContain("createHealthResponse");
    expect(starterFramework).toContain("createLlmCompleteFromEnv");
    expect(starterFramework).toContain("OPEN_FRONTIER_AGENT_LLM_PROVIDER");
    expect(starterFramework).toContain("publicBaseUrlFromRequest");
    expect(starterFramework).toContain("buildAntiStallGuidance");
    expect(starterFramework.indexOf('"spawn"')).toBeLessThan(
      starterFramework.indexOf('"hold"'),
    );
    expect(starterFramework).toContain("OPENROUTER_API_KEY");
    expect(examplePackage).toContain("open-frontier-agent-starter");
    expect(examplePackage).toContain('"start"');
    expect(examplePackage).toContain('"self-test"');
    expect(examplePackage).toContain("smoke-test.mjs");
    expect(examplePackage).toContain('"exports"');
    expect(exampleEnv).toContain("OPENROUTER_API_KEY");
    expect(exampleEnv).toContain("OPEN_FRONTIER_AGENT_LLM_PROVIDER");
    expect(exampleEnv).toContain("OPEN_FRONTIER_AGENT_LLM_COMMAND");
    expect(exampleEnv).toContain("OPEN_FRONTIER_AGENT_PUBLIC_URL");
    expect(exampleEnv).toContain("OPEN_FRONTIER_AGENT_ENDPOINT_PATH");
    expect(exampleEnv).toContain("OPEN_FRONTIER_AGENT_TEST_ENDPOINT_URL");
    expect(exampleLicense).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(exampleAgent).not.toContain("intent:");
    expect(exampleManifest).toContain('"provider": "external-http"');
    expect(exampleSkill).toContain("Never emit raw game intents");
    expect(exampleSkill).toContain("npm run self-test");
  });
});
