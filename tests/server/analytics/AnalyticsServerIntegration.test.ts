/**
 * Real HTTP round-trips against a live `ai-agent-demo-server.ts` process
 * (same binary production runs) covering the two properties that can only
 * be verified this way, not from a unit test of the route handlers in
 * isolation:
 *  - `POST /api/analytics/events` stays reachable in
 *    `PROXYWAR_LEAGUE_WRAPPER_ONLY=true` mode — the hardened posture the
 *    live public deployment actually runs under. The wrapper-only gate
 *    history (Stage 7's `/api/build/*` gate bug) is exactly why this needs
 *    a real boot, not just reading the source for the exemption string.
 *  - `/analytics-report` and `/api/analytics-report` require a valid beta
 *    session (redirect / 401 for anonymous, 200 for a real session token),
 *    matching `/tester-dashboard`'s posture — never anonymous.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createProxyWarBetaSessionToken } from "../../../src/server/agents/ProxyWarBetaAccess";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const require = createRequire(import.meta.url);
// Portable os.tmpdir()-rooted scratch dir — same pattern every other
// fixture-scratch test in this repo already uses (e.g.
// `PremiereWageringBundle.test.ts`). Previously hardcoded to a fixed
// external-volume path that doesn't exist on Linux CI runners; see
// `tests/e2e/support/FixtureServer.ts`'s doc comment for the full history.
const BETA_CODE = "analytics-report-test-invite-code";
const BETA_COOKIE_NAME = "proxywar_beta";

// Each `describe` block reserves its own ephemeral port via `reservePort()`
// (same pattern as `PlatformRootPage.test.ts` / `PlayerProfileIsolation.test.ts`)
// instead of a shared fixed port. A fixed port made this file order-dependent:
// the previous version killed the whole `npx`-wrapped process tree with an
// unawaited `SIGKILL` and moved on, so under full-suite load the next
// `describe` block's boot could race the still-closing previous one on the
// same port. Fresh ephemeral ports remove the race entirely; spawning
// `tsx/cli` directly (below, same as the sibling files) also drops the
// `npx` wrapper layer, so a plain `SIGTERM`-then-`SIGKILL` on the direct
// child is sufficient without process-group tricks.
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

async function waitForOrigin(
  origin: string,
  timeoutMs: number,
  serverOutput: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/league`);
      if (response.ok) return;
    } catch {
      // Booting a real server process — no event to await instead of a
      // bounded real-clock poll here.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `fixture server did not come up in time:\n${serverOutput()}`,
  );
}

// Graceful-then-forced shutdown of a real child process; the bounded wait
// is a real-clock grace period for SIGTERM, not something fakeable (same
// pattern and rationale as `PlatformRootPage.test.ts`'s `stopServer`).
async function stopServer(serverProcess: ChildProcess | null): Promise<void> {
  if (serverProcess === null || serverProcess.exitCode !== null) return;
  serverProcess.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => serverProcess.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (serverProcess.exitCode === null) serverProcess.kill("SIGKILL");
}

interface FixtureDirs {
  fixtureRoot: string;
  identityDir: string;
  artifactsRoot: string;
}

async function prepareFixture(label: string): Promise<FixtureDirs> {
  const fixtureRoot = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), `${label}-`),
  );
  const identityDir = path.join(fixtureRoot, "identity");
  const artifactsRoot = path.join(fixtureRoot, "artifacts");
  await fs.mkdir(identityDir, { recursive: true });
  // Genuinely separate process — `IdentityRegistry.ts`'s default registry
  // dir is a module-load-time constant, so populating it must happen in a
  // fresh process started with the env var already set (see
  // `PublicSurfaceSecurity.test.ts`'s identical doc for why).
  await execFileAsync(
    "npx",
    ["tsx", "src/scripts/proxywar-fixture-league-data.ts", `--root=${fixtureRoot}`],
    { cwd: REPO_ROOT, env: { ...process.env, PROXYWAR_IDENTITY_REGISTRY_DIR: identityDir } },
  );
  return { fixtureRoot, identityDir, artifactsRoot };
}

function spawnServer(
  fixture: FixtureDirs,
  port: number,
  extraEnv: Record<string, string>,
): ChildProcess {
  return spawn(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      "--tsconfig",
      path.join(REPO_ROOT, "tsconfig.json"),
      path.join(REPO_ROOT, "src", "scripts", "ai-agent-demo-server.ts"),
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PROXYWAR_ARTIFACTS_ROOT: fixture.artifactsRoot,
        PROXYWAR_IDENTITY_REGISTRY_DIR: fixture.identityDir,
        PROXYWAR_NATIONS_DIR: path.join(fixture.fixtureRoot, "nations"),
        PROXYWAR_FEATURED_MATCH_STATE_ROOT: path.join(fixture.fixtureRoot, "featured-match-state"),
        PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: path.join(fixture.fixtureRoot, "premiere-state"),
        PROXYWAR_PLATFORM_STATE_ROOT: path.join(fixture.fixtureRoot, "platform-state"),
        // This test only exercises the analytics HTTP surface — no clip or
        // replay rendering is under test, so the renderer child process
        // (a Vite dev server, itself capable of spawning headless Chrome
        // for clip capture) stays off. Matches `PlatformRootPage.test.ts`'s
        // `baseServerEnv` convention; keeps this file leak-proof by never
        // spawning the extra process tree in the first place.
        AI_LEAGUE_DEMO_RENDERER: "false",
        AI_LEAGUE_RENDERER_PORT: String(port + 10_000),
        GAME_ENV: "dev",
        PORT: String(port),
        AI_LEAGUE_DEMO_PORT: String(port),
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function analyticsBatchBody(visitorId: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    visitorId,
    events: [{ name: "page_viewed", occurredAt: new Date().toISOString(), route: "/" }],
  });
}

describe("wrapper-only mode: analytics ingest stays reachable, report stays gated", () => {
  let fixture: FixtureDirs;
  let serverProcess: ChildProcess | null = null;
  let origin: string;
  let serverOutput = "";

  beforeAll(async () => {
    fixture = await prepareFixture("analytics-wrapper");
    const port = await reservePort();
    origin = `http://127.0.0.1:${port}`;
    serverProcess = spawnServer(fixture, port, { PROXYWAR_LEAGUE_WRAPPER_ONLY: "true" });
    serverProcess.stdout?.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));
    serverProcess.stderr?.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));
    await waitForOrigin(origin, 45_000, () => serverOutput);
  }, 60_000);

  afterAll(async () => {
    await stopServer(serverProcess);
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }, 20_000);

  test("POST /api/analytics/events accepts a valid batch and returns 204", async () => {
    const response = await fetch(`${origin}/api/analytics/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: analyticsBatchBody("wrapper-mode-visitor-0000001"),
    });
    expect(response.status).toBe(204);
  });

  test("POST /api/analytics/events silently drops a malformed body — still 204, never an error", async () => {
    const response = await fetch(`${origin}/api/analytics/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(response.status).toBe(204);
  });

  test("GET /analytics-report is unreachable in wrapper-only mode, same posture as every other operator surface", async () => {
    const response = await fetch(`${origin}/analytics-report`, { redirect: "manual" });
    expect(response.status).not.toBe(200);
  });
});

describe("beta-gated mode: operator report requires a valid session; ingest stays anonymous", () => {
  let fixture: FixtureDirs;
  let serverProcess: ChildProcess | null = null;
  let origin: string;
  let serverOutput = "";

  beforeAll(async () => {
    fixture = await prepareFixture("analytics-beta");
    const port = await reservePort();
    origin = `http://127.0.0.1:${port}`;
    serverProcess = spawnServer(fixture, port, {
      PROXYWAR_BETA_ENABLED: "true",
      PROXYWAR_BETA_CODE: BETA_CODE,
    });
    serverProcess.stdout?.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));
    serverProcess.stderr?.on("data", (chunk: Buffer) => (serverOutput += chunk.toString()));
    await waitForOrigin(origin, 45_000, () => serverOutput);
  }, 60_000);

  afterAll(async () => {
    await stopServer(serverProcess);
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }, 20_000);

  test("POST /api/analytics/events is reachable without a beta session (it's the product surface)", async () => {
    const response = await fetch(`${origin}/api/analytics/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: analyticsBatchBody("beta-mode-visitor-0000001"),
    });
    expect(response.status).toBe(204);
  });

  test("GET /analytics-report redirects an anonymous visitor to /beta", async () => {
    const response = await fetch(`${origin}/analytics-report`, { redirect: "manual" });
    expect([301, 302, 303, 307, 308]).toContain(response.status);
    expect(response.headers.get("location")).toMatch(/^\/beta\?next=/);
  });

  test("GET /api/analytics-report returns 401 for an anonymous visitor", async () => {
    const response = await fetch(`${origin}/api/analytics-report`);
    expect(response.status).toBe(401);
  });

  test("GET /analytics-report renders honest not-yet-instrumented states for a real operator session", async () => {
    const token = createProxyWarBetaSessionToken({ inviteCode: BETA_CODE });
    const response = await fetch(`${origin}/analytics-report`, {
      headers: { cookie: `${BETA_COOKIE_NAME}=${encodeURIComponent(token)}` },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Analytics Report");
    expect(html).toContain("not yet instrumented");
  });

  test("GET /api/analytics-report returns the computed report JSON for a real operator session", async () => {
    const token = createProxyWarBetaSessionToken({ inviteCode: BETA_CODE });
    const response = await fetch(`${origin}/api/analytics-report`, {
      headers: { cookie: `${BETA_COOKIE_NAME}=${encodeURIComponent(token)}` },
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      homepageToWatchCtr: { status: string; denominator: number };
      replayLoadSuccessRate: { status: string };
    };
    // The earlier test in this block already POSTed one page_viewed event
    // on "/" — confirms ingest → aggregate → report actually flows
    // end-to-end. It's one event, far below the reporting threshold, so
    // the honest state is "insufficient_traffic" (raw counts), never a
    // fabricated percentage. replay_load_* was never posted at all, so
    // that metric stays genuinely "not_yet_instrumented".
    expect(json.homepageToWatchCtr.status).toBe("insufficient_traffic");
    expect(json.homepageToWatchCtr.denominator).toBe(1);
    expect(json.replayLoadSuccessRate.status).toBe("not_yet_instrumented");
  });
});
