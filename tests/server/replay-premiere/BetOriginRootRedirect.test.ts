/**
 * P0 fix (found live 2026-08-02): a cache-busted GET of the betting
 * origin's root ("/") served the legacy internal demo hub ("Proxy War
 * (ALPHA)" title/shell) instead of the live market, even though "/bet" on
 * the exact SAME origin already correctly resolved to it. The betting
 * origin's homepage must BE the market.
 *
 * Root cause: `ai-agent-demo-server.ts` registers TWO "GET /" handlers.
 * The FIRST one (near the top of the file) short-circuits with
 * `if (leagueWrapperOnly && !platformEnabled) { ...serve the demo hub...
 * return; }` before ever reaching the second handler or any wagering
 * check. Production bet-origin sets BOTH `leagueWrapperOnly=true` and
 * `pointsRoutesEnabled=true` (`PROXYWAR_WAGERING_ENABLED=1`) while never
 * setting `PROXYWAR_PLATFORM_ENABLED` (`platformEnabled=false`) — see
 * cycle-premiere.sh's `start_origin()` for the exact production env this
 * test mirrors — so the demo-hub branch always won regardless of wagering
 * being on. The fix checks `pointsRoutesEnabled` FIRST, ahead of that
 * branch, and redirects to `/bet` (unchanged, still resolves to whichever
 * premiere is currently live).
 *
 * Same real-server spawn convention as `BetOriginLeagueMirrorRedirect.test.ts`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe("bet-origin's homepage IS the market, not the legacy internal demo hub", () => {
  let fixtureRoot = "";
  let privateStateRoot = "";
  let pointsLedgerRoot = "";
  let server: ChildProcess | null = null;
  let origin = "";
  let serverOutput = "";

  beforeAll(async () => {
    fixtureRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "proxywar-bet-root-redirect-")),
    );
    const homeRoot = path.join(fixtureRoot, "home");
    const nationsRoot = path.join(fixtureRoot, "nations");
    const staticRoot = path.join(fixtureRoot, "static");
    const artifactsRoot = path.join(fixtureRoot, "artifacts");
    const leagueRoot = path.join(artifactsRoot, "ai-league-runs", "league");
    privateStateRoot = path.join(
      path.dirname(fixtureRoot),
      `${path.basename(fixtureRoot)}-premiere-state`,
    );
    pointsLedgerRoot = path.join(
      path.dirname(fixtureRoot),
      `${path.basename(fixtureRoot)}-points-ledger`,
    );

    await Promise.all([
      mkdir(homeRoot, { recursive: true }),
      mkdir(nationsRoot, { recursive: true }),
      mkdir(staticRoot, { recursive: true }),
      mkdir(leagueRoot, { recursive: true }),
      mkdir(path.join(fixtureRoot, "resources", "lang"), { recursive: true }),
      mkdir(privateStateRoot, { recursive: true }),
      mkdir(pointsLedgerRoot, { recursive: true }),
    ]);
    await chmod(privateStateRoot, 0o700);
    await chmod(pointsLedgerRoot, 0o700);

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
      // Only needed so waitForServer's readiness probe (below) gets a real
      // 200 — this test never asserts on /league's own content.
      writeFile(
        path.join(leagueRoot, "index.html"),
        "<!doctype html><html><body>league readiness fixture</body></html>",
        "utf8",
      ),
    ]);

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
          // Exact production combination (cycle-premiere.sh's
          // start_origin()): both true, PROXYWAR_PLATFORM_ENABLED unset.
          PROXYWAR_LEAGUE_WRAPPER_ONLY: "true",
          PROXYWAR_WAGERING_ENABLED: "true",
          PROXYWAR_CLIPS_ENABLED: "false",
          PROXYWAR_PREMIERE_CLIPS_ENABLED: "false",
          PROXYWAR_LEAGUE_CLIPS_ENABLED: "false",
          PROXYWAR_ARTIFACTS_ROOT: artifactsRoot,
          PROXYWAR_NATIONS_DIR: nationsRoot,
          PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: privateStateRoot,
          PROXYWAR_POINTS_LEDGER_ROOT: pointsLedgerRoot,
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
    if (fixtureRoot !== "")
      await rm(fixtureRoot, { recursive: true, force: true });
    if (privateStateRoot !== "")
      await rm(privateStateRoot, { recursive: true, force: true });
    if (pointsLedgerRoot !== "")
      await rm(pointsLedgerRoot, { recursive: true, force: true });
  });

  test("GET / redirects 302 to /bet — never the legacy internal demo hub — under the exact production env combination", async () => {
    const response = await rawRequest(origin, "/");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/bet");
    expect(response.body).not.toContain("Proxy War (ALPHA)");
  });

  test("HEAD / also redirects (a cache-busted probe, not just a plain GET)", async () => {
    const response = await rawRequest(origin, "/", "HEAD");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/bet");
  });

  test("/bet itself is untouched — no premiere registered still 503s honestly rather than rendering a stale surface", async () => {
    const response = await rawRequest(origin, "/bet");
    expect(response.status).toBe(503);
    expect(response.body).toContain("No premiere is currently running.");
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
  method: "GET" | "HEAD" = "GET",
): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        method,
        path: requestPath,
        headers: { accept: "text/html" },
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
