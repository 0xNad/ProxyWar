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
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const queue = readFileSync(".github/scripts/coworld-queue.mjs", "utf8");
const vite = readFileSync("vite.config.ts", "utf8");

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

test("release queue is durable beyond GitHub concurrency coalescing", () => {
  assert.match(production, /schedule:/);
  assert.match(production, /cancel-in-progress: false/);
  assert.match(production, /durable FIFO/);
  assert.match(production, /github-actions\[bot\]/);
  assert.match(queue, /merge_order_at/);
  assert.match(queue, /pr\.merged_at/);
});

test("Coworld release is pinned, template-built, collision-checked, and fully certified", () => {
  assert.match(production, /COWORLD_CLI_VERSION: "0\.1\.38"/);
  assert.match(production, /"\$COWORLD_BIN" build --version/);
  assert.match(production, /coworld_manifest_template\.json/);
  assert.match(production, /coworld-authenticated-command\.mjs list --json/);
  assert.match(production, /coworld-authenticated-command\.mjs next-version/);
  assert.match(production, /"\$COWORLD_BIN" certify/);
  assert.match(production, /--wait-hosted-smoke --wait-certification/);
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
      /node \.trusted-ci-control\/\.github\/scripts\/npm-ci-with-retry\.mjs/g,
    )?.length,
    7,
  );
  assert.match(ci, /ref: main/);
  assert.match(ci, /path: \.trusted-ci-control/);
  assert.match(
    ci,
    /sparse-checkout: \.github\/scripts\/npm-ci-with-retry\.mjs/,
  );
  assert.match(ci, /persist-credentials: false/);
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
