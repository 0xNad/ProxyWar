# Coworld League Mirror

A read-only mirror of the hosted Coworld Proxywar league that renders a static
league page — standings, recent rounds, and watchable battle replays — without
going through the Observatory UI.

## Commands

```bash
npm run league:mirror             # one sync
npm run league:mirror:watch       # sync every 5 minutes (Ctrl-C to stop)
npm run league:prune -- --dry-run # report obsolete mirror-owned artifacts
```

Requires a logged-in `coworld` CLI (`uvx coworld status`). The mirror only ever
calls read verbs (`leagues`, `results`, `memberships`, `rounds`, `replays`) plus
public S3 replay downloads. It never uploads, submits, or creates hosted work.

The standings preserve the policy label returned by `results` as the rating-row
provenance, then show the player's current active champion from the read-only
membership list. When those labels differ (for example, a promoted champion
whose inherited rating row still names `v7`), the page shows both. Rank, score,
and **rated rounds** remain explicitly attached to the rating row instead of
being assigned to the newer policy. House ownership is shown only when a current
champion has the exact `proxywar-keystone:vN` policy name.

## Output

- `artifacts/ai-league-runs/league/index.html` — the league page.
- `artifacts/ai-league-runs/league/client.js` — the same-origin update client.
- `artifacts/ai-league-runs/league/data.json` — the machine-readable snapshot.
  Each file is replaced atomically in `client.js` → `index.html` → `data.json`
  order, so `data.json` is the publication barrier. A sibling filesystem lock
  serializes the complete three-file publication across scheduled, manual, and
  watch-mode mirror processes; an abandoned owner is reclaimed after its
  process exits. Byte-identical files are not replaced, preserving their ETags.
  If a required league, standings, or rounds read fails, all three
  artifacts retain the last good league data and expose a stale state. Repeated
  failures keep the first stale transition timestamp so open pages do not
  reload or redownload the same last-good snapshot every mirror cycle. Champion
  memberships and replay processing are fail-soft: a membership failure
  publishes explicitly qualified rating rows without claiming house ownership,
  while a replay-list, download, or parse failure publishes fresh standings and
  rounds, retains available last-good battle cards, and shows a component-level
  warning.
- `artifacts/ai-league-runs/<runID>/` — one standard run bundle per mirrored
  episode: self-contained `spectator.html`, `spectator-replay.json`, and the
  inline artifacts (`game-record.json`, `decisions.jsonl`, `match-summary.json`,
  `spectator-telemetry.json`) that the real-client renderer needs.
- `artifacts/coworld-league-mirror/replays/` — raw hosted replay cache
  (downloads are incremental by episode-request id).

The mirror owns only direct `league-coworld-*` run directories and
`ereq_*.replay` cache files. A whole-cycle filesystem lock serializes fetch,
download, unpack, publication, stale fallback, and pruning. Every artifact
referenced by the published `data.json` is protected. By default, retention also
keeps the newest 48 artifacts and everything younger than six hours; unrelated
runs, files, temporary files, symlinks, and the `league/` site directory are
never candidates. A 5 GiB free-space reserve pauses replay downloads and keeps
the last published battle cards while standings and rounds continue updating.
Use `league:prune -- --dry-run` before a manual cleanup; the real prune command
uses the same whole-cycle lock and fails closed if the published references are
missing or unsafe.

## Viewing

With the dev stack up (`npm run dev`) or the demo server
(`npm run agent:demo-server`):

- League page: `/league` (alias for `/ai-league-runs/league/index.html`)
- Per-battle spectator page: linked from each battle card (`▶ Watch`)
- Real-client render: `Full render` link (`/ai-league-replay/<runID>`)

On a beta-gated server, `/league`, the mirror-written `league-<runID>`
bundles, and their real-client renders are viewable anonymously (the invite
gate lets exactly those paths through — see `isProxyWarPublicLeaguePath`);
all other run directories and pages stay behind the gate.

The loaded page revalidates `data.json` immediately and every 30 seconds, using
its ETag so unchanged checks return `304` instead of downloading the snapshot
again. It reloads only for a newer snapshot or a stale-state change, checks
immediately when a hidden tab becomes visible or the browser reconnects, and
aborts a hung check after 10 seconds. It rejects a mismatched league id or a
payload missing the standings, rounds, or episodes arrays. For one rollout
compatibility window, legacy HTML without a league-id marker accepts the fixed
same-origin data endpoint after validating its non-empty league id. Two consecutive
failures expose an automatic-retry warning. A five-minute meta refresh protects
script-disabled or failed-client loads and is removed only after the first
validated polling response. The script URL carries a content hash so an older
Cloudflare-cached client cannot survive a frontend release.

The league page's Content Security Policy must keep `script-src 'self'` and
`connect-src 'self'` so `client.js` can load and revalidate `data.json`. Do not
add `unsafe-inline` or `unsafe-eval`. The server binds this policy to the actual
league HTML response, including `/league` route aliases and static directory or
extension aliases. The mirror process and serving process should run from the
same clean release checkout while sharing the explicit live artifact root;
running the mirror from a mutable development checkout makes branch edits an
implicit publish path.

`PROXYWAR_LEAGUE_WRAPPER_ONLY=true` goes further: the server serves ONLY the
league mirror and its replay renders. Everything else — beta login, hub,
`/play`, tester dashboard, admin, relay and job APIs (anything that could
start a match on the operator's account) — is unreachable; GETs redirect to
`/league` and other methods 404. Remove the env flag and restart to bring the
full beta server back.

## Flags

```
--league <id>            league to mirror (default: the Proxywar league;
                         env PROXYWAR_LEAGUE_ID)
--max-rendered <n>       battles to render on the page (default 12)
--meta-limit <n>         episode metadata rows to fetch (default 24)
--retain-replays <n>     newest mirror artifacts retained (default 48)
--retain-hours <n>       always retain artifacts newer than this (default 6)
--min-free-gib <n>       reserve below which replay writes pause (default 5)
--site-dir / --cache-dir / --runs-root
--no-unpack              skip writing per-episode run bundles
--watch / --interval-seconds <s>
```
