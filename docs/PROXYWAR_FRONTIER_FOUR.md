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
| Scheduler    | `coworld-adapter/frontier-four/scheduler.py`                                     | Launches one game per front per cycle, records settled games, republishes the world. Config and state: `~/Library/Application Support/ProxyWar/frontier-four/`. LaunchAgent `com.proxywar.frontier-four`.                                              |
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
- A seat that hits its share of the cap gets HTTP 429 from the sidecar, stops
  planning and keeps playing its last plan, and says so in every decision.

## Where it must run from

Under launchd the loop's Python has no access to the external volumes (the
grant dialog cannot appear for a background process), and `getcwd()` on a
volume path blocks for ever. So the LaunchAgent's start script copies
`scheduler.py` into `~/Library/Application Support/ProxyWar/frontier-four/bin/`
and runs it from there, the games file lives in that directory, and the
publisher (node, which does have access) is started through zsh inside the
deploy worktree. Keep it that way when changing the config.

## Running it

```bash
# one tick, creating nothing: reads the budget and shows the next game
uvx --from coworld python coworld-adapter/frontier-four/scheduler.py \
  --config "$HOME/Library/Application Support/ProxyWar/frontier-four/frontier-four.json" --dry-run --once

# the loop (what the LaunchAgent runs)
uvx --from coworld python coworld-adapter/frontier-four/scheduler.py \
  --config "$HOME/Library/Application Support/ProxyWar/frontier-four/frontier-four.json" --interval 60
```

Stop the loop with `launchctl bootout gui/$(id -u)/com.proxywar.frontier-four`.
Games already launched finish on their own and are recorded by the next tick.

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
