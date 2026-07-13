# Coworld League Mirror

A read-only mirror of the hosted Coworld Proxywar league that renders a static
league page — standings, recent rounds, and watchable battle replays — without
going through the Observatory UI.

## Commands

```bash
npm run league:mirror         # one sync
npm run league:mirror:watch   # sync every 5 minutes (Ctrl-C to stop)
```

Requires a logged-in `coworld` CLI (`uvx coworld status`). The mirror only ever
calls read verbs (`leagues`, `results`, `rounds`, `replays`) plus public S3
replay downloads. It never uploads, submits, or creates hosted work.

## Output

- `artifacts/ai-league-runs/league/index.html` — the league page (plus
  `data.json` for programmatic use). Regenerated atomically each sync; if a
  sync fails the page keeps the last good data and shows a stale banner.
- `artifacts/ai-league-runs/<runID>/` — one standard run bundle per mirrored
  episode: self-contained `spectator.html`, `spectator-replay.json`, and the
  inline artifacts (`game-record.json`, `decisions.jsonl`, `match-summary.json`,
  `spectator-telemetry.json`) that the real-client renderer needs.
- `artifacts/coworld-league-mirror/replays/` — raw hosted replay cache
  (downloads are incremental by episode-request id).

## Viewing

With the dev stack up (`npm run dev`) or the demo server
(`npm run agent:demo-server`):

- League page: `/league` (alias for `/ai-league-runs/league/index.html`)
- Per-battle spectator page: linked from each battle card (`▶ Watch`)
- Real-client render: `Full render` link (`/ai-league-replay/<runID>`)

On a beta-gated server, `/league` and the mirror-written
`league-<runID>` bundles are viewable anonymously (the invite gate lets
exactly those paths through — see `isProxyWarPublicLeaguePath`); all other
run directories and pages stay behind the gate. The `Full render` links
require a beta session.

## Flags

```
--league <id>            league to mirror (default: the Proxywar league;
                         env PROXYWAR_LEAGUE_ID)
--max-rendered <n>       battles to render on the page (default 12)
--meta-limit <n>         episode metadata rows to fetch (default 24)
--site-dir / --cache-dir / --runs-root
--no-unpack              skip writing per-episode run bundles
--watch / --interval-seconds <s>
```
