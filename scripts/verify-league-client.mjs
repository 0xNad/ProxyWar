/**
 * `npm run verify:league-client` — end-to-end, two-directional proof that
 * the league client build excludes every wagering surface and that the
 * proof itself has not rotted (operator boundary 2026-07-27).
 *
 * Runs two real production `vite build`s over the same tree:
 *
 *   1. NORMAL build (PROXYWAR_LEAGUE_CLIENT stripped from the env) —
 *      the emitted assets MUST contain the wagering build sentinel
 *      (else the sentinel rotted and the league scan would be vacuous);
 *   2. LEAGUE build (PROXYWAR_LEAGUE_CLIENT=1) — the emitted assets MUST
 *      NOT contain it anywhere (else wagering leaked into the league
 *      bundle). The league build additionally hard-fails on its own if
 *      any wagering module is loaded at all (vite.config.ts guard).
 *
 * Prints both bundles' sizes so the league shrink stays visible. Called
 * from coworld-adapter's `build:image` chain before the docker build; the
 * absent-scan also re-runs INSIDE the image (Dockerfile.coworld) against
 * the exact assets the package ships. Leaves `static/` holding the league
 * build output (each vite build empties and rewrites it).
 *
 * Fails fast on the first broken step; exit 0 means both directions held.
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

runViteBuild("NORMAL", false);
const normal = scanForSentinel(staticDir, sentinel);
if (normal.hits.length === 0) {
  console.error(
    `[verify:league-client] FAIL: the NORMAL build does not contain the ` +
      `wagering sentinel in any emitted asset. The sentinel rotted out of ` +
      `the bundled graph (see src/client/prediction/wagering/` +
      `buildSentinel.ts) — the league absent-scan below would be vacuous, ` +
      `so this is a hard failure.`,
  );
  process.exit(1);
}
console.log(
  `[verify:league-client] NORMAL build OK: sentinel present in ` +
    `${normal.hits.join(", ")} — ${normal.files} files, ` +
    `${formatMiB(normal.totalBytes)} total, ${formatKiB(normal.jsBytes)} JS.`,
);

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
console.log(
  `[verify:league-client] PASS. JS bundle: normal ${formatKiB(
    normal.jsBytes,
  )} -> league ${formatKiB(league.jsBytes)} ` +
    `(${formatKiB(normal.jsBytes - league.jsBytes)} smaller); total assets: ` +
    `${formatMiB(normal.totalBytes)} -> ${formatMiB(league.totalBytes)}. ` +
    `static/ now holds the LEAGUE build.`,
);
