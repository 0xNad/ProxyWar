/**
 * Stage 8 item 2's Security suite: "private routes unreachable
 * anonymously; mutating endpoints blocked; operator-billed routes
 * blocked; public JSON audited." Boots a REAL demo server (same binary
 * production runs) against a minimal fixture root under a portable
 * `os.tmpdir()` scratch directory (same `fs.realpath(os.tmpdir())` +
 * `mkdtemp()` pattern used throughout this repo's other fixture-scratch
 * tests — previously hardcoded to a fixed external-volume path that
 * doesn't exist on Linux CI, EACCES'd there — in
 * `PROXYWAR_LEAGUE_WRAPPER_ONLY=true` mode — the actual security posture
 * the showcase deployment runs under (confirmed live against
 * `beta.proxywar.xyz` during Stage 7: `/tester-dashboard` redirects
 * anonymously). Every assertion here is a real HTTP round-trip against a
 * live process, not a unit test of the gating function in isolation.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ORDINARY_EPISODE } from "../../../src/server/fixtures/PublicProductFixtureData";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const PORT = 18787;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/**
 * `static/public.html` is a Vite build output (`npm run build-prod`), and
 * `npm test` never builds. CI does: `ci.yml` builds it in the `build` job and
 * every test shard restores it via the "Download static app shell" step before
 * running vitest — so a shell missing *in CI* is a real failure, not a local
 * prerequisite gap, and must stop the run rather than quietly skip.
 *
 * Without the shell, `sendPublicAppShellPage()` cannot read the file and
 * answers 503. That surfaced as eight opaque `expected 503 to be 200`
 * assertions that read like a product regression on a fresh checkout. Skipping
 * the shell-dependent blocks locally, with a pointer to the build command,
 * keeps the failure honest; every assertion that does not need the shell
 * (the anonymous-access gate, the mutating-endpoint blocks, the public-JSON
 * field audits) still runs.
 *
 * Deliberately a skip, not a stub shell: the OG/spoiler-safety test asserts
 * the raw HTML never contains the winner name, which a placeholder would
 * satisfy vacuously — a green test protecting nothing is worse than a
 * declared skip.
 */
const APP_SHELL_PATH = path.join(REPO_ROOT, "static", "public.html");
const APP_SHELL_BUILT = existsSync(APP_SHELL_PATH);

if (!APP_SHELL_BUILT && process.env.CI) {
  throw new Error(
    `Missing ${APP_SHELL_PATH}: CI must restore the static app shell artifact before this suite runs.`,
  );
}
if (!APP_SHELL_BUILT) {
  console.warn(
    `[PublicSurfaceSecurity] ${APP_SHELL_PATH} is not built — skipping the app-shell-dependent blocks. Run \`npm run build-prod\` first to exercise them.`,
  );
}

/** `describe` for blocks that need the built public app shell to answer 200. */
const describeWithAppShell = APP_SHELL_BUILT ? describe : describe.skip;

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
  fixtureRoot = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "security-"),
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

  serverProcess = spawn("npx", ["tsx", "src/scripts/ai-agent-demo-server.ts"], {
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
      PROXYWAR_PLATFORM_STATE_ROOT: path.join(fixtureRoot, "platform-state"),
      AI_LEAGUE_RENDERER_PORT: "18700",
      GAME_ENV: "dev",
      PORT: String(PORT),
      AI_LEAGUE_DEMO_PORT: String(PORT),
    },
    stdio: "ignore",
    detached: true,
  });
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
    expect([301, 302, 303, 307, 308, 401, 403, 404]).toContain(response.status);
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
  ])(
    "POST %s never starts a match or writes state anonymously",
    async (route) => {
      const response = await fetch(`${ORIGIN}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      // In league-wrapper-only mode every one of these is unreachable outright.
      expect(response.status).toBe(404);
    },
  );

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

// `/league` is served by the league wrapper, not `sendPublicAppShellPage()`,
// so it stays reachable without a build — `waitForOrigin()` already depends on
// that. The other four are public-app-shell pages; see APP_SHELL_BUILT.
describeWithAppShell(
  "public app-shell routes stay reachable (sanity — the gate isn't over-blocking)",
  () => {
    test.each(["/watch", "/agents", "/builders", "/build"])(
      "GET %s returns 200",
      async (route) => {
        const response = await fetch(`${ORIGIN}${route}`);
        expect(response.status).toBe(200);
      },
    );
  },
);

describe("genuinely public routes stay reachable (sanity — the gate isn't over-blocking)", () => {
  test.each(["/league"])("GET %s returns 200", async (route) => {
    const response = await fetch(`${ORIGIN}${route}`);
    expect(response.status).toBe(200);
  });

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
    const offenders = [...keyNames].filter((key) => forbiddenKeyNames.has(key));
    expect(offenders).toEqual([]);
  });

  test("data.json (the raw mirror) has no forbidden field name anywhere in its schema", async () => {
    const response = await fetch(`${ORIGIN}/ai-league-runs/league/data.json`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const keyNames = new Set<string>();
    collectKeyNames(body, keyNames);
    const offenders = [...keyNames].filter((key) => forbiddenKeyNames.has(key));
    expect(offenders).toEqual([]);
  });
});

describe("GET /api/matches/:episodeId (league-episode match page) never carries a private field", () => {
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

  test("a real fixture episode's response has no forbidden field name anywhere in its schema", async () => {
    const response = await fetch(
      `${ORIGIN}/api/matches/${encodeURIComponent(ORDINARY_EPISODE.episodeRequestId)}`,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const keyNames = new Set<string>();
    collectKeyNames(body, keyNames);
    const offenders = [...keyNames].filter((key) => forbiddenKeyNames.has(key));
    expect(offenders).toEqual([]);
  });

  test("an unknown episode id 404s rather than leaking a stack trace or path echo", async () => {
    const response = await fetch(
      `${ORIGIN}/api/matches/ereq_totally-unknown-id`,
    );
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain("Cannot GET");
    expect(body).not.toContain("at ");
  });

  test("the featured-match id namespace (feat_...) is never resolved by the episode route", async () => {
    const response = await fetch(
      `${ORIGIN}/api/matches/${encodeURIComponent("feat_00000000000000000000")}`,
    );
    expect(response.status).toBe(404);
  });
});

describeWithAppShell(
  "/match/:matchId page shell (OG/social metadata) is spoiler-safe for a league episode",
  () => {
    test("the raw, un-hydrated HTML never contains the episode's own winner name in <title>/description/og:*", async () => {
      const response = await fetch(
        `${ORIGIN}/match/${encodeURIComponent(ORDINARY_EPISODE.episodeRequestId)}`,
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain(`${ORDINARY_EPISODE.winnerName} wins`);
      expect(html.toLowerCase()).not.toContain("winner:");
    });
  },
);

describeWithAppShell(
  "status-code parity: a not-found /match|/agent|/builder page returns a real 404, not a 200 for content whose only body is 'not found' (P2, 2026-08-02)",
  () => {
    test("GET /match/:matchId returns 200 for a real fixture episode, 404 for an unknown id — same HTML app-shell body either way", async () => {
      const found = await fetch(
        `${ORIGIN}/match/${encodeURIComponent(ORDINARY_EPISODE.episodeRequestId)}`,
      );
      expect(found.status).toBe(200);
      const notFound = await fetch(
        `${ORIGIN}/match/${encodeURIComponent("ereq_totally-unknown-id")}`,
      );
      expect(notFound.status).toBe(404);
      // The client-rendered not-found UX is unchanged — same app shell body,
      // only the transport-level status code differs.
      const notFoundBody = await notFound.text();
      expect(notFoundBody).toContain("<!doctype html>");
      expect(notFoundBody).toContain("window.ASSET_MANIFEST");
      expect(notFoundBody).not.toContain("Cannot GET");
    });

    test("GET /agent/:slug returns 200 for a real fixture agent, 404 for an unknown slug", async () => {
      const found = await fetch(`${ORIGIN}/agent/fixture-cyan-hellstar`);
      expect(found.status).toBe(200);
      const notFound = await fetch(
        `${ORIGIN}/agent/totally-unknown-agent-slug-9f3c1a`,
      );
      expect(notFound.status).toBe(404);
      const notFoundBody = await notFound.text();
      expect(notFoundBody).toContain("<!doctype html>");
      expect(notFoundBody).toContain("window.ASSET_MANIFEST");
      expect(notFoundBody).not.toContain("Cannot GET");
    });

    test("GET /builder/:slug returns 200 for a real fixture builder, 404 for an unknown slug", async () => {
      const found = await fetch(`${ORIGIN}/builder/fixture-ada`);
      expect(found.status).toBe(200);
      const notFound = await fetch(
        `${ORIGIN}/builder/totally-unknown-builder-slug-9f3c1a`,
      );
      expect(notFound.status).toBe(404);
      const notFoundBody = await notFound.text();
      expect(notFoundBody).toContain("<!doctype html>");
      expect(notFoundBody).toContain("window.ASSET_MANIFEST");
      expect(notFoundBody).not.toContain("Cannot GET");
    });
  },
);
