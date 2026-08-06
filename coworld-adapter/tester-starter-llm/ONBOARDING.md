# Onboarding: build a ProxyWar agent

A complete walkthrough from zero to *"my agent played a match."* Budget ~15 minutes.

## What you're building

ProxyWar is a live **AI-vs-AI** strategy game — claim territory, form alliances, betray
them, build economy, nuke rivals. You write an **agent** (a "policy"). Each turn it
receives the game state plus a list of **legal moves**, and picks one. It plays the whole
match autonomously; afterward you watch the rendered replay.

The default agent in this repo is **LLM-powered (Claude via Bedrock) — no API key needed.**
You can't make an illegal move, so your agent can never break the game, only play it well
or badly.

## Prerequisites

`launch.sh` checks all of this itself, fixes what it safely can (asking first), and tells
you exactly what's left. The only step it can never do for you is the browser sign-in.

| You need | Why | Who handles it |
|---|---|---|
| **Docker** installed | packages your agent into a container | **You**: [docs.docker.com/get-docker](https://docs.docker.com/get-docker/). Installed but not running? The script offers to start it (macOS). |
| **uv** | runs the Softmax CLI | **The script** — offers the official user-space install if it's missing. |
| **A Softmax account** | to upload your agent | **The script** — runs the free browser sign-in on first use. |

macOS and Linux are supported (on Windows, use WSL). Apple Silicon is fine — the build
targets linux/amd64 automatically. **No model API key is required** — the agent reaches
Claude through Softmax's in-cluster Bedrock.

> Check your setup without changing anything: `bash launch.sh --doctor`.
> Running it via a coding agent / CI: add `--yes` to auto-approve the safe setup steps.

## Step 1 — Get the starter

```bash
git clone https://github.com/0xNad/proxywar-coworld-starter.git
cd proxywar-coworld-starter
```

No separate sign-in step — `launch.sh` runs the browser sign-in for you when needed.

## Step 2 — Run it as-is (your first match)

```bash
bash launch.sh my-agent
```

This checks your setup (offering to install uv / start Docker, and signing you in if
needed), builds your agent, uploads it (Bedrock auto-enabled), and prints your
**policy id** (a UUID) — a diagnostic reference, not proof you're in the league yet.
First build pulls a base image (a couple of minutes, once).

Uploading isn't entering the league — do that next:

```bash
uvx --from coworld coworld leagues        # find the Proxywar league id
uvx --from coworld coworld submit my-agent:v1 --league <league_id>
```

The default agent already plays a real game: it reads your share/troops/gold and each
rival's relative strength, expands early, defends when weak, attacks weak bordered rivals,
and avoids repeating a move that stopped helping.

## Step 3 — Make it your own

Open **`llm-player.mjs`** and edit three things — that's your agent:

- **`STRATEGY`** — the standing orders you hand the model (plain English: how it should play).
- **`buildState`** — the game facts you show the model.
- **`choose`** — how the model's plan becomes one legal move each turn.

The model doesn't pick individual moves — it writes a short **PLAN** (`{"focus": ...,
"preferKinds": [...], "target": ..., "avoidTargets": [...], "reason": ...}`) from your
`STRATEGY` plus a compact `GAME` state (`self`, `rivals`, `avoid` list, `legalActions`).
The agent answers every decision instantly from the current plan and refreshes the plan in
the background every `PLAN_EVERY` decisions (default 3). If the model returns junk or
Bedrock hiccups, it keeps playing on the last good plan and flags the decision as degraded.

> **Choosing your own spawn tile:** every unspawned agent gets a normal
> decision opportunity during the spawn phase, and it is not limited to the
> offered candidate menu — you may reply with any well-formed `spawn:<tile>`
> id (`tile = y * width + x`) for a currently-legal tile you prefer. The game
> exposes bounded geometry for this in `request.match.map`
> (`name`/`width`/`height`) and `request.decisionSupport.spawnFreeform`
> (id format, the small set of tiles other agents currently have reserved,
> and the minimum distance your tile must keep from them) whenever
> `observation.phase === "spawn"`. An illegal or malformed request is
> rejected with a specific reason and the game deterministically places you
> with its own algorithmic fallback instead — you can never miss spawning.
> Full contract: `coworld-adapter/docs/player-protocol.md`.

Re-run `bash launch.sh my-agent` to push a new version.

> **Why not ask the model every turn?** Hosted matches have a hard **wall-clock budget**
> set by the match package (league games currently allow up to 100 minutes; older packages
> only 20). Blocking ~15s on a model call per decision burns the budget waiting — and a
> killed match is scored as a loss no matter how well you played. Plan-in-background
> answers in milliseconds, so full 300-decision games finish with time to spare.

## Step 4 — Iterate

Edit `STRATEGY`/`buildState` → `bash launch.sh my-agent` → `uvx --from coworld coworld submit my-agent:vN --league <league_id>` (bump `vN` each time).

## Prefer a non-LLM agent?

`starter-player.mjs` is a ~80-line rule agent (no model, no Bedrock). Point `launch.sh` at
`--run node --run /app/starter-player.mjs` and drop `--use-bedrock`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Not sure your machine is ready | `bash launch.sh --doctor` — reports everything, changes nothing. |
| `Cannot connect to the Docker daemon` | The script offers to start Docker Desktop (macOS); otherwise start your Docker runtime and re-run. |
| `command not found: uv` | The script offers to install it. If it was just installed, open a new terminal (fresh PATH) and re-run. |
| `Not authenticated` | The script signs you in automatically; to redo it manually: `uvx --from softmax-cli softmax login`. |
| First build is slow | Normal — pulls the Node base image once. |
| `permission denied: ./launch.sh` | Run it as `bash launch.sh my-agent`. |
| Replay shows `BEDROCK_FAIL` on some turns | Shared Bedrock capacity throttled; the agent fell back safely. Usually transient. |
| Policy id not printed | softmax.com/observatory → your policy → copy the version id. |

## Reference

Matches, replays, and per-decision logs live at **softmax.com/observatory**. Each decision
records its `reason`, so you can see exactly what your agent was thinking.
