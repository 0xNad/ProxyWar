#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const INSPECT_ERROR_MAX_BYTES = 64 * 1024;

export function classifyManifestInspection({ tag, status, stderrBytes }) {
  if (
    !/^ghcr\.io\/0xnad\/proxywar-commander-(?:xp-(?:policy|game)|public-base):[0-9a-f]{40}$/.test(
      tag,
    ) ||
    !Number.isSafeInteger(status) ||
    status < 0 ||
    status > 255 ||
    !Buffer.isBuffer(stderrBytes) ||
    stderrBytes.length > INSPECT_ERROR_MAX_BYTES
  ) {
    throw new Error("Commander XP GHCR inspection result is invalid");
  }
  if (status === 0) return "available";

  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const message = stderrBytes.toString("utf8").trim();
  const confirmedNotFound = new RegExp(
    `^(?:ERROR:\\s*)?(?:failed to solve:\\s*)?${escapedTag}: (?:not found|manifest unknown)$`,
    "i",
  );
  if (confirmedNotFound.test(message)) return "not-found";
  throw new Error("Commander XP GHCR inspection failure is indeterminate");
}

export function inspectSinglePlatformManifest({
  tag,
  expectedConfigDigest,
  rawBytes,
}) {
  const discovered = discoverSinglePlatformManifest({ tag, rawBytes });
  if (
    !/^sha256:[0-9a-f]{64}$/.test(expectedConfigDigest) ||
    discovered.configDigest !== expectedConfigDigest
  ) {
    throw new Error("Commander XP GHCR manifest identity mismatch");
  }
  return discovered;
}

export function discoverSinglePlatformManifest({ tag, rawBytes }) {
  if (
    !/^ghcr\.io\/0xnad\/proxywar-commander-(?:xp-(?:policy|game)|public-base):[0-9a-f]{40}$/.test(
      tag,
    ) ||
    !Buffer.isBuffer(rawBytes) ||
    rawBytes.length === 0 ||
    rawBytes.length > 1024 * 1024
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
    !/^sha256:[0-9a-f]{64}$/.test(manifest.config.digest) ||
    !Array.isArray(manifest.layers)
  ) {
    throw new Error("Commander XP GHCR manifest identity mismatch");
  }
  return {
    schemaVersion: 1,
    authority: "ghcr-single-platform-config-adoption-v1",
    tag,
    configDigest: manifest.config.digest,
    manifestDigest: `sha256:${sha256(rawBytes)}`,
    manifestBytes: rawBytes.length,
    manifestSha256: sha256(rawBytes),
  };
}

const [command, tag, digestOrPath, rawPath] = process.argv.slice(2);
if (command === "inspect") {
  const result = inspectSinglePlatformManifest({
    tag,
    expectedConfigDigest: digestOrPath,
    rawBytes: fs.readFileSync(rawPath),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (command === "discover") {
  if (rawPath !== undefined) {
    throw new Error("Commander XP GHCR discovery command is invalid");
  }
  const result = discoverSinglePlatformManifest({
    tag,
    rawBytes: fs.readFileSync(digestOrPath),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (command === "classify-inspect") {
  if (!/^(?:0|[1-9][0-9]{0,2})$/.test(digestOrPath ?? "") || !rawPath) {
    throw new Error("Commander XP GHCR inspection command is invalid");
  }
  const result = classifyManifestInspection({
    tag,
    status: Number(digestOrPath),
    stderrBytes: fs.readFileSync(rawPath),
  });
  process.stdout.write(`${result}\n`);
} else if (import.meta.url === `file://${process.argv[1]}`) {
  throw new Error("Commander XP GHCR adoption command is invalid");
}
