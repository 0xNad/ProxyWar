import type {
  SpectatorEvent,
  SpectatorTelemetry,
} from "./AgentSpectatorTelemetry";

/**
 * Product overhaul spec Stage 6: strategic fingerprint + social record
 * computation, per spec item 2 ("every dimension with documented
 * calculation + minimum sample threshold; hide below threshold; no
 * arbitrary personality percentages") and item 6 ("one computation source,
 * two views, never divergent numbers" between `/agent/:slug` and
 * `/player/:name`).
 *
 * Every ratio here has a NAMED event-level numerator and a NAMED real
 * denominator — never a within-match proxy standing in for missing data.
 * Two corrections from an earlier methodology draft, both verified against
 * this repo's actual data before shipping:
 *
 * 1. Alliance acceptance rate is NEVER derived from `relationships[].
 *    allianceState` (a final-match-state snapshot with no offer/accept/
 *    reject counts). It is derived purely from `SpectatorEvent` history:
 *    `alliance_request` events name who OFFERED an alliance to whom;
 *    `alliance_formed` events (verified present in
 *    `AgentSpectatorTelemetry.ts`'s own event generation — see its
 *    `case "alliance_request"` branch, which promotes the SECOND of two
 *    mutual requests to `alliance_formed`) name which offered pairs
 *    actually completed. offers-received(X) = distinct actors of
 *    `alliance_request` events targeting X; accepted(X) = distinct
 *    counterparts of `alliance_formed` events touching X. Both are real,
 *    countable event sets.
 * 2. Territory share's denominator is the map's REAL land-tile count from
 *    `resources/maps/<map>/manifest.json` (`map.num_land_tiles` for
 *    `GameMapSize.Normal`, `map4x.num_land_tiles` for `Compact` — see
 *    `TerrainMapLoader.ts`'s own `loadTerrainMap`, which picks the exact
 *    same tier by the exact same rule at live-game load time) — never
 *    `max(finalTilesOwned)` within the match. When the manifest can't be
 *    resolved (unknown map name, missing resource), territory share is
 *    reported as absolute tiles + rank-relative share instead of a
 *    denominator-less percentage — see `TerritoryShareResult`.
 *
 * File I/O (reading retained run artifacts, resolving map manifests) is
 * owned entirely by the calling script (`compute-agent-stats.ts`) — this
 * module is pure, matching every other `*Core.ts`/`*Pipeline.ts` module in
 * this codebase.
 */

// ---------------------------------------------------------------------------
// Sample thresholds — every metric below documents its own; consolidated
// here so every threshold used anywhere in this module has one visible
// source of truth.
// ---------------------------------------------------------------------------

const AGGRESSION_MIN_EVENTS = 50;
const DIPLOMACY_MIN_EVENTS = 30;
const ECONOMIC_MIN_EVENTS = 40;
const ACCEPTANCE_MIN_OFFERS = 2;
const TREATY_DURATION_MIN_BROKEN = 2;
const TERRITORY_MIN_EPISODES = 1;
const ARMY_STRENGTH_MIN_EPISODES = 1;
const ALLIANCES_INITIATED_MIN = 1;
const BETRAYAL_MIN = 1;

const ECONOMIC_ACTION_KINDS = new Set<SpectatorEvent["actionKind"]>([
  "build",
  "embargo",
  "upgrade_structure",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single computed ratio/count with its own methodology string and sample-threshold test, per spec item 2. `null` when the underlying data doesn't exist at all (never fabricated as 0). */
export interface AgentMetric {
  value: number;
  sampleSize: number;
  threshold: number;
  methodology: string;
}

export interface TerritoryShareResult {
  /** `finalTilesOwned / realLandTileCount` when the map manifest resolved for every contributing episode; `null` otherwise. */
  share: AgentMetric | null;
  /** Always present when there's at least one qualifying episode: mean absolute tiles owned, and mean rank among that episode's participants (1 = most territory). Never gated on manifest resolution — this is the honest fallback the spec allows when the real denominator isn't reachable. */
  absoluteTiles: { mean: number; sampleSize: number } | null;
  meanRank: { value: number; sampleSize: number } | null;
}

export interface AgentFingerprint {
  aggression: AgentMetric | null;
  diplomacyInitiated: AgentMetric | null;
  economicFocus: AgentMetric | null;
  territory: TerritoryShareResult;
  /** Relative army strength (finalTroops / sum of all finalTroops in the match), meaned across qualifying episodes. */
  armyStrength: AgentMetric | null;
}

export interface NamedCount {
  name: string;
  count: number;
}

export interface AgentSocialRecord {
  alliancesInitiated: AgentMetric | null;
  allianceAcceptanceRate: AgentMetric | null;
  betrayalCount: AgentMetric | null;
  /** Top allies by co-occurrence (distinct episodes with an "allied" relationship), highest first. */
  frequentAllies: readonly NamedCount[];
  /** Top adversaries by attacksSent + attacksReceived, highest first. */
  primaryAdversaries: readonly NamedCount[];
  treatyDuration: AgentMetric | null;
}

export interface AgentStatsSlice {
  episodeCount: number;
  fingerprint: AgentFingerprint;
  social: AgentSocialRecord;
}

// ---------------------------------------------------------------------------
// Per-match raw extraction — pure, one match + one player name in.
// ---------------------------------------------------------------------------

/** Intermediate per-match counts for one agent, before cross-match aggregation. Exported so the aggregator's unit tests can construct fixtures directly without round-tripping through a full SpectatorTelemetry object every time. */
export interface RawMatchAgentMetrics {
  totalEventCount: number;
  attackCount: number;
  allianceRequestCount: number;
  economicActionCount: number;
  finalTilesOwned: number | null;
  realLandTileCount: number | null;
  rank: number | null;
  finalTroops: number | null;
  relativeArmyStrength: number | null;
  alliancesInitiatedCount: number;
  offersReceivedFrom: ReadonlySet<string>;
  offersAcceptedWith: ReadonlySet<string>;
  betrayalCount: number;
  /** Distinct co-occurring allies this episode, by name. */
  alliedNames: readonly string[];
  /** Adversary name -> attacksSent + attacksReceived, this episode only. */
  adversaryCounts: ReadonlyMap<string, number>;
  /** Turn spans (alliance_formed -> alliance_break) for pairs that broke, this episode only. */
  treatyDurationsTurns: readonly number[];
}

/**
 * Extracts one agent's raw metrics from one match's telemetry. `agentID`
 * (not username) — the caller resolves the cross-match stable identity
 * (username/playerName) separately, matching `LeaguePlayerProfile.ts`'s
 * own join key.
 */
export function computeMatchAgentMetrics(
  telemetry: SpectatorTelemetry,
  agentID: string,
  realLandTileCount: number | null,
): RawMatchAgentMetrics | null {
  const self = telemetry.agents.find((agent) => agent.agentID === agentID);
  if (self === undefined) {
    return null;
  }
  const agentEvents = telemetry.events.filter(
    (event) => event.actorAgentID === agentID,
  );
  const totalEventCount = agentEvents.length;
  const attackCount = agentEvents.filter(
    (event) => event.kind === "attack",
  ).length;
  // `event.actionKind` (the RAW submitted action) is used here, never
  // `event.kind` (the NARRATIVE event kind): when a second agent's own
  // alliance_request action happens to complete a mutual pact, the
  // telemetry builder relabels THAT event's `kind` as "alliance_formed"
  // (see AgentSpectatorTelemetry.ts's `case "alliance_request"` — the
  // SECOND of two mutual requests becomes a formed-alliance event, not a
  // request event). `actionKind` still faithfully records it as the
  // alliance_request action it actually was, so counting real
  // diplomatic-initiative ACTIONS (not just ones that stayed pending)
  // requires filtering on `actionKind`, not `kind`.
  const allianceRequestCount = agentEvents.filter(
    (event) => event.actionKind === "alliance_request",
  ).length;
  const economicActionCount = agentEvents.filter((event) =>
    ECONOMIC_ACTION_KINDS.has(event.actionKind),
  ).length;

  // Item 1 fix: offers received/accepted derived purely from events, never
  // from relationships[].allianceState. Same actionKind-vs-kind
  // distinction as above: an offer that immediately completes a pact must
  // still count as an offer RECEIVED.
  const offersReceivedFrom = new Set<string>();
  const offersAcceptedWith = new Set<string>();
  for (const event of telemetry.events) {
    if (
      event.actionKind === "alliance_request" &&
      event.targetAgentID === agentID
    ) {
      offersReceivedFrom.add(event.actorAgentID);
    }
    if (event.kind === "alliance_formed") {
      if (event.actorAgentID === agentID && event.targetAgentID !== null) {
        offersAcceptedWith.add(event.targetAgentID);
      } else if (event.targetAgentID === agentID) {
        offersAcceptedWith.add(event.actorAgentID);
      }
    }
  }

  const alliancesInitiatedCount = new Set(
    agentEvents
      .filter((event) => event.actionKind === "alliance_request")
      .flatMap((event) => (event.targetAgentID === null ? [] : [event.targetAgentID])),
  ).size;

  const betrayalCount = telemetry.events.filter(
    (event) =>
      event.kind === "alliance_break" &&
      event.tone === "betrayal" &&
      event.actorAgentID === agentID,
  ).length;

  // Frequent allies: co-occurrence via a genuinely completed alliance this
  // episode (an `alliance_formed` pair touching this agent) — the same
  // event set `offersAcceptedWith` already derived, just by NAME for
  // cross-episode name aggregation instead of by episode-scoped agentID.
  const idToName = new Map(
    telemetry.agents.map((agent) => [agent.agentID, agent.username]),
  );
  const alliedNames = [...offersAcceptedWith]
    .map((id) => idToName.get(id))
    .filter((name): name is string => name !== undefined);

  // Primary adversaries: attacksSent + attacksReceived from the
  // relationship matrix (already the authoritative aggregate the telemetry
  // builder itself maintains — no need to recount from events).
  const adversaryCounts = new Map<string, number>();
  for (const rel of telemetry.relationships) {
    if (rel.fromAgentID !== agentID) continue;
    const total = rel.attacksSent + rel.attacksReceived;
    if (total <= 0) continue;
    const name = idToName.get(rel.toAgentID);
    if (name !== undefined) {
      adversaryCounts.set(name, total);
    }
  }

  // Treaty duration: alliance_formed -> alliance_break turn span, per pair
  // touching this agent, this episode only.
  const formedAtByPair = new Map<string, number>();
  const treatyDurationsTurns: number[] = [];
  const pairKey = (a: string, b: string): string =>
    [a, b].sort().join("|");
  for (const event of [...telemetry.events].sort(
    (a, b) => a.turnNumber - b.turnNumber || a.sequence - b.sequence,
  )) {
    if (event.targetAgentID === null) continue;
    const touchesAgent =
      event.actorAgentID === agentID || event.targetAgentID === agentID;
    if (!touchesAgent) continue;
    const key = pairKey(event.actorAgentID, event.targetAgentID);
    if (event.kind === "alliance_formed") {
      formedAtByPair.set(key, event.turnNumber);
    } else if (event.kind === "alliance_break") {
      const formedAt = formedAtByPair.get(key);
      if (formedAt !== undefined && event.turnNumber >= formedAt) {
        treatyDurationsTurns.push(event.turnNumber - formedAt);
        formedAtByPair.delete(key);
      }
    }
  }

  const sortedBySize = [...telemetry.agents]
    .filter((agent) => agent.finalTilesOwned !== null)
    .sort((a, b) => (b.finalTilesOwned ?? 0) - (a.finalTilesOwned ?? 0));
  const rank =
    self.finalTilesOwned === null
      ? null
      : sortedBySize.findIndex((agent) => agent.agentID === agentID) + 1;

  const sumFinalTroops = telemetry.agents.reduce(
    (sum, agent) => sum + (agent.finalTroops ?? 0),
    0,
  );
  const relativeArmyStrength =
    self.finalTroops !== null && sumFinalTroops > 0
      ? self.finalTroops / sumFinalTroops
      : null;

  return {
    totalEventCount,
    attackCount,
    allianceRequestCount,
    economicActionCount,
    finalTilesOwned: self.finalTilesOwned,
    realLandTileCount,
    rank: rank === 0 ? null : rank,
    finalTroops: self.finalTroops,
    relativeArmyStrength,
    alliancesInitiatedCount,
    offersReceivedFrom,
    offersAcceptedWith,
    betrayalCount,
    alliedNames,
    adversaryCounts,
    treatyDurationsTurns,
  };
}

// ---------------------------------------------------------------------------
// Cross-match aggregation — pure, sums raw counts BEFORE computing ratios
// (statistically sounder than averaging per-match ratios), gates each
// metric on ITS OWN aggregate sample size, never fabricates a metric the
// underlying data can't support.
// ---------------------------------------------------------------------------

function metric(
  value: number,
  sampleSize: number,
  threshold: number,
  methodology: string,
): AgentMetric | null {
  if (sampleSize < threshold) return null;
  return { value, sampleSize, threshold, methodology };
}

export function aggregateAgentStats(
  matches: readonly RawMatchAgentMetrics[],
): AgentStatsSlice {
  const totalEvents = matches.reduce((sum, m) => sum + m.totalEventCount, 0);
  const totalAttacks = matches.reduce((sum, m) => sum + m.attackCount, 0);
  const totalAllianceRequests = matches.reduce(
    (sum, m) => sum + m.allianceRequestCount,
    0,
  );
  const totalEconomic = matches.reduce(
    (sum, m) => sum + m.economicActionCount,
    0,
  );

  const aggression = metric(
    totalEvents > 0 ? totalAttacks / totalEvents : 0,
    totalEvents,
    AGGRESSION_MIN_EVENTS,
    "attack_count / total_event_count, summed across every retained episode (spectator-telemetry.json timelineBuckets events, actorAgentID filter)",
  );
  const diplomacyInitiated = metric(
    totalEvents > 0 ? totalAllianceRequests / totalEvents : 0,
    totalEvents,
    DIPLOMACY_MIN_EVENTS,
    "alliance_request_count / total_event_count, summed across every retained episode",
  );
  const economicFocus = metric(
    totalEvents > 0 ? totalEconomic / totalEvents : 0,
    totalEvents,
    ECONOMIC_MIN_EVENTS,
    "count(build|embargo|upgrade_structure) / total_event_count, summed across every retained episode",
  );

  const territoryEpisodes = matches.filter((m) => m.finalTilesOwned !== null);
  const withRealDenominator = territoryEpisodes.filter(
    (m) => m.realLandTileCount !== null && m.realLandTileCount > 0,
  );
  const territoryShareMetric =
    withRealDenominator.length >= TERRITORY_MIN_EPISODES
      ? metric(
          withRealDenominator.reduce(
            (sum, m) =>
              sum + (m.finalTilesOwned ?? 0) / (m.realLandTileCount ?? 1),
            0,
          ) / withRealDenominator.length,
          withRealDenominator.length,
          TERRITORY_MIN_EPISODES,
          "mean(finalTilesOwned / real map land-tile count from resources/maps/<map>/manifest.json) across qualifying episodes",
        )
      : null;
  const absoluteTiles =
    territoryEpisodes.length >= TERRITORY_MIN_EPISODES
      ? {
          mean:
            territoryEpisodes.reduce(
              (sum, m) => sum + (m.finalTilesOwned ?? 0),
              0,
            ) / territoryEpisodes.length,
          sampleSize: territoryEpisodes.length,
        }
      : null;
  const ranked = matches.filter((m) => m.rank !== null);
  const meanRank =
    ranked.length >= TERRITORY_MIN_EPISODES
      ? {
          value:
            ranked.reduce((sum, m) => sum + (m.rank ?? 0), 0) / ranked.length,
          sampleSize: ranked.length,
        }
      : null;

  const armyEpisodes = matches.filter((m) => m.relativeArmyStrength !== null);
  const armyStrength =
    armyEpisodes.length >= ARMY_STRENGTH_MIN_EPISODES
      ? metric(
          armyEpisodes.reduce(
            (sum, m) => sum + (m.relativeArmyStrength ?? 0),
            0,
          ) / armyEpisodes.length,
          armyEpisodes.length,
          ARMY_STRENGTH_MIN_EPISODES,
          "mean(finalTroops / sum(finalTroops) across all match participants) across qualifying episodes",
        )
      : null;

  const totalAlliancesInitiated = matches.reduce(
    (sum, m) => sum + m.alliancesInitiatedCount,
    0,
  );
  const alliancesInitiated = metric(
    totalAlliancesInitiated,
    totalAlliancesInitiated,
    ALLIANCES_INITIATED_MIN,
    "count(distinct counterpart per alliance_request sent), summed across every retained episode",
  );

  const totalOffersReceived = matches.reduce(
    (sum, m) => sum + m.offersReceivedFrom.size,
    0,
  );
  const totalOffersAccepted = matches.reduce(
    (sum, m) => sum + m.offersAcceptedWith.size,
    0,
  );
  const allianceAcceptanceRate = metric(
    totalOffersReceived > 0 ? totalOffersAccepted / totalOffersReceived : 0,
    totalOffersReceived,
    ACCEPTANCE_MIN_OFFERS,
    "count(distinct counterpart of an alliance_formed event) / count(distinct actor of an alliance_request event targeting this agent), summed across every retained episode — never relationships[].allianceState (a final-state snapshot with no offer/accept counts)",
  );

  const totalBetrayals = matches.reduce((sum, m) => sum + m.betrayalCount, 0);
  const betrayalCount = metric(
    totalBetrayals,
    totalBetrayals,
    BETRAYAL_MIN,
    "count(alliance_break events with tone=betrayal, actorAgentID=this agent), summed across every retained episode",
  );

  const alliedCounts = new Map<string, number>();
  for (const m of matches) {
    for (const name of m.alliedNames) {
      alliedCounts.set(name, (alliedCounts.get(name) ?? 0) + 1);
    }
  }
  const frequentAllies = [...alliedCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 5);

  const adversaryTotals = new Map<string, number>();
  for (const m of matches) {
    for (const [name, count] of m.adversaryCounts) {
      adversaryTotals.set(name, (adversaryTotals.get(name) ?? 0) + count);
    }
  }
  const primaryAdversaries = [...adversaryTotals.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 5);

  const allTreatyDurations = matches.flatMap((m) => m.treatyDurationsTurns);
  const treatyDuration = metric(
    allTreatyDurations.length > 0
      ? allTreatyDurations.reduce((sum, d) => sum + d, 0) /
          allTreatyDurations.length
      : 0,
    allTreatyDurations.length,
    TREATY_DURATION_MIN_BROKEN,
    "mean(break_turn - formed_turn) for every alliance_formed pair this agent was part of that later broke, pooled across every retained episode (turns, not seconds)",
  );

  return {
    episodeCount: matches.length,
    fingerprint: {
      aggression,
      diplomacyInitiated,
      economicFocus,
      territory: {
        share: territoryShareMetric,
        absoluteTiles,
        meanRank,
      },
      armyStrength,
    },
    social: {
      alliancesInitiated,
      allianceAcceptanceRate,
      betrayalCount,
      frequentAllies,
      primaryAdversaries,
      treatyDuration,
    },
  };
}
