# omp setup — ProxyWar (written 2026-07-21)

`omp` (oh-my-pi) is installed and fully configured for this repo. Claude is the
executor; ChatGPT is the advisor. **One step is left, and only you can do it: the
two OAuth logins.** Everything below the "What's left for you" line is already done.

## What's left for you — two logins

From this repo, run `omp`, then inside the TUI:

```
/login anthropic       # sign in with your Claude Pro/Max account → Claude = executor
/login openai-codex    # sign in with your ChatGPT Plus/Pro account → ChatGPT = advisor
```

Each opens a browser consent page. `omp` stores the refreshed OAuth token in its
own credential db and rotates it per call — no API key is pasted or kept in env.
Verify with `omp usage` (both accounts should list) or `omp models anthropic`
(the catalog is empty until auth resolves).

That's it. The advisor turns on automatically once `openai-codex` is authed —
`advisor.enabled` is already `true`.

## What you get

- **Claude executes every turn.** `default`/`slow` = `claude-opus-4-8`,
  subagents = `claude-sonnet-5`, cheap fan-out = `claude-haiku-4-5`.
- **ChatGPT watches and advises.** `gpt-5.5` holds the `advisor` role (reads each
  turn Claude takes, injects `<advisory>` notes: nit / concern / blocker) and the
  `plan` role (shapes plan mode before Claude writes).
- Advisor controls: `/advisor status`, `/advisor off`, `/advisor dump`.

## Model split — where to change it

Global config: `~/.omp/agent/config.yml` (`modelRoles` block). To flip a role:

```sh
omp config set modelRoles.default anthropic/claude-opus-4-8:high
omp config set modelRoles.advisor openai-codex/gpt-5.5:high
```

To put Claude back in charge of planning too:
`omp config set modelRoles.plan anthropic/claude-opus-4-8:high`.

Available ids: `omp models anthropic` and `omp models openai-codex` (after login).

## What was migrated from Claude Code

| Piece | How it carried over |
|---|---|
| Project brief (`CLAUDE.md`→`AGENTS.md`→`CLAUDE.local.md`) | `.omp/AGENTS.md` `@`-imports the chain. Native `.omp/` shadows the root `AGENTS.md` cleanly. |
| Hard invariants | `.omp/RULES.md` — always-apply sticky rules (survive long sessions). |
| Slash commands (`/catch-up`, `/readiness`, `/coworld-status`) | Read natively from `.claude/commands/` — **no porting needed.** |
| 12 subagents | **Ported** to `.omp/agents/` (byte-identical bodies). omp deliberately skips `.claude/agents/`, so these are copies — edit both or they drift. `reviewer` runs on `@slow`+high thinking. |
| Guard hooks (core-LLM + destructive/gated actions) | **Ported** to `.omp/hooks/pre/proxywar-guard.ts` (TS, fires in every approval mode, incl. `yolo`). Tested: 31/31 cases. Also covers `eval`/`ssh`, which the shell version couldn't. |
| Public-repo hygiene | `.omp/`, `WATCHDOG.md`, `WATCHDOG.yml` added to `.gitignore` — internal strategy stays local like `.claude/`. |

## Advisor tuning knobs (`~/.omp/agent/config.yml`)

- `advisor.syncBacklog: 1` — tightest review (primary waits up to 30s for the
  advisor to catch up each turn). Raise to `3`/`5` if turns feel slow; `off` for
  max throughput.
- `advisor.immuneTurns: 3` — after a delivered concern/blocker, later ones batch
  as non-interrupting asides for 3 turns.
- `advisor.subagents: false` — subagents don't each spawn their own advisor
  (would multiply cost by fan-out). Flip to `true` if you want it.
- `.omp/WATCHDOG.md` is the advisor's review brief (ProxyWar-specific things to
  watch). `.omp/WATCHDOG.yml` can add named advisors with their own models/tools.

## Not done (out of scope unless you want it)

- Login (yours — above).
- MCP servers: omp reads `.claude/` MCP config, but none is configured in this
  repo, so nothing carried. `/mcp` or `.omp/config.yml` if you want any.
- The `.claude/` setup is untouched — Claude Code still works exactly as before.
  This is additive.
