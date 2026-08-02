/**
 * Gap 2 (corrected): the platform (wagering OFF) shows a bettor's stats on
 * a profile page without ever reading `ReplayPremierePointsLedger` itself
 * — betting stays the ledger's sole writer AND its sole direct reader;
 * the platform asks betting server-to-server (`BettingProfileClient` ->
 * betting's `GET /api/internal/accounts/:accountId/betting-profile`,
 * bearer-token authenticated) exactly the same way
 * `PlatformBettingHandoff.test.ts` proves the account handoff, against TWO
 * real spawned server processes.
 *
 * Keyed by the platform's stable, opaque `accountId` — NEVER a display
 * name. Proves:
 * - A genuinely linked account's platform profile (`/api/accounts/:id/
 *   betting-profile`) shows betting stats fetched cross-origin.
 * - TWO linked accounts sharing the SAME display name do NOT collide —
 *   each account id resolves its own stats. This is the correctness bug
 *   the old display-name-matching design had (it predates this file: the
 *   same unsound match lived in the LOCAL `/api/players/:name` branch
 *   before the cross-origin path was added).
 * - `/api/players/:name` (league identity) never returns a `betting` key
 *   at all anymore — it cannot conflate a league player with an account.
 * - Betting unreachable degrades `/api/accounts/:id/betting-profile`'s
 *   betting half to `null` — never a 500.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);

const sharedToken = "test-betting-profile-token-0123456789abcdef";
const linkedParticipantId = `guest_${"a".repeat(32)}`;
const anonParticipantId = `guest_${"b".repeat(32)}`;
const linkedPlatformAccountId = `acct_${"c".repeat(32)}`;
// A SECOND linked account sharing the exact same display name as the
// first — the collision scenario a free-text match would get wrong.
const secondLinkedParticipantId = `guest_${"d".repeat(32)}`;
const secondLinkedPlatformAccountId = `acct_${"e".repeat(32)}`;
const leaguePlayerName = "daveey-proxywar";
const sharedDisplayName = "linked-trader";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface ServerHandle {
  origin: string;
  process: ChildProcess;
  output: string;
}

describe("platform account profile <-> betting profile projection (real servers)", () => {
  let fixtureRoot = "";
  let platform: ServerHandle | null = null;
  let betting: ServerHandle | null = null;

  beforeAll(async () => {
    fixtureRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "proxywar-platform-profile-")),
    );

    const bettingPort = await reservePort();
    const bettingOrigin = `http://127.0.0.1:${bettingPort}`;
    const platformPort = await reservePort();

    betting = await startBettingServer({
      port: bettingPort,
      fixtureRoot: path.join(fixtureRoot, "betting"),
    });

    platform = await startPlatformServer({
      port: platformPort,
      fixtureRoot: path.join(fixtureRoot, "platform"),
      bettingOrigin,
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([
      stopServer(platform?.process ?? null),
      stopServer(betting?.process ?? null),
    ]);
    if (fixtureRoot !== "") await rm(fixtureRoot, { recursive: true, force: true });
  });

  test("a genuinely linked account's platform profile shows betting stats fetched cross-origin from betting, keyed by account id", async () => {
    const response = await rawRequest(
      platform!.origin,
      `/api/accounts/${linkedPlatformAccountId}/betting-profile`,
    );
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as {
      accountId: string;
      displayName: string | null;
      betting: { lifetimePoints: number; premieresTraded: number; premieresWon: number } | null;
    };
    expect(parsed.accountId).toBe(linkedPlatformAccountId);
    expect(parsed.betting).not.toBeNull();
    expect(parsed.betting?.lifetimePoints).toBe(500);
    expect(parsed.betting?.premieresTraded).toBe(2);
    expect(parsed.betting?.premieresWon).toBe(2);
  });

  test("two accounts sharing the SAME display name do not collide: each account id resolves its own, distinct stats", async () => {
    const first = await rawRequest(
      platform!.origin,
      `/api/accounts/${linkedPlatformAccountId}/betting-profile`,
    );
    const second = await rawRequest(
      platform!.origin,
      `/api/accounts/${secondLinkedPlatformAccountId}/betting-profile`,
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstParsed = JSON.parse(first.body) as {
      betting: { lifetimePoints: number } | null;
    };
    const secondParsed = JSON.parse(second.body) as {
      betting: { lifetimePoints: number } | null;
    };
    expect(firstParsed.betting?.lifetimePoints).toBe(500);
    // The second account, despite sharing a display name with the first,
    // resolves to ITS OWN ledger entry — never the first account's.
    expect(secondParsed.betting?.lifetimePoints).toBe(777);
  });

  test("/api/players/:name (league identity) never returns a betting key at all — it cannot conflate a league player with an account", async () => {
    const response = await rawRequest(
      platform!.origin,
      `/api/players/${encodeURIComponent(leaguePlayerName)}`,
    );
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as {
      league: { standing: { rank: number } | null } | null;
    };
    expect(parsed.league?.standing?.rank).toBe(3);
    expect(response.body).not.toContain('"betting"');
    // Never leaks the spoofing guest's own participant id, and never a claim.
    expect(response.body).not.toContain(anonParticipantId);
    expect(response.body.toLowerCase()).not.toContain("lineageslug");
  });

  test("a bearer token that doesn't match is rejected by betting's internal route", async () => {
    const response = await rawRequest(
      betting!.origin,
      `/api/internal/accounts/${linkedPlatformAccountId}/betting-profile`,
      { authorization: "Bearer wrong-token" },
    );
    expect(response.status).toBe(401);
  });

  test("betting unreachable: the platform account profile degrades to no betting section, never a 500", async () => {
    await stopServer(betting!.process);
    const response = await rawRequest(
      platform!.origin,
      `/api/accounts/${linkedPlatformAccountId}/betting-profile`,
    );
    expect(response.status).toBe(200);
    const parsed = JSON.parse(response.body) as {
      displayName: string | null;
      betting: unknown;
    };
    expect(parsed.displayName).toBe(sharedDisplayName);
    expect(parsed.betting).toBeNull();
  });
});

async function startBettingServer(options: {
  port: number;
  fixtureRoot: string;
}): Promise<ServerHandle> {
  const artifactsRoot = path.join(options.fixtureRoot, "artifacts");
  const pointsLedgerRoot = path.join(
    path.dirname(options.fixtureRoot),
    `${path.basename(options.fixtureRoot)}-points-ledger`,
  );
  const privateStateRoot = path.join(
    path.dirname(options.fixtureRoot),
    `${path.basename(options.fixtureRoot)}-premiere-state`,
  );

  await Promise.all([
    mkdir(path.join(options.fixtureRoot, "static"), { recursive: true }),
    mkdir(path.join(artifactsRoot, "ai-league-runs", "league"), { recursive: true }),
    mkdir(path.join(options.fixtureRoot, "resources", "lang"), { recursive: true }),
    mkdir(pointsLedgerRoot, { recursive: true }),
    mkdir(privateStateRoot, { recursive: true }),
  ]);
  await chmod(pointsLedgerRoot, 0o700);
  await chmod(privateStateRoot, 0o700);

  await Promise.all([
    writeFile(
      path.join(options.fixtureRoot, "index.html"),
      "<!doctype html><html><head><title>Proxy War</title></head><body>PROXY WAR</body></html>",
      "utf8",
    ),
    writeFile(
      path.join(options.fixtureRoot, "static", "index.html"),
      "<!doctype html><html><head><title>Proxy War</title></head><body>PROXY WAR</body></html>",
      "utf8",
    ),
    writeFile(path.join(options.fixtureRoot, "resources", "lang", "en.json"), "{}", "utf8"),
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
    // Points ledger: a genuinely linked trader, AND an anonymous guest who
    // freely typed the league player's exact name as their display name —
    // the spoofing scenario the cross-origin route must also resist.
    writeFile(
      path.join(pointsLedgerRoot, "points-ledger-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          [linkedParticipantId]: {
            displayName: sharedDisplayName,
            lifetimePoints: 500,
            premieresTraded: 2,
            premieresWon: 2,
            updatedAt: "2026-07-27T00:00:00.000Z",
            premiereResults: {
              prem_aaaaaaaaaaaaaaaa: 300,
              prem_bbbbbbbbbbbbbbbb: 200,
            },
          },
          // Second linked account, SAME display name as the one above —
          // the collision a free-text match would get wrong.
          [secondLinkedParticipantId]: {
            displayName: sharedDisplayName,
            lifetimePoints: 777,
            premieresTraded: 3,
            premieresWon: 1,
            updatedAt: "2026-07-27T00:00:00.000Z",
            premiereResults: { prem_ffffffffffffffff: 777 },
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
    writeFile(
      path.join(pointsLedgerRoot, "platform-account-links-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        byPlatformAccountId: {
          [linkedPlatformAccountId]: {
            platformAccountId: linkedPlatformAccountId,
            displayName: sharedDisplayName,
            participantId: linkedParticipantId,
            linkedAt: "2026-07-27T00:00:00.000Z",
            updatedAt: "2026-07-27T00:00:00.000Z",
          },
          [secondLinkedPlatformAccountId]: {
            platformAccountId: secondLinkedPlatformAccountId,
            displayName: sharedDisplayName,
            participantId: secondLinkedParticipantId,
            linkedAt: "2026-07-27T00:00:00.000Z",
            updatedAt: "2026-07-27T00:00:00.000Z",
          },
        },
        platformAccountIdByParticipantId: {
          [linkedParticipantId]: linkedPlatformAccountId,
          [secondLinkedParticipantId]: secondLinkedPlatformAccountId,
        },
        aliases: {},
      }),
      { mode: 0o600 },
    ),
  ]);

  return spawnServer({
    port: options.port,
    fixtureRoot: options.fixtureRoot,
    extraEnv: {
      PROXYWAR_WAGERING_ENABLED: "true",
      PROXYWAR_ARTIFACTS_ROOT: artifactsRoot,
      PROXYWAR_POINTS_LEDGER_ROOT: pointsLedgerRoot,
      PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: privateStateRoot,
      PROXYWAR_BETTING_PROFILE_TOKEN: sharedToken,
    },
  });
}

async function startPlatformServer(options: {
  port: number;
  fixtureRoot: string;
  bettingOrigin: string;
}): Promise<ServerHandle> {
  const artifactsRoot = path.join(options.fixtureRoot, "artifacts");
  const privateStateRoot = path.join(
    path.dirname(options.fixtureRoot),
    `${path.basename(options.fixtureRoot)}-premiere-state`,
  );
  const platformStateRoot = path.join(
    path.dirname(options.fixtureRoot),
    `${path.basename(options.fixtureRoot)}-platform-private`,
  );

  await Promise.all([
    mkdir(path.join(options.fixtureRoot, "static"), { recursive: true }),
    mkdir(path.join(artifactsRoot, "ai-league-runs", "league"), { recursive: true }),
    mkdir(path.join(options.fixtureRoot, "resources", "lang"), { recursive: true }),
    mkdir(privateStateRoot, { recursive: true }),
    mkdir(platformStateRoot, { recursive: true }),
  ]);
  await chmod(privateStateRoot, 0o700);
  await chmod(platformStateRoot, 0o700);

  await Promise.all([
    writeFile(
      path.join(options.fixtureRoot, "index.html"),
      "<!doctype html><html><head><title>Proxy War</title></head><body>PROXY WAR</body></html>",
      "utf8",
    ),
    writeFile(
      path.join(options.fixtureRoot, "static", "index.html"),
      "<!doctype html><html><head><title>Proxy War</title></head><body>PROXY WAR</body></html>",
      "utf8",
    ),
    writeFile(path.join(options.fixtureRoot, "resources", "lang", "en.json"), "{}", "utf8"),
    // League mirror: one ranked player, matched by name against the
    // spoofing guest's free-text display name on betting's side.
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
        episodes: [],
      }),
      "utf8",
    ),
    writeFile(
      path.join(artifactsRoot, "ai-league-runs", "league", "index.html"),
      "<!doctype html><html><body>PROXY WAR league</body></html>",
      "utf8",
    ),
    writeFile(
      path.join(platformStateRoot, "platform-accounts-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        accounts: {
          [linkedPlatformAccountId]: {
            displayName: sharedDisplayName,
            createdAt: "2026-07-27T00:00:00.000Z",
            updatedAt: "2026-07-27T00:00:00.000Z",
          },
          [secondLinkedPlatformAccountId]: {
            displayName: sharedDisplayName,
            createdAt: "2026-07-27T00:00:00.000Z",
            updatedAt: "2026-07-27T00:00:00.000Z",
          },
        },
      }),
      { mode: 0o600 },
    ),
  ]);

  return spawnServer({
    port: options.port,
    fixtureRoot: options.fixtureRoot,
    extraEnv: {
      PROXYWAR_PLATFORM_ENABLED: "true",
      PROXYWAR_WAGERING_ENABLED: "false",
      PROXYWAR_ARTIFACTS_ROOT: artifactsRoot,
      PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: privateStateRoot,
      PROXYWAR_PLATFORM_STATE_ROOT: platformStateRoot,
      PROXYWAR_BETTING_PROFILE_TOKEN: sharedToken,
      PROXYWAR_BETTING_ORIGIN: options.bettingOrigin,
    },
  });
}

async function spawnServer(options: {
  port: number;
  fixtureRoot: string;
  extraEnv: Record<string, string>;
}): Promise<ServerHandle> {
  const origin = `http://127.0.0.1:${options.port}`;
  const child = spawn(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      "--tsconfig",
      path.join(projectRoot, "tsconfig.json"),
      path.join(projectRoot, "src", "scripts", "ai-agent-demo-server.ts"),
    ],
    {
      cwd: options.fixtureRoot,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: path.join(options.fixtureRoot, "home"),
        NODE_ENV: "test",
        GAME_ENV: "dev",
        AI_LEAGUE_DEMO_HOST: "127.0.0.1",
        AI_LEAGUE_DEMO_PORT: String(options.port),
        AI_LEAGUE_DEMO_RENDERER: "false",
        PROXYWAR_BETA_ENABLED: "false",
        PROXYWAR_LEAGUE_WRAPPER_ONLY: "false",
        PROXYWAR_CLIPS_ENABLED: "false",
        PROXYWAR_PREMIERE_CLIPS_ENABLED: "false",
        PROXYWAR_LEAGUE_CLIPS_ENABLED: "false",
        PROXYWAR_NATIONS_DIR: path.join(options.fixtureRoot, "nations"),
        ...options.extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const handle: ServerHandle = { origin, process: child, output: "" };
  child.stdout?.on("data", (chunk: Buffer) => (handle.output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (handle.output += chunk.toString()));
  await waitForServer(handle);
  return handle;
}

async function waitForServer(handle: ServerHandle): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (handle.process.exitCode !== null) {
      throw new Error(`Server (${handle.origin}) exited early:\n${handle.output}`);
    }
    try {
      const response = await rawRequest(handle.origin, "/api/status");
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    // Polls a real spawned subprocess's real listening socket — no event
    // to await instead; a genuine wall-clock poll is unavoidable here.
    // `new Promise(executor)`, not `Promise.withResolvers` — this project
    // targets ES2022 lib (no ES2024).
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for server (${handle.origin}):\n${handle.output}`);
}

async function stopServer(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
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

function rawRequest(
  baseUrl: string,
  requestPath: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, baseUrl);
    const request = http.request(url, { method: "GET", headers }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => (body += chunk.toString()));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}
