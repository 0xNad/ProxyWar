import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import englishTranslations from "../../../resources/lang/en.json";

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
  /** Policy label attached to the historical leaderboard rating row. */
  ratingPolicyLabel: string;
  /** Policy currently marked as this player's active champion, if any. */
  activeChampionPolicyLabel: string | null;
  /** @deprecated Compatibility alias for existing data.json consumers. */
  policyLabel: string;
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
  mapSize: string;
  difficulty: string;
  turnCount: number | null;
  decisionCount: number | null;
  degradedCount: number | null;
  winnerName: string | null;
  players: CoworldLeagueEpisodePlayerRow[];
  /** Relative href from the league index to a self-contained spectator page. */
  watchHref: string | null;
  /** Absolute path served by the Vite/demo stack for the real-client render. */
  fullRenderHref: string | null;
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
  links: {
    enterTheLeagueUrl: string;
    platformLabel: string;
  };
}

export interface CoworldLeagueSitePaths {
  indexPath: string;
  clientPath: string;
  dataPath: string;
}

export const COWORLD_LEAGUE_POLL_INTERVAL_MS = 30_000;
export const COWORLD_LEAGUE_POLL_TIMEOUT_MS = 10_000;
const COWORLD_LEAGUE_FAILURES_BEFORE_WARNING = 2;
export const COWORLD_LEAGUE_CLIENT_PATH = "/ai-league-runs/league/client.js";
export const COWORLD_LEAGUE_DATA_PATH = "/ai-league-runs/league/data.json";
const COWORLD_LEAGUE_WRITE_LOCK_RETRY_MS = 50;
const COWORLD_LEAGUE_WRITE_LOCK_TIMEOUT_MS = 60_000;
const COWORLD_LEAGUE_WRITE_LOCK_OWNER_GRACE_MS = 30_000;

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

async function writeCoworldLeagueSiteUnlocked(
  siteDir: string,
  data: CoworldLeagueMirrorData,
): Promise<CoworldLeagueSitePaths> {
  await fs.mkdir(siteDir, { recursive: true });
  const indexPath = path.join(siteDir, "index.html");
  const clientPath = path.join(siteDir, "client.js");
  const dataPath = path.join(siteDir, "data.json");
  // Publish data.json last. Existing pages only reload after observing a newer
  // snapshot, so they cannot race ahead of either the client or the HTML.
  await writeFileAtomic(clientPath, coworldLeagueClientJavaScript());
  await writeFileAtomic(indexPath, coworldLeagueIndexHtml(data));
  await writeFileAtomic(dataPath, `${JSON.stringify(data, null, 2)}\n`);
  return { indexPath, clientPath, dataPath };
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

export function coworldLeagueIndexHtml(data: CoworldLeagueMirrorData): string {
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
  const premiereSection = premiereCard(data.premiere);
  // Premiere-only CSS, emitted ONLY when a premiere card is present. Keeping it
  // out of the static <style> block when absent is what makes the mirror's
  // index.html byte-identical to pre-premiere output for a stale/absent
  // contract. Leading "\n    " with no trailing newline so it slots between two
  // existing style rules without shifting any bytes when empty.
  const premiereStyles =
    data.premiere === undefined
      ? ""
      : "\n    " +
        [
          ".round-pill.premiering { border-color:rgba(122,215,240,.6); color:var(--cyan); box-shadow:inset 0 0 0 1px rgba(122,215,240,.25); }",
          ".premiere-card { border:1px solid rgba(122,215,240,.5); background:linear-gradient(180deg, rgba(122,215,240,.09), rgba(122,215,240,.02)), var(--surface); border-radius:10px; padding:18px; display:flex; flex-direction:column; gap:10px; }",
          ".premiere-card .premiere-eyebrow { color:var(--cyan); font:800 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform:uppercase; letter-spacing:.14em; }",
          ".premiere-card h2 { margin:0; font-size:20px; }",
          ".premiere-card .premiere-body { margin:0; color:#cbd3df; max-width:640px; }",
          ".premiere-card .premiere-meta { display:flex; gap:8px; flex-wrap:wrap; color:var(--muted); font:700 12px ui-monospace, SFMono-Regular, Menlo, monospace; }",
          ".premiere-card .premiere-meta span { border:1px solid var(--line); background:var(--surface2); border-radius:999px; padding:4px 10px; }",
          ".premiere-card .actions { margin-top:2px; }",
        ].join("\n    ");
  return `<!doctype html>
<html lang="en" data-generated-at="${escapeHtml(data.generatedAt)}" data-stale="${data.stale ? "true" : "false"}" data-league-id="${escapeHtml(league.id)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta id="league-refresh-fallback" http-equiv="refresh" content="300">
  <title>Proxy War — Live League</title>
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
    table { width:100%; min-width:600px; border-collapse:collapse; background:var(--surface); }
    th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:middle; }
    th { background:var(--surface2); font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
    tr:last-child td { border-bottom:0; }
    tr.house td { background:rgba(244,166,74,.07); }
    tr.house td:first-child { box-shadow:inset 3px 0 0 var(--amber); }
    td.rank { font:900 16px ui-monospace, SFMono-Regular, Menlo, monospace; width:52px; }
    td.score { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-weight:800; }
    .policy { display:block; color:var(--muted); font:600 12px ui-monospace, SFMono-Regular, Menlo, monospace; margin-top:2px; }
    .policy.active { color:var(--good); font-weight:800; }
    .policy-kind { display:inline-block; min-width:116px; font-size:10px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
    .badge { display:inline-block; border-radius:4px; padding:2px 7px; font:800 10px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:.08em; margin-left:6px; vertical-align:2px; }
    .badge.house { border:1px solid rgba(244,166,74,.5); color:var(--amber); }
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
    .degraded { border:1px solid rgba(244,166,74,.5); color:var(--amber); border-radius:4px; padding:2px 7px; font:800 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
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
    </div>
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
    </div>${premiereSection}
    <section>
      <h2 id="standings-title">Standings</h2>
      <p id="standings-provenance" class="standings-note">${escapeHtml(
        translateText("coworld_league.standings_provenance"),
      )}</p>
      ${standingsTable(data)}
    </section>
    <section>
      <h2>Latest battles</h2>
      ${
        data.episodes.length === 0
          ? `<p class="lede">No completed episodes mirrored yet — next sync will pick them up.</p>`
          : `<div class="battle-grid">${data.episodes.map(battleCard).join("\n")}</div>`
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

function standingsTable(data: CoworldLeagueMirrorData): string {
  if (data.standings.length === 0) {
    return `<p class="lede">No standings mirrored yet.</p>`;
  }
  const rows = data.standings
    .map((row) => {
      // Old snapshots used policyLabel for the rating row. Keep that fallback
      // so a stale-site regeneration cannot relabel or lose the last good row.
      const ratingPolicyLabel =
        row.ratingPolicyLabel ?? row.policyLabel ?? "unknown policy";
      const activeChampionPolicyLabel = row.activeChampionPolicyLabel ?? null;
      const ratingDiffersFromChampion =
        activeChampionPolicyLabel !== null &&
        activeChampionPolicyLabel !== ratingPolicyLabel;
      const policyProvenance = ratingDiffersFromChampion
        ? `<span class="policy active"><span class="policy-kind">${escapeHtml(
            translateText("coworld_league.active_champion"),
          )}</span> ${escapeHtml(activeChampionPolicyLabel ?? "")}</span>
          <span class="policy rating"><span class="policy-kind">${escapeHtml(
            translateText("coworld_league.rating_row"),
          )}</span> ${escapeHtml(ratingPolicyLabel)}</span>`
        : activeChampionPolicyLabel === null
          ? `<span class="policy rating"><span class="policy-kind">${escapeHtml(
              translateText("coworld_league.rating_row"),
            )}</span> ${escapeHtml(ratingPolicyLabel)}</span>`
          : `<span class="policy">${escapeHtml(ratingPolicyLabel)}</span>`;
      return `
        <tr${row.isHouse ? ` class="house"` : ""}>
          <td class="rank">${escapeHtml(String(row.rank))}</td>
          <td>${escapeHtml(row.playerName)}${
            row.isHouse ? `<span class="badge house">HOUSE</span>` : ""
          }${policyProvenance}</td>
          <td class="score">${row.score === null ? "—" : escapeHtml(row.score.toFixed(2))}</td>
          <td>${row.roundsPlayed === null ? "—" : escapeHtml(String(row.roundsPlayed))}</td>
        </tr>`;
    })
    .join("\n");
  return `<div class="standings-scroll" role="region" aria-describedby="standings-provenance" aria-label="${escapeHtml(
    translateText("coworld_league.standings_scroll_label"),
  )}" tabindex="0"><table aria-labelledby="standings-title" aria-describedby="standings-provenance">
    <thead><tr><th>Rank</th><th>Warlord</th><th>${escapeHtml(
      data.league.scoreLabel,
    )}</th><th>${escapeHtml(
      translateText("coworld_league.rated_rounds"),
    )}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function battleCard(episode: CoworldLeagueEpisodeRow): string {
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
    return `
        <div class="combatant" role="listitem">
          <span class="dot" aria-hidden="true" style="background:${escapeHtml(player.color)}"></span>
          <span class="name${player.isAlive ? "" : " dead"}">${escapeHtml(player.name)}${
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
  const degraded =
    episode.degradedCount !== null && episode.degradedCount > 0
      ? `<span class="degraded">⚠ ${escapeHtml(String(episode.degradedCount))} degraded</span>`
      : "";
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
        <span class="links">${
          episode.fullRenderHref === null
            ? `<span class="meta">replay pending</span>`
            : `<a href="${escapeHtml(episode.fullRenderHref)}">▶ Watch replay</a>`
        }</span>
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
  // Leading "\n    " so the caller can append this to the metric-grid's closing
  // </div> with no standalone template line; when premiere is undefined the
  // caller sees "" and the page is byte-identical to the pre-premiere layout.
  return `
    <section class="premiere-section">
      <article class="premiere-card" data-premiere-live="${
        premiere.premierePageLive ? "true" : "false"
      }">
        <div class="premiere-eyebrow">${escapeHtml(eyebrow)}</div>
        <h2>${escapeHtml(translateText("coworld_league.premiere_heading"))}</h2>
        <p class="premiere-body">${escapeHtml(body)}</p>
        <div class="premiere-meta">${metaPills.join("")}</div>
        ${link}
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
