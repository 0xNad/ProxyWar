/**
 * `npm run verify:league-client` — end-to-end, two-directional proof that
 * the league client build excludes every wagering surface and that the
 * proof itself has not rotted (operator boundary 2026-07-27).
 *
 * Runs two real production `vite build`s over the same tree:
 *
 *   1. LEAGUE build (PROXYWAR_LEAGUE_CLIENT=1) — the emitted assets MUST
 *      NOT contain the wagering build sentinel anywhere (else wagering
 *      leaked into the league bundle). The league build additionally
 *      hard-fails on its own if any wagering module is loaded at all
 *      (vite.config.ts guard).
 *   2. NORMAL build (PROXYWAR_LEAGUE_CLIENT stripped from the env), LAST —
 *      the emitted assets MUST contain the sentinel (else the sentinel
 *      rotted and the league scan above was vacuous).
 *
 * The order is deliberate and load-bearing, not cosmetic: each vite build
 * empties and rewrites `static/`, and this repo pattern runs in checkouts
 * that also SERVE (the live beta serves from a worktree). Ending on the
 * NORMAL build means the script always exits with `static/` holding the
 * ordinary, servable bundle — its own final check asserts the sentinel is
 * PRESENT in what it leaves behind — so a serving host that ran this can
 * never be left serving league assets on a betting origin. Enforcement is
 * order-independent; the trailing filesystem state is why NORMAL is last.
 * (Building the league bundle to a separate outDir instead is NOT viable:
 * syncHashedPublicAssets hardcodes `static/` in vite.config.ts.)
 *
 * Prints both bundles' sizes so the league shrink stays visible. Called
 * from coworld-adapter's `build:image` chain before the docker build; the
 * absent-scan also re-runs INSIDE the image (Dockerfile.coworld) against
 * the exact assets the package ships (the in-image build-prod rebuilds
 * league-mode static/ there regardless of what this script left behind).
 *
 * Fails fast on the first broken step; exit 0 means both directions held
 * AND static/ holds a normal bundle with the sentinel present.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  defaultRepoRoot,
  readSentinelFromSource,
  scanForSentinel,
} from "./scan-wagering-sentinel.mjs";

const repoRoot = defaultRepoRoot();
const staticDir = path.join(repoRoot, "static");

/**
 * vite's package `exports` map does not expose `./bin/vite.js` to
 * `require.resolve`, so resolve the package root (its exported
 * `package.json`) and join the bin path on the filesystem instead.
 */
function resolveViteBin() {
  let packageJsonPath;
  try {
    packageJsonPath = createRequire(import.meta.url).resolve(
      "vite/package.json",
      { paths: [repoRoot] },
    );
  } catch {
    packageJsonPath = path.join(
      repoRoot,
      "node_modules",
      "vite",
      "package.json",
    );
  }
  const bin = path.join(path.dirname(packageJsonPath), "bin", "vite.js");
  if (!fs.existsSync(bin)) {
    throw new Error(
      `could not locate vite's CLI at ${bin} — run npm run inst first`,
    );
  }
  return bin;
}

const viteBin = resolveViteBin();

function runViteBuild(label, leagueClient) {
  const env = { ...process.env };
  delete env.PROXYWAR_LEAGUE_CLIENT;
  if (leagueClient) env.PROXYWAR_LEAGUE_CLIENT = "1";
  console.log(`[verify:league-client] building ${label} client bundle...`);
  const result = spawnSync(process.execPath, [viteBin, "build"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    console.error(
      `[verify:league-client] FAIL: ${label} vite build exited with ` +
        `${result.status ?? `signal ${result.signal}`}`,
    );
    process.exit(1);
  }
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

const sentinel = readSentinelFromSource(repoRoot);

// LEAGUE first — see the module doc: NORMAL must run LAST so the script
// always exits with static/ holding the ordinary servable bundle.
runViteBuild("LEAGUE", true);
const league = scanForSentinel(staticDir, sentinel);
if (league.hits.length > 0) {
  console.error(
    `[verify:league-client] FAIL: the LEAGUE build contains the wagering ` +
      `sentinel in:\n  ${league.hits.join("\n  ")}\n` +
      `A wagering module leaked into the league client bundle. Fix the ` +
      `stub map (src/client/prediction/leagueStubs/stubMap.ts) — never ` +
      `ship betting surfaces in the league package.`,
  );
  process.exit(1);
}
console.log(
  `[verify:league-client] LEAGUE build OK: sentinel absent — ` +
    `${league.files} files, ${formatMiB(league.totalBytes)} total, ` +
    `${formatKiB(league.jsBytes)} JS.`,
);

runViteBuild("NORMAL", false);
// Final check, on the exact assets this script leaves behind in static/:
// the NORMAL bundle must carry the sentinel. This both proves the sentinel
// has not rotted (the league absent-scan above was not vacuous) and proves
// the trailing filesystem state is the ordinary servable bundle, never the
// league one.
const normal = scanForSentinel(staticDir, sentinel);
if (normal.hits.length === 0) {
  console.error(
    `[verify:league-client] FAIL: the NORMAL build does not contain the ` +
      `wagering sentinel in any emitted asset. The sentinel rotted out of ` +
      `the bundled graph (see src/client/prediction/wagering/` +
      `buildSentinel.ts) — the league absent-scan above was vacuous, so ` +
      `this is a hard failure. static/ holds this sentinel-less normal ` +
      `build; do not serve until the sentinel wiring is fixed and ` +
      `verified.`,
  );
  process.exit(1);
}
console.log(
  `[verify:league-client] NORMAL build OK: sentinel present in ` +
    `${normal.hits.join(", ")} — ${normal.files} files, ` +
    `${formatMiB(normal.totalBytes)} total, ${formatKiB(normal.jsBytes)} JS.`,
);
console.log(
  `[verify:league-client] PASS. JS bundle: normal ${formatKiB(
    normal.jsBytes,
  )} -> league ${formatKiB(league.jsBytes)} ` +
    `(${formatKiB(normal.jsBytes - league.jsBytes)} smaller); total assets: ` +
    `${formatMiB(normal.totalBytes)} -> ${formatMiB(league.totalBytes)}. ` +
    `static/ now holds the NORMAL build (sentinel present — safe for ` +
    `serving checkouts).`,
);
