/**
 * Frontier games are not league episodes, so before Season 2 their
 * `/match/<id>` pages answered 404 with no share card even though
 * `/api/matches/<id>` found them in the Frontier publisher's
 * `frontier-episodes.json`. And `/world` named the site root as its own
 * address, so a shared world link previewed as the home page.
 *
 * Boots the REAL demo server (the same `spawn`+`tsx` pattern as
 * `FeaturedMatchDetailHttp.test.ts`) over a site directory the Season 2
 * publisher itself wrote, and checks the HTTP responses.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { publishFrontierForm } from "../../src/server/agents/FrontierForm";
import { publishFrontierWorld } from "../../src/server/agents/FrontierFourWorld";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);

const SEASON_TWO_ID = "ereq_14f5f5fc-4a5a-40ba-bb43-2a5b0e2f7bc6";
const SEASON_ONE_ID = "ereq_season_one_game";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function seasonTwoGame() {
  const seats: [string, string, number, number, number][] = [
    ["Grok", "x-ai/grok-4.7", 0, 0.3446, 2],
    ["Gemini", "google/gemini-3.1-pro-preview", 1, 0, 4],
    ["Astra", "openai/gpt-6-astra", 2, 0.2411, 3],
    ["Fable", "anthropic/claude-fable-5.1", 3, 0.4143, 1],
    ["Opus", "anthropic/claude-opus-5.5", 4, 0, 5],
  ];
  return {
    schemaVersion: 2,
    season: 2,
    format: "ffa",
    experienceRequestId: "xreq_frontier_http",
    episodeRequestId: SEASON_TWO_ID,
    variantId: "ffa5-eastasia",
    map: "EastAsia",
    mapSize: "Compact",
    frontLabel: "East Asia",
    completedAt: "2026-10-05T17:06:32.859Z",
    replayUrl:
      "https://softmax-public.s3.amazonaws.com/replays/2bbf4111-0153-423c-a53a-c55224ae154f.replay",
    viewerUrl: null,
    costUsd: 0.07,
    cycle: 4,
    gameIndex: 4,
    episodeIndex: 4,
    sides: seats.map(([label, model, slot], index) => ({
      label,
      model,
      team: null,
      slots: [slot],
      pickOrder: index + 1,
    })),
    winnerLabel: "Fable",
    winType: "points",
    standings: seats.map(([label, , , landShare, rank]) => ({
      label,
      landShare,
      tilesOwned: Math.round(landShare * 880000),
      isAlive: landShare > 0,
      eliminatedAtTurn: landShare > 0 ? null : 20000,
      rank,
    })),
    turnCount: 24000,
    decisionCount: 1200,
    degradedCount: 10,
    telemetry: {},
    voices: [],
    moments: [],
    harness: null,
  };
}

function seasonOneGame() {
  const teams = [
    { label: "Astra", model: "openai/gpt-6-astra", team: "Red", slots: [0] },
    { label: "Grok", model: "x-ai/grok-4.7", team: "Blue", slots: [1] },
  ];
  return {
    schemaVersion: 1,
    experienceRequestId: "xreq_season_one",
    episodeRequestId: SEASON_ONE_ID,
    variantId: "teams-4x3-asia",
    map: "Asia",
    mapSize: "Normal",
    completedAt: "2026-10-04T15:23:54.346Z",
    replayUrl: "https://softmax-public.s3.amazonaws.com/replays/s1.replay",
    viewerUrl: null,
    costUsd: 9.5,
    cycle: 1,
    teams,
    winnerTeam: "Blue",
    scores: [],
    players: [
      { slot: 0, name: "Astra 1", team: "Red", tilesOwned: 10, isAlive: true },
      { slot: 1, name: "Grok 1", team: "Blue", tilesOwned: 90, isAlive: true },
    ],
    turnCount: 20900,
    decisionCount: 2248,
    degradedCount: 166,
  };
}

describe("Frontier /match pages and the /world page address", () => {
  let fixtureRoot = "";
  let artifactsRoot = "";
  let privateStateRoot = "";
  let featuredMatchStateRoot = "";
  let pinManifestPath = "";
  let server: ChildProcess | null = null;
  let origin = "";
  let serverOutput = "";

  beforeAll(async () => {
    fixtureRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "proxywar-frontier-match-http-")),
    );
    artifactsRoot = await realpath(
      await mkdtemp(
        path.join(tmpdir(), "proxywar-frontier-match-http-artifacts-"),
      ),
    );
    const homeRoot = path.join(fixtureRoot, "home");
    const nationsRoot = path.join(fixtureRoot, "nations");
    const staticRoot = path.join(fixtureRoot, "static");
    const identityDir = path.join(fixtureRoot, "identity");
    const leagueRoot = path.join(artifactsRoot, "ai-league-runs", "league");
    privateStateRoot = path.join(
      path.dirname(fixtureRoot),
      `${path.basename(fixtureRoot)}-premiere-state`,
    );
    featuredMatchStateRoot = path.join(
      path.dirname(fixtureRoot),
      `${path.basename(fixtureRoot)}-featured-matches`,
    );
    pinManifestPath = path.join(
      path.dirname(fixtureRoot),
      `${path.basename(fixtureRoot)}-retention-pins.json`,
    );
    await Promise.all([
      mkdir(homeRoot, { recursive: true }),
      mkdir(nationsRoot, { recursive: true }),
      mkdir(staticRoot, { recursive: true }),
      mkdir(identityDir, { recursive: true }),
      mkdir(leagueRoot, { recursive: true }),
      mkdir(path.join(fixtureRoot, "resources", "lang"), { recursive: true }),
      mkdir(privateStateRoot, { recursive: true }),
      mkdir(featuredMatchStateRoot, { recursive: true }),
    ]);
    await chmod(privateStateRoot, 0o700);

    const gamesPath = path.join(fixtureRoot, "frontier-ffa-games.jsonl");
    const seasonOnePath = path.join(fixtureRoot, "games.jsonl");
    await Promise.all([
      writeFile(
        path.join(fixtureRoot, "index.html"),
        "<!doctype html><html><head><title>Proxy War</title></head><body>PROXY WAR</body></html>",
      ),
      writeFile(
        path.join(staticRoot, "index.html"),
        "<!doctype html><html><head><title>Proxy War</title></head><body>PROXY WAR</body></html>",
      ),
      writeFile(
        path.join(staticRoot, "public.html"),
        '<!doctype html><html><head><title>Proxy War</title><link rel="canonical" href="https://proxywar.test/" /><meta name="description" content="Proxy War"><meta property="og:url" content="https://proxywar.test/" /><meta property="og:title" content="Proxy War" /><script>window.GIT_COMMIT = <%- gitCommit %>;</script></head><body>PUBLIC APP</body></html>',
      ),
      writeFile(
        path.join(leagueRoot, "index.html"),
        "<!doctype html><html><body>PROXY WAR league</body></html>",
      ),
      writeFile(
        path.join(leagueRoot, "data.json"),
        JSON.stringify({
          generatedAt: "2026-10-05T18:00:00.000Z",
          lastGoodSyncAt: "2026-10-05T18:00:00.000Z",
          stale: false,
          standings: [],
          episodes: [],
        }),
      ),
      writeFile(path.join(fixtureRoot, "resources", "lang", "en.json"), "{}"),
      writeFile(
        path.join(identityDir, "builders.json"),
        JSON.stringify({ schemaVersion: 1, builders: [] }),
      ),
      writeFile(
        path.join(identityDir, "agents.json"),
        JSON.stringify({ schemaVersion: 1, agents: [] }),
      ),
      writeFile(
        path.join(identityDir, "versions.json"),
        JSON.stringify({ schemaVersion: 1, versions: [] }),
      ),
      writeFile(gamesPath, `${JSON.stringify(seasonTwoGame())}\n`),
      writeFile(seasonOnePath, `${JSON.stringify(seasonOneGame())}\n`),
    ]);
    const publication = await publishFrontierWorld({
      siteDir: leagueRoot,
      gamesPath,
      seasonOneGamesPath: seasonOnePath,
      now: "2026-10-05T18:00:00.000Z",
    });
    await publishFrontierForm({
      siteDir: leagueRoot,
      records: publication.records,
      teams: publication.teams,
      now: "2026-10-05T18:00:00.000Z",
    });

    const port = await reservePort();
    origin = `http://127.0.0.1:${port}`;
    server = spawn(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        "--tsconfig",
        path.join(projectRoot, "tsconfig.json"),
        path.join(projectRoot, "src", "scripts", "ai-agent-demo-server.ts"),
      ],
      {
        cwd: fixtureRoot,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: homeRoot,
          NODE_ENV: "test",
          GAME_ENV: "dev",
          AI_LEAGUE_DEMO_HOST: "127.0.0.1",
          AI_LEAGUE_DEMO_PORT: String(port),
          AI_LEAGUE_DEMO_RENDERER: "false",
          PROXYWAR_BETA_ENABLED: "false",
          PROXYWAR_LEAGUE_WRAPPER_ONLY: "true",
          PROXYWAR_CLIPS_ENABLED: "false",
          PROXYWAR_PREMIERE_CLIPS_ENABLED: "false",
          PROXYWAR_LEAGUE_CLIPS_ENABLED: "false",
          PROXYWAR_ARTIFACTS_ROOT: artifactsRoot,
          PROXYWAR_NATIONS_DIR: nationsRoot,
          PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: privateStateRoot,
          PROXYWAR_FEATURED_MATCH_STATE_ROOT: featuredMatchStateRoot,
          PROXYWAR_IDENTITY_REGISTRY_DIR: identityDir,
          PROXYWAR_LEAGUE_RETENTION_PINS: pinManifestPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout?.on("data", (chunk: Buffer) => {
      serverOutput += chunk.toString();
    });
    server.stderr?.on("data", (chunk: Buffer) => {
      serverOutput += chunk.toString();
    });
    await waitForServer(origin, () => serverOutput, server);
  }, 30_000);

  afterAll(async () => {
    await stopServer(server);
    for (const dir of [
      fixtureRoot,
      artifactsRoot,
      privateStateRoot,
      featuredMatchStateRoot,
    ]) {
      if (dir !== "") await rm(dir, { recursive: true, force: true });
    }
    await rm(pinManifestPath, { force: true });
  });

  test("a Season 2 game's /match page resolves with its own social card", async () => {
    const response = await rawRequest(origin, `/match/${SEASON_TWO_ID}`);
    expect(response.status).toBe(200);
    expect(response.body).toContain(
      `<meta property="og:url" content="${origin}/match/${SEASON_TWO_ID}">`,
    );
    expect(response.body).toContain(
      "Watch this Proxy War Frontier battle: Grok, Gemini, Astra, Fable, Opus on EastAsia.",
    );
    expect(response.body).toContain(
      "Grok vs Gemini +3 more — EastAsia, Round 4",
    );
    expect(response.body).not.toContain("league battle");

    const card = await rawRequest(
      origin,
      `/match/${SEASON_TWO_ID}/card-v1.svg`,
    );
    expect(card.status).toBe(200);
    expect(card.headers["content-type"]).toContain("image/svg+xml");
    expect(card.body).toContain("Fable");

    const api = await rawRequest(origin, `/api/matches/${SEASON_TWO_ID}`);
    expect(api.status).toBe(200);
  });

  test("a Season 1 game's /match page still resolves after Season 2 takes over", async () => {
    const response = await rawRequest(origin, `/match/${SEASON_ONE_ID}`);
    expect(response.status).toBe(200);
    expect(response.body).toContain(
      "Watch this Proxy War Frontier battle: Astra 1, Grok 1 on Asia.",
    );
  });

  test("an unknown id is still a 404", async () => {
    const response = await rawRequest(origin, "/match/ereq_not_a_game");
    expect(response.status).toBe(404);
  });

  test("serves the Nerf Watch file beside world.json", async () => {
    const form = await rawRequest(
      origin,
      "/ai-league-runs/league/frontier-form.json",
    );
    expect(form.status).toBe(200);
    expect(form.headers["content-type"]).toContain("application/json");
    const body = JSON.parse(form.body);
    expect(body.schemaVersion).toBe(1);
    expect(body.models.map((model: { label: string }) => model.label)).toEqual([
      "Astra",
      "Fable",
      "Opus",
      "Gemini",
      "Grok",
    ]);
    const world = await rawRequest(origin, "/ai-league-runs/league/world.json");
    expect(world.status).toBe(200);
    // The private ledger stays private.
    const ledger = await rawRequest(
      origin,
      "/ai-league-runs/league/world-ledger.json",
    );
    expect(ledger.status).toBe(404);
  });

  test("/world names /world as its address", async () => {
    const response = await rawRequest(origin, "/world");
    expect(response.status).toBe(200);
    expect(response.body).toContain(
      `<link rel="canonical" href="${origin}/world">`,
    );
    expect(response.body).toContain(
      `<meta property="og:url" content="${origin}/world">`,
    );
    expect(response.body).not.toContain("https://proxywar.test/");
    // Everything else in the shell is left as it was.
    expect(response.body).toContain(
      '<meta property="og:title" content="Proxy War" />',
    );
    expect(response.body).toContain("PUBLIC APP");
  });
});

async function stopServer(server: ChildProcess | null): Promise<void> {
  if (server === null || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => server.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

async function reservePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (address === null || typeof address === "string") {
    listener.close();
    throw new Error("Failed to reserve a local HTTP port");
  }
  await new Promise<void>((resolve, reject) =>
    listener.close((error) =>
      error === undefined ? resolve() : reject(error),
    ),
  );
  return address.port;
}

async function waitForServer(
  baseUrl: string,
  output: () => string,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early:\n${output()}`);
    }
    try {
      const response = await rawRequest(baseUrl, "/league");
      if (response.status === 200) return;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for server:\n${output()}`);
}

async function rawRequest(
  baseUrl: string,
  requestPath: string,
): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        method: "GET",
        path: requestPath,
        headers: { accept: "text/html,application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}
