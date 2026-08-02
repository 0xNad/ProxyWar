/**
 * Reads and validates a local Coworld episode run bundle — the
 * `artifacts/ai-league-runs/<runID>/` shape (`decisions.jsonl`,
 * `game-record.json`, `match-summary.json`, `spectator-replay.json`) that
 * both `coworld-league-mirror.ts` (public-league sync) and a future
 * xp-request-episode fetch write. This module is provenance-agnostic on
 * purpose — see `PremiereWageringProvenance.ts` for the safety
 * classification that decides whether a given bundle is allowed to be
 * marked "sealed".
 */
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { sha256Hex } from "../../server/replay-premiere/ReplayPremiereIntegrity";

export const PREMIERE_WAGERING_BUNDLE_FILES = [
  "decisions.jsonl",
  "game-record.json",
  "match-summary.json",
  "spectator-replay.json",
] as const;

const MAX_GAME_RECORD_BYTES = 512 * 1024 * 1024;
const MAX_MATCH_SUMMARY_BYTES = 16 * 1024 * 1024;

export class PremiereWageringBundleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PremiereWageringBundleError";
  }
}

export interface PremiereWageringBundleFacts {
  readonly bundleDir: string;
  readonly bundleDirName: string;
  /** `match-summary.json`'s `runID` — the same value bundle unpacking keys off. */
  readonly runId: string;
  readonly turnCount: number;
  readonly gameType: string;
  readonly randomSpawn: boolean;
  readonly map: string;
  readonly seatCount: number;
  /** `match-summary.json.roster[].agentID`, in seat order. */
  readonly seatAgentIds: readonly string[];
  /** sha256 of each required file, keyed by filename — for the sealed manifest. */
  readonly fileHashes: Readonly<Record<string, string>>;
}

async function readBoundedFile(
  filePath: string,
  maxBytes: number,
  code: string,
): Promise<Buffer> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    throw new PremiereWageringBundleError(
      code,
      `missing required bundle file: ${filePath}`,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new PremiereWageringBundleError(
      code,
      `not a regular file: ${filePath}`,
    );
  }
  if (stat.size > maxBytes) {
    throw new PremiereWageringBundleError(
      code,
      `${filePath} exceeds the ${maxBytes}-byte bound`,
    );
  }
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Validates the four required files exist and are regular files, hashes each
 * of them, and extracts the facts checkpoint placement + provenance
 * classification need. Throws loudly on anything short of a well-formed
 * bundle — a sealing tool that tolerates a malformed source is worse than one
 * that refuses to run.
 */
export async function readPremiereWageringBundle(
  bundleDir: string,
): Promise<PremiereWageringBundleFacts> {
  const resolvedDir = path.resolve(bundleDir);
  const decisionsBytes = await readBoundedFile(
    path.join(resolvedDir, "decisions.jsonl"),
    MAX_GAME_RECORD_BYTES,
    "premiere_wagering_bundle_file_invalid",
  );
  const gameRecordBytes = await readBoundedFile(
    path.join(resolvedDir, "game-record.json"),
    MAX_GAME_RECORD_BYTES,
    "premiere_wagering_bundle_file_invalid",
  );
  const matchSummaryBytes = await readBoundedFile(
    path.join(resolvedDir, "match-summary.json"),
    MAX_MATCH_SUMMARY_BYTES,
    "premiere_wagering_bundle_file_invalid",
  );
  const spectatorReplayBytes = await readBoundedFile(
    path.join(resolvedDir, "spectator-replay.json"),
    MAX_MATCH_SUMMARY_BYTES,
    "premiere_wagering_bundle_file_invalid",
  );
  const fileHashes: Record<string, string> = {
    "decisions.jsonl": sha256Hex(decisionsBytes),
    "game-record.json": sha256Hex(gameRecordBytes),
    "match-summary.json": sha256Hex(matchSummaryBytes),
    "spectator-replay.json": sha256Hex(spectatorReplayBytes),
  };
  let matchSummary: unknown;
  let gameRecord: unknown;
  try {
    matchSummary = JSON.parse(matchSummaryBytes!.toString("utf8"));
    gameRecord = JSON.parse(gameRecordBytes!.toString("utf8"));
  } catch {
    throw new PremiereWageringBundleError(
      "premiere_wagering_bundle_json_invalid",
      "match-summary.json or game-record.json is not valid JSON",
    );
  }
  if (!isRecord(matchSummary) || !isRecord(gameRecord)) {
    throw new PremiereWageringBundleError(
      "premiere_wagering_bundle_shape_invalid",
      "match-summary.json / game-record.json must be JSON objects",
    );
  }
  const runId = asString(matchSummary.runID);
  const roster = Array.isArray(matchSummary.roster) ? matchSummary.roster : null;
  const info = isRecord(gameRecord.info) ? gameRecord.info : null;
  const config = info !== null && isRecord(info.config) ? info.config : null;
  const turnCount = info !== null ? asNumber(info.num_turns) : null;
  const gameType = config !== null ? asString(config.gameType) : null;
  const randomSpawn = config !== null ? config.randomSpawn : undefined;
  const map = config !== null ? asString(config.gameMap) : null;
  if (
    runId === null ||
    roster === null ||
    turnCount === null ||
    gameType === null ||
    typeof randomSpawn !== "boolean" ||
    map === null
  ) {
    throw new PremiereWageringBundleError(
      "premiere_wagering_bundle_fields_missing",
      "bundle is missing one of: match-summary.runID/roster, game-record.info.num_turns/config.gameType/config.randomSpawn/config.gameMap",
    );
  }
  const seatAgentIds = roster.map((seat) =>
    isRecord(seat) ? (asString(seat.agentID) ?? "") : "",
  );
  return {
    bundleDir: resolvedDir,
    bundleDirName: path.basename(resolvedDir),
    runId,
    turnCount,
    gameType,
    randomSpawn,
    map,
    seatCount: seatAgentIds.length,
    seatAgentIds,
    fileHashes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
