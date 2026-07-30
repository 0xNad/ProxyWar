# Proxy War Public Product Audit — Stage 0

**Date:** 2026-07-31 | **Surfaces:** beta.proxywar.xyz, proxywar.xyz | **Status:** Live at capture time

Evidence: 15 screenshots across 4 viewports (1440×900, 1280×720, 390×844, 844×390 landscape) in
`artifacts/product-overhaul/before/` (gitignored, kept as untracked operational artifacts per repo
convention — not committed).

---

## 1. Route Inventory

| Route | Status | Renders | Notes |
|-------|--------|---------|-------|
| `beta.proxywar.xyz/` | 302 | → `/league` | |
| `beta.proxywar.xyz/league` | 200 | League standings table | Primary product surface: warlords, scores, policy labels, battle cards |
| `beta.proxywar.xyz/agents` | 302 | → `/league` | Not implemented; falls through to catch-all |
| `beta.proxywar.xyz/watch` | 302 | → `/league` | Not implemented |
| `beta.proxywar.xyz/account` | 302 | → `/league` | Not implemented on beta; platform accounts live on apex only |
| `beta.proxywar.xyz/ai-league-replay/league-*` | 200 | Replay viewer, map + UI | 3 instances captured |
| `beta.proxywar.xyz/premiere/prem_*` | 200 | Premiere viewer | 1 instance captured, revealed state |
| `proxywar.xyz/` | 200 | Platform root hub | Links to account, player profiles |
| `proxywar.xyz/account` | 200 | Account page, GitHub sign-in | `connect-src 'self' https://proxywar.xyz` |
| `proxywar.xyz/player/:name` | 200 | Player profile (standing, episodes, recent) | Functional |

## 2. Information Architecture & Click Paths

- Only implemented public route on beta is `/league`; `/agents`, `/builders`, `/build`, `/watch`,
  `/about`, `/match/:matchId` are all unimplemented (soft 302 to `/league`, not 404).
- Platform routes (`/account`, `/player/:name`) exist only on the apex origin, unreachable from beta
  without manually typing the apex URL — no cross-link either direction at capture time.
- Click path to watch a match: `/` → `/league` → "Watch now"/"Watch latest battle" → premiere or
  replay route. 2–3 clicks; spec's Stage 4 target is one click from a homepage hero, which does not
  exist yet (root is a bare redirect).
- **CSP blocker:** beta's `connect-src 'self'` silently blocks any credentialed fetch to the apex
  PoV-claims endpoint — the mechanism Stage 1 needs. See §10.

## 3. Spoiler Surfaces

| Surface | State | Assessment |
|---|---|---|
| League standings table | Visible | By design — completed rounds show final scores/placement |
| Battle card (league page) | Visible | By design for background rounds |
| Replay title/metadata | Safe | Neutral run-id title, no spoiler in URL/title |
| Premiere page (sealed) | Safe | No-seek-past-live, two-browser resync, reveal-at-end enforced by the runtime |
| Premiere card (league page) | Safe | Pre-reveal shows "SEALED" + countdown; post-reveal shows timestamp |
| Footer/meta tags | Safe | No result leakage observed; `form-action: none` |

## 4. Raw-Label Exposure

Raw Coworld policy labels (e.g. `mickey-mouse-intent:v1`, `proxywar-keystone:v42`,
`captain-underpants-max-aura:v1`) are the **primary public identity** in the league standings
"Warlord" column and on battle cards when a human name is absent — directly contradicts the
product's Builder/Agent/Version identity model (spec §1). Visible at all captured viewports,
including mobile (`league-390x844.png`, crushed but legible).

By contrast, the apex player-profile page (`proxywar.xyz/player/:name`) does **not** show raw
labels — human-readable name only. Stage 1's registry work needs to bring the league surface up to
that same standard and move raw labels to an integrity drawer, not the primary UI.

## 5. Mobile Findings

- **League, 390×844 portrait:** Table crushed into 4 columns (Rank | Warlord | Score | Rated
  rounds), legible, full vertical scroll, no horizontal overflow. Not the responsive card-row
  design Stage 2 specs — usable, not optimal.
- **League, 844×390 landscape:** Table compressed to ~80% viewport width, names truncate/wrap, no
  mobile nav observed. Barely usable.
- **Replay, 390×844:** Map fits viewport, overlay panels appear to stack/drawer. No obvious
  touch-target violations from the screenshot; not independently confirmed by interaction.
- **Premiere, 390×844:** Map + stacked controls, no overflow observed.
- **Player profile, 390×844:** Sections narrow but readable.

## 6. Replay/Broadcast Current State

**Implemented (desktop 1440×900):** Pixi.js map dominates (~70% viewport), top bar with match
ID/round/timestamp, decision log / diplomacy / war-narrative overlay per the existing
`AiLeagueReplayOverlay` (per source, not independently re-verified pixel-by-pixel in this pass).
Same structure holds at mobile widths via a presumed drawer pattern.

**Missing (Stage 4 scope, confirmed absent):** lower thirds, a curated War Room panel
(ALLIANCE/FIRST STRIKE/BETRAYAL/ELIMINATION), broadcast-specific HUD styling, a clickable timeline
with markers, an Analyst-mode toggle. None of these were visible in any capture.

**Premiere viewer:** sealed playback with no-seek-past-live enforced; checkpoint-prediction and
marker UI exist per source but were not distinctly identifiable in the screenshots themselves.

## 7. Stale Data & Degradation Presentation

- No stale banner at capture time — league was live at round 1050, "UPDATED 7/31/2026, 12:00:39
  AM" (~23 min before capture). Mirror's `stale`/`championFeedStale`/`replayFeedStale` flags were
  not triggered during this pass; degradation UI was not exercised by a synthetic stale-feed test.
- No "recovered turns" warning present on the captured round — either no recovery events occurred,
  or they render only in a per-match integrity drawer, not the primary standings view.
- Round-state and freshness copy reads honestly ("ROUND 1050 · LIVE", explicit last-update
  timestamp); no false "live" claim observed.

## 8. Performance Notes

- League page loads without the game/Pixi bundle (correct per spec — bundle is lazy on match
  entry). Static regenerate cycle (~30 s) matches the documented mirror behavior.
- Replay/premiere pages show a perceptible ~2–3 s delay before the map/bundle initializes.
  Not blocking, acceptable for Showcase phase, worth revisiting under Stage 3+ perf work.
- No console errors surfaced during capture.

## 9. Broken Routes & Errors

Every unimplemented route (`/agents`, `/watch`, `/account` on beta) returns a soft 302 to `/league`
rather than 404 or a placeholder — silently misleading rather than informative. No dead links
observed in captures. "Enter your agent" still links out via `data.links.enterTheLeagueUrl`
(Stage 7 scope, unchanged).

## 10. Security & CSP

**beta.proxywar.xyz** (blocking Stage 1):
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:;
connect-src 'self';  ← blocks any fetch to the platform/apex origin
worker-src 'self' blob:; media-src 'self' blob:; manifest-src 'self';
object-src 'none'; frame-src 'none'; frame-ancestors 'none';
base-uri 'self'; form-action 'none'
```

**proxywar.xyz/account:** `connect-src 'self' https://proxywar.xyz` — correctly scoped for the
apex's own use; the beta origin needs the equivalent addition (Stage 1 item B.3, this branch).

All public routes are anonymous-accessible with no auth wall; no admin/tester/relay-mutation
surfaces were reachable from either origin, consistent with the security boundary in the product
spec §3.

## 11. Feature Completeness Summary

**Implemented:** league standings (17 warlords), replay playback + overlay, sealed premieres
(playback, embargo, reveal), player profiles (apex), account + GitHub sign-in (apex), graceful
degradation (stale banners, last-good snapshot), clip generation (V3 watermarked MP4s).

**Not implemented (spec gaps, not defects):** `/watch`, `/agents` + `/agent/:slug`, `/builders` +
`/builder/:slug`, `/build`, `/match/:matchId`, homepage hero/event lobby, broadcast HUD, Director
Cut, identity registry (Builder/Agent/Version + emblems), platform integration on beta (PoV claims,
account chip, profile links — CSP-blocked, not attempted before this audit).

## 12. Worst Findings, Priority Order

1. **Platform accounts unreachable from beta** — CSP blocks the PoV-claims fetch; user has no
   account awareness on the league surface. Stage 1 blocker. *Evidence: CSP header, §10.*
2. **Raw policy labels as primary identity** — breaks the Builder/Agent/Version model. Stage 1.
   *Evidence: `league-1440x900.png`.*
3. **Homepage is a bare redirect to the league table** — no event lobby, no CTA. Stage 2.
   *Evidence: 302 on `/`.*
4. **No broadcast layer** — raw telemetry + map, no narrative framing for first-time viewers.
   Stage 4. *Evidence: `replay-1-1440x900.png`.*
5. **Mobile table doesn't stack to cards** — readable but not the spec'd responsive design. Stage 2.
   *Evidence: `league-390x844.png`.*
6. **Unimplemented routes soft-redirect instead of 404/placeholder** — poor signal. Stage 2.
7. **Replay load ~2–3 s** — not blocking, note for later perf work.
8. **No synthetic stale-feed test run this pass** — degradation UI unverified in this audit
   (feature exists per source, not exercised live).
9. **Director Cut not implemented** — Stage 5, not a Stage 0/1 blocker.
10. **Identity registry empty** — no BuilderProfile/AgentProfile/AgentVersion records exist yet for
    the current 17 participants. Stage 1 blocker.

## 13. Stage 0 Acceptance

1. Audit doc exists with evidence links (this document + `artifacts/product-overhaul/before/`). ✅
2. Branch reconciliation (`claude/product-overhaul`) builds clean: `tsc --noEmit` clean, `npm test`
   clean except a pre-existing, evidenced, environmental disk-floor flake in the untouched
   `replay-premiere` subsystem, `npx vite build` succeeds. See branch topology section below. ✅
3. Before-screenshots captured: 15 files, 4 viewports, all key surfaces. ✅

---

## Branch topology findings (2026-07-31)

Recorded during Stage 0 branch reconciliation on `claude/product-overhaul` (merge commit
`dfe573a97`, full rationale in that commit's body). Three findings that correct the original
task framing rather than confirm it:

1. **`main` is fully contained in `claude/betting`.** `merge-base(main, claude/betting)` equals
   `main`'s own tip (`c35e6be87`) exactly. `git log claude/betting..main` returns 0 commits;
   `git log main..claude/betting` returns 228. Betting is not a sibling line that independently
   needs main's fixes merged in — it already *is* main plus 228 more commits. Merging `main` into
   the branch-off-`claude/betting` base was consequently a true no-op (`Already up to date`, no
   commit produced).
2. **`codex/ui-ux-overhaul` forked from inside `claude/betting`'s own history, not from `main`.**
   `merge-base(claude/betting, codex/ui-ux-overhaul)` = `c282d55f`, a commit 74 commits downstream
   of `main`'s tip along `claude/betting`'s own timeline (not an ancestor of `main` at all). From
   that point ui-ux added 11 exclusive commits (design tokens/primitives, HUD polish, league-page
   humanization, dark replay theming) while betting continued for 155 more exclusive commits over
   the same window. ui-ux is a small, late side-branch of betting's own timeline, not an
   independent third line off `main`. Betting's own tip already carries the `--pw-*` design-token
   foundation (93 occurrences in `AiLeagueReplayOverlay.ts` alone, pre-merge) via that shared
   history, so most of ui-ux's real contribution was already present in betting going in.
3. **The legal-pages cherry-pick claim was inaccurate as stated.** Neither `137fb530f` nor its
   origin `ecf5cd019` is an ancestor of `main`, `claude/betting`, or `codex/ui-ux-overhaul`. What
   is true: `claude/betting` carries its own independent cherry-pick of the same fix, commit
   `a701c3717` (different hash, identical diff/message). `main` and `codex/ui-ux-overhaul` do not
   have the legal-pages removal at all. Not a blocker for the merge (betting's copy carries into
   `claude/product-overhaul` automatically), but worth correcting in the source doc.

## Storage waiver record

2026-07-30/31: operator explicitly waived the 25 GiB worktree/dependency storage floor for the
`product-overhaul` worktree. The waiver was not actually exercised — the lifecycle controller's own
admission check measures the target's parent filesystem, not the internal root, so external-volume
creation passed on the controller's own rules with no override needed. Measured internal free
space: 17 GiB at session start, drifted to 15 GiB over the session (npm cache growth + vitest temp
directories under the OS temp root, which sits on the internal APFS container regardless of
worktree location). Workspace volume (`/Volumes/ProxyWar Workspace`, UUID
`DD5EE598-D3EF-4BD8-A164-66C2DE2688A0`) free throughout: 926–929 GiB. Worktree created via the
lifecycle controller (`create` command, no override, no fallback) at
`/Volumes/ProxyWar Workspace/ProxyWar/worktrees/product-overhaul` on branch
`claude/product-overhaul`, start-point `claude/betting` (`6e0d90a7f`).

---

**Audit completed:** 2026-07-31 00:08 UTC (live capture) / tightened and topology-annotated
2026-07-31 during Stage 0 close-out.
