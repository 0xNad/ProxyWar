/**
 * Wagering build-sentinel scanner — the mechanical half of the league
 * betting exclusion (operator boundary 2026-07-27: speculation lives only
 * on the separate bet surface, never inside the league package).
 *
 * The REAL wagering client graph carries a unique literal
 * (`src/client/prediction/wagering/buildSentinel.ts`) that minification
 * cannot strip. This script walks every emitted build asset and enforces
 * one of two expectations:
 *
 *   --expect present   a NORMAL client build must contain the sentinel in
 *                      at least one asset (proves the sentinel has not
 *                      rotted out of the graph — the absent-scan can never
 *                      pass vacuously);
 *   --expect absent    a LEAGUE client build (PROXYWAR_LEAGUE_CLIENT=1)
 *                      must contain it nowhere (proves no wagering module
 *                      reached the league bundle).
 *
 * The needle is parsed from the sentinel module's SOURCE at runtime, so
 * this script can never drift from the literal it is supposed to police:
 * change the literal in one place and both directions keep working;
 * delete the module and this script fails closed instead of passing an
 * empty scan.
 *
 * Wired into:
 *  - `npm run verify:league-client` (scripts/verify-league-client.mjs) —
 *    both directions, host-side, called from coworld-adapter's
 *    `build:image` chain;
 *  - `coworld-adapter/Dockerfile.coworld` — the absent-scan re-runs inside
 *    the image build against the exact static/ assets the league package
 *    ships, so every future image is checked even if invoked without the
 *    npm chain.
 *
 * Usage: node scripts/scan-wagering-sentinel.mjs --expect present|absent
 *          [--dir static] [--repo-root <path>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SENTINEL_SOURCE_RELPATH = path.join(
  "src",
  "client",
  "prediction",
  "wagering",
  "buildSentinel.ts",
);

export function defaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * Parse the sentinel literal out of the real module's source. Fails closed:
 * a missing module or an unparseable export is an error, never an empty
 * needle.
 */
export function readSentinelFromSource(repoRoot) {
  const sourcePath = path.join(repoRoot, SENTINEL_SOURCE_RELPATH);
  const source = fs.readFileSync(sourcePath, "utf8");
  const match = source.match(
    /export const WAGERING_BUILD_SENTINEL\s*=\s*"([^"]+)"/,
  );
  if (match === null || match[1].length < 16) {
    throw new Error(
      `could not parse WAGERING_BUILD_SENTINEL from ${sourcePath} — the ` +
        `sentinel module rotted; the wagering-exclusion proof is broken.`,
    );
  }
  return match[1];
}

/** Every regular file under dir, recursively, as absolute paths (sorted). */
export function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out.sort();
}

/**
 * Scan every file under `dir` for the sentinel bytes. Returns
 * `{ files, totalBytes, jsBytes, hits }` where `hits` is the list of
 * relative paths containing the sentinel.
 */
export function scanForSentinel(dir, sentinel) {
  const needle = Buffer.from(sentinel, "utf8");
  const files = walkFiles(dir);
  let totalBytes = 0;
  let jsBytes = 0;
  const hits = [];
  for (const file of files) {
    const buffer = fs.readFileSync(file);
    totalBytes += buffer.length;
    if (file.endsWith(".js") || file.endsWith(".mjs")) jsBytes += buffer.length;
    if (buffer.includes(needle)) hits.push(path.relative(dir, file));
  }
  return { files: files.length, totalBytes, jsBytes, hits };
}

function parseArgs(argv) {
  const args = { expect: null, dir: "static", repoRoot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--expect") args.expect = argv[++i];
    else if (arg === "--dir") args.dir = argv[++i];
    else if (arg === "--repo-root") args.repoRoot = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.expect !== "present" && args.expect !== "absent") {
    throw new Error("--expect must be 'present' or 'absent'");
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = args.repoRoot ?? defaultRepoRoot();
  const dir = path.resolve(repoRoot, args.dir);
  if (!fs.existsSync(dir)) {
    throw new Error(`scan dir does not exist: ${dir} (build first)`);
  }
  const sentinel = readSentinelFromSource(repoRoot);
  const result = scanForSentinel(dir, sentinel);
  const summary =
    `scanned ${result.files} files, ` +
    `${(result.totalBytes / 1024 / 1024).toFixed(2)} MiB total ` +
    `(${(result.jsBytes / 1024).toFixed(1)} KiB JS)`;
  if (args.expect === "absent" && result.hits.length > 0) {
    console.error(
      `[wagering-sentinel] FAIL: league build must not contain the wagering ` +
        `sentinel, but it appears in:\n  ${result.hits.join("\n  ")}\n` +
        `${summary}\nA wagering module leaked into the league client bundle.`,
    );
    process.exit(1);
  }
  if (args.expect === "present" && result.hits.length === 0) {
    console.error(
      `[wagering-sentinel] FAIL: normal build must contain the wagering ` +
        `sentinel and does not (${summary}). The sentinel rotted out of ` +
        `the bundled graph — the league absent-scan is now vacuous. See ` +
        `src/client/prediction/wagering/buildSentinel.ts.`,
    );
    process.exit(1);
  }
  console.log(
    `[wagering-sentinel] OK (${args.expect}): ${summary}` +
      (result.hits.length > 0 ? `; sentinel in ${result.hits.join(", ")}` : ""),
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
