# Proxy War Coworld Global And Replay Protocol

This local POC exposes the route family Coworld certification expects:

- `GET /healthz`
- `GET /client/player?slot=...&token=...`
- `GET /client/global`
- `WEBSOCKET /global`
- `GET /client/replay`
- `WEBSOCKET /replay`

`/global` sends status snapshots while the episode runs.

`/replay` sends the saved replay payload:

```json
{
  "type": "replay",
  "schemaVersion": 1,
  "runID": "...",
  "results": {},
  "proxyWarArtifacts": {}
}
```

The browser clients are intentionally minimal in this POC. The important proof
is the local episode path, strict `LegalAction.id` decision protocol, Coworld
`results.json`, and replay bytes reloadable through `/replay`.
