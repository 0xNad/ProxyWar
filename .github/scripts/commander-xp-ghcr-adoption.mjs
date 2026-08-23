#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function inspectSinglePlatformManifest({
  tag,
  expectedConfigDigest,
  rawBytes,
}) {
  if (
    !/^ghcr\.io\/0xnad\/proxywar-commander-xp-(?:policy|game):[0-9a-f]{40}$/.test(
      tag,
    ) ||
    !/^sha256:[0-9a-f]{64}$/.test(expectedConfigDigest) ||
    !Buffer.isBuffer(rawBytes) ||
    rawBytes.length === 0
  ) {
    throw new Error("Commander XP GHCR adoption input is invalid");
  }
  let manifest;
  try {
    manifest = JSON.parse(rawBytes.toString("utf8"));
  } catch {
    throw new Error("Commander XP GHCR manifest is not JSON");
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schemaVersion !== 2 ||
    typeof manifest.mediaType !== "string" ||
    manifest.mediaType.includes("index") ||
    manifest.mediaType.includes("manifest.list") ||
    manifest.config === null ||
    typeof manifest.config !== "object" ||
    Array.isArray(manifest.config) ||
    manifest.config.digest !== expectedConfigDigest ||
    !Array.isArray(manifest.layers)
  ) {
    throw new Error("Commander XP GHCR manifest identity mismatch");
  }
  return {
    schemaVersion: 1,
    authority: "ghcr-single-platform-config-adoption-v1",
    tag,
    configDigest: expectedConfigDigest,
    manifestDigest: `sha256:${sha256(rawBytes)}`,
    manifestBytes: rawBytes.length,
    manifestSha256: sha256(rawBytes),
  };
}

const [command, tag, expectedConfigDigest, rawPath] = process.argv.slice(2);
if (command === "inspect") {
  const result = inspectSinglePlatformManifest({
    tag,
    expectedConfigDigest,
    rawBytes: fs.readFileSync(rawPath),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  throw new Error("Commander XP GHCR adoption command is invalid");
}
