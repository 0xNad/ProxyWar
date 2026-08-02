import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { computeUnmappedPlayerNames } from "../server/identity/IdentityMatching";
import { loadAgentRegistry } from "../server/identity/IdentityRegistry";

const defaultDataJsonPath = path.join(
  "artifacts",
  "ai-league-runs",
  "league",
  "data.json",
);

const StandingsRowSchema = z.looseObject({ playerName: z.string() });

/**
 * Accepts either the full mirror `data.json` shape (`{ standings: [...] }`,
 * what's actually served in production) or a bare standings array (what an
 * operator audit like the registry seed's `standings_raw.json` hands off) —
 * a diff tool that only worked against one live shape would be useless for
 * checking a seed or a fixture before it's ever synced to disk. `.looseObject`
 * (not `.strict()`) because a real `data.json` row carries many more fields
 * this script has no use for; only `playerName` is validated.
 */
const DataJsonPayloadSchema = z.union([
  z.array(StandingsRowSchema),
  z.object({ standings: z.array(StandingsRowSchema) }).loose(),
]);

function extractStandingsRows(
  parsed: unknown,
): readonly { playerName: string }[] {
  const payload = DataJsonPayloadSchema.parse(parsed);
  return Array.isArray(payload) ? payload : payload.standings;
}

/**
 * `npm run identity:list-unmapped -- --data-json <path>` — diffs the live
 * (or seed-audit) roster's `playerName` set against the AgentProfile
 * registry's matched player names. Exits non-zero when any live participant
 * has no registered identity, so it gates the same way `identity:validate`
 * does; the acceptance bar (spec Stage 1) is an empty list for the current
 * roster.
 */
async function main(): Promise<void> {
  const dataJsonPath = process.argv.includes("--data-json")
    ? process.argv[process.argv.indexOf("--data-json") + 1]
    : defaultDataJsonPath;
  const registryDir = process.argv.includes("--dir")
    ? process.argv[process.argv.indexOf("--dir") + 1]
    : undefined;

  const raw = await fs.readFile(dataJsonPath, "utf8");
  const rows = extractStandingsRows(JSON.parse(raw));
  const agents = await loadAgentRegistry(
    registryDir === undefined ? undefined : path.join(registryDir, "agents.json"),
  );

  const unmapped = computeUnmappedPlayerNames(
    rows.map((row) => row.playerName),
    agents,
  );

  console.log(
    `identity:list-unmapped — ${rows.length} live participant(s), ${agents.length} registered agent(s)`,
  );
  if (unmapped.length === 0) {
    console.log("identity:list-unmapped — OK (0 unmapped)");
    return;
  }
  for (const playerName of unmapped) {
    console.error(`UNMAPPED ${playerName}`);
  }
  console.error(`identity:list-unmapped — FAILED (${unmapped.length} unmapped)`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
