# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

The shared engineering rules, repository model, autonomy policy, prioritization, and the
project-state reading list live in **AGENTS.md** — imported below so Claude loads the same
rules any coding agent does, and so the "read `docs/project-state/` first" preamble is
automatic. (AGENTS.md and CLAUDE.local.md are gitignored, so they load locally and are absent
from public clones.)

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

AGENTS.md (local) lists the agent/beta commands (`agent:demo-server`, `agent:closed-beta`,
`agent:public-readiness:strict`, `agent:external-agent:dry-run`, `agent:benchmark:external-full`, …).

## Architecture

OpenFront.io is a real-time multiplayer territorial strategy game. There are four components:

1. **`src/core/`** — Deterministic game simulation. Pure TypeScript with **no external dependencies**. Must remain fully deterministic (seeded PRNG, no floating-point math). Runs in a Web Worker thread. All `src/core` changes **must** include tests.
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
- **Audio:** Howler.js
- **Schemas/Validation:** Zod
- **Testing:** Vitest
- **Server:** Node.js, Express, ws (WebSocket)

## Claude Code

- Use **plan mode** for changes under `src/core/**` and the agent-protocol files: `AgentRunner.ts`, `AgentDecisionValidator.ts`, `LegalActionBuilder.ts`, `AgentObservationBuilder.ts`, `AgentPlannerExecutor.ts`. (A PreToolUse hook also blocks LLM/provider imports into `src/core`.)
- `src/core` is deterministic **simulation**. The rule is **no LLM/Codex/OpenAI/provider logic in core** — config/map loading over `fetch` (`DefaultConfig.ts`, the map loaders) is the existing, allowed exception, not a violation.
- Specialist role **subagents** live in `.claude/agents/` (invoked on demand, not as live threads). The **reviewer** subagent checks this project's invariants before risky changes; ask for it on edits to `AgentPlannerExecutor.ts` or `AgentDemoHub.ts`.
- **Git guardrails:** never force-push, delete branches, or rewrite history. Land changes on a branch off `main` using the `claude/` prefix; commit/push and any deploy/publish are gated outward actions — do them only when the operator asked in-conversation.

<!-- Local-only operating guide (working model, autonomy, internal workspaces). Gitignored; absent from public clones. -->
@CLAUDE.local.md
