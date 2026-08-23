import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync(
  new URL("../workflows/commander-xp-control.yml", import.meta.url),
  "utf8",
);

test("control workflow consumes provision authority without source self-reference", () => {
  assert.match(workflow, /^name: Commander XP immutable control packet$/m);
  assert.match(workflow, /provision_artifact_id:/);
  assert.match(workflow, /commander-xp-provision-manifest-v2\.json/);
  assert.match(workflow, /commander-xp-plan-input-base-v2\.json/);
  assert.match(workflow, /commander-xp-provision-recovery-lineage-v1\.json/);
  assert.match(workflow, /commander-xp-provision-lineage\.mjs validate/);
  assert.match(workflow, /prior-provision-boundary-artifact\.json/);
  assert.match(workflow, /find "\$PROVISION_ROOT" -type f/);
  assert.match(workflow, /find "\$PROVISION_ROOT" -type l/);
  assert.match(workflow, /mode == "plan-only-no-requests-created"/);
  assert.doesNotMatch(workflow, /xp-request create/);
  assert.doesNotMatch(workflow, /upload-coworld|upload-policy/);
});

test("control workflow binds exact protected source and attests immutable output", () => {
  assert.match(workflow, /GITHUB_TRIGGERING_ACTOR" = "0xNad/);
  assert.match(workflow, /GITHUB_REF" = "refs\/heads\/main/);
  assert.match(workflow, /commander-xp-control-manifest-v2\.json/);
  assert.match(workflow, /github-actions-attested-control-packet-v1/);
  assert.match(workflow, /retention-days:\s*90/);
  assert.match(workflow, /overwrite:\s*false/);
  assert.match(workflow, /--deny-self-hosted-runners/);
  for (const uses of workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)) {
    assert.match(uses[1], /@[0-9a-f]{40}$/);
  }
});

test("control workflow mints one annotated preregistration fence and only recovers identical bytes", () => {
  assert.match(workflow, /recover_existing_preregistration_fence:/);
  assert.match(workflow, /commander-xp-preregistration-fence-v1/);
  assert.match(workflow, /github-annotated-preregistration-fence-v1/);
  assert.match(workflow, /preregistrationFenceGitRef/);
  assert.match(workflow, /PROVISION_COMPLETED_AT/);
  assert.match(workflow, /CREATED_AT="\$PROVISION_COMPLETED_AT"/);
  assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/git\/tags/);
  assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/git\/refs/);
  assert.match(
    workflow,
    /test "\$RECOVER_EXISTING_PREREGISTRATION_FENCE" = true/,
  );
  const build = workflow.indexOf(
    "Build and validate the immutable control packet",
  );
  const fence = workflow.indexOf(
    "Atomically create or verify the single preregistration fence",
  );
  const upload = workflow.indexOf("Upload immutable control packet");
  assert.ok(build > 0 && build < fence && fence < upload);
});
