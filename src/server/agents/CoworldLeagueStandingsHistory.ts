import { promises as fs } from "node:fs";
import type { CoworldLeagueMirrorData } from "./CoworldLeagueSiteWriter";

/**
 * Persistent per-sync standings snapshot history — the store the
 * score/rank-over-time graphs need (product overhaul spec: stats
 * time-series). `CoworldLeagueSiteWriter.ts`'s `data.json` is overwritten
 * every publish with only the CURRENT standings, by design (so pages always
 * show the latest truth without a stale-read race) — which is exactly why
 * the standings table's "Movement" column has rendered a static em-dash
 * since the league page shipped: there has never been anywhere to read a
 * PREVIOUS standing from.
 *
 * This module is the fix, following this repo's existing pure-`*Core`
 * (computation) split: `CoworldLeagueSiteWriter.ts` owns reading/writing
 * `standings-history.json` inside its existing write-lock, right alongside
 * `data.json`, using the exact same atomic-write + last-good discipline.
 * Every consumer of the resulting series (`AgentTimeSeries.ts`) must label
 * it "recorded since <first snapshot>" — there is no legitimate way to
 * backfill this file (the mirror's own `data.json` is overwritten in place
 * and retains no prior snapshots, and no other on-disk artifact holds a
 * historical per-round score either — see the product-overhaul graphs task
 * notes). History only ever starts accumulating the moment this code
 * deploys, and is never interpolated across a gap.
 */

export interface StandingsHistoryAgentEntry {
  readonly playerName: string;
  readonly score: number | null;
  readonly rank: number;
  /** Best-known live policy label at snapshot time — active champion label preferred, falling back to the rating label, matching `CoworldLeagueStandingRow`'s own fallback order elsewhere in this codebase. */
  readonly activeVersionLabel: string | null;
}

export interface StandingsHistorySnapshot {
  readonly recordedAt: string;
  readonly roundNumber: number | null;
  /** Sorted by `playerName` for a deterministic, diffable file. */
  readonly agents: readonly StandingsHistoryAgentEntry[];
}

export interface StandingsHistoryStore {
  readonly schemaVersion: 1;
  readonly snapshots: readonly StandingsHistorySnapshot[];
}

export const EMPTY_STANDINGS_HISTORY_STORE: StandingsHistoryStore = {
  schemaVersion: 1,
  snapshots: [],
};

/**
 * Builds this publish's candidate snapshot from the mirror data about to be
 * written. `null` when there is nothing honest to record: a stale republish
 * (no fresh sync happened this cycle — recording one would misdate a
 * duplicate point under a new timestamp) or empty standings (nothing to
 * snapshot yet, e.g. cold start).
 */
export function snapshotFromMirrorData(
  data: CoworldLeagueMirrorData,
): StandingsHistorySnapshot | null {
  if (data.stale || data.standings.length === 0) return null;
  return {
    recordedAt: data.generatedAt,
    roundNumber: data.league.currentRoundNumber,
    agents: data.standings
      .map((row) => ({
        playerName: row.playerName,
        score: row.score,
        rank: row.rank,
        activeVersionLabel:
          row.activeChampionPolicyLabel ??
          row.ratingPolicyLabel ??
          row.policyLabel ??
          null,
      }))
      .slice()
      .sort((a, b) => a.playerName.localeCompare(b.playerName)),
  };
}

function sameSnapshotContent(
  a: StandingsHistorySnapshot,
  b: StandingsHistorySnapshot,
): boolean {
  if (a.roundNumber !== b.roundNumber) return false;
  if (a.agents.length !== b.agents.length) return false;
  for (let i = 0; i < a.agents.length; i++) {
    const x = a.agents[i];
    const y = b.agents[i];
    if (
      x.playerName !== y.playerName ||
      x.score !== y.score ||
      x.rank !== y.rank ||
      x.activeVersionLabel !== y.activeVersionLabel
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Appends `snapshot`, deduped: when the last stored snapshot already
 * carries the identical round number and per-agent (score, rank,
 * activeVersionLabel) set, this is a no-op poll and the store comes back
 * UNCHANGED (same array reference) rather than growing with an identical
 * point on every ~30s mirror sync — the common case between real score/rank
 * movement. A genuine change (score, rank, active version, or round number)
 * always appends, even mid-round.
 */
export function appendStandingsHistorySnapshot(
  store: StandingsHistoryStore,
  snapshot: StandingsHistorySnapshot,
): StandingsHistoryStore {
  const last = store.snapshots[store.snapshots.length - 1];
  if (last !== undefined && sameSnapshotContent(last, snapshot)) {
    return store;
  }
  return { schemaVersion: 1, snapshots: [...store.snapshots, snapshot] };
}

/**
 * Tolerant parse. Returns the literal string `"corrupt"` rather than
 * throwing OR silently resetting to empty: either of those would either
 * fail a league publish over a recoverable file, or quietly discard real
 * accumulated history by treating corruption as "start over". The caller
 * (`CoworldLeagueSiteWriter.ts`) reacts to `"corrupt"` by skipping today's
 * append/write entirely — never overwriting a corrupt-but-possibly-
 * recoverable file — while still publishing `data.json`/`read-model.json`
 * normally (a broken history file must never fail a league publish).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseStandingsHistoryStore(
  raw: string,
): StandingsHistoryStore | "corrupt" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "corrupt";
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.snapshots)
  ) {
    return "corrupt";
  }
  // Shallow structural validation just confirmed schemaVersion/snapshots
  // shape; the double cast (Record -> unknown -> the store type) is TS's
  // documented escape hatch for "I've validated more than the compiler can
  // unify" — same trust level `AgentStatsArtifact.ts`'s own reader applies.
  return parsed as unknown as StandingsHistoryStore;
}

/** A missing file (cold start — the store hasn't been written yet) resolves to the empty store, same tolerance level as every other optional-artifact read in this mirror (see `AgentStatsArtifact.ts`'s own doc). A genuinely corrupt file resolves to `"corrupt"` — see `parseStandingsHistoryStore`'s doc for why that is deliberately NOT collapsed into the empty store here. */
export async function readStandingsHistoryStore(
  filePath: string,
): Promise<StandingsHistoryStore | "corrupt"> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? error.code
        : null;
    if (code === "ENOENT") return EMPTY_STANDINGS_HISTORY_STORE;
    throw error;
  }
  return parseStandingsHistoryStore(raw);
}
