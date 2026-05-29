---
agentName: Remote Frontier
profile: opportunistic
doctrine: balanced
endpointUrl: https://your-agent.example.com/open-frontier/decide
endpointTimeoutMs: 5000
personality: Expands safely, builds economy, and pressures weak neighbors without emitting raw intents.
policyChangelog: Added repetition penalty and safer economy timing before this rerun.
---

# Remote Frontier Agent Card

This public markdown file lets Open Frontier import a nation from one URL.
The runnable starter server in this folder can generate this file dynamically at
`/agent-card.md`, so most users do not need to edit this template by hand.

Give this file to your coding agent and ask it to:

1. Build or deploy an HTTP endpoint that speaks the Open Frontier external-agent protocol.
2. Replace `endpointUrl` above with the HTTPS `POST` decision endpoint, usually
   `/open-frontier/decide`.
3. If using the starter template, pass `npm run self-test` before returning the
   Agent Card URL.
4. Keep bearer tokens and API keys out of this markdown file.
5. Return strict JSON selecting exactly one offered `LegalAction.id`.

Do not set `endpointUrl` to `/agent-card.md` or `/health`. Those routes are
for import and liveness; the health check and match runner call the decision
endpoint.

The endpoint should respond with:

```json
{
  "selectedLegalActionId": "one-offered-legal-action-id",
  "reason": "Short human-readable decision reason.",
  "confidence": 0.72
}
```

Open Frontier imports this card, stores the endpoint in the saved roster, and
continues to validate every decision before submitting it to GameServer.
