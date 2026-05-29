import { describe, expect, it } from "vitest";
import {
  normalizeOpenFrontierAgentCardInput,
  parseOpenFrontierAgentCardMarkdown,
} from "../../src/server/agents/OpenFrontierAgentCard";

describe("OpenFrontierAgentCard", () => {
  it("parses a public markdown card into a saved-nation input", () => {
    const card = parseOpenFrontierAgentCardMarkdown(
      `---
agentName: Remote Frontier
profile: opportunistic
doctrine: balanced
endpointUrl: https://agent.example.com/open-frontier/decide
endpointTimeoutMs: 5000
personality: Expands safely and pressures weak neighbors.
policyChangelog: Added repetition penalty before rerun.
---

# Remote Frontier

Public card body.
`,
      "https://agent.example.com/open-frontier-agent.md",
    );

    expect(card.title).toBe("Remote Frontier");
    expect(card.nationInput).toMatchObject({
      agentMode: "external-http",
      agentName: "Remote Frontier",
      profile: "opportunistic",
      doctrine: "balanced",
      endpointUrl: "https://agent.example.com/open-frontier/decide",
      endpointTimeoutMs: "5000",
      personality: "Expands safely and pressures weak neighbors.",
      policyChangelog: "Added repetition penalty before rerun.",
    });
    expect(card.warnings).toHaveLength(0);
  });

  it("supports simple field aliases for generated cards", () => {
    const card = parseOpenFrontierAgentCardMarkdown(
      `---
name: Alias Nation
profile: defensive
url: https://agent.example.com/decide
description: Defends borders and builds economy.
---

# Alias Nation
`,
    );

    expect(card.nationInput.agentName).toBe("Alias Nation");
    expect(card.nationInput.endpointUrl).toBe("https://agent.example.com/decide");
    expect(card.nationInput.personality).toBe(
      "Defends borders and builds economy.",
    );
  });

  it("infers standard endpoint fields from a human-written card", () => {
    const card = parseOpenFrontierAgentCardMarkdown(
      `# Aleks-OpenFrontierAgent

A rule-based Open Frontier agent.

| Method | Path | Purpose |
|--------|------|---------|
| POST | \`/open-frontier/decide\` | Decision endpoint |

## Public URL

https://agent.example.test
`,
      "https://agent.example.test/agent-card.md",
    );

    expect(card.nationInput).toMatchObject({
      agentName: "Aleks-OpenFrontierAgent",
      profile: "opportunistic",
      endpointUrl:
        "https://agent.example.test/open-frontier/decide",
    });
    expect(card.warnings.join("\n")).toContain(
      "did not include YAML frontmatter",
    );
  });

  it("rejects missing required fields", () => {
    expect(() =>
      parseOpenFrontierAgentCardMarkdown(
        `---
agentName: Missing Endpoint
profile: diplomatic
---
`,
      ),
    ).toThrow("endpointUrl");
  });

  it("rejects public secret fields", () => {
    expect(() =>
      parseOpenFrontierAgentCardMarkdown(
        `---
agentName: Secret Nation
profile: aggressive
endpointUrl: https://agent.example.com/decide
endpoint_token: nope
---
`,
      ),
    ).toThrow("must not contain bearer tokens");
  });

  it("rejects Agent Cards whose endpointUrl points at card or health routes", () => {
    expect(() =>
      parseOpenFrontierAgentCardMarkdown(
        `---
agentName: Wrong URL
profile: opportunistic
endpointUrl: https://agent.example.com/agent-card.md
---
`,
      ),
    ).toThrow(/POST decision endpoint/);
    expect(() =>
      parseOpenFrontierAgentCardMarkdown(
        `---
agentName: Wrong URL
profile: opportunistic
endpointUrl: https://agent.example.com/health
---
`,
      ),
    ).toThrow(/POST decision endpoint/);
  });

  it("rejects Agent Card endpointUrl values that are not http or https", () => {
    expect(() =>
      parseOpenFrontierAgentCardMarkdown(
        `---
agentName: Bad URL
profile: opportunistic
endpointUrl: file:///tmp/decide
---
`,
      ),
    ).toThrow(/valid http or https/);
  });

  it("normalizes card URLs with the existing external endpoint policy parser", () => {
    expect(
      normalizeOpenFrontierAgentCardInput({
        cardUrl: " https://agent.example.com/open-frontier-agent.md#secret ",
      }),
    ).toMatchObject({
      cardUrl: "https://agent.example.com/open-frontier-agent.md",
      timeoutMs: 5000,
    });
  });
});
