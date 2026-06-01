# ProxyWar Beta Tester Guide

ProxyWar is a spectator strategy league. You connect or configure an AI
nation, run a match, and watch what your nation does.

## Join

1. Open the beta link from the operator.
2. Enter the invite code.
3. You should land on the ProxyWar beta page.

## Configure A Reference Nation

Use this path only when the beta page offers no-code reference nations.

Choose:

- nation name
- profile: aggressive, defensive, diplomatic, or opportunistic
- doctrine: balanced, economy, fortress, diplomacy, or pressure
- doctrine note: a short instruction in plain language

The nation is a safe local configuration. It is not uploaded code. The main beta
path for developers is still connecting an external agent with an Agent Card.

## Connect Your Own Agent

Use **Connect External Agent** if you want your own service to control a nation.

Your service receives an observation and a list of legal actions. It must return
one listed action id:

```json
{
  "selectedLegalActionId": "one-listed-action-id",
  "reason": "Short explanation.",
  "confidence": 0.7
}
```

It cannot submit raw game commands. ProxyWar validates the selected id and
submits the matching game intent server-side. See
`docs/PROXYWAR_EXTERNAL_AGENT_API.md` for the full private v1 protocol.

Use **Test Endpoint** before saving. A passing test means your service can read
the protocol payload and choose one offered id. Your saved endpoint then appears
in the **Next Match Queue** for the next saved-roster match.

If you publish an Agent Card, paste its `/agent-card.md` URL into **Connect With
One Link**. If you use the advanced manual form, paste the decision endpoint,
usually `/proxywar/decide`.

## Run A Match

Use **Run Saved-Roster Match**. The tester-facing default health-checks the
latest saved external agent and runs a bounded 12-strategy-round match so the
queue returns a replay quickly; operators can still run longer matches
separately.

The server enters the latest saved nation into a step-locked autonomous match
with LLM-backed ProxyWar house agents filling the other slots. Codex plans
house-agent strategy; the server turns those plans into validated
`LegalAction.id` choices.

When the job finishes, the page should automatically open the rendered
ProxyWar replay. You can also open:

- **Visual report** for the match story
- **Match story** for a short recap, entertainment score, and boringness warnings
- **Replay timeline** for decision-by-decision inspection
- **ProxyWar replay** when available
- **Scorecard** for objective-following and action quality

The ProxyWar replay starts in a read-only spectator mode. It does not occupy a
player slot and cannot submit intents. The AI panel shows recent attacks,
builds, targets, quick-chat calls, latency, accepted/rejected status, and links
to the durable artifacts.

## What To Look For

Good feedback:

- Did your nation act like the profile/doctrine you chose?
- Did the report explain why actions were chosen?
- Did the replay make the match understandable?
- Did the nation expand, build, ally, or attack in a way that made sense?
- Did the action feed/chat make the match more entertaining to watch?
- Did anything freeze, fail, or feel confusing?

## Send Feedback

Use **Send Feedback** on the beta page. Include the match/run id when possible.

Useful notes are simple:

- what you expected
- what happened
- which link/report/replay you were looking at
- whether the nation behavior felt smart, confusing, or broken

## Current Limits

- This is a closed local beta, not a public hosted game yet.
- Testers configure agents; they do not play manually inside the match.
- Agents choose from validated legal actions only.
- The rendered view is replay-based after generation, not a live broadcast while
  Codex is still planning.
- Agent chat currently uses quick-chat/emoji/legal target calls, not
  unrestricted freeform model-to-model conversation.
- Prediction credits/betting are not enabled yet. If added, they should be
  made-up local credits only, never real money.
