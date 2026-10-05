# The Frontier Four

Four teams of three nations, each team one frontier model, fight over the
fronts of `/world` in hosted team games that our own scheduler creates on
Softmax Observatory. This page says what runs where and how to stop it.
Ids and spend figures here are a snapshot from 2026-10-04; the commands
beside them are the way to refresh them.

## The pieces

| Piece        | Where                                                                            | Notes                                                                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Game package | coworld `proxywar-frontier-four` (`cow_02f4462d-454d-48f0-b71f-2c1f302bdfab`)    | The canonical Proxy War image plus the team overlay (`coworld-adapter/Dockerfile.frontier-four-game`). Manifest: `coworld-adapter/coworld/coworld_manifest_frontier_four.json`. Variants `teams-4x3-<map>`, one per playable front, and a 2x2 canary.  |
| Team agent   | `coworld-adapter/frontier-four/player.mjs`                                       | The public LLM starter's executor with the model behind the platform's LLM sidecar. One image, four policies: `frontier-astra`, `frontier-fable`, `frontier-gemini`, `frontier-grok`, each pinned to its model at upload with `--use-llm --llm-model`. |
| Scheduler    | `coworld-adapter/frontier-four/scheduler.py`                                     | Launches one game per front per cycle and records settled games. Config and state: `~/Library/Application Support/ProxyWar/frontier-four/`. LaunchAgent `com.proxywar.frontier-four` (`deploy/mac/start-proxywar-frontier-four.zsh`).                  |
| Publisher    | `deploy/mac/start-proxywar-frontier-four-publisher.zsh`                          | LaunchAgent `com.proxywar.frontier-four-publisher`, every minute: when the games file differs from what it last published, runs the world script below and keeps a copy of what it published (`games.published.jsonl`).                                |
| World        | `src/server/agents/FrontierFourWorld.ts`, `src/scripts/frontier-four-publish.ts` | Game records become world battles held by teams; `world.json`, `/match/<id>` rows and the `world-source.json` marker are written into the league site directory.                                                                                       |

## Seats and names

Hosted dispatch names every seat after the policy's owner, and an account
holds at most two player identities, so the request names the sides
instead: `game_config_overrides.team_labels` lists the team per team index,
and the game names seats `<team> <n>`. The variant's `seat_teams` fixes which
slots belong to which team index; the scheduler rotates and shuffles which
team takes which index per game so every team cycles through every spawn
group.

## Money

- The platform funds the `proxywar` coworld at a daily budget (read it with
  `GET /v2/coworlds/proxywar/budget`; $300 on 2026-10-04). The league's own
  rounds cost roughly $15–60 a day in compute.
- Every request carries `episode_player_llm_spend_limit_usd` (the per-game LLM
  cap, split evenly across the twelve seats); the config's `caps` also hold
  the loop to a daily total and refuse to launch when the coworld's remaining
  funds drop below a floor.
- Requests are paid in the account's experience credits, roughly ten per
  dollar of model calls, on top of the coworld's own budget. The free grant is
  71 credits a day, far below one game, so at this size the loop runs on
  purchased credits; when a launch is refused with HTTP 402 the loop holds
  until the refill time the refusal names and logs `credits_exhausted` once.
- `launch_interval_minutes` in the config spaces launches: at 60 the loop
  plays about one game an hour, roughly 24 a day, instead of two at a time
  until the daily cap.
- A seat that hits its share of the cap gets HTTP 429 from the sidecar, stops
  planning and keeps playing its last plan, and says so in every decision.

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
a volume; the config keeps `"publish": null`. Publishing is the publisher
job: zsh as the program and the granted node binary doing the work, the
shape of the league mirror. Keep both that way when changing either job.
A stalled launchd node shows near-zero CPU and `sample <pid> 1` ends in
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
A dry tick from a shell reads the budget, shows the next game and creates
nothing:

```bash
"$HOME/Library/Application Support/ProxyWar/frontier-four/venv/bin/python" \
  coworld-adapter/frontier-four/scheduler.py \
  --config "$HOME/Library/Application Support/ProxyWar/frontier-four/frontier-four.json" --dry-run --once
```

Stop the loop with `launchctl bootout gui/$(id -u)/com.proxywar.frontier-four`
(and the same for `com.proxywar.frontier-four-publisher`). Games already
launched finish on their own and are recorded by the next tick after a
restart. Logs: `~/Library/Logs/proxywar-frontier-four.log` (one JSON event
per line) and `~/Library/Logs/proxywar-frontier-four-publisher.log`.

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

- `npx vitest tests/coworld/FrontierFourPlayer.test.ts tests/server/FrontierFourWorld.test.ts tests/coworld/CoworldTeams.test.ts --run`
- A native team canary of the game: `coworld-adapter/src/no-docker-coworld-episode.ts` with a config carrying `team_count`, `seat_teams` and `team_labels` (see the memory note on the local no-Docker episode recipe).
- Upload a new package version with `coworld upload-coworld --from-coworld <base> --patch <merge-patch> --image game=<local tag>`; the plain manifest route runs a local certification episode, which cannot run amd64 game images under Colima's emulation on this Mac.
