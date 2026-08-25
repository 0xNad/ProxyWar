import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyManifestInspection,
  discoverSinglePlatformManifest,
  inspectSinglePlatformManifest,
} from "./commander-xp-ghcr-adoption.mjs";

const tag = `ghcr.io/0xnad/proxywar-commander-xp-policy:${"1".repeat(40)}`;
const configDigest = `sha256:${"2".repeat(64)}`;
const manifest = (digest = configDigest) =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest, mediaType: "application/vnd.oci.image.config.v1+json" },
      layers: [{ digest: `sha256:${"3".repeat(64)}` }],
    }),
  );

test("GHCR adoption binds the exact tag to its prebuilt image config", () => {
  const result = inspectSinglePlatformManifest({
    tag,
    expectedConfigDigest: configDigest,
    rawBytes: manifest(),
  });
  assert.equal(result.tag, tag);
  assert.equal(result.configDigest, configDigest);
  assert.match(result.manifestDigest, /^sha256:[0-9a-f]{64}$/);
});

test("GHCR adoption rejects a different image and a multi-platform index", () => {
  assert.throws(() =>
    inspectSinglePlatformManifest({
      tag,
      expectedConfigDigest: configDigest,
      rawBytes: manifest(`sha256:${"4".repeat(64)}`),
    }),
  );
  assert.throws(() =>
    inspectSinglePlatformManifest({
      tag,
      expectedConfigDigest: configDigest,
      rawBytes: Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: "application/vnd.oci.image.index.v1+json",
          manifests: [],
        }),
      ),
    }),
  );
});

test("GHCR adoption accepts the isolated public-base package", () => {
  const publicTag = `ghcr.io/0xnad/proxywar-commander-public-base:${"4".repeat(40)}`;
  const result = inspectSinglePlatformManifest({
    tag: publicTag,
    expectedConfigDigest: configDigest,
    rawBytes: manifest(),
  });
  assert.equal(result.tag, publicTag);
});

test("GHCR output-loss recovery discovers the remote config without rebuild equality", () => {
  const publicTag = `ghcr.io/0xnad/proxywar-commander-public-base:${"5".repeat(40)}`;
  const result = discoverSinglePlatformManifest({
    tag: publicTag,
    rawBytes: manifest(),
  });
  assert.equal(result.configDigest, configDigest);
  assert.match(result.manifestDigest, /^sha256:[0-9a-f]{64}$/);
  assert.throws(() =>
    discoverSinglePlatformManifest({
      tag: publicTag,
      rawBytes: Buffer.alloc(1024 * 1024 + 1),
    }),
  );
});

test("GHCR discovery accepts only an authenticated semantic not-found result", () => {
  const publicTag = `ghcr.io/0xnad/proxywar-commander-public-base:${"5".repeat(40)}`;
  assert.equal(
    classifyManifestInspection({
      tag: publicTag,
      status: 0,
      stderrBytes: Buffer.alloc(0),
    }),
    "available",
  );
  assert.equal(
    classifyManifestInspection({
      tag: publicTag,
      status: 1,
      stderrBytes: Buffer.from(`ERROR: ${publicTag}: not found\n`),
    }),
    "not-found",
  );
  assert.equal(
    classifyManifestInspection({
      tag: publicTag,
      status: 1,
      stderrBytes: Buffer.from(
        `ERROR: failed to solve: ${publicTag}: manifest unknown\n`,
      ),
    }),
    "not-found",
  );
});

test("GHCR discovery fails closed on auth, network, transient, and oversized failures", () => {
  const publicTag = `ghcr.io/0xnad/proxywar-commander-public-base:${"6".repeat(40)}`;
  for (const message of [
    `ERROR: unauthorized: authentication required for ${publicTag}`,
    `ERROR: failed to do request: Head "https://ghcr.io/v2/...": dial tcp: network is unreachable`,
    `ERROR: ${publicTag}: unexpected status from HEAD request: 503 Service Unavailable`,
    `ERROR: ${publicTag}: 429 Too Many Requests`,
    `ERROR: failed to solve: ${publicTag}: not found\nERROR: retry failed`,
    "",
  ]) {
    assert.throws(() =>
      classifyManifestInspection({
        tag: publicTag,
        status: 1,
        stderrBytes: Buffer.from(message),
      }),
    );
  }
  assert.throws(() =>
    classifyManifestInspection({
      tag: publicTag,
      status: 1,
      stderrBytes: Buffer.alloc(64 * 1024 + 1),
    }),
  );
});
