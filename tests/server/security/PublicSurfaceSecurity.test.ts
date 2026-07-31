/**
 * Stage 8 item 2's Security suite: "private routes unreachable
 * anonymously; mutating endpoints blocked; operator-billed routes
 * blocked; public JSON audited." Boots a REAL demo server (same binary
 * production runs) against a minimal fixture root on the external volume,
 * in `PROXYWAR_LEAGUE_WRAPPER_ONLY=true` mode — the actual security
 * posture the showcase deployment runs under (confirmed live against
 * `beta.proxywar.xyz` during Stage 7: `/tester-dashboard` redirects
 * anonymously). Every assertion here is a real HTTP round-trip against a
 * live process, not a unit test of the gating function in isolation.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const EXTERNAL_SCRATCH_ROOT =
  "/Volumes/ProxyWar Workspace/ProxyWar/e2e-security-scratch";
const PORT = 18787;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let fixtureRoot: string;
let serverProcess: ChildProcess | null = null;

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

beforeAll(async () => {
  await fs.mkdir(EXTERNAL_SCRATCH_ROOT, { recursive: true });
  fixtureRoot = await fs.mkdtemp(
    path.join(EXTERNAL_SCRATCH_ROOT, "security-"),
  );
  const identityDir = path.join(fixtureRoot, "identity");
  const artifactsRoot = path.join(fixtureRoot, "artifacts");
  await fs.mkdir(identityDir, { recursive: true });

  // Genuinely separate process — `writeCoworldLeagueSite()` internally
  // resolves the identity registry directory from a MODULE-LOAD-TIME
  // constant (`IdentityRegistry.ts`'s `defaultIdentityRegistryDir`).
  // Calling it in-process here, in a test file whose own top-level
  // imports already ran (and already baked in the constant) before this
  // `beforeAll` sets any env var, silently reads the REAL tracked
  // registry instead of the fixture one — confirmed live while building
  // the Stage 8 E2E suite. A fresh child process, started with the env
  // var already in its `env`, has no such staleness.
  await execFileAsync(
    "npx",
    [
      "tsx",
      "src/scripts/proxywar-fixture-league-data.ts",
      `--root=${fixtureRoot}`,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PROXYWAR_IDENTITY_REGISTRY_DIR: identityDir,
      },
    },
  );

  // A fake run directory carrying the two artifacts the Stage 3 fix must
  // keep 404 on every public surface — the regression this suite pins.
  const fakeRunDir = path.join(
    artifactsRoot,
    "ai-league-runs",
    "security-test-run",
  );
  await fs.mkdir(fakeRunDir, { recursive: true });
  await fs.writeFile(
    path.join(fakeRunDir, "decisions.jsonl"),
    '{"reason":"should never be public"}\n',
  );
  await fs.writeFile(
    path.join(fakeRunDir, "visual-report.html"),
    "<html>should never be public</html>",
  );

  serverProcess = spawn(
    "npx",
    ["tsx", "src/scripts/ai-agent-demo-server.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PROXYWAR_LEAGUE_WRAPPER_ONLY: "true",
        PROXYWAR_ARTIFACTS_ROOT: artifactsRoot,
        PROXYWAR_IDENTITY_REGISTRY_DIR: identityDir,
        PROXYWAR_NATIONS_DIR: path.join(fixtureRoot, "nations"),
        PROXYWAR_FEATURED_MATCH_STATE_ROOT: path.join(
          fixtureRoot,
          "featured-match-state",
        ),
        PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: path.join(
          fixtureRoot,
          "premiere-state",
        ),
        PROXYWAR_PLATFORM_STATE_ROOT: path.join(
          fixtureRoot,
          "platform-state",
        ),
        AI_LEAGUE_RENDERER_PORT: "18700",
        GAME_ENV: "dev",
        PORT: String(PORT),
        AI_LEAGUE_DEMO_PORT: String(PORT),
      },
      stdio: "ignore",
      detached: true,
    },
  );
  await waitForOrigin(45_000);
}, 60_000);

afterAll(async () => {
  if (serverProcess?.pid !== undefined) {
    try {
      process.kill(-serverProcess.pid, "SIGKILL");
    } catch {
      serverProcess.kill("SIGKILL");
    }
  }
  if (fixtureRoot !== undefined) {
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup
    });
  }
}, 20_000);

describe("private/tester routes are unreachable anonymously", () => {
  test.each([
    ["GET", "/tester-dashboard"],
    ["GET", "/api/tester-dashboard"],
    ["GET", "/admin"],
    ["GET", "/api/status"],
  ])("%s %s never returns a 200 with real content", async (method, route) => {
    const response = await fetch(`${ORIGIN}${route}`, {
      method,
      redirect: "manual",
    });
    // Either an outright block (404/401) or a redirect away — never a 200.
    expect(response.status).not.toBe(200);
    expect([301, 302, 303, 307, 308, 401, 403, 404]).toContain(
      response.status,
    );
  });
});

describe("mutating and operator-billed endpoints are blocked", () => {
  test.each([
    "/api/jobs",
    "/api/quick-start",
    "/api/lobby/join",
    "/api/agent-relay/sessions",
    "/api/nations",
    "/api/agent-cards/import",
    "/api/agent-cards/import-and-run",
    "/api/external-agents/check",
  ])("POST %s never starts a match or writes state anonymously", async (route) => {
    const response = await fetch(`${ORIGIN}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    // In league-wrapper-only mode every one of these is unreachable outright.
    expect(response.status).toBe(404);
  });

  test("DELETE /api/nations/:id never deletes state anonymously", async () => {
    const response = await fetch(`${ORIGIN}/api/nations/anything`, {
      method: "DELETE",
    });
    expect(response.status).toBe(404);
  });
});

describe("decisions.jsonl and visual-report.html stay 404 on every public surface (Stage 3 fix regression pin)", () => {
  test.each([
    "/ai-league-runs/security-test-run/decisions.jsonl",
    "/ai-league-runs/security-test-run/visual-report.html",
    "/runs/security-test-run/decisions.jsonl",
    "/runs/security-test-run/visual-report.html",
  ])("GET %s is 404, never serves the artifact", async (route) => {
    const response = await fetch(`${ORIGIN}${route}`);
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain("should never be public");
  });
});

describe("genuinely public routes stay reachable (sanity — the gate isn't over-blocking)", () => {
  test.each(["/league", "/watch", "/agents", "/builders", "/build"])(
    "GET %s returns 200",
    async (route) => {
      const response = await fetch(`${ORIGIN}${route}`);
      expect(response.status).toBe(200);
    },
  );

  test("POST /api/build/funnel-event (the one genuinely public POST route) succeeds", async () => {
    const response = await fetch(`${ORIGIN}/api/build/funnel-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: 1 }),
    });
    expect(response.status).toBe(204);
  });
});

describe("public JSON (read-model.json) never carries a private field", () => {
  const forbiddenKeyNames = new Set([
    "decisions",
    "decisiontail",
    "prompt",
    "rawllmoutput",
    "rawllmprompt",
    "privatepolicyoutput",
    "token",
    "tokens",
    "secret",
    "apikey",
    "verifiedgithub",
  ]);

  function collectKeyNames(value: unknown, into: Set<string>): void {
    if (Array.isArray(value)) {
      for (const item of value) collectKeyNames(item, into);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        into.add(key.toLowerCase().replace(/[_-]/g, ""));
        collectKeyNames(nested, into);
      }
    }
  }

  test("read-model.json has no forbidden field name anywhere in its schema", async () => {
    const response = await fetch(
      `${ORIGIN}/ai-league-runs/league/read-model.json`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const keyNames = new Set<string>();
    collectKeyNames(body, keyNames);
    const offenders = [...keyNames].filter((key) =>
      forbiddenKeyNames.has(key),
    );
    expect(offenders).toEqual([]);
  });

  test("data.json (the raw mirror) has no forbidden field name anywhere in its schema", async () => {
    const response = await fetch(`${ORIGIN}/ai-league-runs/league/data.json`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const keyNames = new Set<string>();
    collectKeyNames(body, keyNames);
    const offenders = [...keyNames].filter((key) =>
      forbiddenKeyNames.has(key),
    );
    expect(offenders).toEqual([]);
  });
});
