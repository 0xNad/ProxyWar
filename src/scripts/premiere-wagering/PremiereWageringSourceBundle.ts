/**
 * Converts one SEALED xp-request premiere-wagering bundle
 * (`decisions.jsonl`/`game-record.json`/`match-summary.json`/
 * `spectator-replay.json` + `xp-request-roster.json` +
 * `premiere-wagering.sealed.json`) into the exact `proxywar_rated_coworld_source`
 * bundle shape `replay-premiere-admit.ts` already accepts — the same bundle
 * `replay-premiere-ingest-coworld.ts` builds for PUBLIC league rounds, just
 * sourced from a private xp-request instead of `coworld episode-results`/
 * `coworld divisions`.
 *
 * WHY A SEPARATE CONVERTER, NOT A REUSE OF `replay-premiere-ingest-coworld.ts`:
 * that script's cross-checks (`--episode-file=`/`--division-file=`/
 * `--division-id=`) are built for a PUBLIC league round's episode/division
 * metadata, fetched via a second read-only Coworld call after the fact. An
 * xp-request has no round and no public episode listing to cross-check
 * against (`docs/project-state/softmax-platform-feedback.md` item 26); the
 * only trustworthy source for "who was in which seat" is the roster THIS
 * repo itself submitted when creating the request
 * (`xp-request-roster.json`, written by `generate-xp-request-episode.ts` in
 * the exact slot order sent to Coworld) — not a second network round-trip.
 *
 * Requires `premiere-wagering.sealed.json` to already report `sealed: true`
 * (see `seal-episode.ts`) — this converter refuses to produce an admissible
 * bundle from a run whose provenance wasn't verified private, so a caller
 * can't skip the seal gate by jumping straight from `generate` to here.
 */
import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { GameRecordSchema } from "../../core/Schemas";
import {
  canonicalReplayPremiereJson,
  sha256Hex,
  assertReplayPremiereJsonValue,
  type ReplayPremiereJsonValue,
} from "../../server/replay-premiere/ReplayPremiereIntegrity";
import type {
  CoworldPremiereSourceIds,
  PremiereSeatIdentity,
} from "../../server/replay-premiere/ReplayPremiereContracts";
import { PREMIERE_WAGERING_SEALED_MANIFEST_FILE } from "./PremiereWageringSealing";
import type { ActiveRosterSeat } from "./PremiereWageringRoster";

export class PremiereWageringSourceBundleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PremiereWageringSourceBundleError";
  }
}

const RATED_BUNDLE_KIND = "proxywar_rated_coworld_source";
const MAX_GAME_RECORD_BYTES = 512 * 1024 * 1024;
export const XP_REQUEST_ROSTER_FILE = "xp-request-roster.json";

export interface XpRequestRosterFile {
  readonly schemaVersion: 1;
  readonly leagueId: string;
  readonly divisionId: string;
  readonly experienceRequestId: string;
  readonly episodeRequestId: string;
  readonly episodeId: string;
  readonly coworldId: string;
  readonly coworldName: string;
  readonly coworldVersion: string;
  readonly variantName: string;
  readonly replayUrl: string;
  readonly requesterUserId: string;
  readonly winnerSlot: number | null;
  readonly map: string | null;
  readonly mapSize: string | null;
  readonly turnCount: number | null;
  readonly decisionCount: number | null;
  readonly degradedCount: number | null;
  readonly seats: readonly ActiveRosterSeat[];
}

export interface BuildRatedPremiereSourceBundleResult {
  readonly outFile: string;
  readonly bundleSha256: string;
  readonly bundleByteLength: number;
  readonly sourceRunId: string;
  readonly turnCount: number;
  readonly seatCount: number;
  readonly checkpointTurns: readonly [number, number];
  readonly seats: readonly PremiereSeatIdentity[];
}

export async function buildRatedPremiereSourceBundle(options: {
  readonly bundleDir: string;
  readonly turnIntervalMs: number;
  readonly outFile?: string;
  readonly now?: () => Date;
}): Promise<BuildRatedPremiereSourceBundleResult> {
  const bundleDir = path.resolve(options.bundleDir);
  const now = options.now?.() ?? new Date();

  const sealedManifest = await readSealedManifest(bundleDir);
  if (!sealedManifest.sealed) {
    throw new PremiereWageringSourceBundleError(
      "premiere_wagering_source_not_sealed",
      `${bundleDir} is not sealed (${PREMIERE_WAGERING_SEALED_MANIFEST_FILE}.sealed !== true) — run premiere-wagering:seal first`,
    );
  }
  const rosterFile = await readRosterFile(bundleDir);
  const gameRecordBytes = await readBoundedFile(
    path.join(bundleDir, "game-record.json"),
    MAX_GAME_RECORD_BYTES,
  );
  let gameRecordRaw: unknown;
  try {
    gameRecordRaw = JSON.parse(gameRecordBytes.toString("utf8"));
  } catch {
    throw new PremiereWageringSourceBundleError(
      "premiere_wagering_source_game_record_invalid",
      "game-record.json is not valid JSON",
    );
  }
  const parsedGameRecord = GameRecordSchema.strict().safeParse(gameRecordRaw);
  if (!parsedGameRecord.success) {
    throw new PremiereWageringSourceBundleError(
      "premiere_wagering_source_game_record_invalid",
      `game-record.json does not match GameRecordSchema: ${parsedGameRecord.error.message}`,
    );
  }
  const info = parsedGameRecord.data.info;
  if (info.players.length !== rosterFile.seats.length) {
    throw new PremiereWageringSourceBundleError(
      "premiere_wagering_source_seat_count_mismatch",
      `game-record.json has ${info.players.length} players but ${XP_REQUEST_ROSTER_FILE} recorded ${rosterFile.seats.length} seats`,
    );
  }

  const winnerClientID =
    rosterFile.winnerSlot === null
      ? null
      : (info.players[rosterFile.winnerSlot]?.clientID ?? null);

  // `displayName` MUST equal the game record's own `player.username` for
  // that seat, verbatim — `ReplayPremierePublication.ts`'s
  // `validateControlledSourceSeats` binds them exactly
  // (`controlled_source_seat_player_binding_mismatch` otherwise). The real
  // Coworld game record already carries the true league player name here
  // (verified against a real xp-request download); the roster sidecar is
  // authoritative for `policyIdentity` (policyVersionId/policyLabel), not
  // for display name.
  const seats: PremiereSeatIdentity[] = info.players.map((player, index) => {
    const rosterSeat = rosterFile.seats[index]!;
    const versionMatch = /:v(\d+)$/.exec(rosterSeat.policyLabel);
    return {
      seatId: player.clientID,
      displayName: player.username,
      policyIdentity: {
        namespace: "softmax_policy_version",
        policyVersionId: rosterSeat.policyVersionId,
        policyName: rosterSeat.policyLabel,
        serverAssignedVersion: versionMatch ? `v${versionMatch[1]}` : "v0",
      },
    };
  });

  const completedAt = new Date(info.end).toISOString();
  const startedAt = new Date(info.start).toISOString();
  const authoritativeResultValue: ReplayPremiereJsonValue = {
    schemaVersion: 1,
    sourceKind: "coworld_result",
    sourceRunId: sealedManifest.runId,
    sourceId: rosterFile.episodeRequestId,
    gameId: info.gameID,
    completedAt,
    turnCount: info.num_turns,
    winner: winnerClientID === null ? null : ["player", winnerClientID],
    seats: seats.map((seat) => ({
      seatId: seat.seatId,
      displayName: seat.displayName,
      won: seat.seatId === winnerClientID,
    })),
  };
  const resultBytes = Buffer.from(
    canonicalReplayPremiereJson(authoritativeResultValue),
    "utf8",
  );

  const bundleGameRecord = {
    ...parsedGameRecord.data,
    info: {
      ...info,
      ...(winnerClientID === null ? {} : { winner: ["player", winnerClientID] }),
    },
  };

  const coworld: CoworldPremiereSourceIds = {
    episodeId: rosterFile.episodeId,
    leagueId: rosterFile.leagueId,
    divisionId: rosterFile.divisionId,
    // xp-requests are not part of a public league round — the
    // experience-request id is the closest stable identifier and is
    // recorded here rather than fabricating a fake round id.
    roundId: rosterFile.experienceRequestId,
  };

  const bundle: ReplayPremiereJsonValue = {
    schemaVersion: 1,
    bundleKind: RATED_BUNDLE_KIND,
    sourceRunId: sealedManifest.runId,
    createdAt: now.toISOString(),
    gameRecord: toJsonValue(bundleGameRecord, "source bundle game record"),
    replay: { turnCount: info.num_turns, turnIntervalMs: options.turnIntervalMs },
    authoritativeResult: {
      sourceId: rosterFile.episodeRequestId,
      encoding: "base64",
      bytes: resultBytes.toString("base64"),
      sha256: sha256Hex(resultBytes),
    },
    seats: toJsonValue(seats, "source bundle seats"),
    coworld: { ...coworld },
    provenance: {
      // Literal required verbatim by `ReplayPremierePublication.ts`'s
      // `validateRatedCoworldProvenance` — this bundle follows the exact
      // same rated-coworld provenance CONTRACT as
      // `replay-premiere-ingest-coworld.ts`, just sourced from a private
      // xp-request instead of a public league round.
      generator: "replay-premiere-rated-coworld-ingest/v1",
      observatory: {
        episodeRequestId: rosterFile.episodeRequestId,
        episodeId: rosterFile.episodeId,
        roundId: rosterFile.experienceRequestId,
        leagueId: rosterFile.leagueId,
        divisionId: rosterFile.divisionId,
        coworldId: rosterFile.coworldId,
        coworldName: rosterFile.coworldName,
        coworldVersion: rosterFile.coworldVersion,
        variantName: rosterFile.variantName,
        replayUrl: rosterFile.replayUrl,
        requesterUserId: rosterFile.requesterUserId,
        episodeCreatedAt: sealedManifest.sealedAt,
        episodeCompletedAt: completedAt,
      },
      rawReplay: {
        sha256: sealedManifest.fileHashes["game-record.json"] ?? "",
        byteLength: gameRecordBytes.byteLength,
        replayKind: "proxywar-coworld-local-poc",
        runId: sealedManifest.runId,
      },
      participants: seats.map((seat, index) => ({
        position: index,
        label: rosterFile.seats[index]!.policyLabel,
        playerId: rosterFile.seats[index]!.playerId,
        playerName: rosterFile.seats[index]!.playerName,
      })),
      game: {
        gameId: info.gameID,
        startedAt,
        completedAt,
        turnCount: info.num_turns,
        map: rosterFile.map ?? String(info.config.gameMap),
        mapSize: rosterFile.mapSize ?? String(info.config.gameMapSize),
        mode: String(info.config.gameMode),
        gameType: String(info.config.gameType),
      },
      build: {
        generatorSha256: sealedManifest.fileHashes["game-record.json"] ?? "",
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
    },
  };
  const bundleBytes = Buffer.from(canonicalReplayPremiereJson(bundle), "utf8");
  const outFile =
    options.outFile ?? path.join(bundleDir, `${sealedManifest.runId}.source.json`);
  await writeExclusive(outFile, bundleBytes);
  return {
    outFile,
    bundleSha256: sha256Hex(bundleBytes),
    bundleByteLength: bundleBytes.byteLength,
    sourceRunId: sealedManifest.runId,
    turnCount: info.num_turns,
    seatCount: seats.length,
    checkpointTurns: sealedManifest.checkpointTurns,
    seats,
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

interface SealedManifestFacts {
  readonly runId: string;
  readonly sealed: boolean;
  readonly sealedAt: string;
  readonly checkpointTurns: readonly [number, number];
  readonly fileHashes: Readonly<Record<string, string>>;
}

async function readSealedManifest(bundleDir: string): Promise<SealedManifestFacts> {
  const filePath = path.join(bundleDir, PREMIERE_WAGERING_SEALED_MANIFEST_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new PremiereWageringSourceBundleError(
      "premiere_wagering_source_sealed_manifest_missing",
      `${filePath} is missing or not valid JSON — run premiere-wagering:seal first`,
    );
  }
  if (
    !isRecord(raw) ||
    asString(raw.runId) === null ||
    typeof raw.sealed !== "boolean" ||
    typeof raw.sealedAt !== "string" ||
    !Array.isArray(raw.checkpointTurns) ||
    raw.checkpointTurns.length !== 2 ||
    !isRecord(raw.fileHashes)
  ) {
    throw new PremiereWageringSourceBundleError(
      "premiere_wagering_source_sealed_manifest_invalid",
      `${filePath} does not look like a sealed manifest`,
    );
  }
  const [checkpointA, checkpointB] = raw.checkpointTurns;
  const checkpointNumberA = asNumber(checkpointA);
  const checkpointNumberB = asNumber(checkpointB);
  if (checkpointNumberA === null || checkpointNumberB === null) {
    throw new PremiereWageringSourceBundleError(
      "premiere_wagering_source_sealed_manifest_invalid",
      `${filePath}.checkpointTurns must be two numbers`,
    );
  }
  const fileHashes: Record<string, string> = {};
  for (const [name, hash] of Object.entries(raw.fileHashes)) {
    const hashString = asString(hash);
    if (hashString === null) {
      throw new PremiereWageringSourceBundleError(
        "premiere_wagering_source_sealed_manifest_invalid",
        `${filePath}.fileHashes.${name} must be a string`,
      );
    }
    fileHashes[name] = hashString;
  }
  if (!raw.sealed) {
    throw new PremiereWageringSourceBundleError(
      "premiere_wagering_source_not_sealed",
      `${filePath}.sealed !== true — run premiere-wagering:seal first`,
    );
  }
  return {
    runId: asString(raw.runId)!,
    sealed: raw.sealed,
    sealedAt: raw.sealedAt,
    checkpointTurns: [checkpointNumberA, checkpointNumberB],
    fileHashes,
  };
}

function parseRosterSeat(value: unknown): ActiveRosterSeat {
  if (
    !isRecord(value) ||
    asString(value.policyVersionId) === null ||
    asString(value.policyLabel) === null ||
    asString(value.playerId) === null ||
    (value.playerName !== null && asString(value.playerName) === null)
  ) {
    throw new PremiereWageringSourceBundleError(
      "premiere_wagering_source_roster_invalid",
      `${XP_REQUEST_ROSTER_FILE} has a malformed roster seat`,
    );
  }
  return {
    policyVersionId: asString(value.policyVersionId)!,
    policyLabel: asString(value.policyLabel)!,
    playerId: asString(value.playerId)!,
    playerName: value.playerName === null ? null : asString(value.playerName),
  };
}

async function readRosterFile(bundleDir: string): Promise<XpRequestRosterFile> {
  const filePath = path.join(bundleDir, XP_REQUEST_ROSTER_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    throw new PremiereWageringSourceBundleError(
      "premiere_wagering_source_roster_missing",
      `${filePath} is missing or not valid JSON — only bundles written by generate-xp-request-episode.ts carry this sidecar`,
    );
  }
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.seats) ||
    raw.seats.length === 0 ||
    asString(raw.leagueId) === null ||
    asString(raw.divisionId) === null ||
    asString(raw.experienceRequestId) === null ||
    asString(raw.episodeRequestId) === null ||
    asString(raw.episodeId) === null ||
    asString(raw.coworldId) === null ||
    asString(raw.coworldName) === null ||
    asString(raw.coworldVersion) === null ||
    asString(raw.variantName) === null ||
    asString(raw.replayUrl) === null ||
    asString(raw.requesterUserId) === null
  ) {
    throw new PremiereWageringSourceBundleError(
      "premiere_wagering_source_roster_invalid",
      `${filePath} does not look like a roster sidecar`,
    );
  }
  return {
    schemaVersion: 1,
    leagueId: asString(raw.leagueId)!,
    divisionId: asString(raw.divisionId)!,
    experienceRequestId: asString(raw.experienceRequestId)!,
    episodeRequestId: asString(raw.episodeRequestId)!,
    episodeId: asString(raw.episodeId)!,
    coworldId: asString(raw.coworldId)!,
    coworldName: asString(raw.coworldName)!,
    coworldVersion: asString(raw.coworldVersion)!,
    variantName: asString(raw.variantName)!,
    replayUrl: asString(raw.replayUrl)!,
    requesterUserId: asString(raw.requesterUserId)!,
    winnerSlot: asNumber(raw.winnerSlot),
    map: asString(raw.map),
    mapSize: asString(raw.mapSize),
    turnCount: asNumber(raw.turnCount),
    decisionCount: asNumber(raw.decisionCount),
    degradedCount: asNumber(raw.degradedCount),
    seats: raw.seats.map(parseRosterSeat),
  };
}

async function readBoundedFile(
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await fs.open(filePath, "r").catch(() => {
    throw new PremiereWageringSourceBundleError(
      "premiere_wagering_source_file_missing",
      `${filePath} is missing`,
    );
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new PremiereWageringSourceBundleError(
        "premiere_wagering_source_file_invalid",
        `${filePath} is not a regular file within the ${maxBytes}-byte bound`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writeExclusive(filePath: string, bytes: Buffer): Promise<void> {
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
    throw new PremiereWageringSourceBundleError(
      "premiere_wagering_source_out_file_exists",
      `${filePath} already exists — refusing to overwrite`,
    );
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function toJsonValue(value: unknown, source: string): ReplayPremiereJsonValue {
  const serialized: unknown = JSON.parse(JSON.stringify(value));
  assertReplayPremiereJsonValue(serialized, source);
  return serialized;
}
