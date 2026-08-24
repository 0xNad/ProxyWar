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
  assert.match(workflow, /environment: coworld-production/);
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
  assert.match(workflow, /docker run --rm --entrypoint \/bin\/sh "\$GAME_TAG"/);
});

test("game image builds with development tools and runs with production dependencies only", () => {
  const dockerfile = fs.readFileSync(
    new URL(
      "../../coworld-adapter/Dockerfile.commander-xp-game",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(dockerfile, /AS commander-xp-game-builder/);
  assert.match(dockerfile, /npm ci --include=dev --ignore-scripts/);
  assert.ok(
    dockerfile.indexOf("npm ci --include=dev --ignore-scripts") <
      dockerfile.indexOf("npm run build-prod"),
  );
  assert.match(dockerfile, /AS commander-xp-game-runtime/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /COPY --from=commander-xp-game-builder/);
});

test("provision authenticates before its durable fence and mutates no XP", () => {
  const preflight = workflow.indexOf(
    "Authenticated no-mutation Coworld and policy preflight",
  );
  const fence = workflow.indexOf(
    "Build immutable recoverable provision fence intent",
  );
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

test("provision serializes the complete Commander regression group before mutation", () => {
  assert.match(workflow, /tests\/server\/Commander\*\.test\.ts/);
  assert.match(workflow, /--run --maxWorkers=1/);
  assert.ok(
    workflow.indexOf("Run exact-source repository and workflow gates") <
      workflow.indexOf("Build immutable recoverable provision fence intent"),
  );
});

test("provision recovers only from exact cumulative immutable stage boundaries", () => {
  assert.match(workflow, /recovery_provision_artifact_id:/);
  assert.match(workflow, /commander-xp-provision-recovery\.mjs validate/);
  assert.match(
    workflow,
    /\.status == "completed" and \.conclusion != "success"/,
  );
  assert.match(workflow, /commander-xp-provision-boundary-fence-intent-/);
  assert.match(
    workflow,
    /Retain immutable provision fence intent before creating the tag/,
  );
  assert.ok(
    workflow.indexOf(
      "Retain immutable provision fence intent before creating the tag",
    ) <
      workflow.indexOf(
        "Create or recover the durable provision fence before any upload",
      ),
  );
  assert.match(workflow, /test -n "\$RECOVERY_PROVISION_ARTIFACT_ID"/);
  assert.match(workflow, /test "\$\(jq -r \.object\.sha/);
  assert.match(workflow, /RECOVERED_GHCR/);
  assert.match(workflow, /commander-xp-provision-boundary-ghcr-/);
  assert.match(workflow, /--recovery=\$PROVISION_STATE_ROOT\/policy-receipts/);
  assert.match(workflow, /policies-partial/);
  assert.match(workflow, /steps\.policy_upload\.outcome != 'success'/);
  assert.match(workflow, /commander-xp-provision-boundary-terminal-proof-/);
  assert.match(
    workflow,
    /commander-xp-provision-boundary-\$\{\{ steps\.eval_boundary\.outputs\.stage \}\}-/,
  );
  assert.match(workflow, /STAGE=eval-partial/);
  assert.match(workflow, /cmp "\$EVAL_ROOT\/eval-coworld-manifest-v2\.json"/);
  assert.match(workflow, /eval-coworld-recovery-readback\.json/);
  assert.match(workflow, /commander-xp-ghcr-adoption\.mjs inspect/);
  assert.match(workflow, /--allow-remote-adoption="\$ALLOW_REMOTE_ADOPTION"/);
  assert.match(workflow, /eval-coworld-adoption-list\.json/);
  assert.match(workflow, /commander-xp-provision-recovery-lineage-v1\.json/);
  assert.match(workflow, /commander-xp-provision-lineage\.mjs seal/);
  assert.doesNotMatch(workflow, /NAME_PREFIX=.*GITHUB_RUN_ID/);
});

test("provision proves exact 360x100 terminality and preserves product binding", () => {
  assert.match(workflow, /commander-xp-run-episode/);
  assert.match(workflow, /commander-xp-certify/);
  assert.match(
    workflow,
    /build_replay_viewer\.sh[^\n]*\\\n\s+"\$EVAL_ROOT\/build\/static-replay-viewer"/,
  );
  assert.match(
    workflow,
    /test -f "\$EVAL_ROOT\/build\/static-replay-viewer\/index\.html"/,
  );
  assert.doesNotMatch(workflow, /"\$COWORLD_BIN" (?:run-episode|certify)/);
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
  assert.match(policyProvisioner, /coworld-0\.1\.42-policy-upload-readback-v3/);
  assert.match(policyProvisioner, /coworld-0\.1\.42-policy-image-upload-v3/);
  assert.match(policyProvisioner, /adopted-after-remote-success/);
  assert.match(
    policyProvisioner,
    /image\.get\("client_hash"\) != client_hash/,
  );
  assert.match(policyProvisioner, /not SHA256\.fullmatch\(image_digest\)/);
  assert.doesNotMatch(
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
