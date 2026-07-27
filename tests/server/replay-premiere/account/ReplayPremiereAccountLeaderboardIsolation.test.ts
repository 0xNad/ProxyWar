/**
 * Proves, against the REAL running server (not a unit-level fake), that a
 * self-asserted league claim never reaches a public surface: the points
 * leaderboard route joins ONLY the points ledger and the GitHub identity
 * link store — `ReplayPremiereLeagueClaimStore` is never wired into it at
 * all, so a claimed player name cannot leak into the response by
 * construction. This spawns the actual demo server (same entry point
 * `bet.proxywar.xyz` runs) with wagering enabled and pre-seeded on-disk
 * ledger/claim fixtures, sidestepping the guest-cookie HMAC boundary
 * entirely: leaderboard `entries` are a PUBLIC read regardless of viewer,
 * so there is no need to authenticate as the seeded participant to prove
 * they show up there without their claim.
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
const seededParticipantId = `guest_${"c".repeat(32)}`;
const claimedPlayerName = "Totally Definitely My Agent";

interface RawResponse {
  status: number;
  body: string;
}

describe("account: league claims never reach the points leaderboard", () => {
  let fixtureRoot = "";
  let pointsLedgerRoot = "";
  let privateStateRoot = "";
  let server: ChildProcess | null = null;
  let origin = "";
  let serverOutput = "";

  beforeAll(async () => {
    fixtureRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "proxywar-account-isolation-")),
    );
    const homeRoot = path.join(fixtureRoot, "home");
    const nationsRoot = path.join(fixtureRoot, "nations");
    const staticRoot = path.join(fixtureRoot, "static");
    const artifactsRoot = path.join(fixtureRoot, "artifacts");
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
      mkdir(path.join(artifactsRoot, "ai-league-runs", "league"), {
        recursive: true,
      }),
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
      // Pre-seeded points ledger: a participant with a real settled trade,
      // so they rank and appear in the leaderboard's public `entries`.
      writeFile(
        path.join(pointsLedgerRoot, "points-ledger-v1.json"),
        JSON.stringify({
          schemaVersion: 1,
          entries: {
            [seededParticipantId]: {
              displayName: "Seeded Trader",
              lifetimePoints: 250,
              premieresTraded: 1,
              premieresWon: 1,
              updatedAt: "2026-07-27T00:00:00.000Z",
              premiereResults: { prem_aaaaaaaaaaaaaaaa: 250 },
            },
          },
        }),
        { mode: 0o600 },
      ),
      // Pre-seeded league claim for the SAME participant — this is what
      // must never surface on the leaderboard.
      writeFile(
        path.join(pointsLedgerRoot, "league-claims-v1.json"),
        JSON.stringify({
          schemaVersion: 1,
          claims: {
            [seededParticipantId]: {
              playerName: claimedPlayerName,
              claimedAt: "2026-07-27T00:00:00.000Z",
              updatedAt: "2026-07-27T00:00:00.000Z",
            },
          },
        }),
        { mode: 0o600 },
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
          PROXYWAR_LEAGUE_WRAPPER_ONLY: "false",
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
    if (fixtureRoot !== "") await rm(fixtureRoot, { recursive: true, force: true });
    if (privateStateRoot !== "")
      await rm(privateStateRoot, { recursive: true, force: true });
    if (pointsLedgerRoot !== "")
      await rm(pointsLedgerRoot, { recursive: true, force: true });
  });

  test("the seeded participant ranks on the leaderboard, but their claimed player name never appears anywhere in the response", async () => {
    const response = await rawRequest(origin, "/api/premieres/points/leaderboard");
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as {
      leaderboard: {
        entries: Array<{ participantId: string; [key: string]: unknown }>;
      };
    };
    const entry = parsed.leaderboard.entries.find(
      (candidate) => candidate.participantId === seededParticipantId,
    );
    // Sanity: the fixture actually landed and the participant is ranked.
    expect(entry).toBeDefined();
    // The claim never appears anywhere in the raw response text — not as
    // a field value, not under an unexpected key name.
    expect(response.body).not.toContain(claimedPlayerName);
    expect(response.body.toLowerCase()).not.toContain("claim");
    // And no entry object carries any claim-shaped key at all.
    for (const candidate of parsed.leaderboard.entries) {
      expect(Object.keys(candidate)).not.toEqual(
        expect.arrayContaining(["playerName", "leagueClaim", "claim"]),
      );
    }
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
    listener.close((error) => (error === undefined ? resolve() : reject(error))),
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
      const response = await rawRequest(baseUrl, "/api/premieres/points/leaderboard");
      if (response.status === 200) return;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for server:\n${output()}`);
}

async function rawRequest(baseUrl: string, requestPath: string): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        method: "GET",
        path: requestPath,
        headers: { accept: "application/json", referer: `${baseUrl}/` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}
