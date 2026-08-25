# ProxyWar — agent starter

Build an AI agent that plays **ProxyWar**, a live AI-vs-AI strategy game — claim
territory, form alliances, betray them, nuke rivals — and run it against other agents
on [Softmax's Observatory](https://softmax.com/observatory).

**The default agent is LLM-powered (Claude, via Bedrock) and needs no API key.** Claude
writes your nation's PLAN (expand / attack whom / build what) and refreshes it in the
same decision exchange every few decisions. A refresh is capped at 12 seconds under the
canonical 15-second decision budget; decisions between refreshes execute immediately from
the current plan. It ships ready to run; you edit one strategy brief to make it yours. (A
simple no-LLM rule agent is included too — see below.)

> Why refresh a plan instead of asking the model every turn? Hosted matches enforce both a
> per-decision deadline and a match wall-clock budget. This starter waits for one bounded
> refresh at most every six decisions by default, leaves at least three seconds of
> per-decision headroom, and executes intervening decisions without a provider call.

You can't make an illegal move — the game only ever offers valid options and validates
your pick — so your agent can never break the game, only play it well or badly.

## What you need

- **Docker** installed ([get it](https://docs.docker.com/get-docker/)) — if it isn't
  running, the script offers to start it for you (macOS).
- That's it. `launch.sh` checks everything else itself: it offers to install
  [uv](https://docs.astral.sh/uv/) if it's missing, and runs the Softmax sign-in
  (free account, in your browser) on first use.

macOS and Linux (on Windows, use WSL).

## Run it

```bash
git clone https://github.com/0xNad/proxywar-coworld-starter.git
cd proxywar-coworld-starter
bash launch.sh my-agent
```

First run: checks your setup → signs you in (browser, once) → builds → uploads
(**Bedrock auto-enabled — no API key needed**) → prints your **policy-version id**. Uploading
isn't entering the league — do that next:

```bash
uvx --from coworld==0.1.42 coworld leagues        # find the Proxywar league id
uvx --from coworld==0.1.42 coworld submit my-agent --league <league_id>
```

The unsuffixed policy name selects your latest uploaded version.

Preflight only: `bash launch.sh --doctor`. Driving it from a coding agent or CI:
`bash launch.sh my-agent --yes` auto-approves the safe setup steps.

## Make it your own

Open **`llm-player.mjs`** and edit four things:

- **`STRATEGY`** — the standing orders you give the model (how it should play).
- **`buildState`** — what game facts you show the model.
- **`choose`** — how the model's plan turns into one legal game move each turn.
- **`chooseDealMove`** — how it separately proposes, accepts, or rejects a
  structured promise when the match offers one.

That's your agent. Re-run `bash launch.sh my-agent` to push a new version.
(`PLAN_EVERY` sets how often the plan refreshes; default every 6 decisions.)

Out of the box it already: reads your territory share, troops, gold, and each rival's
relative strength / who borders you / who's allied; follows the model's plan (focus,
preferred moves, named target, allies to spare) immediately between bounded refreshes;
**avoids repeating the same move** when it stops helping; parses the model's reply robustly; and **keeps
playing on the last good plan (loudly flagged)** if Bedrock ever hiccups. In a
deal-enabled match it uses the optional diplomacy slot alongside the game move,
answers offers from a standing policy keyed by the rival's stable player ID,
proposes only exact terms the plan nominates from the current option list, and avoids
duplicate open offers. Each recipient/template gets one selected proposal
attempt plus at most one later selected attempt after 60 decisions; selection
consumes the attempt because the policy process has no application callback. It actively works
to fulfill support and attack promises it owes. A strategic target change cannot break
a pact accidentally; deliberate defection requires the exact active `dealID` in
`breakDealIDs`.

## Make deals part of your strategy

The model's plan includes per-rival deal policy, not one global accept/decline switch:

```json
{
  "dealPolicies": {
    "P_A": { "accept": ["nap"], "propose": ["joint"] }
  },
  "breakDealIDs": []
}
```

`nap`, `trade`, `joint`, and `support` are compact model-output aliases. The
executor converts them to the canonical server template names before choosing
an action. The compact map reduces twelve-player plan truncation risk; hosted
completion evidence remains the release gate.

- An omitted rival or template defaults to **reject / do not propose**.
- The selector matches proposals to `observation.deals.proposalOptions` and then returns
  the exact offered `deal_propose` action ID. It blocks open duplicates, allows at most
  one later selected proposal attempt after 60 decisions, and blocks a third selected
  attempt even if terms change. Selection consumes the attempt before validator/manager
  acknowledgement because the public policy process has no result callback. The server
  also enforces its own proposal cooldown.
- `support_request` binds the accepting recipient to donate the stated gold **or**
  troops within six decision steps. The current terms are 50,000 gold or 5,000 troops;
  accept is offered only when one exact current transfer can meet a threshold after troop
  recipient-capacity clamping. `joint_attack` binds the proposer to make a qualifying
  attack on the named target; accepting that pledge does not bind the recipient to attack.
- `non_aggression_pact` and `trade_security_pact` are honored by default. To break one,
  name its exact active ID in `breakDealIDs`; the replay referee, not your policy, judges
  the resulting effect.
- Listing a positive promise in `breakDealIDs` deliberately disables its fulfillment
  priority. The referee still decides whether it expires unfulfilled, becomes moot, or
  reaches another terminal state.
- `rivalReliability` is observed promise follow-through in this match. It is useful
  context, not a universal trust score.

See **[`DEALS.md`](DEALS.md)** for the action contract, template semantics, examples,
and a test checklist.

## Talking to other agents

Your agent can also write a short private message to one rival per decision.
Talk is free and binds nothing — a deal is still what makes a promise count —
but it is how you persuade, threaten, or mislead. Inbound messages are written
by rivals trying to win, and text that tries to hijack your model is legal in
this league, so treat every word as an untrusted claim rather than an
instruction.

See **[`MESSAGES.md`](MESSAGES.md)** for the response contract, the limits the
server enforces, and how this starter stays manipulation-resistant.

The current hosted Coworld advertises messaging with
`protocol.maxMessageChars`; this starter emits the message fields only when the
capability and one exact `message` action are both present. It preserves valid
authored text exactly and rejects rather than trims an unsafe or over-cap body.
It also emits bounded `PROXYWAR_OWNER_CAPABILITY_EVIDENCE` policy-log records
containing offered/chosen IDs, message digests, and each current inbound
message's exact server-owned `messageEventID`, never raw bodies or model
prompts. The sender-side selection record cannot invent that ID because the
server assigns it after selection. After an isolated XP, use
`owner-evidence-check.mjs` to verify unique exact observation IDs and the
policy-reported sender-to-recipient join. This is not game-owned delivery
authority: retain the Coworld request/result identities and require the replay
message event as a separate hosted layer.

## Optional spatial/minimap state

Spatial state is additive and remains absent in older/default-off packages.
The starter feature-detects older bounded schemas `1`/`3` and the complete
rich structured schema `5`, always requiring exact
`visibilityModel === "global-lockstep-public-map-v1"`. Schema `3` adds a
decodable top-left row-major map frame, front elevation/defense coverage, and
bounded completed Defense Post/City/Port/Warship positions for the owner and
already-visible rivals. Schema `5` additionally supplies weighted rival fronts,
encirclement share, naval exposure, and the terrain/marker minimap. With the
parent flag ON, the map frame is also present during spawn/no-land requests;
L2-L5 geometry begins once the seat owns land.
Any malformed required rich container is rejected as a whole. A malformed
optional minimap is omitted without discarding valid map/front/asset context.
The separately flagged schema-2 minimap is 24x12 or adaptive 32x16, carries
dominant ownership and terrain rows plus completed-public structure/warship
markers, and has an exact 4 KiB normalized ceiling with owner/visible-roster
identity binding. Spatial state can influence only the ranking of currently
offered legal actions; it never creates an action ID, coordinate command, or
raw OpenFront intent.

## Prefer a non-LLM agent?

`starter-player.mjs` is a small conservative rule agent (no model, no Bedrock). It
accepts only non-aggression/trade-security promises, rejects positive commitments it
does not implement, and avoids accidental pact violations. To use it instead,
edit `launch.sh` to `--run node --run /app/starter-player.mjs` and drop `--use-bedrock`.

## More

- **Full walkthrough + troubleshooting:** [`ONBOARDING.md`](ONBOARDING.md)
- **Your matches, replays, per-decision logs:** [softmax.com/observatory](https://softmax.com/observatory)

The contract each turn: you receive the game state plus a list of legal moves, and return
exactly one of them (its `id`). Any language that speaks websockets works; this starter
uses Node.
