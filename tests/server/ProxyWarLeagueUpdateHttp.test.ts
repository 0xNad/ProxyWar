import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AI_LEAGUE_CLIP_CANARY_FILE } from "../../src/server/agents/AiLeagueClipCanary";
import {
  writeCoworldLeagueSite,
  type CoworldLeagueMirrorData,
} from "../../src/server/agents/CoworldLeagueSiteWriter";
import { controlledSourceBytes } from "./replay-premiere/ReplayPremiereFixtures";

const projectRoot = process.cwd();
const require = createRequire(import.meta.url);
const canaryRunKey = "league-coworld-canary-wrapper";
const canaryBucket = 60;
const controlledSource = JSON.parse(
  controlledSourceBytes().toString("utf8"),
) as {
  gameRecord: Record<string, unknown> & { info: Record<string, unknown> };
};
const canaryRecordBytes = Buffer.from(
  JSON.stringify({
    ...controlledSource.gameRecord,
    info: {
      ...controlledSource.gameRecord.info,
      num_turns: 1_000,
      winner: undefined,
    },
    turns: [],
  }),
);
const canarySourceSha256 = createHash("sha256")
  .update(canaryRecordBytes)
  .digest("hex");
const canaryClipBytes = Buffer.alloc(96, 7);

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

describe("league update HTTP contract", () => {
  let fixtureRoot = "";
  let server: ChildProcess | null = null;
  let openServer: ChildProcess | null = null;
  let origin = "";
  let openOrigin = "";
  let serverOutput = "";
  let openServerOutput = "";
  let caseInsensitiveFixturePaths = false;
  let validReplayRecordPath = "";
  let privateStateRoot = "";
  let openPrivateStateRoot = "";

  beforeAll(async () => {
    fixtureRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "proxywar-league-http-")),
    );
    privateStateRoot = path.join(
      path.dirname(fixtureRoot),
      `${path.basename(fixtureRoot)}-premiere-gated`,
    );
    openPrivateStateRoot = path.join(
      path.dirname(fixtureRoot),
      `${path.basename(fixtureRoot)}-premiere-open`,
    );
    const artifactsRoot = path.join(fixtureRoot, "artifacts");
    const leagueRoot = path.join(artifactsRoot, "ai-league-runs", "league");
    const homeRoot = path.join(fixtureRoot, "home-gated");
    const openHomeRoot = path.join(fixtureRoot, "home-open");
    const nationsRoot = path.join(fixtureRoot, "nations-gated");
    const openNationsRoot = path.join(fixtureRoot, "nations-open");
    const staticRoot = path.join(fixtureRoot, "static");
    const validReplayRoot = path.join(
      artifactsRoot,
      "ai-league-runs",
      "league-valid",
    );
    const compactedReplayRoot = path.join(
      artifactsRoot,
      "ai-league-runs",
      "league-compacted",
    );
    const canaryReplayRoot = path.join(
      artifactsRoot,
      "ai-league-runs",
      canaryRunKey,
    );
    const canaryClipRoot = path.join(
      privateStateRoot,
      "league-clips-v1",
      canaryRunKey,
    );
    validReplayRecordPath = path.join(validReplayRoot, "game-record.json");
    await Promise.all([
      mkdir(leagueRoot, { recursive: true }),
      mkdir(homeRoot, { recursive: true }),
      mkdir(openHomeRoot, { recursive: true }),
      mkdir(nationsRoot, { recursive: true }),
      mkdir(openNationsRoot, { recursive: true }),
      mkdir(staticRoot, { recursive: true }),
      mkdir(validReplayRoot, { recursive: true }),
      mkdir(compactedReplayRoot, { recursive: true }),
      mkdir(canaryReplayRoot, { recursive: true }),
      mkdir(canaryClipRoot, { recursive: true }),
      mkdir(path.join(fixtureRoot, "resources", "lang"), { recursive: true }),
    ]);
    await chmod(privateStateRoot, 0o700);
    const now = Date.now();
    await Promise.all([
      writeCoworldLeagueSite(leagueRoot, fixtureLeagueData()),
      copyFile(
        path.join(projectRoot, "index.html"),
        path.join(staticRoot, "index.html"),
      ),
      copyFile(
        path.join(projectRoot, "resources", "lang", "en.json"),
        path.join(fixtureRoot, "resources", "lang", "en.json"),
      ),
      writeFile(validReplayRecordPath, JSON.stringify({ turns: [] }), "utf8"),
      writeFile(
        path.join(compactedReplayRoot, "game-record.json"),
        JSON.stringify({ compacted: true }),
        "utf8",
      ),
      writeFile(
        path.join(canaryReplayRoot, "game-record.json"),
        canaryRecordBytes,
      ),
      writeFile(
        path.join(canaryClipRoot, `clip-v1-${canaryBucket}.mp4`),
        canaryClipBytes,
      ),
      writeFile(
        path.join(
          canaryClipRoot,
          `clip-v1-${canaryBucket}.render-manifest.json`,
        ),
        JSON.stringify({
          premiereId: canaryRunKey,
          sourceReplaySha256: canarySourceSha256,
          anchorTurn: canaryBucket * 10 + 5,
          clipVersion: 1,
          frameShape: "square",
          frameWidth: 1080,
          frameHeight: 1080,
          outSha256: createHash("sha256").update(canaryClipBytes).digest("hex"),
          outBytes: canaryClipBytes.byteLength,
          generatedAt: new Date(now).toISOString(),
        }),
      ),
      writeFile(
        path.join(privateStateRoot, AI_LEAGUE_CLIP_CANARY_FILE),
        JSON.stringify({
          schemaVersion: 1,
          lifecycle: "claimed",
          runKey: canaryRunKey,
          bucket: canaryBucket,
          sourceReplaySha256: canarySourceSha256,
          armedAt: new Date(now - 60_000).toISOString(),
          expiresAt: new Date(now + 10 * 60_000).toISOString(),
          claimedAt: new Date(now - 30_000).toISOString(),
          disarmedAt: null,
        }),
        { mode: 0o600 },
      ),
    ]);
    try {
      await stat(path.join(artifactsRoot, "ai-league-runs", "League"));
      caseInsensitiveFixturePaths = true;
    } catch {
      caseInsensitiveFixturePaths = false;
    }

    const port = await reservePort();
    const openPort = await reservePort();
    origin = `http://127.0.0.1:${port}`;
    openOrigin = `http://127.0.0.1:${openPort}`;
    const child = spawnLeagueServer({
      artifactsRoot,
      fixtureRoot,
      homeRoot,
      nationsRoot,
      privateStateRoot,
      port,
      betaEnabled: true,
      wrapperOnly: true,
    });
    const openChild = spawnLeagueServer({
      artifactsRoot,
      fixtureRoot,
      homeRoot: openHomeRoot,
      nationsRoot: openNationsRoot,
      privateStateRoot: openPrivateStateRoot,
      port: openPort,
      betaEnabled: false,
      wrapperOnly: false,
    });
    server = child;
    openServer = openChild;
    child.stdout?.on("data", (chunk: Buffer) => {
      serverOutput += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      serverOutput += chunk.toString();
    });
    openChild.stdout?.on("data", (chunk: Buffer) => {
      openServerOutput += chunk.toString();
    });
    openChild.stderr?.on("data", (chunk: Buffer) => {
      openServerOutput += chunk.toString();
    });
    await Promise.all([
      waitForServer(origin, () => serverOutput, child),
      waitForServer(openOrigin, () => openServerOutput, openChild),
    ]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([stopServer(server), stopServer(openServer)]);
    if (fixtureRoot !== "") {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
    await Promise.all(
      [privateStateRoot, openPrivateStateRoot]
        .filter((root) => root !== "")
        .map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("serves the league page with a CSP that permits only same-origin scripts", async () => {
    const alias = await rawRequest(origin, "/league");
    const direct = await rawRequest(
      origin,
      "/ai-league-runs/league/index.html",
    );
    const aliasHead = await rawRequest(origin, "/league", { method: "HEAD" });
    const directHead = await rawRequest(
      origin,
      "/ai-league-runs/league/index.html",
      { method: "HEAD" },
    );

    expect(alias.status).toBe(200);
    expect(direct.status).toBe(200);
    expect(aliasHead.status).toBe(200);
    expect(directHead.status).toBe(200);
    expect(alias.body.toString()).toContain("PROXY WAR");
    expect(direct.body.toString()).toContain("PROXY WAR");
    expect(aliasHead.body).toHaveLength(0);
    expect(directHead.body).toHaveLength(0);
    expect(direct.headers["content-security-policy"]).toBe(
      alias.headers["content-security-policy"],
    );
    expect(aliasHead.headers["content-security-policy"]).toBe(
      alias.headers["content-security-policy"],
    );
    expect(directHead.headers["content-security-policy"]).toBe(
      alias.headers["content-security-policy"],
    );

    const policy = String(alias.headers["content-security-policy"] ?? "");
    const scriptDirective = policy
      .split("; ")
      .find((directive) => directive.startsWith("script-src"));
    expect(scriptDirective).toBe("script-src 'self'");
    expect(scriptDirective).not.toContain("unsafe-inline");
    expect(scriptDirective).not.toContain("unsafe-eval");
    expect(policy).toContain("connect-src 'self'");
  });

  test("applies the league CSP to every open-mode document alias", async () => {
    const paths = [
      "/league",
      "/league/",
      "/LEAGUE",
      "/ai-league-runs/league/",
      "/ai-league-runs/league/index",
      "/ai-league-runs/league/index.html",
      "/runs/league/",
      "/runs/league/index",
      "/runs/league/index.html",
    ];
    if (caseInsensitiveFixturePaths) {
      paths.push(
        "/ai-league-runs/League/",
        "/ai-league-runs/League/index",
        "/ai-league-runs/League/index.html",
        "/runs/League/",
        "/runs/League/index",
        "/runs/League/index.html",
      );
    }

    for (const requestPath of paths) {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await rawRequest(openOrigin, requestPath, { method });
        expect(response.status, `${method} ${requestPath}`).toBe(200);
        expect(
          response.headers["content-security-policy"],
          `${method} ${requestPath}`,
        ).toBeDefined();
        expect(String(response.headers["content-security-policy"])).toContain(
          "script-src 'self'",
        );
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        if (method === "HEAD") {
          expect(response.body, requestPath).toHaveLength(0);
        } else {
          expect(response.body.toString(), requestPath).toContain("PROXY WAR");
        }
      }
    }
  });

  test("serves and revalidates only the allowlisted update artifacts", async () => {
    const client = await rawRequest(origin, "/ai-league-runs/league/client.js");
    expect(client.status).toBe(200);
    expect(client.headers["content-type"]).toMatch(/javascript/);
    expect(client.headers["x-content-type-options"]).toBe("nosniff");
    expect(client.body.toString()).toContain("checkForUpdates");

    const clientHead = await rawRequest(
      origin,
      "/ai-league-runs/league/client.js",
      { method: "HEAD" },
    );
    expect(clientHead.status).toBe(200);
    expect(clientHead.body).toHaveLength(0);

    const data = await rawRequest(origin, "/ai-league-runs/league/data.json");
    expect(data.status).toBe(200);
    expect(data.headers.etag).toBeDefined();
    expect(data.headers["cache-control"]).toContain("max-age=0");

    const revalidated = await rawRequest(
      origin,
      "/ai-league-runs/league/data.json",
      {
        headers: { "If-None-Match": String(data.headers.etag) },
      },
    );
    expect(revalidated.status).toBe(304);
    expect(revalidated.body).toHaveLength(0);

    for (const method of ["GET", "HEAD"] as const) {
      const blocked = await rawRequest(
        origin,
        "/ai-league-runs/league/untrusted.js",
        { method },
      );
      expect(blocked.status).toBe(404);
      expect(blocked.headers.location).toBeUndefined();
    }

    for (const route of [
      "/ai-league-replay/controlled-source-1",
      "/ai-league-runs/controlled-source-1/game-record.json",
      "/proxywar-replay/controlled-source-1",
    ]) {
      for (const method of ["GET", "HEAD"] as const) {
        const blocked = await rawRequest(origin, route, { method });
        expect(blocked.status, `${method} ${route}`).toBe(404);
        expect(blocked.headers.location).toBeUndefined();
      }
    }
  });

  test("serves only the exact claimed Clip canary target without wrapper redirects", async () => {
    const exactStatusPath = `/api/league-runs/${canaryRunKey}/clips/${canaryBucket}`;
    const exactFilePath = `/ai-league-runs/${canaryRunKey}/clip-v1-${canaryBucket}.mp4`;
    const exactStatus = await rawRequest(origin, exactStatusPath);
    const exactFile = await rawRequest(origin, exactFilePath);

    expect(exactStatus.status).toBe(200);
    expect(JSON.parse(exactStatus.body.toString())).toMatchObject({
      state: "ready",
      bucket: canaryBucket,
      ready: {
        clipUrl: exactFilePath,
      },
    });
    expect(exactFile.status).toBe(200);
    expect(exactFile.body).toEqual(canaryClipBytes);

    for (const requestPath of [
      `/api/league-runs/${canaryRunKey}/clips/${canaryBucket + 1}`,
      `/ai-league-runs/${canaryRunKey}/clip-v1-${canaryBucket + 1}.mp4`,
      `/api/league-runs/league-coworld-other-wrapper/clips/${canaryBucket}`,
      `/ai-league-runs/league-coworld-other-wrapper/clip-v1-${canaryBucket}.mp4`,
    ]) {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await rawRequest(origin, requestPath, { method });
        expect(response.status, `${method} ${requestPath}`).toBe(404);
        expect(
          response.headers.location,
          `${method} ${requestPath}`,
        ).toBeUndefined();
      }
    }

    const refusedWrite = await rawRequest(
      origin,
      `/api/league-runs/${canaryRunKey}/clips`,
      { method: "POST" },
    );
    expect(refusedWrite.status).toBe(404);
    expect(refusedWrite.headers.location).toBeUndefined();
  });

  test("serves the replay shell only for a renderable public league record", async () => {
    const replayResponses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        rawRequest(origin, "/ai-league-replay/league-valid", {
          method: index % 2 === 0 ? "GET" : "HEAD",
        }),
      ),
    );
    const replay = replayResponses[0];
    const replayHead = replayResponses[1];

    expect(replayResponses.map((response) => response.status)).toEqual(
      Array(6).fill(200),
    );
    expect(replayHead.body).toHaveLength(0);
    const shell = replay.body.toString();
    expect(shell).toContain('id="proxywar-replay-loading"');
    expect(shell).toContain('data-i18n="ai_league_replay.loading_replay"');
    expect(shell).toContain('"proxywar-replay-booting"');
    expect(shell.indexOf('id="proxywar-replay-loading"')).toBeLessThan(
      shell.indexOf('id="hex-grid"'),
    );

    for (const runID of ["league-missing", "league-compacted"]) {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await rawRequest(
          origin,
          `/ai-league-replay/${runID}`,
          { method },
        );
        expect(response.status, `${method} ${runID}`).toBe(302);
        expect(response.headers.location).toBe("/league");
        expect(response.body.toString(), `${method} ${runID}`).not.toContain(
          'id="proxywar-replay-loading"',
        );
      }
    }

    await writeFile(
      validReplayRecordPath,
      JSON.stringify({ compacted: true, reason: "cache invalidation" }),
      "utf8",
    );
    const invalidated = await rawRequest(
      origin,
      "/ai-league-replay/league-valid",
    );
    expect(invalidated.status).toBe(302);
    expect(invalidated.headers.location).toBe("/league");
  });
});

function fixtureLeagueData(): CoworldLeagueMirrorData {
  return {
    generatedAt: "2026-07-15T15:00:00.000Z",
    lastGoodSyncAt: "2026-07-15T15:00:00.000Z",
    stale: false,
    league: {
      id: "league_fixture",
      name: "Proxywar fixture",
      description: null,
      divisionName: "Competition",
      roundIntervalMinutes: 30,
      episodesPerRound: 8,
      currentRoundNumber: 901,
      currentRoundStatus: "running",
      scoreLabel: "Score",
    },
    standings: [],
    rounds: [],
    episodes: [],
    links: {
      enterTheLeagueUrl: "https://example.com/league",
      platformLabel: "Softmax Coworld",
    },
  };
}

function spawnLeagueServer(options: {
  artifactsRoot: string;
  fixtureRoot: string;
  homeRoot: string;
  nationsRoot: string;
  privateStateRoot: string;
  port: number;
  betaEnabled: boolean;
  wrapperOnly: boolean;
}): ChildProcess {
  return spawn(
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
        HOME: options.homeRoot,
        NODE_ENV: "test",
        GAME_ENV: "dev",
        AI_LEAGUE_DEMO_HOST: "127.0.0.1",
        AI_LEAGUE_DEMO_PORT: String(options.port),
        AI_LEAGUE_DEMO_RENDERER: "false",
        PROXYWAR_BETA_ENABLED: String(options.betaEnabled),
        PROXYWAR_BETA_CODE: "fixture-invite-code",
        PROXYWAR_LEAGUE_WRAPPER_ONLY: String(options.wrapperOnly),
        PROXYWAR_CLIPS_ENABLED: String(options.wrapperOnly),
        PROXYWAR_PREMIERE_CLIPS_ENABLED: "false",
        PROXYWAR_LEAGUE_CLIPS_ENABLED: "false",
        PROXYWAR_ARTIFACTS_ROOT: options.artifactsRoot,
        PROXYWAR_NATIONS_DIR: options.nationsRoot,
        PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: options.privateStateRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function stopServer(server: ChildProcess | null): Promise<void> {
  if (server === null || server.exitCode !== null) {
    return;
  }
  server.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => server.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (server.exitCode === null) {
    server.kill("SIGKILL");
  }
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
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`League server exited early:\n${output()}`);
    }
    try {
      const response = await rawRequest(baseUrl, "/league");
      if (response.status === 200) {
        return;
      }
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for league server:\n${output()}`);
}

async function rawRequest(
  baseUrl: string,
  requestPath: string,
  options: {
    method?: string;
    headers?: http.OutgoingHttpHeaders;
  } = {},
): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        method: options.method ?? "GET",
        path: requestPath,
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}
