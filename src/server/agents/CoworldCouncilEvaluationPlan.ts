import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  CoworldCouncilEvaluationArm,
  CoworldCouncilEvaluationAssignment,
  CoworldCouncilEvaluationPlanBlockEvidence,
  CoworldCouncilEvaluationPlanEvidence,
  CoworldCouncilEvaluationPlanJobEvidence,
  CoworldEvaluationEpisode,
} from "./CoworldEvaluationDataset";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const COUNCIL_PLAN_MAX_BYTES = 10_000_000;
const COUNCIL_MAX_JOBS = 1_000;
const COUNCIL_MAX_ARMS = 35;
const COUNCIL_MAX_ROSTER = 12;
const COUNCIL_MAX_RUN_ARGUMENTS = 128;
const COUNCIL_MAX_IDENTITY_STRING = 4_096;
const COUNCIL_MAX_NAME = 256;
const COUNCIL_MAX_ENVIRONMENT_ENTRIES = 128;
const COUNCIL_MAX_ENVIRONMENT_KEY = 128;
const COUNCIL_MAX_ENVIRONMENT_VALUE = 65_536;
const COUNCIL_MAX_SEED = 308_915_775;
const councilArmOwnedEnvironmentKeys = new Set([
  "PROXYWAR_KEYSTONE_SINGLE_ACTION",
  "PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW",
  "PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD",
  "PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR",
  "PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD",
  "PROXYWAR_KEYSTONE_COMMANDER_RETENTION",
  "PROXYWAR_KEYSTONE_DEFENSE_AUTHORITY",
  "PROXYWAR_KEYSTONE_COUNCIL_BALANCE_OF_POWER",
  "PROXYWAR_KEYSTONE_EXPERT_MASK",
]);
const councilEnvironmentKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const councilSecretEnvironmentTokenPattern =
  /^(?:ACCESS|AUTH|AUTHORIZATION|BEARER|CREDENTIALS?|KEY|OAUTH|PASS|PASSWD|PASSWORD|PAT|PRIVATE|SECRET|SESSION|TOKEN)$/;
const councilSecretEnvironmentCompactPattern =
  /(?:ACCESSKEY|APIKEY|AUTHORIZATION|BEARER|CLIENTSECRET|CREDENTIAL|PASSWORD|PASSWD|PRIVATEKEY|SECRET|TOKEN|PAT$)/;
const councilPlanTopLevelKeys = [
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
] as const;
const councilMatrixIdentityKeys = [
  "contract",
  "manifestSha256",
  "gameImage",
  "candidate",
  "opponents",
  "variantIDs",
  "candidateSeats",
  "seeds",
  "arms",
] as const;
const councilMatrixRunnableKeys = [
  "reference",
  "run",
  "env",
  "name",
  "image",
] as const;
const councilPlanBlockKeys = [
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
] as const;
const councilPlanJobKeys = [
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
] as const;
const councilCompletionKeys = [
  "schemaVersion",
  "status",
  "matrixID",
  "blockID",
  "pairID",
  "jobID",
  "rosterOrderID",
  "arm",
  "expertMask",
  "variantID",
  "seed",
  "map",
  "candidateSeat",
  "roster",
  "candidateImage",
  "gameImage",
  "opponentImages",
  "resultsPath",
  "replayPath",
  "resultsSha256",
  "replaySha256",
  "validation",
] as const;
const councilCompletionValidationKeys = [
  "coworldVersion",
  "episodeRunner",
  "resultsValidator",
  "replayValidator",
] as const;
const councilArmKeys = [
  "armID",
  "kind",
  "base",
  "shadow",
  "expertMask",
  "env",
] as const;
const councilRosterSeatKeys = [
  "seat",
  "role",
  "name",
  "image",
  "run",
  "env",
] as const;
const councilImageKeys = ["reference", "imageID"] as const;
const matrixIDPattern = /^matrix-[0-9a-f]{32}$/;
const blockIDPattern = /^block-[0-9a-f]{32}$/;
const pairIDPattern = /^pair-[0-9a-f]{32}$/;
const rosterOrderIDPattern = /^roster-[0-9a-f]{32}$/;
const sha256Pattern = /^sha256:[0-9a-f]{64}$/;

interface CouncilPlanImage {
  reference: string;
  imageID: string;
}

interface CouncilMatrixRunnableIdentity {
  reference: string;
  run: string[];
  env: Record<string, string>;
  name: string | null;
  image: CouncilPlanImage;
}

interface CouncilMatrixIdentity {
  contract: "proxywar-coworld-paired-matrix-v3";
  manifestSha256: string;
  gameImage: CouncilPlanImage;
  candidate: CouncilMatrixRunnableIdentity;
  opponents: CouncilMatrixRunnableIdentity[];
  variantIDs: string[];
  candidateSeats: number[];
  seeds: number[];
  arms: CoworldCouncilEvaluationArm[];
}

interface CouncilPlanRosterSeat {
  seat: number;
  role: "candidate" | "opponent";
  name: string;
  image: CouncilPlanImage;
  run: string[];
  env: Record<string, string>;
}

interface CouncilPlanBlock {
  blockID: string;
  pairID: string;
  blockIndex: number;
  variantID: string;
  map: string;
  candidateSeat: number;
  seed: number;
  rosterOrderID: string;
  armOrder: string[];
  roster: CouncilPlanRosterSeat[];
}

interface CouncilPlanJob {
  jobID: string;
  matrixID: string;
  blockID: string;
  pairID: string;
  blockOrder: number;
  pairOrder: number;
  arm: CoworldCouncilEvaluationArm;
  expertMask: number;
  variantID: string;
  map: string;
  candidateSeat: number;
  seed: number;
  rosterOrderID: string;
  roster: CouncilPlanRosterSeat[];
  requestPath: string;
  outputDir: string;
  completionPath: string;
  candidateImage: CouncilPlanImage;
  gameImage: CouncilPlanImage;
  opponentImages: CouncilPlanImage[];
}

interface CouncilPlan {
  sourcePath: string;
  matrixID: string;
  matrixIdentity: CouncilMatrixIdentity;
  manifestSha256: string;
  materializedManifestPath: string;
  candidateImage: CouncilPlanImage;
  gameImage: CouncilPlanImage;
  opponentImages: CouncilPlanImage[];
  arms: CoworldCouncilEvaluationArm[];
  blocks: CouncilPlanBlock[];
  jobs: CouncilPlanJob[];
}

export interface CompletedCouncilPlanJob {
  evidence: CoworldCouncilEvaluationPlanJobEvidence;
  outputDir: string;
  resultsPath: string;
  replayPath: string;
}

export interface LoadedCouncilEvaluationPlans {
  evidence: CoworldCouncilEvaluationPlanEvidence;
  completedJobs: CompletedCouncilPlanJob[];
  plannedJobRoots: string[];
}

function councilExactRecord(
  value: unknown,
  keys: readonly string[],
  context: string,
): Record<string, unknown> {
  const record = asRecord(value);
  const actualKeys = record === null ? [] : Object.keys(record);
  const expected = new Set(keys);
  if (
    record === null ||
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => !expected.has(key))
  ) {
    throw new Error(`${context} has invalid keys`);
  }
  return record;
}

function councilString(
  value: unknown,
  context: string,
  maximum = COUNCIL_MAX_IDENTITY_STRING,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new Error(`${context} must be a bounded nonempty string`);
  }
  return value;
}

function councilInteger(
  value: unknown,
  context: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new Error(`${context} must be an integer in 0..${maximum}`);
  }
  return value;
}

function councilStringArray(
  value: unknown,
  context: string,
  maximumEntries = COUNCIL_MAX_RUN_ARGUMENTS,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumEntries ||
    value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.trim().length === 0 ||
        entry.length > COUNCIL_MAX_IDENTITY_STRING ||
        entry.includes("\0"),
    )
  ) {
    throw new Error(`${context} must be a string array`);
  }
  return value as string[];
}

function councilStringMap(
  value: unknown,
  context: string,
  allowedArmEnvironment: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const record = asRecord(value);
  if (
    record === null ||
    Object.keys(record).length > COUNCIL_MAX_ENVIRONMENT_ENTRIES
  ) {
    throw new Error(`${context} must be a bounded environment map`);
  }
  for (const [key, entry] of Object.entries(record)) {
    if (
      !councilEnvironmentKeyPattern.test(key) ||
      key.length > COUNCIL_MAX_ENVIRONMENT_KEY ||
      typeof entry !== "string" ||
      entry.trim().length === 0 ||
      entry.length > COUNCIL_MAX_ENVIRONMENT_VALUE ||
      entry.includes("\0")
    ) {
      throw new Error(`${context} contains an invalid environment entry`);
    }
    if (councilArmOwnedEnvironmentKeys.has(key)) {
      if (allowedArmEnvironment[key] !== entry) {
        throw new Error(`${context} contains an unexpected arm-owned field`);
      }
    } else if (councilReservedOrSecretEnvironmentKey(key)) {
      throw new Error(`${context} contains a reserved or secret-looking key`);
    }
  }
  for (const [key, expected] of Object.entries(allowedArmEnvironment)) {
    if (record[key] !== expected) {
      throw new Error(`${context} is missing a required arm-owned field`);
    }
  }
  return record as Record<string, string>;
}

function councilReservedOrSecretEnvironmentKey(key: string): boolean {
  const upper = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  const tokens = upper.split(/_+/).filter((token) => token.length > 0);
  const compact = tokens.join("");
  return (
    upper.startsWith("COWORLD_") ||
    tokens.includes("AWS") ||
    compact.startsWith("AWS") ||
    tokens.some((token) => councilSecretEnvironmentTokenPattern.test(token)) ||
    councilSecretEnvironmentCompactPattern.test(compact) ||
    upper === "__PROTO__" ||
    upper === "PROTOTYPE" ||
    upper === "CONSTRUCTOR"
  );
}

function councilCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(councilCanonicalize);
  }
  const record = asRecord(value);
  if (record !== null) {
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, councilCanonicalize(record[key])]),
    );
  }
  return value;
}

function councilCanonicalSha256(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(councilCanonicalize(value)))
    .digest("hex")}`;
}

function compareCouncilText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function councilAbsolutePath(value: unknown, context: string): string {
  const string = councilString(value, context);
  if (!path.isAbsolute(string) || path.resolve(string) !== string) {
    throw new Error(`${context} must be an absolute normalized path`);
  }
  return string;
}

function councilImage(value: unknown, context: string): CouncilPlanImage {
  const record = councilExactRecord(value, councilImageKeys, context);
  const reference = councilString(record.reference, `${context}.reference`);
  const imageID = councilString(record.imageID, `${context}.imageID`);
  if (/\s/.test(reference) || !sha256Pattern.test(imageID)) {
    throw new Error(`${context} image identity is invalid`);
  }
  return { reference, imageID };
}

function councilArm(
  value: unknown,
  context: string,
): CoworldCouncilEvaluationArm {
  const record = councilExactRecord(value, councilArmKeys, context);
  const kind = councilString(
    record.kind,
    `${context}.kind`,
  ) as CoworldCouncilEvaluationArm["kind"];
  if (
    kind !== "v16" &&
    kind !== "a1" &&
    kind !== "v16-shadow" &&
    kind !== "a1-shadow" &&
    kind !== "v16-politics-guard" &&
    kind !== "v16-diplomacy-adjudicator" &&
    kind !== "v16-survival-shield" &&
    kind !== "v39" &&
    kind !== "v39-commander-retention" &&
    kind !== "v39-defense-authority" &&
    kind !== "v40" &&
    kind !== "v40-balance-of-power"
  ) {
    throw new Error(`${context}.kind is unsupported`);
  }
  const expertMask = councilInteger(
    record.expertMask,
    `${context}.expertMask`,
    15,
  );
  const shadow = kind === "v16-shadow" || kind === "a1-shadow";
  const politicsGuard = kind === "v16-politics-guard";
  const diplomacyAdjudicator = kind === "v16-diplomacy-adjudicator";
  const v39Family =
    kind === "v39" ||
    kind === "v39-commander-retention" ||
    kind === "v39-defense-authority";
  const v40Family = kind === "v40" || kind === "v40-balance-of-power";
  const survivalShield =
    kind === "v16-survival-shield" || v39Family || v40Family;
  const commanderRetention = kind === "v39-commander-retention" || v40Family;
  const defenseAuthority = kind === "v39-defense-authority";
  const balanceOfPower = kind === "v40-balance-of-power";
  const base = kind === "a1" || kind === "a1-shadow" ? "a1" : "v16";
  if (politicsGuard && expertMask !== 15) {
    throw new Error(`${context}.expertMask must be 15 for politics guard`);
  }
  if (diplomacyAdjudicator && expertMask !== 15) {
    throw new Error(
      `${context}.expertMask must be 15 for diplomacy adjudicator`,
    );
  }
  if (survivalShield && expertMask !== 15) {
    throw new Error(`${context}.expertMask must be 15 for survival shield`);
  }
  if (
    !shadow &&
    !politicsGuard &&
    !diplomacyAdjudicator &&
    !survivalShield &&
    expertMask !== 0
  ) {
    throw new Error(`${context}.expertMask must be 0 for non-shadow arms`);
  }
  const armID = shadow ? `${kind}-m${expertMask}` : kind;
  const env = {
    PROXYWAR_KEYSTONE_SINGLE_ACTION: base === "a1" ? "1" : "0",
    PROXYWAR_KEYSTONE_EXPERT_COUNCIL_SHADOW: shadow ? "1" : "0",
    ...(politicsGuard ? { PROXYWAR_KEYSTONE_COUNCIL_POLITICS_GUARD: "1" } : {}),
    ...(diplomacyAdjudicator
      ? { PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR: "1" }
      : {}),
    ...(survivalShield
      ? { PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD: "1" }
      : {}),
    ...(v39Family || v40Family
      ? {
          PROXYWAR_KEYSTONE_COMMANDER_RETENTION: commanderRetention ? "1" : "0",
          PROXYWAR_KEYSTONE_DEFENSE_AUTHORITY: defenseAuthority ? "1" : "0",
        }
      : {}),
    ...(v40Family
      ? {
          PROXYWAR_KEYSTONE_COUNCIL_BALANCE_OF_POWER: balanceOfPower
            ? "1"
            : "0",
        }
      : {}),
    ...(shadow || politicsGuard || diplomacyAdjudicator || survivalShield
      ? { PROXYWAR_KEYSTONE_EXPERT_MASK: String(expertMask) }
      : {}),
  };
  const parsed: CoworldCouncilEvaluationArm = {
    armID: councilString(record.armID, `${context}.armID`),
    kind,
    base:
      record.base === "v16" || record.base === "a1"
        ? record.base
        : (() => {
            throw new Error(`${context}.base is invalid`);
          })(),
    shadow:
      typeof record.shadow === "boolean"
        ? record.shadow
        : (() => {
            throw new Error(`${context}.shadow is invalid`);
          })(),
    expertMask,
    env: councilStringMap(record.env, `${context}.env`, env),
  };
  const expected: CoworldCouncilEvaluationArm = {
    armID,
    kind,
    base,
    shadow,
    expertMask,
    env,
  };
  if (!isDeepStrictEqual(parsed, expected)) {
    throw new Error(`${context} does not match its derived arm identity`);
  }
  return parsed;
}

function councilRoster(
  value: unknown,
  candidateSeat: number,
  context: string,
  candidateArmEnvironment: Readonly<Record<string, string>> = {},
): CouncilPlanRosterSeat[] {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > COUNCIL_MAX_ROSTER
  ) {
    throw new Error(`${context} must contain 2..${COUNCIL_MAX_ROSTER} seats`);
  }
  if (candidateSeat >= value.length) {
    throw new Error(`${context} candidateSeat is out of range`);
  }
  return value.map((entry, index) => {
    const record = councilExactRecord(
      entry,
      councilRosterSeatKeys,
      `${context}[${index}]`,
    );
    const role = record.role;
    if (
      (role !== "candidate" && role !== "opponent") ||
      (index === candidateSeat) !== (role === "candidate")
    ) {
      throw new Error(`${context}[${index}].role is invalid`);
    }
    const seat = councilInteger(record.seat, `${context}[${index}].seat`);
    if (seat !== index) {
      throw new Error(`${context} is not in exact seat order`);
    }
    return {
      seat,
      role,
      name: councilString(
        record.name,
        `${context}[${index}].name`,
        COUNCIL_MAX_NAME,
      ),
      image: councilImage(record.image, `${context}[${index}].image`),
      run: councilStringArray(record.run, `${context}[${index}].run`),
      env: councilStringMap(
        record.env,
        `${context}[${index}].env`,
        role === "candidate" ? candidateArmEnvironment : {},
      ),
    };
  });
}

function councilImages(value: unknown, context: string): CouncilPlanImage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must contain at least one image`);
  }
  return value.map((entry, index) =>
    councilImage(entry, `${context}[${index}]`),
  );
}

function councilArmRank(arm: CoworldCouncilEvaluationArm): number {
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
}

function compareCouncilArms(
  left: CoworldCouncilEvaluationArm,
  right: CoworldCouncilEvaluationArm,
): number {
  return (
    councilArmRank(left) - councilArmRank(right) ||
    left.expertMask - right.expertMask ||
    compareCouncilText(left.armID, right.armID)
  );
}

function councilMatrixRunnable(
  value: unknown,
  context: string,
): CouncilMatrixRunnableIdentity {
  const record = councilExactRecord(value, councilMatrixRunnableKeys, context);
  const image = councilImage(record.image, `${context}.image`);
  const reference = councilString(record.reference, `${context}.reference`);
  if (reference !== image.reference) {
    throw new Error(`${context} reference differs from its resolved image`);
  }
  const name =
    record.name === null
      ? null
      : councilString(record.name, `${context}.name`, COUNCIL_MAX_NAME);
  return {
    reference,
    run: councilStringArray(record.run, `${context}.run`),
    env: councilStringMap(record.env, `${context}.env`),
    name,
    image,
  };
}

function councilUniqueStrings(value: unknown, context: string): string[] {
  const values = councilStringArray(value, context, COUNCIL_MAX_JOBS);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`${context} must contain unique strings`);
  }
  return values;
}

function councilUniqueIntegers(
  value: unknown,
  context: string,
  maximum: number,
): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must contain integers`);
  }
  const values = value.map((entry, index) =>
    councilInteger(entry, `${context}[${index}]`, maximum),
  );
  if (new Set(values).size !== values.length) {
    throw new Error(`${context} must contain unique integers`);
  }
  return values;
}

function councilMatrixIdentity(
  value: unknown,
  context: string,
): CouncilMatrixIdentity {
  const record = councilExactRecord(value, councilMatrixIdentityKeys, context);
  if (record.contract !== "proxywar-coworld-paired-matrix-v3") {
    throw new Error(`${context}.contract is invalid`);
  }
  const manifestSha256 = councilString(
    record.manifestSha256,
    `${context}.manifestSha256`,
  );
  if (!sha256Pattern.test(manifestSha256)) {
    throw new Error(`${context}.manifestSha256 is invalid`);
  }
  const gameImage = councilImage(record.gameImage, `${context}.gameImage`);
  const candidate = councilMatrixRunnable(
    record.candidate,
    `${context}.candidate`,
  );
  if (
    !Array.isArray(record.opponents) ||
    record.opponents.length === 0 ||
    record.opponents.length >= COUNCIL_MAX_ROSTER
  ) {
    throw new Error(`${context}.opponents cardinality is invalid`);
  }
  const opponents = record.opponents.map((entry, index) =>
    councilMatrixRunnable(entry, `${context}.opponents[${index}]`),
  );
  if (
    !Array.isArray(record.arms) ||
    record.arms.length < 2 ||
    record.arms.length > COUNCIL_MAX_ARMS
  ) {
    throw new Error(`${context}.arms cardinality is invalid`);
  }
  const arms = record.arms.map((entry, index) =>
    councilArm(entry, `${context}.arms[${index}]`),
  );
  if (
    new Set(arms.map((arm) => arm.armID)).size !== arms.length ||
    !isDeepStrictEqual(arms, [...arms].sort(compareCouncilArms))
  ) {
    throw new Error(`${context}.arms are not unique canonical arms`);
  }
  return {
    contract: "proxywar-coworld-paired-matrix-v3",
    manifestSha256,
    gameImage,
    candidate,
    opponents,
    variantIDs: councilUniqueStrings(
      record.variantIDs,
      `${context}.variantIDs`,
    ),
    candidateSeats: councilUniqueIntegers(
      record.candidateSeats,
      `${context}.candidateSeats`,
      opponents.length,
    ),
    seeds: councilUniqueIntegers(
      record.seeds,
      `${context}.seeds`,
      COUNCIL_MAX_SEED,
    ),
    arms,
  };
}

function councilRosterFromMatrixIdentity(
  identity: CouncilMatrixIdentity,
  candidateSeat: number,
): CouncilPlanRosterSeat[] {
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

function councilID(value: unknown, pattern: RegExp, context: string): string {
  const id = councilString(value, context);
  if (!pattern.test(id)) {
    throw new Error(`${context} is invalid`);
  }
  return id;
}

function parseCouncilPlan(value: unknown, sourcePath: string): CouncilPlan {
  const record = councilExactRecord(
    value,
    councilPlanTopLevelKeys,
    `${sourcePath} council plan`,
  );
  if (record.schemaVersion !== 3 || record.coworldVersion !== "0.1.32") {
    throw new Error(
      `${sourcePath} is not a schemaVersion 3 Coworld 0.1.32 plan`,
    );
  }
  const normalizedSourcePath = path.resolve(sourcePath);
  if (
    councilAbsolutePath(record.planPath, `${sourcePath} planPath`) !==
    normalizedSourcePath
  ) {
    throw new Error(`${sourcePath} planPath identity differs from its source`);
  }
  const generatedAt = councilString(
    record.generatedAt,
    `${sourcePath} generatedAt`,
    64,
  );
  const parsedGeneratedAt = new Date(generatedAt);
  if (
    Number.isNaN(parsedGeneratedAt.valueOf()) ||
    parsedGeneratedAt.toISOString() !== generatedAt
  ) {
    throw new Error(`${sourcePath} generatedAt is not canonical ISO time`);
  }
  const matrixID = councilID(
    record.matrixID,
    matrixIDPattern,
    `${sourcePath} matrixID`,
  );
  const manifestSha256 = councilString(
    record.manifestSha256,
    `${sourcePath} manifestSha256`,
  );
  if (!sha256Pattern.test(manifestSha256)) {
    throw new Error(`${sourcePath} manifestSha256 is invalid`);
  }
  councilAbsolutePath(record.manifestPath, `${sourcePath} manifestPath`);
  const root = path.dirname(normalizedSourcePath);
  const materializedManifestPath = councilAbsolutePath(
    record.materializedManifestPath,
    `${sourcePath} materializedManifestPath`,
  );
  if (
    materializedManifestPath !== path.join(root, "payload", "manifest.json")
  ) {
    throw new Error(`${sourcePath} materialized manifest path is invalid`);
  }
  const candidateImage = councilImage(
    record.candidateImage,
    `${sourcePath} candidateImage`,
  );
  const gameImage = councilImage(record.gameImage, `${sourcePath} gameImage`);
  const opponentImages = councilImages(
    record.opponentImages,
    `${sourcePath} opponentImages`,
  );
  if (
    opponentImages.length >= COUNCIL_MAX_ROSTER ||
    !Array.isArray(record.arms) ||
    record.arms.length < 2 ||
    record.arms.length > COUNCIL_MAX_ARMS
  ) {
    throw new Error(`${sourcePath} arm or opponent cardinality is invalid`);
  }
  const arms = record.arms.map((entry, index) =>
    councilArm(entry, `${sourcePath} arms[${index}]`),
  );
  const armByID = new Map(arms.map((arm) => [arm.armID, arm] as const));
  if (
    armByID.size !== arms.length ||
    !isDeepStrictEqual(arms, [...arms].sort(compareCouncilArms))
  ) {
    throw new Error(`${sourcePath} arms are not unique canonical arms`);
  }
  const matrixIdentity = councilMatrixIdentity(
    record.matrixIdentity,
    `${sourcePath} matrixIdentity`,
  );
  if (
    matrixID !==
      `matrix-${councilCanonicalSha256(matrixIdentity).slice(7, 39)}` ||
    matrixIdentity.manifestSha256 !== manifestSha256 ||
    !isDeepStrictEqual(matrixIdentity.gameImage, gameImage) ||
    !isDeepStrictEqual(matrixIdentity.candidate.image, candidateImage) ||
    !isDeepStrictEqual(
      matrixIdentity.opponents.map((opponent) => opponent.image),
      opponentImages,
    ) ||
    !isDeepStrictEqual(matrixIdentity.arms, arms)
  ) {
    throw new Error(
      `${sourcePath} matrixID or matrix identity is inconsistent`,
    );
  }
  if (
    !Array.isArray(record.blocks) ||
    record.blocks.length === 0 ||
    record.blocks.length * arms.length > COUNCIL_MAX_JOBS
  ) {
    throw new Error(`${sourcePath} contains no blocks`);
  }
  const blocks = record.blocks.map((entry, index): CouncilPlanBlock => {
    const block = councilExactRecord(
      entry,
      councilPlanBlockKeys,
      `${sourcePath} blocks[${index}]`,
    );
    const blockID = councilID(
      block.blockID,
      blockIDPattern,
      `${sourcePath} blocks[${index}].blockID`,
    );
    const pairID = councilID(
      block.pairID,
      pairIDPattern,
      `${sourcePath} blocks[${index}].pairID`,
    );
    const blockIndex = councilInteger(
      block.blockIndex,
      `${sourcePath} blocks[${index}].blockIndex`,
    );
    if (blockIndex !== index) {
      throw new Error(`${sourcePath} blockIndex is not in exact plan order`);
    }
    const candidateSeat = councilInteger(
      block.candidateSeat,
      `${sourcePath} blocks[${index}].candidateSeat`,
      COUNCIL_MAX_ROSTER - 1,
    );
    const roster = councilRoster(
      block.roster,
      candidateSeat,
      `${sourcePath} blocks[${index}].roster`,
    );
    const rosterOrderID = councilID(
      block.rosterOrderID,
      rosterOrderIDPattern,
      `${sourcePath} blocks[${index}].rosterOrderID`,
    );
    if (
      rosterOrderID !== `roster-${councilCanonicalSha256(roster).slice(7, 39)}`
    ) {
      throw new Error(`${sourcePath} block rosterOrderID is invalid`);
    }
    const armOrder = councilStringArray(
      block.armOrder,
      `${sourcePath} blocks[${index}].armOrder`,
      COUNCIL_MAX_ARMS,
    );
    const expectedArmOrder = [
      ...arms.slice(index % arms.length),
      ...arms.slice(0, index % arms.length),
    ].map((arm) => arm.armID);
    if (!isDeepStrictEqual(armOrder, expectedArmOrder)) {
      throw new Error(`${sourcePath} block armOrder is invalid`);
    }
    return {
      blockID,
      pairID,
      blockIndex,
      variantID: councilString(
        block.variantID,
        `${sourcePath} blocks[${index}].variantID`,
      ),
      map: councilString(block.map, `${sourcePath} blocks[${index}].map`),
      candidateSeat,
      seed: councilInteger(
        block.seed,
        `${sourcePath} blocks[${index}].seed`,
        COUNCIL_MAX_SEED,
      ),
      rosterOrderID,
      armOrder,
      roster,
    };
  });
  if (
    new Set(blocks.map((block) => block.blockID)).size !== blocks.length ||
    new Set(blocks.map((block) => block.pairID)).size !== blocks.length
  ) {
    throw new Error(`${sourcePath} repeats a block or pair identity`);
  }
  const matrixBlockCount =
    matrixIdentity.variantIDs.length *
    matrixIdentity.candidateSeats.length *
    matrixIdentity.seeds.length;
  if (
    matrixBlockCount !== blocks.length ||
    matrixBlockCount * arms.length > COUNCIL_MAX_JOBS
  ) {
    throw new Error(
      `${sourcePath} matrix axes do not match the bounded block count`,
    );
  }
  const matrixAxisCombinations = matrixIdentity.variantIDs.flatMap(
    (variantID) =>
      matrixIdentity.candidateSeats.flatMap((candidateSeat) =>
        matrixIdentity.seeds.map((seed) => ({
          variantID,
          candidateSeat,
          seed,
        })),
      ),
  );
  if (
    matrixAxisCombinations.length !== blocks.length ||
    blocks.some((block, index) => {
      const combination = matrixAxisCombinations[index];
      const identityParts = [
        matrixID,
        block.variantID,
        block.candidateSeat,
        block.seed,
        block.rosterOrderID,
      ];
      return (
        combination === undefined ||
        block.variantID !== combination.variantID ||
        block.candidateSeat !== combination.candidateSeat ||
        block.seed !== combination.seed ||
        block.blockID !==
          `block-${councilCanonicalSha256(identityParts).slice(7, 39)}` ||
        block.pairID !==
          `pair-${councilCanonicalSha256(identityParts).slice(7, 39)}` ||
        !isDeepStrictEqual(
          block.roster,
          councilRosterFromMatrixIdentity(
            matrixIdentity,
            combination.candidateSeat,
          ),
        )
      );
    })
  ) {
    throw new Error(`${sourcePath} blocks differ from canonical matrix axes`);
  }
  if (!Array.isArray(record.jobs) || record.jobs.length === 0) {
    throw new Error(`${sourcePath} contains no jobs`);
  }
  if (
    record.jobs.length !== blocks.length * arms.length ||
    record.jobs.length > COUNCIL_MAX_JOBS
  ) {
    throw new Error(`${sourcePath} does not contain one job per block arm`);
  }
  const blockByID = new Map(
    blocks.map((block) => [block.blockID, block] as const),
  );
  const jobs = record.jobs.map((entry, index): CouncilPlanJob => {
    const job = councilExactRecord(
      entry,
      councilPlanJobKeys,
      `${sourcePath} jobs[${index}]`,
    );
    const blockID = councilID(
      job.blockID,
      blockIDPattern,
      `${sourcePath} jobs[${index}].blockID`,
    );
    const block = blockByID.get(blockID);
    if (block === undefined) {
      throw new Error(`${sourcePath} job references an unknown block`);
    }
    const arm = councilArm(job.arm, `${sourcePath} jobs[${index}].arm`);
    const plannedArm = armByID.get(arm.armID);
    if (plannedArm === undefined || !isDeepStrictEqual(arm, plannedArm)) {
      throw new Error(`${sourcePath} job arm differs from the plan arm`);
    }
    const blockOrder = councilInteger(
      job.blockOrder,
      `${sourcePath} jobs[${index}].blockOrder`,
      arms.length - 1,
    );
    const pairOrder = councilInteger(
      job.pairOrder,
      `${sourcePath} jobs[${index}].pairOrder`,
      arms.length - 1,
    );
    const roster = councilRoster(
      job.roster,
      block.candidateSeat,
      `${sourcePath} jobs[${index}].roster`,
      arm.env,
    );
    const expectedRoster = block.roster.map((seat) => ({
      ...seat,
      env:
        seat.role === "candidate"
          ? { ...seat.env, ...arm.env }
          : { ...seat.env },
    }));
    const candidateJobImage = councilImage(
      job.candidateImage,
      `${sourcePath} jobs[${index}].candidateImage`,
    );
    const jobGameImage = councilImage(
      job.gameImage,
      `${sourcePath} jobs[${index}].gameImage`,
    );
    const jobOpponentImages = councilImages(
      job.opponentImages,
      `${sourcePath} jobs[${index}].opponentImages`,
    );
    const parsed: CouncilPlanJob = {
      jobID: councilString(job.jobID, `${sourcePath} jobs[${index}].jobID`),
      matrixID: councilID(
        job.matrixID,
        matrixIDPattern,
        `${sourcePath} jobs[${index}].matrixID`,
      ),
      blockID,
      pairID: councilID(
        job.pairID,
        pairIDPattern,
        `${sourcePath} jobs[${index}].pairID`,
      ),
      blockOrder,
      pairOrder,
      arm,
      expertMask: councilInteger(
        job.expertMask,
        `${sourcePath} jobs[${index}].expertMask`,
        15,
      ),
      variantID: councilString(
        job.variantID,
        `${sourcePath} jobs[${index}].variantID`,
      ),
      map: councilString(job.map, `${sourcePath} jobs[${index}].map`),
      candidateSeat: councilInteger(
        job.candidateSeat,
        `${sourcePath} jobs[${index}].candidateSeat`,
        COUNCIL_MAX_ROSTER - 1,
      ),
      seed: councilInteger(
        job.seed,
        `${sourcePath} jobs[${index}].seed`,
        COUNCIL_MAX_SEED,
      ),
      rosterOrderID: councilID(
        job.rosterOrderID,
        rosterOrderIDPattern,
        `${sourcePath} jobs[${index}].rosterOrderID`,
      ),
      roster,
      requestPath: councilAbsolutePath(
        job.requestPath,
        `${sourcePath} jobs[${index}].requestPath`,
      ),
      outputDir: councilAbsolutePath(
        job.outputDir,
        `${sourcePath} jobs[${index}].outputDir`,
      ),
      completionPath: councilAbsolutePath(
        job.completionPath,
        `${sourcePath} jobs[${index}].completionPath`,
      ),
      candidateImage: candidateJobImage,
      gameImage: jobGameImage,
      opponentImages: jobOpponentImages,
    };
    const jobRoot = path.join(root, "payload", "jobs", parsed.jobID);
    if (
      parsed.jobID !== `${block.blockID}-${arm.armID}` ||
      parsed.matrixID !== matrixID ||
      parsed.pairID !== block.pairID ||
      parsed.blockOrder !== parsed.pairOrder ||
      block.armOrder[parsed.blockOrder] !== arm.armID ||
      parsed.expertMask !== arm.expertMask ||
      parsed.variantID !== block.variantID ||
      parsed.map !== block.map ||
      parsed.candidateSeat !== block.candidateSeat ||
      parsed.seed !== block.seed ||
      parsed.rosterOrderID !== block.rosterOrderID ||
      !isDeepStrictEqual(roster, expectedRoster) ||
      !isDeepStrictEqual(candidateJobImage, candidateImage) ||
      !isDeepStrictEqual(jobGameImage, gameImage) ||
      !isDeepStrictEqual(jobOpponentImages, opponentImages) ||
      !isDeepStrictEqual(roster[block.candidateSeat]?.image, candidateImage) ||
      !isDeepStrictEqual(
        roster
          .filter((seat) => seat.role === "opponent")
          .map((seat) => seat.image),
        opponentImages,
      ) ||
      parsed.requestPath !== path.join(jobRoot, "episode_request.json") ||
      parsed.outputDir !== path.join(jobRoot, "episode") ||
      parsed.completionPath !== path.join(jobRoot, "completion.json")
    ) {
      throw new Error(`${sourcePath} job identity is inconsistent`);
    }
    return parsed;
  });
  if (new Set(jobs.map((job) => job.jobID)).size !== jobs.length) {
    throw new Error(`${sourcePath} repeats a job identity`);
  }
  for (const block of blocks) {
    const blockJobs = jobs.filter((job) => job.blockID === block.blockID);
    if (
      blockJobs.length !== arms.length ||
      new Set(blockJobs.map((job) => job.blockOrder)).size !== arms.length
    ) {
      throw new Error(`${sourcePath} block does not contain every arm once`);
    }
  }
  const expectedJobOrder = blocks.flatMap((block) =>
    block.armOrder.map((armID) => `${block.blockID}-${armID}`),
  );
  if (
    jobs.length !== expectedJobOrder.length ||
    jobs.some((job, index) => job.jobID !== expectedJobOrder[index])
  ) {
    throw new Error(`${sourcePath} jobs are not in exact block/arm order`);
  }
  return {
    sourcePath: normalizedSourcePath,
    matrixID,
    matrixIdentity,
    manifestSha256,
    materializedManifestPath,
    candidateImage,
    gameImage,
    opponentImages,
    arms,
    blocks,
    jobs,
  };
}

async function readBoundedJson(
  filePath: string,
  context: string,
): Promise<unknown> {
  const stat = await fs.lstat(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > COUNCIL_PLAN_MAX_BYTES
  ) {
    throw new Error(`${context} is not a bounded regular JSON file`);
  }
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    throw new Error(`${context} contains invalid JSON`);
  }
}

async function hashCouncilArtifact(filePath: string): Promise<string> {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Artifact must not be a symlink: ${filePath}`);
  }
  const hash = createHash("sha256");
  if (stat.isFile()) {
    if (stat.size === 0) {
      throw new Error(`Artifact is empty: ${filePath}`);
    }
    await updateCouncilHashFromFile(hash, filePath);
  } else if (stat.isDirectory()) {
    const files = await collectCouncilArtifactFiles(filePath);
    if (files.length === 0) {
      throw new Error(`Artifact directory is empty: ${filePath}`);
    }
    for (const artifactFile of files) {
      const relative = path
        .relative(filePath, artifactFile)
        .split(path.sep)
        .join("/");
      hash.update(relative);
      hash.update("\0");
      await updateCouncilHashFromFile(hash, artifactFile);
      hash.update("\0");
    }
  } else {
    throw new Error(`Artifact has unsupported file type: ${filePath}`);
  }
  return `sha256:${hash.digest("hex")}`;
}

async function collectCouncilArtifactFiles(
  directory: string,
): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareCouncilText(left.name, right.name));
  for (const entry of entries) {
    const current = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Replay artifact must not contain symlinks: ${current}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectCouncilArtifactFiles(current)));
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

async function updateCouncilHashFromFile(
  hash: ReturnType<typeof createHash>,
  filePath: string,
): Promise<void> {
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
}

function councilAssignment(
  job: CouncilPlanJob,
): CoworldCouncilEvaluationAssignment {
  return {
    matrixID: job.matrixID,
    blockID: job.blockID,
    pairID: job.pairID,
    jobID: job.jobID,
    arm: job.arm,
    intentionToTreat:
      job.arm.shadow ||
      job.arm.kind === "v16-politics-guard" ||
      job.arm.kind === "v16-diplomacy-adjudicator" ||
      job.arm.kind === "v16-survival-shield" ||
      job.arm.kind === "v39-commander-retention" ||
      job.arm.kind === "v39-defense-authority" ||
      job.arm.kind === "v40-balance-of-power",
    actualTreatmentExposure:
      job.arm.kind === "v16-politics-guard" ||
      job.arm.kind === "v16-diplomacy-adjudicator" ||
      job.arm.kind === "v16-survival-shield" ||
      job.arm.kind === "v39-commander-retention" ||
      job.arm.kind === "v39-defense-authority",
    expertMask: job.expertMask,
    variantID: job.variantID,
    seed: job.seed,
    map: job.map,
    candidateSeat: job.candidateSeat,
    rosterOrderID: job.rosterOrderID,
    candidateImageID: job.candidateImage.imageID,
    gameImageID: job.gameImage.imageID,
    opponentImageIDs: job.opponentImages.map((image) => image.imageID),
  };
}

function validateCouncilCompletionProvenance(
  value: unknown,
  context: string,
): void {
  const record = councilExactRecord(
    value,
    councilCompletionValidationKeys,
    context,
  );
  if (
    record.coworldVersion !== "0.1.32" ||
    (record.episodeRunner !== "pinned-coworld-cli" &&
      record.episodeRunner !== "injected") ||
    (record.resultsValidator !== "pinned-coworld-results-schema" &&
      record.resultsValidator !== "injected") ||
    (record.replayValidator !== "pinned-coworld-verify-replay" &&
      record.replayValidator !== "injected-unverified")
  ) {
    throw new Error(`${context} is malformed`);
  }
  if (
    record.episodeRunner !== "pinned-coworld-cli" ||
    record.resultsValidator !== "pinned-coworld-results-schema" ||
    record.replayValidator !== "pinned-coworld-verify-replay"
  ) {
    throw new Error(`${context} is non-production evidence`);
  }
}

async function validateCouncilCompletion(
  job: CouncilPlanJob,
): Promise<{ resultsPath: string; replayPath: string }> {
  const value = await readBoundedJson(
    job.completionPath,
    `job ${job.jobID} completion`,
  );
  const record = councilExactRecord(
    value,
    councilCompletionKeys,
    `job ${job.jobID} completion`,
  );
  if (record.schemaVersion !== 1 || record.status !== "complete") {
    throw new Error(`job ${job.jobID} completion status is invalid`);
  }
  const arm = councilArm(record.arm, `job ${job.jobID} completion.arm`);
  validateCouncilCompletionProvenance(
    record.validation,
    `job ${job.jobID} completion.validation`,
  );
  const candidateSeat = councilInteger(
    record.candidateSeat,
    `job ${job.jobID} completion.candidateSeat`,
    COUNCIL_MAX_ROSTER - 1,
  );
  const roster = councilRoster(
    record.roster,
    candidateSeat,
    `job ${job.jobID} completion.roster`,
    arm.env,
  );
  const candidateImage = councilImage(
    record.candidateImage,
    `job ${job.jobID} completion.candidateImage`,
  );
  const gameImage = councilImage(
    record.gameImage,
    `job ${job.jobID} completion.gameImage`,
  );
  const opponentImages = councilImages(
    record.opponentImages,
    `job ${job.jobID} completion.opponentImages`,
  );
  const resultsPath = councilAbsolutePath(
    record.resultsPath,
    `job ${job.jobID} completion.resultsPath`,
  );
  const replayPath = councilAbsolutePath(
    record.replayPath,
    `job ${job.jobID} completion.replayPath`,
  );
  const resultsSha256 = councilString(
    record.resultsSha256,
    `job ${job.jobID} completion.resultsSha256`,
  );
  const replaySha256 = councilString(
    record.replaySha256,
    `job ${job.jobID} completion.replaySha256`,
  );
  if (!sha256Pattern.test(resultsSha256) || !sha256Pattern.test(replaySha256)) {
    throw new Error(`job ${job.jobID} completion hashes are invalid`);
  }
  if (
    record.matrixID !== job.matrixID ||
    record.blockID !== job.blockID ||
    record.pairID !== job.pairID ||
    record.jobID !== job.jobID ||
    record.rosterOrderID !== job.rosterOrderID ||
    record.expertMask !== job.expertMask ||
    record.variantID !== job.variantID ||
    record.seed !== job.seed ||
    record.map !== job.map ||
    candidateSeat !== job.candidateSeat ||
    !isDeepStrictEqual(arm, job.arm) ||
    !isDeepStrictEqual(roster, job.roster) ||
    !isDeepStrictEqual(candidateImage, job.candidateImage) ||
    !isDeepStrictEqual(gameImage, job.gameImage) ||
    !isDeepStrictEqual(opponentImages, job.opponentImages) ||
    resultsPath !== path.join(job.outputDir, "results.json") ||
    replayPath !== path.join(job.outputDir, "replay")
  ) {
    throw new Error(`job ${job.jobID} completion identity is inconsistent`);
  }
  const outputStat = await fs.lstat(job.outputDir);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error(`job ${job.jobID} output is not a real directory`);
  }
  const resultsStat = await fs.lstat(resultsPath);
  if (!resultsStat.isFile() || resultsStat.isSymbolicLink()) {
    throw new Error(`job ${job.jobID} results are not a regular file`);
  }
  const [canonicalOutputDir, canonicalResultsPath, canonicalReplayPath] =
    await Promise.all([
      fs.realpath(job.outputDir),
      fs.realpath(resultsPath),
      fs.realpath(replayPath),
    ]);
  if (
    !pathIsWithin(canonicalOutputDir, canonicalResultsPath) ||
    !pathIsWithin(canonicalOutputDir, canonicalReplayPath)
  ) {
    throw new Error(
      `job ${job.jobID} completion artifacts escape the canonical output directory`,
    );
  }
  const [actualResultsHash, actualReplayHash] = await Promise.all([
    hashCouncilArtifact(resultsPath),
    hashCouncilArtifact(replayPath),
  ]);
  if (
    actualResultsHash !== resultsSha256 ||
    actualReplayHash !== replaySha256
  ) {
    throw new Error(`job ${job.jobID} completion artifact hash is invalid`);
  }
  return { resultsPath, replayPath };
}

async function validateCouncilMaterializedManifest(
  plan: CouncilPlan,
): Promise<void> {
  const manifest = await readBoundedJson(
    plan.materializedManifestPath,
    `${plan.sourcePath} materialized manifest`,
  );
  if (councilCanonicalSha256(manifest) !== plan.manifestSha256) {
    throw new Error(`${plan.sourcePath} materialized manifest hash is invalid`);
  }
  const manifestRecord = asRecord(manifest);
  const game = asRecord(manifestRecord?.game);
  const runnable = asRecord(game?.runnable);
  if (runnable?.image !== plan.gameImage.reference) {
    throw new Error(
      `${plan.sourcePath} materialized manifest game image is inconsistent`,
    );
  }
}

async function validateCouncilRealDirectory(
  directory: string,
  expectedRealPath: string,
  context: string,
): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${context} must be a real directory`);
  }
  const realPath = await fs.realpath(directory);
  if (path.resolve(realPath) !== path.resolve(expectedRealPath)) {
    throw new Error(`${context} escapes the materialized plan root`);
  }
}

async function validateCouncilPlanFilesystem(plan: CouncilPlan): Promise<void> {
  const root = path.dirname(plan.sourcePath);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`${plan.sourcePath} plan root must be a real directory`);
  }
  const realRoot = await fs.realpath(root);
  await validateCouncilRealDirectory(
    path.join(root, "payload"),
    path.join(realRoot, "payload"),
    `${plan.sourcePath} plan payload`,
  );
  await validateCouncilRealDirectory(
    path.join(root, "payload", "jobs"),
    path.join(realRoot, "payload", "jobs"),
    `${plan.sourcePath} plan jobs`,
  );
  for (const job of plan.jobs) {
    await validateCouncilRealDirectory(
      path.dirname(job.requestPath),
      path.join(realRoot, "payload", "jobs", job.jobID),
      `job ${job.jobID} root`,
    );
  }
}

export async function loadCouncilEvaluationPlans(
  planPaths: readonly string[],
): Promise<LoadedCouncilEvaluationPlans | undefined> {
  if (planPaths.length === 0) {
    return undefined;
  }
  const plans = await Promise.all(
    planPaths.map(async (planPath) =>
      parseCouncilPlan(
        await readBoundedJson(planPath, `${planPath} council plan`),
        planPath,
      ),
    ),
  );
  await Promise.all(plans.map(validateCouncilPlanFilesystem));
  await Promise.all(plans.map(validateCouncilMaterializedManifest));
  const allJobs = plans.flatMap((plan) => plan.jobs);
  const allBlocks = plans.flatMap((plan) =>
    plan.blocks.map(
      (block): CoworldCouncilEvaluationPlanBlockEvidence => ({
        matrixID: plan.matrixID,
        blockID: block.blockID,
        pairID: block.pairID,
        jobIDs: plan.jobs
          .filter((job) => job.blockID === block.blockID)
          .sort((left, right) => left.blockOrder - right.blockOrder)
          .map((job) => job.jobID),
      }),
    ),
  );
  if (
    new Set(plans.map((plan) => plan.matrixID)).size !== plans.length ||
    new Set(allJobs.map((job) => job.jobID)).size !== allJobs.length ||
    new Set(allBlocks.map((block) => block.blockID)).size !== allBlocks.length
  ) {
    throw new Error(
      "Council evaluation plans repeat matrix, block, or job IDs",
    );
  }
  const evidenceJobs: CoworldCouncilEvaluationPlanJobEvidence[] = allJobs.map(
    (job) => ({
      assignment: councilAssignment(job),
      status: "missing",
      invalidReason: null,
      episodeId: null,
    }),
  );
  const evidenceByJob = new Map(
    evidenceJobs.map((job) => [job.assignment.jobID, job] as const),
  );
  const completedJobs: CompletedCouncilPlanJob[] = [];
  for (const job of allJobs) {
    const evidence = evidenceByJob.get(job.jobID)!;
    try {
      await fs.stat(job.completionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      evidence.status = "invalid";
      evidence.invalidReason =
        error instanceof Error ? error.message : String(error);
      continue;
    }
    try {
      const completion = await validateCouncilCompletion(job);
      completedJobs.push({ evidence, outputDir: job.outputDir, ...completion });
    } catch (error) {
      evidence.status = "invalid";
      evidence.invalidReason =
        error instanceof Error ? error.message : String(error);
    }
  }
  return {
    evidence: {
      planPaths: plans.map((plan) => plan.sourcePath),
      blocks: allBlocks,
      jobs: evidenceJobs,
    },
    completedJobs,
    plannedJobRoots: allJobs.map((job) => path.dirname(job.requestPath)),
  };
}

export function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export async function joinCouncilEvaluationPlans(
  episodes: CoworldEvaluationEpisode[],
  loaded: LoadedCouncilEvaluationPlans | undefined,
): Promise<void> {
  if (loaded === undefined) {
    return;
  }
  const episodeSources = new Map<CoworldEvaluationEpisode, string[]>();
  for (const episode of episodes) {
    episodeSources.set(
      episode,
      await Promise.all(
        episode.sourcePaths.map((sourcePath) => fs.realpath(sourcePath)),
      ),
    );
  }
  for (const completed of loaded.completedJobs) {
    if (completed.evidence.status === "invalid") {
      continue;
    }
    let outputRoot: string;
    let resultsPath: string;
    let replayPath: string;
    try {
      [outputRoot, resultsPath, replayPath] = await Promise.all([
        fs.realpath(completed.outputDir),
        fs.realpath(completed.resultsPath),
        fs.realpath(completed.replayPath),
      ]);
    } catch (error) {
      completed.evidence.status = "invalid";
      completed.evidence.invalidReason =
        error instanceof Error ? error.message : String(error);
      continue;
    }
    if (
      !pathIsWithin(outputRoot, resultsPath) ||
      !pathIsWithin(outputRoot, replayPath)
    ) {
      completed.evidence.status = "invalid";
      completed.evidence.invalidReason =
        "completion artifacts escape the canonical job output directory";
      continue;
    }
    const matches = episodes.filter((episode) =>
      (episodeSources.get(episode) ?? []).some((sourcePath) =>
        pathIsWithin(outputRoot, sourcePath),
      ),
    );
    if (matches.length !== 1) {
      completed.evidence.status = "invalid";
      completed.evidence.invalidReason =
        "completed artifacts did not join to exactly one episode";
      continue;
    }
    const episode = matches[0];
    const assignment = completed.evidence.assignment;
    if (
      episode.map !== assignment.map ||
      assignment.candidateSeat >= episode.scores.length ||
      (episode.councilEvaluation !== undefined &&
        episode.councilEvaluation !== null)
    ) {
      completed.evidence.status = "invalid";
      completed.evidence.invalidReason =
        "joined episode identity differs from the planned job";
      continue;
    }
    episode.councilEvaluation = assignment;
    completed.evidence.status = "joined";
    completed.evidence.episodeId = episode.episodeId;
  }
}
