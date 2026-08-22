/**
 * Read-only XP evidence collector and local sealer.
 *
 * This command cannot create, dispatch, cancel, or retry an Experience Request.
 * It accepts a complete mapping of preregistered slots to already-created xreq
 * ids, reads their terminal evidence through Coworld 0.1.42, extracts only the
 * privacy-safe game projection and owned player artifact, and then invokes the
 * independent v2 verifier.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import JSZip from "jszip";

import {
  sha256Canonical,
  type CommanderXpArm,
  type CommanderXpPlannedRequest,
  type CommanderXpPreRegistrationV2,
  type CommanderXpProtocolPhase,
} from "../../src/server/agents/CommanderXpProtocol";
import { verifyCommanderXpEvidence } from "../../src/server/agents/CommanderXpVerifier";
import { commanderXpGameEvidenceFromRawGameLog } from "./commander-xp-game-log";
import { coworldEpisodeIdentity } from "./coworld-seed";

const execFileAsync = promisify(execFile);
const XP_OPENAPI_URL = "https://softmax.com/api/observatory/openapi.json";

export interface CollectorInput {
  schemaVersion: 2;
  phase: "preregistration" | "provider-preflight" | "canary" | "confirmatory";
  preRegistrationPath: string;
  policyIdentitiesPath: string;
  policyInspectPaths: Record<CommanderXpArm, string>;
  evalCoworldIdentityPath: string;
  evalCoworldInspectPath: string;
  evalCoworldManifestPath: string;
  /** Existing authenticated wrapper; workflow pins Coworld 0.1.42 binary. */
  coworldCommandPath: string;
  outputDirectory: string;
  canaryLocalSealSha256: string | null;
  preregistrationLedgerPath?: string;
  providerPreflightLedgerPath?: string;
  canaryLedgerPath?: string;
  confirmatoryActivationPath?: string;
  requests: Array<{
    phase: CommanderXpProtocolPhase;
    replicaIndex: number;
    arm: CommanderXpArm;
    xpRequestID: string;
    submittedRequestPath: string;
    createResponsePath: string;
  }>;
}

export async function collectCommanderXpEvidence(
  input: CollectorInput,
): Promise<{
  outputDirectory: string;
  sealSha256: string;
  integrityVerified: boolean;
  experimentUsable: false;
}> {
  if (input.schemaVersion !== 2) throw new Error("collector schema invalid");
  const envelopeDirectory = path.resolve(input.outputDirectory);
  const coworldCommandPath = path.resolve(input.coworldCommandPath);
  if (!(await fs.stat(coworldCommandPath)).isFile()) {
    throw new Error("collector Coworld command wrapper is invalid");
  }
  const outputDirectory =
    await createCollectorEvidenceOutput(envelopeDirectory);
  const preregText = await fs.readFile(
    path.resolve(input.preRegistrationPath),
    "utf8",
  );
  const prereg = JSON.parse(preregText) as CommanderXpPreRegistrationV2;
  const policyText = await fs.readFile(
    path.resolve(input.policyIdentitiesPath),
    "utf8",
  );
  const evalCoworldIdentityText = await fs.readFile(
    path.resolve(input.evalCoworldIdentityPath),
    "utf8",
  );
  const evalCoworldManifestText = await fs.readFile(
    path.resolve(input.evalCoworldManifestPath),
    "utf8",
  );
  await Promise.all([
    fs.writeFile(
      path.join(outputDirectory, "commander-xp-preregistration-v2.json"),
      preregText,
      { flag: "wx" },
    ),
    fs.writeFile(
      path.join(outputDirectory, "eval-coworld-manifest-v2.json"),
      evalCoworldManifestText,
      { flag: "wx" },
    ),
    fs.writeFile(
      path.join(outputDirectory, "eval-coworld-identity-v2.json"),
      evalCoworldIdentityText,
      { flag: "wx" },
    ),
    fs.writeFile(
      path.join(outputDirectory, "policy-identities-v2.json"),
      policyText,
      { flag: "wx" },
    ),
    ...(["A", "B", "C"] as const).map(async (arm) => {
      const directory = path.join(outputDirectory, "policy-inspect");
      await fs.mkdir(directory, { recursive: true });
      await fs.copyFile(
        path.resolve(input.policyInspectPaths[arm]),
        path.join(directory, `${arm}.json`),
        fs.constants.COPYFILE_EXCL,
      );
    }),
    fs.copyFile(
      path.resolve(input.evalCoworldInspectPath),
      path.join(outputDirectory, "eval-coworld-inspect.json"),
      fs.constants.COPYFILE_EXCL,
    ),
  ]);
  const openApiResponse = await fetch(XP_OPENAPI_URL);
  if (!openApiResponse.ok) {
    throw new Error(`XP OpenAPI returned HTTP ${openApiResponse.status}`);
  }
  const openApiHash = sha256(
    new Uint8Array(await openApiResponse.arrayBuffer()),
  );
  if (openApiHash !== prereg.identities.xpOpenApiSha256) {
    throw new Error("XP OpenAPI hash changed after preregistration");
  }
  await fs.writeFile(
    path.join(outputDirectory, "xp-openapi.sha256"),
    `${openApiHash}  ${XP_OPENAPI_URL}\n`,
    { flag: "wx" },
  );

  const planned =
    input.phase === "preregistration"
      ? []
      : input.phase === "provider-preflight"
        ? prereg.providerPreflightRequests
        : prereg.requests.filter((request) => request.phase === input.phase);
  const phaseAuthorityArtifactPaths = await copyCollectorPhaseAuthority(
    input,
    outputDirectory,
  );
  const mapping = exactCollectorRequestMapping(input.requests, planned);
  for (const request of planned) {
    await collectRun(
      outputDirectory,
      prereg,
      request,
      mapping.get(mappingKey(request))!,
      coworldCommandPath,
    );
  }
  await writeJsonExclusive(
    path.join(outputDirectory, "commander-xp-local-verification-v2.json"),
    {
      schemaVersion: 2,
      verifierSchemaVersion: 2,
      phase: input.phase,
      integrityExpected: true,
      experimentUsable: false,
      authenticity: "external-seal-receipt-required",
    },
  );
  const artifactPaths = [
    "commander-xp-preregistration-v2.json",
    ...phaseAuthorityArtifactPaths,
    "policy-identities-v2.json",
    "policy-inspect/A.json",
    "policy-inspect/B.json",
    "policy-inspect/C.json",
    "eval-coworld-identity-v2.json",
    "eval-coworld-inspect.json",
    "eval-coworld-manifest-v2.json",
    "xp-openapi.sha256",
    "commander-xp-local-verification-v2.json",
    ...planned.flatMap((request) => {
      const directory = runDirectory(request);
      const suffixes =
        request.phase === "provider-preflight"
          ? [
              "xp-evidence.json",
              "submitted-request.json",
              "create-response.json",
              "normalized-request-readback.json",
              "replay-evidence.json",
              "coworld-bundle-receipt.json",
              "command-receipts.json",
              "player-artifact/runtime-manifest.json",
              "player-artifact/trace.jsonl",
              "player-artifact/hashes.json",
            ]
          : [
              "xp-evidence.json",
              "submitted-request.json",
              "create-response.json",
              "normalized-request-readback.json",
              "replay-evidence.json",
              "coworld-bundle-receipt.json",
              "episode-results.json",
              "game-evidence.jsonl",
              "command-receipts.json",
              "player-artifact/runtime-manifest.json",
              "player-artifact/trace.jsonl",
              "player-artifact/hashes.json",
            ];
      return suffixes.map((suffix) => `${directory}/${suffix}`);
    }),
  ];
  const artifacts = await Promise.all(
    artifactPaths.map(async (relativePath) => ({
      path: relativePath,
      sha256: sha256(
        new Uint8Array(
          await fs.readFile(path.join(outputDirectory, relativePath)),
        ),
      ),
    })),
  );
  const namespaceRegistry = await buildCollectorNamespaceRegistry(
    outputDirectory,
    planned,
    collectorPriorLedgerFilename(input.phase) === null
      ? null
      : path.join(outputDirectory, collectorPriorLedgerFilename(input.phase)!),
  );
  const index = {
    schemaVersion: 2,
    experimentID: prereg.experimentID,
    phase: input.phase,
    preRegistrationSha256: prereg.preRegistrationSha256,
    xpOpenApiSha256: prereg.identities.xpOpenApiSha256,
    canarySealSha256:
      input.phase === "confirmatory" ? input.canaryLocalSealSha256 : null,
    namespaceRegistry,
    artifacts,
  } as const;
  await writeJsonExclusive(
    path.join(outputDirectory, "commander-xp-evidence-index-v2.json"),
    index,
  );
  const sealBody = {
    schemaVersion: 2,
    experimentID: prereg.experimentID,
    phase: input.phase,
    status: "complete",
    indexSha256: sha256Canonical(index),
    sealedAt: new Date().toISOString(),
  } as const;
  const seal = { ...sealBody, sealSha256: sha256Canonical(sealBody) };
  await writeJsonExclusive(
    path.join(outputDirectory, "commander-xp-evidence-seal-v2.json"),
    seal,
  );
  const verification = await verifyCommanderXpEvidence(outputDirectory);
  if (!verification.integrityVerified) {
    throw new Error(
      `collected Commander XP evidence failed verification: ${verification.diagnostics[0]?.code ?? "unknown"}`,
    );
  }
  return {
    outputDirectory: envelopeDirectory,
    sealSha256: seal.sealSha256,
    integrityVerified: true,
    experimentUsable: false,
  };
}

export async function createCollectorEvidenceOutput(
  requestedOutputDirectory: string,
): Promise<string> {
  const outputDirectory = path.resolve(requestedOutputDirectory);
  await fs.mkdir(outputDirectory, { recursive: false });
  const evidenceDirectory = path.join(outputDirectory, "evidence");
  await fs.mkdir(evidenceDirectory, { recursive: false });
  return evidenceDirectory;
}

async function collectRun(
  root: string,
  prereg: CommanderXpPreRegistrationV2,
  planned: CommanderXpPlannedRequest,
  mapping: CollectorInput["requests"][number],
  coworldCommandPath: string,
): Promise<void> {
  const xpRequestID = mapping.xpRequestID;
  if (!/^xreq_[A-Za-z0-9-]+$/.test(xpRequestID)) {
    throw new Error("collector xreq id invalid");
  }
  const xpGetArgs = ["xp-request", "get", xpRequestID, "--json"];
  const rawXpText = await coworld(coworldCommandPath, xpGetArgs);
  assertPrivacySafeArtifact(rawXpText, "xp-request-get.json");
  const raw = JSON.parse(rawXpText) as Record<string, unknown>;
  const submittedRequestText = await fs.readFile(
    path.resolve(mapping.submittedRequestPath),
    "utf8",
  );
  JSON.parse(submittedRequestText);
  const createResponseText = await fs.readFile(
    path.resolve(mapping.createResponsePath),
    "utf8",
  );
  JSON.parse(createResponseText);
  const episodes = Array.isArray(raw.episodes) ? raw.episodes : [];
  if (episodes.length !== 1)
    throw new Error("XP request is not single-episode");
  const episode = episodes[0] as Record<string, unknown>;
  const episodeRequestID = String(episode.id ?? "");
  if (String(raw.id ?? "") !== xpRequestID) {
    throw new Error("XP request readback id mismatch");
  }
  const participants = Array.isArray(episode.participants)
    ? episode.participants
    : [];
  const rawRequestedReadback = raw.requested;
  if (
    rawRequestedReadback === null ||
    typeof rawRequestedReadback !== "object"
  ) {
    throw new Error("XP request readback omitted its normalized projection");
  }
  const requestedReadback = normalizedRequestReadback(rawRequestedReadback);
  const replayURL = String(episode.replay_url ?? "");
  let replayPath: string;
  try {
    const parsed = new URL(replayURL);
    if (parsed.protocol !== "https:") throw new Error("not https");
    replayPath = parsed.pathname;
  } catch {
    throw new Error("XP episode replay URL is invalid");
  }
  const xpEvidence = {
    schemaVersion: 2,
    xpRequestID,
    xpRequestCreatedAt: raw.created_at,
    xpRequestStartedAt: raw.started_at,
    xpRequestCompletedAt: raw.completed_at,
    episodeCount: raw.episode_count,
    pendingCount: raw.pending_count,
    submittedCount: raw.submitted_count,
    runningCount: raw.running_count,
    completedCount: raw.completed_count,
    failedCount: raw.failed_count,
    episodeRequestID,
    jobID: episode.job_id,
    status: raw.status,
    coworldID: episode.coworld_id,
    coworldVersion: episode.coworld_version,
    variantID: raw.variant_id,
    episodeID: episode.episode_id,
    replayPath,
    replayURLSha256: sha256(new TextEncoder().encode(replayURL)),
    episodeCreatedAt: episode.created_at,
    dispatchedAt: episode.dispatched_at,
    runningAt: episode.running_at,
    completedAt: episode.completed_at,
    participants: participants.map((entry) => {
      const participant = entry as Record<string, unknown>;
      return {
        position: participant.position,
        policyVersionID: participant.policy_version_id,
      };
    }),
    gameConfig: episode.game_config,
  };
  const directory = path.join(root, runDirectory(planned));
  const artifactDirectory = path.join(directory, "player-artifact");
  await fs.mkdir(artifactDirectory, { recursive: true });
  const bundleTempDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "proxywar-commander-xp-bundle-"),
  );
  const bundlePath = path.join(
    bundleTempDirectory,
    "episode-request-bundle.zip",
  );
  let bundle: Awaited<ReturnType<typeof parseEpisodeBundle>>;
  try {
    await fetchEpisodeBundle(coworldCommandPath, episodeRequestID, bundlePath);
    bundle = await parseEpisodeBundle(bundlePath, episodeRequestID);
  } finally {
    await fs.rm(bundleTempDirectory, { recursive: true, force: true });
  }
  await writeJsonExclusive(
    path.join(directory, "xp-evidence.json"),
    xpEvidence,
  );
  await Promise.all([
    fs.writeFile(
      path.join(directory, "submitted-request.json"),
      submittedRequestText,
      { flag: "wx" },
    ),
    fs.writeFile(
      path.join(directory, "create-response.json"),
      createResponseText,
      { flag: "wx" },
    ),
    writeJsonExclusive(
      path.join(directory, "normalized-request-readback.json"),
      requestedReadback,
    ),
  ]);
  let projectedResults: Record<string, unknown> | null = null;
  const commandReceipts: Array<{
    command: string[];
    resultSha256: string;
  }> = [
    { command: xpGetArgs, resultSha256: sha256(rawXpText) },
    {
      command: ["commander-xp-episode-bundle", episodeRequestID],
      resultSha256: bundle.outerZipSha256,
    },
  ];
  const rawResultsText = bundle.resultsText;
  const rawGameLogText = bundle.gameLogText;
  let gameEvidenceText: string | null = null;
  if (planned.phase !== "provider-preflight") {
    const rawResults = JSON.parse(rawResultsText) as Record<string, unknown>;
    const rawPlayers = Array.isArray(rawResults.players)
      ? rawResults.players
      : [];
    projectedResults = {
      schemaVersion: 2,
      xpRequestID,
      episodeRequestID,
      jobID: xpEvidence.jobID,
      episodeID: xpEvidence.episodeID,
      gameID: rawResults.game_id,
      seed: rawResults.seed,
      scores: rawResults.scores,
      winnerSlot: rawResults.winner_slot,
      subjectWon: rawResults.winner_slot === planned.subjectSeat,
      turnCount: rawResults.turn_count,
      tick: rawResults.tick,
      decisionCount: rawResults.decision_count,
      acceptedDecisionCount: rawResults.accepted_decision_count,
      fallbackCount: rawResults.fallback_count,
      degradedCount: rawResults.degraded_count,
      players: rawPlayers.map((entry) => {
        const player = entry as Record<string, unknown>;
        return {
          slot: player.slot,
          name: player.name,
          score: player.score,
          tilesOwned: player.tiles_owned,
          isAlive: player.is_alive,
        };
      }),
    };
    await writeJsonExclusive(
      path.join(directory, "episode-results.json"),
      projectedResults,
    );
    const gameEvidence = commanderXpGameEvidenceFromRawGameLog(
      rawGameLogText,
    ).flatMap((json) => {
      const parsed = JSON.parse(json) as { coworldSlot?: unknown };
      return parsed.coworldSlot === planned.subjectSeat ? [json] : [];
    });
    if (gameEvidence.length === 0) {
      throw new Error("game-owned Commander XP evidence is missing");
    }
    gameEvidenceText = `${gameEvidence.join("\n")}\n`;
    await fs.writeFile(
      path.join(directory, "game-evidence.jsonl"),
      gameEvidenceText,
      { flag: "wx" },
    );
  }
  const replayEvidence = commanderXpReplayEvidenceProjection(
    replayURL,
    xpEvidence,
    projectedResults,
    bundle.replayBytes,
  );
  await writeJsonExclusive(
    path.join(directory, "replay-evidence.json"),
    replayEvidence,
  );
  const zipPath = path.join(directory, "player-artifact.zip.tmp");
  try {
    const playerArtifactArgs = [
      "episode-logs",
      episodeRequestID,
      "--agent",
      String(planned.subjectSeat),
      "--artifact",
      "--output",
      zipPath,
    ];
    const playerArtifactStdout = await coworld(
      coworldCommandPath,
      playerArtifactArgs,
    );
    commandReceipts.push({
      command: playerArtifactArgs.slice(0, -2),
      resultSha256: sha256(playerArtifactStdout),
    });
    const zip = await JSZip.loadAsync(await fs.readFile(zipPath));
    const expected = new Set([
      "runtime-manifest.json",
      "trace.jsonl",
      "hashes.json",
    ]);
    const files = Object.values(zip.files).filter((entry) => !entry.dir);
    if (
      files.length !== expected.size ||
      files.some((entry) => !expected.has(entry.name))
    ) {
      throw new Error("player artifact file allowlist mismatch");
    }
    for (const entry of files) {
      await fs.writeFile(
        path.join(artifactDirectory, entry.name),
        await entry.async("uint8array"),
        { flag: "wx" },
      );
    }
  } finally {
    await fs.rm(zipPath, { force: true });
  }
  const commandReceipt = {
    schemaVersion: 2,
    coworldClient: "0.1.42",
    commands: commandReceipts,
  };
  await writeJsonExclusive(
    path.join(directory, "command-receipts.json"),
    commandReceipt,
  );
  const projectionHash = async (relativePath: string): Promise<string> =>
    sha256(
      new Uint8Array(await fs.readFile(path.join(directory, relativePath))),
    );
  const bundleReceipt = {
    schemaVersion: 2,
    authority: "coworld-authenticated-bundle-projection-v2",
    downloadedAt: new Date().toISOString(),
    xpRequestID,
    episodeRequestID,
    jobID: xpEvidence.jobID,
    episodeID: xpEvidence.episodeID,
    gameID: coworldEpisodeIdentity(planned.seed).gameId,
    seed: planned.seed,
    coworldID: xpEvidence.coworldID,
    coworldVersion: xpEvidence.coworldVersion,
    variantID: xpEvidence.variantID,
    include: ["results", "replay", "game_logs"],
    manifestSha256: bundle.manifestSha256,
    outerBundleSha256: bundle.outerZipSha256,
    members: bundle.members.map(({ path: memberPath, size, sha256 }) => ({
      path: memberPath,
      bytes: size,
      sha256,
    })),
    projections: {
      episodeResultsSha256:
        projectedResults === null
          ? null
          : await projectionHash("episode-results.json"),
      gameEvidenceSha256:
        gameEvidenceText === null
          ? null
          : await projectionHash("game-evidence.jsonl"),
      replayEvidenceSha256: await projectionHash("replay-evidence.json"),
      commandReceiptsSha256: await projectionHash("command-receipts.json"),
    },
  };
  await writeJsonExclusive(
    path.join(directory, "coworld-bundle-receipt.json"),
    bundleReceipt,
  );
}

function normalizedRequestReadback(value: object): Record<string, unknown> {
  const raw = value as Record<string, unknown>;
  const roster = Array.isArray(raw.roster) ? raw.roster : [];
  return {
    schemaVersion: 2,
    notes: raw.notes,
    numEpisodes: raw.num_episodes,
    roster: roster.map((entry) => {
      const participant = entry as Record<string, unknown>;
      return { slot: participant.slot, policy: participant.policy };
    }),
  };
}

export function commanderXpReplayEvidenceProjection(
  replayURL: string,
  xp: Record<string, unknown>,
  projectedResults: Record<string, unknown> | null,
  bytes: Uint8Array,
): Record<string, unknown> {
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024 * 1024) {
    throw new Error("XP replay byte length is invalid");
  }
  const raw = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as Record<string, unknown>;
  const config = publicReplayConfig(raw.config);
  const replayResults =
    projectedResults === null ? null : publicReplayResults(raw.results);
  return {
    schemaVersion: 2,
    xpRequestID: xp.xpRequestID,
    episodeRequestID: xp.episodeRequestID,
    jobID: xp.jobID,
    episodeID: xp.episodeID,
    replayPath: xp.replayPath,
    replayURLSha256: xp.replayURLSha256,
    contentSha256: sha256(bytes),
    byteLength: bytes.byteLength,
    sourceSchemaVersion: raw.schemaVersion,
    replayKind: raw.replayKind,
    runID: raw.runID,
    matchID: raw.matchID,
    config,
    configSha256: sha256Canonical(config),
    results: replayResults,
    resultsSha256:
      replayResults === null ? null : sha256Canonical(replayResults),
  };
}

function publicReplayConfig(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("XP replay config is invalid");
  }
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    [
      "commander_xp_phase",
      "commander_xp_run_key",
      "players",
      "max_decision_steps",
      "turns_per_decision_step",
      "max_decision_ms",
      "map",
      "map_size",
      "difficulty",
      "seed",
      "episodeIndex",
      "replay_tail_turns",
      "player_connect_timeout_seconds",
      "player_count",
      "num_agents",
      "episode_timeout_seconds",
    ].flatMap((key) => (key in input ? [[key, input[key]]] : [])),
  );
}

function publicReplayResults(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("XP replay results are invalid");
  }
  const raw = value as Record<string, unknown>;
  const players = Array.isArray(raw.players) ? raw.players : [];
  return {
    schemaVersion: 2,
    gameID: raw.game_id,
    seed: raw.seed,
    scores: raw.scores,
    winnerSlot: raw.winner_slot,
    turnCount: raw.turn_count,
    tick: raw.tick,
    decisionCount: raw.decision_count,
    acceptedDecisionCount: raw.accepted_decision_count,
    fallbackCount: raw.fallback_count,
    degradedCount: raw.degraded_count,
    players: players.map((entry) => {
      const player = entry as Record<string, unknown>;
      return {
        slot: player.slot,
        name: player.name,
        score: player.score,
        tilesOwned: player.tiles_owned,
        isAlive: player.is_alive,
      };
    }),
  };
}

async function fetchEpisodeBundle(
  authenticatedCommandPath: string,
  episodeRequestID: string,
  outputPath: string,
): Promise<void> {
  await execFileAsync(
    authenticatedCommandPath,
    ["commander-xp-episode-bundle", episodeRequestID, outputPath],
    {
      maxBuffer: 1024 * 1024,
      env: process.env,
    },
  );
}

async function parseEpisodeBundle(
  bundlePath: string,
  episodeRequestID: string,
): Promise<{
  manifest: Record<string, unknown>;
  manifestSha256: string;
  outerZipSha256: string;
  members: Array<{ path: string; size: number; sha256: string }>;
  resultsText: string;
  replayBytes: Uint8Array;
  gameLogText: string;
}> {
  const outerBytes = new Uint8Array(await fs.readFile(bundlePath));
  if (
    outerBytes.byteLength === 0 ||
    outerBytes.byteLength > 512 * 1024 * 1024
  ) {
    throw new Error("episode bundle byte length is invalid");
  }
  const zip = await JSZip.loadAsync(outerBytes, {
    checkCRC32: true,
    createFolders: false,
  });
  const entries = Object.values(zip.files);
  const expected = ["logs/game.log", "manifest.json", "replay", "results.json"];
  const names = entries.map((entry) => entry.name).sort();
  if (
    entries.some(
      (entry) =>
        entry.dir ||
        entry.name.startsWith("/") ||
        entry.name.includes("\\") ||
        entry.name.split("/").includes(".."),
    ) ||
    JSON.stringify(names) !== JSON.stringify(expected)
  ) {
    throw new Error("episode bundle entry allowlist mismatch");
  }
  const bytesByPath = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const bytes = await entry.async("uint8array");
    if (bytes.byteLength > 256 * 1024 * 1024) {
      throw new Error("episode bundle member exceeds bounded limit");
    }
    bytesByPath.set(entry.name, bytes);
  }
  const decode = (name: string): string =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytesByPath.get(name)!);
  const manifestText = decode("manifest.json");
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(manifest).sort()) !==
      JSON.stringify(["ereq_id", "files", "include", "status"]) ||
    manifest.ereq_id !== episodeRequestID ||
    manifest.status !== "success" ||
    JSON.stringify(manifest.include) !==
      JSON.stringify(["results", "replay", "game_logs"]) ||
    JSON.stringify(manifest.files) !==
      JSON.stringify({
        results: "results.json",
        replay: "replay",
        game_logs: { combined: "logs/game.log" },
      })
  ) {
    throw new Error("episode bundle manifest mismatch");
  }
  const members = expected.map((memberPath) => {
    const bytes = bytesByPath.get(memberPath)!;
    return { path: memberPath, size: bytes.byteLength, sha256: sha256(bytes) };
  });
  return {
    manifest,
    manifestSha256: sha256(manifestText),
    outerZipSha256: sha256(outerBytes),
    members,
    resultsText: decode("results.json"),
    replayBytes: bytesByPath.get("replay")!,
    gameLogText: decode("logs/game.log"),
  };
}

async function coworld(
  authenticatedCommandPath: string,
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync(authenticatedCommandPath, args, {
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  return stdout;
}

function mappingKey(input: {
  phase: string;
  replicaIndex: number;
  arm: string;
}): string {
  return `${input.phase}:${input.replicaIndex}:${input.arm}`;
}

export function exactCollectorRequestMapping(
  requests: CollectorInput["requests"],
  planned: readonly CommanderXpPlannedRequest[],
): Map<string, CollectorInput["requests"][number]> {
  const mapping = new Map(
    requests.map((entry) => [mappingKey(entry), entry] as const),
  );
  if (
    requests.length !== planned.length ||
    mapping.size !== planned.length ||
    planned.some((request) => !mapping.has(mappingKey(request)))
  ) {
    throw new Error(
      "collector mapping does not exactly cover the sealed phase",
    );
  }
  return mapping;
}

function runDirectory(request: CommanderXpPlannedRequest): string {
  return `runs/${request.phase}/r${String(request.replicaIndex).padStart(2, "0")}/${request.arm}`;
}

export function collectorPriorLedgerFilename(
  phase: CollectorInput["phase"],
): string | null {
  switch (phase) {
    case "preregistration":
      return null;
    case "provider-preflight":
      return "commander-xp-prereg-ledger-v2.json";
    case "canary":
      return "commander-xp-provider-preflight-ledger-v2.json";
    case "confirmatory":
      return "commander-xp-canary-ledger-v2.json";
  }
}

export async function copyCollectorPhaseAuthority(
  input: Pick<
    CollectorInput,
    | "phase"
    | "preregistrationLedgerPath"
    | "providerPreflightLedgerPath"
    | "canaryLedgerPath"
    | "confirmatoryActivationPath"
  >,
  outputDirectory: string,
): Promise<string[]> {
  const copy = async (source: string, target: string): Promise<string> => {
    await fs.copyFile(
      path.resolve(source),
      path.join(outputDirectory, target),
      fs.constants.COPYFILE_EXCL,
    );
    return target;
  };
  if (input.phase === "preregistration") {
    if (
      input.preregistrationLedgerPath !== undefined ||
      input.providerPreflightLedgerPath !== undefined ||
      input.canaryLedgerPath !== undefined ||
      input.confirmatoryActivationPath !== undefined
    ) {
      throw new Error("preregistration must not accept phase ledgers");
    }
    return [];
  }
  if (input.preregistrationLedgerPath === undefined) {
    throw new Error("collector preregistration ledger is required");
  }
  const copied = [
    await copy(
      input.preregistrationLedgerPath,
      "commander-xp-prereg-ledger-v2.json",
    ),
  ];
  if (input.phase === "provider-preflight") {
    if (
      input.providerPreflightLedgerPath !== undefined ||
      input.canaryLedgerPath !== undefined ||
      input.confirmatoryActivationPath !== undefined
    ) {
      throw new Error("provider preflight must not accept later phase ledgers");
    }
    return copied;
  }
  if (input.providerPreflightLedgerPath === undefined) {
    throw new Error("collector provider-preflight ledger is required");
  }
  copied.push(
    await copy(
      input.providerPreflightLedgerPath,
      "commander-xp-provider-preflight-ledger-v2.json",
    ),
  );
  if (input.phase === "canary") {
    if (input.canaryLedgerPath !== undefined) {
      throw new Error("canary collection must not accept a canary ledger");
    }
    if (input.confirmatoryActivationPath !== undefined) {
      throw new Error("canary collection must not accept an activation");
    }
    return copied;
  }
  if (input.canaryLedgerPath === undefined) {
    throw new Error("collector canary ledger is required");
  }
  if (input.confirmatoryActivationPath === undefined) {
    throw new Error("collector confirmatory activation is required");
  }
  copied.push(
    await copy(input.canaryLedgerPath, "commander-xp-canary-ledger-v2.json"),
    await copy(
      input.confirmatoryActivationPath,
      "commander-xp-confirmatory-activation-v2.json",
    ),
  );
  return copied;
}

async function writeJsonExclusive(
  target: string,
  value: unknown,
): Promise<void> {
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

const NAMESPACE_KEYS = [
  "decisionRequestID",
  "episodeID",
  "episodeRequestID",
  "jobID",
  "providerRequestID",
  "replayPath",
  "replayURLSha256",
  "runKey",
  "xpRequestID",
] as const;

type NamespaceKey = (typeof NAMESPACE_KEYS)[number];
type NamespaceRegistry = {
  schemaVersion: 2;
  mode: "cumulative-per-namespace";
  priorRegistrySha256: string | null;
  namespaces: Record<NamespaceKey, string[]>;
  registrySha256: string;
};

export async function buildCollectorNamespaceRegistry(
  evidenceRoot: string,
  planned: readonly CommanderXpPlannedRequest[],
  priorLedgerPath: string | null,
): Promise<NamespaceRegistry> {
  const prior =
    priorLedgerPath === null
      ? null
      : validateCollectorNamespaceRegistry(
          (
            JSON.parse(await fs.readFile(priorLedgerPath, "utf8")) as {
              namespaceRegistry?: unknown;
            }
          ).namespaceRegistry,
        );
  const current = Object.fromEntries(
    NAMESPACE_KEYS.map((key) => [key, new Map<string, string>()]),
  ) as Record<NamespaceKey, Map<string, string>>;
  const register = (
    namespace: NamespaceKey,
    value: unknown,
    owner: string,
    allowSameOwner = false,
  ): void => {
    if (typeof value !== "string" || value.length === 0 || value.length > 500) {
      throw new Error(`collector namespace ${namespace} value is invalid`);
    }
    const previous = current[namespace].get(value);
    if (previous !== undefined && (!allowSameOwner || previous !== owner)) {
      throw new Error(`collector namespace ${namespace} is reused`);
    }
    current[namespace].set(value, owner);
  };
  for (const request of planned) {
    const owner = runDirectory(request);
    register("runKey", request.runKey, owner);
    const xp = JSON.parse(
      await fs.readFile(
        path.join(evidenceRoot, owner, "xp-evidence.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    for (const key of [
      "xpRequestID",
      "episodeRequestID",
      "jobID",
      "episodeID",
      "replayPath",
      "replayURLSha256",
    ] as const) {
      register(key, xp[key], owner);
    }
    const gameEvidencePath = path.join(
      evidenceRoot,
      owner,
      "game-evidence.jsonl",
    );
    try {
      const gameEvidence = await fs.readFile(gameEvidencePath, "utf8");
      for (const [index, line] of gameEvidence.split(/\r?\n/).entries()) {
        if (line === "") continue;
        const record = JSON.parse(line) as Record<string, unknown>;
        register("decisionRequestID", record.requestID, owner, true);
        if (typeof record.requestID !== "string") {
          throw new Error(
            `collector game evidence line ${index + 1} is invalid`,
          );
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    const playerTrace = await fs.readFile(
      path.join(evidenceRoot, owner, "player-artifact/trace.jsonl"),
      "utf8",
    );
    for (const [index, line] of playerTrace.split(/\r?\n/).entries()) {
      if (line === "") continue;
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.recordType === "provider") {
        register("providerRequestID", record.requestID, owner, true);
      } else if (record.recordType !== "decision") {
        throw new Error(`collector player trace line ${index + 1} is invalid`);
      }
    }
  }
  const namespaces = Object.fromEntries(
    NAMESPACE_KEYS.map((key) => {
      const union = new Set(prior?.namespaces[key] ?? []);
      for (const value of current[key].keys()) {
        if (union.has(value)) {
          throw new Error(`collector namespace ${key} reuses prior identity`);
        }
        union.add(value);
      }
      return [key, [...union].sort()];
    }),
  ) as Record<NamespaceKey, string[]>;
  const body = {
    schemaVersion: 2 as const,
    mode: "cumulative-per-namespace" as const,
    priorRegistrySha256: prior?.registrySha256 ?? null,
    namespaces,
  };
  return { ...body, registrySha256: sha256(externalCanonicalJson(body)) };
}

function validateCollectorNamespaceRegistry(value: unknown): NamespaceRegistry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("collector prior namespace registry is missing");
  }
  const registry = value as Partial<NamespaceRegistry>;
  if (
    registry.schemaVersion !== 2 ||
    registry.mode !== "cumulative-per-namespace" ||
    typeof registry.registrySha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(registry.registrySha256) ||
    registry.namespaces === undefined ||
    NAMESPACE_KEYS.some(
      (key) =>
        !Array.isArray(registry.namespaces?.[key]) ||
        new Set(registry.namespaces[key]).size !==
          registry.namespaces[key].length ||
        registry.namespaces[key].some(
          (entry, index) =>
            typeof entry !== "string" ||
            entry.length === 0 ||
            entry !== [...registry.namespaces![key]].sort()[index],
        ),
    )
  ) {
    throw new Error("collector prior namespace registry is invalid");
  }
  const { registrySha256, ...body } = registry as NamespaceRegistry;
  if (sha256(externalCanonicalJson(body)) !== registrySha256) {
    throw new Error("collector prior namespace registry hash mismatch");
  }
  return registry as NamespaceRegistry;
}

function externalCanonicalJson(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.keys(entry as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((entry as Record<string, unknown>)[key])]),
      );
    }
    return entry;
  };
  return `${JSON.stringify(sort(value))}\n`;
}

function assertPrivacySafeArtifact(text: string, artifact: string): void {
  for (const forbidden of [
    "messageText",
    "commsSlotText",
    "submittedReason",
    "externalRawOutput",
    "rawProviderOutput",
    "rawPrompt",
    "presigned",
    "AWS_",
    "COWORLD_PLAYER_ARTIFACT_UPLOAD_URL",
  ]) {
    if (text.includes(forbidden)) {
      throw new Error(`${artifact} contains forbidden private material`);
    }
  }
}

async function runCli(): Promise<void> {
  if (process.argv.length !== 3) {
    throw new Error("usage: commander-xp-collect <collector-input.json>");
  }
  const input = JSON.parse(
    await fs.readFile(path.resolve(process.argv[2]!), "utf8"),
  ) as CollectorInput;
  console.log(JSON.stringify(await collectCommanderXpEvidence(input)));
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : "collector failed");
    process.exit(1);
  });
}
