/**
 * Proves, against the REAL running server (not a unit-level fake), that
 * the league player-profile route (`GET /api/players/:name`) — reached
 * by clicking the public league standings — never leaks a private
 * self-asserted league claim, and never returns a betting section at
 * all: betting stats now live only at their own account-id-keyed
 * profile (`GET /api/accounts/:accountId/betting-profile`, platform
 * only — see `PlatformBettingProfileProjection.test.ts`), never joined
 * to a league player by a free-text display-name match (that used to be
 * how this route worked, and it was unsound — see
 * `BettingPlatformAccountLinkStore.getByPlatformAccountId`'s doc).
 *
 * Same spawn pattern as `ReplayPremiereAccountLeaderboardIsolation.test.ts`
 * (same entry point `bet.proxywar.xyz`/`app.proxywar.xyz` both run).
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
const linkedParticipantId = `guest_${"a".repeat(32)}`;
const anonParticipantId = `guest_${"b".repeat(32)}`;
const linkedPlatformAccountId = `acct_${"c".repeat(32)}`;
const leaguePlayerName = "daveey-proxywar";
const linkedTraderName = "linked-trader";
// The anon guest's leftover legacy claim file targets the SAME name their
// (spoofable) display name also uses — proves a stray on-disk claim never
// leaks even though the route no longer wires the claim store in at all.
const claimedPlayerName = leaguePlayerName;

interface RawResponse {
  status: number;
  body: string;
}

describe("player profile: never leaks a claim, never trusts an unverified name match", () => {
  let fixtureRoot = "";
  let pointsLedgerRoot = "";
  let privateStateRoot = "";
  let server: ChildProcess | null = null;
  let origin = "";
  let serverOutput = "";

  beforeAll(async () => {
    fixtureRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "proxywar-player-profile-")),
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
      // Public league mirror: one ranked player, one episode they appear in.
      writeFile(
        path.join(artifactsRoot, "ai-league-runs", "league", "data.json"),
        JSON.stringify({
          generatedAt: "2026-07-27T00:00:00.000Z",
          lastGoodSyncAt: "2026-07-27T00:00:00.000Z",
          stale: false,
          standings: [
            {
              rank: 3,
              playerName: leaguePlayerName,
              ratingPolicyLabel: `${leaguePlayerName}:v23`,
              activeChampionPolicyLabel: `${leaguePlayerName}:v23`,
              policyLabel: `${leaguePlayerName}:v23`,
              score: 24.5,
              roundsPlayed: 40,
              isHouse: false,
            },
          ],
          episodes: [
            {
              roundNumber: 268,
              completedAt: "2026-07-27T02:00:00.000Z",
              map: "Pangaea",
              turnCount: 900,
              winnerName: leaguePlayerName,
              watchHref: null,
              fullRenderHref: "/ai-league-replay/league-x",
              players: [
                {
                  name: leaguePlayerName,
                  tilesOwned: 5000,
                  isAlive: true,
                  isWinner: true,
                },
              ],
            },
          ],
        }),
        "utf8",
      ),
      writeFile(
        path.join(artifactsRoot, "ai-league-runs", "league", "index.html"),
        "<!doctype html><html><body>PROXY WAR league</body></html>",
        "utf8",
      ),
      // Points ledger: BOTH a platform-linked trader and an anonymous guest
      // who freely typed the league player's exact name as their display
      // name — the spoofing scenario this route must resist.
      writeFile(
        path.join(pointsLedgerRoot, "points-ledger-v1.json"),
        JSON.stringify({
          schemaVersion: 1,
          entries: {
            [linkedParticipantId]: {
              displayName: linkedTraderName,
              lifetimePoints: 500,
              premieresTraded: 2,
              premieresWon: 2,
              updatedAt: "2026-07-27T00:00:00.000Z",
              premiereResults: {
                prem_aaaaaaaaaaaaaaaa: 300,
                prem_bbbbbbbbbbbbbbbb: 200,
              },
            },
            [anonParticipantId]: {
              displayName: leaguePlayerName,
              lifetimePoints: 999,
              premieresTraded: 1,
              premieresWon: 1,
              updatedAt: "2026-07-27T00:00:00.000Z",
              premiereResults: { prem_cccccccccccccccc: 999 },
            },
          },
        }),
        { mode: 0o600 },
      ),
      // Genuinely linked platform account — ONLY for the linked participant.
      writeFile(
        path.join(pointsLedgerRoot, "platform-account-links-v1.json"),
        JSON.stringify({
          schemaVersion: 1,
          byPlatformAccountId: {
            [linkedPlatformAccountId]: {
              platformAccountId: linkedPlatformAccountId,
              displayName: linkedTraderName,
              participantId: linkedParticipantId,
              linkedAt: "2026-07-27T00:00:00.000Z",
              updatedAt: "2026-07-27T00:00:00.000Z",
            },
          },
          platformAccountIdByParticipantId: {
            [linkedParticipantId]: linkedPlatformAccountId,
          },
          aliases: {},
        }),
        { mode: 0o600 },
      ),
      // Stray legacy claim file (private self-asserted "this league agent is
      // mine") — the anon guest claiming to OWN the league player. The
      // profile route no longer wires this store in at all; this file
      // proves that even if it's still sitting on disk, nothing leaks.
      writeFile(
        path.join(pointsLedgerRoot, "league-claims-v1.json"),
        JSON.stringify({
          schemaVersion: 1,
          claims: {
            [anonParticipantId]: {
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

  test("the league player's profile shows league data, but no betting section from the unverified name-matching guest, and no claim", async () => {
    const response = await rawRequest(
      origin,
      `/api/players/${encodeURIComponent(leaguePlayerName)}`,
    );
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as {
      league: { standing: { rank: number } | null } | null;
      betting?: unknown;
    };
    expect(parsed.league?.standing?.rank).toBe(3);
    // The spoofing guest traded and typed the exact league name as their
    // display name, but is NOT platform-linked, AND this route no longer
    // ever returns betting data at all — must NOT surface a betting
    // section here.
    expect(parsed.betting).toBeUndefined();
    expect(response.body).not.toContain('"betting"');
    // The private claim, and the guest who made it, never appear anywhere.
    expect(response.body).not.toContain(anonParticipantId);
    expect(response.body.toLowerCase()).not.toContain("claim");
  });

  test("/api/players/:name never returns a betting key at all, even for a name matching a genuinely linked trader — betting stats now live at their own account-id-keyed profile", async () => {
    const response = await rawRequest(
      origin,
      `/api/players/${encodeURIComponent(linkedTraderName)}`,
    );
    // No league standing/episode is named "linked-trader" — 404, no page.
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('"betting"');
    expect(response.body).not.toContain(leaguePlayerName);
    expect(response.body).not.toContain(anonParticipantId);
    expect(response.body.toLowerCase()).not.toContain("claim");
  });

  test("a name with no league standing and no linked trader 404s", async () => {
    const response = await rawRequest(
      origin,
      "/api/players/nobody-plays-this-name",
    );
    expect(response.status).toBe(404);
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
      const response = await rawRequest(
        baseUrl,
        `/api/players/${encodeURIComponent(leaguePlayerName)}`,
      );
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
