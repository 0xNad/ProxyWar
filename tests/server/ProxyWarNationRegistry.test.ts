import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  createProxyWarNationManifest,
  deleteProxyWarNation,
  listProxyWarNations,
  saveProxyWarNation,
  syncProxyWarActiveRoster,
} from "../../src/server/agents/ProxyWarNationRegistry";

describe("ProxyWarNationRegistry", () => {
  it("creates a safe manifest-only nation", () => {
    const manifest = createProxyWarNationManifest({
      agentName: "Iron Coast",
      profile: "defensive",
      doctrine: "fortress",
      personality: "Protect borders and build a durable economy.",
    });

    expect(manifest.agentName).toBe("Iron Coast");
    expect(manifest.brainType).toBe("planner");
    expect(manifest.provider?.provider).toBe("mock-llm");
    expect(manifest.skillPreferences?.defense_building).toBe(1);
  });

  it("rejects unsafe or invalid nation input", () => {
    expect(() =>
      createProxyWarNationManifest({
        agentName: "<script>",
        profile: "defensive",
        doctrine: "fortress",
      }),
    ).toThrow(/angle brackets/);
    expect(() =>
      createProxyWarNationManifest({
        agentName: "Iron Coast",
        profile: "hacker",
        doctrine: "fortress",
      }),
    ).toThrow(/profile must be one of/);
  });

  it("creates an external endpoint nation manifest without accepting raw code", () => {
    const manifest = createProxyWarNationManifest({
      agentName: "Remote Frontier",
      profile: "opportunistic",
      doctrine: "balanced",
      personality: "Use my own hosted agent endpoint.",
      policyChangelog: "Added repetition penalty before rerun.",
      agentMode: "external-http",
      endpointUrl: "https://agent.example.test/proxywar/decide#secret",
      endpointToken: "private-token",
      endpointTimeoutMs: "7000",
    });

    expect(manifest.brainType).toBe("external-http");
    expect(manifest.plannerExecutorMode).toBe(false);
    expect(manifest.provider).toMatchObject({
      provider: "external-http",
      endpointUrl: "https://agent.example.test/proxywar/decide",
      token: "private-token",
      timeoutMs: 7000,
    });
    expect(manifest.policyChangelog).toBe(
      "Added repetition penalty before rerun.",
    );
  });

  it("creates a managed relay nation manifest with token secret support", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "proxywar-"));
    const secretStorePath = path.join(rootDir, "secrets.json");
    try {
      const result = await saveProxyWarNation(
        {
          agentName: "Relay Frontier",
          profile: "opportunistic",
          doctrine: "balanced",
          agentMode: "external-relay",
          relayBaseUrl: "https://beta.proxywar.xyz/",
          relaySessionID: "relay_1234567890abcdef12345678",
          relayToken: "relay-token",
          relayTimeoutMs: "120000",
        },
        {
          nationsDir: path.join(rootDir, "nations"),
          activeRosterDir: path.join(rootDir, "active-roster"),
          secretStorePath,
          curatedManifestDir: path.join(
            process.cwd(),
            "docs",
            "ai-league-agent-manifests",
          ),
        },
      );

      expect(result.nation.brainType).toBe("external-relay");
      expect(result.nation.provider).toMatchObject({
        provider: "external-relay",
        relayBaseUrl: "https://beta.proxywar.xyz",
        sessionID: "relay_1234567890abcdef12345678",
        timeoutMs: 120000,
      });
      expect(
        result.nation.provider?.provider === "external-relay"
          ? result.nation.provider.token
          : undefined,
      ).toBeUndefined();
      expect(
        result.nation.provider?.provider === "external-relay"
          ? result.nation.provider.tokenSecret
          : undefined,
      ).toMatch(/^agent_/);
      await expect(fs.readFile(result.nation.filePath, "utf8")).resolves.not.toContain(
        "relay-token",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("stores external endpoint token env references without plaintext secrets", () => {
    const manifest = createProxyWarNationManifest({
      agentName: "Remote Frontier",
      profile: "opportunistic",
      doctrine: "balanced",
      agentMode: "external-http",
      endpointUrl: "https://agent.example.test/proxywar/decide",
      endpointToken: "env:PROXYWAR_AGENT_TOKEN",
    });

    expect(manifest.provider).toMatchObject({
      provider: "external-http",
      tokenEnv: "PROXYWAR_AGENT_TOKEN",
    });
    expect(
      manifest.provider?.provider === "external-http"
        ? manifest.provider.token
        : undefined,
    ).toBeUndefined();
  });

  it("rejects token references when saving user-submitted external nations", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "proxywar-"));
    const nationsDir = path.join(rootDir, "nations");
    const activeRosterDir = path.join(rootDir, "active-roster");
    try {
      await expect(
        saveProxyWarNation(
          {
            agentName: "Remote Frontier",
            profile: "opportunistic",
            doctrine: "balanced",
            agentMode: "external-http",
            endpointUrl: "https://agent.example.test/proxywar/decide",
            endpointToken: "env:PROXYWAR_AGENT_TOKEN",
          },
          {
            nationsDir,
            activeRosterDir,
            curatedManifestDir: path.join(
              process.cwd(),
              "docs",
              "ai-league-agent-manifests",
            ),
          },
        ),
      ).rejects.toThrow(/operator-only/);

      await expect(
        saveProxyWarNation(
          {
            agentName: "Remote Frontier",
            profile: "opportunistic",
            doctrine: "balanced",
            agentMode: "external-http",
            endpointUrl: "https://agent.example.test/proxywar/decide",
            endpointTokenEnv: "PROXYWAR_AGENT_TOKEN",
          },
          {
            nationsDir,
            activeRosterDir,
            curatedManifestDir: path.join(
              process.cwd(),
              "docs",
              "ai-league-agent-manifests",
            ),
          },
        ),
      ).rejects.toThrow(/operator-only/);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects mixed direct and env external endpoint tokens", () => {
    expect(() =>
      createProxyWarNationManifest({
        agentName: "Remote Frontier",
        profile: "opportunistic",
        doctrine: "balanced",
        agentMode: "external-http",
        endpointUrl: "https://agent.example.test/proxywar/decide",
        endpointToken: "private-token",
        endpointTokenEnv: "PROXYWAR_AGENT_TOKEN",
      }),
    ).toThrow(/directly or through env/);
  });

  it("rejects unsafe external endpoint URLs", () => {
    expect(() =>
      createProxyWarNationManifest({
        agentName: "Remote Frontier",
        profile: "opportunistic",
        doctrine: "balanced",
        agentMode: "external-http",
        endpointUrl: "file:///tmp/agent",
      }),
    ).toThrow(/valid http or https URL/);
  });

  it("saves nations and writes an active 4-agent roster with curated fallbacks", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "proxywar-"));
    const nationsDir = path.join(rootDir, "nations");
    const activeRosterDir = path.join(rootDir, "active-roster");
    try {
      const result = await saveProxyWarNation(
        {
          agentName: "Iron Coast",
          profile: "defensive",
          doctrine: "fortress",
          personality: "Protect borders and build a durable economy.",
          policyChangelog:
            "Added safer Defense Post timing before this saved-roster run.",
        },
        {
          nationsDir,
          activeRosterDir,
          curatedManifestDir: path.join(
            process.cwd(),
            "docs",
            "ai-league-agent-manifests",
          ),
        },
      );
      const nations = await listProxyWarNations(nationsDir);
      const activeFiles = await fs.readdir(activeRosterDir);
      const roster = await syncProxyWarActiveRoster({
        nationsDir,
        activeRosterDir,
        curatedManifestDir: path.join(
          process.cwd(),
          "docs",
          "ai-league-agent-manifests",
        ),
      });

      expect(result.nation.agentName).toBe("Iron Coast");
      expect(result.nation.policyChangelog).toBe(
        "Added safer Defense Post timing before this saved-roster run.",
      );
      expect(nations.map((nation) => nation.agentName)).toContain("Iron Coast");
      expect(nations.map((nation) => nation.policyChangelog)).toContain(
        "Added safer Defense Post timing before this saved-roster run.",
      );
      expect(activeFiles).toHaveLength(4);
      expect(roster).toHaveLength(4);
      expect(roster.some((agent) => agent.policyChangelog !== undefined)).toBe(
        true,
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("can pin one saved nation and fill the match roster with curated fallbacks", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "proxywar-"));
    const nationsDir = path.join(rootDir, "nations");
    const activeRosterDir = path.join(rootDir, "active-roster");
    const curatedManifestDir = path.join(
      process.cwd(),
      "docs",
      "ai-league-agent-manifests",
    );
    try {
      const stale = await saveProxyWarNation(
        {
          agentName: "Stale Agent",
          profile: "opportunistic",
          doctrine: "balanced",
          agentMode: "external-http",
          endpointUrl: "https://stale.example.test/decide",
        },
        {
          nationsDir,
          activeRosterDir,
          curatedManifestDir,
        },
      );
      const fresh = await saveProxyWarNation(
        {
          agentName: "Fresh Agent",
          profile: "aggressive",
          doctrine: "pressure",
          agentMode: "external-http",
          endpointUrl: "https://fresh.example.test/proxywar/decide",
        },
        {
          nationsDir,
          activeRosterDir,
          curatedManifestDir,
        },
      );

      const roster = await syncProxyWarActiveRoster({
        nationsDir,
        activeRosterDir,
        curatedManifestDir,
        pinnedNationID: fresh.nation.nationID,
        maxSavedNations: 1,
      });

      expect(roster).toHaveLength(4);
      expect(roster[0]?.agentName).toBe("Fresh Agent");
      expect(roster.map((agent) => agent.agentName)).not.toContain(
        stale.nation.agentName,
      );
      expect(
        roster.filter((agent) => agent.provider?.provider === "external-http"),
      ).toHaveLength(1);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("can sync only saved external agents without curated fallback agents", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "proxywar-"));
    const nationsDir = path.join(rootDir, "nations");
    const activeRosterDir = path.join(rootDir, "active-roster");
    const curatedManifestDir = path.join(
      process.cwd(),
      "docs",
      "ai-league-agent-manifests",
    );
    try {
      const saved = await saveProxyWarNation(
        {
          agentName: "Tester Agent",
          profile: "aggressive",
          doctrine: "pressure",
          agentMode: "external-http",
          endpointUrl: "https://tester.example.test/proxywar/decide",
        },
        {
          nationsDir,
          activeRosterDir,
          curatedManifestDir,
        },
      );

      const roster = await syncProxyWarActiveRoster({
        nationsDir,
        activeRosterDir,
        curatedManifestDir,
        pinnedNationID: saved.nation.nationID,
        maxSavedNations: 1,
        includeCuratedDefaults: false,
        minRosterSize: 1,
      });

      expect(roster).toHaveLength(1);
      expect(roster[0]?.agentName).toBe("Tester Agent");
      expect(roster[0]?.provider?.provider).toBe("external-http");
      await expect(fs.readdir(activeRosterDir)).resolves.toHaveLength(1);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("deletes a saved nation and refreshes the active roster", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "proxywar-"));
    const nationsDir = path.join(rootDir, "nations");
    const activeRosterDir = path.join(rootDir, "active-roster");
    try {
      const result = await saveProxyWarNation(
        {
          agentName: "Delete Me",
          profile: "opportunistic",
          doctrine: "balanced",
          personality: "Temporary test nation.",
        },
        {
          nationsDir,
          activeRosterDir,
          curatedManifestDir: path.join(
            process.cwd(),
            "docs",
            "ai-league-agent-manifests",
          ),
        },
      );
      await expect(fs.access(result.nation.filePath)).resolves.toBeUndefined();

      const deleted = await deleteProxyWarNation(result.nation.nationID, {
        nationsDir,
        activeRosterDir,
        curatedManifestDir: path.join(
          process.cwd(),
          "docs",
          "ai-league-agent-manifests",
        ),
      });
      const nations = await listProxyWarNations(nationsDir);

      expect(deleted.deletedNation.agentName).toBe("Delete Me");
      await expect(fs.access(result.nation.filePath)).rejects.toThrow();
      expect(nations.map((nation) => nation.nationID)).not.toContain(
        result.nation.nationID,
      );
      expect(deleted.activeRoster.length).toBeGreaterThanOrEqual(4);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("moves saved external endpoint tokens into the local secret store", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "proxywar-"));
    const nationsDir = path.join(rootDir, "nations");
    const activeRosterDir = path.join(rootDir, "active-roster");
    const secretStorePath = path.join(rootDir, "secrets.json");
    try {
      const result = await saveProxyWarNation(
        {
          agentName: "Remote Frontier",
          profile: "opportunistic",
          doctrine: "balanced",
          agentMode: "external-http",
          endpointUrl: "https://agent.example.test/proxywar/decide",
          endpointToken: "private-token",
        },
        {
          nationsDir,
          activeRosterDir,
          secretStorePath,
          curatedManifestDir: path.join(
            process.cwd(),
            "docs",
            "ai-league-agent-manifests",
          ),
        },
      );
      const manifestText = await fs.readFile(result.nation.filePath, "utf8");

      expect(manifestText).not.toContain("private-token");
      expect(result.nation.provider).toMatchObject({
        provider: "external-http",
      });
      expect(
        result.nation.provider?.provider === "external-http"
          ? result.nation.provider.tokenSecret
          : undefined,
      ).toMatch(/^agent_/);
      await expect(fs.readFile(secretStorePath, "utf8")).resolves.toContain(
        "private-token",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
