# ProxyWar / AI Nations League

**ProxyWar** is the public product framing: an autonomous strategy league
where humans create AI nations, enter them into matches, and watch those nations
expand, build, ally, pressure rivals, or collapse.

**AI Nations League** remains the internal technical name for the OpenFrontIO
agent runner, league mode, and artifact pipeline.

The project is an experimental OpenFrontIO fork where every human player slot
can eventually be controlled by an autonomous agent. Humans do not play directly
in the first public demo; they create/configure safe AI nations and spectate.

## Relevant Architecture

- Games are owned by `src/server/GameManager.ts`, which creates and tracks
  `GameServer` instances.
- Private games are created through `POST /api/create_game/:id` in
  `src/server/Worker.ts`. Public games are scheduled by
  `MasterLobbyService` and created on workers through `WorkerLobbyService`.
- Browser clients join over WebSocket with a `join` message. The worker verifies
  the token, creates a `Client`, and calls `GameManager.joinClient`.
- `GameServer` owns lobby membership, start/prestart messages, turn collection,
  and intent stamping. Clients send `ClientIntentMessage`; the server stamps the
  authenticated `clientID` and stores `StampedIntent` entries for the next turn.
- Intent schemas live in `src/core/Schemas.ts`. Core execution maps
  `StampedIntent` values to deterministic executions in
  `src/core/execution/ExecutionManager.ts`.
- Existing bots and nations are not external agents. Tribes/bots and nations are
  deterministic core executions created by `GameRunner.init()` through
  `TribeSpawner`, `TribeExecution`, and `NationExecution`.

## Agent Boundary

Agents live outside `src/core` under `src/server/agents` and scripts. They use
the same server path as normal players:

```text
game/server state -> AgentObservation + LegalAction[] -> AgentBrain
  -> AgentDecision -> validation -> normal game intent
  -> AgentRunner -> GameServer
```

The current in-process runner replaces only the network socket. It still joins a
`GameServer` as a `Client` and submits normal client intent messages.

## Formal Agent Interface

Milestone 3 adds the reusable API future rule, LLM, and custom package agents
should share:

- `AgentObservation`: compact strategic state for one agent, including agent
  identity, profile, phase, turn/tick, own player state when available, visible
  players when available, a derived strategic priority, short-term memory,
  recent decisions, and notes for unavailable data.
- `LegalAction`: one validated choice the agent may pick, including an action
  id, action kind, label, underlying game intent or `null` hold action,
  risk, and metadata.
- `AgentDecision`: the brain's selected `LegalAction.id` plus its reason.
- `AgentBrain`: interface implemented by any future policy, including simple
  rules, local packages, or an LLM-backed adapter outside core.
- `RuleAgentBrain`: a deliberately small baseline brain that chooses from the
  offered legal actions and proves the contract works. It now reads the derived
  strategic priority before falling back to profile-specific preferences.
- `LlmAgentBrain`: an LLM-compatible brain that builds a prompt, asks an
  injected provider for JSON, parses it, and selects only from existing
  `LegalAction.id` values.
- `MockLlmProvider`: the default provider for tests and smoke runs. It never
  calls a network service, but it now reads the same strategic skill scores
  shown to real LLM/Codex providers so the local demo better reflects the
  intended LegalAction-selection contract.
- `OpenAiLlmProvider`: an opt-in real provider outside core. It reads config
  from environment variables, calls the OpenAI Responses API with timeout and
  retry limits, and returns raw text to the existing strict parser.
- `CodexCliLlmProvider`: a private-testing-only provider outside core. It shells
  out to `codex exec` with a read-only sandbox and an output schema. It never
  reads Codex OAuth files or manually reuses tokens.
- `AgentDecisionLogWriter`: writes durable local run artifacts for inspection,
  replay support, audits, and explaining why agents acted.
- `AgentMatchStory`: turns decision logs into spectator-facing recap artifacts
  (`match-story.json` and `match-story.md`) with an entertainment score,
  highlights, boringness warnings, and behavior-improvement suggestions.
- `AgentDemoIndexWriter`: generates the static local run selector at
  `artifacts/ai-league-runs/index.html`.
- `AgentSpectatorReplay`: writes a read-only local spectator replay from saved
  mirrored-state snapshots and decision records. It does not connect to
  `GameServer`, does not allocate a player slot, and cannot submit intents.
- `/ai-league-replay/<run-id>`: local app route that loads
  `artifacts/ai-league-runs/<run-id>/game-record.json` into the existing replay
  renderer and mounts an AI decision overlay.
- `AgentActionAuditor`: compares before/after mirrored core snapshots for
  accepted intents and records whether the expected effect was confirmed,
  unknown, failed, or not applicable.
- `AgentLocalGameMirror`: a non-core smoke/test helper that consumes real
  `GameServer` start/turn messages and advances a local `GameRunner` so agents
  can observe live post-spawn state.
- `AgentStepLockedLeague`: an opt-in smoke/test runner that disables fast
  realtime advancement and manually advances a bounded number of turns between
  agent decisions so slow external brains can act on fresh post-spawn state.
- `AgentStrategicStateBuilder`: a non-core summarizer that turns raw observation
  details into `priority`, `urgency`, scores, recommended action kinds, target
  ids, and concise notes for rule brains and LLM prompts.
- `AgentMemoryBuilder`: a non-core summarizer that turns recent accepted
  decisions into a compact memory summary, recent action counts, repeated action
  notes, recent expansion/build counts, and action ids to avoid repeating
  blindly.

`AgentObservationBuilder`, `LegalActionBuilder`, and
`validateAgentDecision()` are all outside core. They can inspect server/core
snapshots and translate them into safe, typed options without changing
deterministic simulation behavior.

## LLM JSON Action Contract

Milestone 5 adds the contract real model integrations must use later. The LLM
does not create raw game intents. It receives an `AgentObservation` plus a
menu of `LegalAction[]`, then returns strict JSON selecting one listed id:

```json
{
  "selectedLegalActionId": "alliance:PLAYER02",
  "reason": "This alliance reduces early risk and creates a buffer.",
  "confidence": 0.72
}
```

Rules:

- `selectedLegalActionId` must exactly match one offered `LegalAction.id`.
- `reason` must be a short string.
- `confidence` is optional. Numeric values are clamped to 0..1; non-numeric
  confidence is rejected.
- Extra JSON fields, malformed JSON, missing ids, unknown ids, empty output, and
  raw intent JSON are rejected.
- A single markdown JSON code fence is tolerated for easier model testing.

Invalid LLM output, provider errors, and provider timeouts fall back to
`RuleAgentBrain` or the safest `hold` action. Decision metadata records raw
provider output, parse success/failure, parser failure reason, selected id,
confidence, prompt length, and whether fallback was used. Smoke artifacts also
store the raw prompt for auditability. API keys are never placed in prompts or
written by the provider.

## External Agent Endpoint Contract

ProxyWar now supports a private/testing-only external HTTP agent mode for
friends who want to run their own agent service. Endpoint agents still use the
same contract as LLM brains: they receive `AgentObservation` plus public
`LegalAction[]` entries and must return strict JSON with one
`selectedLegalActionId`. They never receive or submit raw game intents.

Endpoint-backed entrants are saved as normal manifests with
`brainType: "external-http"` and `provider.provider: "external-http"`. When a
saved roster match starts, the league runner preserves that manifest provider
and instantiates `ExternalHttpAgentBrain` for that participant; all other
participants continue to use the requested rule/mock/Codex/planner mode.

If an endpoint times out, returns malformed JSON, chooses an unknown id, or
fails HTTP, the decision falls back visibly to the local rule brain. Decision
metadata records `externalActionCall`, `parseSuccess`, `fallbackUsed`, endpoint
label, failure reason, and raw endpoint output when present. Bearer tokens are
sent only as request headers and are not written to reports. Operator-authored
manifests can use `tokenEnv` so local files do not need to store the raw token
value. The beta browser form does not resolve `env:` or `secret:` references;
if a raw beta-only token is entered through the beta page, the local server stores it in
`artifacts/proxywar/secrets/` and saves only a `tokenSecret` reference in
the manifest.

Runs also write external-agent coaching artifacts:

```text
artifacts/ai-league-runs/<run-id>/external-agent-feedback.json
artifacts/ai-league-runs/<run-id>/external-agent-feedback.md
```

The Markdown feedback is the first file an external-agent author should read
after a dry run. It summarizes accepted/rejected decisions, parser failures,
fallbacks, repeated action loops, post-spawn non-hold rate, audit status, and
concrete policy suggestions. The feedback is derived from normal decision logs;
it does not create a second action system or bypass `LegalAction.id`.

See `docs/PROXYWAR_EXTERNAL_AGENT_API.md` for the request/response schema
and a minimal local endpoint example.

The beta page exposes a **Test Endpoint** button backed by
`/api/external-agents/check`. This sends a synthetic observation and two fake
legal action ids (`health-check:expand`, `health-check:hold`) so a friend can
verify protocol compatibility before saving. Saved external endpoints appear in
the local **Next Match Queue**; the current queue implementation is the saved
roster used by saved-roster match jobs, with curated defaults filling empty
slots until at least four entrants exist.

Endpoint calls are now egress-hardened for public beta safety:

- localhost, LAN, link-local, private, and reserved IP ranges are blocked by
  default
- redirects are not followed
- response bodies are capped
- non-JSON response content types are rejected
- local/private endpoint testing requires
  `PROXYWAR_ALLOW_PRIVATE_AGENT_ENDPOINTS=true`

Demo jobs also receive deterministic artifact ids before child processes start.
The demo server attaches completed jobs to the exact expected run/tournament/eval
artifact instead of scanning for the newest artifact after start time.

## Current Legal Actions

- `spawn`: generated before spawn from real map spawn candidates.
- `hold`: a no-op wrapper with no game intent, used as a safe fallback
  because the core intent schema has no explicit no-op.
- `attack`: generated only when a post-spawn observation exposes a target that
  shares a border and `player.canAttackPlayer(other)` says is valid. Attack
  candidates currently offer 10%, 25%, and 40% troop commits with target id,
  target name, troop estimates, relative strength, risk, and the legality
  reason in metadata.
- `alliance_request`: generated only when a post-spawn observation exposes a
  recipient that `player.canSendAllianceRequest(other)` says is valid.
- `build`: generated only when live state proves `player.canBuild(unit, tile)`
  for `Defense Post`, `City`, or `Factory`. Build metadata includes unit, role,
  target tile, resolved build tile, cost, and the core legality reason.
- `donate_troops` / `donate_gold`: generated only when live state proves
  `player.canDonateTroops(other)` or `player.canDonateGold(other)`. These are
  support actions for friendly/allied players and use bounded suggested amounts.
- `embargo`: generated only for alive non-friendly players without an existing
  outgoing embargo. The intent uses the existing `embargo` start action.

Live post-spawn observations include player id, alive/spawned/disconnected
state, troops, gold, territory size, border size, attack/alliance counts,
visible other players, relation/alliance flags, valid attack/alliance booleans,
combat summaries for bordered and attackable players, non-combat build/support
/embargo options, game tick, phase, a derived strategic state, and short-term
memory. Strategic state and memory are guidance only: agents still choose from
`LegalAction[]`, and legality still comes from `LegalActionBuilder` plus
validation. Supplied or pre-spawn observations may still contain notes when a
live core snapshot is unavailable.

Short-term memory currently covers the agent's last few decisions inside the
same run. It records action kinds, accepted/rejected status, targets or units
when available, expansion flags, repeat counts, and a compact summary such as
`recent=spawn,build,attack; expansions=1; builds=1; repeat=attackx1`. Rule
brains use this to diversify repeated neutral expansion when a useful build or
pressure action is available. LLM/Codex brains receive the same memory in the
observation JSON and still may only select one offered `LegalAction.id`.

## Action Coverage Matrix

| Action family | Status | Proof source |
| --- | --- | --- |
| Spawn | Working | Spawn candidates become normal `spawn` intents. |
| Hold | Working | Safe no-intent fallback. |
| Alliance | Working | `player.canSendAllianceRequest(other)`. |
| Attack | Working | `sharesBorderWith` plus `canAttackPlayer`. |
| Build | Working for `Defense Post`, `City`, `Factory` | `player.canBuild(unit, tile)`. |
| Support / donate | Implemented when allies exist | `canDonateTroops` / `canDonateGold`; normal FFA needs an accepted alliance first. |
| Embargo | Working for start embargo | Alive non-friendly target with no current outgoing embargo. |
| Missile / nuke | Not yet exposed | Needs target selection, silo/cooldown checks, and alliance-safety policy. |
| Expansion | Blocked as explicit action | Land growth is simulation-driven; there is no client expansion intent. |

## What Works Now

- One hardcoded agent can join an in-process private game and submit a normal
  `ClientIntentMessage`.
- Four hardcoded agents can join one in-process private game, choose distinct
  legal spawn actions, and submit those actions through the same server intent
  path.
- The league runner now uses the formal pipeline:
  `AgentObservationBuilder -> LegalActionBuilder -> AgentBrain -> validator`.
- The league smoke advances a real in-process match past spawn using server
  turns mirrored into a local `GameRunner`, then runs a post-spawn decision turn
  from live game state.
- Diplomatic agents can submit a proven live `allianceRequest` intent after
  spawn when `canSendAllianceRequest` allows it. Other profiles safely hold when
  their preferred live action is unavailable.
- A deterministic attack smoke can force two nearby hostile spawns on the static
  Asia compact map, advance to active phase with spawn immunity disabled for
  that scenario only, generate live attack LegalActions, select one by mock LLM
  id, submit the normal `attack` intent through `AgentRunner -> GameServer`, and
  verify the mirrored core state records the attack.
- A normal-map action-diversity smoke can advance a standard league setup past
  spawn, observe live build and embargo options, select a build LegalAction by
  mock LLM id, submit the normal `build_unit` intent through
  `AgentRunner -> GameServer`, and verify the mirrored core state records the
  structure.
- Mock LLM brains can run through the same league path. The mock provider can
  emit valid JSON, fenced JSON, unknown ids, malformed JSON, empty output, and
  invalid confidence for tests. It also has attack, build, support, and
  non-hold modes for scenario tests.
- A real LLM provider is available behind an explicit opt-in. Normal tests and
  smoke commands still use rules or `MockLlmProvider`; the real provider is
  only constructed when `--brain=real-llm` and the required environment
  variables are present.
- Every league smoke run writes durable artifacts under
  `artifacts/ai-league-runs/<run-id>/`: `decisions.jsonl`,
  `match-summary.json`, `match-report.md`, and `visual-report.html`.
- Focused tests cover observation building, pre-spawn legal action generation,
  brain selection, invalid decision fallback, multi-agent spawn execution, and a
  live post-spawn alliance request executed through core. The attack scenario
  test proves bordered targets appear in observation, attack candidates are
  generated, the selected attack passes validation and server submission, and
  core execution records attack stats. Build tests prove non-combat options are
  generated from observed legality and that a build intent can execute through
  core. LLM tests cover prompt contents, parser acceptance/rejection, safe
  fallback, and mock-provider selection.
- Decision records include agent identity, profile, brain type, observation
  summary, offered legal action ids grouped by kind, chosen action id/kind,
  reason, decision latency, intent, and accepted/rejected result. LLM records
  also include raw response, optional raw prompt in artifacts, parser/fallback
  metadata, and confidence.

## Realtime Versus Step-Locked Smoke

The original league smoke runs like a local realtime match: `GameServer` emits
turns on a 1ms interval while agents think. This is useful for fast rule and
mock LLM checks because it is close to the normal in-process server path.

Slow external brains such as Codex CLI or remote LLMs can take seconds per
decision. In realtime mode, the match can advance thousands of turns before the
model returns, so post-spawn agents may be dead or out of useful options by the
time their decision is submitted.

Step-locked mode is opt-in. It gives the smoke server a long interval and then
advances turns explicitly:

```text
observe live mirror -> LegalAction[] -> AgentBrain.decide()
  -> validate -> AgentRunner -> GameServer
  -> manually advance N turns -> mirror catch-up -> repeat
```

This keeps `src/core` deterministic and unchanged. The same `LegalAction.id`
contract, validator, `AgentRunner`, `GameServer`, and mirrored core observation
path are used; only the smoke runner controls when turns are emitted.

Step-locked run metadata records the runner mode, turns per decision step,
configured decision timeout, completed steps, mirror catch-up status, per-agent
decision latency, post-spawn non-hold action count, and an only-hold reason when
no useful post-spawn actions were available.

## Live Versus Supplied Observation

Pre-spawn smoke decisions can be made from supplied spawn candidates because the
agent has not yet spawned and no live player state exists. Post-spawn decisions
use a live `Game` snapshot from `AgentLocalGameMirror` or tests. That snapshot is
the same deterministic core state a client would build by consuming server
turns, so legal action generation can call real player methods such as
`canSendAllianceRequest`, `canAttackPlayer`, `sharesBorderWith`, and
`isAlliedWith`.

## Determinism Boundary

Do not put LLM calls, HTTP requests, clocks, retries, model prompts, or agent
memory inside `src/core`. The core simulation must stay deterministic: every
client receives the same turns and independently reaches the same game state.

LLM and policy code belongs outside core. It should consume an
`AgentObservation`, return structured action JSON, validate that JSON against
`LegalAction[]`, and submit normal intents through the server pathway.

## Real LLM Provider

The real provider is opt-in and disabled unless explicitly requested. Mock LLM
remains the default for tests and smoke.

Required environment:

```bash
AI_LEAGUE_LLM_PROVIDER=openai
AI_LEAGUE_LLM_MODEL=<model>
OPENAI_API_KEY=<secret>
```

Optional environment:

```bash
AI_LEAGUE_LLM_TIMEOUT_MS=15000
AI_LEAGUE_LLM_MAX_RETRIES=0
AI_LEAGUE_LLM_MAX_OUTPUT_TOKENS=300
AI_LEAGUE_LLM_ENDPOINT=https://api.openai.com/v1/responses
```

The provider calls the OpenAI Responses API, returns raw model text, and lets
`LlmDecisionParser` enforce the same JSON action-id contract used by
`MockLlmProvider`. A provider error, timeout, malformed response, unknown action
id, or unsafe JSON shape falls back through the existing rule/safe action path.
The provider redacts API-key-looking strings from HTTP error bodies and never
writes the API key to artifacts.

## Codex CLI Provider

`CodexCliLlmProvider` is for local/private testing only. It uses Codex CLI as an
external command:

```bash
npm run agent:league-smoke:codex-cli
```

Required setup:

```bash
codex login
```

Optional environment:

```bash
AI_LEAGUE_CODEX_COMMAND=codex
AI_LEAGUE_CODEX_MODEL=<model>
AI_LEAGUE_CODEX_REASONING_EFFORT=<low|medium|high|xhigh>
AI_LEAGUE_CODEX_PROFILE=<profile>
AI_LEAGUE_CODEX_TIMEOUT_MS=120000
```

The provider runs `codex exec` with read-only sandboxing, no approval prompts,
an output schema matching the strict decision JSON, and `--output-last-message`
so only Codex's final model text is returned to `LlmDecisionParser`. It does not
read `~/.codex/auth.json`, does not inspect OAuth tokens, and does not call
private auth endpoints. Auth remains entirely owned by the Codex CLI.

This path consumes Codex usage/credits and is not recommended for production or
public hosted matches. A hosted league should use a purpose-built provider with
explicit service credentials, budget controls, observability, and isolation.

## Durable Run Artifacts

Every league smoke command writes local artifacts to:

```text
artifacts/ai-league-runs/<run-id>/
```

Start with `visual-report.html` for the full product report, `match-story.md`
for a short spectator recap, and `spectator.html` or `/ai-league-replay/<run-id>`
for replay viewing.

Files:

- `decisions.jsonl`: one decision per line with run id, match id, timestamp,
  agent id/name/profile, brain type, compact observation summary, offered
  action ids grouped by kind, selected LegalAction id/kind, decision latency,
  reason, confidence, raw LLM prompt/output when applicable, parse status,
  fallback status, generated game intent, accepted/rejected result, and
  action-effect audit fields.
- `match-summary.json`: run metadata, roster, counts by action kind, fallback
  and parse-failure counts, runner mode/config, post-spawn non-hold count,
  effect-audit counts, average decision latency, final compact state, and
  notes.
- `match-report.md`: human-readable overview, roster, decision timeline,
  notable attacks/builds/alliances/embargoes/support actions, invalid/fallback
  decisions, effect audit timeline, runner metadata, final known state, replay
  hook status, and limitations.
- `visual-report.html`: a polished browser-friendly match report with summary
  metrics, runner mode, roster cards, timeline grouped by spawn/post-spawn
  cycles, action badges, selected `LegalAction.id` values, reasons, generated
  intent summaries, accepted/rejected badges, fallback badges, parser status,
  effect audit badges, decision latency, collapsible raw details, and local
  links to the spectator/JSONL/JSON/Markdown artifacts.
- `spectator.html`: a static read-only spectator replay. It draws the saved
  owned-tile map snapshots on canvas, shows the agent roster, and overlays the
  decision timeline with reasons, latency, accepted/rejected status, fallback
  status, audit status, and generated intent summaries.
- `spectator-replay.json`: the replay data used by `spectator.html`, including
  map dimensions, roster, per-snapshot player territory/unit summaries, and
  the decisions made during each snapshot.
- `game-record.json`: a local `GameRecord` generated from the saved
  start/turn stream when available. The `/ai-league-replay/<run-id>` route uses
  this file to render the match with the real ProxyWar game canvas.
- `../index.html`: the run selector generated at
  `artifacts/ai-league-runs/index.html`, listing recent run ids, brain type,
  scenario, runner mode, decision counts, non-hold counts, parser/fallback
  counts, audit counts, spectator snapshot counts, and links to each run
  artifact and real-render replay route.

Raw prompts and responses are stored in local artifacts because the agent match
needs to be debuggable and explainable after the fact: reviewers can see exactly
what the model saw, what legal ids were offered, what it returned, and why the
validated action did or did not execute. Do not share these artifacts publicly
without reviewing them first.

## Local Demo Shell

Launch the hosted local demo hub:

```bash
npm run agent:demo-server
```

Launch the invite-gated friends-and-family beta shell:

```bash
npm run agent:closed-beta
```

The beta script enables `PROXYWAR_BETA_ENABLED=true`. Set a private invite
code before a tester session:

```bash
PROXYWAR_BETA_CODE="your-private-code" npm run agent:closed-beta
```

For remote friends with a temporary tunnel:

```bash
PROXYWAR_BETA_CODE="your-private-code" npm run agent:closed-beta:remote
```

For same-Wi-Fi/LAN testers:

```bash
PROXYWAR_BETA_CODE="your-private-code" npm run agent:closed-beta:lan
```

Remote setup details live in `docs/REMOTE_FRIENDS_BETA.md`.

Open:

```text
http://127.0.0.1:8787
```

The public-facing product page is:

```text
http://127.0.0.1:8787/public
```

When beta mode is enabled, unauthenticated visitors are redirected to `/beta`.
The beta gate uses a signed HTTP-only cookie and never prints the invite code in
server logs. Tester feedback submitted from the public page is written to:

```text
artifacts/proxywar/beta-feedback/feedback.jsonl
```

The operator hub is the easiest local product shell. It lists recent match runs and
tournaments, links to visual reports, artifact replays, scorecards, JSON logs,
evaluation reports, tournament leaderboards, and persisted demo-server job
history. It can start safe preconfigured demo, evaluation, and tournament jobs.
It also links runs into the native ProxyWar replay route and highlights the
latest match with one-click report/replay links.

The match form can use:

- `Default four profiles`: the built-in aggressive, defensive, diplomatic, and
  opportunistic profiles.
- `Manifest-defined roster`: the checked-in manifests under
  `docs/ai-league-agent-manifests/`.
- `Saved ProxyWar nations`: local manifest-only nations created through
  the hub, plus curated defaults until there are at least four entrants.

The **Create AI Nation** form is the first public-demo creation flow. It saves a
manifest-only nation with:

- nation name
- strategy profile
- doctrine
- short doctrine note
- generated skill preferences

These nations are configs only. Users do not upload code, do not call APIs from
inside the game, and do not submit raw game intents. The server still runs
the agent, builds observations, offers `LegalAction.id` choices, validates the
decision, and submits normal intents through `AgentRunner -> GameServer`.

Saved ProxyWar nations are written under:

```text
artifacts/proxywar/nations/
```

The active saved-nation roster used by match jobs is materialized under:

```text
artifacts/proxywar/active-roster/
```

Public beta wording uses **Strategy rounds** for the step-locked decision loop:
each round builds observations, offers `LegalAction.id` choices, lets every
agent brain/planner act, submits validated intents, and advances the simulation.
More rounds means a longer generated match and more decisions before replay.

When a beta match job completes, the public page automatically navigates to:

```text
/openfront-replay/<run-id>
```

The demo server proxies the local ProxyWar renderer so remote friends using the
same beta/tunnel URL can watch the rendered replay without opening port 9000
separately. This is still replay-after-generation, not a true live turn stream
while the match is running.

The browser never submits arbitrary commands or paths. The server maps form
values to a fixed allow-list of brain modes, scenarios, rosters, and scripts.
Job history is written locally to:

```text
artifacts/ai-league-demo-jobs/jobs.json
```

For objective-following demos, set decision cycles to `5` through `10`. Those
longer step-locked runs give the planner/executor loop enough repeated choices
for objective scorecards and repetition penalties to become meaningful.

By default the hub starts the local ProxyWar renderer on port 9000 too. The
renderer uses a strict port so replay links stay predictable; if port 9000 is
already occupied, the hub logs the renderer startup failure and assumes the
existing process on port 9000 is the renderer. If you already have the renderer
running, or only want the artifact browser, use:

```bash
AI_LEAGUE_DEMO_RENDERER=false npm run agent:demo-server
```

Generate or refresh the local run selector:

```bash
npm run agent:demo:index
```

Open:

```text
artifacts/ai-league-runs/index.html
```

The index is a static page. It does not start a server and does not require a
database. Every league smoke/demo run also refreshes it automatically after
writing run artifacts. Runs that include spectator replay data show direct
`spectator` and ProxyWar render links. Use `agent:demo-server` when you want a
single browser shell that can also launch new jobs.

## Action-Effect Auditing

Step-locked runs capture mirrored core state before and after each decision
step. The audit layer then checks accepted intents:

- `spawn`: confirms the player is spawned, alive, and owns territory.
- `build_unit`: confirms a matching structure appears or the relevant unit
  count increases.
- `embargo`: confirms the outgoing embargo appears on the acting player.
- `allianceRequest`: confirms an outgoing alliance request appears when still
  visible in the after-state snapshot.
- `attack`: confirms an outgoing attack or a detectable troop/territory delta.
- `donate_gold` / `donate_troops`: confirms a resource/troop transfer when the
  before/after snapshots expose it.
- `hold`: marked not applicable because no game intent is submitted.

Audit statuses:

- `confirmed`: the expected effect is visible in the mirrored core state.
- `unknown`: the intent was accepted, but the current before/after snapshots do
  not prove the effect. The audit reason explains why.
- `failed`: the audit had enough information to expect the effect and did not
  see it. Treat this as a bug unless the reason documents an expected rule edge
  case.
- `not_applicable`: no effect was expected, usually because the action was hold
  or the intent was rejected before execution.

The successful demo target is zero failed audits. Unknown audits are
acceptable only when the artifact explains what the mirror could not prove.

## Spectator And Real Render Modes

The local demo has two viewer modes.

The static artifact spectator is:

```text
artifacts/ai-league-runs/<run-id>/spectator.html
```

It is a replay, not a live spectator client. The smoke/demo runner captures
mirrored core snapshots after spawn and after each step-locked decision cycle,
then writes `spectator-replay.json` and a standalone `spectator.html`.

What it shows:

- A canvas map of owned territory for each agent across saved snapshots.
- Agent roster, profile, brain type, territory, troops, and gold summaries.
- A decision timeline with action kind badges, selected `LegalAction.id`,
  model/agent reason, latency, generated intent summary, accepted/rejected
  status, fallback status, and audit status.
- Links back to `visual-report.html`, `match-report.md`, `decisions.jsonl`,
  `match-summary.json`, `spectator-replay.json`, and `game-record.json`.

Read-only guarantees:

- `spectator.html` opens no socket and does not call `fetch`.
- It creates no `Client`, no player, and no spectator player slot.
- It has no intent submission path; AI agents still submit validated intents
  only through `AgentRunner -> GameServer`.

The real ProxyWar renderer route is:

```text
http://localhost:9000/ai-league-replay/<run-id>
```

Run the local render server first:

```bash
npm run agent:league-render-server
```

This route fetches `game-record.json` and `decisions.jsonl` through the local
dev server, then uses the existing `LocalServer` replay path and real
`GameRenderer`. The viewer receives no `myClientID`; `LocalServer` ignores
non-pause intents during replay, so the route is read-only and does not occupy a
player slot. A compact overlay lists AI decisions while the ProxyWar canvas
renders terrain, territory, structures, bots, agents, attacks, and replay UI.

To generate a run specifically for this real-render demo:

```bash
npm run agent:league-demo:render
```

That command creates a stepped action-diversity match with four AI agents and
four core built-in bots (`--bots=4`). The generated visual report, static
spectator, and run index link to the real render URL.

For the same mixed render demo with Codex CLI controlling the AI agents:

```bash
AI_LEAGUE_CODEX_TIMEOUT_MS=180000 npm run agent:league-demo:render:codex-cli
```

## Remaining LLM Blockers

- Attack support is proven in a dedicated deterministic scenario, but normal
  league matches still do not reliably produce hostile borders immediately
  after spawn. Richer combat needs expansion decisions or longer match
  progression.
- Observation visibility rules still need a spectator/client-view policy before
  production agents can be trusted not to over-observe hidden state.
- Real model calls are available only through the opt-in smoke path. They have
  not been used in tests, tournament mode, distributed workers, or production
  match orchestration.
- Codex CLI model calls are private-testing-only. They depend on the local
  developer's Codex login and local CLI behavior, so they are not portable
  tournament infrastructure.
- Combat observation is intentionally compact. It exposes border/attackability
  and rough troop/territory estimates, not pathing details, front-line geometry,
  or precise tactical evaluation.
- Build observation currently samples owned territory for `Defense Post`,
  `City`, and `Factory` only. Ports, ships, silos, SAMs, and nukes need more
  specialized target and safety logic.
- Donation actions only appear when the live game already considers another
  player friendly. In normal FFA this usually requires reciprocal alliance
  requests first.
- Prompt/response storage is now durable local artifact data, but it is not yet
  a queryable database.
- The real-render route is local/dev-only and reads artifacts from
  `artifacts/ai-league-runs`. It is not yet a hosted spectator service with
  access control, live streaming, or persistent run storage.
- The current runner attaches in process. A production runner still needs the
  real worker WebSocket/auth path for distributed matches.
- Step-locked smoke now provides a local decision timing budget, but production
  orchestration still needs provider budgeting, cancellation, retry policy,
  memory store, and spectator UI timeline.
- Additional action families still need legal builders and smoke proof:
  ports/ships, missile silos, SAMs, nukes/missiles, target-player markings,
  quick chat, alliance extension/rejection/breaking, and delete/upgrade unit
  flows.

## Next Milestones

1. State visibility policy: decide what an agent may know and make the
   observation builder enforce it.
2. Real LLM evaluation runbook: run controlled opt-in model matches, compare
   fallback rate, parse failures, latency, and action diversity against mock
   baselines.
3. Richer non-combat actions: add ports/ships, upgrades, support after
   reciprocal alliances, and safe target-player markings.
4. Live spectator service: host generated replay records and decision overlays
   behind a proper route, then add a live read-only observer after replay mode
   is stable.
5. Agent package and tournament mode: define agent bundles, match entry rules,
   deterministic seeds/configs, scoring, and replayable tournament runs.

## Current Smoke Path

Run:

```bash
npm run agent:smoke
```

The smoke script creates a private in-process game, creates one hardcoded agent,
attaches it, submits `spawn` on tile `10`, and prints the queued server intents.
This proves the first server-side join and intent path, not full LLM play.

Run:

```bash
npm run agent:league-smoke
```

The league smoke script loads the static Asia compact map, generates legal spawn
candidates, creates four strategy-profile agents, starts one private in-process
game, submits opening decisions through the formal agent interface, mirrors
server turns into a local `GameRunner` until spawn ends, runs one live
post-spawn decision turn, and prints decision records.

Run:

```bash
npm run agent:league-smoke:mock-llm
```

The mock LLM smoke path uses `LlmAgentBrain` and `MockLlmProvider`. It proves the
JSON id-selection contract without requiring API keys or making network calls.

Run:

```bash
npm run agent:league-smoke:mock-llm:stepped
```

The stepped mock smoke uses the same mock LLM brain but runs in step-locked
mode. It proves slow-brain orchestration without consuming external model
usage: agents spawn, the server advances only until active phase, agents observe
early live post-spawn state, choose non-hold actions when available, submit
normal intents, and then the smoke advances a controlled turn step.

Run, only when real LLM environment variables are present:

```bash
npm run agent:league-smoke:real-llm
```

The real LLM smoke path uses step-locked action-diversity mode,
`LlmAgentBrain`, and `OpenAiLlmProvider`. Alliance actions are disabled in this
smoke for the same reason as the Codex product demo: it keeps slow-provider
private tests focused on build/embargo choices that execute cleanly when batched
into a smoke turn. If
`AI_LEAGUE_LLM_PROVIDER=openai`, `AI_LEAGUE_LLM_MODEL`, or `OPENAI_API_KEY` is
missing, the command exits before making a match or an API call and prints the
missing configuration. If configured, the model still receives only
`AgentObservation + LegalAction[]` and may only choose one listed
`LegalAction.id`.

Run, only for private local testing with Codex CLI logged in:

```bash
npm run agent:league-smoke:codex-cli
```

This path sets `AI_LEAGUE_LLM_PROVIDER=codex-cli`, shells out to `codex exec`,
uses the local Codex login, and runs in step-locked mode so the match does not
race ahead while Codex thinks. Like the product demo, it uses the
action-diversity scenario with alliance actions disabled so private Codex tests
exercise build/embargo action choices without same-turn alliance ambiguity. It
is useful for private experiments when you do not want to place a direct OpenAI
API key in the environment, but it should not be used for public hosted matches.

Run, only for private local testing with Codex CLI logged in:

```bash
npm run agent:league-smoke:codex-cli:stepped
```

The stepped Codex CLI smoke is the useful private test for Codex-driven
post-spawn strategy. It keeps the match from racing ahead while `codex exec`
thinks, then records whether Codex selected real non-hold post-spawn
LegalAction ids, whether parsing succeeded, whether fallback was used, and
which normal game intents were accepted.

Run:

```bash
npm run agent:league-smoke:attack
```

The attack smoke path uses a deterministic spawn plan generated outside core:
the first two spawn candidates produce adjacent hostile territories, the match
uses `spawnImmunityDuration: 0`, the aggressive mock LLM selects an offered
attack LegalAction id, and the other agents hold after spawn so the attack can
be observed cleanly. The smoke fails if no attack intent is accepted or if the
mirrored core state does not record the attack.

Run:

```bash
npm run agent:league-smoke:actions
```

The action-diversity smoke uses the normal Asia compact map and normal spawn
candidate flow, with extra starting gold so build legality can be proven
immediately after spawn. Mock LLM brains select build LegalAction ids, submit
real `build_unit` intents, and fail the smoke if no accepted non-hold
post-spawn action is selected or mirrored into core.

## Product Demo Commands

Launch the local hosted demo hub:

```bash
npm run agent:demo-server
```

Then open `http://127.0.0.1:8787`. From there you can start a mock/planner demo,
run a small evaluation, run a manifest tournament, browse recent artifacts, and
open native ProxyWar replay links for runs that wrote `game-record.json`.

Refresh the local demo index:

```bash
npm run agent:demo:index
```

Run a local visual demo with mock LLM brains:

```bash
npm run agent:league-demo:visual
```

This is the fastest human-inspectable product demo. It runs a small
step-locked match, requires at least two post-spawn decision cycles, writes all
durable artifacts, and generates `visual-report.html` plus `spectator.html`.

Run a local spectator-focused demo with mock LLM brains:

```bash
npm run agent:league-demo:spectator
```

This uses the action-diversity scenario, writes a stepped match with build and
embargo actions when legal, refreshes the run index, and produces a direct
`spectator.html` replay artifact. Open that file in a browser to watch the map
snapshots and decision overlay.

Run a local real-render demo with four AI agents plus four core bots:

```bash
npm run agent:league-demo:render
npm run agent:league-render-server
```

Then open the printed URL:

```text
http://localhost:9000/ai-league-replay/<run-id>
```

This is the easiest way to inspect the match with the real ProxyWar canvas
instead of the lightweight static spectator canvas.

The render demo intentionally uses more decision steps, wider turn spacing, and
extra replay tail turns so the replay remains watchable instead of stopping just
after the proof decisions. The replay route also auto-centers spectator cameras
on a spawned AI player because spectators do not occupy a player slot and
therefore do not have normal "my player" camera target.

Run the same real-render setup with Codex CLI decisions:

```bash
AI_LEAGUE_CODEX_TIMEOUT_MS=180000 npm run agent:league-demo:render:codex-cli
```

Run a private Codex CLI controlled demo:

```bash
AI_LEAGUE_CODEX_TIMEOUT_MS=180000 npm run agent:league-demo:codex-cli
```

Agent strategy skills are documented in `docs/AI_AGENT_PLAYBOOK.md`. The LLM
prompt includes a compact version of that playbook, and legal actions now expose
neutral expansion when the live observation proves adjacent unowned land.

## Longer-Horizon Objectives

Each agent now receives a tiny per-match objective in its observation. The
objective is generated outside `src/core` from the agent profile, recent memory,
live observation, and the offered `LegalAction[]`.

Current objective kinds:

- `choose_spawn`
- `expand_territory`
- `secure_economy`
- `fortify_border`
- `pressure_rival`
- `build_alliance`
- `survive`

The objective does not create new powers and does not bypass validation. It only
helps a brain choose among already-offered legal actions. For example,
`secure_economy` prefers economic build actions, `pressure_rival` prefers
non-expansion attacks or embargoes, and `build_alliance` prefers alliance or
support actions.

Each run now also writes an objective scorecard:

```text
artifacts/ai-league-runs/<run-id>/objective-scorecard.json
artifacts/ai-league-runs/<run-id>/objective-scorecard.md
```

The scorecard answers "did this agent pursue its plan?" using objective
alignment, accepted intent rate, audited effect rate, post-spawn non-hold rate,
repeated-action penalty, rejected intent penalty, fallback penalty, parser
failure penalty, and unknown/failed audit penalties. Unknown audits are never
treated as confirmed; they lower confidence and stay visible in reports.

Decision artifacts now include:

- `objectiveKind`
- `objectiveSummary`
- `objectiveAligned`
- aggregate objective counts
- objective alignment rate

Use these fields to inspect whether an agent actually followed its longer-term
goal across several decision cycles.

## Planner / Executor Mode

The main product mode is **LLM policy planner + local engine-derived
executor**. The LLM/Codex layer is a slow governor: it chooses objectives,
preferred action kinds, enabled policy modules, targets, and tactical
constraints occasionally. The local planner/executor then scores the current
legal action menu quickly and selects concrete `LegalAction.id` values.

Planner/executor mode splits agent intelligence into:

- slow planner: chooses an objective/plan every few decision cycles or when
  memory says the agent is repeating low-value behavior
- fast executor: selects a valid `LegalAction.id` every decision step using the
  current observation, current plan, memory, and strategic skill scores

Runtime modes are reported explicitly:

- `local-policy-baseline`: rule planner plus local `FrontierPolicyExecutor`;
  zero external calls.
- `mock-policy-planner`: mock planner plus local executor; zero external calls
  and useful only for plumbing/tests.
- `llm-policy-planner`: Codex/OpenAI/custom planner plus local executor; this
  is the main target product mode.
- `llm-action-selector`: Codex/OpenAI/custom provider directly chooses one
  offered `LegalAction.id`; expensive comparison/debug mode.

Legacy names remain as aliases: `rule-planner`, `planner`,
`planner-codex-cli`, and `codex-cli`.

Run the mock policy-planner demo:

```bash
npm run agent:league-demo:planner
```

Run the Codex CLI planner demo:

```bash
AI_LEAGUE_CODEX_TIMEOUT_MS=180000 npm run agent:league-demo:planner:codex-cli
```

Use a cheaper Codex CLI planner configuration:

```bash
AI_LEAGUE_CODEX_MODEL=gpt-5.4 AI_LEAGUE_CODEX_REASONING_EFFORT=medium npm run agent:league-demo:planner:codex-medium
```

Run a full benchmark-style match with that cheaper planner configuration:

```bash
AI_LEAGUE_CODEX_MODEL=gpt-5.4 AI_LEAGUE_CODEX_REASONING_EFFORT=medium npm run agent:benchmark:bots:full:codex-medium
```

The planner is not allowed to submit game intents or select raw actions.
It returns a structured objective/plan. The executor still selects exactly one
offered `LegalAction.id`, and `AgentDecisionValidator` remains the safety gate.
Direct action-selector mode also selects only from offered `LegalAction.id`
values; it is not allowed to emit raw game intents.

Planner/executor artifacts include:

- `runtimeMode`
- `planObjective`
- `planRationale`
- `plannerSource`
- `executorSource`
- `actionSelectionSource`
- `externalPlannerCall`
- `externalActionCall`
- `rawProviderOutputPresent`
- `plannerRan`
- `plannerRefreshReason`
- `plannerLatencyMs`
- `plannerFallbackUsed`
- `planFollowed`

Reports show planner decisions separately from executor actions, including
planner fallbacks and parse failures. A local-only or mock-only win is not an
LLM win unless `externalPlannerCallCount` or `externalActionCallCount` is
non-zero and the report shows provider output/cost attribution.

## Strategic Skills

Agents now share a compact strategy skill taxonomy:

- `expansion`
- `troop_conservation`
- `economy_building`
- `defense_building`
- `diplomacy`
- `pressure`
- `attack_timing`
- `support_ally`
- `recovery`
- `opportunism`

`StrategicSkillEvaluator` scores each offered `LegalAction` outside `src/core`
using the current objective, legal action kind, metadata, risk, memory, and
repetition. The rule executor uses those scores, and LLM prompts include a
compact `STRATEGIC_SKILL_SCORES_JSON` block. Codex/LLMs still choose only a
listed `LegalAction.id`.

Decision logs and visual reports now show the selected skill, skill score, and
top alternatives considered. This makes repeated neutral expansion, repeated
alliance requests, and low-value holds visible instead of silently "valid."

The current behavior layer also treats repeated neutral expansion as a
watchability and strength risk. After an agent has expanded repeatedly, economy,
diplomacy, or real pressure actions receive diversity bonuses when they are
legal, and another neutral expansion receives an explicit stale-action penalty.
That keeps the default demo from looking like four identical scripts marching
through the same expansion loop.

Social/flavor actions such as quick chat and emoji are intentionally secondary
in the planner/executor scheduler. Pressure plans still schedule real target,
embargo, attack, build, or movement actions before flavor, but the executor can
now attach one public quick-chat and one contextual emoji reaction to a
meaningful action. Quick chat is broadcast publicly in replay context. Emoji
uses the built-in bubble system with context-aware choices: evil for
betrayal, clown for weak or overextended targets, target/fire for pressure, and
handshake/thumbs-up for alliance signals.

## Spectator Replay UX

Generate a watchable local replay artifact:

```bash
npm run agent:league-demo:watch
```

This writes the usual run artifacts plus:

```text
artifacts/ai-league-runs/<run-id>/spectator.html
artifacts/ai-league-runs/<run-id>/spectator-replay.json
artifacts/ai-league-runs/<run-id>/game-record.json
```

`spectator.html` is a static, read-only replay. It has pause/play, scrub,
previous/next step controls, follow-agent selection, action-kind filters, and a
selected-decision panel showing objective, plan, skill, reason, generated intent,
latency, accepted/rejected status, fallback status, and audit status. It opens no
socket, creates no player, and cannot submit intents.

For the real ProxyWar renderer route, run:

```bash
npm run agent:league-demo:render
npm run agent:league-render-server
```

Then open:

```text
http://localhost:9000/ai-league-replay/<run-id>
```

The real renderer is still replay-oriented, not a hosted live spectator service.
If no replay snapshots were captured, the static spectator page displays a
graceful empty state and keeps artifact links visible.

This command requires `codex login`. Codex controls each agent through the same
LLM JSON action contract: it receives one agent's observation and legal action
ids, returns one selected `LegalAction.id`, and the validated intent is submitted
through `AgentRunner -> GameServer`. The demo remains step-locked and writes the
same artifact set, including `visual-report.html`.
It also writes `spectator.html`, `spectator-replay.json`, and `game-record.json`
for local replay inspection.

The Codex CLI product demo uses the action-diversity scenario with alliance
actions disabled. Alliance LegalActions remain supported elsewhere, but the demo
leans on build and embargo choices so same-turn diplomacy does not produce
ambiguous core rejection warnings while multiple slow external decisions are
batched into one turn.

## Evaluation

Run batch evaluation:

```bash
npm run agent:evaluate -- --brain=mock-llm --runs=2 --scenario=actions
```

Supported options:

- `--brain=rule`
- `--brain=mock-llm`
- `--brain=planner`
- `--brain=codex-cli`
- `--brain=planner-codex-cli`
- `--brain=local-policy-baseline` in the frontier benchmark
- `--brain=mock-policy-planner` in the frontier benchmark
- `--brain=llm-policy-planner` in the frontier benchmark
- `--brain=llm-action-selector` in the frontier benchmark
- `--scenario=normal`
- `--scenario=actions`
- `--scenario=attack`
- `--scenario=stepped`
- `--runs=N`

Evaluation writes:

```text
artifacts/ai-league-evals/<eval-id>/evaluation-summary.json
artifacts/ai-league-evals/<eval-id>/evaluation-report.md
```

The evaluation report lists run ids, action counts by kind, non-hold rate,
accepted/rejected rate, fallback rate, parser failure rate, provider
timeout/error count, latency stats, whether each run produced
`visual-report.html`, notable decisions, and paths to per-run reports.

All league smoke commands print the artifact directory at the end of the run.
To force a stable artifact path, pass `--run-id=<name>` after the script command,
for example:

```bash
npm run agent:league-smoke:actions -- --run-id=actions-baseline
```

## Tournament Mode

Tournament mode starts with config/manifest-defined agents only. It does not load
or execute arbitrary user code.

Example manifests live in:

```text
docs/ai-league-agent-manifests/
```

Each manifest defines:

- agent name
- profile
- brain type
- planner/executor mode
- personality
- observation policy
- skill preferences
- provider/model settings when applicable

Run a mock/planner tournament:

```bash
npm run agent:tournament:mock
```

Run a small Codex CLI tournament when logged in:

```bash
AI_LEAGUE_CODEX_TIMEOUT_MS=180000 npm run agent:tournament:codex-cli -- --runs=1
```

Tournament artifacts are written to:

```text
artifacts/ai-league-tournaments/<tournament-id>/tournament-summary.json
artifacts/ai-league-tournaments/<tournament-id>/tournament-report.md
artifacts/ai-league-tournaments/<tournament-id>/leaderboard.json
artifacts/ai-league-tournaments/<tournament-id>/leaderboard.html
```

The leaderboard combines objective score, accepted intent rate, non-hold rate,
audit score, and fallback/parser/rejected/audit penalties. Every per-run artifact
remains available under `artifacts/ai-league-runs/<run-id>/`.

## ProxyWar Behavior Consolidation

ProxyWar is the public product framing for this internal AI Nations League
runner. The current architecture and gameplay notes are split into focused docs:

- `docs/PROXYWAR_AGENT_ARCHITECTURE.md`
- `docs/PROXYWAR_BOT_NATION_PLAYBOOK.md`
- `docs/PROXYWAR_BEHAVIOR_ROADMAP.md`

The important behavior fix from the consolidation pass is building placement.
Defense Posts are no longer treated as generic interior defensive structures.
Live observations now attach placement metadata to build options, and Defense
Post candidates require a proven hostile frontier, incoming land attack, or
meaningful defensive value. City and Factory actions carry economic placement
metadata so agents can prefer safer interior economy when no border threat
exists.

LLM/Codex prompts now explicitly forbid code, TypeScript, shell commands, tool
calls, and raw game intents. The model still chooses only one offered
`LegalAction.id`.

Benchmark one ProxyWar agent against built-in nations:

```bash
npm run agent:benchmark:bots
```

Strict full-match gate:

```bash
npm run agent:benchmark:bots:full
```

Current passing full gate:

- Run id: `2026-05-11T03-29-06-603Z-frontier-mock-policy-planner-90ae84f0`
- Result: 10/10 wins
- Conditions: one ProxyWar planner/executor agent vs 5 built-in
  `PlayerType.Nation` opponents plus 5 built-in tribe/bot opponents, Pangaea
  Compact, Easy difficulty, full GameServer/core simulation.
- Report:
  `artifacts/ai-league-benchmarks/2026-05-11T03-29-06-603Z-frontier-mock-policy-planner-90ae84f0/benchmark-report.md`

Medium difficulty is still the next competitive behavior target; the Easy gate
is the current repeatable pass condition, not the final strength ceiling.

If the shell does not expose `npm`, run the same benchmark through local `tsx`:

```bash
PATH=/path/to/node/bin:$PATH
GAME_ENV=dev ./node_modules/.bin/tsx src/scripts/ai-agent-frontier-benchmark.ts --brain=planner --runs=2 --nations=3 --max-turns=6000
```

Benchmark artifacts are written under:

```text
artifacts/ai-league-benchmarks/<benchmark-id>/
```
