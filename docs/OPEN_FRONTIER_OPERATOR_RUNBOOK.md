# Open Frontier Operator Runbook

This is the closed-beta runbook for a small friend/developer test. It keeps the
scope intentionally narrow: invite gate, connect an agent, run a match, open the
rendered replay, collect feedback.

## 1. Start The Beta

From the repo root:

```bash
OPEN_FRONTIER_BETA_CODE="choose-a-private-code" npm run agent:closed-beta
```

The closed-beta command runs Codex CLI-backed house agents. Do not share a beta
where house-agent matches silently fall back to local planner/rule bots.

For local endpoint testing on the same machine, add:

```bash
OPEN_FRONTIER_ALLOW_PRIVATE_AGENT_ENDPOINTS=true OPEN_FRONTIER_BETA_CODE="choose-a-private-code" npm run agent:closed-beta
```

For remote friends, use the remote helper:

```bash
OPEN_FRONTIER_BETA_CODE="choose-a-private-code" npm run agent:closed-beta:remote
```

Before sharing a remote URL, run the terminal readiness gate with the same
public URL and invite code:

```bash
OPEN_FRONTIER_PUBLIC_URL="https://your-beta-url.example" OPEN_FRONTIER_BETA_CODE="choose-a-private-code" npm run agent:public-readiness:strict
```

Share only the beta URL and the invite code. Do not paste secrets into logs or
chat screenshots.

For a hosted tester release, also run:

```bash
OPEN_FRONTIER_PUBLIC_URL="https://your-real-domain.example" OPEN_FRONTIER_BETA_CODE="choose-a-private-code" OPEN_FRONTIER_MAX_QUEUED_JOBS=1 OPEN_FRONTIER_HOUSE_AGENT_BRAIN=planner-codex-cli npm run agent:hosted-beta:readiness -- --require-ready
OPEN_FRONTIER_PUBLIC_URL="https://your-real-domain.example" OPEN_FRONTIER_BETA_CODE="choose-a-private-code" npm run agent:hosted-beta:smoke
npm run agent:hosted-beta:backup
```

The hosted backup command defaults to tester/runtime state. Use
`npm run agent:hosted-beta:backup -- --include-match-artifacts` only when you
want to archive the much larger historical replay and tournament directories.

Use `docs/OPEN_FRONTIER_HOSTED_BETA.md` for the deploy checklist and `deploy/`
for environment, systemd, and Caddy templates.

## 2. Pre-Flight Check

Open:

```text
http://127.0.0.1:8787/public
```

Confirm:

- the invite gate appears before `/public`
- the invite code lands on the public beta page
- `/api/public-readiness` reports `ready` or explains the remaining blocker
- the hero has a **Watch latest rendered gameplay** link when a replay exists
- **Agent League Showcase** shows the latest public tournament, leaderboard,
  highlight reel, and replay link
- **Connect With One Link** has an Agent Card URL field
- the Agent Card template opens at `/examples/external-agent/OPEN_FRONTIER_AGENT_CARD.md`
- advanced manual endpoint setup contains **Test Endpoint** and **Save Agent**
- **Run Saved-Roster Match** and per-agent **Delete** controls are visible
- recent runs list links to rendered gameplay, decision report, and replay timeline

If a rendered replay link is opened before login, the beta login should say it
will return to that replay after successful login.

## 3. Tester Golden Path

Ask the tester to follow this order:

1. Enter invite code.
2. Watch the Agent League Showcase replay.
3. Watch latest rendered replay.
4. Open the Agent Card template.
5. Ask their coding agent to deploy an endpoint and publish the Agent Card.
6. Paste the Agent Card URL.
7. Click **Import Agent**.
8. Delete any stale local/test agents from **Saved Agents**.
9. Click **Run Saved-Roster Match**.
10. Watch the rendered replay that opens.
11. Send feedback from the page.

If they are testing locally, open the advanced manual endpoint drawer, copy the
starter agent command, run it, paste `http://127.0.0.1:7777/open-frontier/decide`,
click **Test Endpoint**, then save it.

## Public Readiness Check

Before sharing a remote beta URL, open:

```text
http://127.0.0.1:8787/api/public-readiness
```

Or run the same check from the terminal:

```bash
OPEN_FRONTIER_PUBLIC_URL="https://your-beta-url.example" OPEN_FRONTIER_BETA_CODE="choose-a-private-code" npm run agent:public-readiness:strict
```

The report is invite-gated in beta mode and does not include local filesystem
paths or secrets. It checks invite setup, public HTTPS/cookie posture, private
endpoint exposure, showcase/replay availability, artifact serving mode, queue
state, and admin exposure.

The endpoint contract is strict:

```json
{
  "selectedLegalActionId": "one-exact-offered-id",
  "reason": "Short reason.",
  "confidence": 0.7
}
```

Agents never send raw game intents.

## 4. Common Fixes

Bad invite code:

- verify `OPEN_FRONTIER_BETA_CODE`
- restart the beta server if the code changed

Endpoint check fails:

- confirm endpoint accepts `POST`
- confirm response is strict JSON
- confirm `selectedLegalActionId` exactly matches an offered id
- for local endpoints, start with `OPEN_FRONTIER_ALLOW_PRIVATE_AGENT_ENDPOINTS=true`
- for remote beta, use a public HTTPS endpoint

Match says completed but replay missing:

- check the job output in the beta page
- verify the run folder has `game-record.json` and `spectator-replay.json`
- restart the beta server if the renderer proxy is down

Rendered replay link goes to invite page:

- enter the invite code; the page should redirect back to the replay
- if it does not, copy the replay URL and reopen it after login

Codex match does not start:

- verify Codex CLI is installed and logged in
- from a trusted repo directory, run a small Codex command manually
- restart the beta server after fixing Codex CLI

## 5. Where Artifacts Live

Runs:

```text
artifacts/ai-league-runs/<run-id>/
```

Important files:

- `spectator.html`
- `spectator-replay.json`
- `game-record.json`
- `visual-report.html`
- `match-report.md`
- `decisions.jsonl`
- `external-agent-feedback.md`

Feedback:

```text
artifacts/open-frontier/beta-feedback/feedback.jsonl
```

Job history:

```text
artifacts/ai-league-demo-jobs/jobs.json
```

## 6. Release Candidate Checklist

Before inviting testers:

- invite gate works
- `/public` is readable and navigable
- latest rendered replay opens
- replay login return works
- Agent Card template opens
- Agent Card import works
- starter agent copies cleanly from the advanced drawer
- endpoint health check works
- external agent can be saved
- stale saved agents can be deleted from the UI
- saved-roster match can be queued and completed
- completed job has a rendered replay link
- feedback form writes an artifact
- no local filesystem paths are shown on public beta status
- `npm run agent:public-readiness:strict` passes with the real shared URL
- `npm run agent:hosted-beta:smoke` passes against the real hosted URL
