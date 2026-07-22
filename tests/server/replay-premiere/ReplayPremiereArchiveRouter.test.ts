import express from "express";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proxyWarLeagueContentSecurityPolicy } from "../../../src/server/agents/ProxyWarPublicArtifacts";
import { ReplayPremiereArchiveStore } from "../../../src/server/replay-premiere/ReplayPremiereArchiveIndex";
import { createReplayPremiereArchiveRouter } from "../../../src/server/replay-premiere/ReplayPremiereArchiveRouter";
import type { ReplayPremiereHttpRegistry } from "../../../src/server/replay-premiere/ReplayPremiereHttp";
import { sha256Hex } from "../../../src/server/replay-premiere/ReplayPremiereIntegrity";
import { buildPremiereResultSummary } from "../../../src/server/replay-premiere/ReplayPremiereResultSummary";

const PUBLIC_ORIGIN = "https://beta.proxywar.xyz";
const APP_SHELL =
  '<!doctype html><html><head><title>Proxy War</title><script>window.BOOTSTRAP_CONFIG={gameEnv:"dev"}</script><script type="module" src="/assets/app.js"></script></head><body><main id=app></main></body></html>';
const ARCHIVED_ID = "prem_archiverouter0001";
const REGISTERED_ID = "prem_registeredlive001";

let root: string;
const servers: http.Server[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-router-"));
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await fs.rm(root, { recursive: true, force: true });
});

async function harness(): Promise<{
  store: ReplayPremiereArchiveStore;
  run(operation: (baseUrl: string) => Promise<void>): Promise<void>;
}> {
  const store = await ReplayPremiereArchiveStore.open({
    privateStateRoot: root,
  });
  await store.recordReclaimed(
    buildPremiereResultSummary({
      premiereId: ARCHIVED_ID,
      sourceRunId: "coworld-run-001",
      sourceKind: "rated_coworld",
      publicationCommitmentHash: sha256Hex(ARCHIVED_ID),
      terminalState: "revealed",
      revealedAt: "2026-07-20T18:00:00.000Z",
      reclaimedAt: "2026-07-20T18:45:00.000Z",
      outcome: {
        winner: { category: "player", groupLabel: null, seatIds: ["SEAT0001"] },
        turnCount: 6,
        completedAt: "2026-07-20T18:00:00.600Z",
        standings: [
          { seatId: "SEAT0001", displayName: "Alpha", won: true },
          { seatId: "SEAT0002", displayName: "Beta", won: false },
        ],
      },
      predictions: [],
      markers: [{ kind: "betrayal", turn: 3, count: 2 }],
    }),
    sha256Hex(ARCHIVED_ID),
  );

  // A "live" premiere is registered but never in the archive index.
  const registry = {
    get: (premiereId: string) =>
      premiereId === REGISTERED_ID ? ({ live: true } as unknown) : null,
  } as unknown as ReplayPremiereHttpRegistry;

  const app = express();
  app.use(
    createReplayPremiereArchiveRouter({
      registry,
      archiveStore: store,
      loadAppShell: async () => APP_SHELL,
      publicOrigin: PUBLIC_ORIGIN,
      pageContentSecurityPolicy: proxyWarLeagueContentSecurityPolicy(),
    }),
  );
  // Downstream marker: proves whether the archive router deferred (next()).
  app.use((request, response) => {
    response
      .status(404)
      .json({ error: { code: "DOWNSTREAM_HANDLED", path: request.path } });
  });
  const server = http.createServer(app);

  return {
    store,
    async run(operation) {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      servers.push(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test server did not bind a TCP address");
      }
      await operation(`http://127.0.0.1:${address.port}`);
    },
  };
}

describe("createReplayPremiereArchiveRouter", () => {
  it("serves the results-summary page for a terminal, indexed premiere", async () => {
    const h = await harness();
    await h.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/premiere/${ARCHIVED_ID}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("cache-control")).toContain("no-store");
      const body = await response.text();
      expect(body).toContain('id="proxywar-premiere-archive"');
      expect(body).toContain(ARCHIVED_ID);
      // The post-reveal winner display name is present (outcome is public now).
      expect(body).toContain("Alpha");
      expect(body).toContain('nonce="');
    });
  });

  it("404s the card route for an archived premiere (sane, not the summary)", async () => {
    const h = await harness();
    await h.run(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/premiere/${ARCHIVED_ID}/card-v1.svg`,
      );
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ error: { code: "PREMIERE_UNAVAILABLE" } });
    });
  });

  it("defers an unknown premiere id to the downstream 404", async () => {
    const h = await harness();
    await h.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/premiere/prem_unknown000000001`);
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe("DOWNSTREAM_HANDLED");
    });
  });

  it("never serves a registered (pre-reveal/live) premiere — it defers", async () => {
    const h = await harness();
    await h.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/premiere/${REGISTERED_ID}`);
      // A live premiere is owned by the downstream public-page router.
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe("DOWNSTREAM_HANDLED");
    });
  });
});
