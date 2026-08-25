import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import yaml from "js-yaml";

const workflow = fs.readFileSync(
  new URL("../workflows/commander-public-base.yml", import.meta.url),
  "utf8",
);
const dockerfile = fs.readFileSync(
  new URL(
    "../../coworld-adapter/Dockerfile.commander-public-base",
    import.meta.url,
  ),
  "utf8",
);

function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = workflow.indexOf("\n      - name: ", start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
}

test("public-base workflow has no duplicate YAML mapping keys", () => {
  assert.doesNotThrow(() => yaml.load(workflow, { json: false }));
});

test("public-base workflow is operator-dispatched from exact protected main CI", () => {
  assert.match(
    workflow,
    /^name: Commander public base immutable materialization$/m,
  );
  assert.match(workflow, /environment: coworld-production/);
  assert.match(workflow, /GITHUB_ACTOR" = 0xNad/);
  assert.match(workflow, /GITHUB_TRIGGERING_ACTOR" = 0xNad/);
  assert.match(workflow, /GITHUB_REF" = refs\/heads\/main/);
  assert.match(workflow, /\.path == "\.github\/workflows\/ci\.yml"/);
  assert.match(workflow, /\.event == "push"/);
  assert.match(workflow, /git status --porcelain=v1 --untracked-files=all/);
  for (const uses of workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)) {
    assert.match(uses[1], /@[0-9a-f]{40}$/);
  }
});

test("public-base workflow builds one isolated linux amd64 image", () => {
  assert.equal(
    workflow.match(/docker build --platform linux\/amd64/g)?.length,
    1,
  );
  assert.match(
    workflow,
    /ghcr\.io\/0xnad\/proxywar-commander-public-base:\$SOURCE_SHA/,
  );
  assert.match(workflow, /Dockerfile\.commander-public-base/);
  assert.doesNotMatch(workflow, /Dockerfile\.commander-xp(?:\s|"|')/);
  assert.doesNotMatch(
    workflow,
    /ghcr\.io\/0xnad\/proxywar-commander-xp-game:\$SOURCE_SHA/,
  );
  assert.equal(
    workflow.match(/actions\/attest-build-provenance@[0-9a-f]{40}/g)?.length,
    1,
  );
  assert.match(workflow, /POLICY_ROOTFS_BYTES/);
  assert.match(workflow, /CommanderStateBuilder\.ts/);
  assert.match(workflow, /CommanderPromptBuilder\.ts/);
  assert.match(workflow, /StrategicCommanderTypes\.ts/);
  assert.match(
    workflow,
    /org\.opencontainers\.image\.source.*https:\/\/github\.com\/0xNad\/ProxyWar/,
  );
  assert.match(workflow, /HOST_SHA=.*sha256sum/);
  assert.match(workflow, /IMAGE_SHA=.*docker run.*sha256sum/);
  assert.match(workflow, /test "\$IMAGE_SHA" = "\$HOST_SHA"/);
  assert.match(
    workflow,
    /Config\.Cmd == \["node","--import","tsx","\/app\/proxywar\/coworld-adapter\/src\/commander-player\.ts"\]/,
  );
  assert.match(dockerfile, /^FROM .*@sha256:[0-9a-f]{64}$/m);
  assert.match(
    dockerfile,
    /CMD \["node", "--import", "tsx", "\/app\/proxywar\/coworld-adapter\/src\/commander-player\.ts"\]/,
  );
  assert.doesNotMatch(dockerfile, /COMMANDER_XP|--arm|starter-player/);
});

test("public-base provenance makes source behavior and adapter identical", () => {
  assert.match(workflow, /COMMANDER_PUBLIC_BASE_SOURCE_SHA=\$SOURCE_SHA/);
  assert.match(
    workflow,
    /COMMANDER_PUBLIC_BASE_SOURCE_TREE_SHA=\$SOURCE_TREE_SHA/,
  );
  assert.match(
    workflow,
    /COMMANDER_PUBLIC_BASE_SOURCE_PROVENANCE_SHA256=\$SOURCE_PROVENANCE_SHA256/,
  );
  assert.match(workflow, /commander-public-base-provenance\.mjs/);
  assert.doesNotMatch(workflow, /BEHAVIOR_BASE_SHA/);
  assert.doesNotMatch(workflow, /a69175a30577b3e516f09a2cb0960d4d129b3f33/);
});

test("public-base workflow materializes one image through the exact Commander entrypoint", () => {
  assert.match(workflow, /commander-public-base-materialize upload/);
  assert.match(workflow, /\.imageCount == 1 and \.policyCount == 1/);
  assert.match(workflow, /\.bedrockEnvironmentCount == 0/);
  assert.match(
    workflow,
    /imageCount:1,policyCount:1,bedrockEnvironmentCount:0,evalCoworldCount:0,xpRequestCount:0/,
  );
  assert.doesNotMatch(workflow, /policy-secret-envs|starter-player|--arm=/);
  assert.match(workflow, /commander-public-base-materialization-v2/);
  assert.match(workflow, /POLICY_IDENTITY_SHA256/);
  assert.match(workflow, /POLICY_NAME="\$POLICY_IDENTITY_SHA256"/);
  assert.doesNotMatch(
    workflow,
    /POLICY_NAME="proxywar-commander-public-base-v2-/,
  );
  assert.match(workflow, /policy-identity-sha256/);
  assert.match(workflow, /docker pull "\$PUBLIC_IMAGE_URI"/);
  assert.match(
    workflow,
    /docker run --rm --entrypoint node "\$PUBLIC_IMAGE_URI" --import tsx -e/,
  );
  assert.doesNotMatch(workflow, /Upload six immutable policy versions/);
  assert.doesNotMatch(workflow, /CANONICAL_COWORLD/);
  assert.doesNotMatch(workflow, /upload-coworld/);
  assert.doesNotMatch(workflow, /xp-request/);
});

test("GHCR and Coworld output-loss windows have exact adoption authority", () => {
  assert.match(workflow, /commander-xp-ghcr-adoption\.mjs discover/);
  assert.match(workflow, /REMOTE_GHCR_ADOPTED=true/);
  assert.match(
    workflow,
    /if: env\.RECOVERED_GHCR_BOUNDARY != 'true'[\s\S]*actions\/attest-build-provenance/,
  );
  const recovery = step("Resolve exact GHCR recovery state");
  const adoptionStart = recovery.indexOf(
    'elif test "$RECOVERY_STAGE" = intent; then',
  );
  const adoptionEnd = recovery.indexOf("            else", adoptionStart);
  assert.notEqual(adoptionStart, -1);
  assert.notEqual(adoptionEnd, -1);
  assert.doesNotMatch(
    recovery.slice(adoptionStart, adoptionEnd),
    /POLICY_CONFIG_DIGEST/,
  );
  assert.match(workflow, /boundary-coworld-intent/);
  assert.match(workflow, /--allow-remote-adoption="\$ALLOW_REMOTE_ADOPTION"/);
  assert.match(
    workflow,
    /coworld-intent\|coworld-image\|coworld-policy\) ALLOW_REMOTE_ADOPTION=true/,
  );
});

test("intent recovery authenticates GHCR discovery and fails closed before push", () => {
  const recovery = step("Resolve exact GHCR recovery state");
  const login = recovery.indexOf("docker login ghcr.io");
  const inspect = recovery.indexOf("docker buildx imagetools inspect --raw");
  const classify = recovery.indexOf("classify-inspect");
  assert.notEqual(login, -1);
  assert.ok(login < inspect);
  assert.ok(inspect < classify);
  assert.match(recovery, /GHCR_INSPECT_STATUS=\$\?/);
  assert.match(recovery, /REMOTE_GHCR_STATE=\$\(node/);
  assert.match(recovery, /if test "\$REMOTE_GHCR_STATE" = available; then/);
  assert.match(recovery, /elif test "\$REMOTE_GHCR_STATE" = not-found; then/);
  assert.doesNotMatch(recovery, /imagetools inspect[\s\S]*2>\/dev\/null/);
  assert.doesNotMatch(recovery, /\|\|\s*true/);

  const push = step("Push one exact immutable GHCR image");
  assert.match(push, /if: env\.REMOTE_GHCR_AVAILABLE != 'true'/);
  assert.ok(workflow.indexOf("classify-inspect") < workflow.indexOf(push));
});

test("public-base workflow retains strict cumulative failure boundaries", () => {
  for (const stage of [
    "boundary-intent",
    "boundary-ghcr",
    "boundary-coworld-intent",
    "materialization_boundary.outputs.stage",
  ]) {
    assert.match(workflow, new RegExp(stage.replaceAll(".", "\\.")));
  }
  assert.match(workflow, /retention-days:\s*90/);
  assert.match(workflow, /recovery_artifact_id:/);
  assert.match(workflow, /conclusion != "success"/);
  assert.match(workflow, /commander-public-base-recovery\.mjs validate/);
  assert.match(workflow, /source-provenance\.json/);
  assert.match(
    workflow,
    /cmp "\$STATE_ROOT\/source-provenance\.json"[\s\\]+"\$RUNNER_TEMP\/commander-public-base-provenance-v1\.json"/,
  );
  assert.match(workflow, /coworld-image/);
  assert.match(workflow, /coworld-policy/);
  assert.match(workflow, /STAGE=complete/);
});

test("recovery downloads and extraction are bounded before allocation", () => {
  const recovery = step("Resolve one exact failed-run boundary");
  assert.match(recovery, /copy metadata/);
  assert.match(recovery, /copy archive/);
  assert.match(recovery, /RECOVERY_DECLARED_BYTES/);
  assert.match(recovery, /32 \* 1024 \* 1024/);
  assert.match(recovery, /recovery-archive\.py[\s\\]+extract/);
  assert.doesNotMatch(recovery, /extractall/);
});

test("every outward public-base boundary reauthorizes protected main", () => {
  for (const name of [
    "Create or verify durable public-base fence",
    "Push one exact immutable GHCR image",
    "Materialize exactly one Coworld image",
    "Verify terminal single-image handoff",
  ]) {
    const outwardStep = step(name);
    assert.match(outwardStep, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(
      outwardStep,
      /commander-xp-main-authorization\.mjs "\$SOURCE_SHA"/,
    );
  }
});
