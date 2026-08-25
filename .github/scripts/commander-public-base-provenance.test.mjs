import assert from "node:assert/strict";
import test from "node:test";

import { buildCommanderPublicBaseProvenance } from "./commander-public-base-provenance.mjs";

test("public-base provenance makes source behavior and adapter identity exact", () => {
  const sourceSha = "1".repeat(40);
  const sourceTreeSha = "2".repeat(40);
  const value = buildCommanderPublicBaseProvenance({
    sourceSha,
    sourceTreeSha,
    sourceArchiveSha256: "3".repeat(64),
  });
  assert.equal(value.sourceSha, sourceSha);
  assert.equal(value.behaviorSourceSha, sourceSha);
  assert.equal(value.adapterSourceSha, sourceSha);
  assert.equal(value.sourceTreeSha, sourceTreeSha);
  assert.equal(value.behaviorSourceTreeSha, sourceTreeSha);
  assert.equal(value.adapterSourceTreeSha, sourceTreeSha);
  assert.match(value.provenanceSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    value.provenanceSha256,
    buildCommanderPublicBaseProvenance({
      sourceSha,
      sourceTreeSha,
      sourceArchiveSha256: "3".repeat(64),
    }).provenanceSha256,
  );
});

test("public-base provenance rejects malformed or crossed identities", () => {
  assert.throws(() =>
    buildCommanderPublicBaseProvenance({
      sourceSha: "short",
      sourceTreeSha: "2".repeat(40),
      sourceArchiveSha256: "3".repeat(64),
    }),
  );
});
