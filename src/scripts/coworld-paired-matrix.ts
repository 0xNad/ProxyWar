import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_SEED = 308_915_775;
const TREATMENT_ENV = "PROXYWAR_KEYSTONE_SINGLE_ACTION";

type JsonObject = Record<string, unknown>;

export interface PairedRunnableSpec {
  image: string;
  run?: string[];
  env?: Record<string, string>;
  name?: string;
}

export interface CoworldPairedMatrixSpec {
  manifestPath: string;
  outputRoot: string;
  candidate: PairedRunnableSpec;
  opponents: PairedRunnableSpec[];
  variantIDs: string[];
  candidateSeats: number[];
  seeds: number[];
}

export interface CoworldPairedJob {
  jobID: string;
  pairID: string;
  pairOrder: number;
  arm: "control" | "treatment";
  treatmentValue: "0" | "1";
  variantID: string;
  map: string;
  candidateSeat: number;
  seed: number;
  requestPath: string;
  outputDir: string;
  candidateImage: string;
  gameImage: string;
  opponentImages: string[];
}

export interface CoworldPairedPlan {
  schemaVersion: 1;
  generatedAt: string;
  manifestPath: string;
  materializedManifestPath: string;
  candidateImage: string;
  gameImage: string;
  jobs: CoworldPairedJob[];
}

interface ParsedArguments {
  specPath: string;
  outputRoot?: string;
  gameImage?: string;
  execute: boolean;
}

export async function materializeCoworldPairedMatrix(input: {
  spec: CoworldPairedMatrixSpec;
  specDirectory: string;
  outputRootOverride?: string;
  gameImageOverride?: string;
  now?: Date;
}): Promise<CoworldPairedPlan> {
  validateMatrixSpec(input.spec);
  const manifestPath = resolveFrom(
    input.specDirectory,
    input.spec.manifestPath,
  );
  const outputRoot = resolveFrom(
    input.specDirectory,
    input.outputRootOverride ?? input.spec.outputRoot,
  );
  const manifest = requireObject(
    JSON.parse(await fs.readFile(manifestPath, "utf8")),
    "manifest",
  );
  const game = requireObject(manifest.game, "manifest.game");
  const gameRunnable = requireObject(game.runnable, "manifest.game.runnable");
  const originalGameImage = requireNonemptyString(
    gameRunnable.image,
    "manifest.game.runnable.image",
  );
  const gameImage = validateImageReference(
    input.gameImageOverride ?? originalGameImage,
    "game image",
  );
  gameRunnable.image = gameImage;

  const variants = requireArray(manifest.variants, "manifest.variants").map(
    (value, index) => requireObject(value, `manifest.variants[${index}]`),
  );
  const variantByID = new Map(
    variants.map((variant, index) => [
      requireNonemptyString(variant.id, `manifest.variants[${index}].id`),
      variant,
    ]),
  );
  for (const variantID of input.spec.variantIDs) {
    if (!variantByID.has(variantID)) {
      throw new Error(`Unknown Coworld variant ${JSON.stringify(variantID)}`);
    }
  }

  await fs.mkdir(outputRoot, { recursive: true });
  const materializedManifestPath = path.join(outputRoot, "manifest.json");
  await atomicWriteJson(materializedManifestPath, manifest);

  const jobs: CoworldPairedJob[] = [];
  let pairIndex = 0;
  for (const variantID of input.spec.variantIDs) {
    const variant = variantByID.get(variantID)!;
    const baseGameConfig = requireObject(
      variant.game_config,
      `variant ${variantID}.game_config`,
    );
    const playerConfig = requireArray(
      baseGameConfig.players,
      `variant ${variantID}.game_config.players`,
    );
    const seatCount = playerConfig.length;
    if (seatCount < 2) {
      throw new Error(`Variant ${variantID} must have at least two seats`);
    }
    if (input.spec.opponents.length !== seatCount - 1) {
      throw new Error(
        `Variant ${variantID} needs ${seatCount - 1} opponents; received ${input.spec.opponents.length}`,
      );
    }
    for (const candidateSeat of input.spec.candidateSeats) {
      if (candidateSeat >= seatCount) {
        throw new Error(
          `Candidate seat ${candidateSeat} is outside ${variantID}'s ${seatCount} seats`,
        );
      }
      for (const seed of input.spec.seeds) {
        const pairID = stableID("pair", variantID, candidateSeat, seed);
        const armOrder: Array<"control" | "treatment"> =
          pairIndex % 2 === 0
            ? ["control", "treatment"]
            : ["treatment", "control"];
        for (const [pairOrder, arm] of armOrder.entries()) {
          const treatmentValue = arm === "treatment" ? "1" : "0";
          const jobID = `${pairID}-${arm}`;
          const jobDirectory = path.join(outputRoot, "jobs", jobID);
          const requestPath = path.join(jobDirectory, "episode_request.json");
          const episodeOutput = path.join(jobDirectory, "episode");
          const players = playerRunnables({
            candidate: input.spec.candidate,
            opponents: input.spec.opponents,
            candidateSeat,
            treatmentValue,
          });
          const names = players.map((player, seat) => ({
            name:
              seat === candidateSeat
                ? (input.spec.candidate.name ?? `Candidate seat ${seat}`)
                : (input.spec.opponents[seat < candidateSeat ? seat : seat - 1]!
                    .name ?? `Opponent seat ${seat}`),
          }));
          const request = {
            manifest,
            game_config: {
              ...structuredClone(baseGameConfig),
              players: names,
              seed,
            },
            players,
            episode_tags: {
              proxywar_matrix: "keystone-single-action-v1",
              proxywar_pair_id: pairID,
              proxywar_arm: arm,
            },
          };
          await fs.mkdir(jobDirectory, { recursive: true });
          await atomicWriteJson(requestPath, request);
          jobs.push({
            jobID,
            pairID,
            pairOrder,
            arm,
            treatmentValue,
            variantID,
            map: requireNonemptyString(
              baseGameConfig.map,
              `variant ${variantID}.game_config.map`,
            ),
            candidateSeat,
            seed,
            requestPath,
            outputDir: episodeOutput,
            candidateImage: input.spec.candidate.image,
            gameImage,
            opponentImages: input.spec.opponents.map(
              (opponent) => opponent.image,
            ),
          });
        }
        pairIndex += 1;
      }
    }
  }

  const plan: CoworldPairedPlan = {
    schemaVersion: 1,
    generatedAt: (input.now ?? new Date()).toISOString(),
    manifestPath,
    materializedManifestPath,
    candidateImage: input.spec.candidate.image,
    gameImage,
    jobs,
  };
  await atomicWriteJson(path.join(outputRoot, "plan.json"), plan);
  return plan;
}

function playerRunnables(input: {
  candidate: PairedRunnableSpec;
  opponents: PairedRunnableSpec[];
  candidateSeat: number;
  treatmentValue: "0" | "1";
}): JsonObject[] {
  const seatCount = input.opponents.length + 1;
  let opponentIndex = 0;
  return Array.from({ length: seatCount }, (_, seat) => {
    if (seat === input.candidateSeat) {
      return runnable(input.candidate, {
        [TREATMENT_ENV]: input.treatmentValue,
      });
    }
    return runnable(input.opponents[opponentIndex++]!);
  });
}

function runnable(
  spec: PairedRunnableSpec,
  envOverride: Record<string, string> = {},
): JsonObject {
  const env = { ...(spec.env ?? {}), ...envOverride };
  return {
    type: "player",
    image: spec.image,
    ...(spec.run === undefined ? {} : { run: [...spec.run] }),
    env,
  };
}

function validateMatrixSpec(spec: CoworldPairedMatrixSpec): void {
  requireNonemptyString(spec.manifestPath, "manifestPath");
  requireNonemptyString(spec.outputRoot, "outputRoot");
  validateRunnable(spec.candidate, "candidate");
  if (spec.candidate.env?.[TREATMENT_ENV] !== undefined) {
    throw new Error(
      `candidate.env must not set ${TREATMENT_ENV}; the matrix owns the treatment flag`,
    );
  }
  if (!Array.isArray(spec.opponents) || spec.opponents.length === 0) {
    throw new Error("opponents must contain at least one runnable");
  }
  spec.opponents.forEach((opponent, index) =>
    validateRunnable(opponent, `opponents[${index}]`),
  );
  validateUniqueStrings(spec.variantIDs, "variantIDs");
  validateUniqueIntegers(spec.candidateSeats, "candidateSeats", 0, 11);
  validateUniqueIntegers(spec.seeds, "seeds", 0, MAX_SEED);
}

function validateRunnable(spec: PairedRunnableSpec, label: string): void {
  validateImageReference(spec.image, `${label}.image`);
  if (spec.run !== undefined) {
    if (!Array.isArray(spec.run) || spec.run.length === 0) {
      throw new Error(
        `${label}.run must be a nonempty argv array when supplied`,
      );
    }
    for (const [index, value] of spec.run.entries()) {
      requireNonemptyString(value, `${label}.run[${index}]`);
    }
  }
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    requireNonemptyString(key, `${label}.env key`);
    if (typeof value !== "string") {
      throw new Error(`${label}.env.${key} must be a public string`);
    }
  }
}

function validateImageReference(value: unknown, label: string): string {
  const image = requireNonemptyString(value, label);
  if (!image.includes(":") && !image.includes("@sha256:")) {
    throw new Error(`${label} must include an explicit tag or digest`);
  }
  if (image.endsWith(":latest")) {
    throw new Error(`${label} must be immutable; :latest is not allowed`);
  }
  return image;
}

function validateUniqueStrings(values: unknown, label: string): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a nonempty array`);
  }
  const strings = values.map((value, index) =>
    requireNonemptyString(value, `${label}[${index}]`),
  );
  if (new Set(strings).size !== strings.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
}

function validateUniqueIntegers(
  values: unknown,
  label: string,
  min: number,
  max: number,
): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must be a nonempty array`);
  }
  for (const [index, value] of values.entries()) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(
        `${label}[${index}] must be an integer in ${min}..${max}`,
      );
    }
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
}

function requireObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireNonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value;
}

function resolveFrom(directory: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(directory, value);
}

function stableID(
  prefix: string,
  variantID: string,
  candidateSeat: number,
  seed: number,
): string {
  const digest = createHash("sha256")
    .update(`${variantID}\0${candidateSeat}\0${seed}`)
    .digest("hex")
    .slice(0, 12);
  return `${prefix}-${digest}`;
}

async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryPath, filePath);
}

function parseArguments(argv: string[]): ParsedArguments {
  let specPath: string | undefined;
  let outputRoot: string | undefined;
  let gameImage: string | undefined;
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--spec") {
      specPath = argv[++index];
    } else if (argument === "--output") {
      outputRoot = argv[++index];
    } else if (argument === "--game-image") {
      gameImage = argv[++index];
    } else if (argument === "--execute") {
      execute = true;
    } else if (argument === "--help") {
      process.stdout.write(
        "Usage: npm run league:paired-matrix -- --spec matrix.json [--output DIR] [--game-image IMAGE]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}`);
    }
  }
  if (specPath === undefined) {
    throw new Error("--spec is required");
  }
  return { specPath, outputRoot, gameImage, execute };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.execute) {
    throw new Error(
      "--execute is intentionally unavailable in the dry-run planner; inspect plan.json first",
    );
  }
  const absoluteSpecPath = path.resolve(args.specPath);
  const spec = JSON.parse(
    await fs.readFile(absoluteSpecPath, "utf8"),
  ) as CoworldPairedMatrixSpec;
  const plan = await materializeCoworldPairedMatrix({
    spec,
    specDirectory: path.dirname(absoluteSpecPath),
    outputRootOverride: args.outputRoot,
    gameImageOverride: args.gameImage,
  });
  process.stdout.write(
    `${JSON.stringify({ plan: path.join(path.dirname(plan.materializedManifestPath), "plan.json"), jobs: plan.jobs.length })}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`coworld paired matrix: ${message}\n`);
    process.exitCode = 1;
  });
}
