import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("ai-agent-demo-server clip capability wiring", () => {
  it("publishes constructed-service generation capability before access gates", async () => {
    const source = await demoServerSource();
    const routeStart = source.indexOf(
      'app.get("/api/clip-capabilities", (_req, res) => {',
    );
    const routeEnd = source.indexOf("\n});", routeStart);
    const betaGate = source.indexOf(
      "if (!betaAccess.enabled || hasValidBetaSession(req))",
    );

    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(routeEnd).toBeGreaterThan(routeStart);
    expect(routeStart).toBeLessThan(betaGate);
    const route = source.slice(routeStart, routeEnd);
    expect(route).toContain(
      'res.setHeader("Cache-Control", "no-store, max-age=0")',
    );
    expect(route).toContain("schemaVersion: 1");
    expect(route).toContain(
      "replayPremiereClipsEnabled && replayPremiereClips !== null",
    );
    expect(route).toContain(
      "aiLeagueRunClipsEnabled && aiLeagueRunClips !== null",
    );
    expect(source).toContain(
      'const replayClipsMasterEnabled = envFlag("PROXYWAR_CLIPS_ENABLED")',
    );
    expect(source).toContain(
      'replayClipsMasterEnabled && envFlag("PROXYWAR_PREMIERE_CLIPS_ENABLED")',
    );
    expect(source).toContain(
      'replayClipsMasterEnabled && envFlag("PROXYWAR_LEAGUE_CLIPS_ENABLED")',
    );
  });

  it("awaits both clip services and Premiere production before exiting", async () => {
    const source = await demoServerSource();
    const shutdownStart = source.indexOf("let shutdownStarted = false;");
    const shutdownEnd = source.indexOf(
      "\nfunction hasValidBetaSession",
      shutdownStart,
    );
    const shutdown = source.slice(shutdownStart, shutdownEnd);

    expect(shutdown).toContain("const serviceShutdown = Promise.allSettled([");
    expect(shutdown).toContain(
      "replayPremiereClips?.close() ?? Promise.resolve()",
    );
    expect(shutdown).toContain(
      "aiLeagueRunClips?.close() ?? Promise.resolve()",
    );
    expect(shutdown).toContain(
      "replayPremiereProduction?.service.close() ?? Promise.resolve()",
    );
    expect(
      shutdown.indexOf("const serviceShutdown = Promise.allSettled(["),
    ).toBeLessThan(shutdown.indexOf("server.close(() => {"));
    expect(shutdown).toContain(
      'results.some((result) => result.status === "rejected") ? 1 : 0',
    );
    expect(shutdown).toContain(
      "void serviceShutdown.then((exitCode) => process.exit(exitCode))",
    );
    expect(shutdown).not.toContain("void replayPremiereClips?.close()");
    expect(shutdown).not.toContain("void aiLeagueRunClips?.close()");
  });
});

async function demoServerSource(): Promise<string> {
  return fs.readFile(
    path.join(process.cwd(), "src", "scripts", "ai-agent-demo-server.ts"),
    "utf8",
  );
}
