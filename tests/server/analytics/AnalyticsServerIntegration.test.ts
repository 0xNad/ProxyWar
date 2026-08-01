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
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createProxyWarBetaSessionToken } from "../../../src/server/agents/ProxyWarBetaAccess";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXTERNAL_SCRATCH_ROOT =
  "/Volumes/ProxyWar Workspace/ProxyWar/analytics-integration-scratch";
// Assigned port for this session's fixture/server processes — see the
// worktree-wide coordination broadcast (five concurrent sessions, one port
// each) — reused sequentially across the two boots below rather than
// claiming a second port.
const PORT = 8805;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BETA_CODE = "analytics-report-test-invite-code";
const BETA_COOKIE_NAME = "proxywar_beta";

async function waitForOrigin(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/league`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("fixture server did not come up in time");
}

async function stopServer(serverProcess: ChildProcess | null): Promise<void> {
  if (serverProcess?.pid === undefined) return;
  try {
    process.kill(-serverProcess.pid, "SIGKILL");
  } catch {
    serverProcess.kill("SIGKILL");
  }
}

interface FixtureDirs {
  fixtureRoot: string;
  identityDir: string;
  artifactsRoot: string;
}

async function prepareFixture(label: string): Promise<FixtureDirs> {
  await fs.mkdir(EXTERNAL_SCRATCH_ROOT, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(
    path.join(EXTERNAL_SCRATCH_ROOT, `${label}-`),
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
  extraEnv: Record<string, string>,
): ChildProcess {
  return spawn("npx", ["tsx", "src/scripts/ai-agent-demo-server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PROXYWAR_ARTIFACTS_ROOT: fixture.artifactsRoot,
      PROXYWAR_IDENTITY_REGISTRY_DIR: fixture.identityDir,
      PROXYWAR_NATIONS_DIR: path.join(fixture.fixtureRoot, "nations"),
      PROXYWAR_FEATURED_MATCH_STATE_ROOT: path.join(fixture.fixtureRoot, "featured-match-state"),
      PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: path.join(fixture.fixtureRoot, "premiere-state"),
      PROXYWAR_PLATFORM_STATE_ROOT: path.join(fixture.fixtureRoot, "platform-state"),
      AI_LEAGUE_RENDERER_PORT: String(PORT + 10_000),
      GAME_ENV: "dev",
      PORT: String(PORT),
      AI_LEAGUE_DEMO_PORT: String(PORT),
      ...extraEnv,
    },
    stdio: "ignore",
    detached: true,
  });
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

  beforeAll(async () => {
    fixture = await prepareFixture("analytics-wrapper");
    serverProcess = spawnServer(fixture, { PROXYWAR_LEAGUE_WRAPPER_ONLY: "true" });
    await waitForOrigin(45_000);
  }, 60_000);

  afterAll(async () => {
    await stopServer(serverProcess);
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }, 20_000);

  test("POST /api/analytics/events accepts a valid batch and returns 204", async () => {
    const response = await fetch(`${ORIGIN}/api/analytics/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: analyticsBatchBody("wrapper-mode-visitor-0000001"),
    });
    expect(response.status).toBe(204);
  });

  test("POST /api/analytics/events silently drops a malformed body — still 204, never an error", async () => {
    const response = await fetch(`${ORIGIN}/api/analytics/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(response.status).toBe(204);
  });

  test("GET /analytics-report is unreachable in wrapper-only mode, same posture as every other operator surface", async () => {
    const response = await fetch(`${ORIGIN}/analytics-report`, { redirect: "manual" });
    expect(response.status).not.toBe(200);
  });
});

describe("beta-gated mode: operator report requires a valid session; ingest stays anonymous", () => {
  let fixture: FixtureDirs;
  let serverProcess: ChildProcess | null = null;

  beforeAll(async () => {
    fixture = await prepareFixture("analytics-beta");
    serverProcess = spawnServer(fixture, {
      PROXYWAR_BETA_ENABLED: "true",
      PROXYWAR_BETA_CODE: BETA_CODE,
    });
    await waitForOrigin(45_000);
  }, 60_000);

  afterAll(async () => {
    await stopServer(serverProcess);
    await fs.rm(fixture.fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
  }, 20_000);

  test("POST /api/analytics/events is reachable without a beta session (it's the product surface)", async () => {
    const response = await fetch(`${ORIGIN}/api/analytics/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: analyticsBatchBody("beta-mode-visitor-0000001"),
    });
    expect(response.status).toBe(204);
  });

  test("GET /analytics-report redirects an anonymous visitor to /beta", async () => {
    const response = await fetch(`${ORIGIN}/analytics-report`, { redirect: "manual" });
    expect([301, 302, 303, 307, 308]).toContain(response.status);
    expect(response.headers.get("location")).toMatch(/^\/beta\?next=/);
  });

  test("GET /api/analytics-report returns 401 for an anonymous visitor", async () => {
    const response = await fetch(`${ORIGIN}/api/analytics-report`);
    expect(response.status).toBe(401);
  });

  test("GET /analytics-report renders honest not-yet-instrumented states for a real operator session", async () => {
    const token = createProxyWarBetaSessionToken({ inviteCode: BETA_CODE });
    const response = await fetch(`${ORIGIN}/analytics-report`, {
      headers: { cookie: `${BETA_COOKIE_NAME}=${encodeURIComponent(token)}` },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Analytics Report");
    expect(html).toContain("not yet instrumented");
  });

  test("GET /api/analytics-report returns the computed report JSON for a real operator session", async () => {
    const token = createProxyWarBetaSessionToken({ inviteCode: BETA_CODE });
    const response = await fetch(`${ORIGIN}/api/analytics-report`, {
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
