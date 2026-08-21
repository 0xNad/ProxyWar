# Proxy War Coworld Player Protocol

The Proxy War Coworld keeps Proxy War's existing external-agent contract and
carries it over a Coworld websocket.

The player container reads `COWORLD_PLAYER_WS_URL` and connects to:

```text
/player?slot=<slot>&token=<token>
```

The game sends:

```json
{
  "type": "decision_request",
  "requestID": "req_...",
  "slot": 0,
  "protocol": {
    "maxActionsPerDecision": 5,
    "maxSpawnPreferences": 16
  },
  "request": {
    "protocolVersion": "proxywar-agent-v1",
    "observation": {},
    "legalActions": [
      {
        "id": "hold",
        "kind": "hold",
        "label": "Hold",
        "risk": { "level": "none", "score": 0 }
      }
    ],
    "responseContract": {
      "selectedLegalActionId": "must exactly match one offered legalActions[].id",
      "selectedDealActionId": "optional; must exactly match one offered deal_* legalActions[].id",
      "reason": "short human-readable string",
      "confidence": "optional number from 0 to 1"
    }
  }
}
```

The player replies:

```json
{
  "type": "decision_response",
  "requestID": "req_...",
  "selectedLegalActionId": "hold",
  "runtimeMode": "llm-policy-planner",
  "reason": "No better legal action was available.",
  "confidence": 0.5
}
```

`selectedLegalActionId` must be one exact offered `legalActions[].id` - no exceptions and no
off-menu ids, for every action kind: the websocket adapter returns an `AgentDecision`, but the
existing `AgentDecisionValidator`, `AgentRunner`, and `GameServer` remain the sole authority, and
`LegalAction.id` selection is still the only way to act - no raw core intent is ever accepted
from a player.

### Reporting a degraded brain

When your policy could not decide for itself, say so: `"fallbackUsed": true` and
`"llmPlannerDegraded": true` travel with the decision so replays and results never
report a dead brain as a healthy one.

`"degradedCause"` is optional and explains WHY. It is validated against a fixed
vocabulary and silently dropped otherwise — an invented cause in an attribution field
is worse than no cause at all:

| value              | meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `plan-warmup`      | No plan yet; the first refresh is still in flight. Benign.            |
| `plan-stale`       | A plan exists, but the latest refresh failed; acting on stale intent. |
| `plan-unavailable` | No plan at all, and the refresh failed.                               |
| `plan-timeout`     | The planner's provider call exceeded the policy's own budget.         |
| `plan-parse`       | The model answered, but its output could not be parsed.               |
| `policy-error`     | The policy's own code threw before it could decide.                   |

A cause is only recorded alongside `"llmPlannerDegraded": true`; sent on its own it is
ignored, so a decision that reports health can never carry failure evidence.

`brain-timeout` and `brain-error` belong to the same vocabulary but are stamped by the
GAME when it never hears from a policy, or when a brain throws. They are rejected on
the inbound wire: a policy cannot attribute its own failure to the server.

### Reporting the runtime path

`"runtimeMode"` is optional, self-reported attribution for the policy runtime
under which this decision was produced. It must exactly equal one of these
values:

- `local-policy-baseline`
- `mock-policy-planner`
- `llm-policy-planner`
- `llm-action-selector`
- `commander-v0-selector`
- `autopilot-executor`

The parser does not trim, case-fold, or infer a mode from the policy name. An
omitted or unrecognized value is recorded as `unknown`; existing third-party
policies therefore remain unknown unless they report one of the exact bounded
values themselves. A runtime mode does not claim that a provider call occurred
on that exact decision; the separate external-call and degradation fields carry
that evidence. Runtime-mode counts are safe aggregate telemetry in
`match-summary.json`. The per-decision record remains in the private
`decisions.jsonl` artifact and is not included in the public replay bundle.

## Spawn preference round (active v1)

Before ordinary play, the game runs exactly one sealed, concurrent spawn
preference round. For `N` players it offers every player the same `N`
quality-floored, maximin-spaced `spawn:<tile>` legal actions. Each action
includes bounded metadata such as `tile`, `x`, `y`, `pressureScore`,
`safetyScore`, `diplomacyScore`, `opportunityScore`, and `localLandScore`.

The request advertises both
`protocol.maxSpawnPreferences` and this spawn-only response contract:

```json
{
  "responseContract": {
    "selectedLegalActionId": "must exactly match one offered legalActions[].id",
    "spawnPreferenceLegalActionIds": "optional ordered array of exact offered spawn legalActions[].id values; selectedLegalActionId must be first",
    "maxSpawnPreferences": 16,
    "reason": "short human-readable string",
    "confidence": "optional number from 0 to 1"
  }
}
```

Reply with the scalar first choice and, when supported, the ranked ballot:

```json
{
  "type": "decision_response",
  "requestID": "req_...",
  "selectedLegalActionId": "spawn:420",
  "spawnPreferenceLegalActionIds": ["spawn:420", "spawn:105", "spawn:880"],
  "reason": "Prefer local land and safety, then opportunity.",
  "confidence": 0.7
}
```

Rules:

- `selectedLegalActionId` is required and must exactly equal element 0 of an
  explicit `spawnPreferenceLegalActionIds` ballot.
- The ballot is spawn-only, contains at most 16 unique strings of at most 200
  characters each, and every entry must exactly match an offered spawn id.
  Partial rankings are allowed. A scalar-only legacy reply is a one-item
  partial ranking.
- The server completes a valid partial ranking in deterministic offered-menu
  order. It rejects an explicit malformed, duplicate, off-menu, mismatched, or
  oversized ballot as a whole and applies the recorded deterministic default.
- The ranking describes preferences for one eventual assignment. It is never
  `selectedLegalActionIds`, never an executable action batch, and never causes
  more than one spawn intent.
- All responses remain hidden until the common round settles. Allocation uses
  a recorded, report-independent priority order and each player receives its
  highest-ranked remaining slot. Response arrival time cannot improve priority.
- This is active protocol v1: one sealed round only. There is no reveal,
  reaction, relocation, trade, retry, or second preference phase.
- The final assigned offered action still passes through
  `AgentDecisionValidator -> AgentRunner -> GameServer`. Players never send a
  tile coordinate or raw spawn intent.

The complete sealed-round evidence is retained in the operator's private
`decisions.jsonl`: offered ids, submitted and normalized ballot, fallback or
validation reason, report-independent priority position, assigned id, and
assigned rank. The public replay records the final executed spawn only. It does
not expose the hidden ballots or by itself prove allocation integrity.

## `selectedDealActionId` (optional)

`selectedDealActionId` is an OPTIONAL second selection - the diplomacy slot. The current league
manifest enables structured deals. The offered action menu is still the source of truth: send the
field only when that exact `deal_*` id appears in the current `legalActions`. A player that never
sends it remains protocol-compatible, but deliberately ignores those diplomacy opportunities.

Where deals ARE on, the field is applied ALONGSIDE `selectedLegalActionId` in the same decision,
so proposing or answering a pact does not cost the player its move:

```json
{
  "type": "decision_response",
  "requestID": "req_...",
  "selectedLegalActionId": "expand:terra-nullius:10",
  "selectedDealActionId": "deal_accept:deal:P_A:P_B:non_aggression_pact:4",
  "reason": "Grow west while the pact holds my east border.",
  "confidence": 0.6
}
```

Rules:

- It must be one exact offered `legalActions[].id` whose `kind` is one of `deal_propose`,
  `deal_accept`, `deal_reject`, `deal_withdraw`.
- Any other id is rejected and dropped - including any id that carries a game action. There is no
  fallback and no second game action: a game action can never be played through this field.
- One deal action per decision. If `selectedLegalActionId` is itself a `deal_*` action, the deal
  slot is rejected outright (the game action stands) - so send the deal in one place, not both.
- Proposals are additionally rate-limited to one every few decision steps; while a player is
  inside that window no `deal_propose` action is offered at all, so selecting only from the
  offered menu is always enough.
- The reply's `reason` doubles as the stated rationale attached to the pact or betrayal in
  replays. It is shown to VIEWERS only - it is never sent to any other player.

### Promise semantics

Deals are breakable promises judged from confirmed game effects. They never grant permission,
block an otherwise legal move, punish a defection, or alter league rating. The server-authored
verdict and an agent's viewer-only stated reason are separate evidence.

| Template                           | Who becomes obligated after acceptance | What the referee observes                                                                                                    |
| ---------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `non_aggression_pact`              | Both parties                           | Neither launches a confirmed hostile action against the other during the window.                                             |
| `trade_security_pact`              | Both parties                           | Non-aggression plus neither starts a voluntary embargo against the other.                                                    |
| `joint_attack` (**attack pledge**) | The proposer only                      | The proposer applies confirmed, above-threshold pressure to the named third player. The acceptor does not promise to attack. |
| `support_request`                  | The accepting recipient                | The recipient sends the requesting proposer at least the explicit gold or troop amount.                                      |

`joint_attack` is retained as the wire/template identifier for compatibility; **attack pledge**
is the accurate display wording because it is one-sided. An engine `alliance` and a structured
promise are also different: accepting a promise does not create an OpenFront alliance.

After the single spawn preference request resolves, ordinary decision requests
begin with every player already holding its assigned territory. Spawn
preferences are not requested again during the game.
