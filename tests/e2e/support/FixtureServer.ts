/**
 * Boots a real `ai-agent-demo-server.ts` process against the Stage 8
 * public-product fixture data, under a fresh `os.tmpdir()`-rooted
 * `mkdtemp()` directory per boot (same portable pattern every other
 * fixture-scratch test in this repo already uses. Previously hardcoded to a fixed
 * external-volume path (`/Volumes/ProxyWar Workspace/...`) to keep a
 * since-retired local 25 GiB internal-disk floor policy satisfied during
 * one prior development session — that path doesn't exist on Linux CI
 * runners (no `/Volumes` mount point at all) or on any other operator's
 * machine, so every test that boots through this file always failed with
 * `EACCES: permission denied, mkdir '/Volumes'` there. The CI job simply
 * never ran long enough, before this repo's Test job was sharded, to
 * surface that as a visible failure instead of a timeout cancellation.
 * `os.tmpdir()` scratch dirs are tiny and always cleaned up via `stop()`
 * below, so the original disk-floor concern doesn't apply here anyway.
 * Shared by the E2E suite and (in spirit — that suite inlines its own
 * minimal variant for speed) the security suite.
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
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, "../../..");

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

// Graceful-then-forced shutdown of a real child process; the bounded wait
// is a real-clock grace period for SIGTERM, not something fakeable (same
// pattern as `tests/server/PlatformRootPage.test.ts`'s `stopServer`). A
// fire-and-forget kill that returns before the OS actually reclaims the
// process is exactly what made `tests/server/analytics/
// AnalyticsServerIntegration.test.ts` order-dependent under load before
// its own 2026-08 hardening — this mirrors that fix here.
async function stopServer(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

// `resources/season/` (tracked, real, committed operational data — see
// `SeasonRegistry.ts`'s doc) has no per-fixture override here without
// `seasonRegistryDir`/`PROXYWAR_SEASON_REGISTRY_DIR` below: every OTHER
// stateful subsystem (identity/artifacts/nations/featured-match/premiere/
// platform) already gets one, but Season shipped after this file did and
// was never wired in — so a fixture-booted server silently fell through
// to the real tracked `resources/season/seasons.json`, rendering a
// `/watch` card for whatever real match is currently featured in
// production with none of that match's real artifacts present in the
// isolated fixture root, producing a live 404 on the card's own link.
function fixtureEnv(fixtureRoot: string): Record<string, string> {
  return {
    identityDir: path.join(fixtureRoot, "identity"),
    artifactsRoot: path.join(fixtureRoot, "artifacts"),
    nationsDir: path.join(fixtureRoot, "nations"),
    featuredMatchStateRoot: path.join(fixtureRoot, "featured-match-state"),
    premiereStateRoot: path.join(fixtureRoot, "premiere-state"),
    platformStateRoot: path.join(fixtureRoot, "platform-state"),
    seasonRegistryDir: path.join(fixtureRoot, "season"),
  };
}

/** Starts a fixture-booted demo server (identity + league mirror only — no real match/premiere admission, matching the fixture command's default fast path) on `port`. Caller MUST call `stop()`. */
export async function startFixtureServer(
  port: number,
): Promise<FixtureServerHandle> {
  const fixtureRoot = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), `e2e-${port}-`),
  );
  let serverProcess: ChildProcess | null = null;
  try {
    const paths = fixtureEnv(fixtureRoot);
    const leagueSiteDir = path.join(
      paths.artifactsRoot,
      "ai-league-runs",
      "league",
    );
    await fs.mkdir(paths.identityDir, { recursive: true });
    await fs.mkdir(leagueSiteDir, { recursive: true });

    const upcomingPremiereFile = path.join(
      fixtureRoot,
      "premiere-upcoming.json",
    );
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
          PROXYWAR_SEASON_REGISTRY_DIR: paths.seasonRegistryDir,
        },
      },
    );

    const origin = `http://127.0.0.1:${port}`;
    serverProcess = spawn(
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
          PROXYWAR_LEAGUE_WRAPPER_ONLY: "true",
          PROXYWAR_ARTIFACTS_ROOT: paths.artifactsRoot,
          PROXYWAR_IDENTITY_REGISTRY_DIR: paths.identityDir,
          PROXYWAR_NATIONS_DIR: paths.nationsDir,
          PROXYWAR_FEATURED_MATCH_STATE_ROOT: paths.featuredMatchStateRoot,
          PROXYWAR_REPLAY_PREMIERE_STATE_ROOT: paths.premiereStateRoot,
          PROXYWAR_PLATFORM_STATE_ROOT: paths.platformStateRoot,
          PROXYWAR_SEASON_REGISTRY_DIR: paths.seasonRegistryDir,
          AI_LEAGUE_RENDERER_PORT: String(port + 10_000),
          GAME_ENV: "dev",
          PORT: String(port),
          AI_LEAGUE_DEMO_PORT: String(port),
        },
        stdio: "ignore",
      },
    );
    await waitForOrigin(origin, 45_000);

    const readyServerProcess = serverProcess;
    return {
      origin,
      fixtureRoot,
      stop: async () => {
        await stopServer(readyServerProcess);
        await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {
          // best-effort cleanup
        });
      },
    };
  } catch (error) {
    // Nothing here left a caller holding a `FixtureServerHandle` to call
    // `stop()` on — clean up everything this call itself started before
    // rethrowing, or a failed boot leaks its scratch directory (and any
    // spawned server) forever. Exactly the accumulation this whole file's
    // 2026-08 hardening pass found: dozens of `e2e-live-*` directories on
    // the external scratch volume, one per failed boot with no cleanup
    // path at all.
    await stopServer(serverProcess);
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup
    });
    throw error;
  }
}

/**
 * Boots a fixture server WITH live-premiere admission (active/late-join/
 * no-seek/reveal E2E coverage) by shelling out to the exact bash
 * orchestrator `npm run fixtures:public-product` itself uses
 * (`FIXTURE_ADMIT_LIVE_PREMIERE=1`) — reusing the validated pipeline
 * rather than re-implementing drama-match/exhibition-match/admission/
 * mirror-regeneration logic a second time in TypeScript. Slow (~1 minute:
 * a real deterministic 2-seat match generation + admission) and requires
 * a CLEAN git checkout (the exhibition's build-provenance check — see
 * `replay-premiere-controlled-exhibition.ts`'s
 * `resolveControlledExhibitionBuildProvenance`) — both real constraints
 * of the underlying admission pipeline, not something this helper adds.
 * Callers needing the fast, no-live-premiere fixture MUST use
 * `startFixtureServer` instead; do not add this to the main suite's
 * `beforeAll`.
 */

/**
 * Fails fast, with a self-explanatory message, when the live-premiere
 * build-provenance gate (`resolveControlledExhibitionBuildProvenance` in
 * `replay-premiere-controlled-exhibition.ts`) would reject the current
 * tree. `git status`/`diff` take well under a second; the exhibition
 * pipeline this guards takes ~1 minute, so checking up front avoids
 * burning that minute only to fail with an opaque "Command failed: bash
 * scripts/fixtures/run-public-product-fixtures.sh" from deep inside the
 * shelled-out script. Set `PROXYWAR_E2E_SKIP_PROVENANCE_BLOCK=1` to skip
 * this whole block instead — that's handled at the test-file level via
 * `describe.skipIf`, upstream of this function ever running.
 */
async function assertCleanCheckoutForLivePremiereGate(): Promise<void> {
  const [status, diff] = await Promise.all([
    execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: REPO_ROOT },
    ),
    execFileAsync("git", ["diff", "--name-only", "HEAD", "--"], {
      cwd: REPO_ROOT,
    }),
  ]);
  const dirtyFiles = status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (dirtyFiles.length === 0 && diff.stdout.trim() === "") return;
  throw new Error(
    [
      "live-premiere build-provenance gate: this block admits a real replay through `resolveControlledExhibitionBuildProvenance`, which requires an exact committed git build and refuses to run against a dirty tree.",
      `dirty files (${dirtyFiles.length}):`,
      ...dirtyFiles.map((line) => `  ${line}`),
      "commit or stash to run this block, or set PROXYWAR_E2E_SKIP_PROVENANCE_BLOCK=1 to skip it for a local dirty-tree run (CI/clean runs are unaffected).",
    ].join("\n"),
  );
}

/** Stops the process recorded in `pidFile` (if any) and removes the
 * pidfile either way — same kill discipline as
 * `scripts/fixtures/run-public-product-fixtures.sh`'s own `stop_origin`. */
async function stopByPidFile(pidFile: string): Promise<void> {
  try {
    const pid = Number((await fs.readFile(pidFile, "utf8")).trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    // no pidfile / already gone
  }
  await fs.rm(pidFile, { force: true }).catch(() => {
    // best-effort cleanup
  });
}

export async function startFixtureServerWithLivePremiere(
  port: number,
): Promise<FixtureServerHandle> {
  await assertCleanCheckoutForLivePremiereGate();
  const fixtureRoot = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), `e2e-live-${port}-`),
  );
  const origin = `http://127.0.0.1:${port}`;
  const pidFile = `/tmp/pw-fixture-origin-${port}.pid`;
  try {
    await execFileAsync(
      "bash",
      ["scripts/fixtures/run-public-product-fixtures.sh"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          FIXTURE_ROOT: fixtureRoot,
          FIXTURE_PORT: String(port),
          FIXTURE_ADMIT_LIVE_PREMIERE: "1",
        },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    await waitForOrigin(origin, 15_000);
    return {
      origin,
      fixtureRoot,
      stop: async () => {
        await stopByPidFile(pidFile);
        await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {
          // best-effort cleanup
        });
      },
    };
  } catch (error) {
    // Same rationale as `startFixtureServer`'s catch above: the shell
    // script starts the real origin process BEFORE the exhibition-
    // admission steps that can still fail, and a throw here leaves the
    // caller with no `FixtureServerHandle` to ever call `stop()` on —
    // clean up here (both the pidfile's process and the scratch
    // directory) or leak them on every failed boot. This is exactly what
    // left dozens of stale `pw-fixture-origin-*.pid` files and matching
    // `e2e-live-*` scratch directories behind (see `scripts/fixtures/
    // clean.sh`, added alongside this fix).
    await stopByPidFile(pidFile);
    await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {
      // best-effort cleanup
    });
    throw error;
  }
}
