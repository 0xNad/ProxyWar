import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_SEED = 308_915_775;
export const COWORLD_PAIRED_BOUNDS = Object.freeze({
  maxJobs: 1_000,
  maxRoster: 12,
  maxRunArguments: 128,
  maxIdentityString: 4_096,
  maxName: 256,
  maxEnvironmentEntries: 128,
  maxEnvironmentKey: 128,
  maxEnvironmentValue: 65_536,
  maxJsonBytes: 10_000_000,
  maxValidationPayloadBytes: 50_000_000,
});
const MAX_JOBS = COWORLD_PAIRED_BOUNDS.maxJobs;
const COMMAND_TIMEOUT_MS = 60_000;
const TREATMENT_ENV = "PROXYWAR_KEYSTONE_SINGLE_ACTION";
const SHADOW_ENV = "PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW";
const POLITICS_GUARD_ENV = "PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD";
const DIPLOMACY_ADJUDICATOR_ENV =
  "PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR";
const SURVIVAL_SHIELD_ENV = "PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD";
const COMMANDER_RETENTION_ENV = "PROXYWAR_KEYSTONE_COMMANDER_RETENTION";
const DEFENSE_AUTHORITY_ENV = "PROXYWAR_KEYSTONE_DEFENSE_AUTHORITY";
const BALANCE_OF_POWER_ENV = "PROXYWAR_KEYSTONE_COUNCIL_BALANCE_OF_POWER";
const EXPERT_MASK_ENV = "PROXYWAR_KEYSTONE_EXPERT_MASK";
const ARM_OWNED_ENV_KEYS = new Set([
  TREATMENT_ENV,
  SHADOW_ENV,
  POLITICS_GUARD_ENV,
  DIPLOMACY_ADJUDICATOR_ENV,
  SURVIVAL_SHIELD_ENV,
  COMMANDER_RETENTION_ENV,
  DEFENSE_AUTHORITY_ENV,
  BALANCE_OF_POWER_ENV,
  EXPERT_MASK_ENV,
]);
const COWORLD_VERSION = "0.1.32";
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
  /** Defaults to the legacy v16/A1 pair when omitted. */
  arms?: CoworldArmSpec[];
}

export type CoworldArmSpec =
  | { kind: "v16" }
  | { kind: "a1" }
  | { kind: "v16-shadow"; expertMask: number }
  | { kind: "a1-shadow"; expertMask: number }
  /** Broad all-break suppression experiment; never implied by v16 controls. */
  | { kind: "v16-politics-guard" }
  /** Transactional diplomacy experiment; never implied by v16 controls. */
  | { kind: "v16-diplomacy-adjudicator" }
  /** Verified-pressure survival experiment; never implied by v16 controls. */
  | { kind: "v16-survival-shield" }
  /** Exact promoted v39 severe-rescue behavior. */
  | { kind: "v39" }
  /** v39 plus healthy Commander directive retention after degraded refreshes. */
  | { kind: "v39-commander-retention" }
  /** v39 plus bounded defense authority over unsafe no-edge conquest. */
  | { kind: "v39-defense-authority" }
  /** Exact promoted v40 severe rescue plus Commander retention. */
  | { kind: "v40" }
  /** v40 plus isolated anti-runaway balance-of-power authority. */
  | { kind: "v40-balance-of-power" }
  | { kind: "council-authoritative" }
  | {
      kind: "expert-mask-authoritative";
      base: "v16" | "a1";
      expertMask: number;
    };

export interface CoworldResolvedArm {
  armID: string;
  kind:
    | "v16"
    | "a1"
    | "v16-shadow"
    | "a1-shadow"
    | "v16-politics-guard"
    | "v16-diplomacy-adjudicator"
    | "v16-survival-shield"
    | "v39"
    | "v39-commander-retention"
    | "v39-defense-authority"
    | "v40"
    | "v40-balance-of-power";
  base: "v16" | "a1";
  shadow: boolean;
  expertMask: number;
  env: Record<string, string>;
}

export interface CoworldResolvedImage {
  reference: string;
  imageID: string;
}

export interface CoworldMatrixRunnableIdentity {
  reference: string;
  run: string[];
  env: Record<string, string>;
  name: string | null;
  image: CoworldResolvedImage;
}

export interface CoworldMatrixIdentity {
  contract: "proxywar-coworld-paired-matrix-v3";
  manifestSha256: string;
  gameImage: CoworldResolvedImage;
  candidate: CoworldMatrixRunnableIdentity;
  opponents: CoworldMatrixRunnableIdentity[];
  variantIDs: string[];
  candidateSeats: number[];
  seeds: number[];
  arms: CoworldResolvedArm[];
}

export interface CoworldRosterSeatIdentity {
  seat: number;
  role: "candidate" | "opponent";
  name: string;
  image: CoworldResolvedImage;
  run: string[];
  env: Record<string, string>;
}

export interface CoworldPairedBlock {
  blockID: string;
  pairID: string;
  blockIndex: number;
  variantID: string;
  map: string;
  candidateSeat: number;
  seed: number;
  rosterOrderID: string;
  armOrder: string[];
  roster: CoworldRosterSeatIdentity[];
}

export interface CoworldPairedJob {
  jobID: string;
  matrixID: string;
  blockID: string;
  pairID: string;
  blockOrder: number;
  pairOrder: number;
  arm: CoworldResolvedArm;
  expertMask: number;
  variantID: string;
  map: string;
  candidateSeat: number;
  seed: number;
  rosterOrderID: string;
  roster: CoworldRosterSeatIdentity[];
  requestPath: string;
  outputDir: string;
  completionPath: string;
  candidateImage: CoworldResolvedImage;
  gameImage: CoworldResolvedImage;
  opponentImages: CoworldResolvedImage[];
}

export interface CoworldPairedPlan {
  schemaVersion: 3;
  coworldVersion: typeof COWORLD_VERSION;
  generatedAt: string;
  matrixID: string;
  matrixIdentity: CoworldMatrixIdentity;
  manifestSha256: string;
  manifestPath: string;
  planPath: string;
  materializedManifestPath: string;
  candidateImage: CoworldResolvedImage;
  gameImage: CoworldResolvedImage;
  opponentImages: CoworldResolvedImage[];
  arms: CoworldResolvedArm[];
  blocks: CoworldPairedBlock[];
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
    if version("coworld") != "${COWORLD_VERSION}":
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
    await readBoundedJson(manifestPath, "manifest"),
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

  const arms = resolveArmSpecs(input.spec.arms);
  validateCandidateArmEnvironmentCapacity(input.spec.candidate, arms);
  const preparedVariants = prepareVariants(manifest, input.spec);
  const blockCount =
    preparedVariants.length *
    input.spec.candidateSeats.length *
    input.spec.seeds.length;
  if (blockCount * arms.length > MAX_JOBS) {
    throw new Error(
      `Matrix would create ${blockCount * arms.length} jobs; maximum is ${MAX_JOBS}`,
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
    arms,
    now: input.now,
  });
  let validationPayloadBytes = assertBoundedJson(
    prepared.manifest,
    "materialized manifest",
  );
  assertBoundedJson(prepared.plan, "paired plan");
  prepared.requests.forEach((request, index) => {
    validationPayloadBytes += assertBoundedJson(
      request,
      `episode request ${index}`,
    );
    if (
      validationPayloadBytes > COWORLD_PAIRED_BOUNDS.maxValidationPayloadBytes
    ) {
      throw new Error("Coworld validation payload exceeds the paired limit");
    }
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

function resolveArmSpecs(
  authored: CoworldArmSpec[] | undefined,
): CoworldResolvedArm[] {
  const specs = authored ?? [{ kind: "v16" }, { kind: "a1" }];
  if (!Array.isArray(specs) || specs.length < 2) {
    throw new Error("arms must contain at least two allowlisted arm specs");
  }
  const resolved = specs.map((value, index) => {
    const object = requirePlainObject(value, `arms[${index}]`);
    const kind = requireNonemptyString(object.kind, `arms[${index}].kind`);
    if (
      kind === "council-authoritative" ||
      kind === "expert-mask-authoritative"
    ) {
      throw new Error(
        `arms[${index}] kind ${JSON.stringify(kind)} is reserved until a reviewed authoritative council runtime exists`,
      );
    }
    if (kind === "v16" || kind === "a1") {
      rejectUnknownKeys(object, ["kind"], `arms[${index}]`);
      const base = kind;
      return Object.freeze({
        armID: kind,
        kind,
        base,
        shadow: false,
        expertMask: 0,
        env: Object.freeze({
          [TREATMENT_ENV]: base === "a1" ? "1" : "0",
          [SHADOW_ENV]: "0",
        }),
      }) satisfies CoworldResolvedArm;
    }
    if (kind === "v16-shadow" || kind === "a1-shadow") {
      rejectUnknownKeys(object, ["kind", "expertMask"], `arms[${index}]`);
      const expertMask = requireIntegerInRange(
        object.expertMask,
        `arms[${index}].expertMask`,
        0,
        15,
      );
      const base = kind === "a1-shadow" ? "a1" : "v16";
      return Object.freeze({
        armID: `${kind}-m${expertMask}`,
        kind,
        base,
        shadow: true,
        expertMask,
        env: Object.freeze({
          [TREATMENT_ENV]: base === "a1" ? "1" : "0",
          [SHADOW_ENV]: "1",
          [EXPERT_MASK_ENV]: String(expertMask),
        }),
      }) satisfies CoworldResolvedArm;
    }
    if (kind === "v16-politics-guard") {
      rejectUnknownKeys(object, ["kind"], `arms[${index}]`);
      return Object.freeze({
        armID: kind,
        kind,
        base: "v16",
        shadow: false,
        expertMask: 15,
        env: Object.freeze({
          [TREATMENT_ENV]: "0",
          [SHADOW_ENV]: "0",
          [POLITICS_GUARD_ENV]: "1",
          [EXPERT_MASK_ENV]: "15",
        }),
      }) satisfies CoworldResolvedArm;
    }
    if (kind === "v16-diplomacy-adjudicator") {
      rejectUnknownKeys(object, ["kind"], `arms[${index}]`);
      return Object.freeze({
        armID: kind,
        kind,
        base: "v16",
        shadow: false,
        expertMask: 15,
        env: Object.freeze({
          [TREATMENT_ENV]: "0",
          [SHADOW_ENV]: "0",
          [DIPLOMACY_ADJUDICATOR_ENV]: "1",
          [EXPERT_MASK_ENV]: "15",
        }),
      }) satisfies CoworldResolvedArm;
    }
    if (kind === "v16-survival-shield") {
      rejectUnknownKeys(object, ["kind"], `arms[${index}]`);
      return Object.freeze({
        armID: kind,
        kind,
        base: "v16",
        shadow: false,
        expertMask: 15,
        env: Object.freeze({
          [TREATMENT_ENV]: "0",
          [SHADOW_ENV]: "0",
          [SURVIVAL_SHIELD_ENV]: "1",
          [EXPERT_MASK_ENV]: "15",
        }),
      }) satisfies CoworldResolvedArm;
    }
    if (
      kind === "v39" ||
      kind === "v39-commander-retention" ||
      kind === "v39-defense-authority"
    ) {
      rejectUnknownKeys(object, ["kind"], `arms[${index}]`);
      return Object.freeze({
        armID: kind,
        kind,
        base: "v16",
        shadow: false,
        expertMask: 15,
        env: Object.freeze({
          [TREATMENT_ENV]: "0",
          [SHADOW_ENV]: "0",
          [SURVIVAL_SHIELD_ENV]: "1",
          [COMMANDER_RETENTION_ENV]:
            kind === "v39-commander-retention" ? "1" : "0",
          [DEFENSE_AUTHORITY_ENV]: kind === "v39-defense-authority" ? "1" : "0",
          [EXPERT_MASK_ENV]: "15",
        }),
      }) satisfies CoworldResolvedArm;
    }
    if (kind === "v40" || kind === "v40-balance-of-power") {
      rejectUnknownKeys(object, ["kind"], `arms[${index}]`);
      return Object.freeze({
        armID: kind,
        kind,
        base: "v16",
        shadow: false,
        expertMask: 15,
        env: Object.freeze({
          [TREATMENT_ENV]: "0",
          [SHADOW_ENV]: "0",
          [SURVIVAL_SHIELD_ENV]: "1",
          [COMMANDER_RETENTION_ENV]: "1",
          [DEFENSE_AUTHORITY_ENV]: "0",
          [BALANCE_OF_POWER_ENV]: kind === "v40-balance-of-power" ? "1" : "0",
          [EXPERT_MASK_ENV]: "15",
        }),
      }) satisfies CoworldResolvedArm;
    }
    throw new Error(
      `arms[${index}].kind is not allowlisted: ${JSON.stringify(kind)}`,
    );
  });
  resolved.sort(compareArms);
  const armIDs = resolved.map((arm) => arm.armID);
  if (new Set(armIDs).size !== armIDs.length) {
    throw new Error("arms must resolve to unique arm identities");
  }
  return resolved;
}

function compareArms(a: CoworldResolvedArm, b: CoworldResolvedArm): number {
  const rank = (arm: CoworldResolvedArm): number => {
    switch (arm.kind) {
      case "v16":
        return 0;
      case "a1":
        return 1;
      case "v16-shadow":
        return 2;
      case "a1-shadow":
        return 3;
      case "v16-politics-guard":
        return 4;
      case "v16-diplomacy-adjudicator":
        return 5;
      case "v16-survival-shield":
        return 6;
      case "v39":
        return 7;
      case "v39-commander-retention":
        return 8;
      case "v39-defense-authority":
        return 9;
      case "v40":
        return 10;
      case "v40-balance-of-power":
        return 11;
    }
  };
  return (
    rank(a) - rank(b) ||
    a.expertMask - b.expertMask ||
    compareText(a.armID, b.armID)
  );
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
    if (seatCount < 2 || seatCount > COWORLD_PAIRED_BOUNDS.maxRoster) {
      throw new Error(
        `Variant ${variantID} must have 2..${COWORLD_PAIRED_BOUNDS.maxRoster} seats`,
      );
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
  arms: CoworldResolvedArm[];
  now?: Date;
}): PreparedMatrix {
  const manifestHex = hashCanonicalJson(input.manifest);
  const manifestSha256 = `sha256:${manifestHex}`;
  const matrixIdentity: CoworldMatrixIdentity = {
    contract: "proxywar-coworld-paired-matrix-v3",
    manifestSha256,
    gameImage: input.gameImage,
    candidate: matrixRunnableIdentity(
      input.spec.candidate,
      input.candidateImage,
    ),
    opponents: input.spec.opponents.map((opponent, index) => ({
      ...matrixRunnableIdentity(opponent, input.opponentImages[index]!),
    })),
    variantIDs: [...input.spec.variantIDs],
    candidateSeats: [...input.spec.candidateSeats],
    seeds: [...input.spec.seeds],
    arms: input.arms,
  };
  const matrixHex = hashCanonicalJson(matrixIdentity);
  const matrixID = `matrix-${matrixHex.slice(0, 32)}`;
  const blocks: CoworldPairedBlock[] = [];
  const jobs: CoworldPairedJob[] = [];
  const requests: JsonObject[] = [];
  const blockIDs = new Set<string>();
  const pairIDs = new Set<string>();
  const jobIDs = new Set<string>();
  const requestPaths = new Set<string>();
  const outputDirs = new Set<string>();
  let blockIndex = 0;

  for (const variant of input.variants) {
    for (const candidateSeat of input.spec.candidateSeats) {
      for (const seed of input.spec.seeds) {
        const blockRoster = rosterIdentity({
          candidate: input.spec.candidate,
          opponents: input.spec.opponents,
          candidateSeat,
          candidateImage: input.candidateImage,
          opponentImages: input.opponentImages,
        });
        const rosterOrderID = `roster-${coworldCanonicalSha256(blockRoster).slice(7, 39)}`;
        const blockID = stableID(
          "block",
          matrixID,
          variant.id,
          candidateSeat,
          seed,
          rosterOrderID,
        );
        const pairID = stableID(
          "pair",
          matrixID,
          variant.id,
          candidateSeat,
          seed,
          rosterOrderID,
        );
        assertUnique(blockIDs, blockID, "block id");
        assertUnique(pairIDs, pairID, "pair id");
        const armOrder = rotateArms(input.arms, blockIndex);
        blocks.push({
          blockID,
          pairID,
          blockIndex,
          variantID: variant.id,
          map: variant.map,
          candidateSeat,
          seed,
          rosterOrderID,
          armOrder: armOrder.map((arm) => arm.armID),
          roster: blockRoster,
        });
        for (const [blockOrder, arm] of armOrder.entries()) {
          const jobID = `${blockID}-${arm.armID}`;
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
          const completionPath = path.join(
            input.outputRoot,
            "payload",
            "jobs",
            jobID,
            "completion.json",
          );
          assertUnique(requestPaths, requestPath, "request path");
          assertUnique(outputDirs, outputDir, "episode output path");
          const roster = rosterIdentity({
            candidate: input.spec.candidate,
            opponents: input.spec.opponents,
            candidateSeat,
            candidateImage: input.candidateImage,
            opponentImages: input.opponentImages,
            arm,
          });
          const players = roster.map(runnableFromRoster);
          const names = roster.map(({ name }) => ({ name }));
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
              proxywar_block_id: blockID,
              proxywar_pair_id: pairID,
              proxywar_arm: arm.armID,
              proxywar_expert_mask: String(arm.expertMask),
            },
          });
          jobs.push({
            jobID,
            matrixID,
            blockID,
            pairID,
            blockOrder,
            pairOrder: blockOrder,
            arm,
            expertMask: arm.expertMask,
            variantID: variant.id,
            map: variant.map,
            candidateSeat,
            seed,
            rosterOrderID,
            roster,
            requestPath,
            outputDir,
            completionPath,
            candidateImage: input.candidateImage,
            gameImage: input.gameImage,
            opponentImages: input.opponentImages,
          });
        }
        blockIndex += 1;
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
    schemaVersion: 3,
    coworldVersion: COWORLD_VERSION,
    generatedAt,
    matrixID,
    matrixIdentity,
    manifestSha256,
    manifestPath: input.manifestPath,
    planPath: path.join(input.outputRoot, "plan.json"),
    materializedManifestPath,
    candidateImage: input.candidateImage,
    gameImage: input.gameImage,
    opponentImages: input.opponentImages,
    arms: input.arms,
    blocks,
    jobs,
  };
  return {
    manifest: input.manifest,
    requests,
    plan,
    outputRoot: input.outputRoot,
  };
}

function rosterIdentity(input: {
  candidate: PairedRunnableSpec;
  opponents: PairedRunnableSpec[];
  candidateSeat: number;
  candidateImage: CoworldResolvedImage;
  opponentImages: CoworldResolvedImage[];
  arm?: CoworldResolvedArm;
}): CoworldRosterSeatIdentity[] {
  const seatCount = input.opponents.length + 1;
  let opponentIndex = 0;
  return Array.from({ length: seatCount }, (_, seat) => {
    if (seat === input.candidateSeat) {
      return {
        seat,
        role: "candidate",
        name: input.candidate.name ?? `Candidate seat ${seat}`,
        image: input.candidateImage,
        run: [...(input.candidate.run ?? [])],
        env: {
          ...(input.candidate.env ?? {}),
          ...(input.arm?.env ?? {}),
        },
      };
    }
    const index = opponentIndex++;
    const opponent = input.opponents[index]!;
    return {
      seat,
      role: "opponent",
      name: opponent.name ?? `Opponent seat ${seat}`,
      image: input.opponentImages[index]!,
      run: [...(opponent.run ?? [])],
      env: { ...(opponent.env ?? {}) },
    };
  });
}

function runnableFromRoster(seat: CoworldRosterSeatIdentity): JsonObject {
  return {
    type: "player",
    image: seat.image.reference,
    ...(seat.run.length === 0 ? {} : { run: [...seat.run] }),
    env: { ...seat.env },
  };
}

function rotateArms(
  arms: CoworldResolvedArm[],
  blockIndex: number,
): CoworldResolvedArm[] {
  const offset = blockIndex % arms.length;
  return [...arms.slice(offset), ...arms.slice(0, offset)];
}

function matrixRunnableIdentity(
  spec: PairedRunnableSpec,
  image: CoworldResolvedImage,
): CoworldMatrixRunnableIdentity {
  return {
    reference: spec.image,
    run: spec.run ?? [],
    env: spec.env ?? {},
    name: spec.name ?? null,
    image,
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
      "arms",
    ],
    "matrix spec",
  );
  requireNonemptyString(spec.manifestPath, "manifestPath");
  requireNonemptyString(spec.outputRoot, "outputRoot");
  validateRunnable(spec.candidate, "candidate");
  if (
    !Array.isArray(spec.opponents) ||
    spec.opponents.length === 0 ||
    spec.opponents.length >= COWORLD_PAIRED_BOUNDS.maxRoster
  ) {
    throw new Error(
      `opponents must contain 1..${COWORLD_PAIRED_BOUNDS.maxRoster - 1} runnables`,
    );
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
    if (spec.name.length > COWORLD_PAIRED_BOUNDS.maxName) {
      throw new Error(`${label}.name exceeds the paired name limit`);
    }
  }
  if (spec.run !== undefined) {
    if (
      !Array.isArray(spec.run) ||
      spec.run.length === 0 ||
      spec.run.length > COWORLD_PAIRED_BOUNDS.maxRunArguments
    ) {
      throw new Error(
        `${label}.run must be a bounded nonempty argv array when supplied`,
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
  // Preserve the historical six-entry candidate reservation for existing arm
  // families. New arms with a larger exact identity are checked after arm
  // resolution by validateCandidateArmEnvironmentCapacity().
  const reservedArmEntries = label === "candidate" ? 6 : 0;
  if (
    Object.keys(env).length >
    COWORLD_PAIRED_BOUNDS.maxEnvironmentEntries - reservedArmEntries
  ) {
    throw new Error(`${label}.env exceeds the paired entry limit`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (
      !ENV_KEY_PATTERN.test(key) ||
      key.length > COWORLD_PAIRED_BOUNDS.maxEnvironmentKey
    ) {
      throw new Error(`${label}.env key ${JSON.stringify(key)} is invalid`);
    }
    if (ARM_OWNED_ENV_KEYS.has(key)) {
      throw new Error(
        `${label}.env must not set arm-owned key ${key}; the matrix derives all arm environment fields`,
      );
    }
    if (isReservedOrSecretEnvKey(key)) {
      throw new Error(
        `${label}.env key ${JSON.stringify(key)} is reserved or secret-looking; only public configuration is allowed`,
      );
    }
    if (
      typeof value !== "string" ||
      value.length > COWORLD_PAIRED_BOUNDS.maxEnvironmentValue
    ) {
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

function validateCandidateArmEnvironmentCapacity(
  candidate: PairedRunnableSpec,
  arms: readonly CoworldResolvedArm[],
): void {
  const authoredEntryCount = Object.keys(candidate.env ?? {}).length;
  const largestResolvedArm = Math.max(
    0,
    ...arms.map((arm) => Object.keys(arm.env).length),
  );
  if (
    authoredEntryCount + largestResolvedArm >
    COWORLD_PAIRED_BOUNDS.maxEnvironmentEntries
  ) {
    throw new Error(
      "candidate.env plus the selected arm identity exceeds the paired entry limit",
    );
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
  await fs.writeFile(
    filePath,
    `${serializeBoundedJson(value, filePath)}\n`,
    "utf8",
  );
}

async function readBoundedJson(
  filePath: string,
  label: string,
): Promise<unknown> {
  const stat = await fs.lstat(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > COWORLD_PAIRED_BOUNDS.maxJsonBytes
  ) {
    throw new Error(`${label} must be a bounded regular JSON file`);
  }
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function assertBoundedJson(value: unknown, label: string): number {
  return Buffer.byteLength(serializeBoundedJson(value, label), "utf8") + 1;
}

function serializeBoundedJson(value: unknown, label: string): string {
  const serialized = JSON.stringify(value, null, 2);
  if (
    typeof serialized !== "string" ||
    Buffer.byteLength(serialized, "utf8") + 1 >
      COWORLD_PAIRED_BOUNDS.maxJsonBytes
  ) {
    throw new Error(`${label} exceeds the paired JSON size limit`);
  }
  return serialized;
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
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > COWORLD_PAIRED_BOUNDS.maxIdentityString ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be a bounded nonempty string`);
  }
  return value;
}

function requireIntegerInRange(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw new Error(`${label} must be an integer in ${min}..${max}`);
  }
  return value as number;
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

export function coworldCanonicalSha256(value: unknown): string {
  return `sha256:${hashCanonicalJson(value)}`;
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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
  return requireNonemptyString(value, argument);
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.execute) {
    throw new Error(
      "--execute is intentionally unavailable in the dry-run planner; inspect plan.json first",
    );
  }
  const absoluteSpecPath = path.resolve(args.specPath);
  const spec = (await readBoundedJson(
    absoluteSpecPath,
    "matrix spec",
  )) as CoworldPairedMatrixSpec;
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
