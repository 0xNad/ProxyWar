/**
 * Behavioral contract for `.github/workflows/ci.yml`'s test-job topology
 * (2026-08-07 e2e isolation): `tests/e2e/**` must never run inside the
 * coverage-instrumented, `--maxWorkers=2` sharded `test` matrix — that is
 * the exact contention GH Actions run 31131165725 (PR26 shard 1/4) and
 * push 10a29b0 (PR25's own merge to main) both hit: a headless Chrome
 * spawned by `tests/e2e/PublicProductJourneys.e2e.test.ts` never got
 * enough CPU to open its DevTools port before `CdpBrowser`'s internal
 * deadline. It must instead run in its own dedicated job, downstream of
 * the same `build` artifact every other test job depends on, via the
 * exact command a contributor already runs locally.
 *
 * This parses the REAL workflow YAML with `js-yaml` and asserts on the
 * parsed job/step objects — never a literal-text/regex match against the
 * file's source — so a change that preserves the same intent in
 * differently-worded YAML still passes, and a change that silently
 * reintroduces the contention (e.g. dropping the exclude flag, or making
 * `test-e2e` skippable) fails for the right reason.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, test } from "vitest";

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  needs?: string | string[];
  if?: string;
  strategy?: { matrix: { include?: Array<{ file: string }> } };
  steps: WorkflowStep[];
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

async function loadCiWorkflow(): Promise<Workflow> {
  const workflowPath = path.join(
    process.cwd(),
    ".github/workflows/ci.yml",
  );
  const raw = await readFile(workflowPath, "utf8");
  return yaml.load(raw) as Workflow;
}

function runSteps(job: WorkflowJob): string[] {
  return job.steps
    .map((step) => step.run)
    .filter((run): run is string => run !== undefined);
}

describe("CI workflow: e2e test isolation", () => {
  test("the sharded coverage `test` matrix excludes tests/e2e/**", async () => {
    const workflow = await loadCiWorkflow();
    const testJob = workflow.jobs.test;
    expect(testJob).toBeDefined();
    const coverageRun = runSteps(testJob).find((run) =>
      run.includes("test:coverage"),
    );
    expect(coverageRun).toBeDefined();
    expect(coverageRun).toMatch(/--exclude=tests\/e2e\/\*\*/);
  });

  test("a dedicated e2e job exists, depends on build, and runs the full e2e suite via the same command a contributor runs locally", async () => {
    const workflow = await loadCiWorkflow();
    const e2eJob = workflow.jobs["test-e2e"];
    expect(e2eJob).toBeDefined();
    expect(e2eJob.needs).toBe("build");
    const runCommands = runSteps(e2eJob);
    // Must be the plain, unfiltered, non-coverage e2e script — no
    // `--shard`, no `test:coverage`, nothing that could quietly narrow
    // which e2e tests actually run.
    expect(runCommands).toContain("npm run test:e2e");
    expect(runCommands.some((run) => run.includes("--shard"))).toBe(false);
    expect(runCommands.some((run) => run.includes("test:coverage"))).toBe(
      false,
    );
  });

  test("the e2e job downloads the exact same static-app-shell artifact the build job publishes, not a separate build", async () => {
    const workflow = await loadCiWorkflow();
    const buildJob = workflow.jobs.build;
    const e2eJob = workflow.jobs["test-e2e"];
    const uploadStep = buildJob.steps.find(
      (step) =>
        step.uses?.startsWith("actions/upload-artifact") &&
        step.with?.name !== undefined,
    );
    const downloadStep = e2eJob.steps.find(
      (step) => step.uses?.startsWith("actions/download-artifact"),
    );
    expect(uploadStep?.with?.name).toBeDefined();
    expect(downloadStep?.with?.name).toBe(uploadStep?.with?.name);
    // The e2e job must never run its own `build-prod`/`vite build` — it
    // consumes the artifact instead, exactly like the sharded `test` job
    // does.
    expect(
      runSteps(e2eJob).some((run) => /\bbuild-prod\b|\bvite build\b/.test(run)),
    ).toBe(false);
  });

  test("every test-family job (test, test-heavy, test-e2e) still runs unconditionally — none gained a skip/if guard", async () => {
    const workflow = await loadCiWorkflow();
    for (const jobName of ["test", "test-heavy", "test-e2e"]) {
      const job = workflow.jobs[jobName];
      expect(job, `${jobName} must exist`).toBeDefined();
      expect(job.if, `${jobName} must not be conditionally skipped`).toBeUndefined();
    }
  });

  test("no test file is silently dropped: heavy(2) + e2e(1) + the 4-way shard's own exclusions stay consistent with each other", async () => {
    const workflow = await loadCiWorkflow();
    const shardRun = runSteps(workflow.jobs.test).find((run) =>
      run.includes("test:coverage"),
    )!;
    const heavyStrategy = workflow.jobs["test-heavy"].strategy;
    expect(heavyStrategy).toBeDefined();
    const heavyFiles = (heavyStrategy?.matrix.include ?? []).map(
      (entry) => entry.file,
    );
    expect(heavyFiles.length).toBeGreaterThan(0);
    for (const file of heavyFiles) {
      expect(shardRun).toContain(`--exclude=${file}`);
    }
    expect(shardRun).toContain("--exclude=tests/e2e/**");
  });
});
