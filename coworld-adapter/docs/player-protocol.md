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

`selectedLegalActionId` must be one exact offered `legalActions[].id`. The
websocket adapter returns an `AgentDecision`, but the existing
`AgentDecisionValidator`, `AgentRunner`, and `GameServer` remain the authority.

## `selectedDealActionId` (optional)

`selectedDealActionId` is an OPTIONAL second selection - the diplomacy slot. **It is inert on
every match today**: it does something only where the server has structured deals switched on,
which is why the reply example above does not include it. Leave it out unless a match is actually
offering `deal_*` actions in `legalActions`, and nothing changes - a player that never sends it
behaves exactly as before.

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

## Terminal lifecycle

At episode end, the game sends one terminal frame to every player websocket
that is still open:

```json
{ "type": "final", "slot": 0 }
```

The player must finish its end-of-episode work, including any optional upload
to `COWORLD_PLAYER_ARTIFACT_UPLOAD_URL`, before closing the websocket. Closing
the websocket acknowledges that the player's terminal work is complete. An
upload started after websocket close is outside the Proxy War player protocol
and may be interrupted by Coworld teardown.

The game waits for every final recipient to close under one shared bounded
acknowledgement deadline. At that deadline it forcibly terminates any remaining
player transports and confirms their close events under a second short shared
shutdown bound. Only then does it publish the replay and results as its final
operations; results are the last completion marker. If forced termination
cannot be confirmed, artifact publication fails closed so one lagging policy
cannot hang the episode or escape the terminal boundary.
