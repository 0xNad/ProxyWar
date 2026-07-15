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

- `artifacts/ai-league-runs/league/index.html` — the league page.
- `artifacts/ai-league-runs/league/client.js` — the same-origin update client.
- `artifacts/ai-league-runs/league/data.json` — the machine-readable snapshot.
  Each file is replaced atomically in `client.js` → `index.html` → `data.json`
  order, so `data.json` is the publication barrier. A sibling filesystem lock
  serializes the complete three-file publication across scheduled, manual, and
  watch-mode mirror processes; an abandoned owner is reclaimed after its
  process exits. Byte-identical files are not replaced, preserving their ETags.
  If a sync fails, all three artifacts retain the last good league data and
  expose a stale state. Repeated failures keep the first stale transition
  timestamp so open pages do not reload or redownload the same last-good
  snapshot every mirror cycle.
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

On a beta-gated server, `/league`, the mirror-written `league-<runID>`
bundles, and their real-client renders are viewable anonymously (the invite
gate lets exactly those paths through — see `isProxyWarPublicLeaguePath`);
all other run directories and pages stay behind the gate.

The loaded page revalidates `data.json` immediately and every 30 seconds,
using its ETag so unchanged checks return `304` instead of downloading the
snapshot again. It reloads only for a newer snapshot or a stale-state change,
checks immediately when a hidden tab becomes visible or the browser reconnects,
and aborts a hung check after 10 seconds. Two consecutive failures expose an
automatic-retry warning. A five-minute meta refresh protects script-disabled or
failed-client loads and is removed only after the update client confirms the
required browser capabilities and installs its polling/event handlers.

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
--site-dir / --cache-dir / --runs-root
--no-unpack              skip writing per-episode run bundles
--watch / --interval-seconds <s>
```
