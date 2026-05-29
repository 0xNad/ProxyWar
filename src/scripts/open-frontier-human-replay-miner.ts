import fs from "fs/promises";
import path from "path";
import {
  buildHumanReplayAnalysis,
  HumanReplayAnalysisReport,
  HumanReplayGameMetadata,
  HumanReplayRecord,
  openFrontReplayUrl,
  writeHumanReplayAnalysisArtifacts,
  writeHumanReplayCorpusArtifacts,
} from "../server/agents/HumanReplayAnalysis";

interface MinerConfig {
  start: string;
  end: string;
  apiBaseUrl: string;
  limit: number;
  maxReplays: number;
  minPlayers: number;
  minDurationSeconds: number;
  windowHours: number;
  lookbackWindows: number;
  topCandidateCount: number;
  requestDelayMs: number;
  includeGameIDs: string[];
  outputID: string;
  refresh: boolean;
  explicitStart: boolean;
}

async function run() {
  const config = configFromArgs(process.argv.slice(2));
  const discovered = await discoverGames(config);
  const selected = selectReplayCandidates(discovered, config);
  const explicitIDs = config.includeGameIDs.filter(
    (gameID) => !selected.some((game) => game.game === gameID),
  );
  const selectedGameIDs = [
    ...explicitIDs,
    ...selected.map((game) => game.game),
  ].slice(0, config.maxReplays + explicitIDs.length);
  if (selectedGameIDs.length === 0) {
    throw new Error("No replay candidates found for the requested window");
  }

  const analyses: HumanReplayAnalysisReport[] = [];
  for (const gameID of selectedGameIDs) {
    const record = await loadReplayRecord(gameID, config);
    analyses.push(
      buildHumanReplayAnalysis({
        record,
        source: localReplayPath(gameID),
        topCandidateCount: config.topCandidateCount,
      }),
    );
    await writeHumanReplayAnalysisArtifacts({
      record,
      source: localReplayPath(gameID),
      directory: replayDirectory(gameID),
      topCandidateCount: config.topCandidateCount,
    });
    if (config.requestDelayMs > 0) {
      await sleep(config.requestDelayMs);
    }
  }

  const corpusDir = path.resolve(
    process.cwd(),
    "artifacts",
    "human-replays",
    "batches",
    safePathSegment(config.outputID),
  );
  const paths = await writeHumanReplayCorpusArtifacts({
    corpusID: config.outputID,
    source: corpusSource(config),
    analyses,
    discoveredGames: discovered,
    directory: corpusDir,
  });
  const selectedPath = path.join(corpusDir, "selected-games.json");
  await fs.writeFile(
    selectedPath,
    `${JSON.stringify(
      selectedGameIDs.map((gameID) => ({
        gameID,
        replayUrl: openFrontReplayUrl(gameID),
        metadata: discovered.find((game) => game.game === gameID) ?? null,
      })),
      null,
      2,
    )}\n`,
  );

  console.log("Human replay mining complete", {
    outputID: config.outputID,
    discovered: discovered.length,
    selected: selectedGameIDs.length,
    report: paths.markdownPath,
    json: paths.jsonPath,
    selectedGames: selectedPath,
  });
}

async function discoverGames(
  config: MinerConfig,
): Promise<HumanReplayGameMetadata[]> {
  const windows = discoveryWindows(config);
  const gamesByID = new Map<string, HumanReplayGameMetadata>();
  for (const window of windows) {
    const games = await discoverGameWindow(config, window);
    for (const game of games) {
      gamesByID.set(game.game, game);
    }
    if (config.requestDelayMs > 0) {
      await sleep(config.requestDelayMs);
    }
  }
  return Array.from(gamesByID.values());
}

async function discoverGameWindow(
  config: MinerConfig,
  window: { start: string; end: string },
): Promise<HumanReplayGameMetadata[]> {
  const url = new URL("/public/games", config.apiBaseUrl);
  url.searchParams.set("start", window.start);
  url.searchParams.set("end", window.end);
  url.searchParams.set("type", "Public");
  url.searchParams.set("mode", "Free For All");
  url.searchParams.set("rankedType", "unranked");
  url.searchParams.set("limit", String(config.limit));
  return (await fetchJsonWithRetry(
    url,
    "discover public games",
  )) as HumanReplayGameMetadata[];
}

function selectReplayCandidates(
  games: HumanReplayGameMetadata[],
  config: MinerConfig,
): HumanReplayGameMetadata[] {
  return games
    .filter(
      (game) =>
        game.numPlayers !== undefined &&
        game.numPlayers >= config.minPlayers &&
        durationSeconds(game) >= config.minDurationSeconds,
    )
    .sort(
      (a, b) =>
        (b.numPlayers ?? 0) - (a.numPlayers ?? 0) ||
        durationSeconds(b) - durationSeconds(a) ||
        String(b.start ?? "").localeCompare(String(a.start ?? "")),
    )
    .slice(0, config.maxReplays);
}

async function loadReplayRecord(
  gameID: string,
  config: MinerConfig,
): Promise<HumanReplayRecord> {
  const filePath = localReplayPath(gameID);
  if (!config.refresh && (await exists(filePath))) {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as HumanReplayRecord;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const url = new URL(
    `/public/game/${encodeURIComponent(gameID)}`,
    config.apiBaseUrl,
  );
  const text = await fetchTextWithRetry(url, `fetch replay ${gameID}`);
  await fs.writeFile(filePath, text);
  return JSON.parse(text) as HumanReplayRecord;
}

function configFromArgs(args: string[]): MinerConfig {
  const explicitStart = stringArg(args, "--start=") !== null;
  const end = stringArg(args, "--end=") ?? new Date().toISOString();
  const maxReplays = positiveIntegerArg(args, "--max-replays=", 5);
  const lookbackWindows = positiveIntegerArg(
    args,
    "--lookback-windows=",
    explicitStart ? 1 : Math.max(1, Math.ceil(maxReplays / 10)),
  );
  const windowHours = positiveIntegerArg(args, "--window-hours=", 48);
  const start =
    stringArg(args, "--start=") ??
    new Date(Date.parse(end) - windowHours * 60 * 60 * 1000).toISOString();
  return {
    start,
    end,
    apiBaseUrl:
      stringArg(args, "--api-base-url=") ?? "https://api.openfront.io",
    limit: positiveIntegerArg(args, "--limit=", 1000),
    maxReplays,
    minPlayers: positiveIntegerArg(args, "--min-players=", 20),
    minDurationSeconds: positiveIntegerArg(
      args,
      "--min-duration-seconds=",
      900,
    ),
    windowHours,
    lookbackWindows,
    topCandidateCount: positiveIntegerArg(args, "--top-candidates=", 5),
    requestDelayMs: nonNegativeIntegerArg(args, "--request-delay-ms=", 250),
    includeGameIDs: listArg(args, "--include-game-id="),
    outputID:
      stringArg(args, "--out-id=") ??
      `recent-ffa-${safePathSegment(start.slice(0, 10))}-${safePathSegment(end.slice(0, 10))}`,
    refresh: args.includes("--refresh"),
    explicitStart,
  };
}

function discoveryWindows(config: MinerConfig): Array<{
  start: string;
  end: string;
}> {
  if (config.explicitStart) {
    return [{ start: config.start, end: config.end }];
  }
  const windows: Array<{ start: string; end: string }> = [];
  let windowEnd = Date.parse(config.end);
  const windowMs = config.windowHours * 60 * 60 * 1000;
  for (let index = 0; index < config.lookbackWindows; index += 1) {
    const windowStart = windowEnd - windowMs;
    windows.push({
      start: new Date(windowStart).toISOString(),
      end: new Date(windowEnd).toISOString(),
    });
    windowEnd = windowStart;
  }
  return windows;
}

function corpusSource(config: MinerConfig): string {
  const windows = discoveryWindows(config);
  const oldestWindow = windows[windows.length - 1] ?? {
    start: config.start,
    end: config.end,
  };
  const newestWindow = windows[0] ?? { start: config.start, end: config.end };
  const url = new URL("/public/games", config.apiBaseUrl);
  url.searchParams.set("start", oldestWindow.start);
  url.searchParams.set("end", newestWindow.end);
  url.searchParams.set("type", "Public");
  url.searchParams.set("mode", "Free For All");
  url.searchParams.set("rankedType", "unranked");
  url.searchParams.set("limit", String(config.limit));
  url.searchParams.set("lookbackWindows", String(windows.length));
  url.searchParams.set("windowHours", String(config.windowHours));
  return url.toString();
}

function durationSeconds(game: HumanReplayGameMetadata): number {
  const start = Date.parse(game.start ?? "");
  const end = Date.parse(game.end ?? "");
  return Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, Math.round((end - start) / 1000))
    : 0;
}

function replayDirectory(gameID: string): string {
  return path.resolve(
    process.cwd(),
    "artifacts",
    "human-replays",
    safePathSegment(gameID),
  );
}

function localReplayPath(gameID: string): string {
  return path.join(replayDirectory(gameID), "game-record.json");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stringArg(args: string[], prefix: string): string | null {
  return (
    args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null
  );
}

function listArg(args: string[], prefix: string): string[] {
  return args
    .filter((arg) => arg.startsWith(prefix))
    .map((arg) => arg.slice(prefix.length))
    .filter(Boolean);
}

function positiveIntegerArg(
  args: string[],
  prefix: string,
  fallback: number,
): number {
  const value = stringArg(args, prefix);
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${prefix}${value} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeIntegerArg(
  args: string[],
  prefix: string,
  fallback: number,
): number {
  const value = stringArg(args, prefix);
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${prefix}${value} must be a non-negative integer`);
  }
  return parsed;
}

async function fetchJsonWithRetry(
  url: URL,
  description: string,
): Promise<unknown> {
  const text = await fetchTextWithRetry(url, description);
  return JSON.parse(text);
}

async function fetchTextWithRetry(
  url: URL,
  description: string,
): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.text();
      }
      lastError = new Error(
        `Failed to ${description}: ${response.status} ${response.statusText}`,
      );
      if (response.status !== 429 && response.status < 500) {
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(750 * (attempt + 1));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
