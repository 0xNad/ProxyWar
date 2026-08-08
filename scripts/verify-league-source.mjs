import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const self = path.relative(repoRoot, scriptPath);

const files = listSourceFiles()
  .filter((file) => file !== self)
  .filter((file) => file !== "proprietary" && !file.startsWith("proprietary/"))
  .filter((file) => fs.existsSync(path.join(repoRoot, file)));

function listSourceFiles() {
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (path.resolve(gitRoot) !== repoRoot) {
      throw new Error("source copy is nested under a different Git checkout");
    }
    return execFileSync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .split("\0")
      .filter(Boolean);
  } catch {
    const ignoredDirectories = new Set([
      ".git",
      ".docker-context",
      "artifacts",
      "build",
      "coverage",
      "dist",
      "logs",
      "node_modules",
      "proprietary",
      "static",
      "tmp",
    ]);
    const discovered = [];
    const visit = (relativeDirectory) => {
      const absoluteDirectory = path.join(repoRoot, relativeDirectory);
      for (const entry of fs.readdirSync(absoluteDirectory, {
        withFileTypes: true,
      })) {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
        const relativePath = path.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) visit(relativePath);
        else if (entry.isFile()) discovered.push(relativePath);
      }
    };
    visit("");
    return discovered;
  }
}

const forbiddenPaths = [
  /^src\/client\/prediction\//,
  /^src\/prediction\//,
  /^src\/scripts\/premiere-wagering\//,
  /^src\/server\/replay-premiere\/(?:wagering|points)\//,
  /^tests\/client\/prediction\/wagering\//,
  /^tests\/prediction\//,
  /^tests\/scripts\/premiere-wagering\//,
  /^tests\/server\/replay-premiere\/(?:wagering|points)\//,
  /(?:^|\/)(?:Betting|Wagering)[^/]*\.(?:ts|js|mjs|md)$/,
  /(?:^|\/)TraderProfilePage\.ts$/,
  /^(?:auto)?cycle-premiere\.sh$/,
  /^(?:generate-)?premiere-queue(?:-lib)?\.sh$/,
];

const forbiddenText = [
  /\bspeculation\b/i,
  /\bbet surface\b/i,
  /bet\.proxywar\.xyz/i,
  /\bbetting\b/i,
  /\bwager(?:s|ed|ing)?\b/i,
  /\bLMSR\b/,
  /synthetic crowd/i,
  /\/bet(?:\/|\b)/i,
  /\/trader(?:\/|\b)/i,
  /PROXYWAR_(?:WAGERING|MARKET)/i,
  /PW_BET_/i,
  /premiere-wagering/i,
  /prediction\/wagering/i,
  /ReplayPremiereMarket/,
  /TraderProfile/,
];

const assetPattern =
  /\.(?:avif|gif|ico|jpe?g|mp3|mp4|ogg|pdf|png|webp|woff2?)$/i;
const failures = [];

for (const file of files) {
  if (forbiddenPaths.some((pattern) => pattern.test(file))) {
    failures.push(`${file}: paused-product path remains`);
    continue;
  }
  if (assetPattern.test(file) || file.startsWith("resources/flags/")) continue;
  const bytes = fs.readFileSync(path.join(repoRoot, file));
  if (bytes.includes(0)) continue;
  const lines = bytes.toString("utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (forbiddenText.some((pattern) => pattern.test(lines[index]))) {
      failures.push(
        `${file}:${index + 1}: ${lines[index].trim().slice(0, 180)}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("League source still contains paused-product paths or text:");
  for (const failure of failures.slice(0, 80)) console.error(`- ${failure}`);
  if (failures.length > 80) {
    console.error(`- ... ${failures.length - 80} additional findings`);
  }
  process.exitCode = 1;
} else {
  console.log(`League source guard passed (${files.length} files scanned).`);
}
