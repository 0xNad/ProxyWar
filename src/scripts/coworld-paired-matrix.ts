import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_SEED = 308_915_775;
const MAX_JOBS = 1_000;
const COMMAND_TIMEOUT_MS = 60_000;
const TREATMENT_ENV = "PROXYWAR_KEYSTONE_SINGLE_ACTION";
const COWORLD_VERSION = "0.1.30";
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/i;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_ENV_TOKEN_PATTERN =
  /^(?:ACCESS|AUTH|AUTHORIZATION|BEARER|CREDENTIALS?|KEY|OAUTH|PASS|PASSWD|PASSWORD|PAT|PRIVATE|SECRET|SESSION|TOKEN)$/;
const SECRET_ENV_COMPACT_PATTERN =
  /(?:ACCESSKEY|APIKEY|AUTHORIZATION|BEARER|CLIENTSECRET|CREDENTIAL|PASSWORD|PASSWD|PRIVATEKEY|SECRET|TOKEN|PAT$)/;

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

export interface CoworldResolvedImage {
  reference: string;
  imageID: string;
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
  candidateImage: CoworldResolvedImage;
  gameImage: CoworldResolvedImage;
  opponentImages: CoworldResolvedImage[];
}

export interface CoworldPairedPlan {
  schemaVersion: 2;
  coworldVersion: typeof COWORLD_VERSION;
  generatedAt: string;
  matrixID: string;
  manifestSha256: string;
  manifestPath: string;
  planPath: string;
  materializedManifestPath: string;
  candidateImage: CoworldResolvedImage;
  gameImage: CoworldResolvedImage;
  opponentImages: CoworldResolvedImage[];
  jobs: CoworldPairedJob[];
}

export type CoworldMatrixSchemaValidator = (input: {
  manifest: JsonObject;
  requests: JsonObject[];
}) => Promise<void>;

export type CoworldImageResolver = (reference: string) => Promise<string>;

interface ParsedArguments {
  specPath: string;
  outputRoot?: string;
  gameImage?: string;
  execute: boolean;
}

interface PreparedVariant {
  id: string;
  gameConfig: JsonObject;
  map: string;
}

interface PreparedMatrix {
  manifest: JsonObject;
  requests: JsonObject[];
  plan: CoworldPairedPlan;
  outputRoot: string;
}

const COWORLD_VALIDATOR = String.raw`
import json
import sys
from importlib.metadata import version

from jsonschema.exceptions import ValidationError as JsonSchemaValidationError
from pydantic import ValidationError as PydanticValidationError

from coworld.certifier import coworld_episode_request_schema, coworld_manifest_schema
from coworld.manifest_validation import (
    validate_authored_game_config,
    validate_coworld_manifest_game_configs,
    validate_game_config_players_match_count,
)
from coworld.schema_validation import validate_json_schema
from coworld.types import CoworldEpisodeJobSpec, CoworldManifest


def fail(kind, location, message):
    print(json.dumps({"ok": False, "kind": kind, "location": location, "message": message}))
    raise SystemExit(2)


try:
    if version("coworld") != "0.1.30":
        fail("version", "coworld", "unexpected Coworld validator version")

    payload = json.load(sys.stdin)
    manifest = payload["manifest"]
    requests = payload["requests"]

    validate_json_schema(manifest, coworld_manifest_schema())
    typed_manifest = CoworldManifest.model_validate(manifest)
    validate_coworld_manifest_game_configs(typed_manifest)

    for index, request in enumerate(requests):
        validate_json_schema(request, coworld_episode_request_schema())
        typed_request = CoworldEpisodeJobSpec.model_validate(request)
        if typed_request.manifest != typed_manifest:
            fail("manifest_mismatch", f"requests[{index}].manifest", "embedded manifest differs")
        validate_game_config_players_match_count(
            typed_request.game_config,
            len(typed_request.players),
        )
        validate_authored_game_config(
            typed_request.game_config,
            typed_manifest.game.config_schema,
        )

    print(json.dumps({"ok": True, "requests": len(requests)}))
except PydanticValidationError as error:
    issue = error.errors(include_input=False, include_url=False)[0]
    fail("pydantic", ".".join(str(part) for part in issue.get("loc", [])), issue.get("msg", "invalid"))
except JsonSchemaValidationError as error:
    fail("json_schema", ".".join(str(part) for part in error.absolute_path), error.message)
except SystemExit:
    raise
except Exception as error:
    fail(type(error).__name__, "", "Coworld rejected the matrix")
`;

export async function materializeCoworldPairedMatrix(input: {
  spec: CoworldPairedMatrixSpec;
  specDirectory: string;
  outputRootOverride?: string;
  gameImageOverride?: string;
  sourcePaths?: string[];
  now?: Date;
  resolveImageID?: CoworldImageResolver;
  validateCoworld?: CoworldMatrixSchemaValidator;
  beforeOutputReservation?: () => Promise<void>;
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
  assertOutputDoesNotOverlapSources(outputRoot, [
    manifestPath,
    ...(input.sourcePaths ?? []),
  ]);
  await assertPathAbsent(outputRoot, "outputRoot");

  const manifest = requirePlainObject(
    JSON.parse(await fs.readFile(manifestPath, "utf8")),
    "manifest",
  );
  const game = requirePlainObject(manifest.game, "manifest.game");
  const gameRunnable = requirePlainObject(
    game.runnable,
    "manifest.game.runnable",
  );
  const originalGameImage = requireNonemptyString(
    gameRunnable.image,
    "manifest.game.runnable.image",
  );
  const gameImageReference = validateImageReference(
    input.gameImageOverride ?? originalGameImage,
    "game image",
  );
  gameRunnable.image = gameImageReference;

  const preparedVariants = prepareVariants(manifest, input.spec);
  const pairCount =
    preparedVariants.length *
    input.spec.candidateSeats.length *
    input.spec.seeds.length;
  if (pairCount * 2 > MAX_JOBS) {
    throw new Error(
      `Matrix would create ${pairCount * 2} jobs; maximum is ${MAX_JOBS}`,
    );
  }

  const resolveImageID = input.resolveImageID ?? resolveLocalDockerImageID;
  const imageIdentities = await resolveImages(
    [
      gameImageReference,
      input.spec.candidate.image,
      ...input.spec.opponents.map((opponent) => opponent.image),
    ],
    resolveImageID,
  );
  const gameImage = imageIdentities.get(gameImageReference)!;
  const candidateImage = imageIdentities.get(input.spec.candidate.image)!;
  const opponentImages = input.spec.opponents.map(
    (opponent) => imageIdentities.get(opponent.image)!,
  );

  const prepared = prepareMatrix({
    spec: input.spec,
    manifest,
    manifestPath,
    outputRoot,
    variants: preparedVariants,
    candidateImage,
    gameImage,
    opponentImages,
    now: input.now,
  });

  const validateCoworld =
    input.validateCoworld ?? validateCoworldMatrixWithPinnedToolchain;
  await validateCoworld({
    manifest: prepared.manifest,
    requests: prepared.requests,
  });

  // Recheck after the potentially slow Coworld validation gate.
  await assertPathAbsent(outputRoot, "outputRoot");
  await publishPreparedMatrix(prepared, {
    beforeOutputReservation: input.beforeOutputReservation,
    verifyImages: async () => {
      await assertResolvedImagesUnchanged(imageIdentities, resolveImageID);
    },
  });
  return prepared.plan;
}

function prepareVariants(
  manifest: JsonObject,
  spec: CoworldPairedMatrixSpec,
): PreparedVariant[] {
  const variants = requireArray(manifest.variants, "manifest.variants").map(
    (value, index) => requirePlainObject(value, `manifest.variants[${index}]`),
  );
  const variantByID = new Map<string, JsonObject>();
  for (const [index, variant] of variants.entries()) {
    const id = requireNonemptyString(
      variant.id,
      `manifest.variants[${index}].id`,
    );
    if (variantByID.has(id)) {
      throw new Error(
        `manifest.variants contains duplicate id ${JSON.stringify(id)}`,
      );
    }
    variantByID.set(id, variant);
  }

  return spec.variantIDs.map((variantID) => {
    const variant = variantByID.get(variantID);
    if (variant === undefined) {
      throw new Error(`Unknown Coworld variant ${JSON.stringify(variantID)}`);
    }
    const gameConfig = requirePlainObject(
      variant.game_config,
      `variant ${variantID}.game_config`,
    );
    const players = requireArray(
      gameConfig.players,
      `variant ${variantID}.game_config.players`,
    );
    const seatCount = players.length;
    if (seatCount < 2) {
      throw new Error(`Variant ${variantID} must have at least two seats`);
    }
    if (spec.opponents.length !== seatCount - 1) {
      throw new Error(
        `Variant ${variantID} needs ${seatCount - 1} opponents; received ${spec.opponents.length}`,
      );
    }
    for (const candidateSeat of spec.candidateSeats) {
      if (candidateSeat >= seatCount) {
        throw new Error(
          `Candidate seat ${candidateSeat} is outside ${variantID}'s ${seatCount} seats`,
        );
      }
    }
    return {
      id: variantID,
      gameConfig,
      map: requireNonemptyString(
        gameConfig.map,
        `variant ${variantID}.game_config.map`,
      ),
    };
  });
}

function prepareMatrix(input: {
  spec: CoworldPairedMatrixSpec;
  manifest: JsonObject;
  manifestPath: string;
  outputRoot: string;
  variants: PreparedVariant[];
  candidateImage: CoworldResolvedImage;
  gameImage: CoworldResolvedImage;
  opponentImages: CoworldResolvedImage[];
  now?: Date;
}): PreparedMatrix {
  const manifestHex = hashCanonicalJson(input.manifest);
  const manifestSha256 = `sha256:${manifestHex}`;
  const matrixHex = hashCanonicalJson({
    contract: "proxywar-coworld-paired-matrix-v2",
    manifestSha256,
    gameImage: input.gameImage,
    candidate: {
      ...runnableIdentity(input.spec.candidate),
      image: input.candidateImage,
    },
    opponents: input.spec.opponents.map((opponent, index) => ({
      ...runnableIdentity(opponent),
      image: input.opponentImages[index],
    })),
    variantIDs: input.spec.variantIDs,
    candidateSeats: input.spec.candidateSeats,
    seeds: input.spec.seeds,
  });
  const matrixID = `matrix-${matrixHex.slice(0, 32)}`;
  const jobs: CoworldPairedJob[] = [];
  const requests: JsonObject[] = [];
  const pairIDs = new Set<string>();
  const jobIDs = new Set<string>();
  const requestPaths = new Set<string>();
  const outputDirs = new Set<string>();
  let pairIndex = 0;

  for (const variant of input.variants) {
    for (const candidateSeat of input.spec.candidateSeats) {
      for (const seed of input.spec.seeds) {
        const pairID = stableID(
          "pair",
          matrixID,
          variant.id,
          candidateSeat,
          seed,
        );
        assertUnique(pairIDs, pairID, "pair id");
        const armOrder: Array<"control" | "treatment"> =
          pairIndex % 2 === 0
            ? ["control", "treatment"]
            : ["treatment", "control"];
        for (const [pairOrder, arm] of armOrder.entries()) {
          const treatmentValue = arm === "treatment" ? "1" : "0";
          const jobID = `${pairID}-${arm}`;
          assertUnique(jobIDs, jobID, "job id");
          const requestPath = path.join(
            input.outputRoot,
            "payload",
            "jobs",
            jobID,
            "episode_request.json",
          );
          const outputDir = path.join(
            input.outputRoot,
            "payload",
            "jobs",
            jobID,
            "episode",
          );
          assertUnique(requestPaths, requestPath, "request path");
          assertUnique(outputDirs, outputDir, "episode output path");
          const players = playerRunnables({
            candidate: input.spec.candidate,
            opponents: input.spec.opponents,
            candidateSeat,
            treatmentValue,
          });
          const names = players.map((_player, seat) => ({
            name:
              seat === candidateSeat
                ? (input.spec.candidate.name ?? `Candidate seat ${seat}`)
                : (input.spec.opponents[seat < candidateSeat ? seat : seat - 1]!
                    .name ?? `Opponent seat ${seat}`),
          }));
          requests.push({
            manifest: input.manifest,
            game_config: {
              ...structuredClone(variant.gameConfig),
              players: names,
              seed,
            },
            players,
            episode_tags: {
              proxywar_matrix: matrixID,
              proxywar_pair_id: pairID,
              proxywar_arm: arm,
            },
          });
          jobs.push({
            jobID,
            pairID,
            pairOrder,
            arm,
            treatmentValue,
            variantID: variant.id,
            map: variant.map,
            candidateSeat,
            seed,
            requestPath,
            outputDir,
            candidateImage: input.candidateImage,
            gameImage: input.gameImage,
            opponentImages: input.opponentImages,
          });
        }
        pairIndex += 1;
      }
    }
  }

  if (jobs.length !== requests.length) {
    throw new Error("Internal matrix error: job/request cardinality differs");
  }
  const generatedAt = (input.now ?? new Date()).toISOString();
  const materializedManifestPath = path.join(
    input.outputRoot,
    "payload",
    "manifest.json",
  );
  const plan: CoworldPairedPlan = {
    schemaVersion: 2,
    coworldVersion: COWORLD_VERSION,
    generatedAt,
    matrixID,
    manifestSha256,
    manifestPath: input.manifestPath,
    planPath: path.join(input.outputRoot, "plan.json"),
    materializedManifestPath,
    candidateImage: input.candidateImage,
    gameImage: input.gameImage,
    opponentImages: input.opponentImages,
    jobs,
  };
  return {
    manifest: input.manifest,
    requests,
    plan,
    outputRoot: input.outputRoot,
  };
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
  const env = Object.fromEntries([
    ...Object.entries(spec.env ?? {}),
    ...Object.entries(envOverride),
  ]);
  return {
    type: "player",
    image: spec.image,
    ...(spec.run === undefined ? {} : { run: [...spec.run] }),
    env,
  };
}

function runnableIdentity(spec: PairedRunnableSpec): JsonObject {
  return {
    reference: spec.image,
    run: spec.run ?? [],
    env: spec.env ?? {},
    name: spec.name ?? null,
  };
}

function validateMatrixSpec(spec: CoworldPairedMatrixSpec): void {
  const object = requirePlainObject(spec, "matrix spec");
  rejectUnknownKeys(
    object,
    [
      "manifestPath",
      "outputRoot",
      "candidate",
      "opponents",
      "variantIDs",
      "candidateSeats",
      "seeds",
    ],
    "matrix spec",
  );
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
  const object = requirePlainObject(spec, label);
  rejectUnknownKeys(object, ["image", "run", "env", "name"], label);
  validateImageReference(spec.image, `${label}.image`);
  if (spec.name !== undefined) {
    requireNonemptyString(spec.name, `${label}.name`);
  }
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
  if (spec.env === undefined) {
    return;
  }
  const env = requirePlainObject(spec.env, `${label}.env`);
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`${label}.env key ${JSON.stringify(key)} is invalid`);
    }
    if (key === TREATMENT_ENV) {
      throw new Error(
        `${label}.env must not set ${TREATMENT_ENV}; the matrix owns the treatment flag`,
      );
    }
    if (isReservedOrSecretEnvKey(key)) {
      throw new Error(
        `${label}.env key ${JSON.stringify(key)} is reserved or secret-looking; only public configuration is allowed`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(`${label}.env.${key} must be a public string`);
    }
    if (value.trim().length === 0) {
      throw new Error(`${label}.env.${key} must not be empty or whitespace`);
    }
    if (value.includes("\0")) {
      throw new Error(`${label}.env.${key} must not contain NUL bytes`);
    }
  }
}

function isReservedOrSecretEnvKey(key: string): boolean {
  const upper = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  const tokens = upper.split(/_+/).filter((token) => token.length > 0);
  const compact = tokens.join("");
  if (
    upper.startsWith("COWORLD_") ||
    tokens.includes("AWS") ||
    compact.startsWith("AWS") ||
    tokens.some((token) => SECRET_ENV_TOKEN_PATTERN.test(token)) ||
    SECRET_ENV_COMPACT_PATTERN.test(compact) ||
    upper === "__PROTO__" ||
    upper === "PROTOTYPE" ||
    upper === "CONSTRUCTOR"
  ) {
    return true;
  }
  return false;
}

function validateImageReference(value: unknown, label: string): string {
  const image = requireNonemptyString(value, label);
  if (/\s/.test(image)) {
    throw new Error(`${label} must not contain whitespace`);
  }
  const digestIndex = image.lastIndexOf("@");
  if (digestIndex >= 0) {
    if (!/^.+@sha256:[0-9a-f]{64}$/i.test(image)) {
      throw new Error(`${label} must use a complete sha256 digest`);
    }
    return image;
  }
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon <= lastSlash || lastColon === image.length - 1) {
    throw new Error(`${label} must include an explicit tag or digest`);
  }
  const tag = image.slice(lastColon + 1);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) {
    throw new Error(`${label} has an invalid Docker tag`);
  }
  if (tag.toLowerCase() === "latest") {
    throw new Error(`${label} must not use the mutable :latest tag`);
  }
  return image;
}

async function resolveImages(
  references: string[],
  resolver: CoworldImageResolver,
): Promise<Map<string, CoworldResolvedImage>> {
  const uniqueReferences = [...new Set(references)];
  const identities = await Promise.all(
    uniqueReferences.map(async (reference) => {
      const resolved = (await resolver(reference)).trim().toLowerCase();
      if (!IMAGE_ID_PATTERN.test(resolved)) {
        throw new Error(
          `Docker returned an invalid image id for ${JSON.stringify(reference)}`,
        );
      }
      return {
        reference,
        imageID: resolved,
      } satisfies CoworldResolvedImage;
    }),
  );
  return new Map(identities.map((identity) => [identity.reference, identity]));
}

async function assertResolvedImagesUnchanged(
  expected: Map<string, CoworldResolvedImage>,
  resolver: CoworldImageResolver,
): Promise<void> {
  const current = await resolveImages([...expected.keys()], resolver);
  for (const [reference, expectedIdentity] of expected) {
    if (current.get(reference)?.imageID !== expectedIdentity.imageID) {
      throw new Error(
        `Local Docker image changed while planning: ${JSON.stringify(reference)}`,
      );
    }
  }
}

export async function resolveLocalDockerImageID(
  reference: string,
): Promise<string> {
  const result = await runCommand(
    "docker",
    ["image", "inspect", "--format={{.Id}}", reference],
    undefined,
  );
  if (result.code !== 0) {
    throw new Error(
      `Unable to resolve local Docker image ${JSON.stringify(reference)}`,
    );
  }
  const lines = result.stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new Error(
      `Docker returned an unexpected image identity for ${JSON.stringify(reference)}`,
    );
  }
  return lines[0]!;
}

export async function validateCoworldMatrixWithPinnedToolchain(input: {
  manifest: JsonObject;
  requests: JsonObject[];
}): Promise<void> {
  const result = await runCommand(
    "uv",
    [
      "run",
      "--no-project",
      "--with",
      `coworld==${COWORLD_VERSION}`,
      "python",
      "-c",
      COWORLD_VALIDATOR,
    ],
    JSON.stringify(input),
  );
  let diagnostic: unknown;
  try {
    diagnostic = JSON.parse(result.stdout.trim());
  } catch {
    diagnostic = undefined;
  }
  if (
    result.code !== 0 ||
    !isPlainObject(diagnostic) ||
    diagnostic.ok !== true
  ) {
    const location =
      isPlainObject(diagnostic) && typeof diagnostic.location === "string"
        ? diagnostic.location
        : "";
    const message =
      isPlainObject(diagnostic) && typeof diagnostic.message === "string"
        ? diagnostic.message
        : "validator process failed";
    throw new Error(
      `Coworld ${COWORLD_VERSION} validation failed${location === "" ? "" : ` at ${location}`}: ${message}`,
    );
  }
}

async function runCommand(
  command: string,
  args: string[],
  stdin: string | undefined,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, COMMAND_TIMEOUT_MS);
    let stdout = "";
    let stderrBytes = 0;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) {
        child.kill();
        reject(new Error(`${command} produced excessive output`));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 1_000_000) {
        child.kill();
        reject(new Error(`${command} produced excessive diagnostics`));
      }
    });
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error(`Unable to start required local command ${command}`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 1, stdout });
    });
    child.stdin.on("error", () => {
      reject(new Error(`${command} closed its input unexpectedly`));
    });
    if (stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(stdin, "utf8");
    }
  });
}

async function publishPreparedMatrix(
  prepared: PreparedMatrix,
  input: {
    verifyImages: () => Promise<void>;
    beforeOutputReservation?: () => Promise<void>;
  },
): Promise<void> {
  const parent = path.dirname(prepared.outputRoot);
  await fs.mkdir(parent, { recursive: true });
  const stagingRoot = path.join(
    parent,
    `.${path.basename(prepared.outputRoot)}.staging-${process.pid}-${randomUUID()}`,
  );
  await fs.mkdir(stagingRoot, { recursive: false, mode: 0o700 });
  try {
    const stagingPayload = path.join(stagingRoot, "payload");
    await fs.mkdir(stagingPayload, { recursive: false });
    await writeJson(
      path.join(stagingPayload, "manifest.json"),
      prepared.manifest,
    );
    for (const [index, job] of prepared.plan.jobs.entries()) {
      const jobDirectory = path.join(stagingPayload, "jobs", job.jobID);
      await fs.mkdir(jobDirectory, { recursive: true });
      await writeJson(
        path.join(jobDirectory, "episode_request.json"),
        prepared.requests[index],
      );
    }
    await writeJson(path.join(stagingRoot, "plan.json"), prepared.plan);
    await input.verifyImages();
    await input.beforeOutputReservation?.();
    try {
      await fs.mkdir(prepared.outputRoot, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(
          `outputRoot appeared before publication; refusing to replace it: ${JSON.stringify(prepared.outputRoot)}`,
          { cause: error },
        );
      }
      throw error;
    }

    // The exclusive mkdir above is the no-replace reservation. The payload is
    // complete before it moves under that reservation, and plan.json is linked
    // last as the atomic publication marker. Consumers must ignore a directory
    // without plan.json.
    await fs.rename(stagingPayload, path.join(prepared.outputRoot, "payload"));
    await fs.link(
      path.join(stagingRoot, "plan.json"),
      path.join(prepared.outputRoot, "plan.json"),
    );
    // plan.json is the documented completion marker. Once its no-replace link
    // succeeds, publication succeeded; cleanup can never turn that success into
    // a caller-visible failure. A later run still refuses the completed output.
    await fs.unlink(path.join(stagingRoot, "plan.json")).catch(() => undefined);
    await fs
      .rm(stagingRoot, { recursive: true, force: true })
      .catch(() => undefined);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertOutputDoesNotOverlapSources(
  outputRoot: string,
  sourcePaths: string[],
): void {
  for (const sourcePath of sourcePaths.map((value) => path.resolve(value))) {
    if (
      isSameOrAncestor(outputRoot, sourcePath) ||
      isSameOrAncestor(sourcePath, outputRoot)
    ) {
      throw new Error(
        `outputRoot ${JSON.stringify(outputRoot)} must not overlap source path ${JSON.stringify(sourcePath)}`,
      );
    }
  }
}

function isSameOrAncestor(ancestor: string, candidate: string): boolean {
  const relative = path.relative(
    path.resolve(ancestor),
    path.resolve(candidate),
  );
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function assertPathAbsent(
  filePath: string,
  label: string,
): Promise<void> {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`${label} already exists: ${JSON.stringify(filePath)}`);
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

function rejectUnknownKeys(
  object: JsonObject,
  allowed: string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${label} contains unknown key ${JSON.stringify(key)}`);
    }
  }
}

function requirePlainObject(value: unknown, label: string): JsonObject {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be a plain object`);
  }
  return value;
}

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  return path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(directory, value);
}

function stableID(prefix: string, ...parts: unknown[]): string {
  const digest = hashCanonicalJson(parts).slice(0, 32);
  return `${prefix}-${digest}`;
}

function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function assertUnique(set: Set<string>, value: string, label: string): void {
  if (set.has(value)) {
    throw new Error(`Generated duplicate ${label} ${JSON.stringify(value)}`);
  }
  set.add(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseArguments(argv: string[]): ParsedArguments {
  let specPath: string | undefined;
  let outputRoot: string | undefined;
  let gameImage: string | undefined;
  let execute = false;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--spec") {
      assertArgumentNotRepeated(seen, argument);
      specPath = requireArgumentValue(argv, ++index, argument);
    } else if (argument === "--output") {
      assertArgumentNotRepeated(seen, argument);
      outputRoot = requireArgumentValue(argv, ++index, argument);
    } else if (argument === "--game-image") {
      assertArgumentNotRepeated(seen, argument);
      gameImage = requireArgumentValue(argv, ++index, argument);
    } else if (argument === "--execute") {
      assertArgumentNotRepeated(seen, argument);
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

function assertArgumentNotRepeated(seen: Set<string>, argument: string): void {
  if (seen.has(argument)) {
    throw new Error(`${argument} must not be repeated`);
  }
  seen.add(argument);
}

function requireArgumentValue(
  argv: string[],
  index: number,
  argument: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${argument} requires a value`);
  }
  return value;
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
    sourcePaths: [absoluteSpecPath],
  });
  process.stdout.write(
    `${JSON.stringify({ plan: plan.planPath, jobs: plan.jobs.length, matrixID: plan.matrixID })}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`coworld paired matrix: ${message}\n`);
    process.exitCode = 1;
  });
}
