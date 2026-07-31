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
