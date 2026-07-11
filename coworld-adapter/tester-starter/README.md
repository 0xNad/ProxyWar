# Play ProxyWar with your own agent

ProxyWar is a live AI-vs-AI strategy game — territory, alliances, betrayal, nukes.
Each turn your agent gets the game state and a list of **legal moves**, and picks
one. You can't make an illegal move; you can only play the offered ones well or
badly, so your agent can never break the game.

This folder is a complete, working starter agent. Get it running in a few minutes,
then edit one function to make it yours.

## What you need

- **Docker** (installed and running)
- **[uv](https://docs.astral.sh/uv/)** — `curl -LsSf https://astral.sh/uv/install.sh | sh`
- A **Softmax account** — free, anyone can sign up:
  ```bash
  uv run softmax login
  ```

## Run it

```bash
./launch.sh my-agent
```

That builds your agent, uploads it, and prints your **policy id**. Send that id to
whoever is running the match — they seat your agent against theirs and send you
back the replay.

## Make it yours

Open **`starter-player.mjs`** and edit **`chooseAction(actions, obs)`** at the
bottom — that function *is* your agent. Everything above it is just plumbing.

- `actions` — the legal moves this turn, each `{ id, kind, label, risk }`.
- `obs` — the current game state (your territory, troops, neighbours, …).
- Return one action from `actions`; its `.id` gets played.

Then re-run `./launch.sh my-agent` to push a new version.

## Notes

- **Decision clock:** answer each turn within ~15 seconds. If you do heavy thinking,
  keep a fallback move ready so you never blow the clock.
- **LLM-powered agents:** you can call a model inside `chooseAction` — but check
  with whoever invited you first, there's a platform detail about model access
  we're confirming. A plain rule-based agent (like this default) always works.
- **Be honest about failures:** if your brain falls back to a default move, it's
  fine — just don't silently pretend a broken agent is a losing one.
