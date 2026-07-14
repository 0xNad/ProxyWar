import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  executeCoworldPairedPlan,
  type CoworldEpisodeRunner,
  type CoworldResultsValidator,
} from "../../src/scripts/coworld-paired-executor";
import {
  coworldCanonicalSha256,
  materializeCoworldPairedMatrix,
  type CoworldArmSpec,
  type CoworldPairedJob,
  type CoworldPairedMatrixSpec,
  type CoworldPairedPlan,
} from "../../src/scripts/coworld-paired-matrix";

async function fakeImageID(reference: string): Promise<string> {
  return `sha256:${createHash("sha256").update(reference).digest("hex")}`;
}

async function fixture(input?: {
  candidateSeats?: number[];
  arms?: CoworldArmSpec[];
}): Promise<CoworldPairedPlan> {
  const specPath = path.resolve(
    "coworld-adapter/coworld/paired-matrix.example.json",
  );
  const authored = JSON.parse(
    await fs.readFile(specPath, "utf8"),
  ) as CoworldPairedMatrixSpec;
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "coworld-paired-executor-"),
  );
  return materializeCoworldPairedMatrix({
    spec: {
      ...authored,
      outputRoot: "unused-by-override",
      variantIDs: ["tournament-4p-asia"],
      candidateSeats: input?.candidateSeats ?? [0],
      seeds: [7],
      arms: input?.arms ?? [
        { kind: "v16" },
        { kind: "a1" },
        { kind: "v16-shadow", expertMask: 5 },
      ],
    },
    specDirectory: path.dirname(specPath),
    outputRootOverride: path.join(directory, "matrix"),
    gameImageOverride: "proxywar-coworld-reset:seed-v1",
    sourcePaths: [specPath],
    resolveImageID: fakeImageID,
    validateCoworld: async () => {},
    now: new Date("2026-07-14T00:00:00.000Z"),
  });
}

async function writeSuccessfulArtifacts(job: CoworldPairedJob): Promise<void> {
  await fs.mkdir(job.outputDir, { recursive: true });
  await fs.writeFile(
    path.join(job.outputDir, "results.json"),
    `${JSON.stringify({ scores: [1, 0, 0, 0] })}\n`,
  );
  await fs.writeFile(
    path.join(job.outputDir, "replay"),
    `${JSON.stringify({ jobID: job.jobID })}\n`,
  );
}

function successfulRunner(seen: string[] = []): CoworldEpisodeRunner {
  return async ({ job }) => {
    seen.push(job.jobID);
    await writeSuccessfulArtifacts(job);
  };
}

async function execute(
  plan: CoworldPairedPlan,
  input?: {
    runEpisode?: CoworldEpisodeRunner;
    resolveImageID?: (reference: string) => Promise<string>;
    validateResults?: CoworldResultsValidator;
  },
) {
  return executeCoworldPairedPlan({
    planPath: plan.planPath,
    resolveImageID: input?.resolveImageID ?? fakeImageID,
    runEpisode: input?.runEpisode,
    validateResults: input?.validateResults ?? (async () => {}),
  });
}

async function savePlan(plan: CoworldPairedPlan): Promise<void> {
  await fs.writeFile(plan.planPath, `${JSON.stringify(plan, null, 2)}\n`);
}

async function rekeyPlanFromCanonicalIdentity(
  plan: CoworldPairedPlan,
): Promise<void> {
  const matrixID = `matrix-${coworldCanonicalSha256(plan.matrixIdentity).slice(7, 39)}`;
  const jobsRoot = path.join(path.dirname(plan.planPath), "payload", "jobs");
  for (const block of plan.blocks) {
    const oldBlockID = block.blockID;
    const identity = [
      matrixID,
      block.variantID,
      block.candidateSeat,
      block.seed,
      block.rosterOrderID,
    ];
    const blockID = `block-${coworldCanonicalSha256(identity).slice(7, 39)}`;
    const pairID = `pair-${coworldCanonicalSha256(identity).slice(7, 39)}`;
    for (const job of plan.jobs.filter(
      (candidate) => candidate.blockID === oldBlockID,
    )) {
      const oldRoot = path.dirname(job.requestPath);
      const jobID = `${blockID}-${job.arm.armID}`;
      const newRoot = path.join(jobsRoot, jobID);
      await fs.rename(oldRoot, newRoot);
      job.jobID = jobID;
      job.matrixID = matrixID;
      job.blockID = blockID;
      job.pairID = pairID;
      job.requestPath = path.join(newRoot, "episode_request.json");
      job.outputDir = path.join(newRoot, "episode");
      job.completionPath = path.join(newRoot, "completion.json");
    }
    block.blockID = blockID;
    block.pairID = pairID;
  }
  plan.matrixID = matrixID;
  await savePlan(plan);
}

describe("Coworld paired sequential executor", () => {
  test("executes the exact balanced order and resumes validated completions", async () => {
    const plan = await fixture({ candidateSeats: [0, 1] });
    const seen: string[] = [];
    const first = await execute(plan, { runEpisode: successfulRunner(seen) });

    expect(seen).toEqual(plan.jobs.map((job) => job.jobID));
    expect(first).toEqual({
      matrixID: plan.matrixID,
      totalJobs: 6,
      executedJobs: 6,
      resumedJobs: 0,
    });
    for (const job of plan.jobs) {
      const completion = JSON.parse(
        await fs.readFile(job.completionPath, "utf8"),
      );
      expect(completion).toMatchObject({
        schemaVersion: 1,
        status: "complete",
        matrixID: plan.matrixID,
        blockID: job.blockID,
        pairID: job.pairID,
        jobID: job.jobID,
        rosterOrderID: job.rosterOrderID,
        arm: job.arm,
        expertMask: job.expertMask,
        variantID: job.variantID,
        seed: job.seed,
        map: job.map,
        candidateSeat: job.candidateSeat,
        roster: job.roster,
        candidateImage: job.candidateImage,
        gameImage: job.gameImage,
        opponentImages: job.opponentImages,
        validation: {
          coworldVersion: "0.1.30",
          episodeRunner: "injected",
          resultsValidator: "injected",
          replayValidator: "injected-unverified",
        },
      });
      expect(completion.resultsSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(completion.replaySha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    const shouldNotRun = vi.fn<CoworldEpisodeRunner>();
    const resumed = await execute(plan, { runEpisode: shouldNotRun });
    expect(shouldNotRun).not.toHaveBeenCalled();
    expect(resumed).toEqual({
      matrixID: plan.matrixID,
      totalJobs: 6,
      executedJobs: 0,
      resumedJobs: 6,
    });

    await expect(
      executeCoworldPairedPlan({
        planPath: plan.planPath,
        resolveImageID: fakeImageID,
        validateResults: async () => {},
      }),
    ).rejects.toThrow("completion identity or artifact hash is invalid");
  });

  test("validates and executes the dedicated politics-guard arm identity", async () => {
    const plan = await fixture({
      arms: [{ kind: "v16" }, { kind: "v16-politics-guard" }],
    });
    const seen: string[] = [];

    const summary = await execute(plan, {
      runEpisode: successfulRunner(seen),
    });

    expect(summary).toMatchObject({ totalJobs: 2, executedJobs: 2 });
    expect(seen).toEqual(plan.jobs.map(({ jobID }) => jobID));
    const guard = plan.jobs.find(
      (job) => job.arm.kind === "v16-politics-guard",
    )!;
    expect(guard.arm.env).toEqual({
      PROXYWAR_KEYSTONE_SINGLE_ACTION: "0",
      PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "0",
      PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD: "1",
      PROXYWAR_KEYSTONE_EXPERT_MASK: "15",
    });
  });

  test("validates and executes the dedicated diplomacy-adjudicator arm identity", async () => {
    const plan = await fixture({
      arms: [{ kind: "v16" }, { kind: "v16-diplomacy-adjudicator" }],
    });
    const seen: string[] = [];

    const summary = await execute(plan, {
      runEpisode: successfulRunner(seen),
    });

    expect(summary).toMatchObject({ totalJobs: 2, executedJobs: 2 });
    expect(seen).toEqual(plan.jobs.map(({ jobID }) => jobID));
    const adjudicator = plan.jobs.find(
      (job) => job.arm.kind === "v16-diplomacy-adjudicator",
    )!;
    expect(adjudicator.arm.env).toEqual({
      PROXYWAR_KEYSTONE_SINGLE_ACTION: "0",
      PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "0",
      PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR: "1",
      PROXYWAR_KEYSTONE_EXPERT_MASK: "15",
    });
  });

  test("validates and executes the dedicated survival-shield arm identity", async () => {
    const plan = await fixture({
      arms: [{ kind: "v16" }, { kind: "v16-survival-shield" }],
    });
    const seen: string[] = [];

    const summary = await execute(plan, {
      runEpisode: successfulRunner(seen),
    });

    expect(summary).toMatchObject({ totalJobs: 2, executedJobs: 2 });
    expect(seen).toEqual(plan.jobs.map(({ jobID }) => jobID));
    const shield = plan.jobs.find(
      (job) => job.arm.kind === "v16-survival-shield",
    )!;
    expect(shield.arm.env).toEqual({
      PROXYWAR_KEYSTONE_SINGLE_ACTION: "0",
      PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "0",
      PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD: "1",
      PROXYWAR_KEYSTONE_EXPERT_MASK: "15",
    });
  });

  test("keeps completed jobs resumable after a later runner interruption", async () => {
    const plan = await fixture();
    let calls = 0;
    await expect(
      execute(plan, {
        runEpisode: async ({ job }) => {
          calls += 1;
          if (calls === 2) {
            throw new Error("synthetic runner interruption");
          }
          await writeSuccessfulArtifacts(job);
        },
      }),
    ).rejects.toThrow("synthetic runner interruption");
    await expect(fs.lstat(plan.jobs[0]!.completionPath)).resolves.toBeDefined();
    await expect(fs.lstat(plan.jobs[1]!.completionPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const resumedSeen: string[] = [];
    const summary = await execute(plan, {
      runEpisode: successfulRunner(resumedSeen),
    });
    expect(resumedSeen).toEqual(plan.jobs.slice(1).map((job) => job.jobID));
    expect(summary).toMatchObject({ executedJobs: 2, resumedJobs: 1 });
  });

  test("revalidates mutable manifest and request inputs around every run", async () => {
    const plan = await fixture();
    await expect(
      execute(plan, {
        runEpisode: async ({ job }) => {
          await writeSuccessfulArtifacts(job);
          const request = JSON.parse(
            await fs.readFile(job.requestPath, "utf8"),
          );
          request.episode_tags.proxywar_arm = "mutated-during-run";
          await fs.writeFile(
            job.requestPath,
            `${JSON.stringify(request, null, 2)}\n`,
          );
        },
      }),
    ).rejects.toThrow("request tags do not match plan identity");
    await expect(fs.lstat(plan.jobs[0]!.completionPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const duringValidation = await fixture();
    await expect(
      execute(duringValidation, {
        runEpisode: successfulRunner(),
        validateResults: async ({ job }) => {
          const request = JSON.parse(
            await fs.readFile(job.requestPath, "utf8"),
          );
          request.episode_tags.proxywar_arm = "mutated-during-validation";
          await fs.writeFile(
            job.requestPath,
            `${JSON.stringify(request, null, 2)}\n`,
          );
        },
      }),
    ).rejects.toThrow("request tags do not match plan identity");
    await expect(
      fs.lstat(duringValidation.jobs[0]!.completionPath),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preflights every job and rejects partial or tampered artifacts before launching", async () => {
    const partialPlan = await fixture();
    await fs.mkdir(partialPlan.jobs.at(-1)!.outputDir);
    const partialRunner = vi.fn<CoworldEpisodeRunner>();
    await expect(
      execute(partialPlan, { runEpisode: partialRunner }),
    ).rejects.toThrow("incomplete or preexisting output");
    expect(partialRunner).not.toHaveBeenCalled();
    await expect(
      fs.lstat(partialPlan.jobs[0]!.outputDir),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const tamperedPlan = await fixture();
    await execute(tamperedPlan, { runEpisode: successfulRunner() });
    await fs.writeFile(
      path.join(tamperedPlan.jobs[1]!.outputDir, "results.json"),
      `${JSON.stringify({ scores: [0, 1, 0, 0] })}\n`,
    );
    const tamperedRunner = vi.fn<CoworldEpisodeRunner>();
    await expect(
      execute(tamperedPlan, { runEpisode: tamperedRunner }),
    ).rejects.toThrow("completion identity or artifact hash is invalid");
    expect(tamperedRunner).not.toHaveBeenCalled();
  });

  test("rejects reordered plans, unexpected environments, and image drift", async () => {
    const reordered = await fixture();
    [reordered.jobs[0], reordered.jobs[1]] = [
      reordered.jobs[1]!,
      reordered.jobs[0]!,
    ];
    await savePlan(reordered);
    const reorderedRunner = vi.fn<CoworldEpisodeRunner>();
    await expect(
      execute(reordered, { runEpisode: reorderedRunner }),
    ).rejects.toThrow("flattened block order");
    expect(reorderedRunner).not.toHaveBeenCalled();

    const contaminated = await fixture();
    const secretValue = "fake-placeholder-never-print";
    contaminated.blocks[0]!.roster[
      contaminated.blocks[0]!.candidateSeat
    ]!.env.AUTH_TOKEN = secretValue;
    await savePlan(contaminated);
    let contaminationError: unknown;
    try {
      await execute(contaminated, {
        runEpisode: vi.fn<CoworldEpisodeRunner>(),
      });
    } catch (error) {
      contaminationError = error;
    }
    expect(contaminationError).toBeInstanceOf(Error);
    expect((contaminationError as Error).message).toContain(
      "reserved or secret-looking",
    );
    expect((contaminationError as Error).message).not.toContain(secretValue);

    const drifted = await fixture();
    const driftRunner = vi.fn<CoworldEpisodeRunner>();
    await expect(
      execute(drifted, {
        runEpisode: driftRunner,
        resolveImageID: async (reference) =>
          fakeImageID(
            reference === drifted.candidateImage.reference
              ? `${reference}-drifted`
              : reference,
          ),
      }),
    ).rejects.toThrow("Local Docker image changed");
    expect(driftRunner).not.toHaveBeenCalled();
  });

  test("binds the recorded game image to the manifest image Coworld executes", async () => {
    const plan = await fixture();
    const claimedGameImage = {
      reference: "proxywar-coworld-reset:claimed-other-build",
      imageID: await fakeImageID("proxywar-coworld-reset:claimed-other-build"),
    };
    plan.gameImage = claimedGameImage;
    plan.matrixIdentity.gameImage = claimedGameImage;
    plan.jobs.forEach((job) => {
      job.gameImage = claimedGameImage;
    });
    await rekeyPlanFromCanonicalIdentity(plan);

    const runner = vi.fn<CoworldEpisodeRunner>();
    await expect(execute(plan, { runEpisode: runner })).rejects.toThrow(
      "manifest game image differs from recorded image identity",
    );
    expect(runner).not.toHaveBeenCalled();
  });

  test("fails closed on malformed identities, request env fields, and escaped job roots", async () => {
    const identityTamper = await fixture();
    identityTamper.matrixIdentity.seeds = [8];
    await savePlan(identityTamper);
    const identityRunner = vi.fn<CoworldEpisodeRunner>();
    await expect(
      execute(identityTamper, { runEpisode: identityRunner }),
    ).rejects.toThrow("matrixID does not match its canonical identity");
    expect(identityRunner).not.toHaveBeenCalled();

    const malformed = await fixture();
    malformed.blocks[0]!.roster[malformed.blocks[0]!.candidateSeat]!.run = [""];
    await savePlan(malformed);
    await expect(execute(malformed)).rejects.toThrow(
      "must be a bounded nonempty string",
    );

    const requestContamination = await fixture();
    const job = requestContamination.jobs[0]!;
    const request = JSON.parse(await fs.readFile(job.requestPath, "utf8"));
    request.players[job.candidateSeat].env.PROXYWAR_KEYSTONE_EXPERT_MASK = "15";
    await fs.writeFile(
      job.requestPath,
      `${JSON.stringify(request, null, 2)}\n`,
    );
    const contaminatedRunner = vi.fn<CoworldEpisodeRunner>();
    await expect(
      execute(requestContamination, { runEpisode: contaminatedRunner }),
    ).rejects.toThrow("unexpected player environment fields");
    expect(contaminatedRunner).not.toHaveBeenCalled();

    const escaped = await fixture();
    const jobRoot = path.dirname(escaped.jobs[0]!.requestPath);
    const movedRoot = `${jobRoot}-moved`;
    await fs.rename(jobRoot, movedRoot);
    await fs.symlink(movedRoot, jobRoot, "dir");
    const escapedRunner = vi.fn<CoworldEpisodeRunner>();
    await expect(
      execute(escaped, { runEpisode: escapedRunner }),
    ).rejects.toThrow("must be a real directory");
    expect(escapedRunner).not.toHaveBeenCalled();

    const tmpEscape = await fixture();
    const externalTmp = await fs.mkdtemp(
      path.join(os.tmpdir(), "coworld-paired-external-tmp-"),
    );
    await fs.symlink(
      externalTmp,
      path.join(path.dirname(tmpEscape.planPath), "tmp"),
    );
    const tmpRunner = vi.fn<CoworldEpisodeRunner>();
    await expect(execute(tmpEscape, { runEpisode: tmpRunner })).rejects.toThrow(
      "plan temporary directory must be a real directory",
    );
    expect(tmpRunner).not.toHaveBeenCalled();
  });

  test("requires both validated results and a nonempty replay before completion", async () => {
    const plan = await fixture();
    await expect(
      execute(plan, {
        runEpisode: async ({ job }) => {
          await fs.mkdir(job.outputDir, { recursive: true });
          await fs.writeFile(
            path.join(job.outputDir, "results.json"),
            `${JSON.stringify({ scores: [1, 0, 0, 0] })}\n`,
          );
        },
      }),
    ).rejects.toThrow();
    await expect(fs.lstat(plan.jobs[0]!.completionPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(execute(plan)).rejects.toThrow(
      "incomplete or preexisting output",
    );
  });
});
