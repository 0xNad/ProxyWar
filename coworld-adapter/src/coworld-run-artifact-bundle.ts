import fs from "node:fs/promises";

export interface CoworldRunArtifactPaths {
  decisionsPath: string;
  summaryPath: string;
  spectatorTelemetryPath: string;
  /** Present only when structured deals were enabled for the episode. */
  dealLedgerPath?: string;
}

/**
 * Builds the exact persisted-artifact subset carried inside the Coworld replay
 * envelope. `deal-ledger.json` is additive and contains only the finalized
 * structured ledger; raw prompts and private decision-debug fields are never
 * copied into it.
 */
export async function coworldInlineRunArtifacts(input: {
  gameRecord: unknown;
  artifacts: CoworldRunArtifactPaths;
}): Promise<Record<string, string>> {
  return {
    "game-record.json": JSON.stringify(input.gameRecord),
    "decisions.jsonl": await fs.readFile(input.artifacts.decisionsPath, "utf8"),
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
