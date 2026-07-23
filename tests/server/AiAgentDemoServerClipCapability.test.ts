import express from "express";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAiLeagueClipCanaryWriteRefusal } from "../../src/server/agents/AiLeagueClipCanary";

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
      'const replayClipsMasterRequested = envFlag("PROXYWAR_CLIPS_ENABLED")',
    );
    expect(source).toContain(
      "replayClipsMasterEnabled && replayPremiereClipsRequested",
    );
    expect(source).toContain(
      "replayClipsMasterEnabled && aiLeagueRunClipsRequested",
    );
    expect(route).not.toContain("aiLeagueClipCanary");
  });

  it("authorizes exact canary actions only after a successful post-bind claim", async () => {
    const source = await demoServerSource();
    const archiveBinding = source.slice(
      source.indexOf("const replayRunClipsForArchive"),
      source.indexOf("app.use(\n  createReplayPremiereArchiveRouter"),
    );
    expect(archiveBinding).toContain("aiLeagueRunClipsEnabled");
    expect(archiveBinding).not.toContain("aiLeagueClipCanaryRecord");

    const apiSurface = source.slice(
      source.indexOf("// League-run clip surface."),
      source.indexOf('app.get("/league"'),
    );
    const refusal = apiSurface.indexOf("if (!aiLeagueRunClipsEnabled)");
    const rateLimit = apiSurface.indexOf(
      'enforceRateLimit("league-clips", rateLimits.leagueClips, req, res)',
    );
    const publicRequest = apiSurface.indexOf(".requestRunClip({");
    expect(refusal).toBeGreaterThanOrEqual(0);
    expect(refusal).toBeLessThan(rateLimit);
    expect(refusal).toBeLessThan(publicRequest);

    expect(source).toContain("leagueClipPublicReadAllowed(req.path)");
    expect(source).toContain("leagueClipPublicWriteAllowed(req.path)");
    expect(source).toContain(
      "aiLeagueRunClips.allowsCanaryRead(route.runKey, route.bucket)",
    );

    const listenStart = source.indexOf(
      "const server = app.listen(port, host, () => {",
    );
    const claim = source.indexOf(
      "await claimAiLeagueClipCanary({",
      listenStart,
    );
    const internalRequest = source.indexOf(
      "const status = await canaryService.requestRunClip({",
      listenStart,
    );
    const authorize = source.indexOf(
      "aiLeagueClipCanaryActionAuthorized = true",
      claim,
    );
    expect(listenStart).toBeGreaterThanOrEqual(0);
    expect(claim).toBeGreaterThan(listenStart);
    expect(authorize).toBeGreaterThan(claim);
    expect(internalRequest).toBeGreaterThan(authorize);
    expect(source).toContain(
      'aiLeagueClipCanaryRecord?.lifecycle === "claimed"',
    );
    expect(source).toContain(
      "isAuthorized: () => aiLeagueClipCanaryActionAuthorized",
    );
    expect(source).toContain('aiLeagueClipCanaryRecord?.lifecycle === "armed"');
    const oneShot = source.slice(claim, source.indexOf("})().catch", claim));
    expect(oneShot.match(/requestRunClip\(\{/g)).toHaveLength(1);
    expect(
      oneShot.match(/aiLeagueClipCanaryActionAuthorized = true/g),
    ).toHaveLength(1);
    expect(oneShot).toContain("participantId: null");
    expect(oneShot).not.toMatch(/retry|setTimeout|setInterval/);
  });

  it("mounts the exact canary write refusal before generic body parsing while retaining the inner guard", async () => {
    const source = await demoServerSource();
    const refusal = source.indexOf(
      "app.use(\n  createAiLeagueClipCanaryWriteRefusal({",
    );
    const parser = source.indexOf('app.use(express.json({ limit: "256kb" }))');
    const apiSurface = source.slice(
      source.indexOf("// League-run clip surface."),
      source.indexOf('app.get("/league"'),
    );

    expect(refusal).toBeGreaterThanOrEqual(0);
    expect(refusal).toBeLessThan(parser);
    expect(source.slice(refusal, parser)).toContain(
      "aiLeagueClipCanaryState.claimable || aiLeagueClipCanaryState.readEnabled",
    );
    expect(apiSurface).toContain("if (!aiLeagueRunClipsEnabled)");
  });

  it("repairs archive temps before Premiere startup and filters league cache repair to archived runs", async () => {
    const source = await demoServerSource();
    const promoter = source.indexOf(
      "const replayPremiereArchivedClipPromoter =",
    );
    const tempRepair = source.indexOf(
      "await replayPremiereArchivedClipPromoter.repairOrphanedTemporaryFiles()",
      promoter,
    );
    const premiereStartup = source.indexOf(
      "const replayPremiereProduction = await startReplayPremiereProduction",
      tempRepair,
    );
    const leagueConstruction = source.indexOf(
      "aiLeagueRunClips = new AiLeagueRunClips({",
      premiereStartup,
    );
    const repairFilter = source.indexOf(
      "shouldRepairRunClipOnIndexRebuild: (runKey) =>",
      leagueConstruction,
    );

    expect(promoter).toBeGreaterThanOrEqual(0);
    expect(tempRepair).toBeGreaterThan(promoter);
    expect(premiereStartup).toBeGreaterThan(tempRepair);
    expect(repairFilter).toBeGreaterThan(leagueConstruction);
    expect(source.slice(tempRepair, premiereStartup)).toContain(
      "Replay Premiere archived clip temp repair degraded:",
    );
    expect(source.slice(repairFilter, repairFilter + 300)).toContain(
      "replayPremiereArchiveStore.revealPublicRatedCoworldPointersForRunKey",
    );
  });

  it("returns canary Clip POST 404 before malformed or oversized JSON touches parser, rate-limit, or request state", async () => {
    let canaryActive = true;
    let parserEntries = 0;
    let rateLimitEntries = 0;
    let requestEntries = 0;
    const app = express();
    app.use(
      createAiLeagueClipCanaryWriteRefusal({
        isCanaryActive: () => canaryActive,
      }),
    );
    app.use((_request, _response, next) => {
      parserEntries += 1;
      next();
    });
    app.use(express.json({ limit: "32b" }));
    app.use((request, _response, next) => {
      if (request.method === "POST" && request.path.endsWith("/clips")) {
        rateLimitEntries += 1;
      }
      next();
    });
    app.post("/api/league-runs/:runKey/clips", (_request, response) => {
      requestEntries += 1;
      response.json({ ok: true });
    });

    const server = await listenOnLoopback(app);
    const route = `${server.origin}/api/league-runs/league-coworld-canary-1234abcd/clips`;
    try {
      for (const body of [
        "{malformed",
        JSON.stringify({ turn: "x".repeat(1_024) }),
      ]) {
        const response = await fetch(route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({
          error: { code: "LEAGUE_CLIP_UNAVAILABLE" },
        });
      }
      expect({ parserEntries, rateLimitEntries, requestEntries }).toEqual({
        parserEntries: 0,
        rateLimitEntries: 0,
        requestEntries: 0,
      });

      canaryActive = false;
      const ordinary = await fetch(route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"turn":0}',
      });
      expect(ordinary.status).toBe(200);
      await expect(ordinary.json()).resolves.toEqual({ ok: true });
      expect({ parserEntries, rateLimitEntries, requestEntries }).toEqual({
        parserEntries: 1,
        rateLimitEntries: 1,
        requestEntries: 1,
      });
    } finally {
      await server.close();
    }
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

async function listenOnLoopback(app: ReturnType<typeof express>): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      }),
  };
}
