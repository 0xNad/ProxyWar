import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COWORLD_PAIRED_BOUNDS,
  coworldCanonicalSha256,
  resolveLocalDockerImageID,
  type CoworldImageResolver,
  type CoworldMatrixIdentity,
  type CoworldMatrixRunnableIdentity,
  type CoworldPairedBlock,
  type CoworldPairedJob,
  type CoworldPairedPlan,
  type CoworldResolvedArm,
  type CoworldResolvedImage,
  type CoworldRosterSeatIdentity,
} from "./coworld-paired-matrix";

const COWORLD_VERSION = "0.1.30";
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ARTIFACT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MATRIX_ID_PATTERN = /^matrix-[0-9a-f]{32}$/;
const BLOCK_ID_PATTERN = /^block-[0-9a-f]{32}$/;
const PAIR_ID_PATTERN = /^pair-[0-9a-f]{32}$/;
const ROSTER_ID_PATTERN = /^roster-[0-9a-f]{32}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_ENV_TOKEN_PATTERN =
  /^(?:ACCESS|AUTH|AUTHORIZATION|BEARER|CREDENTIALS?|KEY|OAUTH|PASS|PASSWD|PASSWORD|PAT|PRIVATE|SECRET|SESSION|TOKEN)$/;
const SECRET_ENV_COMPACT_PATTERN =
  /(?:ACCESSKEY|APIKEY|AUTHORIZATION|BEARER|CLIENTSECRET|CREDENTIAL|PASSWORD|PASSWD|PRIVATEKEY|SECRET|TOKEN|PAT$)/;
const ARM_OWNED_ENV_KEYS = new Set([
  "PROXYWAR_KEYSTONE_SINGLE_ACTION",
  "PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW",
  "PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD",
  "PROXYWAR_KEYSTONE_EXPERT_MASK",
]);
const MAX_ARMS = 35;
const EPISODE_TIMEOUT_SECONDS = 3_600;
const EPISODE_PROCESS_TIMEOUT_MS = 3_700_000;
const VALIDATOR_PROCESS_TIMEOUT_MS = 60_000;

type JsonObject = Record<string, unknown>;

export interface CoworldExecutionValidationProvenance {
  coworldVersion: typeof COWORLD_VERSION;
  episodeRunner: "pinned-coworld-cli" | "injected";
  resultsValidator: "pinned-coworld-results-schema" | "injected";
  replayValidator: "pinned-coworld-verify-replay" | "injected-unverified";
}

export interface CoworldJobCompletion {
  schemaVersion: 1;
  status: "complete";
  matrixID: string;
  blockID: string;
  pairID: string;
  jobID: string;
  rosterOrderID: string;
  arm: CoworldResolvedArm;
  expertMask: number;
  variantID: string;
  seed: number;
  map: string;
  candidateSeat: number;
  roster: CoworldRosterSeatIdentity[];
  candidateImage: CoworldResolvedImage;
  gameImage: CoworldResolvedImage;
  opponentImages: CoworldResolvedImage[];
  resultsPath: string;
  replayPath: string;
  resultsSha256: string;
  replaySha256: string;
  validation: CoworldExecutionValidationProvenance;
}

export interface CoworldPairedExecutionSummary {
  matrixID: string;
  totalJobs: number;
  executedJobs: number;
  resumedJobs: number;
}

export type CoworldEpisodeRunner = (input: {
  plan: CoworldPairedPlan;
  job: CoworldPairedJob;
}) => Promise<void>;

export type CoworldResultsValidator = (input: {
  manifest: JsonObject;
  results: JsonObject;
  job: CoworldPairedJob;
}) => Promise<void>;

export async function executeCoworldPairedPlan(input: {
  planPath: string;
  resolveImageID?: CoworldImageResolver;
  runEpisode?: CoworldEpisodeRunner;
  validateResults?: CoworldResultsValidator;
}): Promise<CoworldPairedExecutionSummary> {
  const planPath = path.resolve(input.planPath);
  const plan = await readJson<CoworldPairedPlan>(planPath, "plan");
  validatePlan(plan, planPath);
  await validatePlanFilesystem(plan);
  const manifest = await readJson<JsonObject>(
    plan.materializedManifestPath,
    "materialized manifest",
  );
  validateMaterializedManifest(plan, manifest);

  for (const job of plan.jobs) {
    const request = await readJson<JsonObject>(
      job.requestPath,
      "episode request",
    );
    validateRequest(plan, job, manifest, request);
  }

  const resolveImageID = input.resolveImageID ?? resolveLocalDockerImageID;
  await assertPlanImagesUnchanged(plan, resolveImageID);
  const validateResults =
    input.validateResults ?? validateCoworldResultsWithPinnedToolchain;
  const validation: CoworldExecutionValidationProvenance = {
    coworldVersion: COWORLD_VERSION,
    episodeRunner:
      input.runEpisode === undefined ? "pinned-coworld-cli" : "injected",
    resultsValidator:
      input.validateResults === undefined
        ? "pinned-coworld-results-schema"
        : "injected",
    replayValidator:
      input.runEpisode === undefined
        ? "pinned-coworld-verify-replay"
        : "injected-unverified",
  };
  const completedJobs = new Set<string>();

  // Preflight every output before launching the first job. A stale later job
  // must not be discovered after earlier arms have already consumed resources.
  for (const job of plan.jobs) {
    const outputExists = await pathExists(job.outputDir);
    const completionExists = await pathExists(job.completionPath);
    if (!outputExists && !completionExists) {
      continue;
    }
    if (!outputExists || !completionExists) {
      throw new Error(
        `Job ${job.jobID} has an incomplete or preexisting output; refusing to overwrite or infer provenance`,
      );
    }
    await validateOutputDirectory(plan, job);
    await validateCompletedJob(
      plan,
      job,
      manifest,
      validateResults,
      validation,
    );
    completedJobs.add(job.jobID);
  }

  const runEpisode = input.runEpisode ?? runCoworldEpisode;
  let executedJobs = 0;
  let resumedJobs = 0;
  for (const job of plan.jobs) {
    if (completedJobs.has(job.jobID)) {
      resumedJobs += 1;
      continue;
    }
    await assertPlanImagesUnchanged(plan, resolveImageID);
    await validateJobRoot(plan, job);
    await validateExecutionInputs(plan, job);
    await assertPathAbsent(job.outputDir, `job ${job.jobID} output`);
    await assertPathAbsent(job.completionPath, `job ${job.jobID} completion`);
    await runEpisode({ plan, job });
    await assertPlanImagesUnchanged(plan, resolveImageID);
    await validateOutputDirectory(plan, job);
    await validateExecutionInputs(plan, job);
    const completion = await buildCompletion(
      plan,
      job,
      manifest,
      validateResults,
      validation,
    );
    await validateExecutionInputs(plan, job);
    await fs.writeFile(
      job.completionPath,
      `${JSON.stringify(completion, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    executedJobs += 1;
  }
  return {
    matrixID: plan.matrixID,
    totalJobs: plan.jobs.length,
    executedJobs,
    resumedJobs,
  };
}

function validatePlan(plan: CoworldPairedPlan, planPath: string): void {
  assertExactObjectKeys(
    plan,
    [
      "schemaVersion",
      "coworldVersion",
      "generatedAt",
      "matrixID",
      "matrixIdentity",
      "manifestSha256",
      "manifestPath",
      "planPath",
      "materializedManifestPath",
      "candidateImage",
      "gameImage",
      "opponentImages",
      "arms",
      "blocks",
      "jobs",
    ],
    "plan",
  );
  if (plan.schemaVersion !== 3 || plan.coworldVersion !== COWORLD_VERSION) {
    throw new Error("Executor requires a schemaVersion 3 Coworld 0.1.30 plan");
  }
  if (
    !MATRIX_ID_PATTERN.test(plan.matrixID) ||
    !ARTIFACT_HASH_PATTERN.test(plan.manifestSha256)
  ) {
    throw new Error("Plan matrix or manifest identity is malformed");
  }
  validateCanonicalTimestamp(plan.generatedAt, "plan.generatedAt");
  validateAbsolutePath(plan.manifestPath, "manifestPath");
  validateAbsolutePath(plan.planPath, "planPath");
  validateAbsolutePath(
    plan.materializedManifestPath,
    "materializedManifestPath",
  );
  if (path.resolve(plan.planPath) !== planPath) {
    throw new Error("Plan path identity does not match the requested plan");
  }
  const root = path.dirname(planPath);
  assertExactPath(
    plan.materializedManifestPath,
    path.join(root, "payload", "manifest.json"),
    "materialized manifest",
  );
  validateImage(plan.candidateImage, "plan.candidateImage");
  validateImage(plan.gameImage, "plan.gameImage");
  if (
    !Array.isArray(plan.opponentImages) ||
    plan.opponentImages.length === 0 ||
    plan.opponentImages.length >= COWORLD_PAIRED_BOUNDS.maxRoster
  ) {
    throw new Error("Plan opponentImages cardinality is invalid");
  }
  plan.opponentImages.forEach((image, index) =>
    validateImage(image, `plan.opponentImages[${index}]`),
  );
  if (
    !Array.isArray(plan.arms) ||
    plan.arms.length < 2 ||
    plan.arms.length > MAX_ARMS
  ) {
    throw new Error("Plan must contain 2..35 resolved arms");
  }
  const armByID = new Map<string, CoworldResolvedArm>();
  for (const arm of plan.arms) {
    validateResolvedArm(arm);
    if (armByID.has(arm.armID)) {
      throw new Error(`Plan repeats arm ${arm.armID}`);
    }
    armByID.set(arm.armID, arm);
  }
  if (
    coworldCanonicalSha256(plan.arms) !==
    coworldCanonicalSha256([...plan.arms].sort(compareResolvedArms))
  ) {
    throw new Error("Plan arms are not in canonical deterministic order");
  }
  validateMatrixIdentity(plan);
  if (
    !Array.isArray(plan.blocks) ||
    plan.blocks.length === 0 ||
    plan.blocks.length * plan.arms.length > COWORLD_PAIRED_BOUNDS.maxJobs
  ) {
    throw new Error("Plan block/job cardinality is invalid");
  }
  const blockByID = new Map<string, CoworldPairedBlock>();
  for (const [blockIndex, block] of plan.blocks.entries()) {
    assertExactObjectKeys(
      block,
      [
        "blockID",
        "pairID",
        "blockIndex",
        "variantID",
        "map",
        "candidateSeat",
        "seed",
        "rosterOrderID",
        "armOrder",
        "roster",
      ],
      `blocks[${blockIndex}]`,
    );
    if (
      block.blockIndex !== blockIndex ||
      !BLOCK_ID_PATTERN.test(block.blockID) ||
      !PAIR_ID_PATTERN.test(block.pairID) ||
      !ROSTER_ID_PATTERN.test(block.rosterOrderID)
    ) {
      throw new Error(`Block at index ${blockIndex} has malformed identity`);
    }
    validateBoundedString(block.variantID, `blocks[${blockIndex}].variantID`);
    validateBoundedString(block.map, `blocks[${blockIndex}].map`);
    validateInteger(
      block.candidateSeat,
      0,
      COWORLD_PAIRED_BOUNDS.maxRoster - 1,
      `blocks[${blockIndex}].candidateSeat`,
    );
    validateInteger(block.seed, 0, 308_915_775, `blocks[${blockIndex}].seed`);
    if (blockByID.has(block.blockID)) {
      throw new Error(`Plan repeats block ${block.blockID}`);
    }
    const expectedArmOrder = rotateArmIDs(
      plan.arms.map((arm) => arm.armID),
      blockIndex,
    );
    if (
      !Array.isArray(block.armOrder) ||
      coworldCanonicalSha256(block.armOrder) !==
        coworldCanonicalSha256(expectedArmOrder)
    ) {
      throw new Error(`Block ${block.blockID} has an invalid arm order`);
    }
    validateRoster(block.roster, block.candidateSeat, "block roster");
    if (stableRosterOrderID(block.roster) !== block.rosterOrderID) {
      throw new Error(`Block ${block.blockID} rosterOrderID is invalid`);
    }
    const identityParts = [
      plan.matrixID,
      block.variantID,
      block.candidateSeat,
      block.seed,
      block.rosterOrderID,
    ] as const;
    if (
      block.blockID !== stableExecutionID("block", ...identityParts) ||
      block.pairID !== stableExecutionID("pair", ...identityParts)
    ) {
      throw new Error(`Block ${block.blockID} stable identity is invalid`);
    }
    validateBlockRoster(plan, block);
    blockByID.set(block.blockID, block);
  }
  validateMatrixAxesAndRosters(plan);
  if (
    !Array.isArray(plan.jobs) ||
    plan.jobs.length !== plan.blocks.length * plan.arms.length
  ) {
    throw new Error("Plan does not contain one job per block arm");
  }
  for (const [jobIndex, job] of plan.jobs.entries()) {
    assertExactObjectKeys(
      job,
      [
        "jobID",
        "matrixID",
        "blockID",
        "pairID",
        "blockOrder",
        "pairOrder",
        "arm",
        "expertMask",
        "variantID",
        "map",
        "candidateSeat",
        "seed",
        "rosterOrderID",
        "roster",
        "requestPath",
        "outputDir",
        "completionPath",
        "candidateImage",
        "gameImage",
        "opponentImages",
      ],
      `jobs[${jobIndex}]`,
    );
    const blockIndex = Math.floor(jobIndex / plan.arms.length);
    const blockOrder = jobIndex % plan.arms.length;
    const block = plan.blocks[blockIndex]!;
    const armID = block.armOrder[blockOrder]!;
    validateResolvedArm(job.arm);
    if (
      job.blockID !== block.blockID ||
      job.blockOrder !== blockOrder ||
      job.pairOrder !== blockOrder ||
      job.arm.armID !== armID ||
      job.jobID !== `${block.blockID}-${armID}`
    ) {
      throw new Error(
        `Job at index ${jobIndex} does not match the flattened block order`,
      );
    }
    validateInteger(job.expertMask, 0, 15, `jobs[${jobIndex}].expertMask`);
    validateAbsolutePath(job.requestPath, `jobs[${jobIndex}].requestPath`);
    validateAbsolutePath(job.outputDir, `jobs[${jobIndex}].outputDir`);
    validateAbsolutePath(
      job.completionPath,
      `jobs[${jobIndex}].completionPath`,
    );
  }
  const jobIDs = new Set<string>();
  const orderKeys = new Set<string>();
  for (const job of plan.jobs) {
    if (jobIDs.has(job.jobID)) {
      throw new Error(`Plan repeats job ${job.jobID}`);
    }
    jobIDs.add(job.jobID);
    if (job.matrixID !== plan.matrixID) {
      throw new Error(`Job ${job.jobID} matrix identity differs from plan`);
    }
    const block = blockByID.get(job.blockID);
    if (
      block === undefined ||
      job.pairID !== block.pairID ||
      job.variantID !== block.variantID ||
      job.map !== block.map ||
      job.seed !== block.seed ||
      job.candidateSeat !== block.candidateSeat ||
      job.rosterOrderID !== block.rosterOrderID ||
      job.pairOrder !== job.blockOrder ||
      block.armOrder[job.blockOrder] !== job.arm.armID
    ) {
      throw new Error(`Job ${job.jobID} does not match its block identity`);
    }
    const plannedArm = armByID.get(job.arm.armID);
    if (
      plannedArm === undefined ||
      coworldCanonicalSha256(job.arm) !== coworldCanonicalSha256(plannedArm) ||
      job.expertMask !== job.arm.expertMask
    ) {
      throw new Error(`Job ${job.jobID} has an invalid arm identity`);
    }
    if (
      coworldCanonicalSha256(job.candidateImage) !==
        coworldCanonicalSha256(plan.candidateImage) ||
      coworldCanonicalSha256(job.gameImage) !==
        coworldCanonicalSha256(plan.gameImage) ||
      coworldCanonicalSha256(job.opponentImages) !==
        coworldCanonicalSha256(plan.opponentImages)
    ) {
      throw new Error(`Job ${job.jobID} image identities differ from plan`);
    }
    const orderKey = `${job.blockID}:${job.blockOrder}`;
    if (orderKeys.has(orderKey)) {
      throw new Error(`Plan repeats block order ${orderKey}`);
    }
    orderKeys.add(orderKey);
    validateRoster(job.roster, job.candidateSeat, "job roster", job.arm);
    validateJobRoster(block, job);
    const jobRoot = path.join(root, "payload", "jobs", job.jobID);
    assertExactPath(
      job.requestPath,
      path.join(jobRoot, "episode_request.json"),
      "request",
    );
    assertExactPath(job.outputDir, path.join(jobRoot, "episode"), "output");
    assertExactPath(
      job.completionPath,
      path.join(jobRoot, "completion.json"),
      "completion",
    );
  }
  for (const block of plan.blocks) {
    const jobs = plan.jobs.filter((job) => job.blockID === block.blockID);
    if (jobs.length !== plan.arms.length) {
      throw new Error(
        `Block ${block.blockID} does not contain every arm exactly once`,
      );
    }
  }
}

function validateMatrixIdentity(plan: CoworldPairedPlan): void {
  const identity = plan.matrixIdentity;
  assertExactObjectKeys(
    identity,
    [
      "contract",
      "manifestSha256",
      "gameImage",
      "candidate",
      "opponents",
      "variantIDs",
      "candidateSeats",
      "seeds",
      "arms",
    ],
    "matrixIdentity",
  );
  if (
    identity.contract !== "proxywar-coworld-paired-matrix-v3" ||
    identity.manifestSha256 !== plan.manifestSha256 ||
    coworldCanonicalSha256(identity.gameImage) !==
      coworldCanonicalSha256(plan.gameImage) ||
    coworldCanonicalSha256(identity.arms) !==
      coworldCanonicalSha256(plan.arms) ||
    plan.matrixID !== `matrix-${coworldCanonicalSha256(identity).slice(7, 39)}`
  ) {
    throw new Error("Plan matrixID does not match its canonical identity");
  }
  validateMatrixRunnable(identity.candidate, "matrixIdentity.candidate");
  if (
    coworldCanonicalSha256(identity.candidate.image) !==
    coworldCanonicalSha256(plan.candidateImage)
  ) {
    throw new Error("Matrix candidate image differs from plan identity");
  }
  if (
    !Array.isArray(identity.opponents) ||
    identity.opponents.length !== plan.opponentImages.length
  ) {
    throw new Error("Matrix opponent identity cardinality differs from plan");
  }
  identity.opponents.forEach((opponent, index) => {
    validateMatrixRunnable(opponent, `matrixIdentity.opponents[${index}]`);
    if (
      coworldCanonicalSha256(opponent.image) !==
      coworldCanonicalSha256(plan.opponentImages[index])
    ) {
      throw new Error(`Matrix opponent ${index} image differs from plan`);
    }
  });
  validateUniqueStrings(identity.variantIDs, "matrixIdentity.variantIDs");
  validateUniqueIntegers(
    identity.candidateSeats,
    0,
    plan.opponentImages.length,
    "matrixIdentity.candidateSeats",
  );
  validateUniqueIntegers(
    identity.seeds,
    0,
    308_915_775,
    "matrixIdentity.seeds",
  );
}

function validateMatrixRunnable(
  runnable: CoworldMatrixRunnableIdentity,
  label: string,
): void {
  assertExactObjectKeys(
    runnable,
    ["reference", "run", "env", "name", "image"],
    label,
  );
  validateBoundedString(runnable.reference, `${label}.reference`);
  validateImage(runnable.image, `${label}.image`);
  if (runnable.reference !== runnable.image.reference) {
    throw new Error(`${label} reference differs from its resolved image`);
  }
  if (
    !Array.isArray(runnable.run) ||
    runnable.run.length > COWORLD_PAIRED_BOUNDS.maxRunArguments
  ) {
    throw new Error(`${label}.run exceeds the paired argument limit`);
  }
  runnable.run.forEach((argument, index) =>
    validateBoundedString(argument, `${label}.run[${index}]`),
  );
  validateEnvironment(runnable.env, `${label}.env`, {});
  if (runnable.name !== null) {
    validateBoundedString(
      runnable.name,
      `${label}.name`,
      COWORLD_PAIRED_BOUNDS.maxName,
    );
  }
}

function validateMatrixAxesAndRosters(plan: CoworldPairedPlan): void {
  const identity = plan.matrixIdentity;
  const combinationCount =
    identity.variantIDs.length *
    identity.candidateSeats.length *
    identity.seeds.length;
  if (
    !Number.isSafeInteger(combinationCount) ||
    combinationCount !== plan.blocks.length ||
    combinationCount * plan.arms.length > COWORLD_PAIRED_BOUNDS.maxJobs
  ) {
    throw new Error("Matrix axes do not match the planned block count");
  }
  let index = 0;
  for (const variantID of identity.variantIDs) {
    for (const candidateSeat of identity.candidateSeats) {
      for (const seed of identity.seeds) {
        const block = plan.blocks[index++]!;
        if (
          block.variantID !== variantID ||
          block.candidateSeat !== candidateSeat ||
          block.seed !== seed
        ) {
          throw new Error(
            `Block ${block.blockID} differs from matrix axis order`,
          );
        }
        const expectedRoster = rosterFromMatrixIdentity(
          identity,
          candidateSeat,
        );
        if (
          coworldCanonicalSha256(block.roster) !==
          coworldCanonicalSha256(expectedRoster)
        ) {
          throw new Error(`Block ${block.blockID} differs from matrix roster`);
        }
      }
    }
  }
}

function rosterFromMatrixIdentity(
  identity: CoworldMatrixIdentity,
  candidateSeat: number,
): CoworldRosterSeatIdentity[] {
  let opponentIndex = 0;
  return Array.from({ length: identity.opponents.length + 1 }, (_, seat) => {
    if (seat === candidateSeat) {
      return {
        seat,
        role: "candidate",
        name: identity.candidate.name ?? `Candidate seat ${seat}`,
        image: identity.candidate.image,
        run: identity.candidate.run,
        env: identity.candidate.env,
      };
    }
    const opponent = identity.opponents[opponentIndex++]!;
    return {
      seat,
      role: "opponent",
      name: opponent.name ?? `Opponent seat ${seat}`,
      image: opponent.image,
      run: opponent.run,
      env: opponent.env,
    };
  });
}

async function validatePlanFilesystem(plan: CoworldPairedPlan): Promise<void> {
  const root = path.dirname(plan.planPath);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Plan root must be a real directory");
  }
  const realRoot = await fs.realpath(root);
  await validateRealDirectory(
    path.join(root, "payload"),
    path.join(realRoot, "payload"),
    "plan payload",
  );
  await validateRealDirectory(
    path.join(root, "payload", "jobs"),
    path.join(realRoot, "payload", "jobs"),
    "plan jobs",
  );
  const tmpDirectory = path.join(root, "tmp");
  if (await pathExists(tmpDirectory)) {
    await validateRealDirectory(
      tmpDirectory,
      path.join(realRoot, "tmp"),
      "plan temporary directory",
    );
  }
  for (const job of plan.jobs) {
    await validateJobRoot(plan, job, realRoot);
  }
}

async function validateJobRoot(
  plan: CoworldPairedPlan,
  job: CoworldPairedJob,
  knownRealRoot?: string,
): Promise<void> {
  const root = path.dirname(plan.planPath);
  const realRoot = knownRealRoot ?? (await fs.realpath(root));
  await validateRealDirectory(
    path.dirname(job.requestPath),
    path.join(realRoot, "payload", "jobs", job.jobID),
    `job ${job.jobID} root`,
  );
}

async function validateOutputDirectory(
  plan: CoworldPairedPlan,
  job: CoworldPairedJob,
): Promise<void> {
  const realRoot = await fs.realpath(path.dirname(plan.planPath));
  await validateRealDirectory(
    job.outputDir,
    path.join(realRoot, "payload", "jobs", job.jobID, "episode"),
    `job ${job.jobID} output`,
  );
}

async function validateRealDirectory(
  directory: string,
  expectedRealPath: string,
  label: string,
): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  const real = await fs.realpath(directory);
  if (path.resolve(real) !== path.resolve(expectedRealPath)) {
    throw new Error(`${label} escapes the materialized plan root`);
  }
}

function validateResolvedArm(arm: CoworldResolvedArm): void {
  assertExactObjectKeys(
    arm,
    ["armID", "kind", "base", "shadow", "expertMask", "env"],
    "resolved arm",
  );
  if (
    arm.kind !== "v16" &&
    arm.kind !== "a1" &&
    arm.kind !== "v16-shadow" &&
    arm.kind !== "a1-shadow" &&
    arm.kind !== "v16-politics-guard"
  ) {
    throw new Error(`Unsupported resolved arm ${String(arm.kind)}`);
  }
  validateBoundedString(arm.armID, "resolved arm.armID");
  const expected = expectedArm(arm.kind, arm.expertMask);
  if (coworldCanonicalSha256(arm) !== coworldCanonicalSha256(expected)) {
    throw new Error(
      `Resolved arm ${arm.armID} has unexpected fields or environment`,
    );
  }
}

function expectedArm(
  kind: CoworldResolvedArm["kind"],
  expertMask: number,
): CoworldResolvedArm {
  const shadow = kind === "v16-shadow" || kind === "a1-shadow";
  const politicsGuard = kind === "v16-politics-guard";
  const base = kind === "a1" || kind === "a1-shadow" ? "a1" : "v16";
  if (!Number.isInteger(expertMask) || expertMask < 0 || expertMask > 15) {
    throw new Error("Expert mask must be an integer in 0..15");
  }
  if (politicsGuard && expertMask !== 15) {
    throw new Error("Politics-guard arm must use the reviewed expert mask 15");
  }
  if (!shadow && !politicsGuard && expertMask !== 0) {
    throw new Error("Non-shadow arms must have expertMask 0");
  }
  return {
    armID: shadow ? `${kind}-m${expertMask}` : kind,
    kind,
    base,
    shadow,
    expertMask,
    env: {
      PROXYWAR_KEYSTONE_SINGLE_ACTION: base === "a1" ? "1" : "0",
      PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: shadow ? "1" : "0",
      ...(politicsGuard
        ? { PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD: "1" }
        : {}),
      ...(shadow || politicsGuard
        ? { PROXYWAR_KEYSTONE_EXPERT_MASK: String(expertMask) }
        : {}),
    },
  };
}

function validateRoster(
  roster: CoworldRosterSeatIdentity[],
  candidateSeat: number,
  label: string,
  arm?: CoworldResolvedArm,
): void {
  if (
    !Array.isArray(roster) ||
    roster.length < 2 ||
    roster.length > COWORLD_PAIRED_BOUNDS.maxRoster
  ) {
    throw new Error(
      `${label} must contain 2..${COWORLD_PAIRED_BOUNDS.maxRoster} seats`,
    );
  }
  validateInteger(
    candidateSeat,
    0,
    roster.length - 1,
    `${label} candidateSeat`,
  );
  for (const [index, seat] of roster.entries()) {
    assertExactObjectKeys(
      seat,
      ["seat", "role", "name", "image", "run", "env"],
      `${label}[${index}]`,
    );
    if (seat.seat !== index) {
      throw new Error(`${label} is not in exact seat order`);
    }
    if (
      (seat.role !== "candidate" && seat.role !== "opponent") ||
      (index === candidateSeat) !== (seat.role === "candidate")
    ) {
      throw new Error(`${label} candidate role does not match candidateSeat`);
    }
    validateBoundedString(seat.name, `${label}[${index}].name`, 256);
    validateImage(seat.image, `${label}[${index}].image`);
    if (
      !Array.isArray(seat.run) ||
      seat.run.length > COWORLD_PAIRED_BOUNDS.maxRunArguments
    ) {
      throw new Error(`${label}[${index}] runnable identity is malformed`);
    }
    seat.run.forEach((argument, argumentIndex) =>
      validateBoundedString(
        argument,
        `${label}[${index}].run[${argumentIndex}]`,
      ),
    );
    validateEnvironment(
      seat.env,
      `${label}[${index}].env`,
      index === candidateSeat && arm !== undefined ? arm.env : {},
    );
  }
}

function validateBlockRoster(
  plan: CoworldPairedPlan,
  block: CoworldPairedBlock,
): void {
  if (block.roster.length !== plan.opponentImages.length + 1) {
    throw new Error(`Block ${block.blockID} roster cardinality is invalid`);
  }
  const candidate = block.roster[block.candidateSeat]!;
  if (
    coworldCanonicalSha256(candidate.image) !==
    coworldCanonicalSha256(plan.candidateImage)
  ) {
    throw new Error(`Block ${block.blockID} candidate image is inconsistent`);
  }
  const opponents = block.roster
    .filter((seat) => seat.role === "opponent")
    .map((seat) => seat.image);
  if (
    coworldCanonicalSha256(opponents) !==
    coworldCanonicalSha256(plan.opponentImages)
  ) {
    throw new Error(`Block ${block.blockID} opponent images are inconsistent`);
  }
}

function validateJobRoster(
  block: CoworldPairedBlock,
  job: CoworldPairedJob,
): void {
  const expected = block.roster.map((seat) => ({
    ...seat,
    env:
      seat.role === "candidate"
        ? { ...seat.env, ...job.arm.env }
        : { ...seat.env },
  }));
  if (coworldCanonicalSha256(job.roster) !== coworldCanonicalSha256(expected)) {
    throw new Error(
      `Job ${job.jobID} roster contains unexpected environment or identity fields`,
    );
  }
  const candidate = job.roster[job.candidateSeat]!;
  if (
    coworldCanonicalSha256(candidate.image) !==
    coworldCanonicalSha256(job.candidateImage)
  ) {
    throw new Error(
      `Job ${job.jobID} candidate image identity is inconsistent`,
    );
  }
  const opponentImages = job.roster
    .filter((seat) => seat.role === "opponent")
    .map((seat) => seat.image);
  if (
    coworldCanonicalSha256(opponentImages) !==
    coworldCanonicalSha256(job.opponentImages)
  ) {
    throw new Error(
      `Job ${job.jobID} opponent image identities are inconsistent`,
    );
  }
}

function validateRequest(
  plan: CoworldPairedPlan,
  job: CoworldPairedJob,
  manifest: JsonObject,
  request: JsonObject,
): void {
  assertExactObjectKeys(
    request,
    ["manifest", "game_config", "players", "episode_tags"],
    `job ${job.jobID} request`,
  );
  if (
    coworldCanonicalSha256(request.manifest) !==
    coworldCanonicalSha256(manifest)
  ) {
    throw new Error(`Job ${job.jobID} request embeds a different manifest`);
  }
  const tags = requireObject(request.episode_tags, "episode_tags");
  const expectedTags = {
    proxywar_matrix: plan.matrixID,
    proxywar_block_id: job.blockID,
    proxywar_pair_id: job.pairID,
    proxywar_arm: job.arm.armID,
    proxywar_expert_mask: String(job.expertMask),
  };
  if (coworldCanonicalSha256(tags) !== coworldCanonicalSha256(expectedTags)) {
    throw new Error(`Job ${job.jobID} request tags do not match plan identity`);
  }
  const config = requireObject(request.game_config, "game_config");
  const names = job.roster.map(({ name }) => ({ name }));
  const variants = manifest.variants;
  if (!Array.isArray(variants)) {
    throw new Error("Materialized manifest variants are malformed");
  }
  const variant = variants.find(
    (entry) => isObject(entry) && entry.id === job.variantID,
  );
  if (variant === undefined) {
    throw new Error(`Job ${job.jobID} variant is absent from the manifest`);
  }
  const authoredConfig = requireObject(
    variant.game_config,
    `manifest variant ${job.variantID} game_config`,
  );
  const expectedConfig = { ...authoredConfig, players: names, seed: job.seed };
  if (
    config.map !== job.map ||
    coworldCanonicalSha256(config) !== coworldCanonicalSha256(expectedConfig)
  ) {
    throw new Error(`Job ${job.jobID} request game identity differs from plan`);
  }
  const expectedPlayers = job.roster.map((seat) => ({
    type: "player",
    image: seat.image.reference,
    ...(seat.run.length === 0 ? {} : { run: seat.run }),
    env: seat.env,
  }));
  if (
    coworldCanonicalSha256(request.players) !==
    coworldCanonicalSha256(expectedPlayers)
  ) {
    throw new Error(
      `Job ${job.jobID} request contains unexpected player environment fields`,
    );
  }
}

function validateMaterializedManifest(
  plan: CoworldPairedPlan,
  manifest: JsonObject,
): void {
  if (coworldCanonicalSha256(manifest) !== plan.manifestSha256) {
    throw new Error("Materialized manifest hash does not match plan identity");
  }
  const game = requireObject(manifest.game, "materialized manifest game");
  const runnable = requireObject(
    game.runnable,
    "materialized manifest game runnable",
  );
  if (runnable.image !== plan.gameImage.reference) {
    throw new Error(
      "Materialized manifest game image differs from recorded image identity",
    );
  }
}

async function validateExecutionInputs(
  plan: CoworldPairedPlan,
  job: CoworldPairedJob,
): Promise<void> {
  const manifest = await readJson<JsonObject>(
    plan.materializedManifestPath,
    "materialized manifest",
  );
  validateMaterializedManifest(plan, manifest);
  const request = await readJson<JsonObject>(
    job.requestPath,
    "episode request",
  );
  validateRequest(plan, job, manifest, request);
}

async function assertPlanImagesUnchanged(
  plan: CoworldPairedPlan,
  resolver: CoworldImageResolver,
): Promise<void> {
  const expected = new Map<string, string>();
  for (const image of [
    plan.gameImage,
    plan.candidateImage,
    ...plan.opponentImages,
  ]) {
    validateImage(image, "plan image");
    const prior = expected.get(image.reference);
    if (prior !== undefined && prior !== image.imageID) {
      throw new Error(`Plan assigns multiple image IDs to ${image.reference}`);
    }
    expected.set(image.reference, image.imageID);
  }
  const resolved = await Promise.all(
    [...expected].map(async ([reference, imageID]) => ({
      reference,
      imageID,
      current: (await resolver(reference)).trim().toLowerCase(),
    })),
  );
  for (const image of resolved) {
    if (
      !IMAGE_ID_PATTERN.test(image.current) ||
      image.current !== image.imageID
    ) {
      throw new Error(`Local Docker image changed for ${image.reference}`);
    }
  }
}

async function buildCompletion(
  plan: CoworldPairedPlan,
  job: CoworldPairedJob,
  manifest: JsonObject,
  validateResults: CoworldResultsValidator,
  validation: CoworldExecutionValidationProvenance,
): Promise<CoworldJobCompletion> {
  const resultsPath = path.join(job.outputDir, "results.json");
  const replayPath = path.join(job.outputDir, "replay");
  const results = await readJson<JsonObject>(resultsPath, "episode results");
  validateBasicResults(results, job);
  await validateResults({ manifest, results, job });
  const resultsSha256 = await hashArtifact(resultsPath);
  const replaySha256 = await hashArtifact(replayPath);
  return {
    schemaVersion: 1,
    status: "complete",
    matrixID: plan.matrixID,
    blockID: job.blockID,
    pairID: job.pairID,
    jobID: job.jobID,
    rosterOrderID: job.rosterOrderID,
    arm: job.arm,
    expertMask: job.expertMask,
    variantID: job.variantID,
    seed: job.seed,
    map: job.map,
    candidateSeat: job.candidateSeat,
    roster: job.roster,
    candidateImage: job.candidateImage,
    gameImage: job.gameImage,
    opponentImages: job.opponentImages,
    resultsPath,
    replayPath,
    resultsSha256,
    replaySha256,
    validation,
  };
}

async function validateCompletedJob(
  plan: CoworldPairedPlan,
  job: CoworldPairedJob,
  manifest: JsonObject,
  validateResults: CoworldResultsValidator,
  validation: CoworldExecutionValidationProvenance,
): Promise<CoworldJobCompletion> {
  const saved = await readJson<CoworldJobCompletion>(
    job.completionPath,
    "job completion",
  );
  const expected = await buildCompletion(
    plan,
    job,
    manifest,
    validateResults,
    validation,
  );
  if (
    saved.schemaVersion !== 1 ||
    saved.status !== "complete" ||
    !ARTIFACT_HASH_PATTERN.test(saved.resultsSha256) ||
    !ARTIFACT_HASH_PATTERN.test(saved.replaySha256) ||
    coworldCanonicalSha256(saved) !== coworldCanonicalSha256(expected)
  ) {
    throw new Error(
      `Job ${job.jobID} completion identity or artifact hash is invalid`,
    );
  }
  return saved;
}

function validateBasicResults(
  results: JsonObject,
  job: CoworldPairedJob,
): void {
  if (
    !Array.isArray(results.scores) ||
    results.scores.length !== job.roster.length ||
    results.scores.some(
      (score) => typeof score !== "number" || !Number.isFinite(score),
    )
  ) {
    throw new Error(`Job ${job.jobID} results contain invalid scores`);
  }
}

async function runCoworldEpisode(input: {
  plan: CoworldPairedPlan;
  job: CoworldPairedJob;
}): Promise<void> {
  const tmpDir = await ensureMatrixTemporaryDirectory(input.plan);
  const code = await runProcess(
    "uvx",
    [
      "--from",
      `coworld==${COWORLD_VERSION}`,
      "coworld",
      "run-episode",
      input.plan.materializedManifestPath,
      input.job.requestPath,
      "-o",
      input.job.outputDir,
      "--verify-replay",
      "--timeout-seconds",
      String(EPISODE_TIMEOUT_SECONDS),
    ],
    EPISODE_PROCESS_TIMEOUT_MS,
    { ...process.env, TMPDIR: tmpDir },
  );
  if (code !== 0) {
    throw new Error(`Coworld episode failed for job ${input.job.jobID}`);
  }
}

async function ensureMatrixTemporaryDirectory(
  plan: CoworldPairedPlan,
): Promise<string> {
  const root = path.dirname(plan.planPath);
  const realRoot = await fs.realpath(root);
  const tmpDir = path.join(root, "tmp");
  try {
    await fs.mkdir(tmpDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
  }
  await validateRealDirectory(
    tmpDir,
    path.join(realRoot, "tmp"),
    "plan temporary directory",
  );
  return tmpDir;
}

const RESULT_VALIDATOR = String.raw`
import json
import sys
from importlib.metadata import version
from coworld.schema_validation import validate_json_schema

payload = json.load(sys.stdin)
if version("coworld") != "0.1.30":
    raise SystemExit(2)
validate_json_schema(payload["results"], payload["manifest"]["game"]["results_schema"])
print(json.dumps({"ok": True}))
`;

async function validateCoworldResultsWithPinnedToolchain(input: {
  manifest: JsonObject;
  results: JsonObject;
}): Promise<void> {
  const code = await runProcess(
    "uv",
    [
      "run",
      "--no-project",
      "--with",
      `coworld==${COWORLD_VERSION}`,
      "python",
      "-c",
      RESULT_VALIDATOR,
    ],
    VALIDATOR_PROCESS_TIMEOUT_MS,
    process.env,
    JSON.stringify({ manifest: input.manifest, results: input.results }),
  );
  if (code !== 0) {
    throw new Error(`Coworld ${COWORLD_VERSION} rejected episode results`);
  }
}

async function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error(`Unable to start required local command ${command}`));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
    child.stdin.on("error", () => undefined);
    if (stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(stdin, "utf8");
    }
  });
}

async function hashArtifact(artifactPath: string): Promise<string> {
  const stat = await fs.lstat(artifactPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Artifact must not be a symlink: ${artifactPath}`);
  }
  const hash = createHash("sha256");
  if (stat.isFile()) {
    if (stat.size === 0) {
      throw new Error(`Artifact is empty: ${artifactPath}`);
    }
    await updateHashFromFile(hash, artifactPath);
  } else if (stat.isDirectory()) {
    const files = await collectArtifactFiles(artifactPath);
    if (files.length === 0) {
      throw new Error(`Artifact directory is empty: ${artifactPath}`);
    }
    for (const file of files) {
      const relative = path
        .relative(artifactPath, file)
        .split(path.sep)
        .join("/");
      hash.update(relative);
      hash.update("\0");
      await updateHashFromFile(hash, file);
      hash.update("\0");
    }
  } else {
    throw new Error(`Artifact has unsupported file type: ${artifactPath}`);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function collectArtifactFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => compareText(a.name, b.name));
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Replay artifact must not contain symlinks: ${current}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectArtifactFiles(current)));
    } else if (entry.isFile()) {
      const stat = await fs.stat(current);
      if (stat.size === 0) {
        throw new Error(`Replay artifact contains an empty file: ${current}`);
      }
      files.push(current);
    } else {
      throw new Error(
        `Replay artifact contains an unsupported entry: ${current}`,
      );
    }
  }
  return files;
}

async function updateHashFromFile(
  hash: ReturnType<typeof createHash>,
  filePath: string,
): Promise<void> {
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
}

async function readJson<T>(filePath: string, label: string): Promise<T> {
  const stat = await fs.lstat(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > COWORLD_PAIRED_BOUNDS.maxJsonBytes
  ) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function stableRosterOrderID(roster: CoworldRosterSeatIdentity[]): string {
  return `roster-${coworldCanonicalSha256(roster).slice(7, 39)}`;
}

function stableExecutionID(prefix: string, ...parts: unknown[]): string {
  return `${prefix}-${coworldCanonicalSha256(parts).slice(7, 39)}`;
}

function rotateArmIDs(armIDs: string[], blockIndex: number): string[] {
  const offset = blockIndex % armIDs.length;
  return [...armIDs.slice(offset), ...armIDs.slice(0, offset)];
}

function compareResolvedArms(
  a: CoworldResolvedArm,
  b: CoworldResolvedArm,
): number {
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
    }
  };
  return (
    rank(a) - rank(b) ||
    a.expertMask - b.expertMask ||
    compareText(a.armID, b.armID)
  );
}

function validateImage(image: CoworldResolvedImage, label: string): void {
  assertExactObjectKeys(image, ["reference", "imageID"], label);
  if (
    !isBoundedString(image.reference) ||
    /\s/.test(image.reference) ||
    typeof image.imageID !== "string" ||
    !IMAGE_ID_PATTERN.test(image.imageID)
  ) {
    throw new Error(`${label} is malformed`);
  }
}

function validateEnvironment(
  value: unknown,
  label: string,
  allowedArmEnvironment: Record<string, string>,
): asserts value is Record<string, string> {
  if (
    !isObject(value) ||
    Object.keys(value).length > COWORLD_PAIRED_BOUNDS.maxEnvironmentEntries
  ) {
    throw new Error(`${label} must be a bounded environment object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      !ENV_KEY_PATTERN.test(key) ||
      key.length > COWORLD_PAIRED_BOUNDS.maxEnvironmentKey ||
      typeof entry !== "string" ||
      entry.length > COWORLD_PAIRED_BOUNDS.maxEnvironmentValue ||
      entry.trim().length === 0 ||
      entry.includes("\0")
    ) {
      throw new Error(`${label} contains an invalid key or value`);
    }
    if (ARM_OWNED_ENV_KEYS.has(key)) {
      if (allowedArmEnvironment[key] !== entry) {
        throw new Error(`${label} contains an unexpected arm-owned field`);
      }
      continue;
    }
    if (isReservedOrSecretEnvKey(key)) {
      throw new Error(`${label} contains a reserved or secret-looking key`);
    }
  }
  for (const [key, expected] of Object.entries(allowedArmEnvironment)) {
    if (value[key] !== expected) {
      throw new Error(`${label} is missing a required arm-owned field`);
    }
  }
}

function isReservedOrSecretEnvKey(key: string): boolean {
  const upper = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  const tokens = upper.split(/_+/).filter((token) => token.length > 0);
  const compact = tokens.join("");
  return (
    upper.startsWith("COWORLD_") ||
    tokens.includes("AWS") ||
    compact.startsWith("AWS") ||
    tokens.some((token) => SECRET_ENV_TOKEN_PATTERN.test(token)) ||
    SECRET_ENV_COMPACT_PATTERN.test(compact) ||
    upper === "__PROTO__" ||
    upper === "PROTOTYPE" ||
    upper === "CONSTRUCTOR"
  );
}

function assertExactObjectKeys(
  value: unknown,
  expectedKeys: string[],
  label: string,
): asserts value is JsonObject {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const expected = [...expectedKeys].sort(compareText);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} contains missing or unexpected fields`);
  }
}

function isBoundedString(
  value: unknown,
  maximum: number = COWORLD_PAIRED_BOUNDS.maxIdentityString,
): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  );
}

function validateBoundedString(
  value: unknown,
  label: string,
  maximum: number = COWORLD_PAIRED_BOUNDS.maxIdentityString,
): asserts value is string {
  if (!isBoundedString(value, maximum)) {
    throw new Error(`${label} must be a bounded nonempty string`);
  }
}

function validateCanonicalTimestamp(value: unknown, label: string): void {
  validateBoundedString(value, label, 64);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
}

function validateAbsolutePath(value: unknown, label: string): void {
  validateBoundedString(value, label);
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
}

function validateInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): asserts value is number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`${label} must be an integer in ${minimum}..${maximum}`);
  }
}

function validateUniqueStrings(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a nonempty array`);
  }
  value.forEach((entry, index) =>
    validateBoundedString(entry, `${label}[${index}]`),
  );
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
}

function validateUniqueIntegers(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a nonempty array`);
  }
  value.forEach((entry, index) =>
    validateInteger(entry, minimum, maximum, `${label}[${index}]`),
  );
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactPath(
  actual: string,
  expected: string,
  label: string,
): void {
  if (path.resolve(actual) !== path.resolve(expected)) {
    throw new Error(`${label} path does not match plan layout`);
  }
}

async function assertPathAbsent(
  filePath: string,
  label: string,
): Promise<void> {
  if (await pathExists(filePath)) {
    throw new Error(`${label} already exists`);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseArguments(argv: string[]): { planPath: string } {
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(
      "Usage: npm run league:paired-execute -- --plan /absolute/path/to/plan.json\n",
    );
    process.exit(0);
  }
  if (argv.length !== 2 || argv[0] !== "--plan" || argv[1]!.startsWith("--")) {
    throw new Error("Executor requires exactly --plan <plan.json>");
  }
  validateBoundedString(argv[1], "--plan");
  return { planPath: argv[1] };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const summary = await executeCoworldPairedPlan({ planPath: args.planPath });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`coworld paired executor: ${message}\n`);
    process.exitCode = 1;
  });
}
