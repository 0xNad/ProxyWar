/**
 * Boots a real `ai-agent-demo-server.ts` process against the Stage 8
 * public-product fixture data, on the external volume (never `os.tmpdir()`
 * — internal disk stays under the 25 GiB floor for the lifetime of this
 * overhaul). Shared by the E2E suite and (in spirit — that suite inlines
 * its own minimal variant for speed) the security suite.
 *
 * Fixture DATA GENERATION runs in a SEPARATE spawned process
 * (`proxywar-fixture-league-data.ts`), never in-process here — confirmed
 * live that calling `writeCoworldLeagueSite()` directly in the test
 * process reads the REAL tracked `resources/identity/` registry instead
 * of the fixture one: `IdentityRegistry.ts`'s `defaultIdentityRegistryDir`
 * is a MODULE-LOAD-TIME constant, already resolved (using whatever
 * `process.env.PROXYWAR_IDENTITY_REGISTRY_DIR` happened to be at the test
 * process's own startup, i.e. unset) by the time this file's top-level
 * imports run — setting the env var afterward, in a `beforeAll`, cannot
 * retroactively change an already-evaluated constant. A genuinely
 * separate process, started with the env var already in its `env`, does
 * not have this problem.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "../../..");
export const EXTERNAL_SCRATCH_ROOT =
  "/Volumes/ProxyWar Workspace/ProxyWar/e2e-fixture-scratch";

export interface FixtureServerHandle {
  origin: string;
  fixtureRoot: string;
  stop: () => Promise<void>;
}

async function waitForOrigin(origin: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/league`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("fixture server did not come up in time");
}

function fixtureEnv(fixtureRoot: string): Record<string, string> {
  return {
    identityDir: path.join(fixtureRoot, "identity"),
    artifactsRoot: path.join(fixtureRoot, "artifacts"),
    nationsDir: path.join(fixtureRoot, "nations"),
    featuredMatchStateRoot: path.join(fixtureRoot, "featured-match-state"),
    premiereStateRoot: path.join(fixtureRoot, "premiere-state"),
    platformStateRoot: path.join(fixtureRoot, "platform-state"),
  };
}

/** Starts a fixture-booted demo server (identity + league mirror only — no real match/premiere admission, matching the fixture command's default fast path) on `port`. Caller MUST call `stop()`. */
export async function startFixtureServer(
  port: number,
): Promise<FixtureServerHandle> {
  await fs.mkdir(EXTERNAL_SCRATCH_ROOT, { recursive: true });
  const fixtureRoot = await fs.mkdtemp(
    path.join(EXTERNAL_SCRATCH_ROOT, `e2e-${port}-`),
  );
  const paths = fixtureEnv(fixtureRoot);
  const leagueSiteDir = path.join(paths.artifactsRoot, "ai-league-runs", "league");
  await fs.mkdir(paths.identityDir, { recursive: true });
  await fs.mkdir(leagueSiteDir, { recursive: true });

  const upcomingPremiereFile = path.join(fixtureRoot, "premiere-upcoming.json");
  await fs.writeFile(
    upcomingPremiereFile,
    JSON.stringify({
      premiereId: "prem_fixture0upcoming01",
      roundNumber: 503,
      mapLabel: "World",
      scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      premierePageLive: false,
    }),
  );

  // Genuinely separate process — see this module's doc for why.
  await execFileAsync(
    "npx",
    [
      "tsx",
      "src/scripts/proxywar-fixture-league-data.ts",
      `--root=${fixtureRoot}`,
      `--premiere-upcoming-file=${upcomingPremiereFile}`,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PROXYWAR_IDENTITY_REGISTRY_DIR: paths.identityDir,
      },
    },
  );

  const origin = `http://127.0.0.1:${port}`;
  const serverProcess: ChildProcess = spawn(
    "npx",
    ["tsx", "src/scripts/ai-agent-demo-server.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PROXYWAR_LEAGUE_WRAPPER_ONLY: "true",
        PROXYWAR_ARTIFACTS_ROOT: paths.artifactsRoot,
        PROXYWAR_IDENTITY_REGISTRY_DIR: paths.identityDir,
        PROXYWAR_NATIONS_DIR: paths.nationsDir,
        PROXYWAR_FEATURED_MATCH_STATE_ROOT: paths.featuredMatchStateRoot,
        PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: paths.premiereStateRoot,
        PROXYWAR_PLATFORM_STATE_ROOT: paths.platformStateRoot,
        AI_LEAGUE_RENDERER_PORT: String(port + 10_000),
        GAME_ENV: "dev",
        PORT: String(port),
        AI_LEAGUE_DEMO_PORT: String(port),
      },
      stdio: "ignore",
      detached: true,
    },
  );
  await waitForOrigin(origin, 45_000);

  return {
    origin,
    fixtureRoot,
    stop: async () => {
      if (serverProcess.pid !== undefined) {
        try {
          process.kill(-serverProcess.pid, "SIGKILL");
        } catch {
          serverProcess.kill("SIGKILL");
        }
      }
      await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {
        // best-effort cleanup
      });
    },
  };
}
