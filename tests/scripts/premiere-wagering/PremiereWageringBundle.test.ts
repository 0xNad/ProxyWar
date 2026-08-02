import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  PremiereWageringBundleError,
  readPremiereWageringBundle,
} from "../../../src/scripts/premiere-wagering/PremiereWageringBundle";

let root: string;

beforeEach(async () => {
  const realTemporaryRoot = await fs.realpath(os.tmpdir());
  root = await fs.mkdtemp(
    path.join(realTemporaryRoot, "premiere-wagering-bundle-"),
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Field shapes lifted directly from a real mirrored bundle
 * (artifacts/ai-league-runs/league-coworld-2026-07-26T09-12-41-706Z-ea6da6f4)
 * — same runID/config/roster field names and nesting. */
async function writeValidBundle(
  dir: string,
  overrides: {
    runID?: string;
    numTurns?: number;
    gameType?: string;
    randomSpawn?: boolean;
    gameMap?: string;
    roster?: unknown[];
  } = {},
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const roster =
    overrides.roster ??
    [
      { agentID: "opportunistic-agent-1", username: "docxology" },
      { agentID: "opportunistic-agent-2", username: "relh" },
    ];
  const matchSummary = {
    runID: overrides.runID ?? "coworld-2026-07-26T09-12-41-706Z-ea6da6f4",
    matchID: "COWRLD01",
    roster,
  };
  const gameRecord = {
    info: {
      gameID: "COWRLD01",
      num_turns: overrides.numTurns ?? 10500,
      config: {
        gameMap: overrides.gameMap ?? "Pangaea",
        gameType: overrides.gameType ?? "Private",
        randomSpawn: overrides.randomSpawn ?? false,
      },
    },
  };
  await Promise.all([
    fs.writeFile(path.join(dir, "decisions.jsonl"), '{"sequence":1}\n'),
    fs.writeFile(path.join(dir, "game-record.json"), JSON.stringify(gameRecord)),
    fs.writeFile(
      path.join(dir, "match-summary.json"),
      JSON.stringify(matchSummary),
    ),
    fs.writeFile(
      path.join(dir, "spectator-replay.json"),
      JSON.stringify({ runID: overrides.runID ?? "coworld-x" }),
    ),
  ]);
}

describe("readPremiereWageringBundle", () => {
  test("extracts turnCount/gameType/randomSpawn/map/seats from a well-formed bundle", async () => {
    const dir = path.join(root, "league-coworld-abc123");
    await writeValidBundle(dir);
    const bundle = await readPremiereWageringBundle(dir);
    expect(bundle.bundleDirName).toBe("league-coworld-abc123");
    expect(bundle.runId).toBe("coworld-2026-07-26T09-12-41-706Z-ea6da6f4");
    expect(bundle.turnCount).toBe(10500);
    expect(bundle.gameType).toBe("Private");
    expect(bundle.randomSpawn).toBe(false);
    expect(bundle.map).toBe("Pangaea");
    expect(bundle.seatCount).toBe(2);
    expect(bundle.seatAgentIds).toEqual([
      "opportunistic-agent-1",
      "opportunistic-agent-2",
    ]);
    expect(Object.keys(bundle.fileHashes).sort()).toEqual([
      "decisions.jsonl",
      "game-record.json",
      "match-summary.json",
      "spectator-replay.json",
    ]);
    expect(bundle.fileHashes["game-record.json"]).toMatch(/^[a-f0-9]{64}$/);
  });

  test("throws when a required file is missing", async () => {
    const dir = path.join(root, "incomplete");
    await writeValidBundle(dir);
    await fs.rm(path.join(dir, "decisions.jsonl"));
    await expect(readPremiereWageringBundle(dir)).rejects.toThrow(
      PremiereWageringBundleError,
    );
  });

  test("throws when match-summary.json is missing runID", async () => {
    const dir = path.join(root, "no-run-id");
    await writeValidBundle(dir);
    await fs.writeFile(
      path.join(dir, "match-summary.json"),
      JSON.stringify({ matchID: "x", roster: [] }),
    );
    await expect(readPremiereWageringBundle(dir)).rejects.toThrow(
      PremiereWageringBundleError,
    );
  });

  test("throws when game-record.json is not valid JSON", async () => {
    const dir = path.join(root, "bad-json");
    await writeValidBundle(dir);
    await fs.writeFile(path.join(dir, "game-record.json"), "{not json");
    await expect(readPremiereWageringBundle(dir)).rejects.toThrow(
      PremiereWageringBundleError,
    );
  });
});
