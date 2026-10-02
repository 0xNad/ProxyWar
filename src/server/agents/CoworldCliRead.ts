import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const defaultCoworldServer = "https://softmax.com/api";
const readVerbs = new Set([
  "leagues",
  "results",
  "memberships",
  "rounds",
  "episodes",
  "replays",
]);

type CoworldReadDependencies = {
  runCli?: (args: string[]) => Promise<string>;
  fetchImpl?: typeof fetch;
  server?: string;
};

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr =
    "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return `${error.message}\n${stderr}`;
}

export function isCoworldRoundListPaginationShapeError(
  error: unknown,
): boolean {
  const text = errorText(error);
  return (
    text.includes("RoundListPublic") &&
    text.includes("total_count") &&
    text.includes("limit") &&
    text.includes("offset") &&
    text.includes("Field required")
  );
}

export function coworldRoundListUrl(
  args: string[],
  server = defaultCoworldServer,
): URL {
  if (args[0] !== "rounds") {
    throw new Error("Coworld round-list fallback only accepts rounds");
  }
  const url = new URL(`${server.replace(/\/$/, "")}/observatory/v2/rounds`);
  const optionNames = new Map([
    ["-l", "league_id"],
    ["--league", "league_id"],
    ["-d", "division_id"],
    ["--division", "division_id"],
    ["--status", "status"],
    ["--limit", "limit"],
    ["--offset", "offset"],
  ]);
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    const queryName = optionNames.get(option);
    if (queryName === undefined || value === undefined || value.length === 0) {
      throw new Error(
        `Unsupported Coworld round-list fallback argument: ${option ?? "missing"}`,
      );
    }
    url.searchParams.set(queryName, value);
  }
  return url;
}

async function fetchCoworldRoundList(
  args: string[],
  { fetchImpl = fetch, server = defaultCoworldServer }: CoworldReadDependencies,
): Promise<unknown> {
  const url = coworldRoundListUrl(args, server);
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Coworld round-list fallback failed: HTTP ${response.status}`,
    );
  }
  const body = (await response.json()) as unknown;
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    !("entries" in body) ||
    !Array.isArray(body.entries)
  ) {
    throw new Error("Coworld round-list fallback returned an invalid shape");
  }
  return body;
}

export async function readCoworldJson(
  args: string[],
  dependencies: CoworldReadDependencies = {},
): Promise<unknown> {
  const verb = args[0];
  if (!readVerbs.has(verb)) {
    throw new Error(`Refusing non-read coworld verb: ${verb}`);
  }
  const runCli =
    dependencies.runCli ??
    (async (cliArgs: string[]) => {
      const { stdout } = await execFileAsync(
        "uvx",
        ["coworld", ...cliArgs, "--json"],
        { timeout: 180_000, maxBuffer: 128 * 1024 * 1024 },
      );
      return stdout;
    });
  try {
    return JSON.parse(await runCli(args)) as unknown;
  } catch (error) {
    if (verb !== "rounds" || !isCoworldRoundListPaginationShapeError(error)) {
      throw error;
    }
    return fetchCoworldRoundList(args, dependencies);
  }
}
