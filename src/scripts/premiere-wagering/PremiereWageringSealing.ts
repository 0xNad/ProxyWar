/**
 * Core sealing orchestration: reads a local bundle, classifies its
 * provenance, checks whether it has already been premiered, computes
 * spawn-aware checkpoints, and writes the sealed-candidate manifest.
 *
 * "Sealed" here means exactly: this file exists, records the bundle's
 * content hashes and the two checkpoint turns, and — load-bearing — the
 * manifest is written NEXT TO the bundle, never into
 * `artifacts/ai-league-runs/league-*` or any other path
 * `isProxyWarPublicLeaguePath`/the mirror would serve. It does not itself
 * make anything private; it records a verdict about whether the bundle
 * already IS private (see `PremiereWageringProvenance.ts`) and refuses to
 * claim sealed status for a bundle that isn't.
 */
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  ReplayPremiereArchiveStore,
  type PremiereArchivePointerV1,
} from "../../server/replay-premiere/ReplayPremiereArchiveIndex";
import { publicRunKeyForSourceRunId } from "../../server/replay-premiere/ReplayPremiereLoopCore";
import { resolveReplayPremierePrivateStateRoot } from "../../server/replay-premiere/ReplayPremiereSecrets";
import {
  checkpointTurnsForEpisode,
  naiveTurnZeroCheckpoints,
  spawnPhaseTurnCount,
} from "./PremiereWageringCheckpoints";
import {
  classifyPremiereWageringProvenance,
  type PremiereWageringSource,
} from "./PremiereWageringProvenance";
import {
  readPremiereWageringBundle,
  type PremiereWageringBundleFacts,
} from "./PremiereWageringBundle";

export const PREMIERE_WAGERING_SEALED_MANIFEST_FILE =
  "premiere-wagering.sealed.json";
const SEALED_MANIFEST_SCHEMA_VERSION = 1 as const;

export class PremiereWageringSealingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PremiereWageringSealingError";
  }
}

export interface PremiereWageringSealedManifest {
  readonly schemaVersion: typeof SEALED_MANIFEST_SCHEMA_VERSION;
  readonly sealedAt: string;
  readonly bundleDirName: string;
  readonly runId: string;
  readonly map: string;
  readonly seatCount: number;
  readonly turnCount: number;
  readonly gameType: string;
  readonly randomSpawn: boolean;
  readonly spawnPhaseTurns: number;
  readonly checkpointTurns: readonly [number, number];
  /** Reported for audit only — production placement always uses `checkpointTurns` above. */
  readonly naiveCheckpointTurnsForComparison: readonly [number, number];
  readonly fileHashes: Readonly<Record<string, string>>;
  readonly provenance: {
    readonly source: PremiereWageringSource;
    readonly reason: string;
  };
  readonly alreadyPremiered: boolean;
  readonly sealed: boolean;
}

async function findExistingPremiereForRun(
  runId: string,
  privateStateRoot: string,
): Promise<PremiereArchivePointerV1 | null> {
  const archiveRoot = path.join(path.resolve(privateStateRoot), "archive-v1");
  try {
    await fs.access(archiveRoot, fsConstants.F_OK);
  } catch {
    // No archive on this machine yet — nothing has ever been premiered.
    // Fail open to "not yet premiered", matching this codebase's convention
    // for "missing state file" everywhere else (suppression contract,
    // archive index, latest-premiere pointer all do the same).
    return null;
  }
  const store = await ReplayPremiereArchiveStore.open({
    privateStateRoot,
    compactOnOpen: false,
  });
  const runKey = publicRunKeyForSourceRunId(runId);
  const matches = store.revealPublicRatedCoworldPointersForRunKey(runKey);
  return matches[0] ?? null;
}

export interface SealPremiereWageringEpisodeOptions {
  readonly bundleDir: string;
  readonly declaredSource?: PremiereWageringSource;
  readonly forceUnsafeSeal?: boolean;
  readonly privateStateRoot?: string;
  readonly skipAlreadyPremieredCheck?: boolean;
  readonly now?: () => Date;
}

export interface SealPremiereWageringEpisodeResult {
  readonly manifest: PremiereWageringSealedManifest;
  readonly manifestPath: string;
  readonly bundle: PremiereWageringBundleFacts;
}

/**
 * Seals one local bundle. Always computes and reports checkpoints and the
 * provenance verdict; only WRITES the manifest (and only ever marks
 * `sealed: true`) when the provenance is sealable and the run hasn't already
 * been premiered — `forceUnsafeSeal` overrides the provenance refusal for
 * explicit, logged test/dev use but the manifest still records the true
 * verdict, never a laundered one.
 */
export async function sealPremiereWageringEpisode(
  options: SealPremiereWageringEpisodeOptions,
): Promise<SealPremiereWageringEpisodeResult> {
  const bundle = await readPremiereWageringBundle(options.bundleDir);
  const provenance = classifyPremiereWageringProvenance({
    bundleDirName: bundle.bundleDirName,
    declaredSource: options.declaredSource,
  });
  const privateStateRoot =
    options.privateStateRoot ?? resolveReplayPremierePrivateStateRoot();
  const existingPremiere = options.skipAlreadyPremieredCheck
    ? null
    : await findExistingPremiereForRun(bundle.runId, privateStateRoot);
  const checkpointTurns = checkpointTurnsForEpisode({
    turnCount: bundle.turnCount,
    spawn: { gameType: bundle.gameType, randomSpawn: bundle.randomSpawn },
  });
  const spawnPhaseTurns = spawnPhaseTurnCount({
    gameType: bundle.gameType,
    randomSpawn: bundle.randomSpawn,
  });
  const sealed =
    existingPremiere === null &&
    (provenance.sealable || options.forceUnsafeSeal === true);
  const now = options.now?.() ?? new Date();
  const manifest: PremiereWageringSealedManifest = {
    schemaVersion: SEALED_MANIFEST_SCHEMA_VERSION,
    sealedAt: now.toISOString(),
    bundleDirName: bundle.bundleDirName,
    runId: bundle.runId,
    map: bundle.map,
    seatCount: bundle.seatCount,
    turnCount: bundle.turnCount,
    gameType: bundle.gameType,
    randomSpawn: bundle.randomSpawn,
    spawnPhaseTurns,
    checkpointTurns,
    naiveCheckpointTurnsForComparison: naiveTurnZeroCheckpoints(
      bundle.turnCount,
    ),
    fileHashes: bundle.fileHashes,
    provenance: { source: provenance.source, reason: provenance.reason },
    alreadyPremiered: existingPremiere !== null,
    sealed,
  };
  if (!sealed) {
    const why =
      existingPremiere !== null
        ? `already premiered as ${existingPremiere.premiereId}`
        : provenance.reason;
    throw new PremiereWageringSealingError(
      "premiere_wagering_seal_refused",
      `refusing to mark ${bundle.bundleDirName} sealed: ${why}`,
    );
  }
  const manifestPath = path.join(
    bundle.bundleDir,
    PREMIERE_WAGERING_SEALED_MANIFEST_FILE,
  );
  await writeManifestExclusive(manifestPath, manifest);
  return { manifest, manifestPath, bundle };
}

async function writeManifestExclusive(
  filePath: string,
  manifest: PremiereWageringSealedManifest,
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new PremiereWageringSealingError(
      "premiere_wagering_manifest_exists",
      `${filePath} already exists — a bundle is sealed exactly once; delete the manifest first if this is intentional`,
    );
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
