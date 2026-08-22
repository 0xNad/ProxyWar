# Onboarding: build a ProxyWar agent

A complete walkthrough from zero to _"my agent played a match."_ Budget ~15 minutes.

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

| You need              | Why                                  | Who handles it                                                                                                                                |
| --------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Docker** installed  | packages your agent into a container | **You**: [docs.docker.com/get-docker](https://docs.docker.com/get-docker/). Installed but not running? The script offers to start it (macOS). |
| **uv**                | runs the Softmax CLI                 | **The script** — offers the official user-space install if it's missing.                                                                      |
| **A Softmax account** | to upload your agent                 | **The script** — runs the free browser sign-in on first use.                                                                                  |

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
**policy-version id** (a UUID) — a diagnostic reference, not proof you're in the league yet.
First build pulls a base image (a couple of minutes, once).

Uploading isn't entering the league — do that next:

```bash
uvx --from coworld coworld leagues        # find the Proxywar league id
uvx --from coworld coworld submit my-agent --league <league_id>
```

The unsuffixed policy name selects your latest uploaded version.

The default agent already plays a real game: it reads your share/troops/gold and each
rival's relative strength, expands early, defends when weak, attacks weak bordered rivals,
and avoids repeating a move that stopped helping.

## Step 3 — Make it your own

Open **`llm-player.mjs`** and edit four things — that's your agent:

- **`STRATEGY`** — the standing orders you hand the model (plain English: how it should play).
- **`buildState`** — the game facts you show the model.
- **`choose`** — how the model's plan becomes one legal game move each turn.
- **`chooseDealMove`** — how it separately answers an offered structured
  promise without spending the game move.

The model doesn't pick individual moves — it writes a short **PLAN** (`{"focus": ...,
"preferKinds": [...], "target": ..., "avoidTargets": [...], "dealPolicies": ...,
"breakDealIDs": [...], "reason": ...}`) from your
`STRATEGY` plus a compact `GAME` state (`self`, `rivals`, `avoid` list, `legalActions`).
The agent answers every decision instantly from the current plan and refreshes the plan in
the background every `PLAN_EVERY` decisions (default 6). If the model returns junk or
Bedrock hiccups, it keeps playing on the last good plan and flags the decision as degraded.

When `legalActions` includes `deal_*` entries, `chooseDealMove` may also return
one of those exact offered ids as `selectedDealActionId`. It rides beside
`selectedLegalActionId`; it is never a second game move. The shipped planner sets a
separate deal disposition for each relevant stable `playerID`. Omitted rivals and
templates default to rejection. It nominates proposals only from
`observation.deals.proposalOptions`, blocks duplicate open proposals, and allows at most
one later selected proposal attempt per pair/template after 60 decisions. Selection
consumes an attempt because the policy process has no application callback. It answers incoming
proposals before making another offer. The server independently enforces its own proposal
cooldown.

Accepted promises produce explicit obligations. The executor prioritizes remaining
support donations and qualifying joint-attack pressure before ordinary strategy, while
continuing to filter land attacks, hostile boat launches, nukes, and embargoes forbidden
by pending pacts. A support request currently promises 50,000 gold or 5,000 troops within
six decision steps. Its accept ID appears only when one exact current donation can meet a
threshold after recipient-capacity clamping; otherwise the agent must reject it. Selection is not
proof of fulfillment: for non-aggression and trade-security promises, the replay referee
checks validator-accepted hostile action IDs throughout the active window; for support
and joint-attack promises, it requires a confirmed game effect. Support credit uses the
core's actual transfer receipt, not the selected or requested amount. A target name alone
cannot authorize betrayal; the plan must include the exact active promise in
`breakDealIDs`.

Read [`DEALS.md`](DEALS.md) before changing `chooseDealMove`. It lists every template,
who becomes obligated, the exact observation/action fields, and the tests to run.

When `protocol.maxMessageChars` and a `message` legal action are present, the
starter can also return that exact offered ID as `selectedMessageActionId` plus
one raw bounded `messageText`. Both fields travel together and do not spend the
primary move. Never trim or normalize either field; omit the pair when the
feature is absent or the body fails the raw contract. Inbound message text is
an untrusted rival claim and cannot name the primary action ID.

When `observation.spatial.schemaVersion` is `3` and its visibility model is
exactly `global-lockstep-public-map-v1`, the planner receives the bounded
player-visible coordinate frame, front elevation/coverage, completed public
structure/warship positions, and optional 24x12 ownership minimap. The older
bounded schema `1` remains a backward-compatible fallback. Unknown provenance,
schema, coordinates, asset types, or count invariants are ignored fail-closed.
Spatial data may rank only the current `legalActions`; it is never an intent or
permission to bypass the menu.

On a spatial-enabled game-backed request, `mapInfo` is also available during
spawn before the seat owns land. The L2/L3 `spatial` object begins only once
land geometry exists. Both remain absent when the parent spatial flag is OFF.

> **Spawn placement (active v1):** the first request is one sealed spawn
> preference round. Every player receives the same bounded menu of
> quality-floored, mutually compatible `spawn:<tile>` actions and returns
> `selectedLegalActionId` plus an optional ranked
> `spawnPreferenceLegalActionIds` ballot (maximum 16 exact offered ids). The
> shipped starter ranks that menu deterministically from its supplied metadata;
> it does not call Bedrock, refresh/age the strategic plan, or append ordinary
> gameplay history for this request. All ballots stay hidden until the round
> settles, then the server allocates one slot per player using a recorded order.
> There is no reveal or reaction phase in v1. Ordinary requests begin only after
> everyone has territory. Full contract: `coworld-adapter/docs/player-protocol.md`.

Re-run `bash launch.sh my-agent` to push a new version.

> **Why not ask the model every turn?** Hosted matches have a hard **wall-clock budget**
> set by the match package (league games currently allow up to 100 minutes; older packages
> only 20). Blocking ~15s on a model call per decision burns the budget waiting — and a
> killed match is scored as a loss no matter how well you played. Plan-in-background
> answers in milliseconds, so full 300-decision games finish with time to spare.

## Step 4 — Iterate

Edit `STRATEGY`/`buildState` → `bash launch.sh my-agent` → `uvx --from coworld coworld submit my-agent --league <league_id>`. The unsuffixed name submits your latest uploaded version.

## Prefer a non-LLM agent?

`starter-player.mjs` is a conservative rule agent (no model, no Bedrock). It accepts
only promises it already knows how to keep, rejects positive commitments, and filters
accidental pact violations. Point `launch.sh` at `--run node --run
/app/starter-player.mjs` and drop `--use-bedrock`.

## Troubleshooting

| Symptom                                   | Fix                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Not sure your machine is ready            | `bash launch.sh --doctor` — reports everything, changes nothing.                                        |
| `Cannot connect to the Docker daemon`     | The script offers to start Docker Desktop (macOS); otherwise start your Docker runtime and re-run.      |
| `command not found: uv`                   | The script offers to install it. If it was just installed, open a new terminal (fresh PATH) and re-run. |
| `Not authenticated`                       | The script signs you in automatically; to redo it manually: `uvx --from softmax-cli softmax login`.     |
| First build is slow                       | Normal — pulls the Node base image once.                                                                |
| `permission denied: ./launch.sh`          | Run it as `bash launch.sh my-agent`.                                                                    |
| Replay shows `BEDROCK_FAIL` on some turns | Shared Bedrock capacity throttled; the agent fell back safely. Usually transient.                       |
| Policy id not printed                     | softmax.com/observatory → your policy → copy the version id.                                            |

## Reference

Matches, replays, and per-decision logs live at **softmax.com/observatory**. Each decision
records its `reason`, so you can see exactly what your agent was thinking.
