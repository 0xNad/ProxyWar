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
      "selectedLegalActionIds": "optional ordered array of 1-5 offered legalActions[].id values; first must equal selectedLegalActionId",
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
  "reason": "No better legal action was available.",
  "confidence": 0.5
}
```

`selectedLegalActionId` must be one exact offered `legalActions[].id` - no exceptions and no
off-menu ids, for every action kind: the websocket adapter returns an `AgentDecision`, but the
existing `AgentDecisionValidator`, `AgentRunner`, and `GameServer` remain the sole authority, and
`LegalAction.id` selection is still the only way to act - no raw core intent is ever accepted
from a player.

## `selectedLegalActionIds` (optional)

`selectedLegalActionIds` carries an ordered batch of up to five compatible actions selected from
the same offered menu. The legacy scalar remains required and authoritative: the first array item
must equal `selectedLegalActionId`. A player that omits the array retains the original one-action
behavior.

```json
{
  "type": "decision_response",
  "requestID": "req_...",
  "selectedLegalActionId": "attack:rival:35",
  "selectedLegalActionIds": [
    "attack:rival:35",
    "build:City:100",
    "upgrade:City:100"
  ],
  "reason": "Pressure the rival while investing accumulated gold.",
  "confidence": 0.7
}
```

Every array item must exactly match an offered `legalActions[].id`; each item is independently
validated through the same `AgentDecisionValidator → AgentRunner → GameServer` path as the scalar
selection. Duplicate ids are removed, batches are capped at five, and malformed arrays safely
degrade to the scalar primary. Off-menu ids are rejected and recorded rather than converted into
raw intents.

Multi-player batches resolve in fair layers: all players' first actions in roster order, then all
players' second actions, and so on. Same-turn construction and diplomacy conflict reservations are
rechecked at every layer. All actions in a batch are chosen from one observation; policies should
therefore batch only actions that remain sensible together and rely on later decision steps for
state-dependent follow-ups.

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
  slot is rejected outright (the action batch stands). An action batch may likewise contain at
  most one `deal_*` action - so send a deal in one place, not several.
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

Spawn is never a player/brain decision and there is no spawn `decision_request` at all: before
any player is asked anything, the league runner deterministically assigns every roster
participant a quality-floored, well-spaced spawn tile
(`AgentSpawnAssignment.assignSpawnSlots` on the ProxyWar side) and submits it directly. A
player's first `decision_request` always arrives after it already has territory.
