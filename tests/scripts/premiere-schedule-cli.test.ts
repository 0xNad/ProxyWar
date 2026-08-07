import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFeaturedMatchStore } from "../../src/server/agents/FeaturedMatch";
import {
  findEventPackage,
  readEventPackageStore,
} from "../../src/server/agents/season/EventPackage";

/**
 * Real subprocess (`tsx`) end-to-end coverage of the four
 * `premiere:schedule`/`validate`/`publish`/`cancel` CLI ENTRY POINTS —
 * not just their shared library functions (covered separately in
 * `premiere-schedule-lib.test.ts`). Proves argv parsing, exit codes, and
 * the real `isMainModule` dispatch actually work, matching the pattern
 * `premiere-candidates.ts`'s/`feature-candidates.ts`'s own test suites
 * already established this session.
 */
const repoRoot = path.resolve(__dirname, "../..");
const scriptsDir = path.join(repoRoot, "src", "scripts");

function runCli(
  scriptName: string,
  args: string[],
  roots: { queueRoot: string; artifactsRoot: string; stateRoot: string },
): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      "npx",
      [
        "tsx",
        path.join(scriptsDir, scriptName),
        `--queue-root=${roots.queueRoot}`,
        `--artifacts-root=${roots.artifactsRoot}`,
        `--state-root=${roots.stateRoot}`,
        ...args,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        // A fresh subprocess reads env at its OWN module-load time (unlike
        // an in-process test call, which would freeze to whatever
        // resolveIdentityRegistryDir() saw at THIS FILE's first import —
        // see feature-candidates.test.ts's own doc on that trap). Pointed
        // at artifactsRoot so every test gets an ISOLATED registry rather
        // than silently falling back to the real resources/identity/.
        env: {
          ...process.env,
          PROXYWAR_IDENTITY_REGISTRY_DIR: roots.artifactsRoot,
        },
      },
    );
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status: number; stdout: Buffer; stderr: Buffer };
    return {
      code: err.status,
      stdout: err.stdout?.toString("utf8") ?? "",
      stderr: err.stderr?.toString("utf8") ?? "",
    };
  }
}

interface SeatFixture {
  seatId: string;
  displayName: string;
  policyName: string;
}

const DEFAULT_SEATS: SeatFixture[] = [
  { seatId: "c1", displayName: "PlayerA", policyName: "player-a-intent:v1" },
  { seatId: "c2", displayName: "PlayerB", policyName: "player-b-intent:v1" },
];

async function writeQueueItem(
  queueRoot: string,
  name: string,
  overrides: Record<string, unknown> = {},
  seats: readonly SeatFixture[] | "malformed" | "missing" = DEFAULT_SEATS,
): Promise<void> {
  const dir = path.join(queueRoot, "ready", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "real-league",
      runId: name,
      sourceFile: "bundle.source.json",
      sha256: "abc",
      turnCount: 9000,
      seatCount: 16,
      map: "world",
      checkpointTurns: [3150, 5850],
      turnIntervalMs: 120,
      coworldId: "cow_x",
      variantId: "v1",
      episodeId: null,
      experienceRequestId: `ereq_${name}`,
      generatedAt: new Date().toISOString(),
      ...overrides,
    }),
    "utf8",
  );
  if (seats === "missing") {
    return;
  }
  if (seats === "malformed") {
    await writeFile(path.join(dir, "bundle.source.json"), "{}", "utf8");
    return;
  }
  await writeFile(
    path.join(dir, "bundle.source.json"),
    JSON.stringify({
      schemaVersion: 1,
      bundleKind: "proxywar_rated_coworld_source",
      sourceRunId: name,
      // Present ONLY to prove resolveSealedBundleParticipants's schema
      // strips result-bearing fields — never asserted on below.
      gameRecord: { info: { players: [] } },
      authoritativeResult: { encoding: "base64", bytes: "AA==", sha256: "x" },
      seats: seats.map((seat) => ({
        seatId: seat.seatId,
        displayName: seat.displayName,
        policyIdentity: {
          namespace: "softmax_policy_version",
          policyVersionId: `pv_${seat.seatId}`,
          policyName: seat.policyName,
          serverAssignedVersion: "v1",
        },
      })),
    }),
    "utf8",
  );
}

/** Minimal empty tracked-identity-shaped registry — same convention `premiere-package.test.ts` established, so `loadIdentityRegistrySnapshot` succeeds against an isolated throwaway directory rather than the real repo one. */
async function writeEmptyIdentityRegistry(dir: string): Promise<void> {
  await writeFile(
    path.join(dir, "builders.json"),
    JSON.stringify({ schemaVersion: 1, builders: [] }),
    "utf8",
  );
  await writeFile(
    path.join(dir, "agents.json"),
    JSON.stringify({ schemaVersion: 1, agents: [] }),
    "utf8",
  );
  await writeFile(
    path.join(dir, "versions.json"),
    JSON.stringify({ schemaVersion: 1, versions: [] }),
    "utf8",
  );
}

describe("premiere schedule CLIs — real subprocess end to end", () => {
  let queueRoot: string;
  let artifactsRoot: string;
  let stateRoot: string;

  beforeEach(async () => {
    queueRoot = await mkdtemp(path.join(os.tmpdir(), "pw-cli-queue-"));
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-cli-artifacts-"));
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "pw-cli-state-"));
    await writeEmptyIdentityRegistry(artifactsRoot);
    await writeQueueItem(queueRoot, "runA");
  });

  afterEach(async () => {
    await Promise.all(
      [queueRoot, artifactsRoot, stateRoot].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  const roots = () => ({ queueRoot, artifactsRoot, stateRoot });

  it("full lifecycle: schedule -> validate (ok) -> publish -> cancel", async () => {
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const scheduleResult = runCli(
      "premiere-schedule.ts",
      [`--episode=ereq_runA`, `--at=${at}`, "--json"],
      roots(),
    );
    expect(scheduleResult.code).toBe(0);
    const scheduled = JSON.parse(scheduleResult.stdout).scheduled;
    expect(scheduled.state).toBe("scheduled");
    expect(scheduled.scheduledAt).toBe(at);
    // The bug this session fixed: participants used to be permanently [].
    expect(scheduled.participants).toHaveLength(2);
    expect(
      scheduled.participants.map((p: { playerName: string }) => p.playerName),
    ).toEqual(["PlayerA", "PlayerB"]);

    const store1 = await readFeaturedMatchStore(stateRoot);
    expect(store1.matches).toHaveLength(1);
    expect(store1.matches[0]?.state).toBe("scheduled");

    const validateResult = runCli("premiere-validate.ts", ["--json"], roots());
    expect(validateResult.code).toBe(0);
    expect(JSON.parse(validateResult.stdout).ok).toBe(true);

    const publishResult = runCli(
      "premiere-publish.ts",
      [`--episode=${scheduled.matchId}`, "--json"],
      roots(),
    );
    expect(publishResult.code).toBe(0);
    expect(JSON.parse(publishResult.stdout).published.state).toBe("published");

    const cancelResult = runCli(
      "premiere-cancel.ts",
      [`--episode=${scheduled.matchId}`, "--json"],
      roots(),
    );
    expect(cancelResult.code).toBe(0);
    expect(JSON.parse(cancelResult.stdout).cancelled.state).toBe("cancelled");

    const store2 = await readFeaturedMatchStore(stateRoot);
    expect(store2.matches[0]?.state).toBe("cancelled");
    expect(store2.matches[0]?.scheduledAt).toBeNull();
  }, 30000);

  it("refuses to schedule an already-published episode with the named rejection reason", async () => {
    await mkdir(path.join(artifactsRoot, "ai-league-runs", "league"), {
      recursive: true,
    });
    await writeFile(
      path.join(artifactsRoot, "ai-league-runs", "league", "data.json"),
      JSON.stringify({ episodes: [{ episodeRequestId: "ereq_runA" }] }),
      "utf8",
    );
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = runCli(
      "premiere-schedule.ts",
      [`--episode=ereq_runA`, `--at=${at}`],
      roots(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already_published_on_league");
  }, 30000);

  it("refuses to schedule a past-dated time", async () => {
    const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = runCli(
      "premiere-schedule.ts",
      [`--episode=ereq_runA`, `--at=${at}`],
      roots(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("scheduled_at_in_past");
  }, 30000);

  it("refuses to schedule two premieres too close together", async () => {
    await writeQueueItem(queueRoot, "runB");
    const at1 = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const r1 = runCli(
      "premiere-schedule.ts",
      [`--episode=ereq_runA`, `--at=${at1}`],
      roots(),
    );
    expect(r1.code).toBe(0);

    const at2 = new Date(Date.parse(at1) + 5 * 60 * 1000).toISOString(); // 5 minutes later
    const r2 = runCli(
      "premiere-schedule.ts",
      [`--episode=ereq_runB`, `--at=${at2}`],
      roots(),
    );
    expect(r2.code).toBe(1);
    expect(r2.stderr).toContain("schedule_collision");
  }, 30000);

  it("premiere:validate reports a real issue when a scheduled queue item disappears", async () => {
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduleResult = runCli(
      "premiere-schedule.ts",
      [`--episode=ereq_runA`, `--at=${at}`, "--json"],
      roots(),
    );
    expect(scheduleResult.code).toBe(0);

    // Simulate cycle-premiere.sh consuming the queue item out from under the schedule.
    await rm(path.join(queueRoot, "ready", "runA"), {
      recursive: true,
      force: true,
    });

    const validateResult = runCli("premiere-validate.ts", ["--json"], roots());
    expect(validateResult.code).toBe(1);
    const parsed = JSON.parse(validateResult.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues[0].reason).toContain("queue_item_missing");
  }, 30000);

  it("premiere:cancel refuses to cancel a record that was never scheduled", async () => {
    const result = runCli(
      "premiere-cancel.ts",
      ["--episode=nonexistent"],
      roots(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not found");
  }, 30000);

  it("premiere:publish refuses to publish before scheduling", async () => {
    const result = runCli(
      "premiere-publish.ts",
      ["--episode=ereq_runA"],
      roots(),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not found");
  }, 30000);
});

/**
 * The real bug this session fixed, end to end: a sealed premiere-lane
 * candidate used to be STRUCTURALLY unable to ever pass
 * `EventPackageGate.isPubliclyPromotable` (participants stayed `[]`
 * forever). This proves the full operator workflow §8.5 documents
 * (schedule -> package -> validate -> publish) now produces a record the
 * gate accepts, with a real evidence-backed lineup — and that the
 * failure mode (a bundle with no resolvable roster) hard-fails at
 * schedule time rather than silently producing another unpromotable
 * record.
 */
describe("premiere-schedule -> premiere-package: the sealed-lane participants gate fix", () => {
  let queueRoot: string;
  let artifactsRoot: string;
  let stateRoot: string;

  beforeEach(async () => {
    queueRoot = await mkdtemp(path.join(os.tmpdir(), "pw-gatefix-queue-"));
    artifactsRoot = await mkdtemp(
      path.join(os.tmpdir(), "pw-gatefix-artifacts-"),
    );
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "pw-gatefix-state-"));
  });

  afterEach(async () => {
    await Promise.all(
      [queueRoot, artifactsRoot, stateRoot].map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  const roots = () => ({ queueRoot, artifactsRoot, stateRoot });

  function runPackageCli(args: string[]): {
    code: number;
    stdout: string;
    stderr: string;
  } {
    try {
      const stdout = execFileSync(
        "npx",
        ["tsx", path.join(scriptsDir, "premiere-package.ts"), ...args],
        {
          cwd: repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PROXYWAR_FEATURED_MATCH_STATE_ROOT: stateRoot,
            PROXYWAR_EVENT_PACKAGE_STATE_ROOT: stateRoot,
            PROXYWAR_ARTIFACTS_ROOT: artifactsRoot,
            PROXYWAR_IDENTITY_REGISTRY_DIR: artifactsRoot,
          },
        },
      );
      return { code: 0, stdout, stderr: "" };
    } catch (error) {
      const err = error as { status: number; stdout: Buffer; stderr: Buffer };
      return {
        code: err.status,
        stdout: err.stdout?.toString("utf8") ?? "",
        stderr: err.stderr?.toString("utf8") ?? "",
      };
    }
  }

  async function writeRealIdentity(now: Date): Promise<void> {
    await writeFile(
      path.join(artifactsRoot, "builders.json"),
      JSON.stringify({ schemaVersion: 1, builders: [] }),
      "utf8",
    );
    await writeFile(
      path.join(artifactsRoot, "agents.json"),
      JSON.stringify({
        schemaVersion: 1,
        agents: [
          {
            id: "agt_auri",
            slug: "auri",
            displayName: "Auri",
            shortCode: "AURI",
            builderId: null,
            tagline: null,
            description: null,
            emblem: {
              style: "geometric-svg-v1",
              seed: "agt_auri",
              assetPath: "resources/identity/emblems/agt_auri.svg",
            },
            primaryColor: "#112233",
            secondaryColor: "#445566",
            debutDate: null,
            policyMatchRule: {
              playerName: "Auri",
              policyFamily: "auri-intent",
            },
            status: "unclaimed",
            publicStrategyDescription: null,
          },
          {
            id: "agt_sefirot",
            slug: "sefirot",
            displayName: "Sefirot",
            shortCode: "SEFI",
            builderId: null,
            tagline: null,
            description: null,
            emblem: {
              style: "geometric-svg-v1",
              seed: "agt_sefirot",
              assetPath: "resources/identity/emblems/agt_sefirot.svg",
            },
            primaryColor: "#667788",
            secondaryColor: "#99aabb",
            debutDate: null,
            policyMatchRule: {
              playerName: "Sefirot",
              policyFamily: "sefirot-intent",
            },
            status: "unclaimed",
            publicStrategyDescription: null,
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      path.join(artifactsRoot, "versions.json"),
      JSON.stringify({
        schemaVersion: 1,
        versions: [
          {
            id: "agtv_auri_v43",
            agentId: "agt_auri",
            publicVersionLabel: "v43",
            softmaxPolicyLabel: "auri-intent:v43",
            immutableDigest: null,
            releaseDate: null,
            releaseNotes: null,
            declaredBaseModel: null,
            scaffoldDescription: null,
            sourceRepositoryRef: null,
            disclosureStatus: "undisclosed",
            qualificationStatus: "active",
            observedVia: ["rating"],
            observedAt: now.toISOString(),
            // Within versionDebutClaim's 14-day window -> guarantees a
            // real evidence-backed reason-to-watch claim, no fabrication.
            firstObservedAt: now.toISOString(),
          },
          {
            id: "agtv_sefirot_v10",
            agentId: "agt_sefirot",
            publicVersionLabel: "v10",
            softmaxPolicyLabel: "sefirot-intent:v10",
            immutableDigest: null,
            releaseDate: null,
            releaseNotes: null,
            declaredBaseModel: null,
            scaffoldDescription: null,
            sourceRepositoryRef: null,
            disclosureStatus: "undisclosed",
            qualificationStatus: "active",
            observedVia: ["rating"],
            observedAt: now.toISOString(),
            firstObservedAt: null,
          },
        ],
      }),
      "utf8",
    );
  }

  async function writeMirrorEpisode(episodeRequestId: string): Promise<void> {
    const siteDir = path.join(artifactsRoot, "ai-league-runs", "league");
    await mkdir(siteDir, { recursive: true });
    await writeFile(
      path.join(siteDir, "data.json"),
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        lastGoodSyncAt: new Date().toISOString(),
        stale: false,
        league: {
          id: "league_test",
          name: "Test League",
          description: null,
          divisionName: "Open",
          roundIntervalMinutes: null,
          episodesPerRound: null,
          currentRoundNumber: null,
          currentRoundStatus: null,
          scoreLabel: "Score",
        },
        standings: [],
        rounds: [],
        episodes: [
          {
            episodeRequestId,
            shortId: "AB1",
            roundNumber: 1,
            completedAt: null,
            map: "Pangaea",
            mapSize: "Normal",
            turnCount: 9000,
            decisionCount: null,
            degradedCount: null,
            winnerName: null,
            players: [],
            watchHref: null,
            fullRenderHref: null,
          },
        ],
        links: {
          enterTheLeagueUrl: "https://example.test",
          platformLabel: "Coworld",
        },
      }),
      "utf8",
    );
  }

  it("sealed-lane candidate -> package -> validate -> publish passes the gate with a real lineup, reading zero result-bearing fields pre-reveal", async () => {
    const now = new Date();
    await writeEmptyIdentityRegistry(artifactsRoot); // overwritten below with real data
    await writeRealIdentity(now);
    await writeQueueItem(
      queueRoot,
      "runGate",
      { experienceRequestId: "ereq_runGate" },
      [
        { seatId: "c1", displayName: "Auri", policyName: "auri-intent:v43" },
        {
          seatId: "c2",
          displayName: "Sefirot",
          policyName: "sefirot-intent:v10",
        },
      ],
    );

    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const scheduleResult = runCli(
      "premiere-schedule.ts",
      [`--episode=ereq_runGate`, `--at=${at}`, "--json"],
      roots(),
    );
    expect(scheduleResult.code).toBe(0);
    const scheduled = JSON.parse(scheduleResult.stdout).scheduled;
    expect(scheduled.participants).toEqual([
      {
        playerName: "Auri",
        agentId: "agt_auri",
        agentVersionId: "agtv_auri_v43",
        builderId: null,
      },
      {
        playerName: "Sefirot",
        agentId: "agt_sefirot",
        agentVersionId: "agtv_sefirot_v10",
        builderId: null,
      },
    ]);

    // Seeded AFTER scheduling, deliberately: `premiere:schedule`'s own
    // pre-flight (rightly) refuses to schedule a FRESH candidate whose
    // episodeRequestId already appears in the live mirror
    // (`already_published_on_league` — a sealed premiere and an
    // already-public mirror episode are mutually exclusive by
    // definition). `premiere:package`'s reason-to-watch lookup is a
    // separate, later read of that same mirror with no such exclusivity
    // check — this ordering isolates "does the full
    // package/validate/publish chain accept an already-resolved lineup"
    // without depending on how/when mirror evidence becomes available
    // for a still-embargoed premiere (a real, separate gap —
    // decisions.jsonl is deleted at seal time, same limitation this
    // module's own drama/story evidence notes already document — out of
    // this fix's scope, which is participants only).
    await writeMirrorEpisode("ereq_runGate");

    // premiere:publish also re-validates the participants guard directly
    // (defense in depth) — must succeed given a real lineup.
    // `premiere:package`'s gate requires `state: "published"` for
    // premiere-lane records (EventPackageGate.ts's `not_yet_published`
    // check — "an operator hasn't committed to running this yet" must
    // never be publicly promotable), so publish runs BEFORE package.
    const publishResult = runCli(
      "premiere-publish.ts",
      [`--episode=${scheduled.matchId}`, "--json"],
      roots(),
    );
    expect(publishResult.code).toBe(0);
    expect(JSON.parse(publishResult.stdout).published.state).toBe("published");

    const packageResult = runPackageCli([`--featured=${scheduled.matchId}`]);
    expect(packageResult.code).toBe(0);
    expect(packageResult.stdout).toContain("isPubliclyPromotable: true");

    const validateResult = runCli("premiere-validate.ts", ["--json"], roots());
    expect(validateResult.code).toBe(0);

    const validateOnlyResult = runPackageCli([
      `--featured=${scheduled.matchId}`,
      "--validate",
    ]);
    expect(validateOnlyResult.code).toBe(0);
    expect(validateOnlyResult.stdout).toContain("isPubliclyPromotable: true");

    // Confirm the package's own reason-to-watch is real, evidence-backed
    // prose (version_debut, referencing the exact AgentVersion + its
    // firstObservedAt) — never a fabricated filler claim. `premiere:package`
    // itself never prints the draft as pure-JSON stdout (its own
    // `printCompleteness` text always follows the `--json` dump — see
    // premiere-package.test.ts's identical convention of never
    // JSON.parse-ing that CLI's stdout), so read the persisted store
    // directly instead.
    const eventPackageStore = await readEventPackageStore(stateRoot);
    const savedPackage = findEventPackage(eventPackageStore, scheduled.matchId);
    expect(savedPackage).not.toBeNull();
    expect(savedPackage!.reasonToWatch.claims.length).toBeGreaterThan(0);
    expect(savedPackage!.reasonToWatch.claims[0]!.source).toBe("version_debut");
    expect(savedPackage!.reasonToWatch.claims[0]!.reference).toContain(
      "agtv_auri_v43",
    );
  }, 30000);

  it("hard-fails at schedule time when the sealed bundle carries no resolvable lineup, never silently producing another unpromotable record", async () => {
    await writeEmptyIdentityRegistry(artifactsRoot);
    await writeQueueItem(
      queueRoot,
      "runNoLineup",
      { experienceRequestId: "ereq_runNoLineup" },
      "malformed",
    );
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = runCli(
      "premiere-schedule.ts",
      [`--episode=ereq_runNoLineup`, `--at=${at}`],
      roots(),
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      "participant identity could not be resolved",
    );

    const store = await readFeaturedMatchStore(stateRoot);
    expect(store.matches).toHaveLength(0);
  }, 30000);

  it("premiere:publish itself refuses a zero-participant premiere-lane record, as defense in depth against any OTHER writer that bypasses premiere:schedule", async () => {
    await writeEmptyIdentityRegistry(artifactsRoot);
    const broken = {
      schemaVersion: 1 as const,
      matchId: `feat_${"b".repeat(20)}`,
      lane: "premiere" as const,
      episodeRequestId: "ereq_broken",
      queueItemName: "20260801T000000Z-broken",
      title: "Broken",
      description: "",
      participants: [],
      map: "world",
      format: "2p duel",
      provenance: {
        source: "premiere-queue" as const,
        sourceRef: "20260801T000000Z-broken",
        capturedAt: new Date().toISOString(),
      },
      state: "scheduled" as const,
      category: null,
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      revealAt: null,
      evidence: {
        dramaScore: null,
        dramaGrade: null,
        entertainmentScore: null,
        storyGrade: null,
        turnCount: 9000,
        decisionCount: null,
        degradedCount: null,
        seatCount: 2,
        replayComplete: true,
        notes: [],
      },
      postMatchSummary: null,
      result: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(stateRoot, "featured-matches.json"),
      JSON.stringify({ schemaVersion: 1, matches: [broken] }),
      "utf8",
    );
    const result = runCli(
      "premiere-publish.ts",
      [`--episode=${broken.matchId}`],
      roots(),
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("zero participants");
  }, 30000);
});
