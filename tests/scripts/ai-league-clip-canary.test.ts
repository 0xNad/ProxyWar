import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runAiLeagueClipCanaryCli } from "../../src/scripts/ai-league-clip-canary";
import { AI_LEAGUE_CLIP_CANARY_FILE } from "../../src/server/agents/AiLeagueClipCanary";

let root: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pw-clip-canary-cli-")),
  );
  await fs.chmod(root, 0o700);
  stdout = [];
  stderr = [];
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const io = () => ({
  stdout: (line: string) => stdout.push(line),
  stderr: (line: string) => stderr.push(line),
});

describe("clips:canary CLI", () => {
  test("requires an explicit absolute private root and never consults environment fallback", async () => {
    expect(
      await runAiLeagueClipCanaryCli(
        ["status", "--private-state-root", "relative/private"],
        io(),
      ),
    ).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["clip_canary_cli_not_absolute:private-state-root"]);
  });

  test("atomically arms, reports, and idempotently disarms the explicit root", async () => {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(
      await runAiLeagueClipCanaryCli(
        [
          "arm",
          "--private-state-root",
          root,
          "--run-key",
          "league-coworld-cli-canary",
          "--bucket",
          "60",
          "--source-replay-sha256",
          "b".repeat(64),
          "--expires-at",
          expiresAt,
        ],
        io(),
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.pop() ?? "null")).toMatchObject({
      enabled: true,
      record: { lifecycle: "armed", bucket: 60 },
    });
    expect(
      (await fs.lstat(path.join(root, AI_LEAGUE_CLIP_CANARY_FILE))).mode &
        0o777,
    ).toBe(0o600);

    expect(
      await runAiLeagueClipCanaryCli(
        ["disarm", "--private-state-root", root],
        io(),
      ),
    ).toBe(0);
    const first = await fs.readFile(
      path.join(root, AI_LEAGUE_CLIP_CANARY_FILE),
      "utf8",
    );
    expect(
      await runAiLeagueClipCanaryCli(
        ["disarm", "--private-state-root", root],
        io(),
      ),
    ).toBe(0);
    expect(
      await fs.readFile(path.join(root, AI_LEAGUE_CLIP_CANARY_FILE), "utf8"),
    ).toBe(first);
  });
});
