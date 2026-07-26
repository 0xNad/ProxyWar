import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildExperienceRequestBody,
  PremiereWageringXpRequestError,
  writeXpRequestBundle,
} from "../../../src/scripts/premiere-wagering/PremiereWageringXpRequest";
import type { ActiveRosterSeat } from "../../../src/scripts/premiere-wagering/PremiereWageringRoster";

function seat(policyVersionId: string): ActiveRosterSeat {
  return {
    policyVersionId,
    policyLabel: `${policyVersionId}:v1`,
    playerId: `player-${policyVersionId}`,
    playerName: null,
  };
}

describe("buildExperienceRequestBody", () => {
  test("seats every roster member in order, one slot each, num_episodes fixed at 1", () => {
    const seats = [seat("pv_1"), seat("pv_2"), seat("pv_3")];
    const body = buildExperienceRequestBody({
      coworldId: "cow_x",
      variantId: "twelve-player-ffa-world",
      seats,
      maxDecisionSteps: 300,
    });
    expect(body.coworld_id).toBe("cow_x");
    expect(body.variant_id).toBe("twelve-player-ffa-world");
    expect(body.num_episodes).toBe(1);
    expect(body.game_config_overrides).toEqual({ max_decision_steps: 300 });
    expect(body.roster).toEqual([
      { player: { policy_ref: "pv_1" }, slot: 0 },
      { player: { policy_ref: "pv_2" }, slot: 1 },
      { player: { policy_ref: "pv_3" }, slot: 2 },
    ]);
  });

  test("refuses to build a zero-seat request", () => {
    expect(() =>
      buildExperienceRequestBody({
        coworldId: "cow_x",
        variantId: "v",
        seats: [],
        maxDecisionSteps: 100,
      }),
    ).toThrow(PremiereWageringXpRequestError);
  });
});

describe("writeXpRequestBundle", () => {
  let root: string;

  beforeEach(async () => {
    const realTemporaryRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(realTemporaryRoot, "premiere-wagering-xpreq-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("writes inline artifacts + spectator-replay.json under an xpreq-<runID> directory, never the mirror's league- prefix", async () => {
    const rawReplayPayload = {
      runID: "coworld-2026-07-26T22-00-00-000Z-feedface",
      inlineRunArtifacts: {
        "decisions.jsonl": '{"sequence":1}\n',
        "game-record.json": JSON.stringify({
          info: {
            num_turns: 5000,
            config: { gameMap: "Pangaea", gameType: "Private", randomSpawn: false },
          },
        }),
        "match-summary.json": JSON.stringify({
          runID: "coworld-2026-07-26T22-00-00-000Z-feedface",
          roster: [],
        }),
      },
      spectatorReplay: {
        schemaVersion: 1,
        runID: "coworld-2026-07-26T22-00-00-000Z-feedface",
        snapshots: [],
      },
    };
    const { bundleDir, parsed } = await writeXpRequestBundle({
      rawReplayPayload,
      runsRootDir: root,
    });
    expect(path.basename(bundleDir)).toBe(
      "xpreq-coworld-2026-07-26T22-00-00-000Z-feedface",
    );
    expect(path.basename(bundleDir)).not.toMatch(/^league-/);
    expect(parsed.runID).toBe("coworld-2026-07-26T22-00-00-000Z-feedface");
    const written = await fs.readdir(bundleDir);
    expect(written.sort()).toEqual(
      [
        "decisions.jsonl",
        "game-record.json",
        "match-summary.json",
        "spectator-replay.json",
      ].sort(),
    );
    const spectatorReplay = JSON.parse(
      await fs.readFile(path.join(bundleDir, "spectator-replay.json"), "utf8"),
    );
    expect(spectatorReplay.runID).toBe("coworld-2026-07-26T22-00-00-000Z-feedface");
  });

  test("throws on an unrecognized raw replay payload", async () => {
    await expect(
      writeXpRequestBundle({ rawReplayPayload: "not an object", runsRootDir: root }),
    ).rejects.toThrow(PremiereWageringXpRequestError);
  });
});
