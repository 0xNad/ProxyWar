# The Frontier: frontier models fight for `/world`

Season 2 (from 2026-10-07): five frontier models, one nation each, play a
free-for-all on Softmax Observatory twice a day. The winner of the latest
battle on a front holds that front on `/world`, and a Nerf Watch panel tracks
each model's results and how it thinks, day by day. Season 1 (2026-10-04/05,
four teams of three) is kept for its recap. This page says what runs where and
how to stop it. Ids are a snapshot; the commands beside them refresh them.

## Why Season 2 changed the setup

Season 1's 37 games (Grok won 25) measured the harness as much as the models:

- Spawn picks went in name order because no request set `episodeIndex`, so
  Astra always picked first and Grok always last, which gave Grok the quietest
  corners on every map.
- The per-game LLM cap was split evenly in dollars. At a 4.5x price gap per
  call it stopped the planner of 41 Astra and 38 Fable seats mid-game, and no
  Gemini or Grok seat.
- Anthropic slugs went through Messages with no reasoning control and 1,500
  output tokens; the others got reasoning `low` and 4,000. Plans refreshed in
  the background, so latency became part of play.
- The model barely steered: about 180 plan calls against 3,000 decisions a
  game; the executor took the first menu option within a kind; 8.8% of
  decisions were struck as "unknown action id" because the server reserves
  same-step diplomacy in roster order; all 2,532 messages were five canned
  strings; games ended on the 60-minute timer with no nukes or betrayals.

## The pieces

| Piece        | Where                                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Game package | coworld `proxywar-frontier-ffa` (Season 2); `proxywar-frontier-four` `cow_02f4462d-454d-48f0-b71f-2c1f302bdfab` (Season 1) | Season 2 is the Season 1 package with a merge patch (`coworld-adapter/coworld/frontier-ffa.patch.json`, result `coworld_manifest_frontier_ffa.json`): variants `ffa5-<map>` (Compact, 240 steps of 100 turns, 40 game minutes) and `ffa5-canary` (48 steps). Same game image; each seat is its own single-seat team so `team_labels` can name it. |
| Agent        | `coworld-adapter/frontier-four/player.mjs` (v2.0.0)                                                                        | One image, one policy per model (`frontier-astra`, `frontier-fable`, `frontier-opus`, `frontier-gemini`, `frontier-grok`), each pinned with `--use-llm --llm-model`.                                                                                                                                                                              |
| Scheduler    | `coworld-adapter/frontier-four/scheduler.py`                                                                               | Season 2 config and state: `~/Library/Application Support/ProxyWar/frontier-ffa/` (`frontier-ffa.json`, `state.json`, `frontier-ffa-games.jsonl`; test games go to `frontier-ffa-test-games.jsonl`). LaunchAgent `com.proxywar.frontier-four`.                                                                                                    |
| Publisher    | `deploy/mac/start-proxywar-frontier-four-publisher.zsh`                                                                    | LaunchAgent `com.proxywar.frontier-four-publisher`, every minute; publishes when its inputs or the UTC hour change. `PROXYWAR_FRONTIER_SEASON=1` publishes Season 1 instead.                                                                                                                                                                      |
| World        | `src/server/agents/FrontierFourWorld.ts`, `src/server/agents/FrontierForm.ts`, `src/scripts/frontier-four-publish.ts`      | Writes `world.json`, `frontier-form.json` (Nerf Watch), `/match/<id>` rows and the `world-source.json` marker into the league site directory.                                                                                                                                                                                                     |

## How a Season 2 game is kept fair

- Spawn order: every request sets `game_config_overrides.episodeIndex`; over
  every block of five games each model picks its start first once, and the
  rotation also balances each map across cycles. Each record keeps
  `sides[].pickOrder`.
- Equal thinking: every seat plans at step 1 and every 15 steps (17 plans in
  a 240-step game) and the game waits for the plan, so every plan lands at
  the same game time. Every model gets the same request: Chat Completions,
  3,000 output tokens, reasoning `low` (dropped for a model only when its
  route refuses it, logged as `control_dropped`).
- The LLM cap is a safety net set per seat (`caps.per_seat_llm_usd`, $5, so
  a five-seat request sends $25), well above what 17 plans cost.
- The model writes the plan (target, build order, allies, betrayal, nuke,
  private `say` lines to rivals, a public `dispatch`); the executor carries
  it out and sends diplomacy in a second batch slot, so a struck alliance ask
  no longer turns the map move into a hold.

## Money

- Requests are paid in the account's experience credits, ten per dollar of
  model calls plus compute. The free grant is 71 credits a day (accumulating
  to 1,000). A Season 1 game cost about 113 credits; Season 2 aims at about
  35 so that two battles a day fit the free grant.
- A request's credit reservation is the mean cost of earlier episodes in the
  same coworld; the first request in a new coworld reserves 10 x its spend
  limit + 0.5. That is why Season 2 has its own coworld, and why its first
  request should be the canary (`test_per_seat_llm_usd`, $1 a seat).
- On HTTP 402 the scheduler holds until the refill time the refusal names and
  logs `credits_exhausted` once; a missed appointment is skipped, not doubled.
- The platform also funds the `proxywar` coworld at a daily budget
  (`GET /v2/coworlds/proxywar/budget`); `caps.min_remaining_usd` refuses
  launches below a floor.

## Where each piece must run from

macOS gates file access on removable volumes per executable (System
Settings, Privacy & Security, Files and Folders). Apple's own binaries such
as zsh and cp pass; node and Python need a grant, which the operator gives
by answering the prompt the first time that binary asks. A launchd job
cannot answer that prompt, and while it is pending every launchd job's
volume access on the Mac blocks in `getcwd()` or `open()`, granted or not,
until the prompt is answered after unlocking the screen or the user's
`tccd` restarts. The league mirror and the premiere loop stalled this way
on 2026-10-04 after the scheduler's Python first touched the deploy worktree.

So the scheduler's Python (a uv build without a grant) runs from a HOME copy
with its working directory, state and games file in HOME and never touches
a volume; the scheduler refuses a config with a `publish` key. Publishing is
the publisher job: zsh as the program and the granted node binary doing the
work, the shape of the league mirror. Keep both that way when changing either
job. A stalled launchd node shows near-zero CPU and `sample <pid> 1` ends in
`__getcwd` and `open$NOCANCEL`.

## Running it

Both jobs are LaunchAgents; the templates are in `deploy/mac/`:

```bash
B="$HOME/Library/Application Support/ProxyWar/bin"
cp deploy/mac/start-proxywar-frontier-four.zsh deploy/mac/start-proxywar-frontier-four-publisher.zsh "$B/"
chmod 755 "$B"/start-proxywar-frontier-four*.zsh
cp deploy/mac/com.proxywar.frontier-four.plist.example ~/Library/LaunchAgents/com.proxywar.frontier-four.plist
cp deploy/mac/com.proxywar.frontier-four-publisher.plist.example ~/Library/LaunchAgents/com.proxywar.frontier-four-publisher.plist
# replace every /Users/YOUR_USER and /Volumes/YOUR_VOLUME placeholder, then:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.proxywar.frontier-four.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.proxywar.frontier-four-publisher.plist
```

The scheduler's virtual environment is
`~/Library/Application Support/ProxyWar/frontier-four/venv` with the pinned
`coworld` package (`uv venv <venv> && uv pip install --python <venv>/bin/python coworld==0.1.56`).
Copy `coworld-adapter/frontier-four/frontier-ffa.example.json` to
`frontier-ffa/frontier-ffa.json` and fill in the coworld id and the five
policy version ids. A dry tick reads the budget, shows the next game and
creates nothing. `--launch-now --variant ffa5-canary` runs one test game
that goes to the test games file and does not advance the rotation:

```bash
PY="$HOME/Library/Application Support/ProxyWar/frontier-four/venv/bin/python"
CFG="$HOME/Library/Application Support/ProxyWar/frontier-ffa/frontier-ffa.json"
"$PY" coworld-adapter/frontier-four/scheduler.py --config "$CFG" --dry-run --once
"$PY" coworld-adapter/frontier-four/scheduler.py --config "$CFG" --launch-now --variant ffa5-canary --once
```

Battles run at `schedule.times_utc` (13:00 and 19:00 UTC by default). Stop
the loop with `launchctl bootout gui/$(id -u)/com.proxywar.frontier-four`;
to keep it stopped across logins also run
`launchctl disable gui/$(id -u)/com.proxywar.frontier-four` (undo with
`enable`). Games already launched finish on their own and are recorded by
the next tick after a restart. Logs: `~/Library/Logs/proxywar-frontier-four.log`
(one JSON event per line) and `~/Library/Logs/proxywar-frontier-four-publisher.log`.

## Handing the world back to the league

While `world-source.json` in the league site directory says `frontier-four`,
the league mirror leaves `world.json` and the world ledger alone. To return
`/world` to the league:

```bash
node --import tsx/esm src/scripts/frontier-four-publish.ts \
  --site-dir "/Volumes/Crucial X9/ProxyWar/live-artifacts/ai-league-runs/league" --restore-league
```

The mirror's next publish rebuilds the league world from its ledger.

## Checks

- `npx vitest tests/coworld/FrontierFourPlayer.test.ts tests/coworld/FrontierPlayerExecutor.test.ts tests/coworld/FrontierPlayerMock.test.ts tests/server/FrontierFourWorld.test.ts tests/server/FrontierForm.test.ts tests/server/FrontierMatchPageHttp.test.ts tests/coworld/CoworldTeams.test.ts --run`
- `cd coworld-adapter/frontier-four && python3 -m unittest discover -s tests`
- A native five-seat canary: `coworld-adapter/src/no-docker-coworld-episode.ts` with `team_count: 5`, `seat_teams: [0,1,2,3,4]`, `team_labels`, and `player.mjs` pointed at `mock-llm-server.mjs` through `COWORLD_LLM_ENDPOINT` (see the memory note on the local no-Docker episode recipe).
- New package versions go up with `coworld upload-coworld --from-coworld <base> --patch <merge-patch> [--image game=<local tag>]`; the plain manifest route runs a local certification episode, which cannot run amd64 game images under Colima's emulation on this Mac.
