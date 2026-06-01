import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import type { ExternalAgentHealthCheckResult } from "../../src/server/agents/ExternalAgentHealthCheck";
import {
  formatProxyWarSavedAgentMaintenanceReport,
  maintainProxyWarSavedExternalAgents,
} from "../../src/server/agents/ProxyWarSavedAgentMaintenance";
import {
  saveProxyWarNation,
  syncProxyWarActiveRoster,
} from "../../src/server/agents/ProxyWarNationRegistry";

describe("ProxyWarSavedAgentMaintenance", () => {
  it("reports stale saved external agents without archiving by default", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "of-saved-health-"));
    const nationsDir = path.join(rootDir, "nations");
    const activeRosterDir = path.join(rootDir, "active-roster");
    const archiveDir = path.join(rootDir, "archive");
    try {
      const stale = await saveProxyWarNation(
        {
          agentName: "Stale Tunnel",
          profile: "opportunistic",
          doctrine: "balanced",
          agentMode: "external-http",
          endpointUrl: "https://stale.example.test/proxywar/decide",
        },
        { nationsDir, activeRosterDir, curatedManifestDir: curatedManifestDir() },
      );

      const report = await maintainProxyWarSavedExternalAgents({
        nationsDir,
        activeRosterDir,
        archiveDir,
        now: new Date("2026-05-30T20:00:00.000Z"),
        checkEndpoint: async (input) =>
          healthResult({
            ok: false,
            endpoint: input.endpointUrl,
            failureReason: "getaddrinfo ENOTFOUND stale.example.test",
            fixHint: "Delete the stale saved agent.",
          }),
      });

      expect(report).toMatchObject({
        checkedAt: "2026-05-30T20:00:00.000Z",
        checkedExternalAgentCount: 1,
        failedExternalAgentCount: 1,
        archivedExternalAgentCount: 0,
      });
      expect(report.checks[0]).toMatchObject({
        agentName: "Stale Tunnel",
        ok: false,
        failureReason: "getaddrinfo ENOTFOUND stale.example.test",
      });
      await expect(fs.access(stale.nation.filePath)).resolves.toBeUndefined();
      await expect(fs.readdir(archiveDir)).rejects.toThrow();
      expect(formatProxyWarSavedAgentMaintenanceReport(report)).toContain(
        "Run again",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("archives failed saved external agents only when requested", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "of-saved-health-"));
    const nationsDir = path.join(rootDir, "nations");
    const activeRosterDir = path.join(rootDir, "active-roster");
    const archiveDir = path.join(rootDir, "archive");
    try {
      const stale = await saveProxyWarNation(
        {
          agentName: "Stale Tunnel",
          profile: "opportunistic",
          doctrine: "balanced",
          agentMode: "external-http",
          endpointUrl: "https://stale.example.test/proxywar/decide",
        },
        { nationsDir, activeRosterDir, curatedManifestDir: curatedManifestDir() },
      );
      await saveProxyWarNation(
        {
          agentName: "Healthy Tunnel",
          profile: "aggressive",
          doctrine: "pressure",
          agentMode: "external-http",
          endpointUrl: "https://healthy.example.test/proxywar/decide",
        },
        { nationsDir, activeRosterDir, curatedManifestDir: curatedManifestDir() },
      );

      const report = await maintainProxyWarSavedExternalAgents({
        nationsDir,
        activeRosterDir,
        archiveDir,
        archiveFailed: true,
        now: new Date("2026-05-30T20:00:00.000Z"),
        checkEndpoint: async (input) =>
          healthResult({
            ok: !input.endpointUrl.includes("stale"),
            endpoint: input.endpointUrl,
            ...(input.endpointUrl.includes("stale")
              ? {
                  failureReason: "getaddrinfo ENOTFOUND stale.example.test",
                  fixHint: "Delete the stale saved agent.",
                }
              : {}),
          }),
      });

      expect(report.failedExternalAgentCount).toBe(1);
      expect(report.archivedExternalAgentCount).toBe(1);
      const staleCheck = report.checks.find(
        (check) => check.agentName === "Stale Tunnel",
      );
      expect(staleCheck?.archivedFilePath).toContain(stale.nation.fileName);
      await expect(fs.access(stale.nation.filePath)).rejects.toThrow();
      await expect(fs.access(staleCheck?.archivedFilePath ?? "")).resolves.toBeUndefined();
      const activeRoster = await syncProxyWarActiveRoster({
        nationsDir,
        activeRosterDir,
        curatedManifestDir: curatedManifestDir(),
      });
      expect(activeRoster.map((agent) => agent.agentName)).not.toContain(
        "Stale Tunnel",
      );
      expect(activeRoster.map((agent) => agent.agentName)).toContain(
        "Healthy Tunnel",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});

function curatedManifestDir(): string {
  return path.join(process.cwd(), "docs", "ai-league-agent-manifests");
}

function healthResult(
  input: Pick<ExternalAgentHealthCheckResult, "ok" | "endpoint"> &
    Partial<ExternalAgentHealthCheckResult>,
): ExternalAgentHealthCheckResult {
  return {
    ok: input.ok,
    endpoint: input.endpoint,
    latencyMs: input.latencyMs ?? 12,
    request: {
      method: "POST",
      protocolVersion: "proxywar-agent-v1",
      contentType: "application/json",
    },
    offeredLegalActionIDs: ["health-check:expand", "health-check:hold"],
    expectedResponse: {
      selectedLegalActionId:
        "one of health-check:expand or health-check:hold",
      reason: "short human-readable string",
      confidence: "optional number from 0 to 1",
    },
    ...(input.failureReason !== undefined
      ? { failureReason: input.failureReason }
      : {}),
    ...(input.fixHint !== undefined ? { fixHint: input.fixHint } : {}),
  };
}
