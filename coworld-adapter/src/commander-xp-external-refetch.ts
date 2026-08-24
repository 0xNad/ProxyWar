/**
 * Independent hosted re-fetch verifier for a sealed Commander XP evidence tree.
 *
 * Raw Coworld responses and bundle bytes remain transient. The only persisted
 * output is a bounded, privacy-safe hash/identity receipt proving that a fresh
 * authenticated read reproduced every sealed projection and player artifact.
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
  type CommanderXpPlannedRequest,
  type CommanderXpPreRegistrationV2,
  type CommanderXpProtocolPhase,
} from "../../src/server/agents/CommanderXpProtocol";
import { assertCommanderXpPreRegistrationDocument } from "../../src/server/agents/CommanderXpVerifier";
import { parseCommanderXpEpisodeBundleBytes } from "./commander-xp-bundle";
import {
  commanderXpEpisodeResultsProjection,
  commanderXpGameEvidenceProjection,
  commanderXpNormalizedRequestReadback,
  commanderXpReplayEvidenceProjection,
  commanderXpXpEvidenceProjection,
} from "./commander-xp-collect";

const execFileAsync = promisify(execFile);

type EvidencePhase = CommanderXpProtocolPhase | "preregistration";

interface EvidenceIndex {
  schemaVersion: 2;
  experimentID: string;
  phase: EvidencePhase;
  preRegistrationSha256: string;
}

interface RefetchRunReceipt {
  runPath: string;
  xpRequestID: string;
  episodeRequestID: string;
  memberSetSha256: string;
  xpEvidenceSha256: string;
  normalizedReadbackSha256: string;
  replayEvidenceSha256: string;
  episodeResultsSha256: string | null;
  gameEvidenceSha256: string | null;
  playerArtifactSha256: string;
}

export async function verifyCommanderXpPlatformRefetch(
  requestedEvidenceRoot: string,
  requestedCommandPath: string,
  requestedOutputPath: string,
): Promise<Record<string, unknown>> {
  const evidenceRoot = await canonicalDirectory(requestedEvidenceRoot);
  const commandPath = await canonicalFile(requestedCommandPath);
  const outputPath = path.resolve(requestedOutputPath);
  const preregistration = await readJson<CommanderXpPreRegistrationV2>(
    path.join(evidenceRoot, "commander-xp-preregistration-v2.json"),
  );
  assertCommanderXpPreRegistrationDocument(preregistration);
  const index = await readJson<EvidenceIndex>(
    path.join(evidenceRoot, "commander-xp-evidence-index-v2.json"),
  );
  if (
    index.schemaVersion !== 2 ||
    index.experimentID !== preregistration.experimentID ||
    index.preRegistrationSha256 !== preregistration.preRegistrationSha256
  ) {
    throw new Error("refetch evidence index identity mismatch");
  }
  const planned = plannedRequests(preregistration, index.phase);
  const runs: RefetchRunReceipt[] = [];
  for (const request of planned) {
    runs.push(
      await refetchRun(evidenceRoot, commandPath, request, index.phase),
    );
  }
  const body = {
    schemaVersion: 2 as const,
    authority: "independent-coworld-0.1.42-refetch-v2" as const,
    experimentID: preregistration.experimentID,
    phase: index.phase,
    preRegistrationSha256: preregistration.preRegistrationSha256,
    verifiedAt: new Date().toISOString(),
    runCount: runs.length,
    runs,
  };
  const result = { ...body, refetchSha256: externalCanonicalSha256(body) };
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
  return result;
}

async function refetchRun(
  evidenceRoot: string,
  commandPath: string,
  planned: CommanderXpPlannedRequest,
  phase: EvidencePhase,
): Promise<RefetchRunReceipt> {
  const relativeRoot = runDirectory(planned);
  const runRoot = path.join(evidenceRoot, relativeRoot);
  const sealedXp = await readJson<Record<string, unknown>>(
    path.join(runRoot, "xp-evidence.json"),
  );
  const receipt = await readJson<Record<string, unknown>>(
    path.join(runRoot, "coworld-bundle-receipt.json"),
  );
  const xpRequestID = String(sealedXp.xpRequestID ?? "");
  const rawXpText = await coworld(commandPath, [
    "xp-request",
    "get",
    xpRequestID,
    "--json",
  ]);
  const rawXp = JSON.parse(rawXpText) as Record<string, unknown>;
  const episodes = Array.isArray(rawXp.episodes) ? rawXp.episodes : [];
  if (rawXp.id !== xpRequestID || episodes.length !== 1) {
    throw new Error(`refetch XP identity mismatch: ${relativeRoot}`);
  }
  const episode = episodes[0] as Record<string, unknown>;
  const episodeRequestID = String(episode.id ?? "");
  const participants = Array.isArray(episode.participants)
    ? episode.participants
    : [];
  const replayURL = String(episode.replay_url ?? "");
  const parsedReplayURL = new URL(replayURL);
  if (parsedReplayURL.protocol !== "https:") {
    throw new Error(`refetch replay URL invalid: ${relativeRoot}`);
  }
  const projectedXp = commanderXpXpEvidenceProjection(
    rawXp,
    xpRequestID,
    episode,
    participants,
    replayURL,
    parsedReplayURL.pathname,
  );
  assertCanonicalEqual(projectedXp, sealedXp, `${relativeRoot}/xp-evidence`);
  const requested = rawXp.requested;
  if (requested === null || typeof requested !== "object") {
    throw new Error(`refetch normalized request missing: ${relativeRoot}`);
  }
  const normalizedReadback = commanderXpNormalizedRequestReadback(requested);
  assertCanonicalEqual(
    normalizedReadback,
    await readJson(path.join(runRoot, "normalized-request-readback.json")),
    `${relativeRoot}/normalized-request-readback`,
  );

  const temporary = await privateRunnerTempDirectory(
    "commander-xp-independent-refetch-",
  );
  try {
    const bundlePath = path.join(temporary, "bundle.zip");
    await execFileAsync(
      commandPath,
      ["commander-xp-episode-bundle", episodeRequestID, bundlePath],
      { maxBuffer: 1024 * 1024, env: process.env },
    );
    const bundle = await parseCommanderXpEpisodeBundleBytes(
      new Uint8Array(await fs.readFile(bundlePath)),
      episodeRequestID,
    );
    const members = bundle.memberHashes.members.map(
      ({ path: memberPath, size, sha256 }) => ({
        path: memberPath,
        bytes: size,
        sha256,
      }),
    );
    assertCanonicalEqual(
      members,
      receipt.members,
      `${relativeRoot}/bundle-members`,
    );
    const manifestMember = members.find(
      (entry) => entry.path === "manifest.json",
    );
    if (
      manifestMember?.sha256 !== receipt.manifestSha256 ||
      receipt.xpRequestID !== xpRequestID ||
      receipt.episodeRequestID !== episodeRequestID
    ) {
      throw new Error(
        `refetch bundle receipt identity mismatch: ${relativeRoot}`,
      );
    }

    const isPreflight = phase === "provider-preflight";
    const rawResults = JSON.parse(bundle.resultsText) as Record<
      string,
      unknown
    >;
    const projectedResults = isPreflight
      ? null
      : commanderXpEpisodeResultsProjection(
          rawResults,
          projectedXp,
          planned.subjectSeat,
        );
    if (projectedResults !== null) {
      assertCanonicalEqual(
        projectedResults,
        await readJson(path.join(runRoot, "episode-results.json")),
        `${relativeRoot}/episode-results`,
      );
    }
    const gameEvidence = isPreflight
      ? null
      : commanderXpGameEvidenceProjection(
          bundle.gameLogText,
          planned.subjectSeat,
        );
    if (
      gameEvidence !== null &&
      gameEvidence !==
        (await fs.readFile(path.join(runRoot, "game-evidence.jsonl"), "utf8"))
    ) {
      throw new Error(`refetch game evidence mismatch: ${relativeRoot}`);
    }
    const replayEvidence = commanderXpReplayEvidenceProjection(
      replayURL,
      projectedXp,
      projectedResults,
      bundle.replayBytes,
    );
    assertCanonicalEqual(
      replayEvidence,
      await readJson(path.join(runRoot, "replay-evidence.json")),
      `${relativeRoot}/replay-evidence`,
    );

    const playerZipPath = path.join(temporary, "player-artifact.zip");
    await execFileAsync(
      commandPath,
      [
        "episode-logs",
        episodeRequestID,
        "--agent",
        String(planned.subjectSeat),
        "--artifact",
        "--output",
        playerZipPath,
      ],
      { maxBuffer: 1024 * 1024, env: process.env },
    );
    const zip = await JSZip.loadAsync(await fs.readFile(playerZipPath), {
      checkCRC32: true,
      createFolders: false,
    });
    const expectedPlayerFiles = [
      "hashes.json",
      "runtime-manifest.json",
      "trace.jsonl",
    ];
    const entries = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .sort((a, b) => a.name.localeCompare(b.name));
    if (
      entries.length !== expectedPlayerFiles.length ||
      entries.some((entry, index) => entry.name !== expectedPlayerFiles[index])
    ) {
      throw new Error(`refetch player artifact set mismatch: ${relativeRoot}`);
    }
    const playerHashes = [];
    for (const entry of entries) {
      const bytes = await entry.async("uint8array");
      const sealed = new Uint8Array(
        await fs.readFile(path.join(runRoot, "player-artifact", entry.name)),
      );
      if (sha256Bytes(bytes) !== sha256Bytes(sealed)) {
        throw new Error(
          `refetch player artifact mismatch: ${relativeRoot}/${entry.name}`,
        );
      }
      playerHashes.push({ path: entry.name, sha256: sha256Bytes(bytes) });
    }

    return {
      runPath: relativeRoot,
      xpRequestID,
      episodeRequestID,
      memberSetSha256: sha256Canonical(members),
      xpEvidenceSha256: await sha256File(
        path.join(runRoot, "xp-evidence.json"),
      ),
      normalizedReadbackSha256: await sha256File(
        path.join(runRoot, "normalized-request-readback.json"),
      ),
      replayEvidenceSha256: await sha256File(
        path.join(runRoot, "replay-evidence.json"),
      ),
      episodeResultsSha256: isPreflight
        ? null
        : await sha256File(path.join(runRoot, "episode-results.json")),
      gameEvidenceSha256: isPreflight
        ? null
        : await sha256File(path.join(runRoot, "game-evidence.jsonl")),
      playerArtifactSha256: sha256Canonical(playerHashes),
    };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

function plannedRequests(
  preregistration: CommanderXpPreRegistrationV2,
  phase: EvidencePhase,
): CommanderXpPlannedRequest[] {
  if (phase === "preregistration") return [];
  const requests =
    phase === "provider-preflight"
      ? preregistration.providerPreflightRequests
      : preregistration.requests.filter((request) => request.phase === phase);
  const expected =
    phase === "provider-preflight" ? 3 : phase === "canary" ? 12 : 96;
  if (requests.length !== expected) {
    throw new Error("refetch request schedule is incomplete");
  }
  return requests;
}

function runDirectory(request: CommanderXpPlannedRequest): string {
  return `runs/${request.phase}/r${String(request.replicaIndex).padStart(2, "0")}/${request.arm}`;
}

async function coworld(commandPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(commandPath, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  return stdout;
}

function assertCanonicalEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): void {
  if (sha256Canonical(actual) !== sha256Canonical(expected)) {
    throw new Error(`independent refetch mismatch: ${label}`);
  }
}

async function readJson<T = unknown>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function canonicalDirectory(requested: string): Promise<string> {
  const absolute = path.resolve(requested);
  const real = await fs.realpath(absolute);
  if (
    !(await fs.stat(real)).isDirectory() ||
    (await fs.lstat(absolute)).isSymbolicLink()
  ) {
    throw new Error("refetch evidence root is invalid");
  }
  return real;
}

async function canonicalFile(requested: string): Promise<string> {
  const absolute = path.resolve(requested);
  const real = await fs.realpath(absolute);
  if (
    !(await fs.stat(real)).isFile() ||
    (await fs.lstat(absolute)).isSymbolicLink()
  ) {
    throw new Error("refetch Coworld command is invalid");
  }
  return real;
}

async function sha256File(filePath: string): Promise<string> {
  return sha256Bytes(new Uint8Array(await fs.readFile(filePath)));
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function externalCanonicalSha256(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry !== null && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, sort(record[key])]),
      );
    }
    return entry;
  };
  return sha256Bytes(
    new TextEncoder().encode(`${JSON.stringify(sort(value))}\n`),
  );
}

async function privateRunnerTempDirectory(prefix: string): Promise<string> {
  const root = await fs.realpath(process.env.RUNNER_TEMP ?? os.tmpdir());
  const directory = await fs.mkdtemp(path.join(root, prefix));
  await fs.chmod(directory, 0o700);
  return directory;
}

async function runCli(): Promise<void> {
  if (process.argv.length !== 5) {
    throw new Error(
      "usage: commander-xp-external-refetch <evidence-root> <coworld-command> <output.json>",
    );
  }
  console.log(
    JSON.stringify(
      await verifyCommanderXpPlatformRefetch(
        process.argv[2]!,
        process.argv[3]!,
        process.argv[4]!,
      ),
    ),
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : "refetch failed");
    process.exitCode = 1;
  });
}
