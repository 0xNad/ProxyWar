import assert from "node:assert/strict";
import test from "node:test";

import { inspectSinglePlatformManifest } from "./commander-xp-ghcr-adoption.mjs";

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
