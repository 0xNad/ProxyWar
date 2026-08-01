import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import englishTranslations from "../../../resources/lang/en.json";
import { DEFAULT_PLATFORM_ORIGIN } from "../../core/PlatformOrigin";
import { readAgentStatsArtifact } from "./AgentStatsArtifact";
import {
  appendStandingsHistorySnapshot,
  EMPTY_STANDINGS_HISTORY_STORE,
  readStandingsHistoryStore,
  snapshotFromMirrorData,
  type StandingsHistoryStore,
} from "./CoworldLeagueStandingsHistory";
import { buildProxyWarPublicReadModel } from "../ProxyWarPublicReadModel";
import {
  readFeaturedMatchStore,
  resolveFeaturedMatchStateRoot,
} from "./FeaturedMatch";
import { generateEmblemSvg } from "../identity/IdentityEmblems";
import {
  AgentIdentityView,
  resolveAgentIdentityView,
} from "../identity/IdentityMatching";
import {
  IdentityRegistrySnapshot,
  loadIdentityRegistrySnapshot,
} from "../identity/IdentityRegistry";

/**
 * Static league-site writer for the hosted Coworld Proxywar league.
 *
 * Renders read-only mirror data (standings, rounds, episode summaries) into a
 * self-contained dark-theme index.html plus a machine-readable data.json. The
 * generated site is flat (no subdirectories) so the beta server's
 * two-segment `/ai-league-runs/:runID/:artifact` route and the Vite
 * `serveAiLeagueArtifacts` middleware can both serve it unchanged.
 */

export interface CoworldLeagueStandingRow {
  rank: number;
  playerName: string;
  /**
   * Policy label attached to the historical leaderboard rating row, or null
   * when Coworld has not reported one. Null renders as "Not yet rated" — never
   * as an internal placeholder string.
   */
  ratingPolicyLabel: string | null;
  /** Policy currently marked as this player's active champion, if any. */
  activeChampionPolicyLabel: string | null;
  /** @deprecated Compatibility alias for existing data.json consumers. */
  policyLabel: string | null;
  score: number | null;
  roundsPlayed: number | null;
  isHouse: boolean;
}

export interface CoworldLeagueEpisodePlayerRow {
  slot: number;
  name: string;
  tilesOwned: number;
  isAlive: boolean;
  isWinner: boolean;
  color: string;
}

export interface CoworldLeagueEpisodeRow {
  episodeRequestId: string;
  shortId: string;
  roundNumber: number | null;
  completedAt: string | null;
  map: string;
  /**
   * Map dimensions (e.g. "Normal"). Populated from the authoritative in-replay
   * config; blank when a row is shown without its downloaded replay. Not a
   * nation/bot property, so — unlike difficulty — it is retained.
   */
  mapSize: string;
  turnCount: number | null;
  decisionCount: number | null;
  degradedCount: number | null;
  winnerName: string | null;
  players: CoworldLeagueEpisodePlayerRow[];
  /** Relative href from the league index to a self-contained spectator page. */
  watchHref: string | null;
  /** Absolute path served by the Vite/demo stack for the real-client render. */
  fullRenderHref: string | null;
  /**
   * `/premiere/<premiereId>` when this episode's sealed premiere has REVEALED
   * (terminal state "revealed" in the premiere archive index — outcome
   * public). Never set for failed/cancelled premieres and never before
   * reveal; a held/quarantined episode has no card at all, so this field can
   * only ever appear on an outcome-public row. Optional and omitted when
   * absent, keeping data.json purely additive for existing consumers (the
   * polling client only checks that `episodes` is an array).
   */
  premiereHref?: string;
  /**
   * Product overhaul spec Stage 5. Optional/additive, same pattern as
   * `premiereHref` above. `writeAgentLeagueRunArtifacts` writes
   * `director-cut-plan.json` for every LOCALLY-produced match; the HOSTED
   * Coworld mirror (`coworld-league-mirror.ts`) now ALSO generates one for a
   * mirrored run dir once it has the telemetry to build it from —
   * `spectator-telemetry.json` when the hosted payload's own
   * `inlineRunArtifacts` carries it (verified against real retained mirror
   * runs — it does, for every currently observed production episode),
   * falling back to deriving it from `decisions.jsonl` otherwise (see
   * `CoworldLeagueMirrorCore.ts`'s `resolveMirroredDirectorCutPlan`).
   * Generation is budgeted (one attempt per sync cycle by default,
   * `--director-cut-budget`) and gradually backfills older retained runs, so
   * a row can stay `undefined` for a cycle or two after its episode first
   * appears — that is expected, not a bug, and this field simply omits
   * itself until a plan exists on disk for that run.
   */
  directorCut?: { durationEstimateSeconds: number; segmentCount: number };
}

export interface CoworldLeagueRoundRow {
  roundNumber: number;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * Spoiler-safe premiere card data. Built ONLY from the suppression contract, so
 * it carries no episodeRequestId, run id, player name, or match outcome. The
 * premiere leak audit scans `/league` HTML for forbidden substrings and
 * `data.json` for exact JSON leaves; keeping this shape to these five fields is
 * what guarantees the league page can never spoil a held premiere.
 */
export interface CoworldLeaguePremiereCard {
  premiereId: string;
  roundNumber: number | null;
  mapLabel: string;
  scheduledAt: string;
  premierePageLive: boolean;
}

/**
 * The persistent premiere slot's REVEALED state: once any premiere has ever
 * revealed, this card fills the slot whenever no LIVE premiere card is
 * rendered, and is only ever REPLACED when the next premiere activates —
 * never removed on a timer — so the slot is never empty again. Carries
 * reveal-public facts only — round, map, reveal time, and the
 * `/premiere/<id>` link (that page is post-reveal public) — and by
 * construction NO winner/outcome text, so it can never spoil anything: it is
 * only ever built for a premiere whose outcome is already public.
 */
export interface CoworldLeagueLatestPremiereCard {
  premiereId: string;
  roundNumber: number | null;
  mapLabel: string;
  /** ISO timestamp of the public reveal. */
  revealedAt: string;
  /** `/premiere/<premiereId>` for the archived premiere page. */
  href: string;
}

export interface CoworldLeagueMirrorData {
  generatedAt: string;
  lastGoodSyncAt: string;
  stale: boolean;
  /** True when current champion memberships could not be read. */
  championFeedStale?: boolean;
  /** True when standings are current but the optional replay feed is delayed. */
  replayFeedStale?: boolean;
  lastGoodReplaySyncAt?: string | null;
  league: {
    id: string;
    name: string;
    description: string | null;
    divisionName: string;
    roundIntervalMinutes: number | null;
    episodesPerRound: number | null;
    currentRoundNumber: number | null;
    currentRoundStatus: string | null;
    scoreLabel: string;
  };
  standings: CoworldLeagueStandingRow[];
  rounds: CoworldLeagueRoundRow[];
  episodes: CoworldLeagueEpisodeRow[];
  /**
   * Optional spoiler-safe premiere card. Omitted whenever nothing is currently
   * premiering (including every stale/absent-contract case), which keeps the
   * mirror output byte-identical to pre-premiere behavior.
   */
  premiere?: CoworldLeaguePremiereCard;
  /**
   * Optional most-recent REVEALED premiere. Additive: omitted whenever the
   * mirror runs without `--latest-premiere` (byte-identical output) or no
   * premiere has ever revealed. Rendered only when the LIVE premiere card is
   * not — the live card always takes precedence and the two never co-render —
   * so once any premiere has revealed, the premiere slot is never empty:
   * exactly one of the live/latest cards shows.
   */
  latestPremiere?: CoworldLeagueLatestPremiereCard;
  links: {
    enterTheLeagueUrl: string;
    platformLabel: string;
  };
}

export interface CoworldLeagueSitePaths {
  indexPath: string;
  clientPath: string;
  dataPath: string;
  readModelPath: string;
  standingsHistoryPath: string;
}

/**
 * Share of a match's decisions that must fall back before the card shows a
 * warning. Below this it is normal variance; every card carrying ⚠ made the
 * whole league look broken.
 */
const DEGRADED_WARNING_PERCENT = 15;

export const COWORLD_LEAGUE_POLL_INTERVAL_MS = 30_000;
export const COWORLD_LEAGUE_POLL_TIMEOUT_MS = 10_000;
const COWORLD_LEAGUE_FAILURES_BEFORE_WARNING = 2;
export const COWORLD_LEAGUE_CLIENT_PATH = "/ai-league-runs/league/client.js";
export const COWORLD_LEAGUE_DATA_PATH = "/ai-league-runs/league/data.json";
export const COWORLD_LEAGUE_READ_MODEL_PATH =
  "/ai-league-runs/league/read-model.json";
const COWORLD_LEAGUE_WRITE_LOCK_RETRY_MS = 50;
const COWORLD_LEAGUE_WRITE_LOCK_TIMEOUT_MS = 60_000;
const COWORLD_LEAGUE_WRITE_LOCK_OWNER_GRACE_MS = 30_000;
// Same platform/account origin `playerProfileLink.ts` links to client-side
// from the points leaderboard — one shared destination for both
// leaderboards. Overridable for tests; the fallback is shared with every
// other consumer (`DEFAULT_PLATFORM_ORIGIN`) because this process is one of
// the ones that does NOT set the env, so a per-file copy silently rots the
// day the origin moves.
const PLAYER_PROFILE_ORIGIN =
  process.env.PROXYWAR_PLATFORM_ORIGIN ?? DEFAULT_PLATFORM_ORIGIN;

function playerProfileUrl(playerName: string): string {
  return `${PLAYER_PROFILE_ORIGIN}/player/${encodeURIComponent(playerName)}`;
}

/** Default when a caller renders without loading the registry (existing tests, and any future direct call) — every row falls back to a provisional identity: player name, no emblem/short-code/builder. Real production rendering always loads the tracked registry instead (see `writeCoworldLeagueSiteUnlocked`). */
const EMPTY_LEAGUE_IDENTITY_SNAPSHOT: IdentityRegistrySnapshot = {
  builders: [],
  agents: [],
  versions: [],
};

type CoworldLeagueTranslationSuffix =
  keyof typeof englishTranslations.coworld_league;
type CoworldLeagueTranslationKey =
  `coworld_league.${CoworldLeagueTranslationSuffix}`;

function translateText(key: CoworldLeagueTranslationKey): string {
  const suffix = key.slice(
    "coworld_league.".length,
  ) as CoworldLeagueTranslationSuffix;
  return englishTranslations.coworld_league[suffix];
}

function errorCode(error: unknown): string | null {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

interface CoworldLeagueWriteLockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

function parseWriteLockOwner(
  value: string,
): CoworldLeagueWriteLockOwner | null {
  try {
    const candidate = JSON.parse(value) as Partial<CoworldLeagueWriteLockOwner>;
    return Number.isInteger(candidate.pid) &&
      Number(candidate.pid) > 0 &&
      typeof candidate.token === "string" &&
      candidate.token.length > 0 &&
      typeof candidate.createdAt === "string"
      ? {
          pid: Number(candidate.pid),
          token: candidate.token,
          createdAt: candidate.createdAt,
        }
      : null;
  } catch {
    return null;
  }
}

async function reclaimAbandonedWriteLock(lockPath: string): Promise<void> {
  const ownerPath = path.join(lockPath, "owner.json");
  let owner: CoworldLeagueWriteLockOwner | null = null;
  try {
    owner = parseWriteLockOwner(await fs.readFile(ownerPath, "utf8"));
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return;
    }
  }

  if (owner !== null && processIsAlive(owner.pid)) {
    return;
  }
  if (owner === null) {
    try {
      const lockStat = await fs.stat(lockPath);
      if (
        Date.now() - lockStat.mtimeMs <
        COWORLD_LEAGUE_WRITE_LOCK_OWNER_GRACE_MS
      ) {
        return;
      }
    } catch {
      return;
    }
  } else {
    try {
      const latestOwner = parseWriteLockOwner(
        await fs.readFile(ownerPath, "utf8"),
      );
      if (latestOwner?.token !== owner.token) {
        return;
      }
    } catch {
      return;
    }
  }

  const abandonedPath = `${lockPath}.abandoned.${randomUUID()}`;
  try {
    await fs.rename(lockPath, abandonedPath);
    await fs.rm(abandonedPath, { recursive: true, force: true });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function acquireCoworldLeagueWriteLock(
  siteDir: string,
): Promise<() => Promise<void>> {
  const lockPath = `${path.resolve(siteDir)}.write-lock`;
  const ownerPath = path.join(lockPath, "owner.json");
  const owner: CoworldLeagueWriteLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const deadline = Date.now() + COWORLD_LEAGUE_WRITE_LOCK_TIMEOUT_MS;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      await fs.mkdir(lockPath);
      try {
        await fs.writeFile(ownerPath, `${JSON.stringify(owner)}\n`, "utf8");
      } catch (error) {
        await fs.rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return async () => {
        try {
          const currentOwner = parseWriteLockOwner(
            await fs.readFile(ownerPath, "utf8"),
          );
          if (currentOwner?.token === owner.token) {
            await fs.rm(lockPath, { recursive: true, force: true });
          }
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            throw error;
          }
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      await reclaimAbandonedWriteLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for Coworld league site writer lock: ${lockPath}`,
          { cause: error },
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, COWORLD_LEAGUE_WRITE_LOCK_RETRY_MS),
      );
    }
  }
}

export async function withCoworldLeagueSiteWriteLock<T>(
  siteDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireCoworldLeagueWriteLock(siteDir);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function writeFileAtomic(
  destinationPath: string,
  contents: string,
): Promise<void> {
  try {
    if ((await fs.readFile(destinationPath, "utf8")) === contents) {
      return;
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents);
    await fs.rename(temporaryPath, destinationPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export const COWORLD_LEAGUE_SOCIAL_IMAGE = "social.png";

/**
 * Social/SEO tags for the league page, which previously shipped with none at
 * all — anything shared from it previewed as a bare link.
 *
 * Deliberately GENERIC: no round number, standings, player name, or outcome.
 * The league page suppresses the currently-premiering round, and these tags are
 * cached and re-scraped independently of the page, so putting live match state
 * in them would be a spoiler channel that bypasses the suppression contract.
 */
function leagueSocialMetaHtml(): string {
  const origin = leagueSocialOrigin();
  const pageUrl = origin === "" ? null : `${origin}/league`;
  const imageUrl =
    origin === ""
      ? null
      : `${origin}/ai-league-runs/league/${COWORLD_LEAGUE_SOCIAL_IMAGE}`;
  const title = "Proxy War — live AI agent league";
  const description =
    "Autonomous AI agents fight full territorial wars on a live ladder — expansion, alliances, betrayals, nukes. A new round every 30 minutes, with no humans at the controls.";
  const tags = [
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta property="og:site_name" content="Proxy War">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
  ];
  if (pageUrl !== null) {
    tags.push(`<link rel="canonical" href="${escapeHtml(pageUrl)}">`);
    tags.push(`<meta property="og:url" content="${escapeHtml(pageUrl)}">`);
  }
  if (imageUrl !== null) {
    tags.push(`<meta property="og:image" content="${escapeHtml(imageUrl)}">`);
    tags.push(
      `<meta property="og:image:alt" content="A Proxy War map with territory claimed by rival AI agents.">`,
    );
    tags.push(`<meta property="og:image:width" content="1200">`);
    tags.push(`<meta property="og:image:height" content="630">`);
    tags.push(`<meta name="twitter:image" content="${escapeHtml(imageUrl)}">`);
    // Without an image X falls back to a small thumbnail card.
    tags.push(`<meta name="twitter:card" content="summary_large_image">`);
  } else {
    tags.push(`<meta name="twitter:card" content="summary">`);
  }
  return tags.map((tag) => `  ${tag}`).join("\n");
}

/**
 * Absolute origin for canonical/social URLs. Social scrapers do not resolve
 * relative og: values, so without this the page gets no preview card at all.
 * Empty when unset — the page then omits absolute URLs rather than guessing a
 * domain.
 */
function leagueSocialOrigin(): string {
  const raw = process.env.PROXYWAR_PUBLIC_URL ?? "";
  if (raw === "") return "";
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

async function copySocialImage(siteDir: string): Promise<void> {
  const destination = path.join(siteDir, COWORLD_LEAGUE_SOCIAL_IMAGE);
  const source = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../resources/images/GameplayScreenshot.png",
  );
  try {
    await fs.copyFile(source, destination);
  } catch {
    // Publishing the league must not depend on the social asset being present.
  }
}

async function writeCoworldLeagueSiteUnlocked(
  siteDir: string,
  data: CoworldLeagueMirrorData,
): Promise<CoworldLeagueSitePaths> {
  await fs.mkdir(siteDir, { recursive: true });
  const indexPath = path.join(siteDir, "index.html");
  const clientPath = path.join(siteDir, "client.js");
  const dataPath = path.join(siteDir, "data.json");
  const readModelPath = path.join(siteDir, "read-model.json");
  const standingsHistoryPath = path.join(siteDir, "standings-history.json");
  // Self-host the social preview image next to the page. The app shell's copy
  // is content-hashed by the build and this writer cannot know that hash, so
  // publishing a stable sibling keeps og:image resolvable without coupling the
  // mirror to the client build. Best-effort: a missing source must never fail a
  // league publish.
  await copySocialImage(siteDir);
  // A malformed/missing registry must never fail a league publish — fall
  // back to the empty snapshot (every row renders provisional) and let
  // `identity:validate` be the place that catches a bad registry file.
  const identity = await loadIdentityRegistrySnapshot().catch((error) => {
    console.warn(
      `coworld-league-mirror: identity registry failed to load, rendering provisional identities: ${(error as Error).message}`,
    );
    return EMPTY_LEAGUE_IDENTITY_SNAPSHOT;
  });
  // The featured-match store is operator-maintained, out-of-band state
  // (`premiere:candidates`/`feature:candidates` rank drafts; a future
  // schedule/publish CLI is what actually writes it) — a missing store is
  // the normal cold-start case (`readFeaturedMatchStore` itself returns an
  // empty, schema-valid file for that; a genuinely corrupt store is left to
  // throw and fail this publish loudly, same "never silently reset"
  // contract `FeaturedMatch.ts` documents on the store's own read function).
  const featuredMatchStore = await readFeaturedMatchStore(
    resolveFeaturedMatchStateRoot(),
  );
  // Product overhaul spec Stage 6: best-effort, tolerant of absence (the
  // stats batch job runs on its own periodic cadence — see
  // `compute-agent-stats.ts`'s own doc for why this must never be a
  // per-publish recomputation). Lives alongside data.json/read-model.json
  // in the SAME site directory.
  const statsArtifact = await readAgentStatsArtifact(
    path.join(siteDir, "agent-stats.json"),
  );
  // Product overhaul spec: standings-history store for score/rank-over-time
  // graphs — see `CoworldLeagueStandingsHistory.ts`'s own doc for why this
  // can only ever grow forward from here, never backfilled. A corrupt file
  // is left untouched on disk (never overwritten) and this cycle publishes
  // with an empty series rather than either failing the league publish or
  // silently discarding real accumulated history.
  const existingStandingsHistory = await readStandingsHistoryStore(
    standingsHistoryPath,
  );
  const standingsHistoryCorrupt = existingStandingsHistory === "corrupt";
  if (standingsHistoryCorrupt) {
    console.warn(
      `coworld-league-mirror: standings-history.json is corrupt, leaving it untouched and publishing with an empty score series this cycle: ${standingsHistoryPath}`,
    );
  }
  const candidateSnapshot = snapshotFromMirrorData(data);
  const standingsHistory: StandingsHistoryStore = standingsHistoryCorrupt
    ? EMPTY_STANDINGS_HISTORY_STORE
    : candidateSnapshot === null
      ? existingStandingsHistory
      : appendStandingsHistorySnapshot(existingStandingsHistory, candidateSnapshot);
  if (!standingsHistoryCorrupt) {
    await writeFileAtomic(
      standingsHistoryPath,
      `${JSON.stringify(standingsHistory, null, 2)}\n`,
    );
  }
  // Publish data.json and read-model.json last. Existing pages only reload
  // after observing a newer data.json snapshot, so they cannot race ahead of
  // either the client or the HTML. read-model.json is the typed, normalized
  // read every Stage 2+ SPA page fetches (spec Stage 2 item 1) — built from
  // the exact same `data`/`identity` inputs the HTML above just rendered
  // from, so the two are never inconsistent with each other.
  const readModel = buildProxyWarPublicReadModel(
    data,
    identity,
    featuredMatchStore,
    statsArtifact,
    standingsHistory,
  );
  await writeFileAtomic(clientPath, coworldLeagueClientJavaScript());
  await writeFileAtomic(indexPath, coworldLeagueIndexHtml(data, identity));
  await writeFileAtomic(dataPath, `${JSON.stringify(data, null, 2)}\n`);
  await writeFileAtomic(
    readModelPath,
    `${JSON.stringify(readModel, null, 2)}\n`,
  );
  return {
    indexPath,
    clientPath,
    dataPath,
    readModelPath,
    standingsHistoryPath,
  };
}

export async function writeCoworldLeagueSite(
  siteDir: string,
  data: CoworldLeagueMirrorData,
): Promise<CoworldLeagueSitePaths> {
  return withCoworldLeagueSiteWriteLock(siteDir, () =>
    writeCoworldLeagueSiteUnlocked(siteDir, data),
  );
}

export async function markCoworldLeagueSiteStale(
  siteDir: string,
  generatedAt = new Date().toISOString(),
): Promise<CoworldLeagueSitePaths> {
  return withCoworldLeagueSiteWriteLock(siteDir, async () => {
    const dataPath = path.join(siteDir, "data.json");
    const previous = JSON.parse(
      await fs.readFile(dataPath, "utf8"),
    ) as CoworldLeagueMirrorData;
    return writeCoworldLeagueSiteUnlocked(siteDir, {
      ...previous,
      generatedAt: previous.stale ? previous.generatedAt : generatedAt,
      stale: true,
    });
  });
}

export function coworldLeagueIndexHtml(
  data: CoworldLeagueMirrorData,
  identity: IdentityRegistrySnapshot = EMPTY_LEAGUE_IDENTITY_SNAPSHOT,
): string {
  const league = data.league;
  const roundChip =
    league.currentRoundNumber === null
      ? "ROUND —"
      : `ROUND ${league.currentRoundNumber}${
          league.currentRoundStatus === "running" ? " · LIVE" : ""
        }`;
  const staleBanner = data.stale
    ? `<div class="stale-banner">Live sync degraded — showing the last good snapshot from <span data-utc="${escapeHtml(
        data.lastGoodSyncAt,
      )}">${escapeHtml(data.lastGoodSyncAt)}</span>.</div>`
    : "";
  const replayFeedBanner =
    !data.stale && data.replayFeedStale === true
      ? `<div class="stale-banner">${escapeHtml(
          translateText("coworld_league.replay_feed_delayed"),
        )}</div>`
      : "";
  const championFeedBanner =
    !data.stale && data.championFeedStale === true
      ? `<div class="stale-banner">${escapeHtml(
          translateText("coworld_league.champion_feed_delayed"),
        )}</div>`
      : "";
  const watchLatest = data.episodes.find((episode) => episode.fullRenderHref);
  // The LIVE premiere card always takes precedence; the compact latest-revealed
  // card fills the same slot ONLY when nothing is currently premiering, so the
  // two never co-render.
  const latestPremiere =
    data.premiere === undefined ? data.latestPremiere : undefined;
  const premiereSection =
    data.premiere !== undefined
      ? premiereCard(data.premiere)
      : latestPremiereCard(latestPremiere);
  // Premiere-only CSS, emitted ONLY when a premiere card (live or latest) is
  // present. Keeping it out of the static <style> block when absent is what
  // makes the mirror's index.html byte-identical to pre-premiere output for a
  // stale/absent contract (and for a mirror running without
  // --latest-premiere). Leading "\n    " with no trailing newline so it slots
  // between two existing style rules without shifting any bytes when empty.
  const premiereStyles =
    data.premiere === undefined && latestPremiere === undefined
      ? ""
      : "\n    " +
        [
          ".round-pill.premiering { border-color:rgba(122,215,240,.6); color:var(--cyan); box-shadow:inset 0 0 0 1px rgba(122,215,240,.25); }",
          ".premiere-card { position:relative; overflow:hidden; border:1px solid rgba(122,215,240,.5); background:linear-gradient(180deg, rgba(122,215,240,.1), rgba(122,215,240,.02) 60%), var(--surface); border-radius:12px; padding:20px; display:flex; flex-direction:column; gap:11px; box-shadow:0 18px 44px rgba(4,10,18,.5); }",
          ".premiere-card::before { content:''; position:absolute; inset:0 0 auto 0; height:2px; background:linear-gradient(90deg, transparent, rgba(122,215,240,.65), transparent); }",
          '.premiere-card[data-premiere-live="true"] { border-color:rgba(239,68,68,.45); background:radial-gradient(120% 130% at 0% 0%, rgba(239,68,68,.14), transparent 42%), linear-gradient(180deg, rgba(122,215,240,.08), rgba(122,215,240,.015) 60%), var(--surface); }',
          '.premiere-card[data-premiere-live="true"]::before { background:linear-gradient(90deg, rgba(239,68,68,.75), rgba(122,215,240,.5), transparent); }',
          ".premiere-card .premiere-badge { align-self:flex-start; display:inline-flex; align-items:center; gap:8px; padding:6px 14px; border-radius:999px; font:900 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:.14em; text-transform:uppercase; }",
          ".premiere-card .premiere-badge.live { border:1px solid rgba(239,68,68,.75); background:rgba(239,68,68,.18); color:#ffd7d2; box-shadow:0 0 22px rgba(239,68,68,.22); }",
          ".premiere-card .premiere-badge.scheduled { gap:10px; border:1px solid var(--line); background:var(--surface2); color:var(--muted); font-weight:800; }",
          ".premiere-card .premiere-badge-dot { width:10px; height:10px; border-radius:999px; background:#ef4444; box-shadow:0 0 0 0 rgba(239,68,68,.55); animation:pw-premiere-pulse 1.6s ease-out infinite; }",
          "@keyframes pw-premiere-pulse { 0% { box-shadow:0 0 0 0 rgba(239,68,68,.55); } 70% { box-shadow:0 0 0 7px rgba(239,68,68,0); } 100% { box-shadow:0 0 0 0 rgba(239,68,68,0); } }",
          ".premiere-card .premiere-badge .premiere-starts { color:var(--muted); font-weight:700; letter-spacing:.02em; text-transform:none; }",
          ".premiere-card .premiere-eyebrow { color:var(--cyan); font:800 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform:uppercase; letter-spacing:.14em; }",
          ".premiere-card h2 { margin:0; font-size:21px; letter-spacing:-.01em; }",
          ".premiere-card .premiere-body { margin:0; color:#cbd3df; max-width:640px; }",
          ".premiere-card .premiere-meta { display:flex; gap:8px; flex-wrap:wrap; color:var(--muted); font:700 12px ui-monospace, SFMono-Regular, Menlo, monospace; }",
          ".premiere-card .premiere-meta span { border:1px solid var(--line); background:var(--surface2); border-radius:999px; padding:5px 11px; }",
          ".premiere-card .actions { margin-top:4px; }",
          ".premiere-card .premiere-link { gap:9px; }",
          ".premiere-card .premiere-link::before { content:''; width:0; height:0; border-style:solid; border-width:5px 0 5px 8px; border-color:transparent transparent transparent currentColor; }",
          "@media (prefers-reduced-motion: reduce) { .premiere-card .premiere-badge-dot { animation:none; } }",
        ].join("\n    ");
  return `<!doctype html>
<html lang="en" data-generated-at="${escapeHtml(data.generatedAt)}" data-stale="${data.stale ? "true" : "false"}" data-league-id="${escapeHtml(league.id)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta id="league-refresh-fallback" http-equiv="refresh" content="300">
  <title>Proxy War — Live League</title>
${leagueSocialMetaHtml()}
  <style>
    :root { color-scheme: dark; --bg:#080b10; --surface:#111720; --surface2:#18202b; --line:#2a3442; --text:#edf1f7; --muted:#a4afbf; --amber:#f4a64a; --cyan:#7ad7f0; --good:#7ee0a8; --bad:#ff9b8f; }
    * { box-sizing:border-box; }
    html, body { max-width:100%; overflow-x:hidden; }
    body { margin:0; background:linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px), var(--bg); background-size:48px 48px,48px 48px,auto; color:var(--text); font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .skip-link { position:fixed; z-index:100; top:8px; left:8px; padding:10px 14px; border-radius:5px; background:var(--amber); color:#1a1206; transform:translateY(-150%); }
    .skip-link:focus { transform:translateY(0); }
    .shell { width:100%; max-width:1180px; margin:0 auto; padding:24px 18px 56px; }
    header { display:flex; justify-content:space-between; gap:16px; align-items:center; margin-bottom:14px; flex-wrap:wrap; }
    .brand { display:flex; gap:10px; align-items:center; font-weight:900; }
    .mark { width:34px; height:34px; border:1px solid rgba(231,235,242,.5); display:grid; place-items:center; border-radius:5px; font:800 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .eyebrow { color:var(--amber); font:800 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform:uppercase; letter-spacing:.14em; }
    .chips { display:flex; gap:8px; flex-wrap:wrap; }
    .chip { border:1px solid var(--line); background:var(--surface); border-radius:999px; padding:7px 12px; font:800 12px ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--muted); }
    .chip.live { border-color:rgba(126,224,168,.5); color:var(--good); }
    /* The one link off this read-only mirror to the account authority.
       44px min target, matching the mobile rules below — box-sizing:border-box
       puts the padding inside min-height, so 32px would BE 32px. */
    a.chip.account-link { text-decoration:none; color:var(--text); display:inline-flex; align-items:center; min-height:44px; }
    a.chip.account-link:hover { border-color:var(--text); }
    .stale-banner { border:1px solid rgba(244,166,74,.5); background:rgba(244,166,74,.08); color:var(--amber); border-radius:6px; padding:10px 12px; margin-bottom:14px; font-weight:800; }
    .sync-status { border:1px solid rgba(255,155,143,.5); background:rgba(255,155,143,.08); color:var(--bad); border-radius:6px; padding:10px 12px; margin-bottom:14px; font-weight:800; }
    .hero { border-top:1px solid var(--line); border-bottom:1px solid var(--line); padding:24px 0 20px; margin-bottom:18px; }
    h1 { margin:8px 0 10px; font-size:clamp(34px, 5vw, 56px); line-height:1; }
    .lede { max-width:760px; color:#cbd3df; font-size:16px; margin:0 0 16px; }
    .actions { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
    .button { min-height:40px; display:inline-flex; align-items:center; justify-content:center; padding:10px 14px; border-radius:5px; border:1px solid var(--line); background:var(--surface2); color:var(--text); font:900 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-decoration:none; }
    .button.primary { background:var(--amber); border-color:var(--amber); color:#1a1206; }
    a { color:var(--cyan); font-weight:800; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .metric-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom:22px; }
    .metric { background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:14px; }
    .metric span { color:var(--muted); font:800 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform:uppercase; letter-spacing:.12em; }
    .metric strong { display:block; font-size:26px; margin-top:6px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
    h2 { margin:0 0 10px; font-size:20px; }
    .standings-note { max-width:820px; color:var(--muted); font-size:13px; margin:-2px 0 10px; }
    section { margin-bottom:26px; }
    .standings-scroll { width:100%; overflow-x:auto; border:1px solid var(--line); border-radius:8px; -webkit-overflow-scrolling:touch; }
    .standings-scroll:focus-visible { outline:2px solid var(--cyan); outline-offset:3px; }
    table { width:100%; min-width:760px; border-collapse:collapse; background:var(--surface); }
    th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:middle; }
    th { background:var(--surface2); font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
    tr:last-child td { border-bottom:0; }
    tr.house td { background:rgba(244,166,74,.07); }
    tr.house td:first-child { box-shadow:inset 3px 0 0 var(--amber); }
    td.rank { font:900 16px ui-monospace, SFMono-Regular, Menlo, monospace; width:52px; }
    td.score { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-weight:800; }
    td.movement { color:var(--muted); font:700 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
    td.recent-form, td.latest-match { font:600 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .muted-note { color:var(--muted); font-style:italic; opacity:.7; }
    .completed-rounds-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
    .completed-rounds-list li { display:flex; gap:8px; align-items:center; color:var(--muted); font:700 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .policy { display:block; color:var(--muted); font:600 12px ui-monospace, SFMono-Regular, Menlo, monospace; margin-top:2px; }
    .policy.active { color:var(--good); font-weight:800; }
    .policy-kind { display:inline-block; min-width:116px; font-size:10px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; cursor:help; }
    .policy-unrated { font-style:italic; opacity:.7; }
    .badge { display:inline-block; border-radius:4px; padding:2px 7px; font:800 10px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:.08em; margin-left:6px; vertical-align:2px; }
    .badge.house { border:1px solid rgba(244,166,74,.5); color:var(--amber); }
    .agent-identity { display:inline-flex; align-items:center; gap:6px; }
    .agent-emblem { width:20px; height:20px; border-radius:4px; overflow:hidden; flex:0 0 auto; display:inline-block; vertical-align:-5px; }
    .agent-emblem svg { display:block; width:100%; height:100%; }
    .agent-shortcode { color:var(--muted); font:700 10px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:.06em; }
    .builder-note { display:block; color:var(--muted); font:600 11px ui-monospace, SFMono-Regular, Menlo, monospace; margin-top:2px; font-style:italic; }
    .integrity-drawer { margin-top:4px; }
    .integrity-drawer summary { cursor:pointer; color:var(--muted); font:700 11px ui-monospace, SFMono-Regular, Menlo, monospace; list-style:none; }
    .integrity-drawer summary::-webkit-details-marker { display:none; }
    .integrity-drawer summary::before { content:"▸ "; }
    .integrity-drawer[open] summary::before { content:"▾ "; }
    .integrity-drawer .integrity-body { margin-top:4px; border-left:2px solid var(--line); padding-left:8px; }
    .integrity-drawer .integrity-refresh { display:block; color:var(--muted); font-size:10px; margin-top:4px; }
    .battle-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:14px; }
    .battle { background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:14px; display:flex; flex-direction:column; gap:10px; }
    .battle-head { display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
    .battle-head h3 { margin:0; font-size:15px; }
    .battle-head span { color:var(--muted); font:700 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .combatants, .combatant-extra-group { display:flex; flex-direction:column; gap:10px; }
    .combatant { display:grid; grid-template-columns:12px minmax(0,1fr) 62px; gap:8px; align-items:center; }
    .dot { width:10px; height:10px; border-radius:3px; }
    .combatant .name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:700; }
    .combatant .name.dead { color:var(--muted); text-decoration:line-through; }
    .combatant .name .win { color:var(--good); }
    .tiles { color:var(--muted); font:700 11px ui-monospace, SFMono-Regular, Menlo, monospace; text-align:right; }
    .bar { grid-column:2 / 4; height:4px; background:var(--surface2); border-radius:2px; overflow:hidden; }
    .bar i { display:block; height:100%; }
    .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0, 0, 0, 0); white-space:nowrap; border:0; }
    .roster-toggle { display:none; align-self:flex-start; min-height:40px; border:1px solid var(--line); border-radius:5px; padding:8px 10px; background:var(--surface2); color:var(--cyan); font:800 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor:pointer; }
    .roster-toggle:focus-visible { outline:2px solid var(--cyan); outline-offset:2px; }
    .roster-toggle .when-expanded { display:none; }
    .battle[data-roster-expanded="true"] .roster-toggle .when-collapsed { display:none; }
    .battle[data-roster-expanded="true"] .roster-toggle .when-expanded { display:inline; }
    .battle-foot { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; border-top:1px solid var(--line); padding-top:10px; margin-top:2px; }
    .battle-foot .meta { color:var(--muted); font:700 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .battle-foot .links { margin-left:auto; }
    .battle-foot .links .link-sep { color:var(--muted); }
    .degraded { border:1px solid var(--line); color:var(--muted); border-radius:4px; padding:2px 7px; font:800 10px ui-monospace, SFMono-Regular, Menlo, monospace; cursor:help; }
    .degraded.elevated { border-color:rgba(244,166,74,.5); color:var(--amber); }
    .rounds-strip { display:flex; gap:8px; flex-wrap:wrap; }
    .round-pill { border:1px solid var(--line); background:var(--surface); border-radius:6px; padding:8px 10px; font:700 12px ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--muted); }
    .round-pill.running { border-color:rgba(126,224,168,.5); color:var(--good); }${premiereStyles}
    footer { border-top:1px solid var(--line); padding-top:16px; color:var(--muted); font-size:13px; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; }
    @media (max-width:640px) {
      .shell { padding-left:12px; padding-right:12px; }
      .battle-grid { grid-template-columns:minmax(0, 1fr); }
      .battle { padding:12px; }
      .roster-disclosure-ready .battle[data-roster-expanded="false"] .combatant-extra-group { display:none; }
      .roster-disclosure-ready .roster-toggle { display:inline-flex; align-items:center; justify-content:center; min-height:44px; }
      .battle-foot { align-items:flex-start; }
      .battle-foot > .meta { flex:1 1 100%; }
      .battle-foot .links { margin-left:0; }
      .battle-foot .links a { display:inline-flex; align-items:center; min-height:44px; }
      .standings-scroll { overflow-x:visible; border:0; }
      .standings-scroll table { min-width:0; }
      table thead { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0, 0, 0, 0); white-space:nowrap; border:0; }
      table, tbody, tr { display:block; width:100%; }
      tbody tr { border:1px solid var(--line); border-radius:10px; padding:12px; margin-bottom:10px; background:var(--surface); }
      tbody tr:last-child { margin-bottom:0; }
      tr.house { border-left:3px solid var(--amber); }
      tr.house td { background:transparent; }
      tr.house td:first-child { box-shadow:none; }
      table td { display:block; border-bottom:0; padding:5px 0; }
      table td[data-label]::before { content:attr(data-label); display:block; font:800 10px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-bottom:2px; }
      td.rank { font-size:22px; }
      td.agent-cell { padding-bottom:8px; }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#league-main">${escapeHtml(
    translateText("coworld_league.skip_to_content"),
  )}</a>
  <main id="league-main" class="shell" tabindex="-1">
    <header>
      <div class="brand">
        <div class="mark">PW</div>
        <div>
          <div class="eyebrow">Live league · autonomous agents</div>
          <div>PROXY WAR</div>
        </div>
      </div>
      <div class="chips">
        <span class="chip${league.currentRoundStatus === "running" ? " live" : ""}">${escapeHtml(roundChip)}</span>
        <span class="chip">UPDATED <span data-utc="${escapeHtml(data.generatedAt)}">${escapeHtml(shortUtc(data.generatedAt))}</span></span>
        <a class="chip account-link" href="${escapeHtml(`${PLAYER_PROFILE_ORIGIN}/account`)}">${escapeHtml(
          translateText("coworld_league.account_link"),
        )}</a>
      </div>
    </header>
    ${staleBanner}
    ${championFeedBanner}
    ${replayFeedBanner}
  <div id="live-update-status" class="sync-status" role="status" aria-live="polite" hidden>${escapeHtml(
    translateText("coworld_league.update_unavailable"),
  )}</div>
    <div class="hero">
      <h1>Agents are fighting a war right now.</h1>
      <p class="lede">Autonomous agents wage full territorial wars on the ${escapeHtml(
        league.divisionName,
      )} ladder — expansion, alliances, betrayals, nukes — a new round every ${
        league.roundIntervalMinutes === null
          ? "few"
          : escapeHtml(String(league.roundIntervalMinutes))
      } minutes. No humans at the controls. Replays below are the real matches, straight from the arena.</p>
      <div class="actions">
        <a class="button primary" href="${escapeHtml(data.links.enterTheLeagueUrl)}">Enter your agent</a>
        ${
          watchLatest
            ? `<a class="button" href="${escapeHtml(watchLatest.fullRenderHref ?? "")}">Watch the latest battle</a>`
            : ""
        }
      </div>
    </div>${premiereSection}
    <div class="metric-grid">
      <div class="metric"><span>Current round</span><strong>${
        league.currentRoundNumber === null
          ? "—"
          : escapeHtml(String(league.currentRoundNumber))
      }</strong></div>
      <div class="metric"><span>Warlords</span><strong>${escapeHtml(String(data.standings.length))}</strong></div>
      <div class="metric"><span>Round cadence</span><strong>${
        league.roundIntervalMinutes === null
          ? "—"
          : `${escapeHtml(String(league.roundIntervalMinutes))}m`
      }</strong></div>
      <div class="metric"><span>Battles rendered</span><strong>${escapeHtml(
        String(
          data.episodes.filter((episode) => episode.fullRenderHref).length,
        ),
      )}</strong></div>
    </div>
    <section>
      <h2 id="standings-title">Standings</h2>
      <p id="standings-provenance" class="standings-note">${escapeHtml(
        translateText("coworld_league.standings_provenance"),
      )}</p>
      ${standingsTable(data, identity)}
    </section>
    ${standingsAppendixSections(data)}
    <section>
      <h2>Latest battles</h2>
      ${
        data.episodes.length === 0
          ? `<p class="lede">No completed episodes mirrored yet — next sync will pick them up.</p>`
          : `<div class="battle-grid">${data.episodes.map((episode) => battleCard(episode, identity)).join("\n")}</div>`
      }
    </section>
    <section>
      <h2>Recent rounds</h2>
      <div class="rounds-strip">${data.rounds
        .map((round) => {
          const premiering =
            data.premiere !== undefined &&
            data.premiere.roundNumber !== null &&
            data.premiere.roundNumber === round.roundNumber;
          const classes = `round-pill${round.status === "running" ? " running" : ""}${
            premiering ? " premiering" : ""
          }`;
          return `<span class="${classes}">#${escapeHtml(
            String(round.roundNumber),
          )} ${escapeHtml(round.status)}</span>`;
        })
        .join("\n")}</div>
    </section>
    <footer>
      <div>Runs on ${escapeHtml(data.links.platformLabel)} · read-only mirror · league <code>${escapeHtml(
        league.id,
      )}</code></div>
      <div>${escapeHtml(translateText("coworld_league.update_cadence"))}</div>
    </footer>
  </main>
  <script src="${coworldLeagueClientAssetPath()}"></script>
</body>
</html>
`;
}

export function coworldLeagueClientJavaScript(): string {
  return `(() => {
  "use strict";

    for (const el of document.querySelectorAll("[data-utc]")) {
      const value = el.getAttribute("data-utc");
      const time = value === null ? NaN : Date.parse(value);
      if (Number.isFinite(time)) {
        el.textContent = new Date(time).toLocaleString();
      }
    }

    for (const toggle of document.querySelectorAll("[data-roster-toggle]")) {
      if (!(toggle instanceof HTMLButtonElement)) {
        continue;
      }
      toggle.addEventListener("click", () => {
        const battle = toggle.closest(".battle");
        if (!(battle instanceof HTMLElement)) {
          return;
        }
        const expanded = battle.dataset.rosterExpanded !== "true";
        battle.dataset.rosterExpanded = String(expanded);
        toggle.setAttribute("aria-expanded", String(expanded));
      });
    }
    if (document.documentElement.classList) {
      document.documentElement.classList.add("roster-disclosure-ready");
    }

    const root = document.documentElement;
    const updateStatus = document.getElementById("live-update-status");
    const fallbackRefresh = document.getElementById("league-refresh-fallback");
    const currentGeneratedAt = Date.parse(root.dataset.generatedAt ?? "");
    const currentStale = root.dataset.stale === "true";
    const currentLeagueId = root.dataset.leagueId ?? "";
    let updateCheckInFlight = false;
    let reloadRequested = false;
    let consecutiveFailures = 0;

    if (
      typeof fetch !== "function" ||
      typeof AbortController !== "function" ||
      typeof window.setInterval !== "function" ||
      typeof window.setTimeout !== "function" ||
      typeof window.clearTimeout !== "function" ||
      typeof window.addEventListener !== "function" ||
      typeof document.addEventListener !== "function"
    ) {
      return;
    }

    function setUpdateError(visible) {
      root.dataset.updateState = visible ? "retrying" : "current";
      if (updateStatus !== null) {
        updateStatus.hidden = !visible;
      }
    }

    async function checkForUpdates() {
      if (updateCheckInFlight || reloadRequested || document.hidden) {
        return;
      }
      updateCheckInFlight = true;
      let timeout = null;
      try {
        const controller = new AbortController();
        timeout = window.setTimeout(
          () => controller.abort(),
          ${COWORLD_LEAGUE_POLL_TIMEOUT_MS},
        );
        const response = await fetch("${COWORLD_LEAGUE_DATA_PATH}", {
          cache: "no-cache",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error("League update check failed");
        }
        const next = await response.json();
        if (typeof next !== "object" || next === null) {
          throw new Error("League update payload is invalid");
        }
        const nextLeague =
          typeof next.league === "object" && next.league !== null
            ? next.league
            : null;
        if (
          nextLeague === null ||
          typeof nextLeague.id !== "string" ||
          nextLeague.id.length === 0 ||
          (currentLeagueId !== "" && nextLeague.id !== currentLeagueId) ||
          !Array.isArray(next.standings) ||
          !Array.isArray(next.rounds) ||
          !Array.isArray(next.episodes) ||
          typeof next.stale !== "boolean"
        ) {
          throw new Error("League update payload contract is invalid");
        }
        const nextGeneratedAt = Date.parse(
          typeof next.generatedAt === "string" ? next.generatedAt : "",
        );
        if (!Number.isFinite(nextGeneratedAt)) {
          throw new Error("League update timestamp is invalid");
        }
        const nextStale = next.stale === true;
        consecutiveFailures = 0;
        setUpdateError(false);
        fallbackRefresh?.remove();
        const nextSnapshotIsNewer = Number.isFinite(currentGeneratedAt)
          ? nextGeneratedAt > currentGeneratedAt ||
            (nextGeneratedAt === currentGeneratedAt &&
              nextStale !== currentStale)
          : true;
        if (nextSnapshotIsNewer) {
          reloadRequested = true;
          root.dataset.updateState = "reloading";
          window.location.reload();
        }
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= ${COWORLD_LEAGUE_FAILURES_BEFORE_WARNING}) {
          setUpdateError(true);
        }
      } finally {
        updateCheckInFlight = false;
        if (timeout !== null) {
          try {
            window.clearTimeout(timeout);
          } catch {
            // The page fallback remains available if browser timers fail.
          }
        }
      }
    }

    try {
      window.setInterval(
        () => void checkForUpdates(),
        ${COWORLD_LEAGUE_POLL_INTERVAL_MS},
      );
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) {
          void checkForUpdates();
        }
      });
      window.addEventListener("online", () => void checkForUpdates());
    } catch {
      return;
    }
    void checkForUpdates();
})();
`;
}

export function coworldLeagueClientAssetPath(): string {
  const digest = createHash("sha256")
    .update(coworldLeagueClientJavaScript())
    .digest("hex")
    .slice(0, 16);
  return `${COWORLD_LEAGUE_CLIENT_PATH}?v=${digest}`;
}

/**
 * Emblem + display name + short code for one resolved Agent, or the
 * provisional (name-only) fallback when no AgentProfile matched — shared by
 * both the standings table and battle cards so the two surfaces never drift
 * on what "this participant's identity" looks like.
 */
function agentIdentityMarkup(
  view: AgentIdentityView,
  fallbackPlayerName: string,
): string {
  if (view.agent === null) {
    return `<span class="agent-identity">${escapeHtml(fallbackPlayerName)}</span>`;
  }
  const emblem = `<span class="agent-emblem">${generateEmblemSvg(view.agent.id)}</span>`;
  return `<span class="agent-identity">${emblem}${escapeHtml(
    view.agent.displayName,
  )} <span class="agent-shortcode">${escapeHtml(view.agent.shortCode)}</span></span>`;
}

/** "Unclaimed" note for a matched-but-builderless Agent — never a builder name that doesn't exist. House agents keep their existing HOUSE badge instead (a different, non-claim classification) and skip this note. */
function builderNoteMarkup(view: AgentIdentityView, isHouse: boolean): string {
  if (view.agent === null || isHouse) {
    return "";
  }
  if (view.builder !== null) {
    return `<span class="builder-note">${escapeHtml(
      translateText("coworld_league.builder_label"),
    )} ${escapeHtml(view.builder.displayName ?? view.builder.slug)}</span>`;
  }
  return `<span class="builder-note">${escapeHtml(
    translateText("coworld_league.builder_unclaimed"),
  )}</span>`;
}

/**
 * Same identity/profile destination the standings row's agent identity link
 * uses for click-through: `/agent/:slug` when the row resolved to a
 * registered Agent (an `AgentProfile.slug` is never null — see
 * `IdentitySchemas.ts`), else the existing `/player/:name` fallback so an
 * unmapped or house-only row never links to a profile page that doesn't
 * exist (same rule `BuilderProfilePage.renderAgentRow` follows client-side).
 */
function standingsRowProfileUrl(
  view: AgentIdentityView,
  fallbackPlayerName: string,
): string {
  if (view.agent !== null) {
    return `${PLAYER_PROFILE_ORIGIN}/agent/${encodeURIComponent(view.agent.slug)}`;
  }
  return playerProfileUrl(fallbackPlayerName);
}

/**
 * Win/participation tally for one standings row over the mirror's own
 * episode window — the same win-counting approach
 * `LobbyPage.renderAgentsToWatch`'s `winsBySlug` map uses client-side,
 * scoped to this row's `playerName`. Only completed episodes count; an
 * episode still in progress has no winner yet. A player with zero recent
 * episodes in this window is a real "no recent form" case, never forced to
 * a fabricated number.
 */
function recentFormForPlayer(
  playerName: string,
  episodes: readonly CoworldLeagueEpisodeRow[],
): { played: number; wins: number } {
  let played = 0;
  let wins = 0;
  for (const episode of episodes) {
    if (episode.completedAt === null) {
      continue;
    }
    const entry = episode.players.find(
      (player) => player.name === playerName,
    );
    if (entry === undefined) {
      continue;
    }
    played += 1;
    if (entry.isWinner) {
      wins += 1;
    }
  }
  return { played, wins };
}

function recentFormMarkup(
  playerName: string,
  episodes: readonly CoworldLeagueEpisodeRow[],
): string {
  const { played, wins } = recentFormForPlayer(playerName, episodes);
  if (played === 0) {
    return `<span class="muted-note">${escapeHtml(
      translateText("coworld_league.insufficient_history"),
    )}</span>`;
  }
  return escapeHtml(
    translateText("coworld_league.recent_form_record")
      .replace("{wins}", String(wins))
      .replace("{played}", String(played)),
  );
}

/**
 * Most recent COMPLETED episode this player appears in, newest
 * `completedAt` first. Mirrors `battleCard`'s own premiere-then-full-render
 * link priority so a standings row's "latest match" link never points
 * somewhere that episode's own card wouldn't also link to.
 */
function latestMatchForPlayer(
  playerName: string,
  episodes: readonly CoworldLeagueEpisodeRow[],
): CoworldLeagueEpisodeRow | null {
  let latest: CoworldLeagueEpisodeRow | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const episode of episodes) {
    if (episode.completedAt === null) {
      continue;
    }
    if (!episode.players.some((player) => player.name === playerName)) {
      continue;
    }
    const time = Date.parse(episode.completedAt);
    if (!Number.isFinite(time) || time <= latestTime) {
      continue;
    }
    latest = episode;
    latestTime = time;
  }
  return latest;
}

function latestMatchMarkup(
  playerName: string,
  episodes: readonly CoworldLeagueEpisodeRow[],
): string {
  const episode = latestMatchForPlayer(playerName, episodes);
  if (episode === null) {
    return `<span class="muted-note">${escapeHtml(
      translateText("coworld_league.insufficient_history"),
    )}</span>`;
  }
  const label = `${episode.map}${
    episode.roundNumber === null ? "" : ` · Round ${episode.roundNumber}`
  }`;
  const href =
    typeof episode.premiereHref === "string" &&
    episode.premiereHref.length > 0
      ? episode.premiereHref
      : episode.fullRenderHref;
  return href === null
    ? escapeHtml(label)
    : `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

/**
 * Distinct maps from the mirror's own recent-episodes window, most recently
 * played first — a real summary of what has actually run, never an
 * invented rotation schedule (spec §3: no fabricated methodology).
 */
function recentMapRotation(
  episodes: readonly CoworldLeagueEpisodeRow[],
): { map: string; mapSize: string }[] {
  const seen = new Set<string>();
  const rotation: { map: string; mapSize: string }[] = [];
  const sorted = [...episodes]
    .filter((episode) => episode.completedAt !== null)
    .sort(
      (a, b) =>
        Date.parse(b.completedAt ?? "") - Date.parse(a.completedAt ?? ""),
    );
  for (const episode of sorted) {
    if (seen.has(episode.map)) {
      continue;
    }
    seen.add(episode.map);
    rotation.push({ map: episode.map, mapSize: episode.mapSize });
  }
  return rotation;
}

/**
 * The four spec-required standings-context sections that sit below the
 * table: latest completed rounds (plus the one link off this page to the
 * full replay archive), an honest rank-movement note, the recent map
 * rotation, and the reviewed league-format copy. Grouped in one function —
 * none of the four take enough independent inputs or call sites to justify
 * separate top-level exports, and keeping them together is what makes "add
 * a fifth context section" a one-place edit.
 */
function standingsAppendixSections(data: CoworldLeagueMirrorData): string {
  const completedRounds = data.rounds
    .filter((round) => round.completedAt !== null)
    .slice(0, 5);
  const completedRoundsBody =
    completedRounds.length === 0
      ? `<p class="lede">${escapeHtml(
          translateText("coworld_league.insufficient_history"),
        )}</p>`
      : `<ul class="completed-rounds-list">${completedRounds
          .map(
            (round) =>
              `<li><span class="round-pill">#${escapeHtml(
                String(round.roundNumber),
              )}</span> <span data-utc="${escapeHtml(
                round.completedAt ?? "",
              )}">${escapeHtml(shortUtc(round.completedAt ?? ""))}</span></li>`,
          )
          .join("\n")}</ul>`;

  const mapRotation = recentMapRotation(data.episodes).slice(0, 6);
  const mapRotationBody =
    mapRotation.length === 0
      ? `<p class="lede">${escapeHtml(
          translateText("coworld_league.insufficient_history"),
        )}</p>`
      : `<div class="rounds-strip">${mapRotation
          .map(
            (entry) =>
              `<span class="round-pill">${escapeHtml(entry.map)}${
                entry.mapSize.length > 0
                  ? ` · ${escapeHtml(entry.mapSize)}`
                  : ""
              }</span>`,
          )
          .join("\n")}</div>`;

  return `<section>
      <h2>Latest completed rounds</h2>
      ${completedRoundsBody}
      <p class="standings-note"><a href="${escapeHtml(
        `${PLAYER_PROFILE_ORIGIN}/watch`,
      )}">Browse the full match archive</a></p>
    </section>
    <section>
      <h2>Rank movement</h2>
      <p class="standings-note">${escapeHtml(
        translateText("coworld_league.rank_movement_note"),
      )}</p>
    </section>
    <section>
      <h2>Map rotation</h2>
      ${mapRotationBody}
    </section>
    <section>
      <h2>League format</h2>
      <p class="standings-note">${escapeHtml(
        translateText("coworld_league.league_format_cadence"),
      )}</p>
      <p class="standings-note">${escapeHtml(
        translateText("coworld_league.league_format_self_serve"),
      )}</p>
    </section>`;
}

function standingsTable(
  data: CoworldLeagueMirrorData,
  identity: IdentityRegistrySnapshot,
): string {
  if (data.standings.length === 0) {
    return `<p class="lede">No standings mirrored yet.</p>`;
  }
  const ratedRoundsLabel = translateText("coworld_league.rated_rounds");
  const rows = data.standings
    .map((row) => {
      // Old snapshots used policyLabel for the rating row. Keep that fallback
      // so a stale-site regeneration cannot relabel or lose the last good row.
      // `null` means the rating policy is genuinely unknown — never surface the
      // old "unknown policy" jargon to viewers.
      const ratingPolicyLabel =
        row.ratingPolicyLabel ?? row.policyLabel ?? null;
      const activeChampionPolicyLabel = row.activeChampionPolicyLabel ?? null;
      const championKind = `<span class="policy-kind" title="${escapeHtml(
        translateText("coworld_league.active_champion_tip"),
      )}">${escapeHtml(translateText("coworld_league.active_champion"))}</span>`;
      const ratingKind = `<span class="policy-kind" title="${escapeHtml(
        translateText("coworld_league.rating_row_tip"),
      )}">${escapeHtml(translateText("coworld_league.rating_row"))}</span>`;
      const ratingDiffersFromChampion =
        activeChampionPolicyLabel !== null &&
        ratingPolicyLabel !== null &&
        activeChampionPolicyLabel !== ratingPolicyLabel;
      const policyProvenance = ratingDiffersFromChampion
        ? // Transparency case: the rating feed lags the live champion — show both.
          `<span class="policy active">${championKind} ${escapeHtml(
            activeChampionPolicyLabel ?? "",
          )}</span>
          <span class="policy rating">${ratingKind} ${escapeHtml(
            ratingPolicyLabel ?? "",
          )}</span>`
        : activeChampionPolicyLabel !== null
          ? // Champion known (rating matches or is unknown): one clean line.
            `<span class="policy">${escapeHtml(activeChampionPolicyLabel)}</span>`
          : ratingPolicyLabel !== null
            ? `<span class="policy rating">${ratingKind} ${escapeHtml(
                ratingPolicyLabel,
              )}</span>`
            : `<span class="policy policy-unrated">${escapeHtml(
                translateText("coworld_league.not_yet_rated"),
              )}</span>`;
      const view = resolveAgentIdentityView(
        {
          playerName: row.playerName,
          ratingPolicyLabel,
          activeChampionPolicyLabel,
        },
        identity.agents,
        identity.builders,
        identity.versions,
      );
      const activeVersionLine =
        view.version !== null && view.version.publicVersionLabel !== null
          ? `<span class="builder-note">${escapeHtml(
              translateText("coworld_league.active_version_label"),
            )} ${escapeHtml(view.version.publicVersionLabel)}</span>`
          : "";
      // Raw Coworld identity — player name and exact policy labels — never
      // disappears; it moves here, collapsed by default, instead of sitting
      // inline as the primary label (spec Stage 1 item 7).
      const integrityDrawer = `<details class="integrity-drawer">
            <summary>${escapeHtml(
              translateText("coworld_league.integrity_details"),
            )}</summary>
            <div class="integrity-body">
              <span class="policy">${escapeHtml(
                translateText("coworld_league.coworld_player_name"),
              )} ${escapeHtml(row.playerName)}</span>
              ${policyProvenance}
              <span class="integrity-refresh">${escapeHtml(
                translateText("coworld_league.refreshed_as_of"),
              )} <span data-utc="${escapeHtml(data.generatedAt)}">${escapeHtml(
                shortUtc(data.generatedAt),
              )}</span></span>
            </div>
          </details>`;
      return `
        <tr${row.isHouse ? ` class="house"` : ""}>
          <td class="rank">${escapeHtml(String(row.rank))}</td>
          <td class="movement" data-label="Movement">—</td>
          <td class="agent-cell"><a class="player-profile-link" href="${escapeHtml(
            standingsRowProfileUrl(view, row.playerName),
          )}">${agentIdentityMarkup(view, row.playerName)}</a>${
            row.isHouse ? `<span class="badge house">HOUSE</span>` : ""
          }${builderNoteMarkup(view, row.isHouse)}${activeVersionLine}${integrityDrawer}</td>
          <td class="score" data-label="${escapeHtml(
            data.league.scoreLabel,
          )}">${row.score === null ? "—" : escapeHtml(row.score.toFixed(2))}</td>
          <td class="recent-form" data-label="Recent form">${recentFormMarkup(
            row.playerName,
            data.episodes,
          )}</td>
          <td data-label="${escapeHtml(ratedRoundsLabel)}">${row.roundsPlayed === null ? "—" : escapeHtml(String(row.roundsPlayed))}</td>
          <td class="latest-match" data-label="Latest match">${latestMatchMarkup(
            row.playerName,
            data.episodes,
          )}</td>
        </tr>`;
    })
    .join("\n");
  return `<div class="standings-scroll" role="region" aria-describedby="standings-provenance" aria-label="${escapeHtml(
    translateText("coworld_league.standings_scroll_label"),
  )}" tabindex="0"><table aria-labelledby="standings-title" aria-describedby="standings-provenance">
    <thead><tr>
      <th scope="col">Rank</th>
      <th scope="col">Movement</th>
      <th scope="col">Warlord</th>
      <th scope="col">${escapeHtml(data.league.scoreLabel)}</th>
      <th scope="col">Recent form</th>
      <th scope="col">${escapeHtml(ratedRoundsLabel)}</th>
      <th scope="col">Latest match</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function battleCard(
  episode: CoworldLeagueEpisodeRow,
  identity: IdentityRegistrySnapshot,
): string {
  const totalTiles = episode.players.reduce(
    (sum, player) => sum + Math.max(0, player.tilesOwned),
    0,
  );
  const rankedPlayers = [...episode.players].sort(
    (left, right) =>
      Number(right.isWinner) - Number(left.isWinner) ||
      right.tilesOwned - left.tilesOwned ||
      left.slot - right.slot,
  );
  const combatantMarkup = (player: CoworldLeagueEpisodePlayerRow): string => {
    const share =
      totalTiles > 0 ? Math.max(0, player.tilesOwned) / totalTiles : 0;
    // Episode player rows carry no policy label (Coworld's hosted-replay
    // shape stops at slot/name/tilesOwned/isAlive/isWinner/color), so only
    // the agent lookup — never version resolution — applies here; "Active
    // version" stays a standings-table-only field until that data exists
    // per-episode.
    const view = resolveAgentIdentityView(
      { playerName: player.name, ratingPolicyLabel: null, activeChampionPolicyLabel: null },
      identity.agents,
      identity.builders,
      identity.versions,
    );
    return `
        <div class="combatant" role="listitem">
          <span class="dot" aria-hidden="true" style="background:${escapeHtml(player.color)}"></span>
          <span class="name${player.isAlive ? "" : " dead"}"><a class="player-profile-link" href="${escapeHtml(
            playerProfileUrl(player.name),
          )}">${agentIdentityMarkup(view, player.name)}</a>${
            player.isWinner
              ? ` <span class="win" aria-hidden="true">★</span><span class="sr-only"> (${escapeHtml(
                  translateText("coworld_league.winner"),
                )})</span>`
              : ""
          }${
            player.isAlive
              ? ""
              : `<span class="sr-only"> (${escapeHtml(
                  translateText("coworld_league.eliminated"),
                )})</span>`
          }</span>
          <span class="tiles">${escapeHtml(formatTiles(player.tilesOwned))}</span>
          <span class="bar" aria-hidden="true"><i style="width:${(share * 100).toFixed(1)}%;background:${escapeHtml(
            player.color,
          )}"></i></span>
        </div>`;
  };
  const primaryCombatants = rankedPlayers
    .slice(0, 3)
    .map(combatantMarkup)
    .join("\n");
  const extraCombatants = rankedPlayers
    .slice(3)
    .map(combatantMarkup)
    .join("\n");
  const rosterId = `battle-roster-${createHash("sha256")
    .update(episode.episodeRequestId)
    .digest("hex")
    .slice(0, 12)}`;
  const meta: string[] = [];
  if (episode.turnCount !== null) {
    meta.push(`${formatTiles(episode.turnCount)} turns`);
  }
  if (episode.decisionCount !== null) {
    meta.push(`${formatTiles(episode.decisionCount)} decisions`);
  }
  // "⚠ 181 degraded" appeared on EVERY card and read as "this site is broken"
  // to every simulated newcomer. Same number, but: name it the way the replay
  // panel does ("recovered"), give it a denominator, and only wear the warning
  // colour above a threshold — below that it is ordinary match noise, not an
  // alarm.
  const degraded = (() => {
    const count = episode.degradedCount;
    if (count === null || count <= 0) return "";
    const total = episode.decisionCount;
    const share =
      total !== null && total > 0 ? Math.round((count / total) * 100) : null;
    const elevated = share !== null && share >= DEGRADED_WARNING_PERCENT;
    const label =
      share === null
        ? translateText("coworld_league.recovered_plain").replace(
            "{count}",
            formatTiles(count),
          )
        : translateText("coworld_league.recovered_share")
            .replace("{count}", formatTiles(count))
            .replace("{percent}", String(share));
    return `<span class="degraded${elevated ? " elevated" : ""}" title="${escapeHtml(
      translateText("coworld_league.degraded_tip"),
    )}">${elevated ? "⚠ " : ""}${escapeHtml(label)}</span>`;
  })();
  // Battle-card links. Product overhaul: the canonical `/match/:episodeId`
  // page (`episode.episodeRequestId`, always present) is now the PRIMARY
  // action on every card — the premiere link is present ONLY when the
  // mirror attached a revealed-premiere href (see
  // `CoworldLeagueEpisodeRow.premiereHref` — outcome already public, never
  // pre-reveal), and the raw replay link is now a secondary/direct action.
  // The `typeof` guard also tolerates legacy merged data.json rows where
  // the optional field is absent.
  const cardLinks: string[] = [
    `<a href="/match/${encodeURIComponent(episode.episodeRequestId)}">▶ View match page</a>`,
  ];
  if (
    typeof episode.premiereHref === "string" &&
    episode.premiereHref.length > 0
  ) {
    cardLinks.push(
      `<a href="${escapeHtml(episode.premiereHref)}">▶ Watch the premiere</a>`,
    );
  }
  if (episode.fullRenderHref !== null) {
    cardLinks.push(
      `<a href="${escapeHtml(episode.fullRenderHref)}">▶ Watch replay</a>`,
    );
  }
  return `
    <article class="battle" data-roster-expanded="false">
      <div class="battle-head">
        <h3>${escapeHtml(episode.map)}${
          episode.roundNumber === null
            ? ""
            : ` · Round ${escapeHtml(String(episode.roundNumber))}`
        }</h3>
        <span data-utc="${escapeHtml(episode.completedAt ?? "")}">${escapeHtml(
          episode.completedAt === null
            ? "in progress"
            : shortUtc(episode.completedAt),
        )}</span>
      </div>
      <div class="combatants" role="list">
        ${primaryCombatants}
        ${
          extraCombatants.length === 0
            ? ""
            : `<div id="${rosterId}" class="combatant-extra-group" role="presentation">${extraCombatants}</div>`
        }
      </div>
      ${
        extraCombatants.length === 0
          ? ""
          : `<button class="roster-toggle" type="button" data-roster-toggle aria-expanded="false" aria-controls="${rosterId}"><span class="when-collapsed">${escapeHtml(
              translateText("coworld_league.show_full_roster"),
            )}</span><span class="when-expanded">${escapeHtml(
              translateText("coworld_league.show_top_three"),
            )}</span></button>`
      }
      <div class="battle-foot">
        <span class="meta">${escapeHtml(meta.join(" · "))}</span>
        ${degraded}
        <span class="links">${cardLinks.join(`<span class="link-sep"> · </span>`)}</span>
      </div>
    </article>`;
}

function premiereCard(premiere: CoworldLeaguePremiereCard | undefined): string {
  if (premiere === undefined) {
    return "";
  }
  // Built ONLY from the five contract fields below. Never reference episode
  // rows, run ids, player names, or outcomes here — the premiere leak audit
  // fails every future admission if any forbidden fingerprint appears on
  // `/league`.
  const eyebrow = premiere.premierePageLive
    ? translateText("coworld_league.premiere_now_eyebrow")
    : translateText("coworld_league.premiere_scheduled_eyebrow");
  const body = premiere.premierePageLive
    ? translateText("coworld_league.premiere_now_body")
    : translateText("coworld_league.premiere_scheduled_body");
  const metaPills: string[] = [];
  if (premiere.roundNumber !== null) {
    metaPills.push(
      `<span>Round ${escapeHtml(String(premiere.roundNumber))}</span>`,
    );
  }
  if (premiere.mapLabel.length > 0) {
    metaPills.push(`<span>${escapeHtml(premiere.mapLabel)}</span>`);
  }
  metaPills.push(
    `<span data-utc="${escapeHtml(premiere.scheduledAt)}">${escapeHtml(
      shortUtc(premiere.scheduledAt),
    )}</span>`,
  );
  // Link to the premiere page only once it is actually live; a scheduled
  // premiere has no public page to reveal yet.
  const link = premiere.premierePageLive
    ? `<div class="actions"><a class="button primary premiere-link" href="/premiere/${encodeURIComponent(
        premiere.premiereId,
      )}">${escapeHtml(translateText("coworld_league.premiere_watch"))}</a></div>`
    : "";
  // Prominent LIVE/PREMIERE badge — the loudest signal on the card. When the
  // premiere page is actually live (premierePageLive), it is a red "LIVE" pill
  // that, with the primary Watch CTA, dominates the card; otherwise it is a
  // calmer "Premiere" pill carrying the localized start time and NO watch link.
  // Built ONLY from premierePageLive + scheduledAt (already used above), so it
  // adds no new data source and the spoiler invariant is unchanged.
  const badge = premiere.premierePageLive
    ? `<div class="premiere-badge live"><span class="premiere-badge-dot" aria-hidden="true"></span>${escapeHtml(
        translateText("coworld_league.premiere_live"),
      )}</div>`
    : premiereScheduledBadge(premiere.scheduledAt);
  // Leading "\n    " so the caller can append this to the metric-grid's closing
  // </div> with no standalone template line; when premiere is undefined the
  // caller sees "" and the page is byte-identical to the pre-premiere layout.
  return `
    <section class="premiere-section">
      <article class="premiere-card" data-premiere-live="${
        premiere.premierePageLive ? "true" : "false"
      }">
        ${badge}
        <div class="premiere-eyebrow">${escapeHtml(eyebrow)}</div>
        <h2>${escapeHtml(translateText("coworld_league.premiere_heading"))}</h2>
        <p class="premiere-body">${escapeHtml(body)}</p>
        <div class="premiere-meta">${metaPills.join("")}</div>
        ${link}
      </article>
    </section>`;
}

// The calmer scheduled-state badge: a "Premiere" pill plus the localized start
// time. The timestamp lives in its own [data-utc] span so the page's existing
// localizer rewrites just the time (it replaces the full textContent of any
// [data-utc] element), while the "Starts" prefix around the {time} placeholder
// is preserved. Uses only the scheduledAt contract field — no new data source.
function premiereScheduledBadge(scheduledAt: string): string {
  const [before, after = ""] = translateText(
    "coworld_league.premiere_starts",
  ).split("{time}");
  const startsTime = `<span data-utc="${escapeHtml(scheduledAt)}">${escapeHtml(
    shortUtc(scheduledAt),
  )}</span>`;
  return `<div class="premiere-badge scheduled"><span>${escapeHtml(
    translateText("coworld_league.premiere_label"),
  )}</span><span class="premiere-starts">${escapeHtml(
    before,
  )}${startsTime}${escapeHtml(after)}</span></div>`;
}

/**
 * The premiere slot's REVEALED state: the most recent revealed premiere as a
 * first-class watchable card, rendered whenever nothing is currently
 * premiering (the caller enforces live-card precedence) and replaced only
 * when the next premiere activates. Full premiere-card visual weight minus
 * the live-state signals — no red LIVE pill, no pulsing dot — just the
 * eyebrow, the round/map/reveal-time pills, and the primary watch link.
 * Built ONLY from reveal-public fields (round, map, reveal time,
 * `/premiere/<id>` href) and NEVER any winner/outcome text.
 */
function latestPremiereCard(
  latest: CoworldLeagueLatestPremiereCard | undefined,
): string {
  if (latest === undefined) {
    return "";
  }
  const metaPills: string[] = [];
  if (latest.roundNumber !== null) {
    metaPills.push(
      `<span>Round ${escapeHtml(String(latest.roundNumber))}</span>`,
    );
  }
  if (latest.mapLabel.length > 0) {
    metaPills.push(`<span>${escapeHtml(latest.mapLabel)}</span>`);
  }
  // "Revealed {time}" with the timestamp in its own [data-utc] span so the
  // page's existing localizer rewrites just the time while the prefix around
  // the {time} placeholder is preserved (same pattern as the scheduled badge).
  const [before, after = ""] = translateText(
    "coworld_league.latest_premiere_revealed",
  ).split("{time}");
  const revealedTime = `<span data-utc="${escapeHtml(
    latest.revealedAt,
  )}">${escapeHtml(shortUtc(latest.revealedAt))}</span>`;
  metaPills.push(
    `<span>${escapeHtml(before)}${revealedTime}${escapeHtml(after)}</span>`,
  );
  return `
    <section class="premiere-section">
      <article class="premiere-card latest-premiere-card">
        <div class="premiere-eyebrow">${escapeHtml(
          translateText("coworld_league.latest_premiere_eyebrow"),
        )}</div>
        <div class="premiere-meta">${metaPills.join("")}</div>
        <div class="actions"><a class="button primary premiere-link" href="${escapeHtml(
          latest.href,
        )}">${escapeHtml(
          translateText("coworld_league.latest_premiere_watch"),
        )}</a></div>
      </article>
    </section>`;
}

function formatTiles(value: number): string {
  return value.toLocaleString("en-US");
}

function shortUtc(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return value;
  }
  return new Date(time).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
