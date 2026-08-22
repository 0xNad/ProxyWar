import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILES,
  NEW_FILES,
  PUBLIC_BASE,
  parseOwnerUpgradeLedger,
} from "./owner-upgrade-contract.mjs";
const packetRoot = path.dirname(fileURLToPath(import.meta.url));
const patchPath = path.join(packetRoot, "proxywar-owner-upgrade.patch");
const ledgerPath = path.join(packetRoot, "SHA256SUMS");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}${result.stderr}`,
    );
  }
  // Keep porcelain status's leading XY columns; only terminal newlines are
  // insignificant. A full trim would remove the first path's status column.
  return result.stdout.trimEnd();
}

function runBytes(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout.toString("utf8")}${result.stderr.toString("utf8")}`,
    );
  }
  return result.stdout;
}

async function sha256(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const starter = path.resolve(process.argv[2] ?? "");
  const platformSource = path.resolve(process.argv[3] ?? "");
  if (process.argv.length !== 4) {
    throw new Error(
      "usage: node verify-owner-upgrade.mjs /absolute/path/to/fresh-public-starter /absolute/path/to/platform-source",
    );
  }
  if (run("git", ["rev-parse", "HEAD"], starter) !== PUBLIC_BASE) {
    throw new Error(`starter HEAD must be exact public base ${PUBLIC_BASE}`);
  }
  if (run("git", ["status", "--porcelain"], starter) !== "") {
    throw new Error("starter checkout must be clean before patch application");
  }

  const {
    baseEntries,
    candidateSource,
    candidateTree,
    expectedEntries,
    patchDigest,
    sourceBlobs,
  } = parseOwnerUpgradeLedger(await readFile(ledgerPath, "utf8"));
  if ((await sha256(patchPath)) !== patchDigest) {
    throw new Error("owner patch SHA-256 does not match sealed ledger");
  }
  for (const [file, digest] of baseEntries) {
    if ((await sha256(path.join(starter, file))) !== digest) {
      throw new Error(`public base hash mismatch for ${file}`);
    }
  }
  run("git", ["cat-file", "-e", `${candidateSource}^{commit}`], platformSource);
  if (
    run("git", ["rev-parse", `${candidateSource}^{tree}`], platformSource) !==
    candidateTree
  ) {
    throw new Error("candidate source tree mismatch");
  }
  for (const file of FILES) {
    const object = `${candidateSource}:coworld-adapter/tester-starter-llm/${file}`;
    if (
      run("git", ["rev-parse", object], platformSource) !==
      sourceBlobs.get(file)
    ) {
      throw new Error(`candidate source blob mismatch for ${file}`);
    }
    if (
      sha256Bytes(runBytes("git", ["show", object], platformSource)) !==
      expectedEntries.get(file)
    ) {
      throw new Error(`candidate source content mismatch for ${file}`);
    }
  }
  for (const file of NEW_FILES) {
    try {
      await stat(path.join(starter, file));
      throw new Error(`public base unexpectedly already contains ${file}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  run("git", ["apply", "--check", patchPath], starter);
  run("git", ["apply", patchPath], starter);
  const changedFiles = run("git", ["status", "--porcelain", "-uall"], starter)
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .sort();
  if (JSON.stringify(changedFiles) !== JSON.stringify(FILES)) {
    throw new Error(
      `after-apply file set mismatch: ${JSON.stringify(changedFiles)}`,
    );
  }
  for (const [file, digest] of expectedEntries) {
    if ((await sha256(path.join(starter, file))) !== digest) {
      throw new Error(`after-apply hash mismatch for ${file}`);
    }
  }
  run("npm", ["install", "--ignore-scripts", "--package-lock=false"], starter);
  run("npm", ["test"], starter);
  run("node", ["--check", "llm-player.mjs"], starter);
  run("node", ["--check", "starter-player.mjs"], starter);
  run("node", ["--check", "owner-capabilities.mjs"], starter);
  run("node", ["--check", "owner-evidence-check.mjs"], starter);
  process.stdout.write(
    `${JSON.stringify({ verdict: "PASS", publicBase: PUBLIC_BASE, candidateSource, candidateTree, patchSHA256: patchDigest, verifiedFiles: expectedEntries.size })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
