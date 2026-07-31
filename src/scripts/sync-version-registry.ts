import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  findAgentForPlayerName,
  resolveObservedVersion,
} from "../server/identity/IdentityMatching";
import type { AgentProfile, AgentVersion } from "../server/identity/IdentitySchemas";
import {
  loadIdentityRegistrySnapshot,
  saveAgentVersionRegistry,
} from "../server/identity/IdentityRegistry";

/**
 * Product overhaul spec Stage 6 item 2: records `firstObservedAt` on
 * `AgentVersion` registry records the moment the mirror first sees a new
 * version label under an agent's own family — `IdentityMatching.ts`'s
 * `resolveObservedVersion` already computes this exact signal for
 * rendering (`registered === null && !familyMismatch` — "a fresh version
 * bump ... a normal 'new observed version'", per its own doc), this script
 * is the first thing that DOES something with it: creates the missing
 * `AgentVersion` registry record, timestamped now.
 *
 * Deliberately a separate periodic batch job, same operational shape as
 * `compute-agent-stats.ts` (see that script's own doc for why), not a hook
 * inside the live 30-second mirror sync loop: `coworldLeagueIndexHtml` /
 * `writeCoworldLeagueSite` are exercised as pure rendering functions today
 * (see `CoworldLeagueSiteWriterIdentity.test.ts`), and giving the render
 * path a registry side effect would need its own concurrency-safety
 * review this task doesn't have room for. This script instead reads the
 * mirror's own already-published `data.json` (exactly "when a new version
 * label appears in mirror data" — the live poll's most recent committed
 * output) and writes back through the existing `saveAgentVersionRegistry`.
 *
 * Backfill: investigated and NOT possible from data currently on disk.
 * Retained local run artifacts (`spectator-telemetry.json`,
 * `match-summary.json`, `decisions.jsonl`) carry no Softmax policy label
 * at all — policy labels are a Coworld-hosted-mirror concept the local
 * league runner never touches. The mirror's own `data.json` is
 * overwritten every 30s with no historical log, and
 * `resources/identity/versions.json` has exactly one commit (the Stage 1
 * seed) in git history. There is genuinely no "first seen" timestamp to
 * recover for the 17 pre-existing seed records; they stay
 * `firstObservedAt: null` until this script (or a future live poll) next
 * observes their exact policy label as a "new" one — which, for an
 * ALREADY-registered version, never happens again (only a version BUMP
 * re-triggers detection). Honest gap, not fabricated.
 */

interface LiveStandingRow {
  playerName: string;
  ratingPolicyLabel: string | null;
  activeChampionPolicyLabel: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLiveStandings(mirrorData: unknown): LiveStandingRow[] {
  if (!isRecord(mirrorData) || !Array.isArray(mirrorData.standings)) {
    return [];
  }
  const rows: LiveStandingRow[] = [];
  for (const raw of mirrorData.standings) {
    if (!isRecord(raw) || typeof raw.playerName !== "string") continue;
    rows.push({
      playerName: raw.playerName,
      ratingPolicyLabel:
        typeof raw.ratingPolicyLabel === "string" ? raw.ratingPolicyLabel : null,
      activeChampionPolicyLabel:
        typeof raw.activeChampionPolicyLabel === "string"
          ? raw.activeChampionPolicyLabel
          : null,
    });
  }
  return rows;
}

/** `v24` -> `24` (the existing registry ID convention, e.g. `agtv_daveey_v24`); falls back to a sanitized full label if stripping the leading `v` leaves nothing usable, so a malformed-but-non-empty label never produces an invalid id. */
function versionIdSuffix(publicVersionLabel: string): string {
  const stripped = publicVersionLabel.replace(/^v/i, "");
  const sanitized = (stripped.length > 0 ? stripped : publicVersionLabel)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return sanitized.length > 0 ? sanitized : "0";
}

/**
 * Pure: given live standings, the registered agents, and the CURRENT
 * version registry, returns the `AgentVersion` records that don't exist
 * yet and should be created — one per live row whose observed policy
 * label is a genuine same-family version bump
 * (`resolveObservedVersion`'s `registered === null && !familyMismatch`).
 * Never touches an agent with no registered `AgentProfile` (exact
 * `playerName` match only, same account-takeover guard
 * `IdentityMatching.ts` already enforces) and never edits an EXISTING
 * version record.
 */
export function detectNewlyObservedVersions(
  standings: readonly LiveStandingRow[],
  agents: readonly AgentProfile[],
  existingVersions: readonly AgentVersion[],
  now: string,
): AgentVersion[] {
  const created: AgentVersion[] = [];
  const knownIds = new Set(existingVersions.map((v) => v.id));
  const knownLabelsByAgent = new Map(
    existingVersions.map((v) => [`${v.agentId}|${v.softmaxPolicyLabel}`, true]),
  );
  for (const row of standings) {
    const agent = findAgentForPlayerName(row.playerName, agents);
    if (agent === null) continue;
    const observed = resolveObservedVersion(
      agent,
      [...existingVersions, ...created],
      row,
    );
    if (observed === null || observed.registered !== null) continue;
    if (observed.familyMismatch || observed.publicVersionLabel === null) continue;
    if (knownLabelsByAgent.has(`${agent.id}|${observed.policyLabel}`)) continue;
    const id = `agtv_${agent.slug}_v${versionIdSuffix(observed.publicVersionLabel)}`;
    if (knownIds.has(id)) continue;
    knownIds.add(id);
    knownLabelsByAgent.set(`${agent.id}|${observed.policyLabel}`, true);
    created.push({
      id,
      agentId: agent.id,
      publicVersionLabel: observed.publicVersionLabel,
      softmaxPolicyLabel: observed.policyLabel,
      immutableDigest: null,
      releaseDate: null,
      releaseNotes: null,
      declaredBaseModel: null,
      scaffoldDescription: null,
      sourceRepositoryRef: null,
      disclosureStatus: "undisclosed",
      qualificationStatus: "active",
      observedVia: [observed.source],
      observedAt: now,
      firstObservedAt: now,
    });
  }
  return created;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dataPathIndex = args.indexOf("--data-path");
  const dataPath =
    dataPathIndex >= 0
      ? args[dataPathIndex + 1]
      : path.resolve(
          process.cwd(),
          "artifacts/ai-league-runs/league/data.json",
        );
  const registryDirIndex = args.indexOf("--registry-dir");
  const registryDir =
    registryDirIndex >= 0 ? args[registryDirIndex + 1] : undefined;

  const [identity, dataRaw] = await Promise.all([
    loadIdentityRegistrySnapshot(registryDir),
    fs.readFile(dataPath, "utf8").catch(() => null),
  ]);
  if (dataRaw === null) {
    console.log(
      `sync-version-registry: no mirror data at ${dataPath}; nothing to detect.`,
    );
    return;
  }
  const standings = readLiveStandings(JSON.parse(dataRaw));
  const now = new Date().toISOString();
  const newVersions = detectNewlyObservedVersions(
    standings,
    identity.agents,
    identity.versions,
    now,
  );
  if (newVersions.length === 0) {
    console.log(
      "sync-version-registry: no new version labels detected; registry unchanged.",
    );
    return;
  }
  const versionsPath =
    registryDir === undefined
      ? undefined
      : path.join(registryDir, "versions.json");
  await saveAgentVersionRegistry(
    [...identity.versions, ...newVersions],
    versionsPath,
  );
  console.log(
    `sync-version-registry: recorded ${newVersions.length} newly observed version(s): ${newVersions
      .map((v) => v.softmaxPolicyLabel)
      .join(", ")}`,
  );
}

// Guarded (unlike this repo's other scripts) because `detectNewlyObservedVersions`
// above is a pure, directly unit-tested export — importing this module for
// that test must never also run `main()`'s real file I/O as a side effect.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
