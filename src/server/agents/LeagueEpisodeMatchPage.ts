import { promises as fs } from "node:fs";
import path from "node:path";
import {
  publicRunKeyFromFullRenderHref,
  publicRunKeyFromWatchHref,
} from "./CoworldLeagueArtifactRetention";
import { AGENT_MATCH_RECAP_SCHEMA_VERSION } from "./AgentMatchRecap";
import type { FeaturedMatchParticipantCard } from "./FeaturedMatchParticipants";
import type {
  CoworldLeagueEpisodePlayerRow,
  CoworldLeagueEpisodeRow,
} from "./CoworldLeagueSiteWriter";
import { generateEmblemSvg } from "../identity/IdentityEmblems";
import { resolveAgentIdentityView } from "../identity/IdentityMatching";
import type { IdentityRegistrySnapshot } from "../identity/IdentityRegistry";
import {
  computeProvisionalIdentities,
  type ProvisionalIdentity,
} from "../identity/ProvisionalIdentity";

/**
 * Product overhaul: canonical match pages for ORDINARY league episodes
 * (the `CoworldLeagueEpisodeRow[]` the hosted Coworld mirror downloads —
 * see `CoworldLeagueMirrorCore.ts`'s `buildEpisodeRow`), not just
 * `FeaturedMatch` records. Backs the narrow `GET /api/matches/:episodeId`
 * route in `ai-agent-demo-server.ts`, exactly parallel to
 * `FeaturedMatchParticipants.ts`/`loadFeaturedMatchDetail` for the
 * `feat_...`-namespaced store: one record, resolved by its own stable
 * public id (`episodeRequestId`, Coworld's own `ereq_...` id — already
 * the same value `ProxyWarPublicReadModel.ts`'s `publicMatch()` uses as
 * `PublicMatch.matchId`, so no new id space is introduced).
 *
 * Every field below is either already public on `data.json`/
 * `read-model.json` (participants, placements, map, turn/decision/
 * degraded counts, hrefs, Director Cut summary) or derived from
 * `match-recap.json` — the event-derived recap artifact on the public
 * run-artifact allowlist (`ProxyWarPublicArtifacts.ts`; `match-story.md`
 * is ALSO public but deliberately never read here — its "Spectator
 * Summary"/"Highlights" are `AgentMatchStory.ts` diagnostic prose (an
 * entertainment-tuning QA artifact), not a battle story; `match-story.json`
 * and `drama-report.json` stay OFF the allowlist entirely and are read only
 * by `feature-candidates.ts`/the mirror's read-model projection as
 * ranking/evidence signals — see `AgentMatchRecap.ts`'s own doc). See
 * `readLeagueEpisodeRecap`'s own doc for why hosted league episodes don't
 * always have one.
 */

export interface LeagueEpisodeMatchPagePlayer {
  slot: number;
  name: string;
  tilesOwned: number;
  isAlive: boolean;
  isWinner: boolean;
  color: string;
  /** 1-based finish order: winner first, then tiles owned desc, then slot asc — same comparator `feature-candidates.ts`'s `buildResult` and `CoworldLeagueSiteWriter.ts`'s `battleCard` already sort by. */
  placement: number;
}

/** Parsed from `match-recap.json` (`AgentMatchRecap.ts`) — event-derived facts only. `null` whenever no real artifact backs it (never a placeholder). */
export interface LeagueEpisodeRecap {
  summary: string;
  beats: string[];
}

/** Before/after territory snapshot for one decisive moment — mirrors `AgentDecisiveMoments.ts`'s `DecisiveMomentState` field for field, re-typed here so this module (like every other page-model file) never imports server-only agent types directly into the page-model surface. */
export interface LeagueEpisodeDecisiveMomentState {
  turn: number;
  agents: {
    username: string;
    tilesOwned: number;
    troops: number;
    territoryShare: number;
    rank: number;
    alive: boolean;
  }[];
}

/** Parsed from `decisive-moments.json` (`AgentDecisiveMoments.ts`) — see that module's doc for the exactly-3-to-5, never-padded selection contract. */
export interface LeagueEpisodeDecisiveMoment {
  turn: number;
  type: string;
  headline: string;
  involvedAgents: string[];
  beforeState: LeagueEpisodeDecisiveMomentState | null;
  afterState: LeagueEpisodeDecisiveMomentState | null;
  jumpToReplayTurn: number;
  /** The agent's OWN stated reason where captured — `null` when none was — never verified reasoning, always rendered client-side as "stated by the agent". */
  statedReason: string | null;
}

export interface LeagueEpisodeMatchPageModel {
  episodeRequestId: string;
  shortId: string;
  /** The mirror's internal `league-<runID>` (or fixture) run key, when derivable from `watchHref`/`fullRenderHref` — the same key the technical drawer and `findArtifactDirectory`-style lookups use. */
  runKey: string | null;
  roundNumber: number | null;
  completedAt: string | null;
  map: string;
  mapSize: string;
  turnCount: number | null;
  decisionCount: number | null;
  degradedCount: number | null;
  winnerName: string | null;
  players: LeagueEpisodeMatchPagePlayer[];
  watchHref: string | null;
  fullRenderHref: string | null;
  premiereHref: string | null;
  directorCut: { durationEstimateSeconds: number; segmentCount: number } | null;
  recap: LeagueEpisodeRecap | null;
  /** `null` when no `decisive-moments.json` exists for this episode yet (not backfilled, or a genuinely quiet match with fewer than `MIN_DECISIVE_MOMENTS` real candidates — see `AgentDecisiveMoments.ts`'s "never padded" doc) — the page renders no section, never a placeholder. */
  decisiveMoments: LeagueEpisodeDecisiveMoment[] | null;
}

/** Reads `data.json`'s `episodes` array with the same tolerant, cast-after-shape-check pattern `FeaturedMatchRetentionPin.ts`/`coworld-league-mirror.ts` already use for this exact file — `null` for anything short of "a JSON object with an `episodes` array" (missing mirror cycle, corrupt write, etc.), never a thrown error. */
export async function readCoworldLeagueEpisodesFromDataJson(
  dataJsonPath: string,
): Promise<readonly CoworldLeagueEpisodeRow[] | null> {
  try {
    const raw = await fs.readFile(dataJsonPath, "utf8");
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("episodes" in value) ||
      !Array.isArray(value.episodes)
    ) {
      return null;
    }
    // `data.json` is written exclusively by this same process's own
    // `CoworldLeagueSiteWriter.ts` from `CoworldLeagueEpisodeRow[]` — same
    // tolerant, shape-checked-then-trusted cast `FeaturedMatchRetentionPin.ts`
    // and `coworld-league-mirror.ts`'s `readPreviousMirrorData` already use
    // for this exact file; a full runtime schema is unwarranted for a
    // same-process artifact this narrowly consumed.
    const episodes = value.episodes as CoworldLeagueEpisodeRow[];
    return episodes;
  } catch {
    return null;
  }
}

export function findLeagueEpisodeByRequestId(
  episodes: readonly CoworldLeagueEpisodeRow[],
  episodeRequestId: string,
): CoworldLeagueEpisodeRow | null {
  return (
    episodes.find(
      (episode) => episode.episodeRequestId === episodeRequestId,
    ) ?? null
  );
}

/** Same derivation `feature-candidates.ts`'s `findArtifactDirectory` already uses: the mirror's own managed run key, recovered from whichever href is present. `null` when neither href is a well-formed managed run link (replay never downloaded). */
export function leagueEpisodeRunKey(row: CoworldLeagueEpisodeRow): string | null {
  return (
    publicRunKeyFromFullRenderHref(row.fullRenderHref) ??
    publicRunKeyFromWatchHref(row.watchHref)
  );
}

export function findLeagueEpisodeRunDir(
  row: CoworldLeagueEpisodeRow,
  runsRootDir: string,
): string | null {
  const runKey = leagueEpisodeRunKey(row);
  return runKey === null ? null : path.join(runsRootDir, runKey);
}

function episodeParticipantCard(
  player: CoworldLeagueEpisodePlayerRow,
  identity: IdentityRegistrySnapshot,
  provisionalIdentities: ReadonlyMap<string, ProvisionalIdentity>,
): FeaturedMatchParticipantCard {
  const view = resolveAgentIdentityView(
    {
      playerName: player.name,
      ratingPolicyLabel: null,
      activeChampionPolicyLabel: null,
    },
    identity.agents,
    identity.builders,
    identity.versions,
  );
  const provisional =
    view.agent === null ? (provisionalIdentities.get(player.name) ?? null) : null;
  return {
    playerName: player.name,
    displayName: view.agent?.displayName ?? player.name,
    agentSlug: view.agent?.slug ?? provisional?.slug ?? null,
    emblemSvg:
      view.agent === null
        ? (provisional?.emblemSvg ?? null)
        : generateEmblemSvg(view.agent.id),
    primaryColor: view.agent?.primaryColor ?? provisional?.primaryColor ?? null,
    secondaryColor:
      view.agent?.secondaryColor ?? provisional?.secondaryColor ?? null,
    versionLabel: view.version?.publicVersionLabel ?? null,
    builderId: view.builder?.id ?? null,
    builderDisplayName: view.builder?.displayName ?? null,
  };
}

/**
 * Resolves every episode participant to the SAME `FeaturedMatchParticipantCard`
 * shape `/api/featured-matches/:matchId` already returns (playerName-based
 * lookup via `resolveAgentIdentityView`, exactly like `battleCard()` in
 * `CoworldLeagueSiteWriter.ts` and `buildParticipants()` in
 * `feature-candidates.ts`) — a registered agent gets emblem/slug/version/
 * builder; an unmapped player name falls back to a provisional card
 * (`displayName` = raw `playerName`, a generated emblem/slug/colors via
 * `ProvisionalIdentity.ts`, `versionLabel`/`builderId`/`builderDisplayName`
 * stay `null` — 2026-08-01 P0 fix), never fabricated beyond that. Order
 * matches `row.players` (slot order), so the client can zip this array
 * against `LeagueEpisodeMatchPageModel.players` by `playerName`/`name`.
 */
export function buildLeagueEpisodeParticipantCards(
  row: CoworldLeagueEpisodeRow,
  identity: IdentityRegistrySnapshot,
): FeaturedMatchParticipantCard[] {
  const provisionalIdentities = computeProvisionalIdentities(
    row.players.map((player) => player.name),
    new Set(identity.agents.map((agent) => agent.slug)),
  );
  return row.players.map((player) =>
    episodeParticipantCard(player, identity, provisionalIdentities),
  );
}

function placementOrderedPlayers(
  row: CoworldLeagueEpisodeRow,
): LeagueEpisodeMatchPagePlayer[] {
  return [...row.players]
    .sort(
      (left, right) =>
        Number(right.isWinner) - Number(left.isWinner) ||
        right.tilesOwned - left.tilesOwned ||
        left.slot - right.slot,
    )
    .map((player, index) => ({ ...player, placement: index + 1 }));
}

export function buildLeagueEpisodeMatchPageModel(
  row: CoworldLeagueEpisodeRow,
  recap: LeagueEpisodeRecap | null,
  decisiveMoments: LeagueEpisodeDecisiveMoment[] | null,
): LeagueEpisodeMatchPageModel {
  return {
    episodeRequestId: row.episodeRequestId,
    shortId: row.shortId,
    runKey: leagueEpisodeRunKey(row),
    roundNumber: row.roundNumber,
    completedAt: row.completedAt,
    map: row.map,
    mapSize: row.mapSize,
    turnCount: row.turnCount,
    decisionCount: row.decisionCount,
    degradedCount: row.degradedCount,
    winnerName: row.winnerName,
    players: placementOrderedPlayers(row),
    watchHref: row.watchHref,
    fullRenderHref: row.fullRenderHref,
    premiereHref: row.premiereHref ?? null,
    directorCut: row.directorCut ?? null,
    recap,
    decisiveMoments,
  };
}

const maximumMatchRecapBytes = 2 * 1024 * 1024;

/**
 * Parses `match-recap.json` (`AgentMatchRecap.ts`'s `AgentMatchRecap`) into
 * the page's `LeagueEpisodeRecap` — a narrow field-validated projection
 * (`summary`/`beats[].message` only; `schemaVersion`/`runID`/`generatedAt`/
 * `beats[].turnNumber`/`beats[].kind` are internal-only, never re-exposed),
 * same "validate exactly what's read, cast nothing blindly" discipline
 * `CoworldLeagueMirrorCore.ts`'s tolerant parsers use. Every beat message is
 * rendered as `Turn N: <message>` — the artifact's own beats are already
 * ordered by `turnNumber`, so this only formats, never reorders or filters.
 * `null` for malformed JSON, the wrong `schemaVersion`, or a recap with zero
 * beats and an empty summary (an artifact that technically exists but
 * carries no real content — same "never a fabricated placeholder" rule the
 * rest of this codebase follows; in practice `AgentMatchRecap.ts` never
 * writes that shape, since it returns `null` instead of writing anything
 * when the curated pass finds zero beats, but this reader stays defensive
 * regardless of the writer's own guarantee).
 */
export function parseMatchRecapArtifact(raw: string): LeagueEpisodeRecap | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== AGENT_MATCH_RECAP_SCHEMA_VERSION) return null;
  const summary = typeof record.summary === "string" ? record.summary : "";
  const beatsRaw = Array.isArray(record.beats) ? record.beats : [];
  const beats = beatsRaw
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const beat = entry as Record<string, unknown>;
      const turnNumber =
        typeof beat.turnNumber === "number" && Number.isFinite(beat.turnNumber)
          ? beat.turnNumber
          : null;
      const message = typeof beat.message === "string" ? beat.message : null;
      if (turnNumber === null || message === null || message.length === 0) {
        return null;
      }
      return `Turn ${turnNumber}: ${message}`;
    })
    .filter((beat): beat is string => beat !== null);
  if (summary.length === 0 && beats.length === 0) return null;
  return { summary, beats };
}

/**
 * Reads and parses `match-recap.json` from an episode's mirrored run
 * directory, when one exists. `null` for a missing/oversized/unreadable
 * file — expected for many hosted league episodes: the mirror only writes
 * one once `CoworldLeagueMatchNarrativeBackfill.ts` has processed that run
 * (budgeted, gradual) AND the match actually had story-worthy events (a
 * genuinely quiet match legitimately never gets one — see
 * `AgentMatchRecap.ts`'s own doc). This still checks the filesystem rather
 * than assuming absence, so a future backfill pass picks up recaps with no
 * code change here.
 */
export async function readLeagueEpisodeRecap(
  runDir: string | null,
): Promise<LeagueEpisodeRecap | null> {
  if (runDir === null) return null;
  try {
    const filePath = path.join(runDir, "match-recap.json");
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > maximumMatchRecapBytes) {
      return null;
    }
    const raw = await fs.readFile(filePath, "utf8");
    return parseMatchRecapArtifact(raw);
  } catch {
    return null;
  }
}

const maximumDecisiveMomentsBytes = 2 * 1024 * 1024;

function parseDecisiveMomentState(
  value: unknown,
): LeagueEpisodeDecisiveMomentState | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const turn = typeof record.turn === "number" ? record.turn : null;
  const agentsRaw = Array.isArray(record.agents) ? record.agents : null;
  if (turn === null || agentsRaw === null) return null;
  const agents = agentsRaw
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const agent = entry as Record<string, unknown>;
      if (
        typeof agent.username !== "string" ||
        typeof agent.tilesOwned !== "number" ||
        typeof agent.troops !== "number" ||
        typeof agent.territoryShare !== "number" ||
        typeof agent.rank !== "number" ||
        typeof agent.alive !== "boolean"
      ) {
        return null;
      }
      return {
        username: agent.username,
        tilesOwned: agent.tilesOwned,
        troops: agent.troops,
        territoryShare: agent.territoryShare,
        rank: agent.rank,
        alive: agent.alive,
      };
    })
    .filter((agent): agent is LeagueEpisodeDecisiveMomentState["agents"][number] => agent !== null);
  return { turn, agents };
}

/**
 * Parses `decisive-moments.json` (`AgentDecisiveMoments.ts`'s
 * `AgentDecisiveMomentsArtifact`) into the page's field-validated
 * `LeagueEpisodeDecisiveMoment[]` — same "validate exactly what's read"
 * discipline `parseMatchRecapArtifact` uses. Requires the current
 * `DECISIVE_MOMENTS_SCHEMA_VERSION`; `null` for malformed JSON, a stale
 * schema, or zero moments (never fabricated).
 */
export function parseDecisiveMomentsArtifact(
  raw: string,
): LeagueEpisodeDecisiveMoment[] | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return null;
  const momentsRaw = Array.isArray(record.moments) ? record.moments : [];
  const moments = momentsRaw
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const moment = entry as Record<string, unknown>;
      if (
        typeof moment.turn !== "number" ||
        typeof moment.type !== "string" ||
        typeof moment.headline !== "string" ||
        !Array.isArray(moment.involvedAgents) ||
        typeof moment.jumpToReplayTurn !== "number"
      ) {
        return null;
      }
      const involvedAgents = moment.involvedAgents.filter(
        (agent): agent is string => typeof agent === "string",
      );
      if (moment.headline.length === 0 || involvedAgents.length === 0) {
        return null;
      }
      return {
        turn: moment.turn,
        type: moment.type,
        headline: moment.headline,
        involvedAgents,
        beforeState: parseDecisiveMomentState(moment.beforeState),
        afterState: parseDecisiveMomentState(moment.afterState),
        jumpToReplayTurn: moment.jumpToReplayTurn,
        statedReason:
          typeof moment.statedReason === "string" ? moment.statedReason : null,
      };
    })
    .filter((moment): moment is LeagueEpisodeDecisiveMoment => moment !== null);
  return moments.length === 0 ? null : moments;
}

/**
 * Reads and parses `decisive-moments.json` from an episode's mirrored run
 * directory, when one exists — same absence handling as
 * `readLeagueEpisodeRecap` (the mirror only writes one once
 * `CoworldLeagueMatchNarrativeBackfill.ts`'s decisive-moments step has
 * processed that run AND at least `MIN_DECISIVE_MOMENTS` real candidates
 * were found — see `AgentDecisiveMoments.ts`'s own doc).
 */
export async function readLeagueEpisodeDecisiveMoments(
  runDir: string | null,
): Promise<LeagueEpisodeDecisiveMoment[] | null> {
  if (runDir === null) return null;
  try {
    const filePath = path.join(runDir, "decisive-moments.json");
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > maximumDecisiveMomentsBytes) {
      return null;
    }
    const raw = await fs.readFile(filePath, "utf8");
    return parseDecisiveMomentsArtifact(raw);
  } catch {
    return null;
  }
}
/**
 * Spoiler-safe title for the match page's OG/social card and `<title>` —
 * participants and context, NEVER the winner/result (product overhaul
 * spec: "no winner/result in title/description per the spoiler-safe card
 * convention"). Distinct from `feature-candidates.ts`'s `buildTitle`,
 * which DOES name the winner — that title is archive-lane FeaturedMatch
 * editorial metadata for an operator, for an outcome that was already
 * public well before being curated; this one is the canonical share card
 * for the raw episode page, always spoiler-neutral regardless of lane.
 *
 * Roster order is BY SLOT (assignment order), never `row.players`'
 * own incoming order or `placementOrderedPlayers`' winner-first order:
 * a link preview is read before any click, so ranking the roster by who
 * won is a spoiler leak through the title/description alone — live P0
 * (2026-08-02): "Captain Underpants... vs PeePee7 +10 more" told a viewer
 * who won before they ever opened the page. Slot order carries no outcome
 * information by construction.
 */
export function leagueEpisodeSpoilerSafeTitle(row: CoworldLeagueEpisodeRow): string {
  const names = [...row.players]
    .sort((left, right) => left.slot - right.slot)
    .map((player) => player.name);
  const roster =
    names.length === 0
      ? "Unknown participants"
      : names.length <= 2
        ? names.join(" vs ")
        : `${names.slice(0, 2).join(" vs ")} +${names.length - 2} more`;
  const roundSuffix =
    row.roundNumber !== null ? `, Round ${row.roundNumber}` : "";
  return `${roster} — ${row.map}${roundSuffix} | Proxy War`;
}

export function leagueEpisodeSpoilerSafeDescription(
  row: CoworldLeagueEpisodeRow,
): string {
  // Slot order, same reasoning as `leagueEpisodeSpoilerSafeTitle` above.
  const names = [...row.players]
    .sort((left, right) => left.slot - right.slot)
    .map((player) => player.name);
  const roster = names.length === 0 ? "Unknown participants" : names.join(", ");
  const roundLabel =
    row.roundNumber !== null ? `Round ${row.roundNumber}` : "an unnumbered round";
  return `Watch this Proxy War league battle: ${roster} on ${row.map}, ${roundLabel}.`;
}
