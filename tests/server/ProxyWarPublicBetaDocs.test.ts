import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

describe("ProxyWar public beta onboarding docs", () => {
  it("keeps tester handoff, external-agent examples, and asset audit available", async () => {
    const root = process.cwd();
    const [
      packageJson,
      startHere,
      externalApi,
      testerHandoff,
      hostedBeta,
      publicDemo,
      assetAudit,
      exampleReadme,
      exampleAgentCard,
      exampleAgent,
      exampleSmokeTest,
      exampleLaunch,
      examplePolicy,
      starterFramework,
      exampleManifest,
      examplePackage,
      exampleEnv,
      exampleLicense,
      exampleSkill,
    ] = await Promise.all([
      fs.readFile(path.join(root, "package.json"), "utf8"),
      fs.readFile(path.join(root, "docs", "PROXYWAR_START_HERE.md"), "utf8"),
      fs.readFile(
        path.join(root, "docs", "PROXYWAR_EXTERNAL_AGENT_API.md"),
        "utf8",
      ),
      fs.readFile(
        path.join(root, "docs", "PROXYWAR_TESTER_HANDOFF.md"),
        "utf8",
      ),
      fs.readFile(path.join(root, "docs", "PROXYWAR_HOSTED_BETA.md"), "utf8"),
      fs.readFile(path.join(root, "docs", "PROXYWAR_PUBLIC_DEMO.md"), "utf8"),
      fs.readFile(
        path.join(root, "docs", "PROXYWAR_ASSET_AND_LICENSE_AUDIT.md"),
        "utf8",
      ),
      fs.readFile(path.join(root, "examples", "external-agent", "README.md"), "utf8"),
      fs.readFile(
        path.join(root, "examples", "external-agent", "PROXYWAR_AGENT_CARD.md"),
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
        path.join(root, "examples", "external-agent", "launch.sh"),
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
      "proxywar-external-agent-dry-run.ts",
    );
    expect(scripts["agent:external-agent:failure-drill"]).toContain(
      "proxywar-external-agent-failure-drill.ts",
    );
    expect(scripts["agent:external-agent:sdk-sim"]).toContain(
      "proxywar-external-agent-sdk-sim.ts",
    );
    expect(scripts["agent:public-readiness"]).toContain(
      "proxywar-public-readiness.ts",
    );
    expect(startHere).toContain("npm run agent:demo-server");
    expect(startHere).toContain("/api/public-readiness");
    expect(startHere).toContain("agent:public-readiness:strict");
    expect(startHere).toContain("npm run agent:external-agent:dry-run");
    expect(startHere).toContain("npm run agent:external-agent:failure-drill");
    expect(startHere).toContain("npm run agent:external-agent:sdk-sim");
    expect(startHere).toContain("LegalAction.id");
    expect(externalApi).toContain("examples/external-agent/simple-agent.mjs");
    expect(externalApi).toContain("Agent Card");
    expect(externalApi).toContain("createHealthResponse");
    expect(externalApi).toContain("unknown JSON field: actionId");
    expect(externalApi).toContain("Do not `source .env`");
    expect(externalApi).toContain("npm run self-test");
    expect(externalApi).toContain("PROXYWAR_AGENT_ENDPOINT_TOKEN");
    expect(externalApi).toContain("npm run agent:external-agent:dry-run");
    expect(externalApi).toContain("npm run agent:external-agent:failure-drill");
    expect(externalApi).toContain("npm run agent:external-agent:sdk-sim");
    expect(testerHandoff).toContain("ProxyWar-starter-agent");
    expect(testerHandoff).toContain("selectedLegalActionId");
    expect(testerHandoff).toContain("npm run self-test");
    expect(testerHandoff).toContain("d713535");
    expect(testerHandoff).toContain("Could not start LLM command claude");
    expect(testerHandoff).toContain("PROXYWAR_AGENT_ENDPOINT_TOKEN");
    expect(testerHandoff).toContain("401");
    expect(testerHandoff).toContain("Starter commit from `git rev-parse --short HEAD`");
    expect(testerHandoff).toContain("Common Fixes");
    expect(testerHandoff).toContain("Send Back After A Run");
    expect(testerHandoff).not.toContain("PROXYWAR_OPERATOR_RUNBOOK");
    expect(hostedBeta).toContain("Send/No-Send Gate");
    expect(hostedBeta).toContain("npm run agent:saved-agents:health");
    expect(hostedBeta).toContain("NO-SEND");
    expect(hostedBeta).toContain("PROXYWAR_PUBLIC_URL");
    expect(hostedBeta).toContain("PROXYWAR_BETA_CODE");
    expect(hostedBeta).toContain("PROXYWAR_MAX_QUEUED_JOBS=1");
    expect(hostedBeta).toContain("PROXYWAR_BACKUP_DIR");
    expect(hostedBeta).toContain("archive-failed");
    expect(publicDemo).toContain("PROXYWAR_TESTER_HANDOFF.md");
    expect(publicDemo).toContain("PROXYWAR_ASSET_AND_LICENSE_AUDIT.md");
    expect(publicDemo).toContain("/examples/external-agent/simple-agent.mjs");
    expect(publicDemo).toContain("/examples/external-agent/AGENT_SKILL.md");
    expect(publicDemo).toContain("agent:external-agent:dry-run");
    expect(publicDemo).toContain("raw run-directory serving is restricted");
    expect(publicDemo).toContain("/api/public-readiness");
    expect(publicDemo).toContain("agent:public-readiness:strict");
    expect(publicDemo).not.toContain("docs/PROXYWAR_START_HERE.md");
    expect(publicDemo).not.toContain("docs/PROXYWAR_OPERATOR_RUNBOOK.md");
    expect(publicDemo).not.toContain("docs/REMOTE_FRIENDS_BETA.md");
    expect(assetAudit).toContain("AGPL v3");
    expect(assetAudit).toContain("LICENSE-ASSETS");
    expect(exampleReadme).toMatch(/Test\s+Endpoint/);
    expect(exampleReadme).toContain("PROXYWAR_AGENT_CARD.md");
    expect(exampleReadme).toContain("npm run agent:external-agent:dry-run");
    expect(exampleReadme).toContain("npm run agent:external-agent:failure-drill");
    expect(exampleReadme).toContain("npm run agent:external-agent:sdk-sim");
    expect(exampleReadme).toContain("starter-framework.mjs");
    expect(exampleReadme).toContain("Template Package Readiness");
    expect(exampleReadme).toContain("/agent-card.md");
    expect(exampleReadme).toContain("URL Map");
    expect(exampleReadme).toContain("unknown JSON field: actionId");
    expect(exampleReadme).toContain("PROXYWAR_AGENT_PUBLIC_URL");
    expect(exampleReadme).toContain("PROXYWAR_AGENT_ENDPOINT_TOKEN");
    expect(exampleReadme).toContain("LLM-backed");
    expect(exampleReadme).toContain("Codex CLI");
    expect(exampleReadme).toContain("Claude/Cowork");
    expect(exampleReadme).toContain("./launch.sh");
    expect(exampleReadme).toContain("Do not `source .env`");
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
    expect(exampleSmokeTest).toContain("PROXYWAR_AGENT_TEST_ENDPOINT_URL");
    expect(exampleLaunch).toContain("decision_url=");
    expect(exampleLaunch).toContain("PROXYWAR_AGENT_TEST_ENDPOINT_URL");
    expect(examplePolicy).toContain("createStarterAgent");
    expect(examplePolicy).toContain("createAgentCardMarkdown");
    expect(examplePolicy).toContain("createHealthResponse");
    expect(starterFramework).toContain("selectedLegalActionId");
    expect(starterFramework).toContain("createAgentCardMarkdown");
    expect(starterFramework).toContain("createHealthResponse");
    expect(starterFramework).toContain("createLlmCompleteFromEnv");
    expect(starterFramework).toContain("PROXYWAR_AGENT_LLM_PROVIDER");
    expect(starterFramework).toContain("publicBaseUrlFromRequest");
    expect(starterFramework).toContain("buildAntiStallGuidance");
    expect(starterFramework.indexOf('"spawn"')).toBeLessThan(
      starterFramework.indexOf('"hold"'),
    );
    expect(starterFramework).toContain("OPENROUTER_API_KEY");
    expect(examplePackage).toContain("proxywar-agent-starter");
    expect(examplePackage).toContain('"start"');
    expect(examplePackage).toContain('"launch"');
    expect(examplePackage).toContain('"self-test"');
    expect(examplePackage).toContain("smoke-test.mjs");
    expect(examplePackage).toContain('"exports"');
    expect(exampleEnv).toContain("OPENROUTER_API_KEY");
    expect(exampleEnv).toContain("PROXYWAR_AGENT_LLM_PROVIDER");
    expect(exampleEnv).toContain("PROXYWAR_AGENT_LLM_COMMAND");
    expect(exampleEnv).toContain("PROXYWAR_AGENT_PUBLIC_URL");
    expect(exampleEnv).toContain("PROXYWAR_AGENT_ENDPOINT_PATH");
    expect(exampleEnv).toContain("PROXYWAR_AGENT_TEST_ENDPOINT_URL");
    expect(exampleLicense).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
    expect(exampleAgent).not.toContain("intent:");
    expect(exampleManifest).toContain('"provider": "external-http"');
    expect(exampleSkill).toContain("Never emit raw game intents");
    expect(exampleSkill).toContain("npm run self-test");
    expect(exampleSkill).toContain("PROXYWAR_AGENT_ENDPOINT_TOKEN");
  });
});
