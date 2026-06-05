# Proxy War Closed Beta Readiness

Proxy War can now run as a local invite-gated friends-and-family demo. This
is still a private beta flow: it is suitable for a trusted local network or a
temporary tunnel, not a fully hosted public launch.

## Launch Command

```bash
PROXYWAR_BETA_CODE="your-private-code" npm run agent:closed-beta
```

There is no built-in default invite code. If `PROXYWAR_BETA_CODE` is
missing, the beta login page shows an operator setup warning instead of letting
testers in.

Open:

```text
http://127.0.0.1:8787/public
```

The server redirects unauthenticated visitors to `/beta`. The invite code is not
printed in server logs.

## Remote Friends Access

For trusted remote testers, use:

```bash
PROXYWAR_BETA_CODE="your-private-code" npm run agent:closed-beta:remote
```

The remote helper starts the local beta server and, when `cloudflared` is
installed, opens a temporary tunnel. It refuses missing invite codes.

For same-Wi-Fi testers:

```bash
PROXYWAR_BETA_CODE="your-private-code" npm run agent:closed-beta:lan
```

See `docs/REMOTE_FRIENDS_BETA.md` for tunnel options and limitations.

Before sharing any remote URL, run the public readiness gate:

```bash
PROXYWAR_PUBLIC_URL="https://your-beta-url.example" PROXYWAR_BETA_CODE="your-private-code" npm run agent:public-readiness:strict
```

The public readiness gate live-health-checks saved external agents; stale
temporary tunnels must be deleted or re-imported before sharing.

To inspect saved external agents without changing files:

```bash
npm run agent:saved-agents:health
```

To move failed saved manifests out of the active roster:

```bash
npm run agent:saved-agents:health -- --archive-failed
```

For the remote helper itself, the dry check is:

```bash
PROXYWAR_PUBLIC_URL="https://your-beta-url.example" PROXYWAR_BETA_CODE="your-private-code" npm run agent:closed-beta:remote -- --check --provider=none
```

## What Testers Can Do

- Create safe manifest-only AI nations.
- Run a Codex-planned saved-nations Proxy War match.
- Watch the latest match through visual reports and replay links.
- Submit lightweight feedback from the beta page.

Tester-created nations are configs only. Testers cannot upload code or submit
raw game intents.

## Local Artifact Paths

Saved nations:

```text
artifacts/proxywar/nations/
```

Feedback:

```text
artifacts/proxywar/beta-feedback/feedback.jsonl
```

Match artifacts:

```text
artifacts/ai-league-runs/<run-id>/
```

## Safety Model

The closed beta gate is a simple local invite-code gate:

- enabled only when `PROXYWAR_BETA_ENABLED=true`
- signed HTTP-only session cookie
- invite code validated server-side
- raw debug artifacts remain behind the same local gate
- no API keys are required for mock/planner demos

This is not a production identity system. Before a broad public launch, add
proper hosted auth, rate limits, user accounts, persistent storage, moderation,
and a public/private artifact split.

## Operator Checklist

1. Set a private invite code.
2. Start `npm run agent:closed-beta`.
3. Open `/public` and sign in through `/beta`.
4. Create one test nation.
5. Run a Codex strategy match.
6. Open `visual-report.html` and `spectator.html`.
7. Submit beta feedback.
8. Review `feedback.jsonl` and latest match artifacts.
9. Run `npm run agent:public-readiness:strict` before sharing a remote URL.

## Current Beta Limitations

- Local server only; no cloud deployment is configured.
- In-memory job queue; jobs reset when the process restarts.
- Raw artifacts are still local files rather than hosted durable storage.
- Invite code is shared, not per-user.
- Feedback is local JSONL, not an inbox or issue tracker.
- Public tunnels should be used carefully because artifact reports may include
  raw model prompts/responses for debugging.
- `npm run agent:public-readiness:strict` is the final share/no-share gate for
  a remote beta link.
