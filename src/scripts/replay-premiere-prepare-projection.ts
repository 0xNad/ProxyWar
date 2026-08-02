import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS,
  ReplayPremiereAdmissionCatalog,
} from "../server/replay-premiere/ReplayPremiereCatalog";
import {
  DeterministicReplayPremiereCheckpointProjector,
  type ReplayPremiereCheckpointProjector,
} from "../server/replay-premiere/ReplayPremiereCheckpointProjection";
import {
  rebuildReplayPremiereProjectionInput,
  type ReplayPremiereCheckpointProjectionPublicationFaultInjector,
} from "../server/replay-premiere/ReplayPremiereCheckpointProjectionStore";
import { isPremiereId } from "../server/replay-premiere/ReplayPremiereContracts";
import { ReplayPremiereError } from "../server/replay-premiere/ReplayPremiereErrors";
import { configuredReplayPremiereDeploymentOrigin } from "./replay-premiere-admit";

const REQUIRED_ARGUMENT_PREFIXES = [
  "--premiere-id=",
  "--private-state-root=",
  "--deployment-origin=",
] as const;
const REPEATED_ARGUMENT_PREFIX = "--served-root=";
export const REPLAY_PREMIERE_PROJECTION_PREPARATION_TIMEOUT_MS = 90_000;

interface ReplayPremiereProjectionPreparationOptions {
  premiereId: string;
  privateStateRoot: string;
  servedRoots: string[];
  deploymentOrigin: string;
}

export interface ReplayPremiereProjectionPreparationDependencies {
  environment?: Record<string, string | undefined>;
  checkpointProjector?: ReplayPremiereCheckpointProjector;
  /** Test-only override; production always uses the fixed exported ceiling. */
  projectionTimeoutMs?: number;
  /** Test-only artifact-publication durability seam. */
  checkpointProjectionPublicationFaultInjector?: ReplayPremiereCheckpointProjectionPublicationFaultInjector;
}

export interface ReplayPremiereProjectionPreparationSummary {
  premiereId: string;
  admissionRecordHash: string;
  sourceReplaySha256: string;
  publicationCommitmentHash: string;
  projectionArtifactHash: string;
  reused: boolean;
}

export async function prepareReplayPremiereCheckpointProjection(
  args: string[],
  dependencies: ReplayPremiereProjectionPreparationDependencies = {},
): Promise<ReplayPremiereProjectionPreparationSummary> {
  const options = parseArguments(args);
  const configuredOrigin = configuredReplayPremiereDeploymentOrigin(
    dependencies.environment ?? process.env,
  );
  if (configuredOrigin !== options.deploymentOrigin) {
    throw preparationFailure("projection_preparation_origin_mismatch");
  }
  const catalog = await ReplayPremiereAdmissionCatalog.open({
    privateStateRoot: options.privateStateRoot,
    servedRoots: options.servedRoots,
    writerWaitMs: 1_000,
    checkpointProjectionPublicationFaultInjector:
      dependencies.checkpointProjectionPublicationFaultInjector,
  });
  try {
    const read = await catalog.readAll();
    if (read.failures.length > 0) {
      throw preparationFailure("projection_preparation_catalog_not_clean");
    }
    const record = read.entries.find(
      (entry) => entry.premiereId === options.premiereId,
    );
    if (record === undefined) {
      throw preparationFailure("projection_preparation_admission_not_found");
    }
    const rebuilt = await rebuildReplayPremiereProjectionInput({
      record,
      privateStateRoot: catalog.privateStateRoot,
      servedRoots: options.servedRoots,
      maxSourceBytes: DEFAULT_REPLAY_PREMIERE_CATALOG_LIMITS.maxSourceBytes,
      publicOrigin: configuredOrigin,
    });
    const existing = await catalog.loadCheckpointProjection({
      record,
      gate: rebuilt.gate,
    });
    if (existing !== null) {
      return summary(record, existing.artifactHash, true);
    }
    // Projection can take tens of seconds on a real replay. Release the
    // canonical catalog lock before computation; the immutable record/gate is
    // revalidated when publishCheckpointProjection reacquires it.
    await catalog.close();
    const projector =
      dependencies.checkpointProjector ??
      new DeterministicReplayPremiereCheckpointProjector(
        path.join(process.cwd(), "resources", "maps"),
      );
    const projection = await projectBeforePreparationDeadline({
      projector,
      gate: rebuilt.gate,
      drafts: rebuilt.drafts,
      timeoutMs:
        dependencies.projectionTimeoutMs ??
        REPLAY_PREMIERE_PROJECTION_PREPARATION_TIMEOUT_MS,
    });
    const artifact = await catalog.publishCheckpointProjection({
      record,
      gate: rebuilt.gate,
      projection,
    });
    return summary(record, artifact.artifactHash, false);
  } finally {
    await catalog.close();
  }
}

async function projectBeforePreparationDeadline(options: {
  projector: ReplayPremiereCheckpointProjector;
  gate: Parameters<ReplayPremiereCheckpointProjector["project"]>[0]["gate"];
  drafts: Parameters<ReplayPremiereCheckpointProjector["project"]>[0]["drafts"];
  timeoutMs: number;
}): Promise<Awaited<ReturnType<ReplayPremiereCheckpointProjector["project"]>>> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > REPLAY_PREMIERE_PROJECTION_PREPARATION_TIMEOUT_MS
  ) {
    throw preparationFailure("projection_preparation_timeout_invalid");
  }
  const controller = new AbortController();
  let deadlineExpired = false;
  let rejectDeadline: ((error: ReplayPremiereError) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort();
    rejectDeadline?.(
      preparationFailure("projection_preparation_deadline_exceeded"),
    );
  }, options.timeoutMs);
  timer.unref?.();
  const projection = options.projector.project({
    gate: options.gate,
    drafts: options.drafts,
    signal: controller.signal,
  });
  void projection.catch(() => undefined);
  try {
    return await Promise.race([projection, deadline]);
  } catch (error) {
    if (deadlineExpired) {
      throw preparationFailure("projection_preparation_deadline_exceeded");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function executeReplayPremiereProjectionPreparationCli(
  args: string[],
  dependencies: ReplayPremiereProjectionPreparationDependencies,
  io: { stdout(line: string): void; stderr(line: string): void },
): Promise<number> {
  try {
    const result = await prepareReplayPremiereCheckpointProjection(
      args,
      dependencies,
    );
    io.stdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    io.stderr(
      `REPLAY_PREMIERE_PROJECTION_PREPARATION_FAILED ${operatorCode(error)}\n`,
    );
    return 1;
  }
}

function parseArguments(
  args: string[],
): ReplayPremiereProjectionPreparationOptions {
  if (
    args.length === 0 ||
    args.some(
      (argument) =>
        !REQUIRED_ARGUMENT_PREFIXES.some((prefix) =>
          argument.startsWith(prefix),
        ) && !argument.startsWith(REPEATED_ARGUMENT_PREFIX),
    )
  ) {
    throw preparationFailure(
      "projection_preparation_unknown_or_missing_argument",
    );
  }
  const single = (prefix: string): string => {
    const values = args
      .filter((argument) => argument.startsWith(prefix))
      .map((argument) => argument.slice(prefix.length));
    if (values.length !== 1 || values[0].length === 0) {
      throw preparationFailure(
        "projection_preparation_argument_cardinality_invalid",
      );
    }
    return values[0];
  };
  const servedRoots = args
    .filter((argument) => argument.startsWith(REPEATED_ARGUMENT_PREFIX))
    .map((argument) => argument.slice(REPEATED_ARGUMENT_PREFIX.length));
  if (
    servedRoots.length === 0 ||
    servedRoots.some((root) => root.length === 0)
  ) {
    throw preparationFailure("projection_preparation_served_roots_invalid");
  }
  const premiereId = single("--premiere-id=");
  if (!isPremiereId(premiereId)) {
    throw preparationFailure("projection_preparation_premiere_id_invalid");
  }
  return {
    premiereId,
    privateStateRoot: single("--private-state-root="),
    servedRoots,
    deploymentOrigin: exactOrigin(single("--deployment-origin=")),
  };
}

function exactOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw preparationFailure("projection_preparation_origin_invalid");
  }
  if (
    url.origin !== value ||
    (url.protocol !== "https:" && url.protocol !== "http:")
  ) {
    throw preparationFailure("projection_preparation_origin_invalid");
  }
  return value;
}

function summary(
  record: {
    premiereId: string;
    recordHash: string;
    stagedSource: { sourceReplaySha256: string };
    expectedPublicationCommitmentHash: string;
  },
  projectionArtifactHash: string,
  reused: boolean,
): ReplayPremiereProjectionPreparationSummary {
  return {
    premiereId: record.premiereId,
    admissionRecordHash: record.recordHash,
    sourceReplaySha256: record.stagedSource.sourceReplaySha256,
    publicationCommitmentHash: record.expectedPublicationCommitmentHash,
    projectionArtifactHash,
    reused,
  };
}

function preparationFailure(operatorCode: string): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCode,
    "PREMIERE_INVALID_REQUEST",
    400,
    "Replay Premiere checkpoint projection preparation rejected the operation",
  );
}

function operatorCode(error: unknown): string {
  return error instanceof ReplayPremiereError
    ? error.operatorCode
    : "projection_preparation_unavailable";
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const exitCode = await executeReplayPremiereProjectionPreparationCli(
    process.argv.slice(2),
    {},
    {
      stdout: (line) => process.stdout.write(line),
      stderr: (line) => process.stderr.write(line),
    },
  );
  if (exitCode !== 0) process.exitCode = exitCode;
}
