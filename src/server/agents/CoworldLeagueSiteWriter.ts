import { promises as fs } from "node:fs";
import path from "node:path";

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

export interface CoworldLeagueMirrorData {
  generatedAt: string;
  lastGoodSyncAt: string;
  stale: boolean;
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
  links: {
    enterTheLeagueUrl: string;
    platformLabel: string;
  };
}

export interface CoworldLeagueSitePaths {
  indexPath: string;
  dataPath: string;
}

export async function writeCoworldLeagueSite(
  siteDir: string,
  data: CoworldLeagueMirrorData,
): Promise<CoworldLeagueSitePaths> {
  await fs.mkdir(siteDir, { recursive: true });
  const indexPath = path.join(siteDir, "index.html");
  const dataPath = path.join(siteDir, "data.json");
  await fs.writeFile(indexPath, coworldLeagueIndexHtml(data));
  await fs.writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`);
  return { indexPath, dataPath };
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
  const watchLatest = data.episodes.find((episode) => episode.watchHref);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="300">
  <title>Proxy War — Live League</title>
  <style>
    :root { color-scheme: dark; --bg:#080b10; --surface:#111720; --surface2:#18202b; --line:#2a3442; --text:#edf1f7; --muted:#a4afbf; --amber:#f4a64a; --cyan:#7ad7f0; --good:#7ee0a8; --bad:#ff9b8f; }
    * { box-sizing:border-box; }
    html, body { max-width:100%; overflow-x:hidden; }
    body { margin:0; background:linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px), var(--bg); background-size:48px 48px,48px 48px,auto; color:var(--text); font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .shell { width:100%; max-width:1180px; margin:0 auto; padding:24px 18px 56px; }
    header { display:flex; justify-content:space-between; gap:16px; align-items:center; margin-bottom:14px; flex-wrap:wrap; }
    .brand { display:flex; gap:10px; align-items:center; font-weight:900; }
    .mark { width:34px; height:34px; border:1px solid rgba(231,235,242,.5); display:grid; place-items:center; border-radius:5px; font:800 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .eyebrow { color:var(--amber); font:800 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform:uppercase; letter-spacing:.14em; }
    .chips { display:flex; gap:8px; flex-wrap:wrap; }
    .chip { border:1px solid var(--line); background:var(--surface); border-radius:999px; padding:7px 12px; font:800 12px ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--muted); }
    .chip.live { border-color:rgba(126,224,168,.5); color:var(--good); }
    .stale-banner { border:1px solid rgba(244,166,74,.5); background:rgba(244,166,74,.08); color:var(--amber); border-radius:6px; padding:10px 12px; margin-bottom:14px; font-weight:800; }
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
    section { margin-bottom:26px; }
    table { width:100%; border-collapse:collapse; background:var(--surface); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
    th, td { padding:10px 12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:middle; }
    th { background:var(--surface2); font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
    tr:last-child td { border-bottom:0; }
    tr.house td { background:rgba(244,166,74,.07); }
    tr.house td:first-child { box-shadow:inset 3px 0 0 var(--amber); }
    td.rank { font:900 16px ui-monospace, SFMono-Regular, Menlo, monospace; width:52px; }
    td.score { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-weight:800; }
    .policy { display:block; color:var(--muted); font:600 12px ui-monospace, SFMono-Regular, Menlo, monospace; margin-top:2px; }
    .badge { display:inline-block; border-radius:4px; padding:2px 7px; font:800 10px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:.08em; margin-left:6px; vertical-align:2px; }
    .badge.house { border:1px solid rgba(244,166,74,.5); color:var(--amber); }
    .battle-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:14px; }
    .battle { background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:14px; display:flex; flex-direction:column; gap:10px; }
    .battle-head { display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
    .battle-head b { font-size:15px; }
    .battle-head span { color:var(--muted); font:700 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .combatant { display:grid; grid-template-columns:12px minmax(0,1fr) 62px; gap:8px; align-items:center; }
    .dot { width:10px; height:10px; border-radius:3px; }
    .combatant .name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:700; }
    .combatant .name.dead { color:var(--muted); text-decoration:line-through; }
    .combatant .name .win { color:var(--good); }
    .tiles { color:var(--muted); font:700 11px ui-monospace, SFMono-Regular, Menlo, monospace; text-align:right; }
    .bar { grid-column:2 / 4; height:4px; background:var(--surface2); border-radius:2px; overflow:hidden; }
    .bar i { display:block; height:100%; }
    .battle-foot { display:flex; justify-content:space-between; align-items:center; gap:8px; border-top:1px solid var(--line); padding-top:10px; margin-top:2px; }
    .battle-foot .meta { color:var(--muted); font:700 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .degraded { border:1px solid rgba(244,166,74,.5); color:var(--amber); border-radius:4px; padding:2px 7px; font:800 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .rounds-strip { display:flex; gap:8px; flex-wrap:wrap; }
    .round-pill { border:1px solid var(--line); background:var(--surface); border-radius:6px; padding:8px 10px; font:700 12px ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--muted); }
    .round-pill.running { border-color:rgba(126,224,168,.5); color:var(--good); }
    footer { border-top:1px solid var(--line); padding-top:16px; color:var(--muted); font-size:13px; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; }
    @media (max-width:640px) { .battle-grid { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <div class="shell">
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
            ? `<a class="button" href="${escapeHtml(watchLatest.watchHref ?? "")}">Watch the latest battle</a>`
            : ""
        }
      </div>
    </div>
    <div class="metric-grid">
      <div class="metric"><span>Current round</span><strong>${
        league.currentRoundNumber === null ? "—" : escapeHtml(String(league.currentRoundNumber))
      }</strong></div>
      <div class="metric"><span>Warlords</span><strong>${escapeHtml(String(data.standings.length))}</strong></div>
      <div class="metric"><span>Round cadence</span><strong>${
        league.roundIntervalMinutes === null ? "—" : `${escapeHtml(String(league.roundIntervalMinutes))}m`
      }</strong></div>
      <div class="metric"><span>Battles rendered</span><strong>${escapeHtml(
        String(data.episodes.filter((episode) => episode.watchHref).length),
      )}</strong></div>
    </div>
    <section>
      <h2>Standings</h2>
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
        .map(
          (round) =>
            `<span class="round-pill${round.status === "running" ? " running" : ""}">#${escapeHtml(
              String(round.roundNumber),
            )} ${escapeHtml(round.status)}</span>`,
        )
        .join("\n")}</div>
    </section>
    <footer>
      <div>Runs on ${escapeHtml(data.links.platformLabel)} · read-only mirror · league <code>${escapeHtml(
        league.id,
      )}</code></div>
      <div>Auto-refreshes every 5 minutes</div>
    </footer>
  </div>
  <script>
    for (const el of document.querySelectorAll("[data-utc]")) {
      const value = el.getAttribute("data-utc");
      const time = value === null ? NaN : Date.parse(value);
      if (Number.isFinite(time)) {
        el.textContent = new Date(time).toLocaleString();
      }
    }
  </script>
</body>
</html>
`;
}

function standingsTable(data: CoworldLeagueMirrorData): string {
  if (data.standings.length === 0) {
    return `<p class="lede">No standings mirrored yet.</p>`;
  }
  const rows = data.standings
    .map(
      (row) => `
        <tr${row.isHouse ? ` class="house"` : ""}>
          <td class="rank">${escapeHtml(String(row.rank))}</td>
          <td>${escapeHtml(row.playerName)}${
            row.isHouse ? `<span class="badge house">HOUSE</span>` : ""
          }<span class="policy">${escapeHtml(row.policyLabel)}</span></td>
          <td class="score">${row.score === null ? "—" : escapeHtml(row.score.toFixed(2))}</td>
          <td>${row.roundsPlayed === null ? "—" : escapeHtml(String(row.roundsPlayed))}</td>
        </tr>`,
    )
    .join("\n");
  return `<table>
    <thead><tr><th>Rank</th><th>Warlord</th><th>${escapeHtml(
      data.league.scoreLabel,
    )}</th><th>Rounds</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function battleCard(episode: CoworldLeagueEpisodeRow): string {
  const totalTiles = episode.players.reduce(
    (sum, player) => sum + Math.max(0, player.tilesOwned),
    0,
  );
  const combatants = episode.players
    .map((player) => {
      const share =
        totalTiles > 0 ? Math.max(0, player.tilesOwned) / totalTiles : 0;
      return `
        <div class="combatant">
          <span class="dot" style="background:${escapeHtml(player.color)}"></span>
          <span class="name${player.isAlive ? "" : " dead"}">${escapeHtml(player.name)}${
            player.isWinner ? ` <span class="win">★</span>` : ""
          }</span>
          <span class="tiles">${escapeHtml(formatTiles(player.tilesOwned))}</span>
          <span class="bar"><i style="width:${(share * 100).toFixed(1)}%;background:${escapeHtml(
            player.color,
          )}"></i></span>
        </div>`;
    })
    .join("\n");
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
    <article class="battle">
      <div class="battle-head">
        <b>${escapeHtml(episode.map)}${
          episode.roundNumber === null ? "" : ` · Round ${escapeHtml(String(episode.roundNumber))}`
        }</b>
        <span data-utc="${escapeHtml(episode.completedAt ?? "")}">${escapeHtml(
          episode.completedAt === null ? "in progress" : shortUtc(episode.completedAt),
        )}</span>
      </div>
      ${combatants}
      <div class="battle-foot">
        <span class="meta">${escapeHtml(meta.join(" · "))}</span>
        ${degraded}
        <span class="links">${
          episode.watchHref === null
            ? `<span class="meta">replay pending</span>`
            : `<a href="${escapeHtml(episode.watchHref)}">▶ Watch</a>`
        }${
          episode.fullRenderHref === null
            ? ""
            : `<span class="meta"> · </span><a href="${escapeHtml(
                episode.fullRenderHref,
              )}">Full render</a>`
        }</span>
      </div>
    </article>`;
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
