import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

const workflow = fs.readFileSync(
  new URL("../workflows/commander-xp-evidence.yml", import.meta.url),
  "utf8",
);

test("protected Commander evidence workflow fences before dispatch and uploads evidence before authority", () => {
  assert.match(workflow, /^name: Commander XP protected experiment evidence$/m);
  assert.match(workflow, /GITHUB_TRIGGERING_ACTOR" = "0xNad/);
  assert.match(workflow, /GITHUB_REF" = "refs\/heads\/main/);
  assert.match(workflow, /coworld==0\.1\.42/);
  assert.match(workflow, /environment: coworld-production/);
  assert.match(workflow, /^ {2}contents: write$/m);
  assert.match(workflow, /status "\$EVAL_COWORLD_ID" --json/);
  assert.match(workflow, /commander-xp-dispatch-fence-/);
  assert.match(workflow, /commander-xp-dispatch-fence-v2/);
  assert.match(workflow, /Create durable atomic pre-dispatch Git ref/);
  assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/git\/refs/);
  assert.match(workflow, /commander-xp-dispatch-progress-v2\.json/);
  assert.match(workflow, /commander-xp-dispatch-receipt-v2\.json/);
  assert.match(workflow, /runs\/\*\*\/submitted-request\.json/);
  assert.match(workflow, /runs\/\*\*\/create-response\.json/);
  assert.match(workflow, /runs\/\*\*\/create-failure\.json/);
  assert.match(workflow, /runs\/\*\*\/first-wave-terminal\.json/);
  assert.doesNotMatch(
    workflow,
    /Retain immutable sanitized dispatch boundary evidence[\s\S]*?create-response-raw\.json[\s\S]*?if-no-files-found/,
  );
  assert.match(
    workflow,
    /Retain immutable sanitized dispatch boundary evidence/,
  );
  assert.match(workflow, /steps\.dispatch\.outcome != 'success'/);
  assert.match(workflow, /overwrite: false/g);
  const fence = workflow.indexOf("Upload immutable pre-dispatch fence");
  const auth = workflow.indexOf(
    "Authenticate and inspect the exact eval Coworld before fencing",
  );
  const dispatch = workflow.indexOf(
    "Build exact dispatch authorization and submit once",
  );
  const durableFence = workflow.indexOf(
    "Create durable atomic pre-dispatch Git ref",
  );
  const partial = workflow.indexOf(
    "Retain immutable sanitized dispatch boundary evidence",
  );
  const collect = workflow.indexOf("Collect only privacy-safe projections");
  const evidence = workflow.indexOf(
    "Upload immutable sanitized evidence first",
  );
  const authorityBuild = workflow.indexOf(
    "Build the post-upload non-circular authority request",
  );
  const authority = workflow.indexOf(
    "Upload immutable authority request second",
  );
  const external = workflow.indexOf(
    "Upload immutable completion-trigger handoff",
  );
  assert.ok(
    auth > 0 && auth < durableFence && durableFence < fence && fence < dispatch,
  );
  assert.ok(dispatch < partial && partial < collect);
  assert.ok(collect < evidence);
  assert.ok(evidence < authorityBuild && authorityBuild < authority);
  assert.ok(authority < external);
});

test("workflow resolves attested prior phases before the irreversible fence", () => {
  assert.match(workflow, /preregistration_binding_artifact_id:/);
  assert.match(workflow, /provider_preflight_binding_artifact_id:/);
  assert.match(workflow, /canary_binding_artifact_id:/);
  assert.match(workflow, /verify-phase-binding/);
  assert.match(workflow, /verify-prior-authority/);
  assert.match(workflow, /gh attestation verify "\$BINDING"/);
  assert.doesNotMatch(
    workflow,
    /\$CONTROL_ROOT\/commander-xp-(?:prereg|provider-preflight|canary)-ledger-v2\.json/,
  );
  const retained = workflow.indexOf(
    "Resolve and verify retained phase authorities before mutation",
  );
  const activation = workflow.indexOf(
    "Build confirmatory activation from the verified canary authority",
  );
  const fence = workflow.indexOf("Upload immutable pre-dispatch fence");
  assert.ok(retained > 0 && retained < activation && activation < fence);
});

test("workflow adopts one exact retained partial boundary without replaying its fence", () => {
  assert.match(workflow, /recovery_dispatch_artifact_id:/);
  assert.match(
    workflow,
    /Resolve one exact retained dispatch boundary for recovery/,
  );
  assert.match(
    workflow,
    /actions\/artifacts\/\$RECOVERY_DISPATCH_ARTIFACT_ID\/zip/,
  );
  assert.match(
    workflow,
    /commander-xp-dispatch-boundary-\$EXPERIMENT_ID-\$PHASE-\$SOURCE_SHA-\$RECOVERY_RUN_ID-\$RECOVERY_RUN_ATTEMPT/,
  );
  assert.match(workflow, /commander-xp-dispatch-recovery-v1/);
  assert.match(
    workflow,
    /Resume from retained wave one and submit confirmatory wave two[\s\S]+conclusion == "skipped"/,
  );
  assert.match(workflow, /EXPECTED_FINAL_NAME/);
  assert.match(workflow, /commander-xp-dispatch-recovery-link-v1\.json/);
  assert.match(workflow, /recoveryDirectory:\$recovery/);
  assert.match(workflow, /cp "\$RECOVERY_AUTH_PATH"/);
  assert.match(
    workflow,
    /Create durable atomic pre-dispatch Git ref[\s\S]*?inputs\.recovery_dispatch_artifact_id == ''/,
  );
  const resolve = workflow.indexOf(
    "Resolve one exact retained dispatch boundary for recovery",
  );
  const fence = workflow.indexOf("Create durable atomic pre-dispatch Git ref");
  const dispatch = workflow.indexOf(
    "Build exact dispatch authorization and submit once",
  );
  assert.ok(resolve > 0 && resolve < fence && fence < dispatch);
});

test("confirmatory dispatch retains wave one before waiting and submits wave two only from that prefix", () => {
  assert.match(workflow, /confirmatoryDispatchMode:"first-wave-only"/);
  assert.match(
    workflow,
    /del\(\.confirmatoryDispatchMode\) \| \.recoveryDirectory=\$recovery \| \.outputDirectory=\$output/,
  );
  assert.match(workflow, /commander-xp-dispatch-boundary-final-/);
  assert.match(workflow, /commander-xp-dispatch-final-input-v2\.json/);
  const firstDispatch = workflow.indexOf(
    "Build exact dispatch authorization and submit once",
  );
  const firstBoundary = workflow.indexOf(
    "Retain immutable sanitized dispatch boundary evidence",
  );
  const secondDispatch = workflow.lastIndexOf(
    "Resume from retained wave one and submit confirmatory wave two",
  );
  const secondBoundary = workflow.indexOf(
    "Retain immutable confirmatory wave-two boundary evidence",
  );
  const terminalWait = workflow.indexOf(
    "Wait for every dispatched XP request to finish",
  );
  assert.ok(
    firstDispatch < firstBoundary &&
      firstBoundary < secondDispatch &&
      secondDispatch < secondBoundary &&
      secondBoundary < terminalWait,
  );
});

test("workflow never interpolates dispatch inputs into shell source", () => {
  const parsed = yaml.load(workflow);
  for (const step of parsed.jobs.collect.steps) {
    if (typeof step.run === "string") {
      assert.doesNotMatch(step.run, /\$\{\{\s*inputs\./);
    }
  }
  assert.match(
    workflow,
    /PREREGISTRATION_BINDING_ARTIFACT_ID: \$\{\{ inputs\.preregistration_binding_artifact_id \}\}/,
  );
  assert.match(
    workflow,
    /require_positive_integer "\$PREREGISTRATION_BINDING_ARTIFACT_ID"/,
  );
  const authorize = parsed.jobs.collect.steps.find(
    (step) => step.name === "Authorize exact protected-main source and CI",
  ).run;
  const functionsStart = authorize.indexOf("require_positive_integer() {");
  const functionsEnd = authorize.indexOf(
    'test "$GITHUB_EVENT_NAME"',
    functionsStart,
  );
  const caseStart = authorize.indexOf('case "$PHASE" in', functionsEnd);
  const end = authorize.indexOf('test "$GITHUB_SHA"', caseStart);
  const validation =
    authorize.slice(functionsStart, functionsEnd) +
    authorize.slice(caseStart, end);
  const baseEnv = {
    ...process.env,
    PHASE: "provider-preflight",
    PREREGISTRATION_BINDING_ARTIFACT_ID: "123",
    PROVIDER_PREFLIGHT_BINDING_ARTIFACT_ID: "",
    CANARY_BINDING_ARTIFACT_ID: "",
    RECOVERY_DISPATCH_ARTIFACT_ID: "",
  };
  execFileSync("bash", ["-euo", "pipefail", "-c", validation], {
    env: baseEnv,
  });
  for (const poison of ["123'\nexit 0\n'", '123"\nexit 0\n"']) {
    assert.throws(() =>
      execFileSync("bash", ["-euo", "pipefail", "-c", validation], {
        env: {
          ...baseEnv,
          PREREGISTRATION_BINDING_ARTIFACT_ID: poison,
        },
      }),
    );
  }
});

test("workflow consumes an attested external control packet without tracked self-reference", () => {
  assert.match(workflow, /experiment_id:/);
  assert.match(
    workflow,
    /commander-xp-evidence-\$\{\{ inputs\.experiment_id \}\}-\$\{\{ inputs\.phase \}\}-\$\{\{ inputs\.source_sha \}\}/,
  );
  assert.match(workflow, /control_artifact_id:/);
  assert.match(workflow, /commander-xp-control-manifest-v2\.json/);
  assert.match(workflow, /commander-xp-control\.yml@refs\/heads\/main/);
  assert.match(workflow, /CONTROL_ARTIFACT_ID/);
  assert.doesNotMatch(workflow, /control_root:/);
  assert.doesNotMatch(workflow, /CONTROL_ROOT_INPUT/);
  assert.doesNotMatch(workflow, /git ls-files --error-unmatch/);
});

test("workflow clean-installs and typechecks the adapter collector runtime", () => {
  assert.match(workflow, /version: "0\.8\.12"/);
  assert.match(workflow, /test "\$\(uv --version\)" = "uv 0\.8\.12"/);
  assert.match(workflow, /--prefix coworld-adapter --ignore-scripts/);
  assert.match(workflow, /npm run --prefix coworld-adapter typecheck/);
  assert.match(
    workflow,
    /import\('\.\/coworld-adapter\/src\/commander-xp-collect\.ts'\)/,
  );
});

test("collector input jq compiles with every referenced source argument", () => {
  const parsed = yaml.load(workflow);
  const collectStep = parsed.jobs.collect.steps.find(
    (step) =>
      step.name ===
      "Collect only privacy-safe projections and create the local seal",
  );
  const run = collectStep.run;
  const start = run.indexOf("jq -n \\\n");
  const marker = '> "$RUNNER_TEMP/commander-xp-collector-input-v2.json"';
  const end = run.indexOf(marker, start) + marker.length;
  assert.ok(start >= 0 && end >= marker.length);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "commander-xp-collector-jq-"),
  );
  fs.writeFileSync(
    path.join(directory, "dispatch-requests.json"),
    '{"requests":[]}\n',
  );
  execFileSync("bash", ["-euo", "pipefail", "-c", run.slice(start, end)], {
    env: {
      ...process.env,
      PHASE: "preregistration",
      CONTROL_ROOT: "/immutable-control",
      RUNNER_TEMP: directory,
      GITHUB_WORKSPACE: "/exact-source",
      PREREG_LEDGER_PATH: "",
      PROVIDER_LEDGER_PATH: "",
      CANARY_LEDGER_PATH: "",
      ACTIVATION_PATH: "",
    },
  });
  const input = JSON.parse(
    fs.readFileSync(
      path.join(directory, "commander-xp-collector-input-v2.json"),
      "utf8",
    ),
  );
  assert.equal(
    input.xpOpenApiContractPath,
    "/immutable-control/xp-openapi-contract-v2.json",
  );
  assert.equal(
    input.sourceProvenancePath,
    "/immutable-control/commander-xp-source-provenance-v2.json",
  );
  assert.equal(
    input.sourceTreeDiffPath,
    "/immutable-control/commander-xp-source-tree-diff-v1.json",
  );
});

test("workflow completes with an immutable handoff for the workflow-run seal", () => {
  assert.match(workflow, /github-actions-completed-collector-handoff-v1/);
  assert.match(workflow, /commander-xp-external-seal-handoff-v1\.json/);
  assert.match(workflow, /externalSealTrigger:"workflow_run:completed"/);
  assert.doesNotMatch(workflow, /gh workflow run commander-xp-external-seal/);
  assert.doesNotMatch(workflow, /gh run watch/);
});

test("workflow pins every reusable action and never uploads raw Coworld evidence", () => {
  for (const uses of workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gm)) {
    assert.match(uses[1], /@[0-9a-f]{40}$/);
  }
  assert.doesNotMatch(workflow, /episode-results-raw\.json/);
  assert.doesNotMatch(workflow, /game-logs-raw\.txt/);
  assert.doesNotMatch(workflow, /replay\.json/);
  assert.match(workflow, /commander-xp-external-seal-request-v1\.json/);
  assert.match(workflow, /commander-xp-envelope\/evidence\//);
  assert.match(workflow, /commander-xp-envelope\/authority\//);
});

test("reviewed source allowlist equals the complete behavior-base range", () => {
  const expected = JSON.parse(
    fs.readFileSync(
      new URL("./commander-xp-source-allowlist-v2.json", import.meta.url),
      "utf8",
    ),
  );
  const repository = fileURLToPath(new URL("../..", import.meta.url));
  const trackedDiff = execFileSync(
    "git",
    [
      "-C",
      repository,
      "diff",
      "--name-only",
      "a69175a30577b3e516f09a2cb0960d4d129b3f33",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const untracked = execFileSync(
    "git",
    ["-C", repository, "ls-files", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(
    [...new Set([...trackedDiff, ...untracked])].sort(),
    expected,
  );
});
