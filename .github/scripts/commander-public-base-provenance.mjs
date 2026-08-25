#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

export function buildCommanderPublicBaseProvenance({
  sourceSha,
  sourceTreeSha,
  sourceArchiveSha256,
}) {
  if (
    !SHA1.test(sourceSha) ||
    !SHA1.test(sourceTreeSha) ||
    !SHA256.test(sourceArchiveSha256)
  ) {
    throw new Error("Commander public-base provenance input is invalid");
  }
  const body = {
    schemaVersion: 1,
    authority: "clean-exact-git-archive-public-base-v1",
    repository: "0xNad/ProxyWar",
    workflowPath: ".github/workflows/commander-public-base.yml",
    sourceSha,
    sourceTreeSha,
    behaviorSourceSha: sourceSha,
    behaviorSourceTreeSha: sourceTreeSha,
    adapterSourceSha: sourceSha,
    adapterSourceTreeSha: sourceTreeSha,
    sourceArchiveSha256,
    platform: "linux/amd64",
  };
  return {
    ...body,
    provenanceSha256: hash(JSON.stringify(canonical(body))),
  };
}

async function main() {
  const [sourceSha, sourceTreeSha, sourceArchiveSha256, output] =
    process.argv.slice(2);
  if (process.argv.length !== 6 || !output) {
    throw new Error(
      "usage: commander-public-base-provenance.mjs <source-sha> <source-tree-sha> <archive-sha256> <output>",
    );
  }
  const provenance = buildCommanderPublicBaseProvenance({
    sourceSha,
    sourceTreeSha,
    sourceArchiveSha256,
  });
  fs.writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify(provenance)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
