import fs from "node:fs/promises";
import { coworldPublicRunArtifacts } from "./proxywar-public-run-artifacts.ts";

export interface CoworldRunArtifactPaths {
  summaryPath: string;
  spectatorTelemetryPath: string;
  /** Present only when structured deals were enabled for the episode. */
  dealLedgerPath?: string;
}

const publicRunArtifacts = new Set<string>(coworldPublicRunArtifacts);

/**
 * Builds the exact public persisted-artifact subset carried inside the Coworld
 * replay envelope. The full `decisions.jsonl` remains in the private episode
 * artifact directory so server-side derivation and local debugging retain the
 * evidence, but it is never copied into the viewer-facing replay.
 */
export async function coworldInlineRunArtifacts(input: {
  gameRecord: unknown;
  artifacts: CoworldRunArtifactPaths;
}): Promise<Record<string, string>> {
  return {
    "game-record.json": JSON.stringify(input.gameRecord),
    ...(input.artifacts.dealLedgerPath === undefined
      ? {}
      : {
          "deal-ledger.json": await fs.readFile(
            input.artifacts.dealLedgerPath,
            "utf8",
          ),
        }),
    "match-summary.json": await fs.readFile(
      input.artifacts.summaryPath,
      "utf8",
    ),
    "spectator-telemetry.json": await fs.readFile(
      input.artifacts.spectatorTelemetryPath,
      "utf8",
    ),
  };
}

/**
 * Sanitizes both newly-created and historical Coworld replay envelopes before
 * they cross the unauthenticated `/replay` websocket boundary. Filtering here
 * is defense in depth: a legacy replay may already contain a private inline
 * artifact even though current bundle creation excludes it.
 */
export function coworldPublicReplayPayload(payload: unknown): unknown {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return payload;
  }

  const record = payload as Record<string, unknown>;
  const sanitized: Record<string, unknown> = { ...record };
  if (Object.hasOwn(record, "inlineRunArtifacts")) {
    sanitized.inlineRunArtifacts = publicInlineRunArtifacts(
      record.inlineRunArtifacts,
    );
  }

  if (
    record.config !== null &&
    typeof record.config === "object" &&
    !Array.isArray(record.config)
  ) {
    const config = record.config as Record<string, unknown>;
    const { tokens, ...publicConfig } = config;
    const players = Array.isArray(config.players) ? config.players : [];
    sanitized.config = {
      ...publicConfig,
      player_count:
        typeof config.player_count === "number"
          ? config.player_count
          : Array.isArray(tokens)
            ? tokens.length
            : players.length,
    };
  }

  return sanitized;
}

function publicInlineRunArtifacts(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        publicRunArtifacts.has(entry[0]) && typeof entry[1] === "string",
    ),
  );
}
