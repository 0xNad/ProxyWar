# Proxy War Coworld Global And Replay Protocol

This local POC exposes the route family Coworld certification expects:

- `GET /healthz`
- `GET /client/player?slot=...&token=...`
- `GET /client/global`
- `WEBSOCKET /global`
- `GET /client/replay`
- `WEBSOCKET /replay`

`/global` sends status snapshots while the episode runs. Snapshot messages include
the latest Proxy War spectator frame, public match config, and map dimensions so
`/client/global` can render live territory state without occupying a player slot.

`/replay` sends the saved replay payload:

```json
{
  "type": "replay",
  "schemaVersion": 1,
  "runID": "...",
  "results": {},
  "proxyWarArtifacts": {},
  "spectatorReplay": {
    "replayKind": "artifact-snapshot-replay",
    "map": {},
    "snapshots": []
  }
}
```

The browser clients are part of the Coworld surface, with only two browser
client shapes:

- `/client/global` and `/client/replay` use the same spectator viewer, with map
  drawing and frame playback. Global connects to `/global` for live frames;
  replay connects to `/replay` for saved frames.
- `/client/player` connects to `/player`, shows each decision request, and lets a
  human choose one offered `LegalAction.id`.

Public global/replay payloads omit per-slot connection tokens.
