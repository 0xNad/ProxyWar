import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Real subprocess (`tsx`) end-to-end coverage of the five `season:*`
 * entry points themselves — argv parsing, exit codes, and the real
 * `isMainModule` dispatch — matching `premiere-schedule-cli.test.ts`'s
 * own established pattern. Business logic itself is covered by
 * `season-lib.test.ts` and `SeasonRegistry.test.ts`.
 */
const repoRoot = path.resolve(__dirname, "../..");
const scriptsDir = path.join(repoRoot, "src", "scripts");
const FEAT_ID = `feat_${"d".repeat(20)}`;

describe("season:* CLIs — real subprocess end to end", () => {
  let registryDir: string;

  function runCli(scriptName: string, args: string[]): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync("npx", ["tsx", path.join(scriptsDir, scriptName), ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PROXYWAR_SEASON_REGISTRY_DIR: registryDir },
      });
      return { code: 0, stdout, stderr: "" };
    } catch (error) {
      const err = error as { status: number; stdout: Buffer; stderr: Buffer };
      return { code: err.status, stdout: err.stdout?.toString("utf8") ?? "", stderr: err.stderr?.toString("utf8") ?? "" };
    }
  }

  beforeEach(async () => {
    registryDir = await mkdtemp(path.join(os.tmpdir(), "pw-season-cli-"));
  });

  afterEach(async () => {
    await rm(registryDir, { recursive: true, force: true });
  });

  it("full lifecycle: create -> add-event -> status -> activate -> complete", () => {
    const created = runCli("season-create.ts", [
      "--slug=zero",
      "--title=Season Zero",
      "--start=2026-08-01",
      "--end=2026-09-26",
      "--description=an eight-week flagship programme",
    ]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("season_zero");

    const added = runCli("season-add-event.ts", [
      "--season=season_zero",
      `--featured=${FEAT_ID}`,
      "--scheduled-at=2026-08-08T18:00:00.000Z",
    ]);
    expect(added.code).toBe(0);

    const status = runCli("season-status.ts", ["--season=season_zero"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain(FEAT_ID);
    expect(status.stdout).toContain("[draft]");

    const activated = runCli("season-activate.ts", ["--season=season_zero"]);
    expect(activated.code).toBe(0);

    const statusAfterActivate = runCli("season-status.ts", ["--season=season_zero"]);
    expect(statusAfterActivate.stdout).toContain("[active]");

    const completed = runCli("season-complete.ts", ["--season=season_zero"]);
    expect(completed.code).toBe(0);

    const finalStatus = runCli("season-status.ts", ["--season=season_zero"]);
    expect(finalStatus.stdout).toContain("[completed]");
  }, 30000);

  it("refuses to create a season missing required flags", () => {
    const result = runCli("season-create.ts", ["--slug=zero"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("usage:");
  });

  it("refuses to activate an already-active season a second time", () => {
    runCli("season-create.ts", [
      "--slug=zero",
      "--title=Season Zero",
      "--start=2026-08-01",
      "--end=2026-09-26",
    ]);
    runCli("season-activate.ts", ["--season=season_zero"]);
    const secondActivate = runCli("season-activate.ts", ["--season=season_zero"]);
    expect(secondActivate.code).not.toBe(0);
    expect(secondActivate.stdout).toContain("invalid_transition");
  }, 30000);

  it("season:status reports no seasons registered on a cold start", () => {
    const status = runCli("season-status.ts", []);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("no seasons registered");
  });

  it("season:add-event supports attaching a standings snapshot reference", () => {
    runCli("season-create.ts", [
      "--slug=zero",
      "--title=Season Zero",
      "--start=2026-08-01",
      "--end=2026-09-26",
    ]);
    const result = runCli("season-add-event.ts", [
      "--season=season_zero",
      "--standings-snapshot=2026-08-01T00:00:00.000Z",
      "--label=season open",
    ]);
    expect(result.code).toBe(0);
    const status = runCli("season-status.ts", ["--season=season_zero"]);
    expect(status.stdout).toContain("standings snapshot refs: 1");
  }, 30000);
});
