# Replay-scoped Clips production release evidence

Date: 2026-07-24
Control owner: Codex
Status: deployed and live-proof complete

## Product result

Clipping is available on retained league replays, not only during a live
Replay Premiere. The ordinary `/ai-league-replay/<run-key>` viewer exposes the
`Social clip` / `Download clip` control whenever the source is eligible. The
archived Premiere page also exposes its Clip control and durable MP4 download.
Premiere generation remains independently disabled; this release intentionally
reports capabilities as `premiereGenerationEnabled=false` and
`leagueGenerationEnabled=true`.

## Exact release identity

- Commit: `91f806131a65b35e3fa3601f70d459ffe3706aa3`
- Tree: `c375e12aa9a5ab02d257b514d9eddebeec8e3ccb`
- Static build SHA-256:
  `24f3ff9c9d58486f2ca574b763444daf31b59491d6277f821a3ec889828f5141`
- Installed wrapper SHA-256:
  `8b11481dc175c39919e7964343fe491348c2480493aaa935d2e576cb2756d627`
- Installed attestation helper SHA-256:
  `7e4aaffe26de13034d1680caf02397f4c5f73ebda766aff214dde7c6e3614cd7`
- Attestation nonce:
  `96f577e6465f9bf60184819ff27630e0387eebe027d181b0300b679147c35b6e`
- Release evidence root:
  `/Users/claude/Library/Application Support/ProxyWar/storage/release-evidence/20260724T1300Z-91f806131-clips-v3`

Both source and release worktrees were clean at the exact release identity
before deployment. No branch was pushed. `[repo/file verified]`

## Verification before deployment

- Attestation, release-state, and restart Node suites: 59/59.
- Runtime configuration Vitest: 6/6.
- V3 canary and canary-runtime suites: 30/30.
- Root TypeScript, Coworld-adapter TypeScript, production build, Prettier,
  wrapper syntax, and diff checks passed.
- ESLint passed with zero errors and 110 inherited warnings.
- Two independent reviewers approved the exact candidate for disabled deploy,
  attestation probe, conditional V3 arm, and public enablement only after the
  literal canary contract passed. `[repo/file verified]`

## V3 one-shot canary

The canary targeted retained run
`league-coworld-2026-07-24T07-30-47-307Z-e8397add`, bucket 62, anchor turn 625,
after playback was independently observed beyond its capture tail. V3 was
claimed once and rendered once.

- Target MP4: 987,854 bytes.
- SHA-256:
  `97b3154d0905f29b3605dfca672cff223bdaa6b8c98996fc02744c6cc60eb4ae`.
- Cache, archive, public target, and public archive bytes were identical.
- Full ffmpeg decode passed; inspected frames showed a playable replay,
  `proxywar.xyz` watermark, OpenFront CC BY-SA 4.0 attribution, and the
  independence notice.
- Wrong bucket 63 returned literal public 404 for GET and HEAD with no redirect
  or edge hit; public generation POST remained unavailable during the canary.
- Cleanup left no worker, Chrome, ffmpeg, or recent `pw-clip-*` residue.
- Content-addressed GO record:
  `canary-go.json`, SHA-256
  `7694265a70d9e0f9a68ab792d1d36910d65d62c254f640074dcbce414e964aa5`.

The mandatory rollback then restored `false/false`, hid the target cache route,
preserved the durable archive, and durably disarmed the claimed V3 state.
`[live verified]`

## Ordinary retained-replay proof after enablement

After the canary and rollback, Control enabled the reviewed release through the
release-manager transaction and used the normal public API—not the canary
path—to request bucket 64 at turn 645 for the same retained replay.

- POST returned bucket 64 pending, then ready after about 35 seconds.
- MP4: 998,030 bytes.
- SHA-256:
  `f3b835a8caf0e55d88fab8292aaf81eb17e390fa09ebbd74134f36c6c43dca9e`.
- Public GET and HEAD returned 200 `video/mp4` with the exact length.
- Full ffmpeg decode passed; an inspected middle frame showed the World replay
  and `proxywar.xyz` watermark.
- No renderer process or recent Clip temporary directory remained.
- The ready status and public MP4 remained available after the manager-free
  restart.

Browser verification separately showed the Clip control on the newest exposed
round-744 ordinary replay
`league-coworld-2026-07-24T11-53-27-295Z-1e1a304e` and on archived Premiere
`prem_bc943dd04de0c5e01ea9af2b`. `[live verified]`

## Durable activation and scheduler recovery

Control wrote strict schema-v2 release state at
`clip-release-v1.json`, removed every Clip manager binding—including the
correct `PROXYWAR_CLIPS_EXPECTED_ATTESTATION_NONCE` name—and performed a fresh
controlled restart.

- Restart: PID/PGID/writer 3408 -> 4893; `forced=false`, ready=true.
- The new log slice contained exactly one
  `Clip activation source: durable_state` and no `release_manager` line.
- The beta launchd service exposed no Clip manager binding.
- Local and public capabilities both remained exactly `false/true`.
- The Premiere scheduler was re-enabled and bootstrapped. Its first iteration
  reconciled and released an expired Premiere; its second iteration was idle.
  Both exited zero, with no new stderr.
- Post-scheduler local/public capabilities stayed `false/true`, and the newest
  ordinary replay still showed the Clip control.

This proves the durable startup path without relying on the current launchd
manager environment. A literal logout or host reboot was not performed and
remains a separate recovery observation; it is not evidence missing from the
completed in-place release transaction. `[live verified]`

## Rollback

The write-independent emergency deny remains
`PROXYWAR_CLIPS_FORCE_DISABLED=true`, followed by a controlled restart and
literal `false/false` proof before attempting to write durable state disabled.
The complete inverse transaction is preserved in
`docs/PROXYWAR_ARCHIVED_CLIP_CANARY.md`.
