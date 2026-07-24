import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runAiLeagueClipCanaryCli } from "../../src/scripts/ai-league-clip-canary";
import {
  AI_LEAGUE_CLIP_CANARY_FILE,
  AI_LEAGUE_CLIP_CANARY_PREDECESSOR_FILE,
  AI_LEAGUE_CLIP_CANARY_ROOT_PREDECESSOR_FILE,
} from "../../src/server/agents/AiLeagueClipCanary";
import { controlledSourceBytes } from "../server/replay-premiere/ReplayPremiereFixtures";

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
    const runKey = "league-coworld-cli-canary";
    const premiereId = "prem_abcdef1234567890";
    const runsRoot = path.join(root, "ai-league-runs");
    const controlledSource = (
      JSON.parse(controlledSourceBytes().toString("utf8")) as {
        gameRecord: Record<string, unknown> & { info: Record<string, unknown> };
      }
    ).gameRecord;
    const sourceBytes = Buffer.from(
      JSON.stringify({
        ...controlledSource,
        info: { ...controlledSource.info, num_turns: 1_000 },
        turns: [],
      }),
    );
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    await fs.mkdir(path.join(runsRoot, runKey), { recursive: true });
    await fs.writeFile(
      path.join(runsRoot, runKey, "game-record.json"),
      sourceBytes,
    );
    const archiveRoot = path.join(root, "archive-v1");
    await fs.mkdir(path.join(archiveRoot, "summaries"), { recursive: true });
    await fs.writeFile(
      path.join(archiveRoot, "archive-index.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        premiereId,
        sourceRunId: "coworld-cli-canary",
        sourceKind: "rated_coworld",
        terminalState: "revealed",
        revealedAt: "2026-07-24T02:30:00.000Z",
        publicationCommitmentHash: "1".repeat(64),
        sourceReplaySha256: sourceSha256,
        summaryHash: "2".repeat(64),
        summaryRelPath: `summaries/${premiereId}.summary.json`,
        reclaimedAt: "2026-07-24T02:31:00.000Z",
      })}\n`,
    );
    const rootPredecessor = path.join(
      root,
      AI_LEAGUE_CLIP_CANARY_ROOT_PREDECESSOR_FILE,
    );
    const rootPredecessorBytes = Buffer.from(
      `${JSON.stringify({
        schemaVersion: 1,
        lifecycle: "disarmed",
        runKey: "league-coworld-predecessor",
        bucket: 60,
        sourceReplaySha256: "a".repeat(64),
        armedAt: "2026-07-24T02:39:53.048Z",
        expiresAt: "2026-07-24T02:59:52.000Z",
        claimedAt: "2026-07-24T02:40:18.409Z",
        disarmedAt: "2026-07-24T02:44:26.234Z",
      })}\n`,
    );
    const rootPredecessorSha256 = createHash("sha256")
      .update(rootPredecessorBytes)
      .digest("hex");
    await fs.writeFile(rootPredecessor, rootPredecessorBytes, { mode: 0o600 });
    const predecessor = path.join(root, AI_LEAGUE_CLIP_CANARY_PREDECESSOR_FILE);
    const predecessorBytes = Buffer.from(
      `${JSON.stringify({
        schemaVersion: 2,
        lifecycle: "disarmed",
        runKey: "league-coworld-predecessor-v2",
        premiereId: "prem_1234567890abcdef",
        bucket: 61,
        sourceReplaySha256: "b".repeat(64),
        priorStateSha256: rootPredecessorSha256,
        armedAt: "2026-07-24T02:45:00.000Z",
        expiresAt: "2026-07-24T03:05:00.000Z",
        claimedAt: null,
        disarmedAt: "2026-07-24T02:46:00.000Z",
      })}\n`,
    );
    const predecessorSha256 = createHash("sha256")
      .update(predecessorBytes)
      .digest("hex");
    await fs.writeFile(predecessor, predecessorBytes, { mode: 0o600 });
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(
      await runAiLeagueClipCanaryCli(
        [
          "arm",
          "--private-state-root",
          root,
          "--runs-root",
          runsRoot,
          "--run-key",
          runKey,
          "--premiere-id",
          premiereId,
          "--bucket",
          "60",
          "--source-replay-sha256",
          sourceSha256,
          "--prior-state-sha256",
          predecessorSha256,
          "--root-predecessor-state-sha256",
          rootPredecessorSha256,
          "--expires-at",
          expiresAt,
        ],
        io(),
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.pop() ?? "null")).toMatchObject({
      enabled: true,
      record: {
        schemaVersion: 3,
        lifecycle: "armed",
        bucket: 60,
        priorStateSha256: predecessorSha256,
        rootPredecessorStateSha256: rootPredecessorSha256,
      },
    });
    expect(
      (await fs.lstat(path.join(root, AI_LEAGUE_CLIP_CANARY_FILE))).mode &
        0o777,
    ).toBe(0o600);
    expect(
      await runAiLeagueClipCanaryCli(
        ["status", "--private-state-root", root],
        io(),
      ),
    ).toBe(0);
    expect(JSON.parse(stdout.pop() ?? "null")).toMatchObject({
      enabled: true,
      claimable: true,
      readEnabled: false,
      record: {
        schemaVersion: 3,
        lifecycle: "armed",
        priorStateSha256: predecessorSha256,
        rootPredecessorStateSha256: rootPredecessorSha256,
      },
    });

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
    expect(await fs.readFile(predecessor)).toEqual(predecessorBytes);
    expect(await fs.readFile(rootPredecessor)).toEqual(rootPredecessorBytes);
  });
});
