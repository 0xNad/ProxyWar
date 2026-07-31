import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFeaturedMatchStore } from "../../src/server/agents/FeaturedMatch";

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
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
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

async function writeQueueItem(
  queueRoot: string,
  name: string,
  overrides: Record<string, unknown> = {},
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
  await writeFile(path.join(dir, "bundle.source.json"), "{}", "utf8");
}

describe("premiere schedule CLIs — real subprocess end to end", () => {
  let queueRoot: string;
  let artifactsRoot: string;
  let stateRoot: string;

  beforeEach(async () => {
    queueRoot = await mkdtemp(path.join(os.tmpdir(), "pw-cli-queue-"));
    artifactsRoot = await mkdtemp(path.join(os.tmpdir(), "pw-cli-artifacts-"));
    stateRoot = await mkdtemp(path.join(os.tmpdir(), "pw-cli-state-"));
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
    await mkdir(path.join(artifactsRoot, "ai-league-runs", "league"), { recursive: true });
    await writeFile(
      path.join(artifactsRoot, "ai-league-runs", "league", "data.json"),
      JSON.stringify({ episodes: [{ episodeRequestId: "ereq_runA" }] }),
      "utf8",
    );
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = runCli("premiere-schedule.ts", [`--episode=ereq_runA`, `--at=${at}`], roots());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already_published_on_league");
  }, 30000);

  it("refuses to schedule a past-dated time", async () => {
    const at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const result = runCli("premiere-schedule.ts", [`--episode=ereq_runA`, `--at=${at}`], roots());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("scheduled_at_in_past");
  }, 30000);

  it("refuses to schedule two premieres too close together", async () => {
    await writeQueueItem(queueRoot, "runB");
    const at1 = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const r1 = runCli("premiere-schedule.ts", [`--episode=ereq_runA`, `--at=${at1}`], roots());
    expect(r1.code).toBe(0);

    const at2 = new Date(Date.parse(at1) + 5 * 60 * 1000).toISOString(); // 5 minutes later
    const r2 = runCli("premiere-schedule.ts", [`--episode=ereq_runB`, `--at=${at2}`], roots());
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
    await rm(path.join(queueRoot, "ready", "runA"), { recursive: true, force: true });

    const validateResult = runCli("premiere-validate.ts", ["--json"], roots());
    expect(validateResult.code).toBe(1);
    const parsed = JSON.parse(validateResult.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.issues[0].reason).toContain("queue_item_missing");
  }, 30000);

  it("premiere:cancel refuses to cancel a record that was never scheduled", async () => {
    const result = runCli("premiere-cancel.ts", ["--episode=nonexistent"], roots());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not found");
  }, 30000);

  it("premiere:publish refuses to publish before scheduling", async () => {
    const result = runCli("premiere-publish.ts", ["--episode=ereq_runA"], roots());
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not found");
  }, 30000);
});
