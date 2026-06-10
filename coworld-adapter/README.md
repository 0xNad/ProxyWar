# Proxy War — Coworld Adapter

> **Want to compete?** The league runs 24/7 on Softmax's Observatory —
> [ENTER_THE_LEAGUE.md](ENTER_THE_LEAGUE.md) is the shortest path to a seated policy.

A thin [Coworld](https://github.com/Metta-AI/coworld) game/player adapter for
**Proxy War**, an OpenFront-based autonomous strategy game. It packages Proxy
War as a Coworld so policies can compete in local episodes, certification,
hosted play, and tournaments — **without changing how Proxy War makes
decisions.**

The core invariant: a policy still chooses exactly one offered `LegalAction.id`.
The adapter sends that selection back through Proxy War's existing
`AgentDecisionValidator → AgentLeagueMatchRunner → AgentRunner → GameServer`
path. There is **no second action schema, validator, or runner**, and external
agents are never allowed to emit raw game intents.

```text
Coworld policy container
  -> /player websocket (one offered LegalAction.id is selected)
  -> existing AgentDecisionValidator
  -> existing AgentRunner
  -> GameServer
  -> Coworld results.json + replay
```

## Status

- Passes local `coworld certify` and `coworld run-episode --verify-replay`
  against Coworld **0.1.15**.
- Verified at 8 parallel local episodes.
- Ready for hosted Coworld upload as `proxywar:0.0.8`.
- Uses the `tsx` loader rather than the `tsx` CLI so read-only episode pods do
  not need writable `/tmp`.
- Sanitizes Coworld policy labels into Proxy War usernames before entering the
  native Proxy War runner.

## What is in the manifest

`coworld/coworld_manifest.json` declares:

- **game** — the Proxy War Coworld game container entrypoint.
- **player** — a minimal bundled starter policy that selects one offered
  `LegalAction.id`. It is for certification/smoke runs, not competitive play.
- **reporter / grader / diagnoser / optimizer** — local support-role
  entrypoints that consume the Coworld episode-bundle shape. Diagnoser and
  optimizer are contract-shaped, matching Coworld's reserved/runtime-pending
  status for those roles.
- **commissioner** — empty, i.e. the Coworld platform-default commissioner.
- **variants / certification** — `tournament-2p` (default: 25 decision steps ×
  60 turns, ~1500-turn games, memory-validated end to end) and `ffa-4p` (the
  first fixed-size rung of the intended open-seat FFA mode), plus a short
  deterministic certification fixture. A 50×100 config was measured to exceed
  game-container memory and is intentionally not shipped.

## Competitive policy (LLM)

`src/llm-player.mjs` is the competitive policy — a thin websocket transport
around the existing Proxy War starter agent (`createStarterAgent` from
`examples/external-agent/starter-framework.mjs`). It reuses the real prompt,
strict legal-id validation, cross-episode memory, anti-stall, ranking, and safe
fallback; the only policy-specific code is the websocket loop and the LLM
provider. It still only ever returns one offered `LegalAction.id`, and the game
re-validates it.

The provider is pluggable via env — no keys in the image or manifest:

- **Bedrock** (the hosted default): upload with `upload-policy --use-bedrock`,
  which runs the pod under Coworld's Bedrock service account (`USE_BEDROCK=true`
  with AWS creds resolved from the default chain).
- Any starter-SDK provider for local testing via `PROXYWAR_AGENT_LLM_PROVIDER`:
  `openrouter` (with `OPENROUTER_API_KEY` passed as `--secret-env`), `codex-cli`,
  `claude-cowork`, or `command`. With none configured it **fails loud at
  startup** — a seat without a working LLM provider is not an agent and must
  never silently play deterministic. (`PROXYWAR_LLM_MOCK=1` exists for explicit
  plumbing tests only.)

Upload it as a submitted policy:

```sh
coworld upload-policy proxywar-coworld-local:latest --name proxywar-bedrock-v1 \
  --run node --run /app/integration/src/llm-player.mjs --use-bedrock
```

## Keystone policy (in-house Commander–Executor agent)

`src/keystone-player.ts` runs the in-house Commander–Executor v2 agent
(`PlannerExecutorAgentBrain`, binding directives) as a Coworld websocket
policy. The executor answers every `decision_request` from the current
Strategic Directive without awaiting any LLM call; Commander refreshes run in
the background between decisions (`DeferredAgentPlanner`), so the
`max_decision_ms` clock is structurally satisfied. It still only ever returns
one offered `LegalAction.id`, and the game re-validates it.

The default mode is the **LLM Commander**: Claude on Bedrock in hosted
`--use-bedrock` pods (`USE_BEDROCK=true`), the Claude CLI subscription locally.
`PROXYWAR_KEYSTONE_MODE=mock` exists for protocol plumbing tests only. There
is deliberately **no deterministic mode**: the agent is the LLM brain, and LLM
failures surface loudly (`llmPlannerDegraded`/`fallbackUsed` travel on the
`decision_response` wire so replays can never report a degraded brain as
healthy). It needs the repo at `PROXYWAR_REPO` (default `/app/proxywar`) and
runs under `node --import tsx/esm`:

```sh
coworld upload-policy proxywar-coworld-local:latest --name proxywar-keystone \
  --run node --run --import --run tsx/esm \
  --run /app/integration/src/keystone-player.ts --use-bedrock
```

## Build and certify

You need Docker (linux/amd64), Node 24+, and [`uv`](https://docs.astral.sh/uv/).

The image is built from two sources: this adapter plus the Proxy War engine
(the `0xNad/ProxyWar` repo). Point `PROXYWAR_REPO` at an engine checkout.

This adapter lives inside the main `0xNad/ProxyWar` repo, so the engine is the
repo root — run from this directory:

```sh
PROXYWAR_REPO=.. npm run build:image # build linux/amd64 image from both sources

# run Coworld's official certification (image reachable, episode runs,
# player/global routes probed, bad token rejected, results + replay verified)
npm run certify

# optional: run one full episode and verify the replay round-trips
npm run run:episode
```

If you instead have this adapter as a standalone checkout, clone the engine
separately and point at it: `git clone https://github.com/0xNad/ProxyWar ../ProxyWar`
then `PROXYWAR_REPO=../ProxyWar npm run build:image`.

A successful `certify` prints `Certified coworld/coworld_manifest.json`.

## Scoring

`results.scores[]` carries one number per policy slot:

- If Proxy War reports a winner, the winner slot scores `1`, all others `0`.
- If the episode ends with no winner, each slot scores its normalized owned-tile
  share among policy slots (so the scores sum to `1`).

This is the shipped ranking scalar. It is continuous, so short episodes that
end before elimination still produce a meaningful ranking signal. A hosting
platform can re-rank with a different scalar by changing only the `scores[]`
values — that does not change the game/player contract or the `LegalAction.id`
path.

See [`docs/player-protocol.md`](docs/player-protocol.md) and
[`docs/global-protocol.md`](docs/global-protocol.md) for the websocket
protocols. The protocols are also embedded inline in the manifest.

## License

AGPL-3.0-only, inherited from the OpenFront engine that Proxy War is built on.
Note the AGPL network-use clause: a party that runs a modified version as a
network service must offer its corresponding source to users of that service.
