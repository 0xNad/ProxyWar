import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  materializeCoworldPairedMatrix,
  type CoworldMatrixSchemaValidator,
  type CoworldPairedMatrixSpec,
} from "../../src/scripts/coworld-paired-matrix";

function variant(id: string, map: string, seats = 4): Record<string, unknown> {
  return {
    id,
    name: `${seats} player ${map}`,
    game_config: {
      players: Array.from({ length: seats }, (_, index) => ({
        name: `Seat ${index}`,
      })),
      map,
    },
    description: "Paired matrix test variant.",
  };
}

function validManifest(variants: Record<string, unknown>[]): object {
  const configSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["tokens", "players", "map"],
    properties: {
      tokens: {
        type: "array",
        minItems: 2,
        maxItems: 12,
        items: { type: "string", minLength: 1 },
      },
      players: {
        type: "array",
        minItems: 2,
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: { name: { type: "string", minLength: 1 } },
        },
      },
      map: { type: "string", enum: ["Asia", "Europe", "Pangaea"] },
      seed: { type: "integer", minimum: 0, maximum: 308_915_775 },
    },
  };
  return {
    $schema:
      "https://raw.githubusercontent.com/Metta-AI/coworld/main/src/coworld/coworld_manifest_schema.json",
    game: {
      name: "paired-test",
      version: "1.0.0",
      description: "Paired matrix test world.",
      owner: "proxywar",
      config_schema: configSchema,
      results_schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["scores"],
        properties: {
          scores: {
            type: "array",
            minItems: 2,
            maxItems: 12,
            items: { type: "number" },
          },
        },
      },
      runnable: {
        type: "game",
        image: "game:v1",
        run: ["node", "/app/game.js"],
        env: {},
      },
      protocols: {
        player: { type: "text", value: "Test player protocol." },
        global: { type: "text", value: "Test global protocol." },
      },
      docs: {
        readme: { type: "text", value: "# Paired matrix test" },
        pages: [],
      },
    },
    player: [
      {
        type: "player",
        image: "starter:v1",
        run: ["node", "/app/player.js"],
        env: {},
        id: "starter",
        name: "Starter",
        description: "Test starter.",
      },
    ],
    reporter: [],
    commissioner: [],
    grader: [],
    diagnoser: [],
    optimizer: [],
    variants,
    certification: {
      game_config: {
        players: [{ name: "One" }, { name: "Two" }],
        map: "Asia",
      },
      players: [{ player_id: "starter" }, { player_id: "starter" }],
    },
  };
}

async function fixture(input?: {
  variants?: Record<string, unknown>[];
}): Promise<{
  directory: string;
  manifestPath: string;
  outputRoot: string;
  spec: CoworldPairedMatrixSpec;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "coworld-paired-"));
  const manifestPath = path.join(directory, "manifest.json");
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      validManifest(input?.variants ?? [variant("tournament-4p-asia", "Asia")]),
    ),
  );
  return {
    directory,
    manifestPath,
    outputRoot: path.join(directory, "matrix"),
    spec: {
      manifestPath: "manifest.json",
      outputRoot: "matrix",
      candidate: {
        image: "candidate:v1",
        run: ["node", "/app/candidate.js"],
        env: { PROXYWAR_KEYSTONE_MODE: "mock" },
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

async function fakeImageID(reference: string): Promise<string> {
  return `sha256:${createHash("sha256").update(reference).digest("hex")}`;
}

const acceptSchema: CoworldMatrixSchemaValidator = async () => {};

describe("Coworld paired matrix planner", () => {
  test("validates in memory, resolves images, and atomically publishes paired requests", async () => {
    const { directory, outputRoot, spec } = await fixture();
    let validationObserved = false;
    const validateCoworld: CoworldMatrixSchemaValidator = async (input) => {
      validationObserved = true;
      expect(input.requests).toHaveLength(4);
      await expect(fs.lstat(outputRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    };
    const plan = await materializeCoworldPairedMatrix({
      spec,
      specDirectory: directory,
      gameImageOverride: "game:v2",
      resolveImageID: fakeImageID,
      validateCoworld,
      now: new Date("2026-07-14T00:00:00.000Z"),
    });

    expect(validationObserved).toBe(true);
    expect(plan.schemaVersion).toBe(2);
    expect(plan.coworldVersion).toBe("0.1.30");
    expect(plan.matrixID).toMatch(/^matrix-[0-9a-f]{32}$/);
    expect(plan.manifestSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.jobs).toHaveLength(4);
    expect(plan.jobs.map((job) => job.arm)).toEqual([
      "control",
      "treatment",
      "treatment",
      "control",
    ]);
    expect(new Set(plan.jobs.map((job) => job.jobID)).size).toBe(4);
    expect(new Set(plan.jobs.map((job) => job.requestPath)).size).toBe(4);
    expect(plan.candidateImage).toEqual({
      reference: "candidate:v1",
      imageID: await fakeImageID("candidate:v1"),
    });
    expect(plan.gameImage).toEqual({
      reference: "game:v2",
      imageID: await fakeImageID("game:v2"),
    });
    expect(plan.opponentImages).toEqual(
      await Promise.all(
        [0, 1, 2].map(async (index) => ({
          reference: `opponent-${index}:v1`,
          imageID: await fakeImageID(`opponent-${index}:v1`),
        })),
      ),
    );
    expect(plan.jobs[0]!.opponentImages).toEqual(plan.opponentImages);

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
    expect(
      requests[0].game_config.players.map(({ name }: { name: string }) => name),
    ).toEqual(["Auri", "Opponent 0", "Opponent 1", "Opponent 2"]);
    expect(requests.map((request) => request.players[0].env)).toEqual([
      {
        PROXYWAR_KEYSTONE_MODE: "mock",
        PROXYWAR_KEYSTONE_SINGLE_ACTION: "0",
      },
      {
        PROXYWAR_KEYSTONE_MODE: "mock",
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
      await fs.readFile(path.join(outputRoot, "plan.json"), "utf8"),
    );
    expect(savedPlan.generatedAt).toBe("2026-07-14T00:00:00.000Z");
    expect(savedPlan.jobs).toHaveLength(4);
    expect(
      (await fs.readdir(directory)).filter((entry) =>
        entry.includes(".matrix.staging-"),
      ),
    ).toEqual([]);
  });

  test("resolved image identities participate in matrix and pair IDs", async () => {
    const first = await fixture();
    const second = await fixture();
    const planA = await materializeCoworldPairedMatrix({
      spec: first.spec,
      specDirectory: first.directory,
      resolveImageID: fakeImageID,
      validateCoworld: acceptSchema,
    });
    const planB = await materializeCoworldPairedMatrix({
      spec: second.spec,
      specDirectory: second.directory,
      resolveImageID: async (reference) =>
        fakeImageID(`${reference}-different-build`),
      validateCoworld: acceptSchema,
    });

    expect(planA.matrixID).not.toBe(planB.matrixID);
    expect(planA.jobs[0]!.pairID).not.toBe(planB.jobs[0]!.pairID);
  });

  test("rejects existing or source-overlapping output without touching sources", async () => {
    const existing = await fixture();
    await fs.mkdir(existing.outputRoot);
    let resolverCalls = 0;
    await expect(
      materializeCoworldPairedMatrix({
        spec: existing.spec,
        specDirectory: existing.directory,
        resolveImageID: async (reference) => {
          resolverCalls += 1;
          return fakeImageID(reference);
        },
        validateCoworld: acceptSchema,
      }),
    ).rejects.toThrow("outputRoot already exists");
    expect(resolverCalls).toBe(0);

    const overlap = await fixture();
    const before = await fs.readFile(overlap.manifestPath, "utf8");
    await expect(
      materializeCoworldPairedMatrix({
        spec: overlap.spec,
        specDirectory: overlap.directory,
        outputRootOverride: overlap.directory,
        resolveImageID: fakeImageID,
        validateCoworld: acceptSchema,
      }),
    ).rejects.toThrow("must not overlap source path");
    expect(await fs.readFile(overlap.manifestPath, "utf8")).toBe(before);
  });

  test("schema or later-variant failure leaves no partial or stale output", async () => {
    const schemaFailure = await fixture();
    await expect(
      materializeCoworldPairedMatrix({
        spec: schemaFailure.spec,
        specDirectory: schemaFailure.directory,
        resolveImageID: fakeImageID,
        validateCoworld: async () => {
          throw new Error("synthetic schema failure");
        },
      }),
    ).rejects.toThrow("synthetic schema failure");
    await expect(fs.lstat(schemaFailure.outputRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const variantFailure = await fixture({
      variants: [
        variant("tournament-4p-asia", "Asia"),
        variant("tournament-3p-europe", "Europe", 3),
      ],
    });
    await expect(
      materializeCoworldPairedMatrix({
        spec: {
          ...variantFailure.spec,
          variantIDs: ["tournament-4p-asia", "tournament-3p-europe"],
        },
        specDirectory: variantFailure.directory,
        resolveImageID: fakeImageID,
        validateCoworld: acceptSchema,
      }),
    ).rejects.toThrow("needs 2 opponents");
    await expect(fs.lstat(variantFailure.outputRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rejects implicit latest, mutable latest, malformed specs, and treatment contamination", async () => {
    const { directory, spec } = await fixture();
    const cases: Array<[CoworldPairedMatrixSpec, string]> = [
      [
        {
          ...spec,
          candidate: {
            ...spec.candidate,
            image: "registry.example:5000/repository",
          },
        },
        "explicit tag or digest",
      ],
      [
        {
          ...spec,
          candidate: { ...spec.candidate, image: "candidate:latest" },
        },
        "mutable :latest",
      ],
      [
        {
          ...spec,
          candidate: { ...spec.candidate, name: "" },
        },
        "candidate.name must be a nonempty string",
      ],
      [
        {
          ...spec,
          candidate: { ...spec.candidate, env: [] as any },
        },
        "candidate.env must be a plain object",
      ],
      [
        {
          ...spec,
          opponents: spec.opponents.map((opponent, index) =>
            index === 0
              ? {
                  ...opponent,
                  env: { PROXYWAR_KEYSTONE_SINGLE_ACTION: "1" },
                }
              : opponent,
          ),
        },
        "matrix owns the treatment flag",
      ],
    ];
    for (const [invalidSpec, message] of cases) {
      await expect(
        materializeCoworldPairedMatrix({
          spec: invalidSpec,
          specDirectory: directory,
          resolveImageID: fakeImageID,
          validateCoworld: acceptSchema,
        }),
      ).rejects.toThrow(message);
    }
  });

  test("rejects secret-looking and reserved environment keys without exposing values", async () => {
    const { directory, spec } = await fixture();
    const secretValue = "fake-placeholder-never-print";
    for (const key of [
      "AWS_SECRET_ACCESS_KEY",
      "AUTH_TOKEN",
      "DATABASE_PASSWORD",
      "PRIVATE_KEY",
      "SERVICE_API_KEY",
      "myToken",
      "AWSACCESSKEY",
      "COWORLD_PLAYER_WS_URL",
    ]) {
      let error: unknown;
      try {
        await materializeCoworldPairedMatrix({
          spec: {
            ...spec,
            candidate: {
              ...spec.candidate,
              env: { [key]: secretValue },
            },
          },
          specDirectory: directory,
          resolveImageID: fakeImageID,
          validateCoworld: acceptSchema,
        });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("reserved or secret-looking");
      expect((error as Error).message).not.toContain(secretValue);
    }
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
          resolveImageID: fakeImageID,
          validateCoworld: acceptSchema,
        }),
      ).rejects.toThrow(message);
    }
  });

  test("validates the real 24-request example with pinned Coworld 0.1.30", async () => {
    const specPath = path.resolve(
      "coworld-adapter/coworld/paired-matrix.example.json",
    );
    const spec = JSON.parse(
      await fs.readFile(specPath, "utf8"),
    ) as CoworldPairedMatrixSpec;
    const temporaryRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "coworld-paired-real-"),
    );
    const outputRoot = path.join(temporaryRoot, "matrix");
    const plan = await materializeCoworldPairedMatrix({
      spec,
      specDirectory: path.dirname(specPath),
      outputRootOverride: outputRoot,
      gameImageOverride: "proxywar-coworld-reset:seed-v1",
      sourcePaths: [specPath],
      resolveImageID: fakeImageID,
      now: new Date("2026-07-14T00:00:00.000Z"),
    });

    expect(plan.jobs).toHaveLength(24);
    expect(new Set(plan.jobs.map((job) => job.pairID)).size).toBe(12);
    expect(new Set(plan.jobs.map((job) => job.jobID)).size).toBe(24);
    for (const job of plan.jobs) {
      await expect(fs.lstat(job.requestPath)).resolves.toBeDefined();
    }
  }, 60_000);
});
