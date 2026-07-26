All anchors confirmed. The line numbers in the findings match the live file (1904 lines), the win-modal banner is real (`coworld-adapter/src/coworld-appshell.ts`, element id `proxywar-coworld-winner-banner`), and the `ai-league-replay-frame` event is dispatched at the overlay (line 379, 1537) and built in `ClientGameRunner.ts`. Here is the brief.

---

# Proxy War Replay Spectator Panel — UX Overhaul Brief

**Target:** `src/client/AiLeagueReplayOverlay.ts` (1904 lines, replay-only overlay; native OpenFront client renders underneath)
**Date:** 2026-06-25
**Status:** Decision-ready. Implement directly.

All edits are **replay-route-only** (mounted from `openAiLeagueReplay`, guarded by `window.__PROXYWAR_AI_REPLAY__` / `isAiLeagueReplayRoute()`). Nothing here touches `src/core`, agents, or live-play layers. The **no-socket invariant** (commit `02d31ca97`) must be preserved: do not add any fetch/socket. The win banner already lives in `coworld-adapter/src/coworld-appshell.ts` — do not duplicate it.

---

## (A) PANEL INVENTORY — current elements + footprint

Default panel: top-right, `min(420px, 100vw-32px)` wide, up to `100vh-32px` tall, `z-index 50000`. Native-spectator-UI variant flips to bottom-left, capped `min(58vh, 520px)`.

| # | Element | File:Line | Footprint | Verdict |
|---|---------|-----------|-----------|---------|
| Header | Title "Proxy War Replay" + runID + Reset/Panel buttons | 502–523, 1069–1078 | ~40px | Keep, slim |
| 1 | **Metrics grid** (Decisions, Non-hold, Rejected, Fallbacks) | 550–565, 1080–1085 | ~60px / 4 cols | **SPACE HOG — gut to 3 cells** |
| 2 | Match setup (agents vs opponents, config) | 629–633, 1086–1089 | ~45px | Compress to 1 line |
| 3 | **Match story** (score/grade/summary/highlights/warnings) | 635–648, 1090–1106, 464, 1745–1751 | ~80px | **DELETE (Fix 4)** |
| 4 | Opening neutral land | 1107–1114, 1145–1164 | ~45px | **CUT** (builder stat) |
| 5 | **Replay speed slider** | 570–595, 1115–1127, 181–193 | ~90px | **DELETE — duplicate (Fix 1)** |
| 6 | **Politics board** (N×N trust/distrust/heat matrix) | 649–712, 1234–1247 | **~140px, LARGEST fixed section** | **SPACE HOG — replace (Fix 2/3)** |
| 7 | Diplomacy feed (comm threads, 8 max) | 713–745, 1274–1327 | ~100px (2nd largest) | Keep, demote behind toggle |
| 8 | Recent action feed | 596–627, 1329–1350 | ~80px | Collapse to top-3 playstyle line |
| 9 | Action counts summary | 759–785, 1131 | ~25px | Merge into #8 |
| 10 | **Decision log** (ALL decisions) | 746–788, 1362–1388 | **UNBOUNDED scroll** | **SPACE HOG — cap + strip debug fields** |
| 11 | Footer links | 790–794, 1133–1139 | ~30px | Keep |
| 12 | Disclaimer | 1132 | ~20px | Keep, one line |
| — | Resize handle | 536–545, 1142 | corner | Keep |

**Full-screen secondary overlays (outside the panel):**
| Element | File:Line | Verdict |
|---------|-----------|---------|
| Replay banner (top-center) | 833–852 | Keep |
| Social map bubbles (above agents) | 853–916, 1499–1577 | Keep |
| Social transcript "Political radio" (bottom-left) | 917–976, 1661–1673 | Keep, but de-conflict with story timeline removal |
| **Story timeline (bottom-center nav)** | 984–1029, 387–411, 147, 169 | **DELETE (Fix 4)** |

**The four genuine space hogs: the 4-cell metrics grid (#1), the politics matrix (#6), the unbounded decision log (#10), and — on the main screen — the bottom story timeline.**

---

## (B) PRIOR WORK — what the recent agent built and why (don't undo intent blindly)

The overlay evolved deliberately across June 2026 from a decision-log viewer into a "watchable narrative interface." Preserve the **load-bearing** intent below; the operator's fix list deliberately reverses two of these bets (story, panel-side speed).

- **v1 declutter (commit `998ca0c90`, June 6):** replay-scoped CSS (`body.ai-league-replay-mode`) hides player-only chrome. **Keep — this is the foundation; we extend the hidden-list, never remove it.**
- **v2 narrative (`7ec7a2b76`, June 6):** match-story beats (FW3), **live standings** (FW4, driven by per-frame `ai-league-replay-frame`), self-explaining decision cards (FW5), honesty-tagged synthetic narration (SR4). **Live standings + decision cards = keep and elevate. Match-story beats = the operator is killing (Fix 4) — this is an explicit reversal, intentional, not an accident.**
- **Honesty markers (`d9ff9c434`, June 14):** `llmPlannerDegraded` / `validationFallbackUsed` surfaced in decision cards. **Keep — degradation honesty is a P2 reliability invariant per roadmap; do not let the metrics simplification erase the fallback signal.**
- **Coworld result card (`582809fb4`) + winner banner (`coworld-appshell.ts`):** static result replaces ad win-screen. **The win banner is already done in the appshell — the overlay must NOT add its own.**
- **No-socket restoration (`02d31ca97`, June 20):** drama-report fetch removed to keep the read-only invariant. **Hard constraint — nothing added here may fetch or open a socket.**

**Net:** the agent's intent was "externalize agent intent + standings honestly, no spoilers, read-only." Fix list keeps that spine and removes the two pieces that proved hollow (algorithmic story) or redundant (panel speed slider). The pending `watchability-polish-spec.md` (fit-to-map camera, further native-UI hiding) is **complementary** and should land alongside, not be undone.

---

## (C) FIX LIST — the operator's explicit asks

### Fix 1 — De-duplicate the game-speed slider (and audit other native/overlay dupes)

**The duplicate:** the overlay renders its own speed slider (panel) while the native `ReplayPanel` renders ×0.5/×1/×2/Max buttons (top-right). Two speed controls on screen.

**Keep:** native `src/client/graphics/layers/ReplayPanel.ts:20–112` (top-right buttons — standard HUD corner, part of OpenFront client, already emits `ReplaySpeedChangeEvent`).
**Remove from the overlay:**
- HTML section `AiLeagueReplayOverlay.ts:1115–1127`
- Event binding `181–193`
- CSS `570–595` (`.ai-league-speed`, `-row`, `input`, `-labels`)
- Mobile CSS override referencing speed if present in `1057+`

**Callback handling:** keep the `onReplaySpeedChange` param (lines 132/141) in the type signature for external integration, but it is no longer wired to a panel input. The native panel already drives speed via `ReplaySpeedChangeEvent`; the overlay should not re-emit. If `onReplaySpeedChange` has no remaining caller after removal, leave the optional field in place (harmless) and drop only the now-dead listener at 181–193.

**Other dupes audited:** no other direct control duplication. Pause/play, fullscreen, settings, timer live only in the native `GameRightSidebar` — correct, leave them. One adjacent cleanup: `AiLeagueReplayOverlay.ts:814` hides native `<attacks-display>`; **remove that one hide rule** so incoming-attack arrows stay visible to spectators (aggression is watchable; the native attack display is not player-scoped). Verify `<events-display>` doesn't already cover it before deleting — if it does, leave hidden.

### Fix 2 — Drastically simplify + COMPACT the metrics panel

**Current 4-cell grid is jargon (`Decisions`, `Non-hold`, `Rejected`, `Fallbacks`) and a space hog. Replace with a 3-cell compact strip.**

**Minimal metric set (3 cells, replacing `1080–1085`):**
1. **Moves** — `input.decisions.length` (rename label "Decisions" → "Moves")
2. **Invalid** — rejected count (`decision.result.accepted === false`) — rename "Rejected" → "Invalid"
3. **Recovered** — fallback count (`decision.fallbackUsed === true`) — rename "Fallbacks" → "Recovered". **Must stay** to preserve the `llmPlannerDegraded` honesty signal from `d9ff9c434`. If any fallback occurred, color this cell amber (`.warn`, styles already at 759–785).

**Cut entirely:** "Non-hold" (builder debug), "Opening neutral land" section (1107–1114), per-decision latency, intent-type, audit-status, sequence-number from decision cards (1362–1388 — keep only seq#→turn, action badge, accept/reject, social text, reason).

**Compact layout:** change `.ai-league-metrics` (550–552) from `grid-template-columns: repeat(4,1fr)` to `repeat(3,1fr)`; reduce metric card padding `8px`→`6px` (556–565); value font `16px`→`14px`. Collapse the match-setup config line (1088–1089) from four clauses to one: `"{N} agents · {map} · {difficulty} · {turns}-turn"`. Net: metrics+setup drop from ~105px to ~55px.

### Fix 3 — ADD an at-a-glance alliances + trade-restrictions view

**This replaces the politics matrix (#6), not adds to it.** The trust/distrust/heat numbers are internal sim variables with no game-visible scale — cut them. Show **real, engine-authoritative** alliance and embargo state instead.

**Data source (from data-availability finding — this is NOT currently in the frame event and must be plumbed):**
Extend the `ai-league-replay-frame` payload in `src/client/ClientGameRunner.ts:599–630` (the `dispatchAiLeagueReplayFrame` map at ~606–620). Per alive+spawned player add:
- `allies: number[]` — from `player.allies().map(p => p.smallID())`
- `embargoes: string[]` — `Array.from(player.data.embargoes)` (PlayerIDs this player embargoes; `GameUpdates.ts:181`)
- `alliances: {other: PlayerID, expiresAt: Tick, hasExtensionRequest: boolean}[]` — from `player.alliances()` (`GameUpdates.ts:189`, `AllianceView` 196–202)

Then extend the overlay's `AiLeagueReplayFrameEventDetail` interface (`AiLeagueReplayOverlay.ts:33–45`) with the same three fields. This is read-only state already in `GameView` — **no socket, invariant safe.**

**Visualization (concrete) — a compact "Diplomacy" strip replacing the matrix at 1234–1247:**
Per-player **diplomacy chip row**, ranked by `tilesOwned` (live, from the frame event). Each row:
```
●Crimson  41%  ▸ ●Azure(ally)  ●Jade(war)  ⊘Slate(embargo)
```
- Player dot uses the on-map color (already available per-frame).
- One **dominant strength number**: territory share % (compute `tilesOwned / totalTiles`), tabular figures.
- **Stance glyphs** toward each rival: green dot = ally (in `allies`), red dot = at war / attacking, `⊘` = embargo (in either player's `embargoes`, bidirectional). Encode **type by glyph/treatment, never a new hue** (hues are spent on player identity).
- Alliance rows with `hasExtensionRequest` get a small "↻" suffix; near-expiry (`expiresAt - currentTick < threshold`) dims the ally dot.

This updates live as frames arrive (reuse the existing `ai-league-replay-frame` listener at 1537), giving the Tier-0 "who's-allied / who's-embargoing" glance the best-practices finding demands at 4-player FFA scale. **Drop the N×N matrix entirely** for the default 4p case (matrices only pay off at ≥5 players). Keep the existing **diplomacy feed / comm threads (713–745, 1274–1327)** but behind a collapsible "Show talks" toggle, not always-expanded.

### Fix 4 — REMOVE the meaningless story (panel + main screen)

The algorithmic match story produces hollow generic headlines. Delete both surfaces.

**Panel match-story card — delete:**
- `464` — `const matchStory = input.summary?.matchStory ?? null;`
- `1090–1106` — the entire `${matchStory ? \`<section class="ai-league-story">…\` : ""}` block
- `635–648` — `.ai-league-story`, `.ai-league-story ul`, `.ai-league-story li` CSS
- `1745–1751` — the `matchStory?: {…}` field on the summary interface

**Main-screen story timeline — delete:**
- `147` — `document.getElementById("ai-league-story-timeline")?.remove();`
- `169` — `mountAiLeagueStoryTimeline(spectatorTelemetry);`
- `387–411` — entire `function mountAiLeagueStoryTimeline(...)`
- `984–1029` — `#ai-league-story-timeline` + `.ai-league-timeline-title` + `.ai-league-timeline-marker` CSS
- `1063–1066` — mobile reposition of `#ai-league-story-timeline`

**Do NOT touch:** `coworld-adapter/src/no-docker-coworld-episode.ts:44` still writes `match-story.md` as an archival artifact — leave it (not rendered in UI). The server-side `AgentMatchStory.ts` generator stays (artifact-only). The bottom-left **social transcript "Political radio"** (917–976) is a *different* element — keep it; only the story timeline goes.

---

## (D) ADDITIONAL IMPROVEMENTS — prioritized (grounded in best-practices finding)

**P0 — Always-on standings strip.** Promote a persistent ranked player strip (name, on-map color dot, territory-share %) to the top of the panel, above metrics. Rationale: Tier-0 non-negotiable — a mid-match viewer must answer "who's winning?" in <1s with no input. Data already arrives per-frame (`tilesOwned`); just rank and pin it. Folds naturally into the Fix-3 diplomacy strip (same rows).

**P0 — Single "headline event" slot, not the decision log as the hero.** One lower-third line surfacing the latest *promotable* event ("Crimson breaks alliance with Azure"). Promote betrayals, eliminations, first-strikes from the existing comm-thread tone data; let routine expansion stay silent. Rationale: an AI match's only drama is intent/relationship change — Keystone's ally-early/betray-late is exactly the beat to flash.

**P1 — Surface each agent's current directive/intent.** On a selected agent, show its `planObjective` / `planRationale` (already captured in decision cards from `7ec7a2b76`) as a short human-readable line. Rationale: this is the *differentiator* — a human RTS reads intent from micro; an AI match has none, so without printed intent it's "colored blobs moving."

**P1 — Cap and lazy-render the decision log.** The unbounded log (10) is the worst footprint offender. Default to last ~15 entries with a "show all" expander; strip debug fields (latency, intent-type, audit-status, sequence#). Rationale: footprint discipline — detail is on-demand, not pinned.

**P2 — Collapse action feed (8) + action counts (9) into one "playstyle" line.** Top-3 action kinds as badges: `Mostly [Attack] [Expand] [Diplomacy]`. Rationale: removes two redundant sections; viewer wants "what does this agent do," not a 10-row tally.

**P2 — Readability for stream/720p.** Min ~14px effective type, tabular figures on all live numbers (share %, counts) so ranked digits don't jitter, semi-opaque plate behind labels. Reserve red exclusively for war/betrayal. Rationale: replays get watched small and re-encoded; current 11–13px small-caps labels die downscaled.

**P3 — Default-collapse the panel toward edges, never occlude center.** Keep the resize/drag, but ship a tighter default (≤360px) anchored so the map center stays clear. Rationale: every overlay pixel over the playfield hides the actual contest. Pairs with the pending `watchability-polish-spec.md` fit-to-map camera.

**P3 — Colorblind-safe player hues.** Verify the on-map palette reused in the new diplomacy chips is deuteranopia-separable (no red/green as the only distinction between two players). Rationale: in 4-way FFA the entire parse depends on color identity; ~8% of male viewers can't split red from green.

---

## (E) IMPLEMENTATION TARGETS — files / functions / lines + risk notes

**Primary file — `src/client/AiLeagueReplayOverlay.ts`:**
| Change | Lines |
|--------|-------|
| Delete speed slider HTML | 1115–1127 |
| Delete speed event binding | 181–193 |
| Delete speed CSS | 570–595 |
| Metrics grid → 3 cols + compact CSS | 550–565, 1080–1085 |
| Remove "Non-hold" + opening-neutral logic | 1082, 1107–1114, 1145–1164 |
| Replace politics matrix with diplomacy chip strip | 649–712, 1234–1271 |
| Extend frame-detail interface (allies/embargoes/alliances) | 33–45 |
| Delete match-story card + retrieval + interface + CSS | 464, 635–648, 1090–1106, 1745–1751 |
| Delete story timeline fn + mount + cleanup + CSS | 147, 169, 387–411, 984–1029, 1063–1066 |
| Remove `<attacks-display>` hide rule | 814 |
| Strip debug fields from decision cards; cap to ~15 | 1362–1388 |
| Collapse action feed + counts to playstyle line | 1329–1360, 1131 |

**Secondary file — `src/client/graphics/layers/ReplayPanel.ts`:** no change (native speed control we keep). Confirm it stays mounted in replay mode (it is — not in the hidden CSS list).

**Data plumbing — `src/client/ClientGameRunner.ts:599–630`** (`dispatchAiLeagueReplayFrame`): add `allies`, `embargoes`, `alliances` to the per-player map (~606–620), sourced from `player.allies()`, `player.data.embargoes`, `player.alliances()`. **This is the only non-overlay code change** and is required for Fix 3.

**Do NOT touch:** `coworld-adapter/src/coworld-appshell.ts` (win banner `proxywar-coworld-winner-banner` already correct — overlay must not add its own winner UI); `src/server/agents/AgentMatchStory.ts` (artifact generator, keep); `coworld-adapter/src/no-docker-coworld-episode.ts:44` (still writes `match-story.md`, keep).

**Risk notes:**
1. **Replay-only safety:** every overlay change is inside `mountAiLeagueReplayOverlay` / replay-route guards — no live-play layer touched. The one shared-file edit (`ClientGameRunner.ts`) only *reads* existing `GameView` state and only dispatches it on the existing replay-frame path; **no socket, no intent, no fetch** → preserves the `02d31ca97` no-socket invariant.
2. **`tsc`:** removing the `matchStory` interface field (1745–1751) requires removing its only consumer (464, 1090–1106) in the same change or tsc breaks. Extending `AiLeagueReplayFrameEventDetail` (33–45) must match the new `ClientGameRunner` payload exactly. Run `npm exec -- tsc --noEmit`.
3. **i18n:** any new visible strings ("Invalid", "Recovered", "ally", "war", "embargo", playstyle labels) must go through `translateText()` with keys added to `resources/lang/en.json` only (per CLAUDE.md). Do not edit other lang files.
4. **Win-banner collision:** the appshell hides native `<win-modal>` and shows its own banner at `top:15%` — the same position as the overlay replay banner (833–852). After story-timeline removal frees the bottom-center, leave the top-center banner zone to the appshell winner banner; don't reintroduce a panel-side winner element.
5. **Degradation honesty:** do not let the metrics cut erase the fallback/`llmPlannerDegraded` signal — the "Recovered" cell (Fix 2) and the per-decision fallback badge are the retained surfaces; this is a P2 roadmap invariant.
6. **Tests:** `tests/` has coverage for overlay beats/standings/decision cards/narration (`41dbdebd1`). Removing the story surfaces will break story-beat assertions — update those tests; keep standings/decision/narration assertions green.