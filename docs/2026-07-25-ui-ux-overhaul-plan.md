# Proxy War — UI/UX Overhaul Plan (for Opus)

Date: 2026-07-25
Author: Control (Claude)
Status: Proposed — implementation plan, not yet started. Deploy is operator-gated.

---

## 0. How to use this document

This is a step-by-step implementation plan for a UI/UX overhaul of every panel,
menu, option, and button a Proxy War user sees. It is written to be executed by
Opus without re-discovering the codebase. It is grounded in:

- A **live visual survey** of the four distinct rendered surfaces (live `/league`,
  archived `/premiere/<id>`, `/ai-league-replay/<id>`, and the game client main
  menu + SOLO modal + in-game spawn/HUD, driven locally on `localhost:9000`).
- An **exhaustive code inventory** of every client component (`src/client/**`)
  and every server-rendered web surface (`src/server/**`), with file paths.

Work top-to-bottom by phase. Each phase is **independently shippable** and lists
its files, concrete changes, acceptance criteria, and verification commands. Do
Phase 0 first — it is the enabling foundation every other phase depends on.

**This plan touches presentation only. It does NOT touch `src/core` (deterministic
simulation) or the agent protocol** (`AgentRunner.ts`, `AgentDecisionValidator.ts`,
`LegalActionBuilder.ts`, `AgentObservationBuilder.ts`, `AgentPlannerExecutor.ts`).
So the plan-mode + reviewer gate for those files does not apply here — with one
hard exception: any change to `CoworldLeagueSiteWriter.ts` or the premiere page/
overlay **must keep the spoiler-safety leak audit green** (see §2 Invariants).

---

## 1. The core diagnosis

Proxy War currently ships **four disjoint visual identities**, each with its own
color tokens, styling mechanism, and i18n story. A user moving league → watch a
premiere → watch a replay → (in dev) the game client crosses three or four
different-looking products.

| # | Surface | Where the tokens live | Palette | Styling mechanism | i18n |
|---|---------|-----------------------|---------|-------------------|------|
| 1 | **Game client** (menu, lobby, in-game HUD, modals) | `src/client/styles.css` `@theme` | **OpenFront blue** `--color-malibu-blue #0084d1`, `--color-cyber-yellow #ffd700`; surface `#0a1628` | Tailwind v4 (light-DOM Lit) + one shadow-DOM island (`BuildMenu`) | real ICU (`translateText` + `data-i18n`) |
| 2 | **League page** `/league` | inline `:root` in `CoworldLeagueSiteWriter.ts:486` | **ProxyWar amber** `--amber #f4a64a` on `--bg #080b10`, `--cyan #7ad7f0` | server-generated static HTML + one inline `<style>` | English-only facade (server `translateText` always returns EN; most copy hardcoded) |
| 3 | **Premiere overlay** `/premiere/<id>` | `OVERLAY_CSS` in `ReplayPremiereOverlay.ts:2366` | dark, **accent cyan** `--rp-accent #56c7f5`, live red, positive green, 5-marker palette | imperative DOM + injected `<style>`, `--rp-*` tokens | real ICU (`replay_premiere.*`, 132 keys) |
| 4 | **AI-league replay overlay** `/ai-league-replay/<id>` | `ai-league-*` classes in `AiLeagueReplayOverlay.ts` | **LIGHT theme** — `#fff`, `#f8fafc`, `#fff2dc` cards over the dark game map | imperative DOM + injected `<style>` | real ICU (`ai_league_replay.*`, 62 keys) |

(Historical/beta code adds still more palettes: `/play` dark page, the `/public`
+ `/agent-start` + operator hub **light** theme — but those are 404'd in
production, see §3.)

**On top of the identity split, systemic debt (from the code inventory):**

- **Two button systems:** `o-button` (brand-token, `components/baseComponents/Button.ts`)
  vs `actionButton` (hardcodes hex `#f59e0b`/`#38bdf8`, `components/ui/ActionButton.ts`),
  plus hand-rolled `<button class>` in HUD panels.
- **Three rendering paradigms:** Lit+Tailwind light-DOM (most), Lit+Shadow+hand-written
  `css` (`BuildMenu` only), and imperative vanilla DOM + injected `<style>` (all
  spectator/replay overlays).
- **Color chaos inside the client:** brand `malibu-blue`/`aquarius` in some places;
  raw `blue-500/600`, `sky-*`, `slate-*`, `gray-*`, `zinc-*`, and hardcoded hex for
  the same concepts elsewhere (desktop nav uses `malibu-blue`, mobile nav uses raw
  `blue-600`; glass panels appear as `bg-gray-800/92`, `slate-800/85`, `zinc-900/95`).
- **Icons:** emoji-as-iconography (⬆️⬇️ ✕ ❌ 💰 🛡️ ⚠️ ⚓ 🔀 🏛️ ⚔️ 👤 ⏳ ★ ▶) mixed with
  SVG/`assetUrl`; icon tinting via long CSS `filter: invert()/sepia()/hue-rotate()` chains.
- **Native `alert()`/`confirm()`** used in ~8 flows (host/join leave, exit, kick,
  copy errors, account email) despite a proper `<confirm-dialog>` and toast system existing.
- **z-index ladder with no scale:** `z-[40/100/799/800/900/1001/1200/2000/9998/9999/10001/10002/10010/40000/40001]`, plus invalid `z-999`/`z-[9999]` typos.
- **Arbitrary sizes everywhere:** `w-87.5`, `w-175`, `px-25`, `max-w-100`, `min-w-75`, `py-1.25`, `sm:w-100`.
- **Untranslated strings** leak English regardless of locale: `ChatDisplay` "Hide"/"Chat",
  `PlayerInfoOverlay` "Health:"/"Troops:", the whole `MultiTabModal` scare copy,
  `LangSelector` `title="Change Language"`, several `alert()` texts, `NotLoggedInWarning`.
- **Duplicate settings UIs:** in-game `SettingsModal.ts` (button-list) vs menu
  `UserSettingModal.ts` (`setting-toggle` cards) cover overlapping settings with
  totally different UI.
- **Dead legacy CSS** in `styles.css` (`.option-card`, `.start-game-button`,
  `.options-layout`, `.lobby-id-box`, `.message-area`) from the pre-Tailwind era.

**Visual issues caught in the live survey (screenshots in Appendix C):**

- Garbled version string renders as **"VH.HH.HH"** under the logo (pixel-font mapping bug).
- **Stale inherited OpenFront promo banners** cycle on the menu: "Spring Clan
  Tournament … Sign up on Discord before April 12", "Clan Tournaments … on Discord!" —
  not Proxy War content.
- The **"Social clip" card renders white-on-dark** in the premiere overlay, and the
  whole AI-league replay panel is a light sheet over the dark map — the single most
  jarring theme break.
- "Choose the moment" heading is **clipped** behind the clip card's top edge.
- Spectator/standings expose raw internal jargon to viewers: **"unknown policy"**,
  **"Rating row unknown policy"**, **"⚠ N degraded"**, **"Recovered 43"** with no explanation.
- League updates do a **full `window.location.reload()`** on every 30s data change
  (loses scroll/focus).

---

## 2. Guiding principles & invariants (do not violate)

1. **Preserve behavior.** This is a reskin + UX-polish pass, not a rewrite. No change
   to game rules, intent flow, or the agent protocol. `src/core` is untouched.
2. **No audio, ever.** Audio was removed product-wide (`c282d55f3`, standing decision).
   Do not add any sound/music toggle or asset. See memory `no-audio-product-decision`.
3. **Spoiler-safety contract is sacred** (league premiere card + premiere page):
   - The live/scheduled premiere card on `/league` may render **only the 5
     spoiler-neutral fields** it uses today (round, map, time, live/scheduled state,
     link). Never surface winner/outcome text pre-reveal.
   - The premiere page must **not expose pre-reveal scrubbing** (the `body.replay-premiere-pre-reveal`
     CSS that hides the scrubber/play-pause must keep working).
   - Output must stay **byte-identical when no premiere is present** (the premiere CSS
     block is appended only when a card exists — keep that).
   - Any edit to these files must keep the **leak-audit tests green** (they scan
     `/league` HTML + `data.json` and the premiere metadata).
4. **i18n discipline.** All new user-visible text goes through `translateText()` and
   adds its key to `resources/lang/en.json` **only**. Never edit other `resources/lang/*.json`
   (Crowdin owns them). When you newly translate a client component, add its tag to the
   manual re-render list in `LangSelector.ts:207-240` or it won't re-localize on language change.
5. **League page output contract.** `/league` is a static 3-file generator
   (`index.html`, `client.js`, `data.json`) written atomically; keep the flat-file layout
   and the atomic write. Keep it self-contained (no external CSS/JS/CDN) — it is served
   raw and CSP-restricted.
6. **Determinism / gates.** No `src/core` edits, no new nondeterministic deps. Deploy,
   push to `main`, and any hosted Coworld mutation stay **operator-gated** — this plan
   ends at "locally green branch," not "deployed."
7. **Accessibility is part of "done."** New interactive elements are real `<button>`s
   with `aria-label`/roles and keyboard support; respect `prefers-reduced-motion`;
   maintain ≥44px touch targets on mobile (the league page already does this — match it).

---

## 3. Production reality → priority (READ BEFORE PICKING WORK)

Production runs with `PROXYWAR_LEAGUE_WRAPPER_ONLY=true`
(`src/scripts/ai-agent-demo-server.ts:483`). A global middleware then serves **only**
`/league`, `/premiere/*`, the `/ai-league-replay` canvas, and renderer assets;
**every other GET redirects to `/league`, every other POST → 404.**

That means the surfaces are not equally important:

| Tier | Surfaces | Ships in prod today? |
|------|----------|----------------------|
| **A — production, high traffic** | `/league` page; `/premiere/<id>` overlay; `/ai-league-replay/<id>` overlay; the HUD layers that render *during replay* (Leaderboard, TeamStats, GameLeftSidebar, GameRightSidebar, ReplayPanel, SpawnTimer, WinModal result, HeadsUpMessage, canvas map) | **Yes** |
| **B — game client shell** | OpenFront main menu, nav, SOLO/Create/Join/Ranked modals, menu Settings/Help/Account/Store/Clans, interactive-play HUD (ControlPanel, BuildMenu, PlayerPanel, radial menu, chat, send-resource, moderation) | **No** (redirects to `/league` in wrapper mode; dev/beta only) |
| **C — historical/beta** | `/play`, `/public`, `/agent-start`, operator/demo hub, `spectator.html`, `openfront-replay` stubs, `/beta` gate | **No** (404/redirect in prod) |

**Priority = Phase 0 (foundation) → Tier A → Tier B → skip Tier C** (unless the operator
reactivates it). Tier B is inherited-OpenFront chrome; it carries the worst brand
incoherence (blue brand, garbled version, stale Discord banners) and matters the moment
the client is ever exposed, but it is not the current live product. Do not spend a single
cycle restyling Tier C historical code.

---

## PHASE 0 — Design foundation: one token system + primitive consolidation

**Goal:** a single source of truth for color, spacing, radius, elevation, and typography
that all four surfaces consume, plus one button primitive and one modal/dialog primitive.
Everything after this becomes "swap raw values for tokens."

**Canonical palette:** adopt Proxy War's **dark + amber** identity (already the league
page's look and the operator-facing brand), reconciled with the premiere overlay's
`--rp-*` system, which is the most mature (it already has accent/live/positive/caution/
danger + a 5-marker palette + a radius scale + reduced-motion handling). Use the premiere
values as the structural base and the league amber as the primary brand accent.

### 0.1 Define the canonical tokens (one file, three consumers)

Create `src/client/styles/tokens.css` (imported by `styles.css`) defining a `:root` token
set. Mirror the same values into two exportable strings so the non-Tailwind surfaces reuse
them verbatim:

- `src/server/agents/leaguePageTokens.ts` → exports the `:root{…}` string that
  `CoworldLeagueSiteWriter.ts` inlines (replacing its ad-hoc `:root` at line 486).
- `src/client/styles/overlayTokens.ts` → exports the token block that
  `ReplayPremiereOverlay.ts` and `AiLeagueReplayOverlay.ts` inject (replacing `--rp-*`
  and `ai-league-*` hardcoded values).

Token groups (name them semantically, not by hue):

```
--pw-bg / --pw-surface / --pw-surface-2 / --pw-surface-3   (dark elevations)
--pw-line / --pw-line-strong                                (borders)
--pw-text / --pw-text-dim / --pw-muted                      (text)
--pw-accent (#f4a64a amber) / --pw-accent-strong / --pw-accent-soft / --pw-on-accent
--pw-info (cyan) / --pw-live (red) / --pw-positive (green) / --pw-caution / --pw-danger
--pw-mk-turning / --pw-mk-smart / --pw-mk-mistake / --pw-mk-betrayal / --pw-mk-clip  (+ *-soft)
--pw-r-xs..xl / --pw-r-pill                                 (radius scale: 7/9/11/14/18/999)
--pw-space-1..8                                             (4px base spacing scale)
--pw-z-*  (see 0.4)
--pw-shadow / --pw-shadow-soft
--pw-focus                                                  (focus ring color)
```

Wire the Tailwind `@theme` in `styles.css` to consume these (`--color-accent: var(--pw-accent)`,
etc.) so Tailwind utilities and hand-written CSS resolve to the same values. Keep the old
`--color-malibu-blue` name as an **alias** to `--pw-info` during migration so nothing breaks;
remove aliases in Phase 5.

**Decision to make explicit for the operator (one line):** the game client is currently
OpenFront-blue; this plan repalettes it to Proxy War amber/dark to match the league. If the
operator wants to *keep* blue as the in-game accent and amber only for web chrome, that is a
one-token change (`--pw-accent`) — flag it, don't guess.

### 0.2 One button primitive

Fold `actionButton` (`components/ui/ActionButton.ts`) into `o-button`
(`components/baseComponents/Button.ts`): map its `normal/red/green/indigo/yellow/sky`
variants onto `o-button` variants (`primary/secondary/danger/positive/info/ghost`) backed by
tokens; delete the hardcoded hex. Provide a thin functional wrapper if HUD call sites need the
old ergonomics, but there must be **one** styled implementation. Fix the `disable` vs `disabled`
prop-name trap on `o-button` (accept both, document one).

### 0.3 One dialog path

Route every native `alert()`/`confirm()` through the existing `<confirm-dialog>`
(`components/ConfirmDialog.ts`) and the `show-message` toast host (`HeadsUpMessage.ts`).
Call sites to fix: `HostLobbyModal` (leave), `JoinLobbyModal` (leave), `GameRightSidebar`
(exit), `PlayerModerationModal` (kick), `SinglePlayerModal` (max-timer `alert`),
`CopyButton` (copy error), `AccountModal` (×3 email `alert`), `TokenLoginModal` (login fail).
Each replacement string goes through `translateText`.

### 0.4 z-index scale, spacing scale, glass-panel token

- Add named z-tokens and replace the ad-hoc ladder: `--pw-z-hud:100`, `--pw-z-panel:800`,
  `--pw-z-overlay:900`, `--pw-z-modal:1000`, `--pw-z-modal-nested:1200`, `--pw-z-toast:2000`,
  `--pw-z-top:9000`. Kill invalid `z-999`.
- Replace `bg-gray-800/92`, `bg-slate-800/85`, `bg-zinc-900/95` with one `--pw-surface`
  glass token (`background: color-mix(... )` or an rgba var) used by all HUD panels.
- Sweep the arbitrary sizes (`w-87.5`, `px-25`, `min-w-75`, `py-1.25`, …) onto the spacing
  scale (mechanical; can be a codemod).

### 0.5 Delete dead CSS

Remove the superseded legacy classes in `styles.css` (`.option-card`, `.start-game-button`,
`.options-layout`, `.lobby-id-box`, `.message-area`). Confirm no live references first
(`rg -n "option-card|start-game-button|options-layout|lobby-id-box|message-area" src`).

**Phase 0 acceptance:** `tokens.css` + two exported token strings exist and are consumed by
all four surfaces; `o-button` is the only button implementation; no `alert(`/`confirm(` in
`src/client`; z/spacing scales defined; dead CSS gone. `tsc`, `lint`, `npm test`, `build-prod`
all green. Visual: league, premiere, replay, menu each still render (screenshot each).

---

## PHASE 1 — `/league` public page (Tier A, highest traffic)

**Files:** `src/server/agents/CoworldLeagueSiteWriter.ts` (template+CSS+client JS, 1167 ln),
`CoworldLeagueMirrorCore.ts` (data), `CoworldLeaguePremiereSuppression.ts` (spoiler),
`ProxyWarPublicArtifacts.ts` (CSP/allowlist).

Element-by-element (top→bottom of `coworldLeagueIndexHtml`, line 411):

1. **Adopt Phase 0 tokens** — replace the inline `:root` (line 486) with the shared
   `leaguePageTokens.ts` block. No visual regression intended; this is the coherence anchor.
2. **Header / hero** — keep "Agents are fighting a war right now." (it tests well and is
   on-brand). Resolve the **"Warlord/Warlords" vs "Standings" terminology drift** — pick one
   noun for a competitor across chips, standings header, and metric label.
3. **Standings table readability** (the densest weak spot). Today each row can show
   `name`, a green `active-champion` policy line, and a `Rating row unknown policy` line —
   raw internal provenance leaking to spectators. Changes:
   - Replace **"unknown policy"** / **"Rating row unknown policy"** with human copy (e.g.
     hide the provenance line entirely for non-house rows; for the house row show a single
     "House agent" tag). Keep the raw provenance in `data.json` for debugging, out of the UI.
   - Give the HOUSE badge and the active-champion accent the token colors; make the rank
     column and score column monospace-aligned (already partly is).
   - Consider a compact/expanded toggle if rows exceed ~14 (there are 14 warlords today).
4. **"⚠ N degraded" and "Recovered N"** — these are honest-degradation telemetry the
   operator wants visible, but the words are jargon. Reword to viewer-legible copy with a
   tooltip (`title`/`aria-label`) explaining "N decisions the agent failed to make and the
   engine filled in." Keep the number; explain it once.
5. **Battle cards** — dense 13–14-row rosters with strikethrough eliminations render well
   but are heavy. Keep the top-3 + roster-toggle pattern (good). Token-ize the color dots,
   the proportional `.bar`, the winner `★`, and the `▶` links. Ensure the roster toggle stays
   ≥44px on mobile (it does — keep).
6. **Icon system** — replace text glyphs `★ ▶ ⚠` with a tiny inline-SVG set (still
   self-contained, no external assets) so they render consistently cross-platform.
7. **Premiere cards** — apply tokens; keep the **exact 5-field spoiler-safe contract** and
   the "append premiere CSS only when present" behavior. Verify the live LIVE-badge pulse and
   the "Latest premiere / Watch now" slot still look right in both states.
8. **Update mechanism** — the 30s poll doing a full `window.location.reload()` is the biggest
   functional UX debt here (loses scroll/focus, flashes). Upgrade `coworldLeagueClientJavaScript`
   to **diff-and-patch** the DOM from the new `data.json` (standings rows, battle cards, chips,
   timestamps) instead of reloading. Keep the reload as a fallback if the contract shape
   changes. This is the highest-value single change on this page.
9. **i18n (optional, larger)** — `/league` is English-only by design (server `translateText`
   is a facade). Genuine localization means routing hardcoded copy through real keys and
   shipping the strings client-side. Scope this as a **stretch** sub-phase; do not block the
   visual overhaul on it.

**Acceptance:** page uses shared tokens; no raw "unknown policy"/jargon in the UI; degraded/
recovered explained on hover; SVG icons; **incremental update with no full reload**; premiere
cards unchanged in contract. **Leak-audit tests green.** Verify with a tall-viewport screenshot
of hero, standings, battle grid, footer in light and dark OS themes.

---

## PHASE 2 — `/premiere/<id>` overlay (Tier A)

**Files:** `src/client/ReplayPremiereOverlay.ts` (3250 ln, `OVERLAY_CSS` at 2366),
`ReplayPremierePublicPage.ts` (server shell/OG card), `ReplayLoadingScreen.ts` (join veil),
`ReplayPremiereRuntime.ts` (state).

This surface has had several polish passes and is the most mature — do **targeted** fixes:

1. **Fix the white "Social clip" / clip card theme break.** In the dark overlay the clip
   "sheet" and the caption card render near-white (`--rp-caption: #ffffff` in the light block,
   but the clip card reads light in dark mode too). Re-theme the clip/caption/"Choose the
   moment" block onto `--pw-surface`/`--pw-line` so it sits in the dark system. This is the #1
   visual complaint on the premiere page.
2. **Fix the clipped "Choose the moment" heading** (it hides behind the card's top edge) —
   spacing/overflow fix.
3. **Adopt Phase 0 tokens** — replace `--rp-*` values with the shared `overlayTokens.ts`
   (keep the `--rp-*` *names* as aliases to minimize churn across the 885-line CSS constant).
4. **Dead light theme** — `:root[data-theme="light"]` exists but is never set in production.
   Either wire it to the client **Dark Mode** setting (so the premiere honors the toggle) or
   delete it. Recommend wiring it, since Dark Mode is a real user setting; if wired, QA both.
5. **Premiere-specific loading copy** — the join veil reuses generic `ai_league_replay.*`
   "Loading replay…"; add `replay_premiere.*` keys for premiere wording ("Joining the live
   premiere…", sync progress). Keep the pre-reveal scrubber suppression intact.
6. **Perf/churn (optional)** — the overlay recreates its `<style>` and does `replaceChildren`
   on every hydrate with a manual focus save/restore. Not user-visible but worth a follow-up:
   cache the `<style>` node; patch instead of full replace. Do not risk the spoiler invariants
   for this — defer if risky.

**Acceptance:** no white cards in dark mode; heading not clipped; tokens shared; Dark Mode
honored (or dead theme removed); premiere loading copy present; **pre-reveal scrub suppression
and 5-field card contract intact**; leak-audit green. Verify archived + (if possible) a live
premiere.

---

## PHASE 3 — `/ai-league-replay/<id>` overlay (Tier A — worst identity break)

**Files:** `src/client/AiLeagueReplayOverlay.ts` (2321 ln), `AiLeagueReplayMode.ts`, and the
`ai-league-native-spectator-styles` injected by the game renderer that repositions
`game-left-sidebar`/`leader-board`.

This panel is a **light theme** (`#fff`, `#f8fafc`, `#fff2dc`, `#eef6ff`) bolted onto the dark
game map — the single most incoherent surface, and it is production (it's what league "Watch
replay" and the premiere sit on).

1. **Re-theme dark.** Rebuild the `ai-league-*` CSS onto the shared `overlayTokens.ts`
   dark palette so the spectator panel matches league + premiere. This is the bulk of the work.
2. **Humanize jargon** — same "Recovered N", "Invalid", "degraded" telemetry appears here
   (I saw "Recovered 43" amber card, standings all "8%"). Give the stats cards legible labels +
   tooltips; format the flat "8%" starting shares so they read as "even start" rather than
   looking broken.
3. **Keep the good bits** — the draggable/collapsible panel, Reset layout, mobile bottom-sheet,
   decision-log "Show older", diplomacy toggle, and headline-event toasts are solid; just
   re-skin them. Preserve `escapeHtml` usage (it renders agent-authored text — keep it escaped).
4. **Standings/leaderboard reposition** — verify the `game-left-sidebar`/`leader-board`
   reposition still aligns after Phase 4 restyles those HUD layers.

**Acceptance:** panel is dark and matches league/premiere; jargon explained; drag/collapse/
mobile behaviors intact; agent text still escaped. Screenshot early-game and mid-game.

---

## PHASE 4 — Replay-visible in-game HUD (Tier A)

These HUD layers render **in production** during replay/premiere playback, so they are Tier A
even though they live in the game client. Restyle only what shows in replay; leave interactive-
only layers to Phase 6.

**Files (all `src/client/graphics/layers/`):** `Leaderboard.ts`, `TeamStats.ts`,
`GameLeftSidebar.ts`, `GameRightSidebar.ts`, `ReplayPanel.ts`, `SpawnTimer.ts`,
`ImmunityTimer.ts`, `WinModal.ts`, `HeadsUpMessage.ts`.

1. **Glass-panel + token sweep** — replace `bg-gray-800/92`, `bg-slate-800/85` with the
   `--pw-surface` glass token; accent bars/active states to `--pw-accent`/`--pw-info`.
2. **Leaderboard** — replace the **emoji sort arrows ⬆️⬇️** with SVG; give the expand `+`/`-`
   an `aria-label`; token-ize the inline `grid-template-columns` px minmax.
3. **GameRightSidebar** — the timer/replay/pause/fast-forward/settings/exit controls are
   `<div @click>` with no keyboard/role. Convert to real buttons with `aria-label` (some alts
   are hardcoded English — "settings"/"exit" — route through `translateText`). The exit
   `confirm()` is already handled in Phase 0.3.
4. **ReplayPanel** — token-ize the ×0.5/×1/×2/fastest speed buttons (active = `--pw-accent`).
5. **SpawnTimer / ImmunityTimer** — replace hardcoded `rgba(255,165,0,.9)` and the inline
   color array with tokens; fix invalid `z-999` → `--pw-z-*`.
6. **WinModal** — token-ize; keep the replay branch that strips the cosmetic upsell and routes
   to `/league` (`isLeagueReplay()`); fix arbitrary `w-87.5/md:w-175`.
7. **HeadsUpMessage** — token-ize the inline rgba toast colors (green/red) via
   `--pw-positive`/`--pw-danger`.

**Acceptance:** every replay-visible panel uses tokens and the shared glass surface; no emoji
icons in these layers; sidebar controls keyboard-accessible; untranslated alts fixed; z-index
on the scale. Verify by watching a league replay and screenshotting each panel.

---

## PHASE 5 — Game client shell: brand, menu, nav, lobby (Tier B)

Dev/beta today, but this is where the **inherited-OpenFront identity** lives and it is the
biggest brand-coherence gap the moment the client is exposed.

**Brand fixes (high visibility):**
1. **Repalette to Proxy War** — flip the `@theme` accent from `--color-malibu-blue` to
   `--pw-accent` (amber) across the client, or per the operator's §0.1 decision. The big blue
   SOLO button, blue nav actives, blue toggles all move to the brand accent.
2. **Fix the garbled version string** ("VH.HH.HH" under the logo) — trace the version source
   (`resources/version.txt` / `--desktop-logo-image-url`) and the pixel-font glyph mapping;
   render the real version or drop the subtitle.
3. **Remove/replace stale inherited banners** — the rotating "Spring Clan Tournament / Sign up
   on Discord before April 12" and "Clan Tournaments … on Discord!" promos are OpenFront
   content. Either remove the promo carousel or replace with Proxy War copy (e.g. point at
   `/league`). Source: `HomepagePromos.ts` / news feed.
4. **Nav consistency** — desktop nav uses `malibu-blue`, mobile nav + clan tab use raw
   `blue-500/600` with a hardcoded `drop-shadow`. Unify onto the accent token; extract the
   copy-pasted ~200-char button class string into a shared constant.

**Structural fixes:**
5. **Reconcile the duplicate settings UIs** — the in-game `SettingsModal.ts` (button-list) and
   the menu `UserSettingModal.ts` (`setting-toggle` cards) overlap. Pick the card UI as
   canonical and have the in-game settings reuse the same `setting-toggle/slider/select`
   components (subset relevant in-game). Deduplicate the settings definitions.
6. **Menu modals token sweep** — `SinglePlayerModal`, `HostLobbyModal`, `JoinLobbyModal`,
   `GameConfigSettings`, `MapPicker`, `LobbyPlayerView` (has custom `.player-tag`/`.host-badge`
   CSS — token-ize), `RankedModal`, `Matchmaking` (hardcoded `bg-purple-600`), `Store`,
   `LeaderboardModal`, `ClanModal`, `AccountModal`, `HelpModal` (keycaps hardcode
   `bg-[#2a2a2a]`), `NewsModal`, `LanguageModal`.
7. **Fix untranslated strings** surfaced in the inventory: `LangSelector` "Change Language",
   `ChatDisplay` "Hide"/"Chat" (Phase 6), `NotLoggedInWarning` fallback, `CopyButton`/
   `AccountModal`/`TokenLoginModal` alert texts (already via Phase 0.3), the `"${maxTimerValue} min"`
   / `"/s"` hardcoded unit suffixes → localized number/unit formatting.

**Acceptance:** client reads as Proxy War (amber/dark), not OpenFront-blue; version string
correct; no stale Discord/clan-tournament promos; nav unified; one settings component family;
menu modals on tokens. `tsc`/`lint`/`test`/`build` green; screenshot menu, SOLO modal, a lobby,
Settings, Help.

---

## PHASE 6 — Interactive-play HUD & modals + off-pattern islands (Tier B)

Lowest priority (not in prod, only during interactive play), but needed for full coverage.

1. **`BuildMenu.ts`** — the only Shadow-DOM + 190-line hand-written CSS island with hardcoded
   hex (`#1e1e1e/#2c2c2c/#444/#ff4444`) and its own `z-index:9999`. Migrate to light-DOM Lit +
   tokens like the rest, or at minimum feed it the shared token variables.
2. **Quick-chat CSS island** — `ChatModal.ts` uses `styles/modal/chat.css` with off-brand hex
   (`#333/#66c/#4caf50`) and a white search input. Token-ize.
3. **`PlayerPanel.ts`** — replace emoji icons (🏛️⚔️👤💰🛡️⚠️⚓🔀⏳) with the SVG set; token-ize
   `bg-zinc-900/95`; fix `min-w-75 max-w-100`; move the injected traitor-ring `@keyframes` to CSS.
4. **`MainRadialMenu`/`RadialMenu`/`RadialMenuElements`** — imperative SVG with a `COLORS` map of
   hardcoded hex (`#e6c74a/#2a82c9/#4ade80/#ef4444`) and `z-index 10000`. Feed it tokens; align
   the wheel palette with player/relation colors used elsewhere.
5. **`RelationSmiley`, `AlertFrame`** — hardcoded relation/alert hex → tokens.
6. **Remaining HUD** — `ControlPanel` (icon `filter:` chains → colored SVGs; `/s` suffix i18n),
   `UnitDisplay`, `AttacksDisplay` (two spellings of the cancel glyph `❌`/`❌` → one SVG),
   `EventsDisplay` (legacy `btn/btn-info/btn-gray` mapping), `ChatDisplay` ("Hide"/"Chat" i18n),
   `PlayerInfoOverlay` ("Health:"/"Troops:" i18n; unify the troop-bar color mapping with
   ControlPanel), `EmojiTable`, `SendResourceModal` (custom `.range-x`; `#0f1116`),
   `PlayerModerationModal`, `MultiTabModal` (translate the whole scare block), `GameInfoModal`
   (arbitrary `px-25/w-75/h-37.5`; `❌` emoji).

**Acceptance:** no Shadow-DOM/CSS-island divergence; no hardcoded hex in HUD; emoji icons
replaced; radial + relation + alert palettes tokenized; interactive HUD strings translated.
Verify in a local interactive game (see §Verification for the dev-sim caveat).

---

## Cross-cutting cleanup track (do alongside phases, not as a blocker)

- **Kill remaining `alert()`/`confirm()`** (Phase 0.3 covers the list; sweep for stragglers
  with `rg -n "\balert\(|\bconfirm\(" src/client`).
- **z-index audit** — `rg -n "z-\[|z-index" src/client` → map every value onto `--pw-z-*`.
- **Arbitrary-value codemod** — `rg -n "w-\d|min-w-\d|max-w-\d|px-\d|py-\d\.\d" src/client` →
  spacing scale.
- **Untranslated-string sweep** — grep for user-visible string literals in `.ts` render methods
  not wrapped in `translateText`; add keys to `en.json`.
- **Dead CSS** — Phase 0.5 plus a final pass over `styles/modal/*`, `styles/components/*`.

---

## Verification (run per phase)

```bash
npm exec -- tsc --noEmit        # typecheck
npm run lint                    # eslint (note: repo baseline has ~2 pre-existing errors + warnings; do not add new)
npm test                        # vitest (unit + server) — MUST include the league/premiere leak-audit + mirror tests
npm run build-prod              # production build must succeed
```

Targeted tests that MUST stay green when touching web surfaces:
```bash
npx vitest CoworldLeagueSiteWriter --run
npx vitest ReplayPremiere --run           # spoiler/leak audits + integrity
npx vitest CoworldLeagueMirror --run
```

**Visual verification method (works around a capture bug):** the in-app browser goes black on
scrolled screenshots. Instead resize to a **tall viewport** (e.g. 1280×1600) and screenshot
without scrolling, or shift content up with a temporary `document.body.style.transform`. Check
each surface in **both** OS color schemes (`resize_window colorScheme: light|dark`).

**Dev-sim caveat:** `npm run start:client` alone serves the menu + modals, but an interactive
single-player game **will not tick** without the server (the local sim stalls in spawn — I hit
this). To visually verify interactive HUD (Phase 6), run full `npm run dev` (client+server) and
start a solo game, or verify replay-visible HUD (Phase 4) via a real `/ai-league-replay/<id>`
which needs no live server.

**Rollout:** land each phase on a `codex/`-prefixed branch off `main`; keep commits per-phase.
Deploy is a separate operator-gated step (the live beta runs from a frozen release checkout;
see project-state). Do not push or deploy without in-conversation operator approval.

---

## Appendix A — Full surface inventory (condensed; file paths for Opus)

### A. Production web surfaces
- **`/league`** — `src/server/agents/CoworldLeagueSiteWriter.ts` (+ `CoworldLeagueMirrorCore.ts`,
  `coworld-league-mirror.ts`, `CoworldLeaguePremiereSuppression.ts`, `ProxyWarPublicArtifacts.ts`).
  Header, hero+CTAs, premiere card / latest-premiere slot, 4-metric grid, standings table,
  battle-card grid, recent-rounds chips, footer. 30s poll → full reload. English-only facade.
- **`/premiere/<id>`** — server shell `ReplayPremierePublicPage.ts`; client overlay
  `ReplayPremiereOverlay.ts` (3250 ln); runtime `ReplayPremiereRuntime.ts`; veil
  `ReplayLoadingScreen.ts`. States: scheduled/playing/checkpoint/revealed/archived/failure/
  cancelled/recovery. Prediction voting, REACT markers, ambient mode, share, clip, counter-challenge.
- **`/ai-league-replay/<id>`** — `AiLeagueReplayOverlay.ts` (2321 ln, **light theme**),
  `AiLeagueReplayMode.ts`. Draggable panel, standings, decision log, diplomacy, headline toasts.

### B. Game client shell
- Entry: `index.html`, `Main.ts`, `components/{DesktopNavBar,MobileNavBar,MainLayout,PlayPage,
  Footer,NewsBox}.ts`, `LangSelector.ts`, `{Username,Flag,Pattern}Input.ts`.
- Lobby/pre-game: `SinglePlayerModal.ts`, `HostLobbyModal.ts`, `JoinLobbyModal.ts`,
  `GameStartingModal.ts`, `Matchmaking.ts`, `components/{RankedModal,GameConfigSettings,
  Difficulties,ToggleInputCard,LobbyConfigItem,LobbyPlayerView}.ts`, `components/map/{MapPicker,MapDisplay}.ts`.
- In-game HUD (`graphics/layers/`): `Leaderboard, ControlPanel, UnitDisplay, AttacksDisplay,
  EventsDisplay, ChatDisplay, BuildMenu, EmojiTable, GameLeftSidebar, GameRightSidebar,
  ReplayPanel, SpawnTimer, ImmunityTimer, HeadsUpMessage, TeamStats, PlayerInfoOverlay,
  MainRadialMenu/RadialMenu/RadialMenuElements, RelationSmiley, AlertFrame, PerformanceOverlay, InGamePromo`.
- In-game modals: `SettingsModal, WinModal, PlayerPanel, SendResourceModal, PlayerModerationModal,
  ChatModal, MultiTabModal, GameInfoModal`.
- Menu modals: `UserSettingModal, HelpModal, TroubleshootingModal, NewsModal, LanguageModal,
  AccountModal, LeaderboardModal, Store, ClanModal, TerritoryPatternsModal, FlagInputModal, TokenLoginModal`.
- Shared/base: `baseComponents/{Button(o-button),Modal(o-modal)}.ts`, `BaseModal.ts`,
  `ui/{ActionButton,ModalHeader,Divider}.ts`, `ConfirmDialog.ts`, `ModalOverlay.ts`,
  `baseComponents/setting/*`, `FluentSlider.ts`, `CopyButton.ts`, cosmetics/`ranking`/`stats`/
  `leaderboard`/`clan` component families.

### C. Historical/beta (DO NOT restyle unless reactivated)
`/play` (`QuickStartPlayPage.ts`), `/public` + `/agent-start` + operator hub (`AgentDemoHub.ts`,
~5900 ln, light theme), `spectator.html` (`AgentSpectatorReplay.ts`), `openfront-replay`/
`proxywar-replay` 302 stubs, `/beta` gate, feedback (`/api/beta/feedback`).

## Appendix B — Token migration map (old → new)

| Old (scattered) | New (canonical) |
|---|---|
| `--color-malibu-blue #0084d1`, raw `blue-500/600`, `sky-*` (client) | `--pw-info` (keep blue alias during migration) |
| `--color-cyber-yellow #ffd700`, `#f59e0b`, `#fbbf24` (buttons) | `--pw-accent` / `--pw-caution` |
| league `--amber #f4a64a` | `--pw-accent` |
| league `--bg #080b10`, `--surface #111720` | `--pw-bg`, `--pw-surface` |
| premiere `--rp-*` (accent/live/positive/…/mk-*) | `--pw-*` (keep `--rp-*` as alias) |
| replay `#fff/#f8fafc/#fff2dc` light cards | `--pw-surface`/`--pw-surface-2` (dark) |
| `bg-gray-800/92`, `slate-800/85`, `zinc-900/95` | `--pw-surface` glass |
| `z-[799..40001]`, `z-999` | `--pw-z-*` scale |
| `actionButton` hex variants | `o-button` token variants |

## Appendix C — Visual issues log (from the live survey)

1. Menu logo subtitle renders garbled **"VH.HH.HH"** (version/pixel-font bug). → Phase 5.2
2. Menu promo banner cycles inherited OpenFront **"Spring Clan Tournament / Discord / April 12"**
   and **"Clan Tournaments … Discord"**. → Phase 5.3
3. In-game accent is OpenFront **blue** (SOLO button, toggles, nav) — clashes with amber league. → Phase 5.1
4. Premiere **"Social clip" card renders white-on-dark**; **"Choose the moment" heading clipped**. → Phase 2.1/2.2
5. AI-league replay panel is a **light/white sheet over the dark map** (whole-panel theme break). → Phase 3.1
6. Standings expose **"unknown policy" / "Rating row unknown policy"** to viewers. → Phase 1.3
7. **"⚠ N degraded"** and **"Recovered 43"** telemetry shown without explanation. → Phase 1.4 / 3.2
8. `/league` does a **full page reload** every 30s on data change. → Phase 1.8
9. Duplicate settings UIs (in-game button-list vs menu cards). → Phase 5.5
10. Two button systems, emoji icons, native `alert()/confirm()`, z-index chaos. → Phase 0
