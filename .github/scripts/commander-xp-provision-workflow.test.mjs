import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import yaml from "js-yaml";

const workflow = fs.readFileSync(
  new URL("../workflows/commander-xp-provision.yml", import.meta.url),
  "utf8",
);
const policyProvisioner = fs.readFileSync(
  new URL(
    "../../coworld-adapter/scripts/provision-commander-xp-policies.py",
    import.meta.url,
  ),
  "utf8",
);

test("provision workflow has no duplicate YAML mapping keys", () => {
  assert.doesNotThrow(() => yaml.load(workflow, { json: false }));
});

test("provision runs only on protected exact main and successful push CI", () => {
  assert.match(workflow, /^name: Commander XP immutable eval provision$/m);
  assert.match(workflow, /environment: commander-xp-eval/);
  assert.match(workflow, /GITHUB_ACTOR" = 0xNad/);
  assert.match(workflow, /GITHUB_TRIGGERING_ACTOR" = 0xNad/);
  assert.match(workflow, /GITHUB_REF" = refs\/heads\/main/);
  assert.match(workflow, /\.event == "push"/);
  assert.match(workflow, /\.path == "\.github\/workflows\/ci\.yml"/);
  assert.match(workflow, /git rev-parse HEAD\^\{tree\}/);
  assert.match(workflow, /git status --porcelain=v1 --untracked-files=all/);
  for (const uses of workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)) {
    assert.match(uses[1], /@[0-9a-f]{40}$/);
  }
});

test("provision builds both images from one clean archive with exact provenance", () => {
  assert.match(workflow, /buildTreeDiffManifest/);
  assert.match(workflow, /git archive --format=tar "\$SOURCE_SHA"/);
  assert.match(
    workflow,
    /sourceArchiveSha256:process\.env\.SOURCE_ARCHIVE_SHA256/,
  );
  assert.match(workflow, /commander-xp-source-provenance-v2\.json/);
  assert.match(workflow, /provision-commander-xp-policies\.test\.py/);
  assert.match(workflow, /Dockerfile\.commander-xp-game/);
  assert.match(workflow, /Dockerfile\.commander-xp/);
  assert.match(workflow, /docker build --platform linux\/amd64/g);
  assert.match(workflow, /actions\/attest-build-provenance@[0-9a-f]{40}/);
  assert.match(workflow, /--source-digest "\$SOURCE_SHA"/);
  assert.match(workflow, /--signer-digest "\$SOURCE_SHA"/);
  assert.match(workflow, /--deny-self-hosted-runners/);
});

test("provision authenticates before its durable fence and mutates no XP", () => {
  const preflight = workflow.indexOf(
    "Authenticated no-mutation Coworld and policy preflight",
  );
  const fence = workflow.indexOf("Create durable provision fence");
  const imagePush = workflow.indexOf("Push exact immutable GHCR images");
  const policyUpload = workflow.indexOf(
    "Upload six immutable policy versions from one image",
  );
  const coworldUpload = workflow.indexOf(
    "Upload and inspect the noncanonical eval Coworld",
  );
  assert.ok(preflight >= 0 && preflight < fence);
  assert.ok(fence < imagePush && imagePush < policyUpload);
  assert.ok(policyUpload < coworldUpload);
  assert.match(workflow, /namesAvailable == 6/);
  assert.match(workflow, /policyCount == 6/);
  assert.doesNotMatch(workflow, /xp-request create/);
});

test("provision proves exact 360x100 terminality and preserves product binding", () => {
  assert.match(workflow, /run-episode/);
  assert.match(workflow, /tournament-4p-pangaea/);
  assert.match(workflow, /\.turn_count <= 36400/);
  assert.match(workflow, /\.tick <= 36400/);
  assert.match(workflow, /\.seed == 17 and \.game_id == "PWSAAAAR"/);
  assert.match(workflow, /exact-image-coworld-0\.1\.42-run-episode-v1/);
  assert.match(workflow, /eval-coworld-terminal-proof-v2\.json/);
  assert.match(workflow, /\.coworld\.canonical[^\n]+false/);
  assert.match(
    workflow,
    /cmp "\$RUNNER_TEMP\/canonical-binding-before\.jsonl"/,
  );
  assert.match(workflow, /No XP request was created by this workflow/);
});

test("provision retains only safe projections of presigned policy upload responses", () => {
  assert.match(policyProvisioner, /responseSha256/);
  assert.match(policyProvisioner, /responseProjection/);
  assert.match(
    policyProvisioner,
    /"uploadRequired": requested\.pre_signed_info is not None/,
  );
  assert.doesNotMatch(policyProvisioner, /"authorization_token"/);
  assert.doesNotMatch(
    policyProvisioner,
    /write_(?:text|bytes)\([^\n]*response_bytes/,
  );
  assert.match(policyProvisioner, /coworld-0\.1\.42-policy-upload-readback-v2/);
  assert.match(
    policyProvisioner,
    /image\["image_digest"\] != args\.oci_digest/,
  );
});

test("provision attests a unique immutable 90-day handoff packet", () => {
  assert.match(workflow, /github-actions-attested-provision-packet-v1/);
  assert.match(workflow, /actions\/attest@[0-9a-f]{40}/);
  assert.match(workflow, /retention-days:\s*90/);
  assert.match(workflow, /overwrite:\s*false/);
  assert.match(
    workflow,
    /commander-xp-provision-\$SOURCE_SHA-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT/,
  );
});
