# Archived Replay Clip One-Shot Canary Runbook

Status: candidate procedure. Execute only from the exact independently reviewed
release commit. This control does not deploy code, mutate Coworld, read private
environment files, or enable anonymous Clip generation.

## Contract

The owner-only state is exactly `<privateStateRoot>/clip-canary-v1.json`.
`clips:canary` accepts that root only through explicit
`--private-state-root`; it does not read an env file or secret. An arm is bound
to one public `league-*` run key, one renderable bucket, the exact retained
`game-record.json` SHA-256, and an expiry no more than 30 minutes after arm.

The master emergency gate `PROXYWAR_CLIPS_ENABLED` is enabled for only the
canary restart through the documented launchd-manager override below; the
private service env remains off and is not edited. Both ordinary generation
surface flags, `PROXYWAR_PREMIERE_CLIPS_ENABLED` and
`PROXYWAR_LEAGUE_CLIPS_ENABLED`, must remain off. The public capability must
therefore remain `false/false`. If either surface flag is on, the server treats
the armed state as a conflict and constructs no Clip service.

An armed target is source-validated before bind and again after bind. Only
after port 8788 binds does the server durably claim it and issue exactly one
system request at `premiereClipRepresentativeAnchorTurn(bucket)`. Claim is
at-most-once authorization, not proof of render success. A claimed restart
never requests again. Render failure has no automatic retry.

## Operator-supplied exact inputs

Set these from reviewed, non-secret paths and retained public replay evidence;
do not source the private service env file:

```bash
PRIVATE_STATE_ROOT=/absolute/reviewed/replay-premiere-private-root
RUNS_ROOT=/absolute/reviewed/ai-league-runs
RUN_KEY=league-coworld-REPLACE_EXACTLY
PREMIERE_ID=prem_REPLACE_EXACTLY
BUCKET=REPLACE_INTEGER
SOURCE_SHA256=REPLACE_64_LOWERCASE_HEX
ORIGIN=http://127.0.0.1:8788
PREMIERE_LOOP_LABEL="gui/$(id -u)/com.proxywar.premiere-loop"
```

Verify the retained source identity before arming:

```bash
test "$(shasum -a 256 "$RUNS_ROOT/$RUN_KEY/game-record.json" | awk '{print $1}')" = "$SOURCE_SHA256"
npm run clips:canary -- status --private-state-root "$PRIVATE_STATE_ROOT"
curl --fail --silent "$ORIGIN/api/clip-capabilities" | jq -e '.schemaVersion == 1 and .premiereGenerationEnabled == false and .leagueGenerationEnabled == false'
```

Stop new Premiere admissions before the restart transaction. Preserve the
plist and scheduler data; unload rather than delete it:

```bash
launchctl print "$PREMIERE_LOOP_LABEL"
launchctl disable "$PREMIERE_LOOP_LABEL"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.proxywar.premiere-loop.plist"
! launchctl print "$PREMIERE_LOOP_LABEL"
```

Confirm no `replay-premiere-loop.ts` iteration remains before proceeding.

## Arm and activate

Use a short explicit expiry (20 minutes shown; the parser rejects more than 30):

```bash
EXPIRES_AT="$(date -u -v+20M '+%Y-%m-%dT%H:%M:%S.000Z')"
npm run clips:canary -- arm \
  --private-state-root "$PRIVATE_STATE_ROOT" \
  --run-key "$RUN_KEY" \
  --bucket "$BUCKET" \
  --source-replay-sha256 "$SOURCE_SHA256" \
  --expires-at "$EXPIRES_AT"
```

Use the reviewed ordinary restart helper, not `launchctl kickstart -k` and not
the controlled-outage drill:

```bash
launchctl setenv PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE true
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --ready-url=http://127.0.0.1:8788/league \
  --dry-run
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --ready-url=http://127.0.0.1:8788/league
```

Immediately prove the public surface is still generation-disabled. The exact
target status may be `pending`, `ready`, or absent after a failed render; the
same endpoint for another bucket and every POST must be 404:

```bash
curl --fail --silent "$ORIGIN/api/clip-capabilities" | jq -e '.premiereGenerationEnabled == false and .leagueGenerationEnabled == false'
curl --silent --show-error -o /tmp/proxywar-canary-status.json -w '%{http_code}\n' \
  "$ORIGIN/api/league-runs/$RUN_KEY/clips/$BUCKET"
curl --silent --show-error -o /dev/null -w '%{http_code}\n' \
  "$ORIGIN/api/league-runs/$RUN_KEY/clips/$((BUCKET + 1))"
curl --silent --show-error -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' -d '{"turn":0}' \
  "$ORIGIN/api/league-runs/$RUN_KEY/clips"
npm run clips:canary -- status --private-state-root "$PRIVATE_STATE_ROOT"
```

When ready, `GET|HEAD /ai-league-runs/$RUN_KEY/clip-v1-$BUCKET.mp4` is the
only canary cache document. The archive pointer for `$PREMIERE_ID` must name the
same rated Coworld source run, and the durable promotion must appear at both
`$PRIVATE_STATE_ROOT/archive-v1/clips/$PREMIERE_ID.mp4` and
`GET|HEAD /premiere/$PREMIERE_ID/clip.mp4`. Verify the cache and durable MP4
hashes match, the render manifest names `$RUN_KEY` and `$SOURCE_SHA256`, full
decode succeeds, the watermark/end slate is present, no renderer process
remains, and disk/quota telemetry is sound. A claimed state or HTTP 200 alone
is insufficient evidence.

## Roll back

Disarm is durable and idempotent. It preserves target, arm, claim, and disarm
timestamps. Then use the same ordinary helper so the cache stays intact but no
canary service serves it:

Remove the launchd-manager override before restarting. The installed wrapper
unsets the override inside the child after translating it to the ordinary
master gate, so the server cannot use it as a separate hidden capability.

The mutation lock has one conservative crash-recovery path. The CLI removes it
only when it is an exact bounded schema-v1 record, a non-symlink regular file
owned by the service uid with mode `0600` and one link, its recorded pid is
confirmed absent, and the path still names the same inode immediately before
unlink. It then fsyncs the private-state directory and retries exclusive lock
creation exactly once. Do not manually remove a lock that fails these checks.

Node does not expose an atomic compare-and-unlink operation. Recovery therefore
rechecks the root and pathname after the asynchronous pid probe, with its final
`lstat` immediately before `unlink`. Normal release keeps its owned descriptor
open, compares that inode to the pathname immediately before unlink, and checks
that the owned inode has zero links afterward. A replacement observed by either
check is preserved and returns an uncertainty error. The `0700` private root
limits this race to the service uid, but a malicious or concurrent same-uid
actor can still swap the pathname in the final `lstat`-to-`unlink` syscall
window. The post-unlink link check can detect some such swaps but cannot restore
a replacement already removed in that irreducible window. Treat any uncertainty
diagnostic as a stop condition, not permission to retry.

- `clip_canary_mutation_lock_owner_pid_live` also covers a reused pid: another
  process currently answers for the recorded pid, so disarm did not run.
- `clip_canary_mutation_lock_owner_pid_unverifiable` includes `EPERM` and probe
  failures. Treat ownership as live; disarm did not run.
- `clip_canary_mutation_lock_malformed`,
  `clip_canary_mutation_lock_symlink`,
  `clip_canary_mutation_lock_not_regular`,
  `clip_canary_mutation_lock_hardlinked`,
  `clip_canary_mutation_lock_wrong_owner`,
  `clip_canary_mutation_lock_wrong_mode`,
  `clip_canary_mutation_lock_too_large`, or
  `clip_canary_mutation_lock_read_failed` identifies an unverifiable or foreign
  lock. Preserve it for operator inspection.
- `clip_canary_mutation_lock_changed_during_recovery` or
  `clip_canary_mutation_lock_retry_blocked` identifies a concurrent path/inode
  change or a new lock winning the single retry. Stop; do not loop disarm.
- `clip_canary_mutation_lock_recovery_uncertain`,
  `clip_canary_mutation_lock_cleanup_uncertain`, or
  `clip_canary_mutation_lock_release_uncertain` means filesystem durability or
  ownership is uncertain. Stop the service and inspect the private-state
  directory before any retry.

```bash
npm run clips:canary -- disarm --private-state-root "$PRIVATE_STATE_ROOT"
launchctl unsetenv PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --ready-url=http://127.0.0.1:8788/league \
  --dry-run
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --ready-url=http://127.0.0.1:8788/league
curl --fail --silent "$ORIGIN/api/clip-capabilities" | jq -e '.premiereGenerationEnabled == false and .leagueGenerationEnabled == false'
test "$(curl --silent -o /dev/null -w '%{http_code}' "$ORIGIN/ai-league-runs/$RUN_KEY/clip-v1-$BUCKET.mp4")" = 404
```

Restore the scheduler only after rollback proof:

```bash
launchctl enable "$PREMIERE_LOOP_LABEL"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.proxywar.premiere-loop.plist"
launchctl print "$PREMIERE_LOOP_LABEL"
```

If claim, source validation, quota, disk floor, renderer, manifest, promotion,
or restart validation fails, do not re-arm or retry the render. Record the
fixed canary diagnostic, disarm, perform the ordinary rollback restart, and
retain both the state record and Clip cache for inspection.
