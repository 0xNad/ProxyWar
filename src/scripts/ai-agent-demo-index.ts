import path from "path";
import { writeAgentDemoIndex } from "../server/agents/AgentDemoIndexWriter";

const args = process.argv.slice(2);
const runsRootDir =
  stringArg(args, "--runs-root=") ??
  path.join(process.cwd(), "artifacts", "ai-league-runs");
const limit = positiveIntegerArg(args, "--limit=", 50);

const result = await writeAgentDemoIndex({
  runsRootDir,
  limit,
});

console.log("Proxy War demo index generated", {
  indexPath: result.indexPath,
  runCount: result.runs.length,
});

function stringArg(args: string[], prefix: string): string | null {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function positiveIntegerArg(
  args: string[],
  prefix: string,
  defaultValue: number,
): number {
  const raw = stringArg(args, prefix);
  if (raw === null || raw === "") {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${prefix}${raw} must be a positive integer`);
  }
  return value;
}
