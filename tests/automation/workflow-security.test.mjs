import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const admission = readFileSync(
  ".github/workflows/trusted-pr-admission.yml",
  "utf8",
);
const production = readFileSync(
  ".github/workflows/coworld-production.yml",
  "utf8",
);
const commissionerProduction = readFileSync(
  ".github/workflows/coworld-commissioner-production.yml",
  "utf8",
);
const commissionerProductionScript = readFileSync(
  ".github/scripts/coworld-commissioner-production.mjs",
  "utf8",
);
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const queue = readFileSync(".github/scripts/coworld-queue.mjs", "utf8");
const vite = readFileSync("vite.config.ts", "utf8");
const gitignore = readFileSync(".gitignore", "utf8");
const leagueSourceGuard = readFileSync(
  "scripts/verify-league-source.mjs",
  "utf8",
);
const trustedReleasePolicy = JSON.parse(
  readFileSync(".github/automation/trusted-release-policy.json", "utf8"),
);

test("privileged admission executes only protected main metadata code", () => {
  assert.match(admission, /pull_request_target:/);
  assert.match(admission, /ref: main/);
  assert.match(admission, /persist-credentials: false/);
  assert.doesNotMatch(admission, /pull_request\.head\.sha/);
  assert.doesNotMatch(admission, /refs\/pull/);
  assert.doesNotMatch(admission, /download-artifact/);
  assert.deepEqual(
    [...admission.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]),
    ["TRUSTED_RELEASE_APP_PRIVATE_KEY"],
  );
  assert.match(
    admission,
    /actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1/,
  );
  assert.match(admission, /permission-workflows: write/);
  assert.match(
    admission,
    /GITHUB_TOKEN: \$\{\{ steps\.trusted_app\.outputs\.token \|\| github\.token \}\}/,
  );
});

test("admission identity comes from API pull_request.user.login", () => {
  const source = readFileSync(
    ".github/scripts/trusted-pr-admission.mjs",
    "utf8",
  );
  assert.match(source, /authorLogin: pr\.user\.login/);
  assert.match(source, /fresh\.input\.headSha/);
  assert.match(source, /expectedHeadOid/);
  assert.match(source, /expected_head_sha: expectedHeadSha/);
  assert.match(source, /canRefreshTrustedBranch/);
  assert.match(source, /branchRefreshTokenReady/);
  assert.match(source, /missing-trusted-release-github-app-token/);
  assert.doesNotMatch(source, /enablePullRequestAutoMerge/);
  assert.doesNotMatch(source, /commit.*email/i);
  assert.doesNotMatch(source, /head\.ref.*trusted/i);
});

test("production secrets are isolated to a protected main environment job", () => {
  assert.match(production, /name: coworld-production/);
  assert.match(
    production,
    /COWORLD_API_TOKEN: \$\{\{ secrets\.COWORLD_API_TOKEN \}\}/,
  );
  assert.doesNotMatch(production, /enable-cache: true/);
  assert.match(production, /UV_NO_CACHE=1/);
  assert.match(production, /\.user\.login=="github-actions\[bot\]"/);
  assert.match(production, /blocked_candidate/);
  assert.match(production, /deploy-finalizer:/);
  assert.match(production, /needs\.deploy\.result != 'success'/);
  assert.match(production, /needs\.preflight\.result != 'success'/);
  assert.match(production, /needs\.build\.result != 'success'/);
  assert.match(production, /proxywar-coworld-deploy-failure:/);
  assert.doesNotMatch(production, /original_previous=\$\{\{/);
  assert.doesNotMatch(production, /pull_request:/);
  assert.doesNotMatch(production, /pull_request_target:/);
  assert.match(
    production,
    /test "\$SOURCE_SHA" = "\$\(gh api repos\/\$GITHUB_REPOSITORY\/git\/ref\/heads\/main/,
  );
});

test("commissioner migration is an operator-only exact-source protected production dispatch", () => {
  assert.match(commissionerProduction, /workflow_dispatch:/);
  assert.match(commissionerProduction, /source_sha:\n\s+description:/);
  assert.match(commissionerProduction, /resume_run_id:\n\s+description:/);
  assert.match(commissionerProduction, /resume_artifact_id:\n\s+description:/);
  assert.match(commissionerProduction, /required: true/);
  assert.doesNotMatch(
    commissionerProduction,
    /pull_request:|pull_request_target:|schedule:/,
  );
  assert.match(commissionerProduction, /test "\$GITHUB_ACTOR" = "0xNad"/);
  assert.match(
    commissionerProduction,
    /CONTROL_SHA=\$\(gh api repos\/\$GITHUB_REPOSITORY\/git\/ref\/heads\/main/,
  );
  assert.match(
    commissionerProduction,
    /compare\/\$SOURCE_SHA\.\.\.\$CONTROL_SHA/,
  );
  assert.match(commissionerProduction, /case "\$RELATION" in ahead\|identical/);
  assert.match(
    commissionerProduction,
    /test "\$\(git rev-parse HEAD\)" = "\$CONTROL_SHA"/,
  );
  assert.match(
    commissionerProduction,
    /environment:\n\s+name: coworld-production/,
  );
  assert.match(commissionerProduction, /group: proxywar-coworld-production/);
  assert.match(commissionerProduction, /cancel-in-progress: false/);
  const commissionerSecrets = [
    ...commissionerProduction.matchAll(/secrets\.([A-Z0-9_]+)/g),
  ].map((match) => match[1]);
  assert.equal(commissionerSecrets.length, 6);
  assert.ok(
    commissionerSecrets.every((secret) => secret === "COWORLD_API_TOKEN"),
  );
});

test("commissioner migration consumes an exact certified release and rechecks every mutation gate", () => {
  assert.match(commissionerProduction, /resolve-ci "\$SOURCE_SHA"/);
  assert.match(
    commissionerProduction,
    /resolve-release-candidates "\$SOURCE_SHA"/,
  );
  assert.match(commissionerProduction, /releaseRunIds\[\]/);
  assert.match(commissionerProduction, /resolve-release "\$SOURCE_SHA"/);
  assert.match(
    commissionerProduction,
    /actions\/artifacts\/\$RELEASE_ARTIFACT_ID\/zip/,
  );
  assert.match(
    commissionerProduction,
    /sha256sum --check coworld-release\.sha256/,
  );
  assert.match(commissionerProduction, /unsafe release artifact member/);
  assert.match(commissionerProduction, /unsafe release archive member/);
  assert.match(commissionerProduction, /validate-artifact/);
  assert.match(commissionerProduction, /validate-image/);
  assert.match(commissionerProduction, /linux-amd64 commissioner image/);
  assert.match(
    commissionerProduction,
    /resolve-ci "\$SOURCE_SHA" "\$RUNNER_TEMP\/ci-runs-recheck\.json"/,
  );
  assert.match(
    commissionerProduction,
    /releaseArtifactId "\$RUNNER_TEMP\/release-recheck\.json"\)" = "\$RELEASE_ARTIFACT_ID"/,
  );
  assert.match(commissionerProduction, /validate-source "\$SOURCE_SHA"/);
  assert.match(commissionerProduction, /next-version "\$COWORLD_NAME"/);
});

test("commissioner mutation is narrow, guarded, certified, canonical, bound, and durably recorded", () => {
  assert.match(
    commissionerProduction,
    /patch-commissioner "\$COWORLD_NAME" "\$LOCAL_COMMISSIONER_IMAGE" \\\n+\s+--runnable-id "\$COMMISSIONER_RUNNABLE_ID" --version "\$PATCH_VERSION"/,
  );
  assert.match(commissionerProduction, /coworld-docker-guard\.mjs/);
  assert.match(commissionerProduction, /docker" run --rm invalid-image/);
  assert.match(commissionerProduction, /test "\$\?" -eq 126/);
  assert.match(commissionerProduction, /certification-state/);
  assert.match(commissionerProduction, /test "\$STATE" != failed/);
  assert.match(commissionerProduction, /commissioner_migration_version/);
  assert.match(commissionerProduction, /validate-final/);
  assert.match(
    commissionerProduction,
    /coworld-commissioner-mutation-receipt\.json/,
  );
  assert.match(
    commissionerProduction,
    /coworld-commissioner-reconciliation-state\.json/,
  );
  assert.match(commissionerProductionScript, /recoveryProcedure/);
  assert.match(commissionerProductionScript, /automaticRollback: false/);
  assert.match(commissionerProduction, /if: \$\{\{ always\(\) \}\}/);
  assert.match(commissionerProduction, /validate-resume-reference/);
  assert.match(commissionerProduction, /validate-resume-receipt/);
  assert.match(commissionerProduction, /validate-resume-source/);
  assert.match(
    commissionerProduction,
    /compare\/\$RECEIPT_CONTROL_SHA\.\.\.\$CONTROL_SHA/,
  );
  assert.match(commissionerProduction, /build-reconciliation/);
  assert.doesNotMatch(commissionerProduction, /--slurpfile observedStatus/);
  assert.doesNotMatch(commissionerProduction, /--slurpfile observedLeague/);
  assert.match(
    commissionerProduction,
    /coworld-commissioner-migration-evidence\.json/,
  );
  assert.match(commissionerProduction, /state=success/);
  assert.match(commissionerProduction, /state=failure/);
  assert.match(commissionerProduction, /migration-finalizer:/);
  assert.doesNotMatch(commissionerProduction, /set -x/);
  assert.doesNotMatch(commissionerProduction, /echo.*COWORLD_API_TOKEN/);
  assert.doesNotMatch(
    commissionerProduction,
    /path:\s*.*(credentials|\.softmax|COWORLD_API_TOKEN)/i,
  );
  assert.deepEqual(
    [
      ...commissionerProduction.matchAll(
        /path:\s*\$\{\{ runner\.temp \}\}\/([^\n]+)/g,
      ),
    ].map((match) => match[1]),
    [
      "coworld-commissioner-mutation-receipt.json",
      "coworld-commissioner-reconciliation-state.json",
      "coworld-commissioner-migration-evidence.json",
    ],
  );
});

test("commissioner recovery resumes only an exact retained mutation and never re-patches it", () => {
  assert.match(
    commissionerProduction,
    /Recover the exact existing mutation from its immutable receipt\n\s+if: \$\{\{ needs\.admission\.outputs\.migration_mode == 'resume' \}\}/,
  );
  assert.match(
    commissionerProduction,
    /Patch only the exact commissioner runnable\n\s+id: patch\n\s+if: \$\{\{ needs\.admission\.outputs\.migration_mode == 'new' \}\}/,
  );
  assert.match(
    commissionerProduction,
    /actions\/artifacts\/\$RESUME_ARTIFACT_ID\/zip/,
  );
  assert.match(
    commissionerProduction,
    /resume artifact must contain only the mutation receipt/,
  );
  assert.match(commissionerProduction, /validate-resume-receipt/);
  assert.match(commissionerProduction, /validate-resume-source/);
  assert.match(commissionerProduction, /status "\$SOURCE_COWORLD_ID" --json/);
  assert.match(
    commissionerProductionScript,
    /resume source status Coworld id mismatch/,
  );
  assert.match(
    commissionerProductionScript,
    /validateCommissionerOnlyManifestPatch/,
  );
  assert.doesNotMatch(
    commissionerProduction,
    /migration_mode == 'resume'[\s\S]{0,3000}next-version/,
  );
});

test("release ledger batches every eligible merge after a quiet window", () => {
  assert.match(production, /schedule:/);
  assert.match(production, /cancel-in-progress: false/);
  assert.match(production, /durable release ledger/);
  assert.match(production, /batch_records_json/);
  assert.match(production, /Batch merge SHAs/);
  assert.match(production, /Close batch queue records/);
  assert.match(production, /github-actions\[bot\]/);
  assert.match(queue, /merge_order_at/);
  assert.match(queue, /pr\.merged_at/);
  assert.match(queue, /batchQuietMinutes/);
  assert.match(queue, /hasGlobalBatchHold/);
  assert.match(queue, /validateBatchSnapshot/);
  assert.match(queue, /git\/ref\/heads\/main/);
});

test("Coworld release is pinned to the replay-bundle readiness contract, template-built, collision-checked, and fully certified", () => {
  assert.equal(trustedReleasePolicy.coworld.cliVersion, "0.1.42");
  assert.match(
    production,
    new RegExp(
      `COWORLD_CLI_VERSION: "${trustedReleasePolicy.coworld.cliVersion.replaceAll(".", "\\.")}"`,
    ),
  );
  assert.equal(
    production.match(
      /uv tool install --force "coworld==\$COWORLD_CLI_VERSION"/g,
    )?.length,
    3,
  );
  assert.match(production, /"\$COWORLD_BIN" build --version/);
  assert.match(production, /coworld_manifest_template\.json/);
  assert.match(production, /coworld-authenticated-command\.mjs list --json/);
  assert.match(production, /coworld-authenticated-command\.mjs next-version/);
  assert.match(production, /"\$COWORLD_BIN" certify/);
  assert.match(production, /--wait-hosted-smoke --wait-certification/);
  assert.match(
    production,
    /upload-coworld[^\n]+--timeout-seconds 600 --hosted-smoke-timeout-seconds 1800 --certification-timeout-seconds 1800/,
  );
  assert.match(production, /transcript_summary/);
  assert.match(
    production,
    /coworld-authenticated-command\.mjs replay-open.*--hosted --no-open-browser/,
  );
  assert.match(production, /coworld-published-replay\.mjs/);
  assert.match(production, /\.game\.coworld_id/);
});

test("exact-source images cross into production only as a checksummed inert archive", () => {
  const save = production.indexOf('docker image save "${IMAGES[@]}"');
  const load = production.indexOf("docker image load");
  const upload = production.indexOf(
    "coworld-authenticated-command.mjs upload-coworld",
  );
  assert.ok(save > 0);
  assert.ok(load > save);
  assert.ok(upload > load);
  assert.match(
    production,
    /sha256sum coworld-release\.tgz coworld-images\.tar\.gz coworld-images\.txt coworld-certified-manifests\.json coworld-certification-key\.txt > coworld-release\.sha256/,
  );
  assert.match(production, /sha256sum --check coworld-release\.sha256/);
  assert.match(production, /image_archive_refs != image_values/);
  assert.match(production, /compression-level: 0/);
  assert.doesNotMatch(production, /docker (container )?run/);
});

test("credentialless certification proof is restored before guarded production upload", () => {
  const certify = production.indexOf('"$COWORLD_BIN" certify');
  const cacheArtifact = production.indexOf(
    "coworld-certified-manifests.json",
    certify,
  );
  const restore = production.indexOf(
    'install -m 600 "$RUNNER_TEMP/release-artifact/coworld-certified-manifests.json"',
  );
  const guard = production.indexOf(
    'install -m 755 "$GITHUB_WORKSPACE/.github/scripts/coworld-docker-guard.mjs"',
  );
  const cacheProof = production.indexOf(
    "coworld-certification-cache-key.py",
    restore,
  );
  const upload = production.indexOf(
    "coworld-authenticated-command.mjs upload-coworld",
  );
  assert.ok(certify > 0);
  assert.ok(cacheArtifact > certify);
  assert.ok(restore > cacheArtifact);
  assert.ok(guard > restore);
  assert.ok(cacheProof > guard);
  assert.ok(upload > cacheProof);
  assert.equal(
    production.match(/XDG_CACHE_HOME=\$CERTIFICATION_CACHE/g)?.length,
    2,
  );
  assert.equal(production.match(/\^sha256:\[0-9a-f\]\{64\}\$/g)?.length, 4);
  assert.match(
    production,
    /coworld-certification-key\.txt"\)" =~ \^sha256:\[0-9a-f\]\{64\}\$/,
  );
  assert.match(production, /test "\$ACTUAL_KEY" =/);
  assert.match(
    production,
    /coworld-docker-guard\/docker" run --rm invalid-image/,
  );
  assert.match(production, /test "\$\?" -eq 126/);
});

test("ordinary frontend changes cannot skip replay-viewer rebuild", () => {
  assert.doesNotMatch(production, /paths-ignore:/);
  assert.doesNotMatch(production, /if:.*coworld-adapter/);
  assert.match(production, /build\/static-replay-viewer/);
  assert.match(
    production,
    /grep -r -q -E 'ai-league-replay-progress\|replay_progress_tip' coworld-adapter\/dist\/build\/static-replay-viewer/,
  );
  assert.match(
    production,
    /! grep -r -q -E 'Support Proxy War!\|Purchase a territory skin' coworld-adapter\/dist\/build\/static-replay-viewer/,
  );
  assert.doesNotMatch(production, /grep -R/);
  assert.doesNotMatch(production, /\brg -q/);
});

test("main CI retains PR, push, merge-group, and explicit recursion fallback coverage", () => {
  assert.match(ci, /merge_group:/);
  assert.match(ci, /pull_request:/);
  assert.match(ci, /push:/);
  assert.match(ci, /workflow_dispatch:/);
  assert.match(ci, /🔐 Trusted release automation/);
  assert.match(ci, /ref: \$\{\{ inputs\.source_sha \|\| github\.sha \}\}/);
  assert.match(vite, /\*\*\/tests\/automation\/\*\*/);
});

test("every main CI dependency install uses the bounded retry wrapper", () => {
  assert.doesNotMatch(ci, /- run: npm ci\s*$/m);
  assert.equal(
    ci.match(
      /node artifacts\/trusted-ci-control\/\.github\/scripts\/npm-ci-with-retry\.mjs/g,
    )?.length,
    8,
  );
  assert.match(ci, /ref: main/);
  assert.match(ci, /path: artifacts\/trusted-ci-control/);
  assert.match(
    ci,
    /sparse-checkout: \.github\/scripts\/npm-ci-with-retry\.mjs/,
  );
  assert.match(ci, /persist-credentials: false/);
  assert.match(gitignore, /^artifacts\/$/m);
  assert.match(leagueSourceGuard, /"artifacts"/);
});

test("production retries failed exact-source CI without bypassing it", () => {
  const awaitMainCi = readFileSync(".github/scripts/await-main-ci.mjs", "utf8");
  assert.match(awaitMainCi, /rerun-failed-jobs/);
  assert.match(awaitMainCi, /requiredCiRunAction/);
  assert.match(awaitMainCi, /action === "fail"/);
  assert.doesNotMatch(
    awaitMainCi,
    /conclusion !== "success"[^]*process\.exit\(0\)/,
  );
});

test("workflows never echo or artifact production credentials", () => {
  assert.doesNotMatch(production, /echo.*COWORLD_API_TOKEN/);
  assert.match(production, /actions\/upload-artifact@ea165f8/);
  assert.match(production, /coworld-release\.sha256/);
  assert.doesNotMatch(
    production,
    /upload-artifact[\s\S]{0,500}(credentials|\.softmax)/i,
  );
  assert.doesNotMatch(production, /set -x/);
  assert.match(
    production,
    /Remove any residual ephemeral credential directories/,
  );
  const secretSteps = production
    .split(/\n {6}- name:/)
    .filter((step) => step.includes("secrets.COWORLD_API_TOKEN"));
  assert.ok(secretSteps.length > 0);
  for (const step of secretSteps) {
    assert.doesNotMatch(
      step,
      /npm run|npx |docker |vitest|pytest|\$COWORLD_BIN" (build|certify)/,
    );
  }
});
