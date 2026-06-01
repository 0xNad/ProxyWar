import { describe, expect, it } from "vitest";
import {
  normalizeProxyWarAgentCardInput,
  parseProxyWarAgentCardMarkdown,
} from "../../src/server/agents/ProxyWarAgentCard";

describe("ProxyWarAgentCard", () => {
  it("parses a public markdown card into a saved-nation input", () => {
    const card = parseProxyWarAgentCardMarkdown(
      `---
agentName: Remote Frontier
profile: opportunistic
doctrine: balanced
endpointUrl: https://agent.example.com/proxywar/decide
endpointTimeoutMs: 120000
personality: Expands safely and pressures weak neighbors.
policyChangelog: Added repetition penalty before rerun.
---

# Remote Frontier

Public card body.
`,
      "https://agent.example.com/proxywar-agent.md",
    );

    expect(card.title).toBe("Remote Frontier");
    expect(card.nationInput).toMatchObject({
      agentMode: "external-http",
      agentName: "Remote Frontier",
      profile: "opportunistic",
      doctrine: "balanced",
      endpointUrl: "https://agent.example.com/proxywar/decide",
      endpointTimeoutMs: "120000",
      personality: "Expands safely and pressures weak neighbors.",
      policyChangelog: "Added repetition penalty before rerun.",
    });
    expect(card.warnings).toHaveLength(0);
  });

  it("parses BOM, CRLF, unicode, and leading blank lines in generated cards", () => {
    const card = parseProxyWarAgentCardMarkdown(
      `\uFEFF\r\n---\r\nagentName: Café Frontier\r\nprofile: diplomatic\r\nendpointUrl: https://agent.example.com/proxywar/decide\r\nendpointTimeoutMs: 120000\r\npersonality: Uses alliances and safe expansion.\r\n---\r\n\r\n# Café Frontier\r\n`,
    );

    expect(card.nationInput).toMatchObject({
      agentName: "Café Frontier",
      profile: "diplomatic",
      endpointUrl: "https://agent.example.com/proxywar/decide",
      endpointTimeoutMs: "120000",
    });
  });

  it("supports simple field aliases for generated cards", () => {
    const card = parseProxyWarAgentCardMarkdown(
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
    const card = parseProxyWarAgentCardMarkdown(
      `# Aleks-ProxyWarAgent

A rule-based ProxyWar agent.

| Method | Path | Purpose |
|--------|------|---------|
| POST | \`/proxywar/decide\` | Decision endpoint |

## Public URL

https://agent.example.test
`,
      "https://agent.example.test/agent-card.md",
    );

    expect(card.nationInput).toMatchObject({
      agentName: "Aleks-ProxyWarAgent",
      profile: "opportunistic",
      endpointUrl:
        "https://agent.example.test/proxywar/decide",
    });
    expect(card.warnings.join("\n")).toContain(
      "did not include YAML frontmatter",
    );
  });

  it("rejects missing required fields", () => {
    expect(() =>
      parseProxyWarAgentCardMarkdown(
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
      parseProxyWarAgentCardMarkdown(
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

  it("rejects public secret-looking body text and endpoint query tokens", () => {
    expect(() =>
      parseProxyWarAgentCardMarkdown(
        `---
agentName: Secret Nation
profile: aggressive
endpointUrl: https://agent.example.com/decide
---

Authorization: Bearer beta-token-that-should-not-be-public
`,
      ),
    ).toThrow("must not contain bearer tokens");

    expect(() =>
      parseProxyWarAgentCardMarkdown(
        `---
agentName: Query Secret
profile: aggressive
endpointUrl: https://agent.example.com/decide?token=abc123456789
---
`,
      ),
    ).toThrow("must not include tokens");
  });

  it("rejects Agent Cards whose endpointUrl points at card or health routes", () => {
    expect(() =>
      parseProxyWarAgentCardMarkdown(
        `---
agentName: Wrong URL
profile: opportunistic
endpointUrl: https://agent.example.com/agent-card.md
---
`,
      ),
    ).toThrow(/POST decision endpoint/);
    expect(() =>
      parseProxyWarAgentCardMarkdown(
        `---
agentName: Wrong URL
profile: opportunistic
endpointUrl: https://agent.example.com/health
---
`,
      ),
    ).toThrow(/POST decision endpoint/);
    expect(() =>
      parseProxyWarAgentCardMarkdown(
        `---
agentName: Wrong URL
profile: opportunistic
endpointUrl: https://agent.example.com/health/
---
`,
      ),
    ).toThrow(/POST decision endpoint/);
  });

  it("rejects Agent Card endpointUrl values that are not http or https", () => {
    expect(() =>
      parseProxyWarAgentCardMarkdown(
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
      normalizeProxyWarAgentCardInput({
        cardUrl: " https://agent.example.com/proxywar-agent.md#secret ",
      }),
    ).toMatchObject({
      cardUrl: "https://agent.example.com/proxywar-agent.md",
      timeoutMs: 5000,
    });
  });

  it("rejects cards larger than the import limit", () => {
    expect(() =>
      parseProxyWarAgentCardMarkdown(
        `---
agentName: Big Card
profile: opportunistic
endpointUrl: https://agent.example.com/proxywar/decide
---

${"x".repeat(70 * 1024)}
`,
      ),
    ).toThrow(/too large/);
  });
});
