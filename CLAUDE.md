# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

This tracked file is the baseline engineering and contribution guidance for
every checkout. `AGENTS.md` and `CLAUDE.local.md` are gitignored local overlays;
they are intentionally absent from independent public clones and forks.

## Checkout context

### Independent public clone or fork

Missing local overlays are expected and **do not** make the checkout read-only.
Coding-agent-assisted contributions are welcome. Work on a feature branch or
fork, follow `CONTRIBUTING.md`, run the relevant checks, and open a pull request.
Local edits, tests, and commits do not require the private instruction bundle.
Pushing a branch or opening a pull request still requires the authorization of
the person operating the coding agent.

### Operator-managed checkout or linked worktree

When the task environment identifies an operator-managed primary checkout or
provides lifecycle metadata for a managed worktree, its local instruction
bundle is required. Resolve the primary checkout from
`git rev-parse --path-format=absolute --git-common-dir` (the parent of its
terminal `.git` directory), then read its `AGENTS.md`, `CLAUDE.local.md`,
`docs/project-state/STANDING-POSITION.md`, and
`docs/project-state/context-for-new-codex-threads.md` explicitly.

Do not assume the relative imports below succeeded. If an operator-managed
checkout is expected to have that bundle and it cannot be found, keep only that
managed checkout read-only and report the bootstrap gap. Do not apply this
fail-closed rule to an independent public clone or fork.

<!--
Absent by design in independent public clones. Required in an identified
operator-managed checkout; if missing there, that managed checkout stays read-only.
-->
@AGENTS.md

## Commands

```bash
npm run inst             # Install deps (npm ci --ignore-scripts — do NOT use npm install)
npm run dev              # Run client + server in dev mode with hot reload
npm run start:client     # Client only
npm run start:server-dev # Server only
npm test                 # Run all tests (vitest run && vitest run tests/server)
npm run test:coverage    # Tests with coverage
npm run lint             # ESLint
npm run lint:fix         # ESLint with auto-fix
npm run format           # Prettier
npm exec -- tsc --noEmit # Typecheck
npm run build-prod       # Production build
```

**Run a single test file:**

```bash
npx vitest tests/YourTest.test.ts --run
npx vitest NationAllianceBehavior --run # match by name pattern
```

When present, local `AGENTS.md` lists additional operator commands and identifies
historical or maintenance-only workflows.

## Architecture

OpenFront.io is a real-time multiplayer territorial strategy game. There are four components:

1. **`src/core/`** — Deterministic game simulation. It has selected dependencies, but no provider calls or simulation networking may be introduced. It must remain deterministic (seeded PRNG, no floating-point simulation math). Runs in a Web Worker thread. All `src/core` changes **must** include tests.
2. **`src/client/`** — Rendering (Pixi.js/WebGL), UI (Lit web components + Tailwind CSS 4), WebSocket communication.
3. **`src/server/`** — Game coordination, intent relay, WebSocket management (Node.js/Express/ws).
4. **API** — Closed-source Cloudflare Worker handling auth, stats, cosmetics, monetization. Not in this repo.

### Simulation Flow (Intent → Execution)

The game simulation runs **on each client**, not the server. The server only relays intents.

1. Player action → client creates an **Intent** → sent to server
2. Server bundles all intents for the tick into a **Turn** → relays to all clients
3. Client forwards Turn to the Core worker
4. Core creates an **Execution** for each intent
5. Core calls `executeNextTick()` — all executions run and mutate game state
6. Core sends **GameUpdates** back to client → client renders

Intents and all wire messages are Zod-validated schemas defined in `src/core/Schemas.ts`.

### CDN / Static Assets

The game server only serves `index.html` and the WebSocket. All other assets (JS bundle, images, maps, worker) come from a CDN bucket. `CDN_BASE` is an empty string in dev (falls back to same-origin) and a full origin (e.g. `https://cdn.example.com`) in production. It is set as both a Vite build-time variable and a server runtime env var.

## Key Files

| File                        | Purpose                                |
| --------------------------- | -------------------------------------- |
| `src/core/Schemas.ts`       | All intent/message types (Zod schemas) |
| `src/core/GameRunner.ts`    | Simulation orchestrator                |
| `src/core/game/GameImpl.ts` | Game state implementation              |
| `src/server/GameServer.ts`  | Main WebSocket server, game loop       |
| `src/server/Master.ts`      | Lobby and game registry                |
| `tests/util/Setup.ts`       | Test helper — creates test games       |
| `docs/Architecture.md`      | Architecture overview                  |
| `docs/Auth.md`              | JWT/auth flow                          |
| `docs/API.md`               | Public API endpoints                   |
| `vite.config.ts`            | Build config, CDN handling             |

## UI Text / i18n

All user-visible text must go through `translateText()` and have a corresponding entry added to `resources/lang/en.json`. Translations are managed via Crowdin. DO NOT modify any other translation files.

## Testing Patterns

Tests use a `setup()` helper from `tests/util/Setup.ts` that creates a full game instance with map data from `tests/testdata/maps/`. Write tests that exercise the core simulation directly — not mocks.

## Tech Stack

- **Bundler:** Vite + TypeScript 5.7
- **Rendering:** Pixi.js (WebGL)
- **UI Components:** Lit (LitElement) + Tailwind CSS 4
- **Schemas/Validation:** Zod
- **Testing:** Vitest
- **Server:** Node.js, Express, ws (WebSocket)

## Claude Code

- Use **plan mode** for changes under `src/core/**` and the agent-protocol files: `AgentRunner.ts`, `AgentDecisionValidator.ts`, `LegalActionBuilder.ts`, `AgentObservationBuilder.ts`, `AgentPlannerExecutor.ts`. Operator-managed checkouts may also provide a PreToolUse hook that blocks LLM/provider imports into `src/core`; independent public clones must enforce this rule through review and tests.
- `src/core` is deterministic **simulation**. The rule is **no LLM/Codex/OpenAI/provider logic in core** — config/map loading over `fetch` (`DefaultConfig.ts`, the map loaders) is the existing, allowed exception, not a violation.
- Operator-managed checkouts may provide specialist role **subagents** under `.claude/agents/`. Independent public clones must not assume those local helpers exist. Changes to `AgentPlannerExecutor.ts` or `AgentDemoHub.ts` require an independent review recorded in the pull request.
- **Git guardrails:** never force-push, delete branches, or rewrite history.
  Public contributors should use a feature branch or fork and may open a pull
  request with the authorization of the person operating the coding agent.
  Operator-managed checkouts may impose a branch prefix and additional gates in
  their local overlays. Deploys and package publication always require explicit
  repository-owner authorization.

<!--
Absent by design in independent public clones. Required in an identified
operator-managed checkout; if missing there, that managed checkout stays read-only.
-->
@CLAUDE.local.md
