# Coworld replay visual bugs — 2026-08-15

## Decision and evidence boundary

The UI target is Maxwell's Coworld-live replay interface, not current upstream
OpenFront. The target entered the repository as `99d596e9` (`Add the new replay
viewer`, GitHub author `johomax`) and was merged with localization and lifecycle
repairs in `87208a70` (PR #110). This repair branch starts at that merge commit.

The deployed baseline was tested read-only against Coworld
`cow_fcef76bf-8b8d-43af-8cdc-47e936d76f03`, ProxyWar package `0.1.45`, static
bundle SHA-256
`9bcdb2ed99421d12fc89742665f7cb41345a5f6c24c614c9cc6939e741a3cfb7`, and
retained Pangaea replay `136e6089-bfcf-403f-bd9a-0f38057182ae.replay` (16 AI
agents, 1,855 decisions, broadcast revision 83). [live/runtime verified]

Repository and local-branch tests do not prove a Coworld deployment. No hosted
package, league binding, or served Coworld artifact was changed in this work.

## Reproducible defects

### CAM-01 — delayed competitor fit overwrites a drag or zoom

Severity: P0. Confidence: high.

1. Pause a replay.
2. Select a competitor from the scorebug or rail.
3. Drag or wheel before the asynchronous territory-border lookup resolves.
4. The delayed fit lands afterward and yanks the camera back to the selected
   competitor.

Cause: `TransformHandler.fitPlayerInView()` invalidated older competitor
requests but did not invalidate a pending request when the viewer expressed a
new camera intent.

### CAM-02 — resize and fullscreen discard manual framing

Severity: P0. Confidence: high.

1. At 1280 x 720, zoom deeply around an off-centre point and drag to a deliberate
   composition.
2. Resize to 900 x 700, or enter and exit fullscreen.
3. The camera returns to a whole-map fit. After the generic resize it can also
   be undersized and left-biased compared with a fresh 900 x 700 load.

Cause: every replay resize/fullscreen transition called `centerAll(0.9)` unless
a competitor was followed. The renderer had no durable distinction between an
untouched automatic camera and viewer-owned framing. The followed path also
skipped publication of fresh `--pw-board-*` and `--pw-band-*` layout geometry.

### CAM-03 — nuke cinema can restore a stale camera

Severity: P0. Confidence: high from deterministic source flow.

The nuke punch-in captures a camera snapshot and restores it after the impact.
A drag, zoom, or competitor selection during the cinematic did not invalidate
that snapshot, so the restore could overwrite the viewer's newer choice.

### INPUT-01 — pinch release can become a false tap/follow

Severity: P0. Confidence: high from synthetic pointer reproduction.

The first `pointerup` from a two-finger gesture cleared every pointer and then
ran the normal tap path. That could select/follow a nation after a pinch,
prevent a smooth transition to one-finger pan, and synthesize a tap from
`pointercancel`. The map also lacked pointer capture, making termination less
reliable when a drag crossed the canvas or iframe boundary.

### ZOOM-01 — large wheel deltas can reverse direction

Severity: P1. Confidence: high.

The linear factor `1 + delta / 600` is zero at `delta = -600` and negative below
it. A sufficiently large zoom-in event could therefore create an infinite
intermediate value or reverse into a zoom-out before clamping.

### UI-01 — two contradictory Hide interface controls

Severity: P1. Confidence: high; browser reproduced.

Maxwell's toolbar used `body.proxywar-hud-hidden`, while the restored broadcast
layer mounted a second eye control using `body.pw-gui-hidden`. At 900 x 700 both
buttons were visible. The toolbar control hid only legacy HUD elements and left
the timeline, Analyst tab, identity/follow badge, and second eye on screen.

### UI-02 — narrow scorebug occupies map space and can retain an invisible sort

Severity: P1. Confidence: high.

At 740 x 480 the five-column scorebug measured 246 px wide and retained all 17
header/player rows in the DOM, despite the map needing the horizontal space.
When a desktop-only economy column was the active sort, narrowing the viewport
could also preserve an ordering whose metric was no longer visible.

## Baseline passes and limits

- PASS: 32 drags across eight return cycles returned to exact screenshot
  alignment (`dx = 0`, `dy = 0`; crop mean absolute difference `0.018`).
- PASS: off-centre wheel zoom preserved its cursor anchor.
- PASS: zoom-floor, pan, re-zoom, 12 small fullscreen zoom steps, and 20 rapid
  in/out pairs produced no runaway or oscillation.
- PASS: the Analyst drawer accepted map gestures and the player-card modal
  blocked background gestures.
- PASS: zero browser console errors; expected static-startup/JWT and sampled
  replay-hash warnings remained.
- NOT RUN: genuine hardware trackpad pinch. The browser driver cannot emit a
  real Safari gesture stream, so this requires deterministic synthetic gesture
  coverage plus a hardware smoke test before hosted release.
- NOT RUN: deployed 12-agent replay. The current retained league window exposed
  16-player rounds and no 12-player replay in a 1,000-item search.

## Deliberate non-fix

Fresh 844 x 390 and 390 x 844 static-viewer layouts leave large bands because a
square Pangaea board is contained in an extreme-aspect frame. The static Coworld
viewer explicitly disables the orientation-aware crop/overzoom policy so the
whole board remains visible. This is a product framing tradeoff, not the same
interaction defect as camera resets. It remains documented rather than silently
changing Maxwell's whole-map landing contract.

## Repair and release gate

### Implemented repair

- CAM-01/CAM-03: a replay-only monotonic camera-intent epoch now invalidates
  pending competitor fits and nuke-camera restores after a locate, drag, zoom,
  whole-map command, disposal, or replacement renderer.
- CAM-02: resize/fullscreen refits untouched automatic cameras, preserves a
  viewer-owned camera, and republishes scorebug/dossier docking geometry in
  both cases. Deferred fullscreen work is tracked, cancelled, and disposal
  guarded.
- INPUT-01: pointer capture, cancellation, lost-capture handling, per-pointer
  release, multi-touch tap suppression, and pinch-to-one-finger continuation
  now share one lifecycle. Safari `gesturestart/change/end` trackpad pinch is
  supported without double-applying iOS pointer gestures.
- ZOOM-01: zoom uses bounded exponential scaling, which is finite and
  directionally monotonic for every delta while preserving cursor anchoring.
- UI-01: the duplicate `pw-gui-hidden`/body-level eye implementation was
  removed. Maxwell's toolbar and `proxywar-hud-hidden` are now the only state
  and control, and that state includes the restored broadcast surfaces.
- UI-02: below 981 px, the scorebug exposes rank, player, and territory only,
  uses breakpoint-bounded rows, and resets an invisible economy sort to visible
  territory order. Broadcast revision is 85.
- Replay rewind lifecycle: the competitor-locate bridge disposer is now owned
  by the renderer so a replaced replay cannot retain a second stale camera
  command path.

### Verification result

- PASS: 113 focused tests across eight input, transform, renderer, bridge,
  cinematic, scorebug, and toolbar suites.
- PASS: three translation-system tests after removing the retired toggle's two
  unused English keys.
- PASS: `npm exec -- tsc --noEmit`.
- PASS: ESLint on every changed TypeScript source and test.
- PASS: final Coworld static-viewer build (`tsc --noEmit` plus Vite); main
  bundle `main-CPxWwWc-.js`, SHA-256
  `f828a28d4f4c853bafb25b562d4ffee801101918e7c3cdd03cc453c2d245efb5`.
- PASS: that exact final bundle served a real 16-agent Pangaea local replay
  `04a01eb0-fa97-423b-89e4-bfc867161e06.replay`. Deep manual framing remained
  on the same world point at screen center after 1280 x 720 to 900 x 700;
  refreshed layout variables reported a 630 x 630 board and 135 px side band.
- PASS: at 740 x 480, the scorebug measured 177.6 px wide with a three-column
  `22px 99.6px 46px` grid, compared with the 246 px five-column baseline.
- PASS: exactly one Hide interface control; after activation the scorebug,
  scrubber, Analyst drawer, identity badge, nuke cinema, following chip, and
  replay end card all had no visible client rect, while one Show interface
  control remained reachable.
- PASS: large negative and positive wheel deltas completed without reversal or
  runaway; browser log contained zero errors and only the expected static
  startup/JWT/hash warnings.
- NOT RUN: genuine Safari hardware pinch and deployed post-repair Coworld
  viewer. Synthetic gesture/pointer tests cover the event contracts.
- NOT RUN: actual local fullscreen transition. The in-app browser denied the
  fullscreen request; deterministic nested-rAF, disposal, and camera-preserve
  tests cover that path, while the deployed baseline proved the original bug.

The broad non-E2E suite ran 5,036 tests: 5,020 passed and 16 failed. One failure
was change-related (the retired toggle's translation keys) and passed after the
repair above. The remaining 15 are outside this diff: eight public-surface
fixtures returned 503, and seven existing server/CLI/map tests exceeded their
5-30 second timeouts. The full-suite gate is therefore not green even though
the changed replay surface is green.

### Residual risk

`ReplayFrameCache` still keys preview frames by turn while copying the current
interactive board canvas. A preview captured before/after a camera gesture or
during nuke cinema may therefore have a different composition from an adjacent
preview. This was not browser-reproduced or profiled in this pass, so it remains
an explicit unverified risk rather than a claimed defect or an excuse for a
speculative cache rewrite.

Independent review is GO with high confidence for the scoped code and final
rebuilt-artifact smoke. A later Coworld release must separately prove the
immutable package version, bundle hash, canonical league binding, and served
replay; this local repair does not establish any of those hosted facts.
