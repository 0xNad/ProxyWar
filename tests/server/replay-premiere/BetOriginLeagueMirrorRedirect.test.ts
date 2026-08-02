/**
 * P0 honesty fix (found live 2026-08-02): the bet origin (`PROXYWAR_
 * WAGERING_ENABLED=true`) serves its own byte-for-byte snapshot of the
 * league mirror at `/league` (and its `/ai-league-runs/league*` static
 * alias), asserting `data-stale="false"` and a `generated-at` timestamp
 * frozen from whenever the deploy's clone was checked out, while the real
 * league on the league origin keeps advancing. Product separation: a
 * league standings PAGE belongs on the league origin, so a real visitor
 * must be redirected there instead.
 *
 * That redirect is deliberately narrow — see `ai-agent-demo-server.ts`'s
 * own comment above the guard for the full reasoning — because two
 * internal safety checks depend on this exact path answering 200 with
 * real content on the wagering origin and cannot be pointed anywhere
 * else:
 *   - `cycle-premiere.sh`'s `wait_for_origin` / `replay-premiere-loop.ts`'s
 *     `restartReadyUrl` poll it directly over loopback (no `Sec-Fetch-*`
 *     headers, no forwarding headers) to confirm a restart landed.
 *   - `replay-premiere-admit.ts`'s leak-audit collector fetches it over
 *     the PUBLIC origin (arrives here with a forwarding header, exactly
 *     like real Cloudflare-tunnelled traffic, but never sends
 *     `Sec-Fetch-Dest`, because it is a `fetch()` call, never a browser
 *     navigation) with `redirect: "error"` — a blanket redirect would
 *     make every premiere admission fail closed.
 *
 * This proves, against a REAL running server (not a unit-level fake),
 * that a genuine browser navigation gets redirected while both internal
 * shapes above keep getting 200.
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
const canonicalLeagueUrl = "https://beta.proxywar.test/league";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe("bet origin's copied /league mirror redirects a real visitor, not the safety checks that depend on it", () => {
  let fixtureRoot = "";
  let privateStateRoot = "";
  let pointsLedgerRoot = "";
  let server: ChildProcess | null = null;
  let origin = "";
  let serverOutput = "";

  beforeAll(async () => {
    fixtureRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "proxywar-bet-league-redirect-")),
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
      // The frozen copy under test: baked `data-stale="false"` and a
      // long-past `generated-at`, exactly the shape the live bet.proxywar.xyz
      // clone served (frozen 2026-07-27).
      writeFile(
        path.join(leagueRoot, "index.html"),
        '<!doctype html><html><body data-generated-at="2026-07-27T12:04:13.804Z" data-stale="false">frozen bet-origin league copy</body></html>',
        "utf8",
      ),
      writeFile(
        path.join(leagueRoot, "data.json"),
        JSON.stringify({
          generatedAt: "2026-07-27T00:00:00.000Z",
          lastGoodSyncAt: "2026-07-27T00:00:00.000Z",
          stale: false,
          standings: [],
          episodes: [],
        }),
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
          PROXYWAR_LEAGUE_WRAPPER_ONLY: "true",
          PROXYWAR_WAGERING_ENABLED: "true",
          PROXYWAR_CLIPS_ENABLED: "false",
          PROXYWAR_PREMIERE_CLIPS_ENABLED: "false",
          PROXYWAR_LEAGUE_CLIPS_ENABLED: "false",
          PROXYWAR_ARTIFACTS_ROOT: artifactsRoot,
          PROXYWAR_NATIONS_DIR: nationsRoot,
          PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: privateStateRoot,
          PROXYWAR_POINTS_LEDGER_ROOT: pointsLedgerRoot,
          PROXYWAR_LEAGUE_HOME_URL: canonicalLeagueUrl,
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

  test.each(["/league", "/ai-league-runs/league/index.html"])(
    "a real browser navigation to %s is redirected 302 to the canonical league origin",
    async (requestPath) => {
      const response = await rawRequest(origin, requestPath, {
        // Every real browser navigation sends this; curl and Node's
        // fetch/undici never do.
        "sec-fetch-dest": "document",
        // Cloudflare adds this for every tunnelled request, so a real
        // internet visitor looks like this even though the origin process
        // only ever sees loopback sockets behind the tunnel.
        "x-forwarded-for": "203.0.113.7",
      });
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(canonicalLeagueUrl);
      expect(response.body).not.toContain("frozen bet-origin league copy");
    },
  );

  test("the restart-readiness probe (no Sec-Fetch-Dest, no forwarding header — genuinely local) still gets the real page", async () => {
    const response = await rawRequest(origin, "/league", {});
    expect(response.status).toBe(200);
    expect(response.body).toContain("frozen bet-origin league copy");
  });

  test("the leak-audit's public-origin fetch (forwarded like real traffic, but no Sec-Fetch-Dest because it's fetch(), not a navigation) still gets 200 with real content", async () => {
    const response = await rawRequest(origin, "/league", {
      "x-forwarded-for": "203.0.113.7",
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain("frozen bet-origin league copy");
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
      // Deliberately no Sec-Fetch-Dest / forwarding header here — this is
      // exactly the shape of the real readiness probes this fix must not
      // break (see the file doc comment).
      const response = await rawRequest(baseUrl, "/league", {});
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
  headers: Record<string, string>,
): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        method: "GET",
        path: requestPath,
        headers: { accept: "text/html", ...headers },
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
