# Coworld League Mirror

A read-only mirror of the hosted Coworld Proxywar league that renders a static
league page — standings, recent rounds, and watchable battle replays — without
going through the Observatory UI.

## Commands

```bash
npm run league:mirror                        # one sync
npm run league:mirror:watch                  # sync every 5 minutes (Ctrl-C to stop)
npm run league:mirror -- --recover-pins-only # restore missing pinned evidence
npm run league:prune                         # safe plan only; reports prune candidates
npm run league:prune -- --apply              # archive summaries, then delete candidates
```

Requires a logged-in `coworld` CLI (`uvx coworld status`). The mirror only ever
calls read verbs (`leagues`, `results`, `memberships`, `rounds`, `episodes`,
`replays`) plus public S3 replay downloads. It never uploads, submits, or
creates hosted work.

The standings preserve the policy label returned by `results` as the rating-row
provenance, then show the player's current active champion from the read-only
membership list. When those labels differ (for example, a promoted champion
whose inherited rating row still names `v7`), the page shows both. Rank, score,
and **rated rounds** remain explicitly attached to the rating row instead of
being assigned to the newer policy. House ownership is shown only when a current
champion has the exact `Commander:vN` policy name or the retained rollback
lineage `proxywar-keystone:vN`.

## Round integrity

The canonical detector is
`src/server/agents/CoworldLeagueRoundIntegrity.ts`. It reads the live ladder
contract from `settings.ladder.scheduler.num_episodes`,
`settings.round_interval_minutes`, and
`settings.ladder.fulfillment.allowed_failures`; checks only terminal completed
rounds after every expected episode-request row is present and terminal; and
counts a request as score-bearing only when it has an episode id, a running
timestamp, no error, and one finite unique score for every scheduled policy.
The exact completed-without-running/no-score phantom is reported separately.
Coworld's episode-list response can omit those execution fields even when the
detail response contains them, so the mirror and sentinel hydrate the latest
round's completed summaries through bounded read-only episode-detail calls.
If any detail read fails, the round is incomplete evidence, never a failure.

A breach first appears as confirmation-pending. Identical episode evidence must
persist for 60 seconds before the state becomes degraded. A later healthy round
clears current degradation while retaining the last confirmed breach. Missing
or partial episode evidence retains the last verified assessment and marks only
the round-integrity feed delayed; replay-only failures remain isolated under
`replayFeedStale`.

The installed `pw-league-sentinel.mjs` is machine-local operating code, not a
tracked repository source. Build/copy of the detector alone is not activation:
the sentinel must also import the adapter and call it from its hosted-round
collection path. The tracked installer stages the exact tested detector,
dependency-free adapter, and sentinel patch together:

```bash
SENTINEL="$HOME/Library/Application Support/ProxyWar/bin/pw-league-sentinel.mjs"
node scripts/install-pw-league-round-integrity-sentinel.mjs dry-run \
  --sentinel "$SENTINEL"

# Record these before the authorized install and pass the exact values back.
REPOSITORY_SHA="$(git rev-parse HEAD)"
SENTINEL_SHA="$(shasum -a 256 "$SENTINEL" | awk '{print $1}')"
node scripts/install-pw-league-round-integrity-sentinel.mjs install \
  --sentinel "$SENTINEL" \
  --expected-sentinel-sha256 "$SENTINEL_SHA" \
  --expected-repository-sha "$REPOSITORY_SHA"

node scripts/install-pw-league-round-integrity-sentinel.mjs verify \
  --sentinel "$SENTINEL" \
  --receipt '/exact/receiptPath/from-install-output/receipt.json'
```

The adapter evaluates the latest completed round directly from read-only
Coworld league/division/episode reads. It emits
`round_incomplete_execution:round_<id>` only when the same breached round and
episode-evidence hash survive a second direct read at least 60 seconds later.
The class is deliberately absent from the sentinel's autofix allow-list.

## Scheduler health

`CoworldLeagueSchedulerHealth.ts` evaluates hosted round timestamps without
mutating or restarting the league. An explicit hosted pause is reported as
paused. Otherwise, silence longer than the larger of two hours or three
configured round intervals is delayed. The current state and the latest proven
gap between adjacent round numbers are published in `schedulerHealth`; a later
round returns current status to healthy while retaining the recent recovered
gap for diagnosis. Non-adjacent list rows never prove a gap.

## Per-player fallback attribution

New match summaries include cycle-level `playerReliability` aggregates: brain
decisions, fallbacks, degraded decisions, and bounded degradation-cause counts.
The mirror joins those server-authored aggregates to replay participants and
shows non-zero fallback shares on the responsible player, rather than leaving
the match-wide total to look like a platform-wide failure. Raw policy output
and failure text are not included.

Installation creates a timestamped receipt and exact backups beside the
sentinel, installs the detector and adapter first, then atomically replaces the
sentinel as the activation barrier. It does not restart launchd. The install
fails closed on sentinel or repository SHA drift at staging and immediately
before activation, any tracked repository modification, syntax/self-test
failure, or partial integration. `verify` requires that install receipt and
rebuilds the detector from the receipt-bound clean repository SHA; marker-only
wiring is not proof. Roll back using the exact `receiptPath` printed by the
install (also without restarting):

```bash
node scripts/install-pw-league-round-integrity-sentinel.mjs rollback \
  --receipt '/absolute/path/from-install-output/receipt.json'
```

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
  `spectator-telemetry.json`) that the real-client renderer needs. The mirror
  also generates `replay-ui.json`, a bounded projection containing aggregate
  decision counts and the newest 60 display-safe decisions. The real renderer
  loads only `game-record.json` before its first frame, then hydrates the panel
  from these smaller evidence artifacts; it does not download the raw JSONL as
  part of replay startup.
- `artifacts/coworld-league-mirror/replays/` — raw hosted replay cache
  (downloads are incremental by episode-request id).
- `artifacts/coworld-league-mirror/summaries/` — indefinite compact evidence:
  gzip-compressed hosted result records plus byte-faithful `match-summary.json`
  `game-record.json`, and `spectator-telemetry.json` copies made before heavy
  artifacts are removed.

The mirror owns only direct `league-coworld-*` run directories and
`ereq_*.replay` cache files. A whole-cycle filesystem lock serializes fetch,
download, unpack, publication, stale fallback, and pruning. Every artifact
referenced by the published `data.json` is protected. By default, retention also
keeps the newest 24 raw replays and newest 96 rendered bundles. Ordering comes
from each replay's validated embedded run timestamp, not filesystem mtime.
The durable pin manifest at `deploy/coworld-league-retention-pins.json` protects
explicitly cited evidence in addition to the current published battles.
Unrelated runs, files, temporary files, symlinks, unmarked directories, and the
`league/` site directory are never candidates. Before deletion, the pruner
atomically archives compact results and the three small evidence files; any archive
failure aborts deletion. A hard 10 GiB free-space reserve pauses replay writes
and keeps the last published battle cards while standings and rounds continue
updating. `league:prune` is plan-only by default and requires `--apply` to delete;
both modes use the same whole-cycle lock and fail closed if published or pinned
reference data is unavailable, malformed, or unsafe.

## World map (`/world`)

Every publish also maintains the persistent world map over the league:

- `artifacts/ai-league-runs/league/world-ledger.json` — private, append-only
  battle results (one row per episode-request id: map, winner, completion
  time). Merged idempotently; a recorded winner is never rewritten. A corrupt
  ledger is left untouched and the last good `world.json` stays published.
- `artifacts/ai-league-runs/league/world.json` — the public read model the
  `/world` page and the front page (`/`) fetch (allowlisted beside
  `read-model.json`). It is rebuilt from the whole ledger on every publish, so
  it never drifts from it. Its `links` carry the read model's account and
  starter URLs, so the front page never has to load the read model.

Each battle's map is one front of an Earth map
(`src/server/agents/CoworldLeagueWorld.ts`, `WORLD_THEATRES`). A front belongs
to the agent with the most wins in its last 12 battles; a tie keeps the holder
and shows the front under siege. Pangaea, World and Giant World Map battles
decide the Crown instead of a region. Fronts with no battles stay unclaimed
until a matching map enters the rotation:

| Front         | Maps that decide it                          |
| ------------- | -------------------------------------------- |
| North America | NorthAmerica                                 |
| South America | SouthAmerica, AmazonRiver                    |
| Britannia     | Britannia, BritanniaClassic                  |
| Europe        | Europe, EuropeClassic, Italia, Iceland, Alps |
| Black Sea     | BlackSea, BosphorusStraits, Caucasus         |
| Middle East   | Mena, MiddleEast, StraitOfHormuz             |
| Africa        | Africa, NileDelta                            |
| Asia          | Asia, Yenisei, Baikal                        |
| East Asia     | EastAsia, Japan                              |
| Oceania       | Oceania, Australia, StraitOfMalacca          |
| The Crown     | Pangaea, World, GiantWorldMap                |

The mirror only sees battles it mirrors, so a fresh install starts the world
empty. Backfill it once from the durable summary archive (idempotent, takes the
same site lock, safe while the mirror runs):

```bash
npm run league:world-backfill -- \
  --site-dir artifacts/ai-league-runs/league \
  --archive artifacts/coworld-league-mirror/summaries
```

The pages' Earth (`src/client/publicapp/WorldMapGrid.ts`) is generated from the
game's own World map: every land tile joins the front of its nearest nation in
the World manifest, each nation assigned to the front whose battlefield maps
contain it. Rerun `npx tsx src/scripts/generate-world-map-grid.ts` only if
those assignments or the source map change; the output is deterministic.

The front page (`src/client/publicapp/HomePage.ts`) is the same world in one
screen: who is winning, the map with every holder named, the latest takeovers,
the rule worked through on a real front's last battles, and a prompt for a
coding agent to enter the league. It states liveness only from measured data
(the newest battle's age and battles in the last 24 hours), never from the
configured round schedule.

`/` serves the front page only once `world.json` exists; until then the league
host sends `/` to the event lobby (`/lobby`) and the apex keeps its static page.
Roll it out in this order, so the page never shows a partial history:

1. Deploy the mirror, so it publishes `world.json` with every cycle.
2. Run the backfill above once.
3. Rebuild the client (`npx vite build`); an old bundle still mounts the lobby
   at `/`.
4. Restart the servers.

When the division-wide replay feed is unavailable, the round-scoped fallback
reads the latest terminal rounds **including failed ones**: a round that misses
the rating threshold still contains finished, replayable battles. Round
integrity keeps reading completed rounds only.

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
--retain-raw <n>         newest raw replay files retained (default 24)
--retain-bundles <n>     newest rendered bundles retained (default 96)
--min-free-gib <n>       reserve below which replay writes pause (minimum 10)
--pin-manifest <path>    durable evidence pins (default deploy manifest)
--summary-archive <path> compact indefinite evidence archive
--recover-pins-only      restore every manifest pin without republishing the site
--site-dir / --cache-dir / --runs-root
--no-unpack              skip writing per-episode run bundles
--watch / --interval-seconds <s>
```

The standalone prune command accepts the same retention, pin, archive, and path
flags. It prints a plan by default; pass `--apply` only after reviewing that plan.
