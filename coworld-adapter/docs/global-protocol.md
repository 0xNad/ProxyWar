# Proxy War Coworld Global And Replay Protocol

This local POC exposes the route family Coworld certification expects:

- `GET /healthz`
- `GET /client/player?slot=...&token=...`
- `GET /client/global`
- `WEBSOCKET /global`
- `GET /client/replay`
- `WEBSOCKET /replay`

`/global` sends status snapshots while the episode runs. Snapshot messages include
the latest Proxy War spectator frame, public match config, and map dimensions for
machine consumers.

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

The browser clients are part of the Coworld surface and share the same native
Proxy War app shell:

- `/client/global` and `/client/replay` serve the native Proxy War replay view.
  The client waits for Coworld replay artifacts, then loads the existing
  `game-record.json` replay path through `/ai-league-runs/<runID>/...`.
- `/client/player` serves that same native view and adds a Coworld player
  sidebar. The sidebar connects to `/player`, shows the current legal action
  menu, and lets a human choose one offered `LegalAction.id`.

Public global/replay payloads omit per-slot connection tokens.
