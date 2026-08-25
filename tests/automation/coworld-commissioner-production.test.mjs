import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMutationIntent,
  buildMutationReceipt,
  buildReconciliationState,
  certificationState,
  discoverAllocatedCommissionerMutation,
  extractSourceSha,
  parsePatchCommissionerOutput,
  selectImmutableReleaseArtifact,
  selectSuccessfulMainCiRun,
  selectSuccessfulProductionRelease,
  selectSuccessfulProductionRun,
  selectSuccessfulProductionRunCandidates,
  validateCanonicalSourceRelease,
  validateCommissionerImageInspection,
  validateCommissionerOnlyManifestPatch,
  validateFinalMigration,
  validateReleaseArtifact,
  validateResumeIntent,
  validateResumeReference,
} from "../../.github/scripts/coworld-commissioner-production.mjs";

const sha = "a".repeat(40);
const sourceId = "cow_11111111-1111-1111-1111-111111111111";
const patchedId = "cow_22222222-2222-2222-2222-222222222222";
const sourceImage = "img_11111111-1111-1111-1111-111111111111";
const patchedImage = "img_22222222-2222-2222-2222-222222222222";
const leagueId = "league_cb60d526-ecfd-4836-ab3a-81fc6cf7dc42";

function manifest(version, commissionerImage) {
  return {
    game: {
      version,
      runnable: { image: "proxywar-game-local:coworld-0123456789ab" },
      replay_viewer: { bundle: `sha256:${"3".repeat(64)}` },
      docs: {
        pages: [
          {
            id: "proxywar-release-provenance",
            content: { type: "text", value: `source_sha=${sha}\n` },
          },
        ],
      },
    },
    player: [
      {
        id: "proxywar-player",
        image: "proxywar-player-local:coworld-0123456789ab",
      },
      {
        id: "proxywar-player-2",
        image: "proxywar-player-local:coworld-0123456789ab",
      },
    ],
    commissioner: [
      { id: "proxywar-ladder-commissioner", image: commissionerImage },
    ],
    optimizer: [],
  };
}

function status(id, version, image, overrides = {}) {
  return {
    coworld: {
      id,
      version,
      canonical: true,
      manifest_hash: `sha256:${"4".repeat(64)}`,
      manifest: manifest(version, image),
    },
    certification: {
      state: "certified",
      certification_job_id: "33333333-3333-3333-3333-333333333333",
      transcript_summary: Array.from({ length: 10 }, () => ({
        status: "pass",
      })),
    },
    ...overrides,
  };
}

function hostedImage(id, clientHash) {
  return {
    id,
    name: "proxywar-commissioner-local",
    version: 7,
    client_hash: clientHash,
    status: "ready",
    image_uri: null,
    image_digest: `sha256:${"8".repeat(64)}`,
    public_image_uri: null,
  };
}

test("resolves only successful exact-source main CI and production runs", () => {
  const ci = selectSuccessfulMainCiRun(
    {
      workflow_runs: [
        {
          id: 1,
          head_sha: sha,
          head_branch: "main",
          event: "push",
          status: "completed",
          conclusion: "failure",
          created_at: "2026-08-25T00:00:00Z",
        },
        {
          id: 2,
          head_sha: sha,
          head_branch: "main",
          event: "push",
          status: "completed",
          conclusion: "success",
          created_at: "2026-08-25T00:01:00Z",
        },
      ],
    },
    sha,
  );
  assert.equal(ci.mainCiRunId, 2);
  const release = selectSuccessfulProductionRun(
    {
      workflow_runs: [
        {
          id: 3,
          head_sha: sha,
          head_branch: "main",
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
          display_title: `Coworld production ${sha}`,
          created_at: "2026-08-25T00:02:00Z",
        },
        {
          id: 4,
          head_sha: sha,
          head_branch: "main",
          event: "schedule",
          status: "completed",
          conclusion: "success",
          display_title: "Coworld production queue-drain",
          created_at: "2026-08-25T00:03:00Z",
        },
      ],
    },
    sha,
  );
  assert.equal(release.releaseRunId, 4);
  assert.equal(
    selectSuccessfulProductionRun(
      {
        workflow_runs: [
          {
            id: 5,
            head_sha: sha,
            head_branch: "main",
            event: "workflow_dispatch",
            status: "completed",
            conclusion: "success",
            display_title: "Coworld production issue-177",
            created_at: "2026-08-25T00:04:00Z",
          },
        ],
      },
      sha,
    ).releaseRunId,
    5,
  );
  assert.throws(
    () =>
      selectSuccessfulProductionRun(
        { workflow_runs: [{ ...release, id: 4 }] },
        sha,
      ),
    /no successful exact-source/,
  );
});

test("pairs successful production candidates with their own retained artifact", () => {
  const runs = {
    workflow_runs: [
      {
        id: 30,
        head_sha: sha,
        head_branch: "main",
        event: "workflow_dispatch",
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-25T00:02:00Z",
      },
      {
        id: 40,
        head_sha: sha,
        head_branch: "main",
        event: "schedule",
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-25T00:03:00Z",
      },
      {
        id: 50,
        head_sha: sha,
        head_branch: "main",
        event: "schedule",
        status: "completed",
        conclusion: "success",
        created_at: "2026-08-25T00:04:00Z",
      },
    ],
  };
  assert.deepEqual(
    selectSuccessfulProductionRunCandidates(runs, sha).releaseRunIds,
    [50, 40, 30],
  );
  const selected = selectSuccessfulProductionRelease(
    runs,
    {
      runs: [
        {
          runId: 50,
          artifacts: [
            {
              id: 80,
              name: `coworld-release-${sha}`,
              expired: true,
              size_in_bytes: 1234,
            },
          ],
        },
        { runId: 40, artifacts: [] },
        {
          runId: 30,
          artifacts: [
            {
              id: 70,
              name: `coworld-release-${sha}`,
              expired: false,
              size_in_bytes: 1234,
            },
          ],
        },
      ],
    },
    sha,
  );
  assert.equal(selected.releaseRunId, 30);
  assert.equal(selected.releaseArtifactId, 70);
  assert.throws(
    () =>
      selectSuccessfulProductionRelease(
        runs,
        {
          runs: [
            { runId: 50, artifacts: [] },
            { runId: 40, artifacts: [] },
          ],
        },
        sha,
      ),
    /artifacts were not resolved for production run 30/,
  );
});

test("resolves one unexpired, nonempty exact-source artifact", () => {
  const selected = selectImmutableReleaseArtifact(
    {
      artifacts: [
        {
          id: 7,
          name: `coworld-release-${sha}`,
          expired: false,
          size_in_bytes: 1234,
        },
      ],
    },
    sha,
  );
  assert.equal(selected.releaseArtifactId, 7);
  assert.throws(
    () =>
      selectImmutableReleaseArtifact(
        {
          artifacts: [
            {
              ...selected,
              id: 7,
              name: `coworld-release-${sha}`,
              expired: true,
              size_in_bytes: 1,
            },
          ],
        },
        sha,
      ),
    /expired/,
  );
});

test("validates certified canonical exact-source package and league binding", () => {
  const sourceStatus = status(sourceId, "0.1.62", sourceImage);
  const result = validateCanonicalSourceRelease({
    expectedSourceSha: sha,
    coworlds: [
      {
        id: sourceId,
        name: "proxywar",
        version: "0.1.62",
        canonical: true,
        manifest: sourceStatus.coworld.manifest,
      },
    ],
    status: sourceStatus,
    league: {
      id: leagueId,
      game: { coworld_id: sourceId },
      commissioner_key: "platform",
      rounds_paused_at: null,
      commissioner_migration_version: `sha256:${"5".repeat(64)}`,
    },
  });
  assert.equal(result.sourceCoworldId, sourceId);
  assert.equal(extractSourceSha(sourceStatus.coworld.manifest), sha);
  assert.throws(
    () =>
      validateCanonicalSourceRelease({
        expectedSourceSha: sha,
        coworlds: [],
        status: sourceStatus,
        league: {},
      }),
    /canonical ProxyWar Coworld/,
  );
});

test("commissioner-only manifest comparison rejects every unrelated mutation", () => {
  const sourceManifest = manifest("0.1.62", sourceImage);
  const patchedManifest = manifest("0.1.63", patchedImage);
  assert.doesNotThrow(() =>
    validateCommissionerOnlyManifestPatch({
      sourceManifest,
      patchedManifest,
      sourceCommissionerImage: sourceImage,
      patchedCommissionerImage: patchedImage,
    }),
  );
  const corruptions = [
    (value) => {
      value.game.runnable.image = "img_33333333-3333-3333-3333-333333333333";
    },
    (value) => {
      value.player[0].image = "img_33333333-3333-3333-3333-333333333333";
    },
    (value) => {
      value.optimizer.push({
        id: "unexpected-optimizer",
        image: "img_33333333-3333-3333-3333-333333333333",
      });
    },
    (value) => {
      value.game.replay_viewer.bundle = `sha256:${"8".repeat(64)}`;
    },
    (value) => {
      value.game.environment = { PROXYWAR_UNEXPECTED: "1" };
    },
    (value) => {
      value.game.docs.pages[0].content.value += "changed=true\n";
    },
  ];
  for (const mutate of corruptions) {
    const corrupted = structuredClone(patchedManifest);
    mutate(corrupted);
    assert.throws(
      () =>
        validateCommissionerOnlyManifestPatch({
          sourceManifest,
          patchedManifest: corrupted,
          sourceCommissionerImage: sourceImage,
          patchedCommissionerImage: patchedImage,
        }),
      /changed outside/,
    );
  }
});

test("release validation binds the exact local commissioner image and deduplicated image inventory", () => {
  const releaseManifest = manifest(
    "0.1.62",
    "proxywar-commissioner-local:coworld-0123456789ab",
  );
  const imageList = [
    "proxywar-commissioner-local:coworld-0123456789ab",
    "proxywar-game-local:coworld-0123456789ab",
    "proxywar-player-local:coworld-0123456789ab",
  ];
  const result = validateReleaseArtifact({
    expectedSourceSha: sha,
    expectedVersion: "0.1.62",
    releaseMetadata: { source_sha: sha, version: "0.1.62" },
    manifest: releaseManifest,
    imageList,
  });
  assert.equal(result.localCommissionerImage, imageList[0]);
  assert.throws(
    () =>
      validateReleaseArtifact({
        expectedSourceSha: sha,
        expectedVersion: "0.1.62",
        releaseMetadata: { source_sha: sha, version: "0.1.62" },
        manifest: releaseManifest,
        imageList: imageList.slice().reverse(),
      }),
    /image inventory/,
  );
});

test("commissioner image inspection is exactly one tagged linux-amd64 image", () => {
  const image = "proxywar-commissioner-local:coworld-0123456789ab";
  const result = validateCommissionerImageInspection({
    image,
    inspection: [
      {
        Id: `sha256:${"6".repeat(64)}`,
        Os: "linux",
        Architecture: "amd64",
        RepoTags: [image],
      },
    ],
  });
  assert.equal(result.platform, "linux/amd64");
  assert.throws(
    () =>
      validateCommissionerImageInspection({
        image,
        inspection: [
          {
            Id: `sha256:${"6".repeat(64)}`,
            Os: "linux",
            Architecture: "arm64",
            RepoTags: [image],
          },
        ],
      }),
    /linux\/amd64/,
  );
});

test("patch output and certification states fail closed", () => {
  const patch = parsePatchCommissionerOutput(
    `Patched commissioner: proxywar:0.1.63\nCoworld: ${patchedId}\nCommissioner image: ${patchedImage}\nCanonical: yes\n`,
  );
  assert.equal(patch.patchedCommissionerImageId, patchedImage);
  assert.throws(
    () =>
      parsePatchCommissionerOutput(
        `Patched commissioner: proxywar:0.1.63\nCoworld: ${patchedId}\nCommissioner image: ${patchedImage}\nCanonical: no\n`,
      ),
    /Canonical:/,
  );
  assert.equal(
    certificationState(status(patchedId, "0.1.63", patchedImage)),
    "ready",
  );
  assert.equal(
    certificationState({ certification: { state: "failed" } }),
    "failed",
  );
  assert.equal(
    certificationState({ certification: { state: "running" } }),
    "pending",
  );
});

test("pre-mutation authority recovers an exact successful mutation after output and receipt loss", () => {
  const controlSha = "b".repeat(40);
  const dispatchSha = "c".repeat(40);
  const source = {
    sourceSha: sha,
    sourceCoworldId: sourceId,
    sourceCoworldVersion: "0.1.62",
    sourceCommissionerImageId: sourceImage,
    commissionerRunnableId: "proxywar-ladder-commissioner",
    previousCommissionerMigrationVersion: `sha256:${"5".repeat(64)}`,
  };
  const image = {
    localCommissionerImage: "proxywar-commissioner-local:coworld-0123456789ab",
    localCommissionerImageId: `sha256:${"6".repeat(64)}`,
    platform: "linux/amd64",
  };
  const context = {
    controlSha,
    workflowRunId: 101,
    mainCiRunId: 102,
    releaseRunId: 103,
    releaseArtifactId: 104,
    releaseArtifactName: `coworld-release-${sha}`,
    releaseArtifactBytes: 2048,
  };
  const intent = buildMutationIntent({
    expectedSourceSha: sha,
    context,
    source,
    targetVersion: "0.1.63",
    image,
  });
  const workflowRun = {
    id: 101,
    path: ".github/workflows/coworld-commissioner-production.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: dispatchSha,
    status: "completed",
    conclusion: "failure",
  };
  const artifact = {
    id: 105,
    name: `coworld-commissioner-mutation-${sha}-101`,
    expired: false,
    size_in_bytes: 4096,
    workflow_run: { id: 101, head_sha: dispatchSha },
  };
  const resumed = validateResumeIntent({
    expectedSourceSha: sha,
    expectedWorkflowRunId: 101,
    expectedArtifactId: 105,
    workflowRun,
    artifact,
    intent,
  });
  assert.equal(resumed.target.patchedCoworldVersion, "0.1.63");
  assert.equal(resumed.source.sourceCoworldId, sourceId);
  const historicalSource = status(sourceId, "0.1.62", sourceImage);
  historicalSource.coworld.canonical = false;
  const discovered = discoverAllocatedCommissionerMutation({
    expectedSourceSha: sha,
    intent,
    coworlds: [
      {
        id: patchedId,
        name: "proxywar",
        version: "0.1.63",
        canonical: true,
        manifest: manifest("0.1.63", patchedImage),
      },
    ],
    sourceStatus: historicalSource,
    hostedImage: hostedImage(patchedImage, image.localCommissionerImageId),
  });
  assert.deepEqual(discovered, {
    patchedCoworldVersion: "0.1.63",
    patchedCoworldId: patchedId,
    patchedCommissionerImageId: patchedImage,
    canonical: true,
  });

  const diagnosticReceipt = buildMutationReceipt({
    expectedSourceSha: sha,
    context,
    source,
    patch: discovered,
    image,
  });
  assert.equal(diagnosticReceipt.stage, "mutation-returned");
  assert.match(diagnosticReceipt.recoveryProcedure, /diagnostic only/);

  assert.throws(
    () =>
      validateResumeReference({
        expectedSourceSha: sha,
        expectedWorkflowRunId: 999,
        expectedArtifactId: 105,
        workflowRun,
        artifact,
      }),
    /workflow run identity/,
  );
  assert.throws(
    () =>
      validateResumeReference({
        expectedSourceSha: sha,
        expectedWorkflowRunId: 101,
        expectedArtifactId: 105,
        workflowRun: { ...workflowRun, conclusion: "success" },
        artifact,
      }),
    /completed unsuccessful migration/,
  );
  assert.throws(
    () =>
      validateResumeReference({
        expectedSourceSha: sha,
        expectedWorkflowRunId: 101,
        expectedArtifactId: 105,
        workflowRun,
        artifact: { ...artifact, size_in_bytes: 64 * 1024 + 1 },
      }),
    /byte bound/,
  );
  assert.throws(
    () =>
      validateResumeIntent({
        expectedSourceSha: sha,
        expectedWorkflowRunId: 101,
        expectedArtifactId: 105,
        workflowRun,
        artifact,
        intent: {
          ...intent,
          target: { ...intent.target, untrustedTargetField: sourceId },
        },
      }),
    /unexpected fields/,
  );
  assert.throws(
    () =>
      discoverAllocatedCommissionerMutation({
        expectedSourceSha: sha,
        intent,
        coworlds: [
          {
            id: patchedId,
            name: "proxywar",
            version: "0.1.63",
            canonical: true,
            manifest: {
              ...manifest("0.1.63", patchedImage),
              untrustedMutation: true,
            },
          },
        ],
        sourceStatus: historicalSource,
        hostedImage: hostedImage(patchedImage, image.localCommissionerImageId),
      }),
    /changed outside package version and commissioner image/,
  );
  assert.throws(
    () =>
      discoverAllocatedCommissionerMutation({
        expectedSourceSha: sha,
        intent,
        coworlds: [
          {
            id: patchedId,
            name: "proxywar",
            version: "0.1.63",
            canonical: true,
            manifest: manifest("0.1.63", patchedImage),
          },
        ],
        sourceStatus: historicalSource,
        hostedImage: hostedImage(patchedImage, `sha256:${"9".repeat(64)}`),
      }),
    /does not match the authorized local config digest/,
  );
});

test("reconciliation evidence exposes only strict status and league projections", () => {
  const source = {
    sourceSha: sha,
    sourceCoworldId: sourceId,
    sourceCoworldVersion: "0.1.62",
    sourceCommissionerImageId: sourceImage,
    commissionerRunnableId: "proxywar-ladder-commissioner",
    previousCommissionerMigrationVersion: `sha256:${"5".repeat(64)}`,
  };
  const observedStatus = status(patchedId, "0.1.63", patchedImage);
  observedStatus.privateCredentialCanary = "AUTHENTICATED_STATUS_SECRET";
  observedStatus.coworld.manifest.privatePayload =
    "AUTHENTICATED_MANIFEST_SECRET";
  const observedLeague = {
    id: leagueId,
    game: { coworld_id: patchedId },
    commissioner_key: "platform",
    rounds_paused_at: null,
    commissioner_migration_version: `sha256:${"7".repeat(64)}`,
    privateCredentialCanary: "AUTHENTICATED_LEAGUE_SECRET",
  };
  const projected = buildReconciliationState({
    expectedSourceSha: sha,
    controlSha: "b".repeat(40),
    workflowRunId: 101,
    source,
    patch: {
      patchedCoworldVersion: "0.1.63",
      patchedCoworldId: patchedId,
      patchedCommissionerImageId: patchedImage,
      canonical: true,
    },
    observedStatus,
    observedLeague,
    statusExit: "0",
    leagueExit: "0",
    resumeWorkflowRunId: 100,
    resumeArtifactId: 105,
  });
  assert.deepEqual(Object.keys(projected.observedStatus).sort(), [
    "canonical",
    "certificationJobId",
    "certificationPassed",
    "certificationState",
    "commissionerImageId",
    "commissionerRunnableId",
    "coworldId",
    "coworldVersion",
    "manifestHash",
    "replayBundle",
    "sourceSha",
  ]);
  assert.deepEqual(Object.keys(projected.observedLeague).sort(), [
    "boundCoworldId",
    "commissionerKey",
    "commissionerMigrationVersion",
    "leagueId",
    "platformLadderEnabled",
  ]);
  assert.equal(projected.automaticRollback, false);
  assert.deepEqual(projected.resumeReference, {
    previousWorkflowRunId: 100,
    mutationAuthorityArtifactId: 105,
  });
  assert.doesNotMatch(JSON.stringify(projected), /AUTHENTICATED_.*_SECRET/);
  assert.doesNotMatch(JSON.stringify(projected), /privatePayload/);
});

test("reconciliation retains resume authority when patch output and receipt are absent", () => {
  const projected = buildReconciliationState({
    expectedSourceSha: sha,
    controlSha: "b".repeat(40),
    workflowRunId: 101,
    source: {
      sourceSha: sha,
      sourceCoworldId: sourceId,
      sourceCoworldVersion: "0.1.62",
      sourceCommissionerImageId: sourceImage,
      commissionerRunnableId: "proxywar-ladder-commissioner",
      previousCommissionerMigrationVersion: `sha256:${"5".repeat(64)}`,
    },
    patch: {},
    observedStatus: {},
    observedLeague: {},
    statusExit: "not-attempted",
    leagueExit: "not-attempted",
    resumeWorkflowRunId: 101,
    resumeArtifactId: 105,
  });
  assert.equal(projected.patch, null);
  assert.deepEqual(projected.resumeReference, {
    previousWorkflowRunId: 101,
    mutationAuthorityArtifactId: 105,
  });
});

test("final migration requires changed migration identity and exact patched binding", () => {
  const previous = `sha256:${"5".repeat(64)}`;
  const next = `sha256:${"7".repeat(64)}`;
  const preflight = {
    sourceCoworldId: sourceId,
    sourceCoworldVersion: "0.1.62",
    sourceCommissionerImageId: sourceImage,
    previousCommissionerMigrationVersion: previous,
  };
  const patch = {
    patchedCoworldId: patchedId,
    patchedCoworldVersion: "0.1.63",
    patchedCommissionerImageId: patchedImage,
    canonical: true,
  };
  const patchedStatus = status(patchedId, "0.1.63", patchedImage);
  const historicalSourceStatus = status(sourceId, "0.1.62", sourceImage);
  historicalSourceStatus.coworld.canonical = false;
  const evidence = validateFinalMigration({
    expectedSourceSha: sha,
    expectedVersion: "0.1.63",
    preflight,
    patch,
    sourceStatus: historicalSourceStatus,
    status: patchedStatus,
    league: {
      id: leagueId,
      game: { coworld_id: patchedId },
      commissioner_key: "platform",
      rounds_paused_at: null,
      commissioner_migration_version: next,
    },
  });
  assert.equal(evidence.commissionerMigrationVersionAfter, next);
  assert.equal(evidence.sourceCommissionerImageId, sourceImage);
  assert.throws(
    () =>
      validateFinalMigration({
        expectedSourceSha: sha,
        expectedVersion: "0.1.63",
        preflight,
        patch,
        sourceStatus: status(sourceId, "0.1.62", sourceImage),
        status: patchedStatus,
        league: {
          id: leagueId,
          game: { coworld_id: patchedId },
          commissioner_key: "platform",
          rounds_paused_at: null,
          commissioner_migration_version: previous,
        },
      }),
    /did not change/,
  );
});
