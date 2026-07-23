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
const FAILED_ID = "prem_archiverouterfail1";
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

async function harness(
  options: { retainedRunKeys?: ReadonlySet<string> } = {},
): Promise<{
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
      mapLabel: "Pangaea",
      formatLabel: "2-player FFA",
    }),
    sha256Hex(ARCHIVED_ID),
  );

  // A terminal FAILED premiere is archived without any outcome (spoiler-neutral).
  await store.recordReclaimed(
    buildPremiereResultSummary({
      premiereId: FAILED_ID,
      sourceRunId: "coworld-run-002",
      sourceKind: "rated_coworld",
      publicationCommitmentHash: sha256Hex(FAILED_ID),
      terminalState: "failed",
      revealedAt: null,
      reclaimedAt: "2026-07-20T18:45:00.000Z",
      outcome: null,
      predictions: [],
      markers: [],
    }),
    sha256Hex(FAILED_ID),
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
      resolveClipGenerationTarget:
        options.retainedRunKeys === undefined
          ? undefined
          : async (runKey) => options.retainedRunKeys?.has(runKey) === true,
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

  it("emits a winner-led social card for a reveal-public archive", async () => {
    const h = await harness();
    await h.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/premiere/${ARCHIVED_ID}`);
      expect(response.status).toBe(200);
      const head = (await response.text()).split("</head>")[0];
      // Winner name + turn/agent counts + map are public post-reveal.
      expect(head).toContain(
        "<title>Alpha wins — Proxy War Replay Premiere</title>",
      );
      expect(head).toContain(
        '<meta property="og:title" content="Alpha wins — Proxy War Replay Premiere">',
      );
      expect(head).toContain(
        '<meta property="og:description" content="Rated league replay · 2 agents · 6 turns · revealed 2026-07-20 · Pangaea">',
      );
      expect(head).toContain('<meta property="og:url" content="');
      // Text-only card: the card-image route intentionally 404s, so no og:image.
      expect(head).toContain('<meta name="twitter:card" content="summary">');
      expect(head).not.toContain("og:image");
      // The shell's own <title> is stripped so exactly one title survives.
      expect(head).not.toContain("<title>Proxy War</title>");
    });
  });

  it("keeps a failed archived page's meta neutral — no winner/standings words", async () => {
    const h = await harness();
    await h.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/premiere/${FAILED_ID}`);
      expect(response.status).toBe(200);
      const head = (await response.text()).split("</head>")[0];
      expect(head).toContain(
        "<title>Premiere ended — Proxy War Replay Premiere</title>",
      );
      expect(head).toContain(
        '<meta property="og:title" content="Premiere ended — Proxy War Replay Premiere">',
      );
      // No outcome/winner/standings language anywhere in the meta.
      expect(head).not.toContain("wins");
      expect(head).not.toContain("Alpha");
      expect(head).not.toContain("standings");
      expect(head).not.toContain("og:image");
    });
  });

  it("still 404s a non-indexed id even with archived meta injection", async () => {
    const h = await harness();
    await h.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/premiere/prem_neverindexed0001`);
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error.code).toBe("DOWNSTREAM_HANDLED");
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

describe("archived durable clip route", () => {
  const CLIP_BYTES = Buffer.from("mp4-bytes-for-archive-test");

  async function plantDurableClip(premiereId: string): Promise<void> {
    const clipsDir = path.join(root, "archive-v1", "clips");
    await fs.mkdir(clipsDir, { recursive: true });
    await fs.writeFile(path.join(clipsDir, `${premiereId}.mp4`), CLIP_BYTES);
  }

  function archivePayloadFrom(html: string): {
    replayRunKey: string | null;
    clipGenerationTarget: {
      kind: "league_run";
      replayRunKey: string;
    } | null;
    clip: { url: string; byteLength: number } | null;
  } {
    const match =
      /<script[^>]*id="proxywar-premiere-archive"[^>]*>([\s\S]*?)<\/script>/.exec(
        html,
      );
    if (match === null) throw new Error("archive payload island missing");
    return JSON.parse(match[1]);
  }

  it("serves the durable clip with download headers, GET and HEAD", async () => {
    const h = await harness();
    await plantDurableClip(ARCHIVED_ID);
    await h.run(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/premiere/${ARCHIVED_ID}/clip.mp4`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(response.headers.get("content-length")).toBe(
        String(CLIP_BYTES.byteLength),
      );
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="${ARCHIVED_ID}.mp4"`,
      );
      // Post-reveal-public: cacheable, but never indexable.
      expect(response.headers.get("cache-control")).toContain("public");
      expect(response.headers.get("x-robots-tag")).toContain("noindex");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(CLIP_BYTES);

      const head = await fetch(`${baseUrl}/premiere/${ARCHIVED_ID}/clip.mp4`, {
        method: "HEAD",
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(
        String(CLIP_BYTES.byteLength),
      );
      expect((await head.arrayBuffer()).byteLength).toBe(0);
    });
  });

  it("404s (fixed body, never downstream) when no durable artifact exists", async () => {
    const h = await harness();
    await h.run(async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/premiere/${ARCHIVED_ID}/clip.mp4`,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "PREMIERE_UNAVAILABLE" },
      });
    });
  });

  it("404s a failed premiere's clip even if an artifact was planted (spoiler gate)", async () => {
    const h = await harness();
    await plantDurableClip(FAILED_ID);
    await h.run(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/premiere/${FAILED_ID}/clip.mp4`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "PREMIERE_UNAVAILABLE" },
      });
    });
  });

  it("404s unknown and registered (non-revealed) ids terminally — no fall-through", async () => {
    const h = await harness();
    // Even a planted artifact for a still-registered premiere must not serve:
    // while the runtime is live the durable route stays closed.
    await plantDurableClip(REGISTERED_ID);
    await h.run(async (baseUrl) => {
      for (const premiereId of ["prem_unknown000000001", REGISTERED_ID]) {
        const response = await fetch(
          `${baseUrl}/premiere/${premiereId}/clip.mp4`,
        );
        expect(response.status).toBe(404);
        // The fixed premiere failure body — proving the request never reached
        // the downstream marker (no DOWNSTREAM_HANDLED).
        expect(await response.json()).toEqual({
          error: { code: "PREMIERE_UNAVAILABLE" },
        });
      }
    });
  });

  it("rejects range requests and non-GET methods", async () => {
    const h = await harness();
    await plantDurableClip(ARCHIVED_ID);
    await h.run(async (baseUrl) => {
      const range = await fetch(`${baseUrl}/premiere/${ARCHIVED_ID}/clip.mp4`, {
        headers: { Range: "bytes=0-3" },
      });
      expect(range.status).toBe(416);
      const post = await fetch(`${baseUrl}/premiere/${ARCHIVED_ID}/clip.mp4`, {
        method: "POST",
      });
      expect(post.status).toBe(405);
      expect(post.headers.get("allow")).toBe("GET, HEAD");
    });
  });

  it("embeds the clip in the archived page payload only when the artifact exists", async () => {
    const h = await harness();
    await h.run(async (baseUrl) => {
      // Availability is a per-request stat: absent before, present after.
      const before = archivePayloadFrom(
        await (await fetch(`${baseUrl}/premiere/${ARCHIVED_ID}`)).text(),
      );
      expect(before.clip).toBeNull();

      await plantDurableClip(ARCHIVED_ID);
      const after = archivePayloadFrom(
        await (await fetch(`${baseUrl}/premiere/${ARCHIVED_ID}`)).text(),
      );
      expect(after.clip).toEqual({
        url: `/premiere/${ARCHIVED_ID}/clip.mp4`,
        byteLength: CLIP_BYTES.byteLength,
      });
    });
  });

  it("exposes a replay-scoped generation target only while the ordinary source is retained", async () => {
    const expectedRunKey = "league-coworld-run-001";
    const missing = await harness({ retainedRunKeys: new Set() });
    await missing.run(async (baseUrl) => {
      const payload = archivePayloadFrom(
        await (await fetch(`${baseUrl}/premiere/${ARCHIVED_ID}`)).text(),
      );
      expect(payload.replayRunKey).toBe(expectedRunKey);
      expect(payload.clipGenerationTarget).toBeNull();
    });

    const retained = await harness({
      retainedRunKeys: new Set([expectedRunKey]),
    });
    await retained.run(async (baseUrl) => {
      const payload = archivePayloadFrom(
        await (await fetch(`${baseUrl}/premiere/${ARCHIVED_ID}`)).text(),
      );
      expect(payload.clipGenerationTarget).toEqual({
        kind: "league_run",
        replayRunKey: expectedRunKey,
      });
    });
  });
});
