/**
 * Gap 1: the platform's own homepage. Two things must hold:
 *   1. `renderPlatformRootHtml` says what Proxy War is and gives exactly
 *      four ways in (League, Replays, Market, Account).
 *   2. Against a REAL running server, `GET /` renders that page ONLY when
 *      `PROXYWAR_PLATFORM_ENABLED` — every other process keeps serving the
 *      byte-identical internal demo hub, proven against the SAME pure
 *      `loadAgentDemoHubModel` + `renderAgentDemoHubHtml` the route itself
 *      calls, not merely assumed unchanged.
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
import {
  loadAgentDemoHubModel,
  renderAgentDemoHubHtml,
} from "../../src/server/agents/AgentDemoHub";
import { loadProxyWarHouseAgentBrain } from "../../src/server/agents/AgentDemoServerJobs";
import { renderPlatformRootHtml } from "../../src/server/platform/PlatformRootPage";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);

describe("renderPlatformRootHtml (pure)", () => {
  test("states what Proxy War is and gives exactly four ways in", () => {
    const html = renderPlatformRootHtml({
      leagueUrl: "https://beta.example/league",
      replaysUrl: "https://beta.example/watch",
      marketUrl: "https://bet.example/bet",
      githubSignInAvailable: true,
    });
    expect(html).toContain("Proxy War");
    // One clear explainer sentence, not a dashboard.
    expect(html).toMatch(/AI agents fight for territory/);
    // Exactly four entry points, unmistakably labelled.
    for (const label of ["League", "Replays", "Market", "Account"]) {
      expect(html).toContain(`<h2>${label}</h2>`);
    }
    expect(html).toContain('href="https://beta.example/league"');
    expect(html).toContain('href="https://beta.example/watch"');
    expect(html).toContain('href="https://bet.example/bet"');
    // Replays and Market cards must have different hrefs
    const replayMatch = html.match(/href="([^"]*)"[^<]*<h2>Replays<\/h2>/);
    const marketMatch = html.match(/href="([^"]*)"[^<]*<h2>Market<\/h2>/);
    expect(replayMatch).toBeTruthy();
    expect(marketMatch).toBeTruthy();
    expect(replayMatch![1]).not.toEqual(marketMatch![1]);
    // Replays href must not point to /bet
    expect(replayMatch![1]).not.toMatch(/\/bet($|[?#])/);
    // Never a duplicate of the account page's own content/controls.
    expect(html).not.toContain("display-name");
    expect(html).not.toContain("csrfToken");
  });

  test("never advertises a sign-in that does not exist on this process", () => {
    // The OAuth routes are absent entirely without configured credentials, so
    // a homepage promising GitHub sign-in would be advertising a 404. The
    // meta description must not claim cross-surface identity either: the
    // league has no handoff integration, so identity reaches the market only.
    const html = renderPlatformRootHtml({
      leagueUrl: "https://beta.example/league",
      replaysUrl: "https://beta.example/watch",
      marketUrl: "https://bet.example/bet",
      githubSignInAvailable: false,
    });
    expect(html).not.toContain("Sign in with GitHub");
    expect(html).not.toContain("every surface");
    // Still offers the account page — guest identity is real and useful.
    expect(html).toContain("/account");
  });
});

describe("GET / (real servers)", () => {
  let platformFixture = "";
  let hubFixture = "";
  let platform: ChildProcess | null = null;
  let hub: ChildProcess | null = null;
  let platformOrigin = "";
  let hubOrigin = "";
  let platformOutput = "";
  let hubOutput = "";
  let hubArtifactsRoot = "";
  let hubNationsRoot = "";

  beforeAll(async () => {
    platformFixture = await realpath(
      await mkdtemp(path.join(tmpdir(), "proxywar-platform-root-")),
    );
    hubFixture = await realpath(
      await mkdtemp(path.join(tmpdir(), "proxywar-hub-root-")),
    );

    const platformPort = await reservePort();
    const hubPort = await reservePort();
    platformOrigin = `http://127.0.0.1:${platformPort}`;
    hubOrigin = `http://127.0.0.1:${hubPort}`;

    const platformArtifactsRoot = path.join(platformFixture, "artifacts");
    hubArtifactsRoot = path.join(hubFixture, "artifacts");
    hubNationsRoot = path.join(hubFixture, "nations");

    const platformStateRoot = path.join(
      path.dirname(platformFixture),
      `${path.basename(platformFixture)}-platform-private`,
    );
    await Promise.all([
      seedMinimalFixture(platformFixture, platformArtifactsRoot),
      seedMinimalFixture(hubFixture, hubArtifactsRoot),
      mkdir(hubNationsRoot, { recursive: true }),
      mkdir(platformStateRoot, { recursive: true }),
    ]);
    await chmod(platformStateRoot, 0o700);

    platform = spawn(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        "--tsconfig",
        path.join(projectRoot, "tsconfig.json"),
        path.join(projectRoot, "src", "scripts", "ai-agent-demo-server.ts"),
      ],
      {
        cwd: platformFixture,
        env: {
          ...baseServerEnv(
            platformFixture,
            platformPort,
            platformArtifactsRoot,
          ),
          PROXYWAR_PLATFORM_ENABLED: "true",
          PROXYWAR_LEAGUE_WRAPPER_ONLY: "true",
          PROXYWAR_PLATFORM_STATE_ROOT: platformStateRoot,
          PROXYWAR_LEAGUE_HOME_URL: "https://beta.proxywar.test/league",
          PROXYWAR_MARKET_HOME_URL: "https://bet.proxywar.test/bet",
          // Deliberately NOT overridden: this is the one test that must
          // exercise the REAL default (`platformReplaysHomeUrl` in
          // ai-agent-demo-server.ts, currently `https://beta.proxywar.xyz/
          // watch`) instead of an env value that happens to already be
          // correct. Overriding it to a bet.-shaped URL here would make
          // this suite pass even if the default regressed back to
          // `${bettingOrigin}/bet` (see `b9ca3238a`'s fix and its own
          // supersession note above `platformMarketHomeUrl` in that file).
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    platform.stdout?.on(
      "data",
      (chunk: Buffer) => (platformOutput += chunk.toString()),
    );
    platform.stderr?.on(
      "data",
      (chunk: Buffer) => (platformOutput += chunk.toString()),
    );

    hub = spawn(
      process.execPath,
      [
        require.resolve("tsx/cli"),
        "--tsconfig",
        path.join(projectRoot, "tsconfig.json"),
        path.join(projectRoot, "src", "scripts", "ai-agent-demo-server.ts"),
      ],
      {
        cwd: hubFixture,
        env: baseServerEnv(
          hubFixture,
          hubPort,
          hubArtifactsRoot,
          hubNationsRoot,
        ),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    hub.stdout?.on("data", (chunk: Buffer) => (hubOutput += chunk.toString()));
    hub.stderr?.on("data", (chunk: Buffer) => (hubOutput += chunk.toString()));

    await Promise.all([
      waitForServer(platformOrigin, () => platformOutput, platform),
      waitForServer(hubOrigin, () => hubOutput, hub),
    ]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([stopServer(platform), stopServer(hub)]);
    if (platformFixture !== "")
      await rm(platformFixture, { recursive: true, force: true });
    if (hubFixture !== "")
      await rm(hubFixture, { recursive: true, force: true });
  });

  test("PROXYWAR_PLATFORM_ENABLED serves the platform landing page at /, redirect gate included", async () => {
    const response = await rawRequest(platformOrigin, "/");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Proxy War");
    for (const label of ["League", "Replays", "Market", "Account"]) {
      expect(response.body).toContain(`<h2>${label}</h2>`);
    }
    expect(response.body).toContain('href="https://beta.proxywar.test/league"');
    expect(response.body).toContain('href="https://bet.proxywar.test/bet"');
    expect(response.body).toContain('href="/account"');
    // The Replays card must use the REAL, un-overridden production default
    // (`platformReplaysHomeUrl`) — scoped to that card's own anchor, not a
    // bare substring match, so this fails if a future regression points
    // Replays back at the betting origin (the exact bug `b9ca3238a` fixed:
    // Replays and Market sharing one URL with no way to tell them apart).
    const replaysCardHref = /href="([^"]+)"[^>]*>\s*<h2>Replays<\/h2>/.exec(
      response.body,
    )?.[1];
    expect(replaysCardHref).toBe("https://beta.proxywar.xyz/watch");
    expect(replaysCardHref).not.toContain("bet.");
    // Not the internal demo hub.
    expect(response.body).not.toContain("Proxy War Demo");
  });

  test("without PROXYWAR_PLATFORM_ENABLED, / renders the byte-identical internal demo hub", async () => {
    const response = await rawRequest(hubOrigin, "/");
    expect(response.status).toBe(200);
    const expectedModel = await loadAgentDemoHubModel({
      runsRootDir: path.join(hubArtifactsRoot, "ai-league-runs"),
      tournamentsRootDir: path.join(hubArtifactsRoot, "ai-league-tournaments"),
      evaluationsRootDir: path.join(hubArtifactsRoot, "ai-league-evals"),
      rendererBaseUrl: "http://127.0.0.1:9000",
      jobs: [],
      nationsDir: hubNationsRoot,
      manifestDir: path.join(hubFixture, "docs", "ai-league-agent-manifests"),
      houseAgentBrain: loadProxyWarHouseAgentBrain({}),
      closedBeta: undefined,
    });
    const expectedHtml = renderAgentDemoHubHtml(expectedModel);
    expect(response.body).toBe(expectedHtml);
    // Sanity: proves the comparison isn't vacuous.
    expect(response.body).not.toContain("Autonomous-agent strategy arena");
  });
});

function privateStateRootFor(fixtureRoot: string): string {
  return path.join(
    path.dirname(fixtureRoot),
    `${path.basename(fixtureRoot)}-premiere-state`,
  );
}

async function seedMinimalFixture(
  fixtureRoot: string,
  artifactsRoot: string,
): Promise<void> {
  const staticRoot = path.join(fixtureRoot, "static");
  const privateStateRoot = privateStateRootFor(fixtureRoot);
  await Promise.all([
    mkdir(staticRoot, { recursive: true }),
    mkdir(path.join(artifactsRoot, "ai-league-runs", "league"), {
      recursive: true,
    }),
    mkdir(path.join(fixtureRoot, "resources", "lang"), { recursive: true }),
    mkdir(privateStateRoot, { recursive: true }),
  ]);
  await chmod(privateStateRoot, 0o700);
  await Promise.all([
    writeFile(
      path.join(fixtureRoot, "index.html"),
      "<!doctype html><html><head><title>Proxy War</title></head><body>PROXY WAR</body></html>",
      "utf8",
    ),
    writeFile(
      path.join(staticRoot, "index.html"),
      "<!doctype html><html><head><title>Proxy War</title></head><body>PROXY WAR</body></html>",
      "utf8",
    ),
    writeFile(
      path.join(fixtureRoot, "resources", "lang", "en.json"),
      "{}",
      "utf8",
    ),
    writeFile(
      path.join(artifactsRoot, "ai-league-runs", "league", "data.json"),
      JSON.stringify({
        generatedAt: "2026-07-27T00:00:00.000Z",
        lastGoodSyncAt: "2026-07-27T00:00:00.000Z",
        stale: false,
        standings: [],
        episodes: [],
      }),
      "utf8",
    ),
    writeFile(
      path.join(artifactsRoot, "ai-league-runs", "league", "index.html"),
      "<!doctype html><html><body>PROXY WAR league</body></html>",
      "utf8",
    ),
  ]);
}

function baseServerEnv(
  fixtureRoot: string,
  port: number,
  artifactsRoot: string,
  nationsRoot?: string,
): NodeJS.ProcessEnv {
  const privateStateRoot = privateStateRootFor(fixtureRoot);
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: path.join(fixtureRoot, "home"),
    NODE_ENV: "test",
    GAME_ENV: "dev",
    AI_LEAGUE_DEMO_HOST: "127.0.0.1",
    AI_LEAGUE_DEMO_PORT: String(port),
    AI_LEAGUE_DEMO_RENDERER: "false",
    PROXYWAR_BETA_ENABLED: "false",
    PROXYWAR_LEAGUE_WRAPPER_ONLY: "false",
    PROXYWAR_WAGERING_ENABLED: "false",
    PROXYWAR_CLIPS_ENABLED: "false",
    PROXYWAR_PREMIERE_CLIPS_ENABLED: "false",
    PROXYWAR_LEAGUE_CLIPS_ENABLED: "false",
    PROXYWAR_ARTIFACTS_ROOT: artifactsRoot,
    PROXYWAR_NATIONS_DIR: nationsRoot ?? path.join(fixtureRoot, "nations"),
    PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: privateStateRoot,
  };
}

// `new Promise(executor)`, not `Promise.withResolvers` — this project
// targets ES2022 lib (no ES2024), same reasoning as
// `PremiereWageringXpRequest.ts`'s doc comment.
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

function rawRequest(
  baseUrl: string,
  requestPath: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, baseUrl);
    const request = http.request(url, { method: "GET" }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => (body += chunk.toString()));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body,
        }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

// Polls a real spawned subprocess's real listening socket — there is no
// event to await instead (the process either hasn't bound the port yet or
// has, and only a live request tells us which), so a genuine wall-clock
// poll is unavoidable here.
async function waitForServer(
  baseUrl: string,
  output: () => string,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Server (${baseUrl}) exited early:\n${output()}`);
    }
    try {
      const response = await rawRequest(baseUrl, "/league");
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for server (${baseUrl}):\n${output()}`);
}

// Graceful-then-forced shutdown of a real child process; the bounded wait
// is a real-clock grace period for SIGTERM, not something fakeable.
async function stopServer(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
