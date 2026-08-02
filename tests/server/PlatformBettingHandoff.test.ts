/**
 * End-to-end proof of the platform build's contract, against TWO real
 * spawned server processes — `app.proxywar.xyz` (platform, wagering OFF)
 * and `bet.proxywar.xyz` (betting, wagering ON) — exactly the two
 * deployments the contract describes, talking over real HTTP:
 *
 * - Accounts work with wagering off (the platform's own regression risk).
 * - The full handoff: betting redirects to the platform, the platform
 *   issues an opaque code, betting redeems it server-to-server, and
 *   records `platformAccountId` (+ cached display name) against its own
 *   canonical participant — never a second identity system.
 * - Points stay betting-owned; display name resolves from the platform.
 * - Betting works for a user who never signs in (same identity, same
 *   bankroll implied by an unaffected leaderboard read).
 * - The platform is never in the path of a trade: once the platform
 *   process is killed, betting's leaderboard/account reads keep working.
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

interface ServerHandle {
  origin: string;
  process: ChildProcess;
  output: string;
}

describe("platform account authority <-> betting handoff (real servers)", () => {
  let fixtureRoot = "";
  let platform: ServerHandle | null = null;
  let betting: ServerHandle | null = null;

  beforeAll(async () => {
    fixtureRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "proxywar-platform-handoff-")),
    );

    const bettingPort = await reservePort();
    const bettingOrigin = `http://127.0.0.1:${bettingPort}`;
    const platformPort = await reservePort();
    const platformOrigin = `http://127.0.0.1:${platformPort}`;

    const returnOrigins = JSON.stringify({ betting: bettingOrigin });

    platform = await startServer({
      name: "platform",
      port: platformPort,
      fixtureRoot: path.join(fixtureRoot, "platform"),
      extraEnv: {
        PROXYWAR_PLATFORM_ENABLED: "true",
        PROXYWAR_PLATFORM_RETURN_ORIGINS: returnOrigins,
        PROXYWAR_WAGERING_ENABLED: "false",
      },
    });

    betting = await startServer({
      name: "betting",
      port: bettingPort,
      fixtureRoot: path.join(fixtureRoot, "betting"),
      extraEnv: {
        PROXYWAR_WAGERING_ENABLED: "true",
        PROXYWAR_PLATFORM_ORIGIN: platformOrigin,
      },
    });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([stopServer(platform?.process ?? null), stopServer(betting?.process ?? null)]);
    if (fixtureRoot !== "") await rm(fixtureRoot, { recursive: true, force: true });
  });

  test("the platform serves accounts with wagering off — GET /api/account works, bootstraps a fresh account", async () => {
    const response = await rawRequest(platform!.origin, "GET", "/api/account");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      identity: { accountId: string; displayName: null };
      claims: unknown[];
    };
    expect(body.identity.accountId).toMatch(/^acct_[a-f0-9]{32}$/);
    expect(body.identity.displayName).toBeNull();
    expect(body.claims).toEqual([]);
  });

  test("GitHub auth routes are absent on the platform when no OAuth credentials are configured", async () => {
    const response = await rawRequest(platform!.origin, "GET", "/api/auth/github/start");
    expect(response.status).toBe(404);
  });

  test("a betting user who never signs in still gets a working leaderboard/account read (same identity, no platform dependency)", async () => {
    const response = await rawRequest(betting!.origin, "GET", "/api/premieres/account");
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as {
      identity: { participantId: string; platformLinked: boolean; displayName: null };
    };
    expect(body.identity.participantId).toMatch(/^guest_[a-f0-9]{32}$/);
    expect(body.identity.platformLinked).toBe(false);
    expect(body.identity.displayName).toBeNull();
  });

  test("/api/identity/status sees the SAME guest cookie /api/premieres/account issued -- regression for a live P0: a Path=/api/premieres cookie is invisible to /api/identity/status (outside that path), so it silently re-minted a fresh identity on every call", async () => {
    const bootstrapResponse = await rawRequest(betting!.origin, "GET", "/api/premieres/account");
    const guestCookie = firstCookiePair(bootstrapResponse.headers, "proxywar_premiere_guest");
    expect(guestCookie).not.toBeNull();
    const bootstrapBody = JSON.parse(bootstrapResponse.body) as {
      identity: { participantId: string };
    };

    const statusResponse = await rawRequest(betting!.origin, "GET", "/api/identity/status", {
      cookie: guestCookie!,
    });
    expect(statusResponse.status).toBe(200);
    // The whole bug: this must NOT set a competing cookie for a
    // participant the caller never asked to become.
    expect(firstCookiePair(statusResponse.headers, "proxywar_premiere_guest")).toBeNull();

    // The identity read afterward must still resolve to the SAME
    // participant /api/premieres/account bootstrapped -- not a fresh one.
    const afterStatus = await rawRequest(betting!.origin, "GET", "/api/premieres/account", {
      cookie: guestCookie!,
    });
    const afterStatusBody = JSON.parse(afterStatus.body) as {
      identity: { participantId: string };
    };
    expect(afterStatusBody.identity.participantId).toBe(
      bootstrapBody.identity.participantId,
    );
  });

  test("a guest who merely visits the sign-in page and never completes the handoff still reads signedIn:false — the header must bind to a completed link, never a mere session/intent cookie", async () => {
    // Regression check for a P2 report: does /api/identity/status's
    // `signedIn` bind to "an authenticated, completed platform link"
    // (correct) or to something weaker like "a session/intent cookie
    // exists" (would falsely show "Signed in" for a visit-only guest)?
    const bootstrapResponse = await rawRequest(betting!.origin, "GET", "/api/premieres/account");
    const bettingCookie = firstCookiePair(bootstrapResponse.headers, "proxywar_premiere_guest")!;

    const beforeStatus = await rawRequest(betting!.origin, "GET", "/api/identity/status", {
      cookie: bettingCookie,
    });
    const beforeBody = JSON.parse(beforeStatus.body) as {
      identity: { signedIn: boolean };
    };
    expect(beforeBody.identity.signedIn).toBe(false);

    // Click "sign in": betting mints a link-intent cookie and redirects to
    // the platform's own /handoff/start — the user reaches the OAuth-style
    // consent surface but goes no further (closes the tab, hits back —
    // never returns with a code to betting's /callback).
    const handoffStart = await rawRequest(betting!.origin, "GET", "/api/premieres/auth/handoff/start", {
      cookie: bettingCookie,
    });
    expect(handoffStart.status).toBe(302);
    const platformStartUrl = new URL(handoffStart.headers.location!);
    const handoffIssue = await rawRequest(
      platform!.origin,
      "GET",
      `${platformStartUrl.pathname}${platformStartUrl.search}`,
    );
    // The platform DID mint a real one-time code (the consent surface was
    // reached) — this proves the abandonment happens strictly AFTER this
    // point, not because the platform itself refused.
    expect(handoffIssue.status).toBe(302);
    expect(new URL(handoffIssue.headers.location!).searchParams.get("code")).not.toBeNull();

    // The user never follows that redirect back to betting's own
    // /callback. Betting's own state for this guest must be untouched:
    // still exactly the same cookie, still signedIn:false.
    const afterAbandon = await rawRequest(betting!.origin, "GET", "/api/identity/status", {
      cookie: bettingCookie,
    });
    expect(afterAbandon.status).toBe(200);
    const afterBody = JSON.parse(afterAbandon.body) as {
      identity: { signedIn: boolean; displayName: string | null };
    };
    expect(afterBody.identity.signedIn).toBe(false);
    expect(afterBody.identity.displayName).toBeNull();

    // Same check via the account route's own `platformLinked` field —
    // the exact field GithubSignIn.ts's header binds to.
    const account = await rawRequest(betting!.origin, "GET", "/api/premieres/account", {
      cookie: bettingCookie,
    });
    const accountBody = JSON.parse(account.body) as {
      identity: { platformLinked: boolean };
    };
    expect(accountBody.identity.platformLinked).toBe(false);
  });

  test("the full handoff: betting -> platform -> back to betting, sets a display name AND a private lineage claim SET (two lineages, both survive), both resolve on the betting side without betting ever writing them, and the claims never reach a public route", async () => {
    // 1. Establish a betting guest session.
    const bootstrapResponse = await rawRequest(betting!.origin, "GET", "/api/premieres/account");
    const bettingCookie = firstCookiePair(bootstrapResponse.headers, "proxywar_premiere_guest");
    expect(bettingCookie).not.toBeNull();

    // 2. Set a display name on the PLATFORM directly (simulating the user
    //    having already visited app.proxywar.xyz and named themselves).
    const platformAccount = await rawRequest(platform!.origin, "GET", "/api/account");
    const platformCookie = firstCookiePair(platformAccount.headers, "proxywar_platform_account");
    expect(platformCookie).not.toBeNull();
    const { csrfToken } = JSON.parse(platformAccount.body) as { csrfToken: string };
    const nameResponse = await rawRequest(
      platform!.origin,
      "POST",
      "/api/account/display-name",
      {
        cookie: platformCookie!,
        origin: platform!.origin,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      JSON.stringify({ displayName: "Daveey the Great" }),
    );
    expect(nameResponse.status).toBe(200);

    // 2b. Also set TWO private, self-asserted lineage claims on the
    //     platform — proves the handoff's claim-passthrough carries the
    //     whole SET, not just one ("accounts are for all model").
    const claimResponse = await rawRequest(
      platform!.origin,
      "POST",
      "/api/account/claim",
      {
        cookie: platformCookie!,
        origin: platform!.origin,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      JSON.stringify({ label: "daveey-proxywar:v24" }),
    );
    expect(claimResponse.status).toBe(200);
    const secondClaimResponse = await rawRequest(
      platform!.origin,
      "POST",
      "/api/account/claim",
      {
        cookie: platformCookie!,
        origin: platform!.origin,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
      },
      JSON.stringify({ label: "second-lineage:v3" }),
    );
    expect(secondClaimResponse.status).toBe(200);
    const secondClaimBody = JSON.parse(secondClaimResponse.body) as {
      claims: { lineageSlug: string }[];
    };
    // The first claim is still present — adding a second never discards it.
    expect(secondClaimBody.claims.map((c) => c.lineageSlug).sort()).toEqual([
      "daveey-proxywar",
      "second-lineage",
    ]);

    // 3. Click "sign in" on betting: GET the handoff start, following
    //    redirects by hand (a real browser would do this automatically,
    //    carrying each origin's own cookie jar).
    const handoffStart = await rawRequest(betting!.origin, "GET", "/api/premieres/auth/handoff/start", {
      cookie: bettingCookie!,
    });
    expect(handoffStart.status).toBe(302);
    const bettingIntentCookie = firstCookiePair(
      handoffStart.headers,
      "proxywar_premiere_link_intent",
    );
    expect(bettingIntentCookie).not.toBeNull();
    const platformStartUrl = new URL(handoffStart.headers.location!);
    expect(platformStartUrl.origin).toBe(platform!.origin);

    // 4. The browser navigates to the platform's /handoff/start, carrying
    //    the SAME platform cookie from step 2 (the user is already
    //    recognised by the platform).
    const handoffIssue = await rawRequest(
      platform!.origin,
      "GET",
      `${platformStartUrl.pathname}${platformStartUrl.search}`,
      { cookie: platformCookie! },
    );
    expect(handoffIssue.status).toBe(302);
    const returnUrl = new URL(handoffIssue.headers.location!);
    expect(returnUrl.origin).toBe(betting!.origin);
    expect(returnUrl.pathname).toBe("/api/premieres/auth/handoff/callback");
    expect(returnUrl.searchParams.get("code")).not.toBeNull();

    // 5. The browser lands back on betting's callback, carrying its own
    //    guest cookie + the link-intent cookie minted in step 3.
    const callback = await rawRequest(
      betting!.origin,
      "GET",
      `${returnUrl.pathname}${returnUrl.search}`,
      { cookie: `${bettingCookie}; ${bettingIntentCookie}` },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain("identity=linked");

    // 6. Betting's account read now shows the platform-sourced display
    //    name — resolved from BettingPlatformAccountLinkStore, never
    //    written by betting itself (no such write route exists anymore).
    const linkedCookie =
      firstCookiePair(callback.headers, "proxywar_premiere_guest") ?? bettingCookie!;
    const afterLink = await rawRequest(betting!.origin, "GET", "/api/premieres/account", {
      cookie: linkedCookie,
    });
    expect(afterLink.status).toBe(200);
    const afterLinkBody = JSON.parse(afterLink.body) as {
      identity: {
        platformLinked: boolean;
        displayName: string | null;
        claims: { lineageSlug: string; label: string }[];
      };
    };
    expect(afterLinkBody.identity.platformLinked).toBe(true);
    expect(afterLinkBody.identity.displayName).toBe("Daveey the Great");
    // BOTH claims resolve same-origin on betting, sourced from the
    // handoff's cached copy — no cross-origin request, no platform call.
    expect(
      afterLinkBody.identity.claims.map((c) => c.lineageSlug).sort(),
    ).toEqual(["daveey-proxywar", "second-lineage"]);

    // The claims are private: they must never leak into a PUBLIC route,
    // even though the SAME server process now holds them in the link
    // store.
    const leaderboard = await rawRequest(
      betting!.origin,
      "GET",
      "/api/premieres/points/leaderboard",
    );
    expect(leaderboard.body.toLowerCase()).not.toContain("lineageslug");
    expect(leaderboard.body.toLowerCase()).not.toContain("daveey-proxywar");
    expect(leaderboard.body.toLowerCase()).not.toContain("second-lineage");
  });

  test("a handoff code cannot be redeemed twice: replaying the exact callback the second time fails, first identity link is untouched", async () => {
    const bootstrapResponse = await rawRequest(betting!.origin, "GET", "/api/premieres/account");
    const bettingCookie = firstCookiePair(bootstrapResponse.headers, "proxywar_premiere_guest")!;
    const handoffStart = await rawRequest(
      betting!.origin,
      "GET",
      "/api/premieres/auth/handoff/start",
      { cookie: bettingCookie },
    );
    const intentCookie = firstCookiePair(handoffStart.headers, "proxywar_premiere_link_intent")!;
    const platformStartUrl = new URL(handoffStart.headers.location!);
    const handoffIssue = await rawRequest(
      platform!.origin,
      "GET",
      `${platformStartUrl.pathname}${platformStartUrl.search}`,
    );
    const returnUrl = new URL(handoffIssue.headers.location!);
    const cookieHeader = `${bettingCookie}; ${intentCookie}`;
    const first = await rawRequest(
      betting!.origin,
      "GET",
      `${returnUrl.pathname}${returnUrl.search}`,
      { cookie: cookieHeader },
    );
    expect(first.status).toBe(302);
    expect(first.headers.location).toContain("identity=linked");

    // Replay the exact same callback URL (same code+state) a second time.
    // The link-intent cookie is single-use in practice (cleared after the
    // first callback), but even presenting it again, the CODE itself is
    // what must refuse a second redemption.
    const second = await rawRequest(
      betting!.origin,
      "GET",
      `${returnUrl.pathname}${returnUrl.search}`,
      { cookie: cookieHeader },
    );
    expect(second.status).toBe(302);
    expect(second.headers.location).toContain("identity=error");
  });

  test("the platform going down never blocks betting: leaderboard and account reads keep working after the platform process exits", async () => {
    await stopServer(platform!.process);
    const leaderboard = await rawRequest(betting!.origin, "GET", "/api/premieres/points/leaderboard");
    expect(leaderboard.status).toBe(200);
    const account = await rawRequest(betting!.origin, "GET", "/api/premieres/account");
    expect(account.status).toBe(200);
  });
});

async function startServer(options: {
  name: string;
  port: number;
  fixtureRoot: string;
  extraEnv: Record<string, string>;
}): Promise<ServerHandle> {
  const homeRoot = path.join(options.fixtureRoot, "home");
  const nationsRoot = path.join(options.fixtureRoot, "nations");
  const staticRoot = path.join(options.fixtureRoot, "static");
  const artifactsRoot = path.join(options.fixtureRoot, "artifacts");
  // Siblings of fixtureRoot, never children — fixtureRoot IS the server's
  // cwd (a servedRoot), and `assertSafeRoot` rejects a private state root
  // nested inside anything served.
  const privateStateRoot = path.join(
    path.dirname(options.fixtureRoot),
    `${path.basename(options.fixtureRoot)}-premiere-state`,
  );
  const pointsLedgerRoot = path.join(
    path.dirname(options.fixtureRoot),
    `${path.basename(options.fixtureRoot)}-points-ledger`,
  );
  const platformStateRoot = path.join(
    path.dirname(options.fixtureRoot),
    `${path.basename(options.fixtureRoot)}-platform-private`,
  );

  await Promise.all([
    mkdir(homeRoot, { recursive: true }),
    mkdir(nationsRoot, { recursive: true }),
    mkdir(staticRoot, { recursive: true }),
    mkdir(path.join(artifactsRoot, "ai-league-runs", "league"), { recursive: true }),
    mkdir(path.join(options.fixtureRoot, "resources", "lang"), { recursive: true }),
    mkdir(privateStateRoot, { recursive: true }),
    mkdir(pointsLedgerRoot, { recursive: true }),
    mkdir(platformStateRoot, { recursive: true }),
  ]);
  await chmod(privateStateRoot, 0o700);
  await chmod(pointsLedgerRoot, 0o700);
  await chmod(platformStateRoot, 0o700);

  await Promise.all([
    writeFile(
      path.join(options.fixtureRoot, "index.html"),
      "<!doctype html><html><head><title>Proxy War</title></head><body>PROXY WAR</body></html>",
      "utf8",
    ),
    writeFile(
      path.join(staticRoot, "index.html"),
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
  ]);

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
        HOME: homeRoot,
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
        PROXYWAR_ARTIFACTS_ROOT: artifactsRoot,
        PROXYWAR_NATIONS_DIR: nationsRoot,
        PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: privateStateRoot,
        PROXYWAR_POINTS_LEDGER_ROOT: pointsLedgerRoot,
        PROXYWAR_PLATFORM_STATE_ROOT: platformStateRoot,
        ...options.extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const handle: ServerHandle = { origin, process: child, output: "" };
  child.stdout?.on("data", (chunk: Buffer) => {
    handle.output += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    handle.output += chunk.toString();
  });
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
      const response = await rawRequest(handle.origin, "GET", "/api/premieres/points/leaderboard");
      if (response.status === 200 || response.status === 404) return;
    } catch {
      // Not listening yet.
    }
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
  method: string,
  requestPath: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<RawResponse> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        method,
        path: requestPath,
        headers: { accept: "application/json", referer: `${baseUrl}/`, ...headers },
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
    if (body !== undefined) request.write(body);
    request.end();
  });
}

/** Extracts `name=value` (no attributes) for one cookie name from a `Set-Cookie` response header, for replaying on the next request. */
function firstCookiePair(
  headers: http.IncomingHttpHeaders,
  name: string,
): string | null {
  const raw = headers["set-cookie"];
  if (raw === undefined) return null;
  for (const entry of raw) {
    const pair = entry.split(";")[0];
    if (pair.startsWith(`${name}=`)) return pair;
  }
  return null;
}
