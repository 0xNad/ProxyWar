import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  coworldCanonicalSha256,
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
    expect(plan.schemaVersion).toBe(3);
    expect(plan.coworldVersion).toBe("0.1.30");
    expect(plan.matrixID).toMatch(/^matrix-[0-9a-f]{32}$/);
    expect(plan.matrixID).toBe(
      `matrix-${coworldCanonicalSha256(plan.matrixIdentity).slice(7, 39)}`,
    );
    expect(plan.matrixIdentity).toMatchObject({
      contract: "proxywar-coworld-paired-matrix-v3",
      manifestSha256: plan.manifestSha256,
      gameImage: plan.gameImage,
      candidate: {
        reference: plan.candidateImage.reference,
        image: plan.candidateImage,
      },
      opponents: plan.opponentImages.map((image) => ({
        reference: image.reference,
        image,
      })),
      variantIDs: spec.variantIDs,
      candidateSeats: spec.candidateSeats,
      seeds: spec.seeds,
      arms: plan.arms,
    });
    expect(plan.manifestSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.blocks).toHaveLength(2);
    expect(plan.jobs).toHaveLength(4);
    expect(plan.arms.map((arm) => arm.armID)).toEqual(["v16", "a1"]);
    expect(plan.jobs.map((job) => job.arm.armID)).toEqual([
      "v16",
      "a1",
      "a1",
      "v16",
    ]);
    expect(plan.blocks.map((block) => block.armOrder)).toEqual([
      ["v16", "a1"],
      ["a1", "v16"],
    ]);
    expect(plan.blocks.map((block) => block.blockIndex)).toEqual([0, 1]);
    expect(
      plan.jobs.every(
        (job) =>
          job.matrixID === plan.matrixID &&
          job.blockID ===
            plan.blocks.find((block) => block.pairID === job.pairID)?.blockID &&
          job.rosterOrderID.startsWith("roster-") &&
          job.completionPath.endsWith("completion.json"),
      ),
    ).toBe(true);
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
    expect(plan.materializedManifestPath).toBe(
      path.join(outputRoot, "payload", "manifest.json"),
    );
    expect(plan.planPath).toBe(path.join(outputRoot, "plan.json"));
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
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "0",
      },
      {
        PROXYWAR_KEYSTONE_MODE: "mock",
        PROXYWAR_KEYSTONE_SINGLE_ACTION: "1",
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "0",
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

  test("materializes allowlisted N-arm blocks with deterministic balanced order", async () => {
    const { directory, spec } = await fixture();
    const plan = await materializeCoworldPairedMatrix({
      spec: {
        ...spec,
        candidateSeats: [0, 1, 2, 3],
        arms: [
          { kind: "a1-shadow", expertMask: 15 },
          { kind: "v16-shadow", expertMask: 5 },
          { kind: "a1" },
          { kind: "v16" },
        ],
      },
      specDirectory: directory,
      resolveImageID: fakeImageID,
      validateCoworld: acceptSchema,
    });

    const armIDs = ["v16", "a1", "v16-shadow-m5", "a1-shadow-m15"];
    expect(plan.arms.map((arm) => arm.armID)).toEqual(armIDs);
    expect(plan.blocks.map((block) => block.armOrder)).toEqual([
      armIDs,
      ["a1", "v16-shadow-m5", "a1-shadow-m15", "v16"],
      ["v16-shadow-m5", "a1-shadow-m15", "v16", "a1"],
      ["a1-shadow-m15", "v16", "a1", "v16-shadow-m5"],
    ]);
    expect(plan.jobs).toHaveLength(16);
    for (let position = 0; position < armIDs.length; position += 1) {
      expect(
        plan.blocks.map((block) => block.armOrder[position]).sort(),
      ).toEqual([...armIDs].sort());
    }

    const shadow = plan.jobs.find((job) => job.arm.armID === "v16-shadow-m5")!;
    expect(shadow.expertMask).toBe(5);
    expect(shadow.arm).toEqual({
      armID: "v16-shadow-m5",
      kind: "v16-shadow",
      base: "v16",
      shadow: true,
      expertMask: 5,
      env: {
        PROXYWAR_KEYSTONE_SINGLE_ACTION: "0",
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "1",
        PROXYWAR_KEYSTONE_EXPERT_MASK: "5",
      },
    });
    expect(shadow.roster[shadow.candidateSeat]!.env).toMatchObject(
      shadow.arm.env,
    );
    expect(
      plan.blocks[0]!.roster[plan.blocks[0]!.candidateSeat]!.env,
    ).not.toHaveProperty("PROXYWAR_KEYSTONE_SINGLE_ACTION");
  });

  test("materializes a dedicated v16 politics-guard arm without contaminating control", async () => {
    const { directory, spec } = await fixture();
    const plan = await materializeCoworldPairedMatrix({
      spec: {
        ...spec,
        candidateSeats: [0],
        arms: [{ kind: "v16" }, { kind: "v16-politics-guard" }],
      },
      specDirectory: directory,
      resolveImageID: fakeImageID,
      validateCoworld: acceptSchema,
    });

    expect(plan.arms.map(({ armID }) => armID)).toEqual([
      "v16",
      "v16-politics-guard",
    ]);
    const control = plan.jobs.find((job) => job.arm.armID === "v16")!;
    const guard = plan.jobs.find(
      (job) => job.arm.armID === "v16-politics-guard",
    )!;
    expect(control.arm.env).not.toHaveProperty(
      "PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD",
    );
    expect(guard.arm).toEqual({
      armID: "v16-politics-guard",
      kind: "v16-politics-guard",
      base: "v16",
      shadow: false,
      expertMask: 15,
      env: {
        PROXYWAR_KEYSTONE_SINGLE_ACTION: "0",
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "0",
        PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD: "1",
        PROXYWAR_KEYSTONE_EXPERT_MASK: "15",
      },
    });
    expect(guard.roster[guard.candidateSeat]!.env).toMatchObject(guard.arm.env);
  });

  test("materializes a dedicated v16 diplomacy-adjudicator arm without contaminating control", async () => {
    const { directory, spec } = await fixture();
    const plan = await materializeCoworldPairedMatrix({
      spec: {
        ...spec,
        candidateSeats: [0],
        arms: [{ kind: "v16" }, { kind: "v16-diplomacy-adjudicator" }],
      },
      specDirectory: directory,
      resolveImageID: fakeImageID,
      validateCoworld: acceptSchema,
    });

    expect(plan.arms.map(({ armID }) => armID)).toEqual([
      "v16",
      "v16-diplomacy-adjudicator",
    ]);
    const control = plan.jobs.find((job) => job.arm.armID === "v16")!;
    const adjudicator = plan.jobs.find(
      (job) => job.arm.armID === "v16-diplomacy-adjudicator",
    )!;
    expect(control.arm.env).not.toHaveProperty(
      "PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR",
    );
    expect(adjudicator.arm).toEqual({
      armID: "v16-diplomacy-adjudicator",
      kind: "v16-diplomacy-adjudicator",
      base: "v16",
      shadow: false,
      expertMask: 15,
      env: {
        PROXYWAR_KEYSTONE_SINGLE_ACTION: "0",
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "0",
        PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR: "1",
        PROXYWAR_KEYSTONE_EXPERT_MASK: "15",
      },
    });
    expect(adjudicator.arm.env).not.toHaveProperty(
      "PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD",
    );
    expect(adjudicator.roster[adjudicator.candidateSeat]!.env).toMatchObject(
      adjudicator.arm.env,
    );
  });

  test("materializes a dedicated v16 survival-shield arm without contaminating control", async () => {
    const { directory, spec } = await fixture();
    const plan = await materializeCoworldPairedMatrix({
      spec: {
        ...spec,
        candidateSeats: [0],
        arms: [{ kind: "v16" }, { kind: "v16-survival-shield" }],
      },
      specDirectory: directory,
      resolveImageID: fakeImageID,
      validateCoworld: acceptSchema,
    });

    expect(plan.arms.map(({ armID }) => armID)).toEqual([
      "v16",
      "v16-survival-shield",
    ]);
    const control = plan.jobs.find((job) => job.arm.armID === "v16")!;
    const shield = plan.jobs.find(
      (job) => job.arm.armID === "v16-survival-shield",
    )!;
    expect(control.arm.env).not.toHaveProperty(
      "PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD",
    );
    expect(shield.arm).toEqual({
      armID: "v16-survival-shield",
      kind: "v16-survival-shield",
      base: "v16",
      shadow: false,
      expertMask: 15,
      env: {
        PROXYWAR_KEYSTONE_SINGLE_ACTION: "0",
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "0",
        PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD: "1",
        PROXYWAR_KEYSTONE_EXPERT_MASK: "15",
      },
    });
    expect(shield.arm.env).not.toHaveProperty(
      "PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR",
    );
    expect(shield.roster[shield.candidateSeat]!.env).toMatchObject(
      shield.arm.env,
    );
  });

  test("materializes mutually isolated same-image v39 treatment arms", async () => {
    const { directory, spec } = await fixture();
    const plan = await materializeCoworldPairedMatrix({
      spec: {
        ...spec,
        candidateSeats: [0],
        arms: [
          { kind: "v39" },
          { kind: "v39-commander-retention" },
          { kind: "v39-defense-authority" },
        ],
      },
      specDirectory: directory,
      resolveImageID: fakeImageID,
      validateCoworld: acceptSchema,
    });

    expect(plan.arms.map(({ armID }) => armID)).toEqual([
      "v39",
      "v39-commander-retention",
      "v39-defense-authority",
    ]);
    const [control, commander, defense] = plan.arms;
    expect(control).toEqual({
      armID: "v39",
      kind: "v39",
      base: "v16",
      shadow: false,
      expertMask: 15,
      env: {
        PROXYWAR_KEYSTONE_SINGLE_ACTION: "0",
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "0",
        PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD: "1",
        PROXYWAR_KEYSTONE_COMMANDER_RETENTION: "0",
        PROXYWAR_KEYSTONE_DEFENSE_AUTHORITY: "0",
        PROXYWAR_KEYSTONE_EXPERT_MASK: "15",
      },
    });
    expect(commander?.env).toEqual({
      ...control?.env,
      PROXYWAR_KEYSTONE_COMMANDER_RETENTION: "1",
    });
    expect(defense?.env).toEqual({
      ...control?.env,
      PROXYWAR_KEYSTONE_DEFENSE_AUTHORITY: "1",
    });
    expect(
      Object.keys(control!.env).filter(
        (key) => control!.env[key] !== commander!.env[key],
      ),
    ).toEqual(["PROXYWAR_KEYSTONE_COMMANDER_RETENTION"]);
    expect(
      Object.keys(control!.env).filter(
        (key) => control!.env[key] !== defense!.env[key],
      ),
    ).toEqual(["PROXYWAR_KEYSTONE_DEFENSE_AUTHORITY"]);
    for (const job of plan.jobs) {
      expect(job.roster[job.candidateSeat]!.env).toMatchObject(job.arm.env);
    }
  });

  test("materializes an exact v40 control and isolated balance-of-power treatment", async () => {
    const { directory, spec } = await fixture();
    const plan = await materializeCoworldPairedMatrix({
      spec: {
        ...spec,
        candidateSeats: [0],
        arms: [{ kind: "v40" }, { kind: "v40-balance-of-power" }],
      },
      specDirectory: directory,
      resolveImageID: fakeImageID,
      validateCoworld: acceptSchema,
    });

    expect(plan.arms.map(({ armID }) => armID)).toEqual([
      "v40",
      "v40-balance-of-power",
    ]);
    const [control, balance] = plan.arms;
    expect(control).toEqual({
      armID: "v40",
      kind: "v40",
      base: "v16",
      shadow: false,
      expertMask: 15,
      env: {
        PROXYWAR_KEYSTONE_SINGLE_ACTION: "0",
        PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: "0",
        PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD: "1",
        PROXYWAR_KEYSTONE_COMMANDER_RETENTION: "1",
        PROXYWAR_KEYSTONE_DEFENSE_AUTHORITY: "0",
        PROXYWAR_KEYSTONE_COUNCIL_BALANCE_OF_POWER: "0",
        PROXYWAR_KEYSTONE_EXPERT_MASK: "15",
      },
    });
    expect(balance?.env).toEqual({
      ...control?.env,
      PROXYWAR_KEYSTONE_COUNCIL_BALANCE_OF_POWER: "1",
    });
    expect(
      Object.keys(control!.env).filter(
        (key) => control!.env[key] !== balance!.env[key],
      ),
    ).toEqual(["PROXYWAR_KEYSTONE_COUNCIL_BALANCE_OF_POWER"]);
    for (const job of plan.jobs) {
      expect(job.roster[job.candidateSeat]!.env).toMatchObject(job.arm.env);
    }
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

  test("rejects mutable image drift immediately before publication", async () => {
    const { directory, outputRoot, spec } = await fixture();
    const calls = new Map<string, number>();
    await expect(
      materializeCoworldPairedMatrix({
        spec,
        specDirectory: directory,
        resolveImageID: async (reference) => {
          const count = (calls.get(reference) ?? 0) + 1;
          calls.set(reference, count);
          return fakeImageID(
            reference === "candidate:v1" && count > 1
              ? `${reference}-drifted`
              : reference,
          );
        },
        validateCoworld: acceptSchema,
      }),
    ).rejects.toThrow("Local Docker image changed while planning");
    await expect(fs.lstat(outputRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(calls.get("candidate:v1")).toBe(2);
    expect(
      (await fs.readdir(directory)).filter((entry) =>
        entry.includes(".matrix.staging-"),
      ),
    ).toEqual([]);
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

  test("an output path created during publication is never replaced", async () => {
    const { directory, outputRoot, spec } = await fixture();
    const sentinel = path.join(outputRoot, "racer-owned.txt");
    await expect(
      materializeCoworldPairedMatrix({
        spec,
        specDirectory: directory,
        resolveImageID: fakeImageID,
        validateCoworld: acceptSchema,
        beforeOutputReservation: async () => {
          await fs.mkdir(outputRoot);
          await fs.writeFile(sentinel, "leave-this-untouched");
        },
      }),
    ).rejects.toThrow("appeared before publication; refusing to replace it");

    expect(await fs.readFile(sentinel, "utf8")).toBe("leave-this-untouched");
    expect(await fs.readdir(outputRoot)).toEqual(["racer-owned.txt"]);
    expect(
      (await fs.readdir(directory)).filter((entry) =>
        entry.includes(".matrix.staging-"),
      ),
    ).toEqual([]);
  });

  test("post-marker unlink failure remains a successful complete publication", async () => {
    const { directory, outputRoot, spec } = await fixture();
    const unlink = vi
      .spyOn(fs, "unlink")
      .mockRejectedValueOnce(new Error("synthetic post-marker unlink failure"));
    try {
      const plan = await materializeCoworldPairedMatrix({
        spec,
        specDirectory: directory,
        resolveImageID: fakeImageID,
        validateCoworld: acceptSchema,
      });

      await expect(fs.lstat(plan.planPath)).resolves.toBeDefined();
      await expect(
        fs.lstat(plan.materializedManifestPath),
      ).resolves.toBeDefined();
      for (const job of plan.jobs) {
        await expect(fs.lstat(job.requestPath)).resolves.toBeDefined();
      }
      expect(
        (await fs.readdir(directory)).filter((entry) =>
          entry.includes(".matrix.staging-"),
        ),
      ).toEqual([]);
      expect((await fs.readdir(outputRoot)).sort()).toEqual([
        "payload",
        "plan.json",
      ]);
    } finally {
      unlink.mockRestore();
    }
  });

  test("pre-marker link failure throws and leaves no completion marker", async () => {
    const { directory, outputRoot, spec } = await fixture();
    const link = vi
      .spyOn(fs, "link")
      .mockRejectedValueOnce(new Error("synthetic pre-marker link failure"));
    try {
      await expect(
        materializeCoworldPairedMatrix({
          spec,
          specDirectory: directory,
          resolveImageID: fakeImageID,
          validateCoworld: acceptSchema,
        }),
      ).rejects.toThrow("synthetic pre-marker link failure");
      await expect(
        fs.lstat(path.join(outputRoot, "plan.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.lstat(path.join(outputRoot, "payload", "manifest.json")),
      ).resolves.toBeDefined();
    } finally {
      link.mockRestore();
    }
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

  test("rejects mutable images, malformed specs, and arm-owned environment contamination", async () => {
    const { directory, spec } = await fixture();
    const cases: Array<[CoworldPairedMatrixSpec, string]> = [
      [
        {
          ...spec,
          opponents: Array.from({ length: 12 }, () => spec.opponents[0]!),
        },
        "opponents must contain 1..11 runnables",
      ],
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
        "candidate.name must be a bounded nonempty string",
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
        "must not set arm-owned key",
      ],
      [
        {
          ...spec,
          candidate: {
            ...spec.candidate,
            env: { PROXYWAR_KEYSTONE_COMMANDER_RETENTION: "1" },
          },
        },
        "must not set arm-owned key",
      ],
      [
        {
          ...spec,
          candidate: {
            ...spec.candidate,
            env: { PROXYWAR_KEYSTONE_DEFENSE_AUTHORITY: "1" },
          },
        },
        "must not set arm-owned key",
      ],
      [
        {
          ...spec,
          candidate: {
            ...spec.candidate,
            env: { PROXYWAR_KEYSTONE_COUNCIL_BALANCE_OF_POWER: "1" },
          },
        },
        "must not set arm-owned key",
      ],
      [
        {
          ...spec,
          candidate: {
            ...spec.candidate,
            env: { PROXYWAR_KEYSTONE_EXPERT_MASK: "15" },
          },
        },
        "must not set arm-owned key",
      ],
      [
        {
          ...spec,
          candidate: {
            ...spec.candidate,
            env: { PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD: "1" },
          },
        },
        "must not set arm-owned key",
      ],
      [
        {
          ...spec,
          candidate: {
            ...spec.candidate,
            env: {
              PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR: "1",
            },
          },
        },
        "must not set arm-owned key",
      ],
      [
        {
          ...spec,
          opponents: spec.opponents.map((opponent, index) =>
            index === 0
              ? {
                  ...opponent,
                  env: { PROFILE: "   " },
                }
              : opponent,
          ),
        },
        "must not be empty or whitespace",
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

  test("rejects non-unique, invalid, unknown, and reserved authority arms", async () => {
    const { directory, spec } = await fixture();
    const cases: Array<[CoworldPairedMatrixSpec["arms"], string]> = [
      [[{ kind: "v16" }], "at least two"],
      [[{ kind: "v16" }, { kind: "v16" }], "unique arm identities"],
      [
        [{ kind: "v16" }, { kind: "v16-shadow", expertMask: 16 }],
        "integer in 0..15",
      ],
      [
        [{ kind: "v16" }, { kind: "council-authoritative" }],
        "reserved until a reviewed authoritative council runtime exists",
      ],
      [[{ kind: "v16" }, { kind: "unknown" } as never], "not allowlisted"],
    ];
    for (const [arms, message] of cases) {
      await expect(
        materializeCoworldPairedMatrix({
          spec: { ...spec, arms },
          specDirectory: directory,
          resolveImageID: fakeImageID,
          validateCoworld: acceptSchema,
        }),
      ).rejects.toThrow(message);
    }
  });

  test("shares executor bounds and rejects unexecutable runnable identities", async () => {
    const { directory, spec } = await fixture();
    const cases: Array<[CoworldPairedMatrixSpec, string]> = [
      [
        {
          ...spec,
          candidate: { ...spec.candidate, name: "n".repeat(257) },
        },
        "name exceeds the paired name limit",
      ],
      [
        {
          ...spec,
          candidate: {
            ...spec.candidate,
            run: Array.from({ length: 129 }, () => "argument"),
          },
        },
        "bounded nonempty argv array",
      ],
      [
        {
          ...spec,
          candidate: {
            ...spec.candidate,
            env: Object.fromEntries(
              Array.from({ length: 126 }, (_, index) => [
                `PUBLIC_${index}`,
                "value",
              ]),
            ),
          },
        },
        "env exceeds the paired entry limit",
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

  test("preserves the old candidate environment limit while accounting for the larger v40 identity", async () => {
    const publicEnv = Object.fromEntries(
      Array.from({ length: 122 }, (_, index) => [`PUBLIC_${index}`, "value"]),
    );
    const oldFixture = await fixture();
    await expect(
      materializeCoworldPairedMatrix({
        spec: {
          ...oldFixture.spec,
          candidate: { ...oldFixture.spec.candidate, env: publicEnv },
          arms: [{ kind: "v16" }, { kind: "a1" }],
        },
        specDirectory: oldFixture.directory,
        resolveImageID: fakeImageID,
        validateCoworld: acceptSchema,
      }),
    ).resolves.toBeDefined();

    const v40Fixture = await fixture();
    await expect(
      materializeCoworldPairedMatrix({
        spec: {
          ...v40Fixture.spec,
          candidate: { ...v40Fixture.spec.candidate, env: publicEnv },
          arms: [{ kind: "v40" }, { kind: "v40-balance-of-power" }],
        },
        specDirectory: v40Fixture.directory,
        resolveImageID: fakeImageID,
        validateCoworld: acceptSchema,
      }),
    ).rejects.toThrow(
      "candidate.env plus the selected arm identity exceeds the paired entry limit",
    );
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
      "GITHUB_PAT",
      "GITHUBPAT",
      "AUTH_HEADER",
      "ACCESS_KEY",
      "PUBLIC_KEY",
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

  test("validates the real 48-request N-arm example with pinned Coworld 0.1.30", async () => {
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

    expect(plan.jobs).toHaveLength(48);
    expect(new Set(plan.jobs.map((job) => job.pairID)).size).toBe(12);
    expect(new Set(plan.jobs.map((job) => job.jobID)).size).toBe(48);
    for (const job of plan.jobs) {
      await expect(fs.lstat(job.requestPath)).resolves.toBeDefined();
    }
  }, 60_000);
});
