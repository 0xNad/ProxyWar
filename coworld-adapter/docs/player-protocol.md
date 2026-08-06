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
    "decisionSupport": {
      "spawnFreeform": {
        "available": true,
        "idFormat": "spawn:<tile>",
        "tileFormula": "tile = y * map.width + x",
        "reservedTiles": [841205, 1029871],
        "minDistanceFromReserved": 30
      }
    },
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

`selectedLegalActionId` must be one exact offered `legalActions[].id` - **with
one bounded exception**: during the spawn phase (`decisionSupport.spawnFreeform`
present), a player MAY reply with any well-formed `spawn:<tile>` id for a tile
it prefers, even when that exact id was not itself offered. `tile` is a
row-major integer (`tile = y * map.width + x`, using `request.match.map.width`/
`request.match.map.height`); every unspawned agent gets this decision
opportunity by default (not opt-in), resolved concurrently with every other
still-unspawned agent's decision that same spawn-phase tick, then committed
in fixed roster order - and it is a ONE-SHOT consultation: once an agent's
spawn choice is accepted it is never asked again for the rest of the phase.

Because decisions are computed concurrently against a snapshot, EVERY chosen
spawn tile - including one that came from the offered `legalActions` menu,
not only an off-menu `spawn:<tile>` id - is independently revalidated
server-side against the LATEST game state at the moment it actually commits,
never trusted from the snapshot: bounds/land/unowned/border/footprint/
min-distance against every already-spawned player, plus distance from every
other agent's current spawn reservation (`decisionSupport.spawnFreeform.
reservedTiles`) as of that exact commit, not as of when the request was
built. This is what makes two agents choosing the identical offered-or-off-
menu tile resolve deterministically: whichever agent commits first in roster
order keeps it, and every later agent's now-conflicting choice is rejected
with a specific reason (never a silent random substitution) and
deterministically falls back to the same algorithmic spawn placement every
agent already gets by default - an agent can never miss spawning because it
chose its own tile. Every non-spawn action kind is unaffected: the websocket
adapter returns an `AgentDecision`, but the existing `AgentDecisionValidator`,
`AgentRunner`, and `GameServer` remain the sole authority, and
`LegalAction.id` selection is still the only way to act - no raw core intent
is ever accepted from a player.
