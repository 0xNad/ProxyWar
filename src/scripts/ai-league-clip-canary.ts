#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import {
  armAiLeagueClipCanary,
  disarmAiLeagueClipCanary,
  readAiLeagueClipCanary,
  type AiLeagueClipCanaryTarget,
} from "../server/agents/AiLeagueClipCanary";

interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export async function runAiLeagueClipCanaryCli(
  argv: readonly string[],
  io: CliIo = {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  },
): Promise<number> {
  try {
    const command = argv[0];
    if (command !== "arm" && command !== "status" && command !== "disarm") {
      throw new Error(
        "usage: clips:canary <arm|status|disarm> --private-state-root <absolute-path>",
      );
    }
    const args = parseArgs(argv.slice(1));
    const privateStateRoot = requireAbsolute(args, "private-state-root");
    if (command === "status") {
      rejectUnknown(args, ["private-state-root"]);
      io.stdout(
        JSON.stringify(await readAiLeagueClipCanary({ privateStateRoot })),
      );
      return 0;
    }
    if (command === "disarm") {
      rejectUnknown(args, ["private-state-root"]);
      io.stdout(
        JSON.stringify(await disarmAiLeagueClipCanary({ privateStateRoot })),
      );
      return 0;
    }
    rejectUnknown(args, [
      "private-state-root",
      "run-key",
      "bucket",
      "source-replay-sha256",
      "expires-at",
    ]);
    const bucket = Number(requireArg(args, "bucket"));
    const target: AiLeagueClipCanaryTarget = {
      runKey: requireArg(args, "run-key"),
      bucket,
      sourceReplaySha256: requireArg(args, "source-replay-sha256"),
    };
    const record = await armAiLeagueClipCanary({
      privateStateRoot,
      target,
      expiresAt: requireArg(args, "expires-at"),
    });
    io.stdout(JSON.stringify({ enabled: true, record }));
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flag?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error("clip_canary_cli_invalid_arguments");
    }
    const name = flag.slice(2);
    if (parsed.has(name)) throw new Error(`clip_canary_cli_duplicate:${name}`);
    parsed.set(name, value);
  }
  return parsed;
}

function requireArg(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (value === undefined || value === "")
    throw new Error(`clip_canary_cli_missing:${name}`);
  return value;
}

function requireAbsolute(args: Map<string, string>, name: string): string {
  const value = requireArg(args, name);
  if (!value.startsWith("/"))
    throw new Error(`clip_canary_cli_not_absolute:${name}`);
  return value;
}

function rejectUnknown(
  args: Map<string, string>,
  accepted: readonly string[],
): void {
  const allowed = new Set(accepted);
  const unknown = [...args.keys()].filter((name) => !allowed.has(name));
  if (unknown.length > 0)
    throw new Error(`clip_canary_cli_unknown:${unknown.join(",")}`);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  process.exitCode = await runAiLeagueClipCanaryCli(process.argv.slice(2));
}
