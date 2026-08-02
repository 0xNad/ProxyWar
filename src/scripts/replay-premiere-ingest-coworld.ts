import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GameRecordSchema, TurnSchema, type GameRecord } from "../core/Schemas";
import {
  PREMIERE_REAL_TURN_INTERVAL_MS,
  type CoworldPremiereSourceIds,
  type PremiereSeatIdentity,
} from "../server/replay-premiere/ReplayPremiereContracts";
import { ReplayPremiereError } from "../server/replay-premiere/ReplayPremiereErrors";
import {
  assertReplayPremiereJsonValue,
  canonicalReplayPremiereJson,
  sha256Hex,
  type ReplayPremiereJsonValue,
} from "../server/replay-premiere/ReplayPremiereIntegrity";

/**
 * Converts one fetched Softmax Observatory league replay into the hash-bound
 * rated Coworld premiere source bundle consumed by `premiere:admit`.
 *
 * Read-only toward Softmax: this command only consumes files the operator
 * already fetched (`coworld replays --json`, `coworld divisions --json`, and
 * the replay object itself). It never uploads, submits, or mutates anything
 * hosted. It writes exactly one new local bundle file (plus optional admission
 * input templates) and refuses to overwrite existing files.
 *
 * Every downstream fact is re-derived and re-verified from the bundle bytes by
 * the admission command and again at server startup; this converter is the
 * single place where the raw Observatory replay and episode metadata are
 * cross-checked against each other before they become one bundle.
 */

const MIB = 1024 * 1024;
const MAX_RAW_REPLAY_BYTES = 256 * MIB;
const MAX_METADATA_BYTES = 4 * MIB;
const EXPECTED_RAW_REPLAY_KIND = "proxywar-coworld-local-poc";
const GENERATOR = "replay-premiere-rated-coworld-ingest/v1";
const RATED_BUNDLE_KIND = "proxywar_rated_coworld_source";
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const REQUIRED_ARGUMENT_PREFIXES = [
  "--replay-file=",
  "--episode-file=",
  "--episode-request-id=",
  "--division-file=",
  "--division-id=",
  "--out-file=",
] as const;
const OPTIONAL_ARGUMENT_PREFIXES = [
  "--turn-interval-ms=",
  "--admission-input-dir=",
] as const;

export interface ReplayPremiereCoworldIngestOptions {
  replayFile: string;
  episodeFile: string;
  episodeRequestId: string;
  divisionFile: string;
  divisionId: string;
  outFile: string;
  turnIntervalMs: number;
  admissionInputDir: string | null;
}

export interface ReplayPremiereCoworldIngestSummary {
  bundleKind: typeof RATED_BUNDLE_KIND;
  outFile: string;
  bundleSha256: string;
  bundleByteLength: number;
  sourceRunId: string;
  episodeRequestId: string;
  coworld: CoworldPremiereSourceIds;
  coworldId: string;
  coworldName: string;
  coworldVersion: string;
  gameId: string;
  turnCount: number;
  turnIntervalMs: number;
  seatCount: number;
  rawReplaySha256: string;
  rawReplayByteLength: number;
  suggestedCheckpointSequences: [number, number];
  admissionInputDir: string | null;
}

export interface ReplayPremiereCoworldIngestDependencies {
  now?: () => Date;
}

export interface ReplayPremiereCoworldIngestCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export async function runReplayPremiereCoworldIngest(
  args = process.argv.slice(2),
  dependencies: ReplayPremiereCoworldIngestDependencies = {},
): Promise<ReplayPremiereCoworldIngestSummary> {
  const options = parseArgs(args);
  const now = dependencies.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw ingestFailure("coworld_ingest_clock_invalid");
  }
  const rawReplayBytes = await readBoundedFile(
    options.replayFile,
    MAX_RAW_REPLAY_BYTES,
    "coworld_ingest_replay_file_invalid",
  );
  const [episodeValue, divisionValue] = await Promise.all([
    readBoundedJson(options.episodeFile, "coworld_ingest_episode_file_invalid"),
    readBoundedJson(
      options.divisionFile,
      "coworld_ingest_division_file_invalid",
    ),
  ]);
  const rawReplay = parseRawReplay(rawReplayBytes);
  const gameRecord = rawReplay.gameRecord;
  const info = gameRecord.info;
  const episode = selectEpisodeRow(episodeValue, options.episodeRequestId);
  const division = selectDivisionRow(
    divisionValue,
    options.divisionId,
    episode.coworldId,
  );
  crossCheckEpisodeAgainstReplay(episode, rawReplay);

  const winnerClientID =
    rawReplay.winnerSlot === null
      ? null
      : info.players[rawReplay.winnerSlot].clientID;
  const seats: PremiereSeatIdentity[] = info.players.map((player, index) => ({
    seatId: player.clientID,
    displayName: player.username,
    policyIdentity: {
      namespace: "softmax_policy_version",
      policyVersionId: episode.participants[index].policyVersionId,
      policyName: episode.participants[index].policyName,
      serverAssignedVersion: `v${episode.participants[index].version}`,
    },
  }));
  const coworld: CoworldPremiereSourceIds = {
    episodeId: episode.episodeId,
    leagueId: division.leagueId,
    divisionId: division.divisionId,
    roundId: episode.roundId,
  };
  const completedAt = new Date(info.end).toISOString();
  const startedAt = new Date(info.start).toISOString();
  const authoritativeResultValue: ReplayPremiereJsonValue = {
    schemaVersion: 1,
    sourceKind: "coworld_result",
    sourceRunId: rawReplay.runId,
    sourceId: episode.episodeRequestId,
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
    ...gameRecord,
    info: {
      ...info,
      ...(winnerClientID === null
        ? {}
        : { winner: ["player", winnerClientID] }),
    },
  };
  const generatorSha256 = sha256Hex(
    await fs.readFile(fileURLToPath(import.meta.url)),
  );
  const bundle: ReplayPremiereJsonValue = {
    schemaVersion: 1,
    bundleKind: RATED_BUNDLE_KIND,
    sourceRunId: rawReplay.runId,
    createdAt: now.toISOString(),
    gameRecord: toJsonValue(bundleGameRecord, "rated bundle game record"),
    replay: {
      turnCount: info.num_turns,
      turnIntervalMs: options.turnIntervalMs,
    },
    authoritativeResult: {
      sourceId: episode.episodeRequestId,
      encoding: "base64",
      bytes: resultBytes.toString("base64"),
      sha256: sha256Hex(resultBytes),
    },
    seats: toJsonValue(seats, "rated bundle seats"),
    coworld: { ...coworld },
    provenance: {
      generator: GENERATOR,
      observatory: {
        episodeRequestId: episode.episodeRequestId,
        episodeId: episode.episodeId,
        roundId: episode.roundId,
        leagueId: division.leagueId,
        divisionId: division.divisionId,
        coworldId: episode.coworldId,
        coworldName: episode.coworldName,
        coworldVersion: episode.coworldVersion,
        variantName: episode.variantName,
        replayUrl: episode.replayUrl,
        requesterUserId: episode.requesterUserId,
        episodeCreatedAt: episode.createdAt,
        episodeCompletedAt: episode.completedAt,
      },
      rawReplay: {
        sha256: sha256Hex(rawReplayBytes),
        byteLength: rawReplayBytes.byteLength,
        replayKind: EXPECTED_RAW_REPLAY_KIND,
        runId: rawReplay.runId,
      },
      participants: episode.participants.map((participant, index) => ({
        position: index,
        label: participant.label,
        playerId: participant.playerId,
        playerName: participant.playerName,
      })),
      game: {
        gameId: info.gameID,
        startedAt,
        completedAt,
        turnCount: info.num_turns,
        map: String(info.config.gameMap),
        mapSize: String(info.config.gameMapSize),
        mode: String(info.config.gameMode),
        gameType: String(info.config.gameType),
      },
      build: {
        generatorSha256,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
    },
  };
  const bundleBytes = Buffer.from(canonicalReplayPremiereJson(bundle), "utf8");
  await writeExclusive(
    options.outFile,
    bundleBytes,
    "coworld_ingest_out_file_unwritable",
  );
  const suggestedCheckpointSequences: [number, number] = [
    Math.round(0.35 * info.num_turns),
    Math.round(0.65 * info.num_turns),
  ];
  if (options.admissionInputDir !== null) {
    await emitAdmissionInputTemplates({
      directory: options.admissionInputDir,
      now,
      episode,
      seatCount: seats.length,
      map: String(info.config.gameMap),
      suggestedCheckpointSequences,
    });
  }
  return {
    bundleKind: RATED_BUNDLE_KIND,
    outFile: options.outFile,
    bundleSha256: sha256Hex(bundleBytes),
    bundleByteLength: bundleBytes.byteLength,
    sourceRunId: rawReplay.runId,
    episodeRequestId: episode.episodeRequestId,
    coworld,
    coworldId: episode.coworldId,
    coworldName: episode.coworldName,
    coworldVersion: episode.coworldVersion,
    gameId: info.gameID,
    turnCount: info.num_turns,
    turnIntervalMs: options.turnIntervalMs,
    seatCount: seats.length,
    rawReplaySha256: sha256Hex(rawReplayBytes),
    rawReplayByteLength: rawReplayBytes.byteLength,
    suggestedCheckpointSequences,
    admissionInputDir: options.admissionInputDir,
  };
}

export async function executeReplayPremiereCoworldIngestCli(
  args: string[],
  dependencies: ReplayPremiereCoworldIngestDependencies,
  io: ReplayPremiereCoworldIngestCliIo,
): Promise<number> {
  try {
    const summary = await runReplayPremiereCoworldIngest(args, dependencies);
    io.stdout(`${JSON.stringify(summary)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`REPLAY_PREMIERE_COWORLD_INGEST_FAILED ${operatorCode(error)}\n`);
    return 1;
  }
}

interface ParsedRawReplay {
  runId: string;
  gameRecord: GameRecord;
  winnerSlot: number | null;
  resultPlayers: Array<{ slot: number; name: string }>;
  declaredTurnCount: number;
}

function parseRawReplay(bytes: Buffer): ParsedRawReplay {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw ingestFailure("coworld_ingest_replay_invalid_json");
  }
  if (!isRecord(value)) {
    throw ingestFailure("coworld_ingest_replay_not_object");
  }
  if (
    value.schemaVersion !== 1 ||
    value.replayKind !== EXPECTED_RAW_REPLAY_KIND
  ) {
    throw ingestFailure("coworld_ingest_replay_kind_unsupported");
  }
  const runId = value.runID;
  if (typeof runId !== "string" || !OPAQUE_ID_PATTERN.test(runId)) {
    throw ingestFailure("coworld_ingest_replay_run_id_invalid");
  }
  const inlineArtifacts = value.inlineRunArtifacts;
  if (
    !isRecord(inlineArtifacts) ||
    typeof inlineArtifacts["game-record.json"] !== "string"
  ) {
    throw ingestFailure("coworld_ingest_replay_game_record_missing");
  }
  let gameRecordValue: unknown;
  try {
    gameRecordValue = JSON.parse(inlineArtifacts["game-record.json"]);
  } catch {
    throw ingestFailure("coworld_ingest_replay_game_record_invalid_json");
  }
  const parsedRecord = GameRecordSchema.strict().safeParse(gameRecordValue);
  if (!parsedRecord.success) {
    throw ingestFailure(
      "coworld_ingest_replay_game_record_schema_invalid",
      parsedRecord.error,
    );
  }
  const record = parsedRecord.data;
  const info = record.info;
  if (
    !Number.isSafeInteger(info.num_turns) ||
    info.num_turns < 4 ||
    !Number.isSafeInteger(info.start) ||
    !Number.isSafeInteger(info.end) ||
    info.players.length < 2 ||
    info.players.length > 64
  ) {
    throw ingestFailure("coworld_ingest_replay_game_record_contract_invalid");
  }
  const seenClientIds = new Set<string>();
  for (const player of info.players) {
    // Hosted adapter seats never carry real account identity; a non-null
    // persistentID would be PII and fails closed.
    if (player.persistentID !== null) {
      throw ingestFailure("coworld_ingest_replay_player_pii_present");
    }
    if (seenClientIds.has(player.clientID)) {
      throw ingestFailure("coworld_ingest_replay_duplicate_client_id");
    }
    seenClientIds.add(player.clientID);
  }
  let previousTurnNumber = -1;
  for (const turn of record.turns) {
    const strictTurn = TurnSchema.strict().safeParse(turn);
    if (
      !strictTurn.success ||
      !Number.isSafeInteger(turn.turnNumber) ||
      turn.turnNumber <= previousTurnNumber ||
      turn.turnNumber >= info.num_turns
    ) {
      throw ingestFailure("coworld_ingest_replay_turn_stream_invalid");
    }
    previousTurnNumber = turn.turnNumber;
  }
  const results = value.results;
  if (!isRecord(results)) {
    throw ingestFailure("coworld_ingest_replay_results_missing");
  }
  if (results.turn_count !== info.num_turns) {
    throw ingestFailure("coworld_ingest_replay_turn_count_mismatch");
  }
  const winnerSlot = results.winner_slot;
  if (
    winnerSlot !== null &&
    (!Number.isSafeInteger(winnerSlot) ||
      Number(winnerSlot) < 0 ||
      Number(winnerSlot) >= info.players.length)
  ) {
    throw ingestFailure("coworld_ingest_replay_winner_slot_invalid");
  }
  const finalState = value.finalState;
  if (
    isRecord(finalState) &&
    finalState.winnerSlot !== undefined &&
    finalState.winnerSlot !== winnerSlot
  ) {
    throw ingestFailure("coworld_ingest_replay_winner_slot_inconsistent");
  }
  const resultPlayers = results.players;
  if (
    !Array.isArray(resultPlayers) ||
    resultPlayers.length !== info.players.length
  ) {
    throw ingestFailure("coworld_ingest_replay_result_players_invalid");
  }
  const parsedResultPlayers = resultPlayers.map((entry, index) => {
    if (
      !isRecord(entry) ||
      entry.slot !== index ||
      typeof entry.name !== "string"
    ) {
      throw ingestFailure("coworld_ingest_replay_result_players_invalid");
    }
    return { slot: index, name: entry.name };
  });
  return {
    runId,
    gameRecord: record,
    winnerSlot: winnerSlot === null ? null : Number(winnerSlot),
    resultPlayers: parsedResultPlayers,
    declaredTurnCount: info.num_turns,
  };
}

interface ParsedEpisodeRow {
  episodeRequestId: string;
  episodeId: string;
  roundId: string;
  coworldId: string;
  coworldName: string;
  coworldVersion: string;
  variantName: string | null;
  replayUrl: string;
  requesterUserId: string;
  createdAt: string;
  completedAt: string;
  gameConfig: Record<string, unknown>;
  participants: Array<{
    policyVersionId: string;
    policyName: string;
    version: number;
    playerId: string;
    playerName: string;
    label: string;
  }>;
}

function selectEpisodeRow(
  value: unknown,
  episodeRequestId: string,
): ParsedEpisodeRow {
  const rows = Array.isArray(value) ? value : [value];
  const matches = rows.filter(
    (row) => isRecord(row) && row.id === episodeRequestId,
  );
  if (matches.length !== 1) {
    throw ingestFailure("coworld_ingest_episode_row_not_found");
  }
  const row = matches[0] as Record<string, unknown>;
  if (row.status !== "completed") {
    throw ingestFailure("coworld_ingest_episode_not_completed");
  }
  const participantsValue = row.participants;
  if (!Array.isArray(participantsValue) || participantsValue.length < 2) {
    throw ingestFailure("coworld_ingest_episode_participants_invalid");
  }
  const participants = participantsValue.map((entry, index) => {
    if (
      !isRecord(entry) ||
      entry.position !== index ||
      typeof entry.policy_version_id !== "string" ||
      typeof entry.policy_name !== "string" ||
      !Number.isSafeInteger(entry.version) ||
      Number(entry.version) < 0 ||
      typeof entry.player_id !== "string" ||
      typeof entry.player_name !== "string" ||
      typeof entry.label !== "string"
    ) {
      throw ingestFailure("coworld_ingest_episode_participants_invalid");
    }
    return {
      policyVersionId: String(entry.policy_version_id),
      policyName: String(entry.policy_name),
      version: Number(entry.version),
      playerId: String(entry.player_id),
      playerName: String(entry.player_name),
      label: String(entry.label),
    };
  });
  const createdAt = canonicalTimestampOf(row.created_at);
  const completedAt = canonicalTimestampOf(row.completed_at);
  if (
    typeof row.episode_id !== "string" ||
    typeof row.round_id !== "string" ||
    typeof row.coworld_id !== "string" ||
    typeof row.coworld_name !== "string" ||
    typeof row.coworld_version !== "string" ||
    (row.variant_name !== null && typeof row.variant_name !== "string") ||
    typeof row.replay_url !== "string" ||
    typeof row.requester_user_id !== "string" ||
    createdAt === null ||
    completedAt === null ||
    !isRecord(row.game_config) ||
    [row.episode_id, row.round_id, row.coworld_id].some(
      (id) => !OPAQUE_ID_PATTERN.test(String(id)),
    )
  ) {
    throw ingestFailure("coworld_ingest_episode_row_invalid");
  }
  return {
    episodeRequestId,
    episodeId: String(row.episode_id),
    roundId: String(row.round_id),
    coworldId: String(row.coworld_id),
    coworldName: String(row.coworld_name),
    coworldVersion: String(row.coworld_version),
    variantName: row.variant_name === null ? null : String(row.variant_name),
    replayUrl: String(row.replay_url),
    requesterUserId: String(row.requester_user_id),
    createdAt,
    completedAt,
    gameConfig: row.game_config as Record<string, unknown>,
    participants,
  };
}

interface ParsedDivisionRow {
  divisionId: string;
  leagueId: string;
}

function selectDivisionRow(
  value: unknown,
  divisionId: string,
  expectedCoworldId: string,
): ParsedDivisionRow {
  const rows = Array.isArray(value) ? value : [value];
  const matches = rows.filter((row) => isRecord(row) && row.id === divisionId);
  if (matches.length !== 1) {
    throw ingestFailure("coworld_ingest_division_row_not_found");
  }
  const division = matches[0] as Record<string, unknown>;
  const league = division.league;
  if (!isRecord(league) || !isRecord(league.game)) {
    throw ingestFailure("coworld_ingest_division_row_invalid");
  }
  const game = league.game as Record<string, unknown>;
  if (game.coworld_id !== expectedCoworldId) {
    // The named division must belong to the league whose game produced this
    // episode's Coworld; anything else is a cross-league identity claim.
    throw ingestFailure("coworld_ingest_division_binding_mismatch");
  }
  if (
    typeof league.id !== "string" ||
    !OPAQUE_ID_PATTERN.test(divisionId) ||
    !OPAQUE_ID_PATTERN.test(league.id)
  ) {
    throw ingestFailure("coworld_ingest_division_row_invalid");
  }
  return { divisionId, leagueId: String(league.id) };
}

function crossCheckEpisodeAgainstReplay(
  episode: ParsedEpisodeRow,
  rawReplay: ParsedRawReplay,
): void {
  const info = rawReplay.gameRecord.info;
  if (episode.participants.length !== info.players.length) {
    throw ingestFailure("coworld_ingest_participant_count_mismatch");
  }
  for (let index = 0; index < info.players.length; index += 1) {
    // Both name sources inside the replay file must agree: the adapter's game
    // record stores an OpenFront-sanitized (and possibly truncated) username,
    // while the replay results keep the raw name at episode time. The episode
    // row's participants[].player_name is the account's CURRENT display name
    // (players rename between episodes), so it binds positionally and is
    // recorded as provenance, never compared byte-for-byte.
    const recordProjection = alphanumericProjection(
      info.players[index].username,
    );
    const resultProjection = alphanumericProjection(
      rawReplay.resultPlayers[index].name,
    );
    if (
      recordProjection.length === 0 ||
      !resultProjection.startsWith(recordProjection)
    ) {
      throw ingestFailure("coworld_ingest_participant_binding_mismatch");
    }
  }
  const gameConfig = episode.gameConfig;
  if (
    gameConfig.map !== String(info.config.gameMap) ||
    gameConfig.map_size !== String(info.config.gameMapSize) ||
    gameConfig.difficulty !== String(info.config.difficulty) ||
    gameConfig.num_agents !== info.players.length
  ) {
    throw ingestFailure("coworld_ingest_episode_game_config_mismatch");
  }
}

async function emitAdmissionInputTemplates(options: {
  directory: string;
  now: Date;
  episode: ParsedEpisodeRow;
  seatCount: number;
  map: string;
  suggestedCheckpointSequences: [number, number];
}): Promise<void> {
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
  const checkpointSeed = sha256Hex(
    `${options.episode.episodeId}:${options.episode.episodeRequestId}`,
  );
  const eligibilityTemplate = {
    schemaVersion: 1,
    eligibilityCheckVersion: "phase0/v1",
    externalEmbargoEvidence: [],
    // League standings publish every rated outcome; only the
    // spoiler-resistant label is honest for rated Coworld sources.
    externalOutcomeMayBePublic: true,
    publicLabel: "spoiler_resistant_premiere",
  };
  const definitionTemplate = {
    schemaVersion: 1,
    title: `${options.episode.coworldName} league premiere`,
    spoilerNeutralDescription: `A rated ${options.episode.coworldName} league episode on ${options.map}.`,
    map: { id: options.map, label: options.map },
    matchFormat: {
      id: `ffa-${options.seatCount}`,
      label: options.episode.variantName ?? `${options.seatCount}-seat FFA`,
      seatCount: options.seatCount,
    },
    scheduledAt: options.now.toISOString(),
    playbackRate: 2,
    checkpoints: [
      {
        id: `cp_${checkpointSeed.slice(0, 8)}`,
        sequence: options.suggestedCheckpointSequences[0],
      },
      {
        id: `cp_${checkpointSeed.slice(8, 16)}`,
        sequence: options.suggestedCheckpointSequences[1],
      },
    ],
  };
  await writeExclusive(
    path.join(options.directory, "eligibility.input.json"),
    Buffer.from(`${JSON.stringify(eligibilityTemplate, null, 2)}\n`, "utf8"),
    "coworld_ingest_template_unwritable",
  );
  await writeExclusive(
    path.join(options.directory, "definition.input.json"),
    Buffer.from(`${JSON.stringify(definitionTemplate, null, 2)}\n`, "utf8"),
    "coworld_ingest_template_unwritable",
  );
}

function parseArgs(args: string[]): ReplayPremiereCoworldIngestOptions {
  if (
    args.length === 0 ||
    args.some(
      (argument) =>
        !REQUIRED_ARGUMENT_PREFIXES.some((prefix) =>
          argument.startsWith(prefix),
        ) &&
        !OPTIONAL_ARGUMENT_PREFIXES.some((prefix) =>
          argument.startsWith(prefix),
        ),
    )
  ) {
    throw ingestFailure("coworld_ingest_unknown_or_missing_argument");
  }
  for (const prefix of REQUIRED_ARGUMENT_PREFIXES) {
    if (args.filter((argument) => argument.startsWith(prefix)).length !== 1) {
      throw ingestFailure("coworld_ingest_argument_cardinality_invalid");
    }
  }
  for (const prefix of OPTIONAL_ARGUMENT_PREFIXES) {
    if (args.filter((argument) => argument.startsWith(prefix)).length > 1) {
      throw ingestFailure("coworld_ingest_argument_cardinality_invalid");
    }
  }
  const replayFile = singleValue(args, "--replay-file=");
  const episodeFile = singleValue(args, "--episode-file=");
  const episodeRequestId = singleValue(args, "--episode-request-id=");
  const divisionFile = singleValue(args, "--division-file=");
  const divisionId = singleValue(args, "--division-id=");
  const outFile = singleValue(args, "--out-file=");
  // Default to the real OpenFront turn cadence so premieres play at regular
  // match speed at rate 1. The flag remains only as an explicit override.
  const turnIntervalRaw =
    optionalValue(args, "--turn-interval-ms=") ??
    String(PREMIERE_REAL_TURN_INTERVAL_MS);
  const admissionInputDir = optionalValue(args, "--admission-input-dir=");
  const turnIntervalMs = Number(turnIntervalRaw);
  if (
    [replayFile, episodeFile, divisionFile, outFile].some(
      (entry) => !path.isAbsolute(entry),
    ) ||
    (admissionInputDir !== null && !path.isAbsolute(admissionInputDir)) ||
    !outFile.endsWith(".source.json") ||
    !OPAQUE_ID_PATTERN.test(episodeRequestId) ||
    !OPAQUE_ID_PATTERN.test(divisionId) ||
    !Number.isSafeInteger(turnIntervalMs) ||
    turnIntervalMs <= 0 ||
    turnIntervalMs > 60_000
  ) {
    throw ingestFailure("coworld_ingest_argument_value_invalid");
  }
  return {
    replayFile,
    episodeFile,
    episodeRequestId,
    divisionFile,
    divisionId,
    outFile,
    turnIntervalMs,
    admissionInputDir,
  };
}

function singleValue(args: string[], prefix: string): string {
  const values = args
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  if (
    values.length !== 1 ||
    values[0].length === 0 ||
    values[0].includes("\0")
  ) {
    throw ingestFailure("coworld_ingest_argument_value_invalid");
  }
  return values[0];
}

function optionalValue(args: string[], prefix: string): string | null {
  const values = args
    .filter((argument) => argument.startsWith(prefix))
    .map((argument) => argument.slice(prefix.length));
  if (values.length === 0) return null;
  if (values[0].length === 0 || values[0].includes("\0")) {
    throw ingestFailure("coworld_ingest_argument_value_invalid");
  }
  return values[0];
}

async function readBoundedFile(
  filePath: string,
  maxBytes: number,
  operatorCodeValue: string,
): Promise<Buffer> {
  const resolved = path.resolve(filePath);
  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch {
    throw ingestFailure(operatorCodeValue);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw ingestFailure(operatorCodeValue);
  }
  const handle = await fs
    .open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch(() => null);
  if (handle === null) throw ingestFailure(operatorCodeValue);
  try {
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      throw ingestFailure(operatorCodeValue);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readBoundedJson(
  filePath: string,
  operatorCodeValue: string,
): Promise<unknown> {
  const bytes = await readBoundedFile(
    filePath,
    MAX_METADATA_BYTES,
    operatorCodeValue,
  );
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw ingestFailure(operatorCodeValue);
  }
}

async function writeExclusive(
  filePath: string,
  bytes: Buffer,
  operatorCodeValue: string,
): Promise<void> {
  let handle;
  try {
    handle = await fs.open(
      filePath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw ingestFailure(operatorCodeValue);
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

function alphanumericProjection(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "");
}

function canonicalTimestampOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ingestFailure(
  operatorCodeValue: string,
  cause?: unknown,
): ReplayPremiereError {
  return new ReplayPremiereError(
    operatorCodeValue,
    "PREMIERE_INVALID_REQUEST",
    400,
    `Replay premiere Coworld ingest rejected: ${operatorCodeValue}`,
    cause === undefined ? undefined : { cause },
  );
}

function operatorCode(error: unknown): string {
  return error instanceof ReplayPremiereError
    ? error.operatorCode
    : "coworld_ingest_unavailable";
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const exitCode = await executeReplayPremiereCoworldIngestCli(
    process.argv.slice(2),
    {},
    {
      stdout: (line) => process.stdout.write(line),
      stderr: (line) => process.stderr.write(line),
    },
  );
  if (exitCode !== 0) process.exitCode = exitCode;
}
