import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  materializeCoworldPairedMatrix,
  type CoworldPairedMatrixSpec,
} from "../../src/scripts/coworld-paired-matrix";

async function fixture(): Promise<{
  directory: string;
  spec: CoworldPairedMatrixSpec;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "coworld-paired-"));
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      game: {
        runnable: {
          type: "game",
          image: "game:v1",
          run: ["node", "/app/game.js"],
          env: {},
        },
        config_schema: {},
        results_schema: {},
      },
      players: [],
      commissioners: [],
      renderers: [],
      diagnosers: [],
      optimizers: [],
      variants: [
        {
          id: "tournament-4p-asia",
          game_config: {
            players: [
              { name: "1" },
              { name: "2" },
              { name: "3" },
              { name: "4" },
            ],
            map: "Asia",
            max_decision_steps: 300,
          },
        },
      ],
      certification: {
        game_config: { players: [{ name: "1" }, { name: "2" }] },
        players: [{ player_id: "starter" }, { player_id: "starter" }],
      },
    }),
  );
  return {
    directory,
    spec: {
      manifestPath: "manifest.json",
      outputRoot: "matrix",
      candidate: {
        image: "candidate:v1",
        run: ["node", "/app/candidate.js"],
        env: { PROXYWAR_KEYSTONE_MODE: "mock-llm" },
        name: "Auri",
      },
      opponents: [0, 1, 2].map((index) => ({
        image: `opponent-${index}:v1`,
        run: ["node", "/app/opponent.js"],
        env: { PROFILE: String(index) },
        name: `Opponent ${index}`,
      })),
      variantIDs: ["tournament-4p-asia"],
      candidateSeats: [0, 2],
      seeds: [7],
    },
  };
}

describe("Coworld paired matrix planner", () => {
  test("materializes interleaved same-image A/B requests with one treatment difference", async () => {
    const { directory, spec } = await fixture();
    const plan = await materializeCoworldPairedMatrix({
      spec,
      specDirectory: directory,
      gameImageOverride: "game:v2",
      now: new Date("2026-07-14T00:00:00.000Z"),
    });

    expect(plan.jobs).toHaveLength(4);
    expect(plan.jobs.map((job) => job.arm)).toEqual([
      "control",
      "treatment",
      "treatment",
      "control",
    ]);
    expect(new Set(plan.jobs.map((job) => job.candidateImage))).toEqual(
      new Set(["candidate:v1"]),
    );
    expect(new Set(plan.jobs.map((job) => job.gameImage))).toEqual(
      new Set(["game:v2"]),
    );

    const materializedManifest = JSON.parse(
      await fs.readFile(plan.materializedManifestPath, "utf8"),
    );
    expect(materializedManifest.game.runnable.image).toBe("game:v2");
    const pair = plan.jobs.filter((job) => job.candidateSeat === 0);
    const requests = await Promise.all(
      pair.map(async (job) =>
        JSON.parse(await fs.readFile(job.requestPath, "utf8")),
      ),
    );
    expect(requests[0].manifest).toEqual(materializedManifest);
    expect(requests[1].manifest).toEqual(materializedManifest);
    expect(requests[0].game_config).toEqual(requests[1].game_config);
    expect(requests[0].players[0].image).toBe("candidate:v1");
    expect(requests[1].players[0].image).toBe("candidate:v1");
    expect(requests.map((request) => request.players[0].env)).toEqual([
      {
        PROXYWAR_KEYSTONE_MODE: "mock-llm",
        PROXYWAR_KEYSTONE_SINGLE_ACTION: "0",
      },
      {
        PROXYWAR_KEYSTONE_MODE: "mock-llm",
        PROXYWAR_KEYSTONE_SINGLE_ACTION: "1",
      },
    ]);
    const scrubTreatment = (request: Record<string, any>) => ({
      ...request,
      episode_tags: { ...request.episode_tags, proxywar_arm: "paired" },
      players: request.players.map((player: Record<string, any>) => ({
        ...player,
        env: {
          ...player.env,
          PROXYWAR_KEYSTONE_SINGLE_ACTION: "paired",
        },
      })),
    });
    expect(scrubTreatment(requests[0])).toEqual(scrubTreatment(requests[1]));

    const savedPlan = JSON.parse(
      await fs.readFile(path.join(directory, "matrix", "plan.json"), "utf8"),
    );
    expect(savedPlan.generatedAt).toBe("2026-07-14T00:00:00.000Z");
    expect(savedPlan.jobs).toHaveLength(4);
  });

  test("rejects mutable images and a candidate-owned treatment flag", async () => {
    const { directory, spec } = await fixture();
    await expect(
      materializeCoworldPairedMatrix({
        spec: {
          ...spec,
          candidate: { ...spec.candidate, image: "candidate:latest" },
        },
        specDirectory: directory,
      }),
    ).rejects.toThrow(":latest is not allowed");
    await expect(
      materializeCoworldPairedMatrix({
        spec: {
          ...spec,
          candidate: {
            ...spec.candidate,
            env: { PROXYWAR_KEYSTONE_SINGLE_ACTION: "1" },
          },
        },
        specDirectory: directory,
      }),
    ).rejects.toThrow("matrix owns the treatment flag");
  });

  test("rejects invalid opponent cardinality, seats, variants, and seeds", async () => {
    const { directory, spec } = await fixture();
    const cases: Array<[Partial<CoworldPairedMatrixSpec>, string]> = [
      [{ opponents: spec.opponents.slice(0, 2) }, "needs 3 opponents"],
      [{ candidateSeats: [4] }, "outside"],
      [{ variantIDs: ["missing"] }, "Unknown Coworld variant"],
      [{ seeds: [308_915_776] }, "0..308915775"],
    ];
    for (const [change, message] of cases) {
      await expect(
        materializeCoworldPairedMatrix({
          spec: { ...spec, ...change },
          specDirectory: directory,
        }),
      ).rejects.toThrow(message);
    }
  });
});
