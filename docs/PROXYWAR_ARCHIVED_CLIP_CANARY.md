# Archived Replay Clip One-Shot Canary Runbook

Status: candidate procedure. Execute only from the exact independently reviewed
release commit. This procedure deploys the reviewed beta wrapper and, after a
literal canary GO, enables anonymous retained-replay Clip generation. It does
not mutate Coworld or read private environment-file contents.

This is a checked command sequence, not a pasteable batch script. Start one
dedicated `zsh`, run the input block first, then execute exactly one command at
a time in the documented order. Record each exit status and required output.
Do not execute the next command unless the current command exits zero and its
literal assertion passes. Code fences group phases for readability; pasting a
whole fence would defeat the release gates because a later command could hide
an earlier failure. The release-enable phase is forbidden unless the standalone
GO-evidence `jq` command has just exited zero in that same shell.

## Contract

The owner-only state for this acceptance transaction is exactly
`<privateStateRoot>/clip-canary-v3.json`. The failed v1 predecessor and the
disarmed, unclaimed v2 attempt remain durably preserved as
`clip-canary-v1.json` and `clip-canary-v2.json`. No command in this release
reads either predecessor except to verify its exact terminal bytes before v3
arm, and no command rewrites, resets, renames, or deletes either file.
`clips:canary` accepts that root only through explicit
`--private-state-root`; it does not read an env file or secret. An arm is bound
to one public `league-*` run key, one renderable bucket, the exact retained
`game-record.json` SHA-256, and an expiry no more than 30 minutes after arm.

The master generation gate `PROXYWAR_CLIPS_ENABLED` is enabled for only the
canary restart through the documented launchd-manager override below; the
private service env remains off and is not edited. Both ordinary generation
surface flags, `PROXYWAR_PREMIERE_CLIPS_ENABLED` and
`PROXYWAR_LEAGUE_CLIPS_ENABLED`, must remain off. The public capability must
therefore remain `false/false`. If either surface flag is on, the server treats
the armed state as a conflict and constructs no Clip service.

`PROXYWAR_CLIPS_FORCE_DISABLED=true` is the manager-only, highest-priority
emergency deny. It is captured before the private env is sourced and overrides
canary, release-manager, and durable-state enables without requiring any state
file write. Keep it latched after a failed durable disable; the core league
continues with all Clip capabilities false.

The `arm` transaction validates the exact hashes and terminal-disarmed schemas
of both immutable predecessor records, stable source bytes and their exact hash,
the canonical Premiere id and sole reveal-public rated-Coworld archive pointer,
the bucket against the record's declared `num_turns`, and absence of both cache
and durable destination files while holding the shared mutation lock, before
the immutable v3 write. Because the true replay terminal is discovered by the
renderer, the operator must independently observe playback beyond the planned
capture tail and choose a safely earlier bucket before arming.
The server repeats the same validation before bind and after bind. Only after
port 8788 binds does the server durably claim it and issue exactly one system
request at `premiereClipRepresentativeAnchorTurn(bucket)`. Claim is at-most-once
authorization, not proof of render success. A claimed restart never requests
again. Render failure has no automatic retry.

## Operator-supplied exact inputs

Set these from reviewed, non-secret paths and retained public replay evidence;
do not source the private service env file:

```bash
set -u
set -o pipefail
PRIVATE_STATE_ROOT=/absolute/reviewed/replay-premiere-private-root
RELEASE_STATE_FILE="$PRIVATE_STATE_ROOT/clip-release-v1.json"
RUNS_ROOT=/absolute/reviewed/ai-league-runs
RUN_KEY=league-coworld-REPLACE_EXACTLY
PREMIERE_ID=prem_REPLACE_EXACTLY
BUCKET=REPLACE_INTEGER
SOURCE_SHA256=REPLACE_64_LOWERCASE_HEX
PRIOR_STATE_SHA256=REPLACE_V2_STATE_64_LOWERCASE_HEX
ROOT_PREDECESSOR_STATE_SHA256=REPLACE_V1_STATE_64_LOWERCASE_HEX
RELEASE_COMMIT=REPLACE_40_LOWERCASE_HEX
RELEASE_TREE=REPLACE_40_LOWERCASE_HEX
RELEASE_BUILD_SHA256=REPLACE_STATIC_BUILD_64_LOWERCASE_HEX
REVIEWED_WRAPPER_SHA256=REPLACE_WRAPPER_64_LOWERCASE_HEX
INSTALLED_WRAPPER="$HOME/Library/Application Support/ProxyWar/bin/start-proxywar-beta.zsh"
WRAPPER_BACKUP=/absolute/release-evidence/start-proxywar-beta.before-v3.zsh
CANARY_GO_EVIDENCE=/absolute/reviewed/canary-go.json
CANARY_GO_EVIDENCE_SHA256=REPLACE_GO_EVIDENCE_64_LOWERCASE_HEX
ORIGIN=http://127.0.0.1:8788
PUBLIC_ORIGIN=https://beta.proxywar.xyz
PREMIERE_LOOP_LABEL="gui/$(id -u)/com.proxywar.premiere-loop"
assert_clip_manager_env_unset() {
  local PW_CLIP_ENV_NAME="$1"
  local PW_CLIP_ENV_VALUE
  PW_CLIP_ENV_VALUE="$(launchctl getenv "$PW_CLIP_ENV_NAME")" || return 1
  test -z "$PW_CLIP_ENV_VALUE"
}
```

Verify the retained source identity before arming:

```bash
test "$(shasum -a 256 "$RUNS_ROOT/$RUN_KEY/game-record.json" | awk '{print $1}')" = "$SOURCE_SHA256"
test "$(shasum -a 256 "$PRIVATE_STATE_ROOT/clip-canary-v1.json" | awk '{print $1}')" = "$ROOT_PREDECESSOR_STATE_SHA256"
test "$(shasum -a 256 "$PRIVATE_STATE_ROOT/clip-canary-v2.json" | awk '{print $1}')" = "$PRIOR_STATE_SHA256"
jq -e '.schemaVersion == 1 and .lifecycle == "disarmed"' \
  "$PRIVATE_STATE_ROOT/clip-canary-v1.json"
jq -e --arg rootPrior "$ROOT_PREDECESSOR_STATE_SHA256" \
  '.schemaVersion == 2 and .lifecycle == "disarmed" and .claimedAt == null and
   .priorStateSha256 == $rootPrior' \
  "$PRIVATE_STATE_ROOT/clip-canary-v2.json"
test "$(git rev-parse HEAD)" = "$RELEASE_COMMIT"
test "$(git rev-parse 'HEAD^{tree}')" = "$RELEASE_TREE"
if ! RELEASE_STATUS="$(git status --porcelain --untracked-files=all)"; then
  echo "Unable to verify release worktree status" >&2
  exit 1
fi
test -z "$RELEASE_STATUS"
test "$(node deploy/mac/proxywar-clips-release-state.mjs build-hash \
  --path="$PWD/static")" = "$RELEASE_BUILD_SHA256"
npm run --silent clips:canary -- status \
  --private-state-root "$PRIVATE_STATE_ROOT" | jq -e \
  '.enabled == false and .claimable == false and .readEnabled == false and
   .record == null and .diagnostic.code == "clip_canary_state_missing"'
curl --fail --silent "$ORIGIN/api/clip-capabilities" | jq -e '.schemaVersion == 1 and .premiereGenerationEnabled == false and .leagueGenerationEnabled == false'
curl --fail --silent "$PUBLIC_ORIGIN/api/clip-capabilities" | jq -e '.schemaVersion == 1 and .premiereGenerationEnabled == false and .leagueGenerationEnabled == false'
```

Before arming, deploy the reviewed wrapper atomically while Clips remain
disabled. Preserve the previous exact bytes for rollback; never overwrite the
backup. The installed file must be owned by the service uid, mode `0755`, and
hash-identical to the reviewed repository file:

```bash
node deploy/mac/proxywar-clips-release-state.mjs disable \
  --path="$RELEASE_STATE_FILE"
launchctl unsetenv PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE
launchctl unsetenv PROXYWAR_CLIPS_RELEASE_OVERRIDE
launchctl unsetenv PROXYWAR_CLIPS_FORCE_DISABLED
launchctl unsetenv PROXYWAR_CLIPS_EXPECTED_COMMIT
launchctl unsetenv PROXYWAR_CLIPS_EXPECTED_TREE
launchctl unsetenv PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256
assert_clip_manager_env_unset PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE
assert_clip_manager_env_unset PROXYWAR_CLIPS_RELEASE_OVERRIDE
assert_clip_manager_env_unset PROXYWAR_CLIPS_FORCE_DISABLED
assert_clip_manager_env_unset PROXYWAR_CLIPS_EXPECTED_COMMIT
assert_clip_manager_env_unset PROXYWAR_CLIPS_EXPECTED_TREE
assert_clip_manager_env_unset PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256
test "$(shasum -a 256 deploy/mac/start-proxywar-beta.zsh | awk '{print $1}')" = "$REVIEWED_WRAPPER_SHA256"
test ! -e "$WRAPPER_BACKUP"
cp -p "$INSTALLED_WRAPPER" "$WRAPPER_BACKUP"
install -m 0755 deploy/mac/start-proxywar-beta.zsh "$INSTALLED_WRAPPER.next"
test "$(shasum -a 256 "$INSTALLED_WRAPPER.next" | awk '{print $1}')" = "$REVIEWED_WRAPPER_SHA256"
mv -f "$INSTALLED_WRAPPER.next" "$INSTALLED_WRAPPER"
test "$(stat -f '%u:%Lp' "$INSTALLED_WRAPPER")" = "$(id -u):755"
test "$(shasum -a 256 "$INSTALLED_WRAPPER" | awk '{print $1}')" = "$REVIEWED_WRAPPER_SHA256"
```

There is no automatic restore. On any failure, stop before the next command. If
the installed wrapper was already replaced, restore `$WRAPPER_BACKUP` through a
new `.next` file, verify its preserved hash/mode/owner, and only then consider a
disabled restart. Every dry-run and restart below supplies the expected wrapper
hash, and its JSON result must report the same
`installedWrapperSha256`.

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
npm run --silent clips:canary -- arm \
  --private-state-root "$PRIVATE_STATE_ROOT" \
  --runs-root "$RUNS_ROOT" \
  --run-key "$RUN_KEY" \
  --premiere-id "$PREMIERE_ID" \
  --bucket "$BUCKET" \
  --source-replay-sha256 "$SOURCE_SHA256" \
  --prior-state-sha256 "$PRIOR_STATE_SHA256" \
  --root-predecessor-state-sha256 "$ROOT_PREDECESSOR_STATE_SHA256" \
  --expires-at "$EXPIRES_AT" | jq -e \
  --arg run "$RUN_KEY" --arg premiere "$PREMIERE_ID" \
  --argjson bucket "$BUCKET" --arg source "$SOURCE_SHA256" \
  --arg prior "$PRIOR_STATE_SHA256" \
  --arg rootPrior "$ROOT_PREDECESSOR_STATE_SHA256" \
  '.enabled == true and .record.schemaVersion == 3 and
   .record.lifecycle == "armed" and .record.runKey == $run and
   .record.premiereId == $premiere and .record.bucket == $bucket and
   .record.sourceReplaySha256 == $source and
   .record.priorStateSha256 == $prior and
   .record.rootPredecessorStateSha256 == $rootPrior'
```

Use the reviewed ordinary restart helper, not `launchctl kickstart -k` and not
the controlled-outage drill:

```bash
assert_clip_manager_env_unset PROXYWAR_CLIPS_FORCE_DISABLED
assert_clip_manager_env_unset PROXYWAR_CLIPS_RELEASE_OVERRIDE
launchctl setenv PROXYWAR_CLIPS_EXPECTED_COMMIT "$RELEASE_COMMIT"
launchctl setenv PROXYWAR_CLIPS_EXPECTED_TREE "$RELEASE_TREE"
launchctl setenv PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256 "$RELEASE_BUILD_SHA256"
launchctl setenv PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE true
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --expected-wrapper-sha256="$REVIEWED_WRAPPER_SHA256" \
  --start-timeout-ms=60000 \
  --ready-url=http://127.0.0.1:8788/league \
  --dry-run
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --expected-wrapper-sha256="$REVIEWED_WRAPPER_SHA256" \
  --start-timeout-ms=60000 \
  --ready-url=http://127.0.0.1:8788/league
```

Immediately prove the public surface is still generation-disabled. The exact
target status may be `pending`, `ready`, or absent after a failed render; the
same endpoint for another bucket and every POST must be 404:

```bash
curl --fail --silent "$ORIGIN/api/clip-capabilities" | jq -e '.premiereGenerationEnabled == false and .leagueGenerationEnabled == false'
curl --fail --silent "$PUBLIC_ORIGIN/api/clip-capabilities" | jq -e '.premiereGenerationEnabled == false and .leagueGenerationEnabled == false'
curl --silent --show-error -o /tmp/proxywar-canary-status.json -w '%{http_code}\n' \
  "$ORIGIN/api/league-runs/$RUN_KEY/clips/$BUCKET"
curl --silent --show-error -o /dev/null -w '%{http_code}\n' \
  "$ORIGIN/api/league-runs/$RUN_KEY/clips/$((BUCKET + 1))"
curl --silent --show-error -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' -d '{"turn":0}' \
  "$ORIGIN/api/league-runs/$RUN_KEY/clips"
curl --silent --show-error --dump-header /tmp/proxywar-public-canary-status.headers \
  -o /tmp/proxywar-public-canary-status.json \
  "$PUBLIC_ORIGIN/api/league-runs/$RUN_KEY/clips/$BUCKET"
curl --silent --show-error --dump-header /tmp/proxywar-public-wrong-status-GET.headers \
  --output /dev/null --write-out '%{http_code}\n' \
  "$PUBLIC_ORIGIN/api/league-runs/$RUN_KEY/clips/$((BUCKET + 1))"
curl --silent --show-error --head \
  --dump-header /tmp/proxywar-public-wrong-status-HEAD.headers \
  --output /dev/null --write-out '%{http_code}\n' \
  "$PUBLIC_ORIGIN/api/league-runs/$RUN_KEY/clips/$((BUCKET + 1))"
curl --silent --show-error --dump-header /tmp/proxywar-public-wrong-mp4-GET.headers \
  --output /dev/null --write-out '%{http_code}\n' \
  "$PUBLIC_ORIGIN/ai-league-runs/$RUN_KEY/clip-v1-$((BUCKET + 1)).mp4"
curl --silent --show-error --head \
  --dump-header /tmp/proxywar-public-wrong-mp4-HEAD.headers \
  --output /dev/null --write-out '%{http_code}\n' \
  "$PUBLIC_ORIGIN/ai-league-runs/$RUN_KEY/clip-v1-$((BUCKET + 1)).mp4"
curl --silent --show-error --dump-header /tmp/proxywar-public-canary-post.headers \
  --output /tmp/proxywar-public-canary-post.json \
  -H 'Content-Type: application/json' -d '{"turn":0}' \
  "$PUBLIC_ORIGIN/api/league-runs/$RUN_KEY/clips"
npm run clips:canary -- status --private-state-root "$PRIVATE_STATE_ROOT"
```

Use a wrong bucket whose public Clip URLs have never been probed. Its four
GET/HEAD responses and the POST must be literal 404, have no `Location`, carry
`Cache-Control: no-store, max-age=0`, and must not report an edge cache HIT.
Retain every header/body file above. Poll the public exact-target status until
`ready`; then require its public MP4 GET and HEAD to be 200 and the public GET
hash/length to match the cache and durable archive. A loopback-only result is
not a canary GO.

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
launchctl setenv PROXYWAR_CLIPS_FORCE_DISABLED true
test "$(launchctl getenv PROXYWAR_CLIPS_FORCE_DISABLED)" = true
launchctl unsetenv PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE
launchctl unsetenv PROXYWAR_CLIPS_RELEASE_OVERRIDE
launchctl unsetenv PROXYWAR_CLIPS_EXPECTED_COMMIT
launchctl unsetenv PROXYWAR_CLIPS_EXPECTED_TREE
launchctl unsetenv PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256
assert_clip_manager_env_unset PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE
assert_clip_manager_env_unset PROXYWAR_CLIPS_RELEASE_OVERRIDE
assert_clip_manager_env_unset PROXYWAR_CLIPS_EXPECTED_COMMIT
assert_clip_manager_env_unset PROXYWAR_CLIPS_EXPECTED_TREE
assert_clip_manager_env_unset PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --expected-wrapper-sha256="$REVIEWED_WRAPPER_SHA256" \
  --start-timeout-ms=60000 \
  --ready-url=http://127.0.0.1:8788/league \
  --dry-run
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --expected-wrapper-sha256="$REVIEWED_WRAPPER_SHA256" \
  --start-timeout-ms=60000 \
  --ready-url=http://127.0.0.1:8788/league
curl --fail --silent "$ORIGIN/api/clip-capabilities" | jq -e '.premiereGenerationEnabled == false and .leagueGenerationEnabled == false'
curl --fail --silent "$PUBLIC_ORIGIN/api/clip-capabilities" | jq -e '.premiereGenerationEnabled == false and .leagueGenerationEnabled == false'
npm run --silent clips:canary -- disarm --private-state-root "$PRIVATE_STATE_ROOT" | jq -e \
  --arg run "$RUN_KEY" --arg premiere "$PREMIERE_ID" \
  --argjson bucket "$BUCKET" --arg source "$SOURCE_SHA256" \
  --arg prior "$PRIOR_STATE_SHA256" \
  --arg rootPrior "$ROOT_PREDECESSOR_STATE_SHA256" \
  '.record.schemaVersion == 3 and .record.lifecycle == "disarmed" and
   .record.runKey == $run and .record.premiereId == $premiere and
   .record.bucket == $bucket and .record.sourceReplaySha256 == $source and
   .record.priorStateSha256 == $prior and
   .record.rootPredecessorStateSha256 == $rootPrior'
test "$(shasum -a 256 "$PRIVATE_STATE_ROOT/clip-canary-v1.json" | awk '{print $1}')" = "$ROOT_PREDECESSOR_STATE_SHA256"
test "$(shasum -a 256 "$PRIVATE_STATE_ROOT/clip-canary-v2.json" | awk '{print $1}')" = "$PRIOR_STATE_SHA256"
test "$(curl --silent -o /dev/null -w '%{http_code}' "$ORIGIN/ai-league-runs/$RUN_KEY/clip-v1-$BUCKET.mp4")" = 404
curl --silent --show-error --dump-header /tmp/proxywar-public-rollback-mp4-GET.headers \
  --output /dev/null --write-out '%{http_code}\n' \
  "$PUBLIC_ORIGIN/ai-league-runs/$RUN_KEY/clip-v1-$BUCKET.mp4"
curl --silent --show-error --head \
  --dump-header /tmp/proxywar-public-rollback-mp4-HEAD.headers \
  --output /dev/null --write-out '%{http_code}\n' \
  "$PUBLIC_ORIGIN/ai-league-runs/$RUN_KEY/clip-v1-$BUCKET.mp4"
```

Both public rollback responses must be literal 404 with no `Location`,
`Cache-Control: no-store, max-age=0`, and no edge cache HIT before restoring
the scheduler. The durable `/premiere/$PREMIERE_ID/clip.mp4` remains 200.

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

## Enable replay-scoped Clips after a GO

Only a complete canary GO authorizes this transaction. Disarm the canary and
remove its manager override first. Then enable the documented release override;
the wrapper translates it into the master and retained league-run generation
gates after sourcing the private env. The live-Premiere generation gate remains
false: replay clipping is keyed by the retained league replay and does not
depend on a live Premiere lifecycle. The child unsets the override name, while
launchd retains the manager value across controlled restarts.

Before setting the release override, quiesce the Premiere loop exactly as in
the canary transaction and confirm no iteration remains. Preserve a
content-addressed `canary-go.json` whose exact commit, run, Premiere id, bucket,
source hash, both predecessor-state hashes, HTTP assertions, artifact hashes,
decode result, visual result, cleanup result, and `verdict: "GO"` have all been
verified.

```bash
npm run --silent clips:canary -- disarm --private-state-root "$PRIVATE_STATE_ROOT" | jq -e \
  --arg run "$RUN_KEY" --arg premiere "$PREMIERE_ID" \
  --argjson bucket "$BUCKET" --arg source "$SOURCE_SHA256" \
  --arg prior "$PRIOR_STATE_SHA256" \
  --arg rootPrior "$ROOT_PREDECESSOR_STATE_SHA256" \
  '.record.schemaVersion == 3 and .record.lifecycle == "disarmed" and
   .record.claimedAt != null and .record.runKey == $run and
   .record.premiereId == $premiere and .record.bucket == $bucket and
   .record.sourceReplaySha256 == $source and
   .record.priorStateSha256 == $prior and
   .record.rootPredecessorStateSha256 == $rootPrior'
test "$(shasum -a 256 "$PRIVATE_STATE_ROOT/clip-canary-v1.json" | awk '{print $1}')" = "$ROOT_PREDECESSOR_STATE_SHA256"
test "$(shasum -a 256 "$PRIVATE_STATE_ROOT/clip-canary-v2.json" | awk '{print $1}')" = "$PRIOR_STATE_SHA256"
test "$(shasum -a 256 "$CANARY_GO_EVIDENCE" | awk '{print $1}')" = "$CANARY_GO_EVIDENCE_SHA256"
jq -e --arg run "$RUN_KEY" --arg premiere "$PREMIERE_ID" \
  --argjson bucket "$BUCKET" --arg source "$SOURCE_SHA256" \
  --arg prior "$PRIOR_STATE_SHA256" \
  --arg rootPrior "$ROOT_PREDECESSOR_STATE_SHA256" \
  --arg commit "$RELEASE_COMMIT" \
  --arg tree "$RELEASE_TREE" --arg build "$RELEASE_BUILD_SHA256" \
  '(keys | sort) == (["artifacts","attributionPassed","bucket","buildSha256",
    "cleanupPassed","commit","decodePassed","http","premiereId",
    "priorStateSha256","rootPredecessorStateSha256","runKey","schemaVersion",
    "sourceReplaySha256","tree","verdict","watermarkPassed"] | sort) and
   .schemaVersion == 1 and .verdict == "GO" and .commit == $commit and
   .tree == $tree and .buildSha256 == $build and .runKey == $run and
   .premiereId == $premiere and .bucket == $bucket and
   .sourceReplaySha256 == $source and .priorStateSha256 == $prior and
   .rootPredecessorStateSha256 == $rootPrior and
   (.http | keys | sort) == (["exactMp4Get","exactMp4Head","exactStatusReady",
    "localCapabilitiesDisabled","postNoStore404","publicCapabilitiesDisabled",
    "wrongMp4GetNoStore404","wrongMp4HeadNoStore404",
    "wrongStatusGetNoStore404","wrongStatusHeadNoStore404"] | sort) and
   ([.http[]] | all(. == true)) and
   (.artifacts | keys | sort) == (["archiveBytes","archiveSha256","cacheBytes",
    "cacheSha256","manifestsEqual","publicBytes","publicSha256"] | sort) and
   (.artifacts.cacheSha256 | test("^[a-f0-9]{64}$")) and
   .artifacts.cacheSha256 == .artifacts.archiveSha256 and
   .artifacts.cacheSha256 == .artifacts.publicSha256 and
   (.artifacts.cacheBytes | type == "number") and .artifacts.cacheBytes > 0 and
   .artifacts.cacheBytes == .artifacts.archiveBytes and
   .artifacts.cacheBytes == .artifacts.publicBytes and
   .artifacts.manifestsEqual == true and .decodePassed == true and
   .watermarkPassed == true and .attributionPassed == true and
   .cleanupPassed == true' "$CANARY_GO_EVIDENCE"
launchctl unsetenv PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE
launchctl unsetenv PROXYWAR_CLIPS_FORCE_DISABLED
assert_clip_manager_env_unset PROXYWAR_CLIPS_FORCE_DISABLED
launchctl setenv PROXYWAR_CLIPS_EXPECTED_COMMIT "$RELEASE_COMMIT"
launchctl setenv PROXYWAR_CLIPS_EXPECTED_TREE "$RELEASE_TREE"
launchctl setenv PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256 "$RELEASE_BUILD_SHA256"
launchctl setenv PROXYWAR_CLIPS_RELEASE_OVERRIDE true
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --expected-wrapper-sha256="$REVIEWED_WRAPPER_SHA256" \
  --start-timeout-ms=60000 \
  --ready-url=http://127.0.0.1:8788/league \
  --dry-run
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --expected-wrapper-sha256="$REVIEWED_WRAPPER_SHA256" \
  --start-timeout-ms=60000 \
  --ready-url=http://127.0.0.1:8788/league
curl --fail --silent "$ORIGIN/api/clip-capabilities" | jq -e \
  '.premiereGenerationEnabled == false and .leagueGenerationEnabled == true'
curl --fail --silent "$PUBLIC_ORIGIN/api/clip-capabilities" | jq -e \
  '.premiereGenerationEnabled == false and .leagueGenerationEnabled == true'
```

The service log for this first restart must contain exactly
`Clip activation source: release_manager`.

If the dry-run, restart, or either capability check fails, this transaction is
NO-GO. Immediately unset `PROXYWAR_CLIPS_RELEASE_OVERRIDE`, run the emergency
disable dry-run and restart below, prove `false/false` locally and publicly,
and only then restore the scheduler. Never leave a release override latent
after a failed enable attempt.

On success, keep the scheduler quiesced through the UI proof and the
manager-to-durable-state restart below. Do not restore it between those steps.

After enablement, verify one retained archived replay and one currently exposed
replay show the Clip control, a fresh permitted bucket can reach `ready`, the
MP4 decodes with watermark and attribution, wrong or unavailable buckets stay
fail-closed, and no worker/Chrome/ffmpeg process survives completion. Live
Premiere lifecycle is never an eligibility requirement for a retained replay.

Only after that post-enable proof, persist the same nonsecret identity in the
owner-only release-state record. Then remove every manager value and perform
one more hash-bound restart. `false/true` after this manager-free restart proves
the durable startup path rather than merely the current login-session manager
environment. A real logout/reboot remains a separate live recovery observation:

```bash
node deploy/mac/proxywar-clips-release-state.mjs enable \
  --path="$RELEASE_STATE_FILE" \
  --commit="$RELEASE_COMMIT" \
  --tree="$RELEASE_TREE" \
  --build-sha256="$RELEASE_BUILD_SHA256"
launchctl unsetenv PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE
launchctl unsetenv PROXYWAR_CLIPS_RELEASE_OVERRIDE
launchctl unsetenv PROXYWAR_CLIPS_FORCE_DISABLED
launchctl unsetenv PROXYWAR_CLIPS_EXPECTED_COMMIT
launchctl unsetenv PROXYWAR_CLIPS_EXPECTED_TREE
launchctl unsetenv PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256
assert_clip_manager_env_unset PROXYWAR_CLIPS_RELEASE_OVERRIDE
assert_clip_manager_env_unset PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE
assert_clip_manager_env_unset PROXYWAR_CLIPS_FORCE_DISABLED
assert_clip_manager_env_unset PROXYWAR_CLIPS_EXPECTED_COMMIT
assert_clip_manager_env_unset PROXYWAR_CLIPS_EXPECTED_TREE
assert_clip_manager_env_unset PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --expected-wrapper-sha256="$REVIEWED_WRAPPER_SHA256" \
  --start-timeout-ms=60000 \
  --ready-url=http://127.0.0.1:8788/league \
  --dry-run
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --expected-wrapper-sha256="$REVIEWED_WRAPPER_SHA256" \
  --start-timeout-ms=60000 \
  --ready-url=http://127.0.0.1:8788/league
curl --fail --silent "$ORIGIN/api/clip-capabilities" | jq -e \
  '.premiereGenerationEnabled == false and .leagueGenerationEnabled == true'
curl --fail --silent "$PUBLIC_ORIGIN/api/clip-capabilities" | jq -e \
  '.premiereGenerationEnabled == false and .leagueGenerationEnabled == true'
```

The service log for this manager-free restart must contain exactly
`Clip activation source: durable_state` and must not contain
`release_manager`. If any durable-state write, manager-absence assertion,
restart, log assertion, or capability check fails, immediately run the
emergency disable transaction below. It first latches the write-independent
manager deny and proves `false/false`; only then does it attempt to write
durable state false. Never leave a failed durable enablement latent.

Only now restore the scheduler with the commands in the rollback section,
require two exit-zero iterations, and recheck `false/true` locally and publicly.

Emergency disable is the inverse controlled transaction:

Before invoking it against a live release, disable/boot out the Premiere loop
and confirm no iteration remains. Restore it only after `false/false` proof.

Every later deployment must begin with these six unsets before installing or
restarting a new release. The wrapper also binds either Clip override to the
expected clean commit, tree, and deterministic `static/` digest; mismatch
keeps the core league process available but forces all Clip gates false.

```bash
launchctl setenv PROXYWAR_CLIPS_FORCE_DISABLED true
test "$(launchctl getenv PROXYWAR_CLIPS_FORCE_DISABLED)" = true
launchctl unsetenv PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE
launchctl unsetenv PROXYWAR_CLIPS_RELEASE_OVERRIDE
launchctl unsetenv PROXYWAR_CLIPS_EXPECTED_COMMIT
launchctl unsetenv PROXYWAR_CLIPS_EXPECTED_TREE
launchctl unsetenv PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256
assert_clip_manager_env_unset PROXYWAR_ARCHIVED_CLIP_CANARY_MASTER_OVERRIDE
assert_clip_manager_env_unset PROXYWAR_CLIPS_RELEASE_OVERRIDE
assert_clip_manager_env_unset PROXYWAR_CLIPS_EXPECTED_COMMIT
assert_clip_manager_env_unset PROXYWAR_CLIPS_EXPECTED_TREE
assert_clip_manager_env_unset PROXYWAR_CLIPS_EXPECTED_BUILD_SHA256
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --expected-wrapper-sha256="$REVIEWED_WRAPPER_SHA256" \
  --start-timeout-ms=60000 \
  --ready-url=http://127.0.0.1:8788/league \
  --dry-run
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --expected-wrapper-sha256="$REVIEWED_WRAPPER_SHA256" \
  --start-timeout-ms=60000 \
  --ready-url=http://127.0.0.1:8788/league
curl --fail --silent "$ORIGIN/api/clip-capabilities" | jq -e \
  '.premiereGenerationEnabled == false and .leagueGenerationEnabled == false'
curl --fail --silent "$PUBLIC_ORIGIN/api/clip-capabilities" | jq -e \
  '.premiereGenerationEnabled == false and .leagueGenerationEnabled == false'
node deploy/mac/proxywar-clips-release-state.mjs disable \
  --path="$RELEASE_STATE_FILE"
launchctl unsetenv PROXYWAR_CLIPS_FORCE_DISABLED
assert_clip_manager_env_unset PROXYWAR_CLIPS_FORCE_DISABLED
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --expected-wrapper-sha256="$REVIEWED_WRAPPER_SHA256" \
  --start-timeout-ms=60000 \
  --ready-url=http://127.0.0.1:8788/league \
  --dry-run
node deploy/mac/proxywar-beta-launchd-restart.mjs \
  --expected-wrapper-sha256="$REVIEWED_WRAPPER_SHA256" \
  --start-timeout-ms=60000 \
  --ready-url=http://127.0.0.1:8788/league
curl --fail --silent "$ORIGIN/api/clip-capabilities" | jq -e \
  '.premiereGenerationEnabled == false and .leagueGenerationEnabled == false'
curl --fail --silent "$PUBLIC_ORIGIN/api/clip-capabilities" | jq -e \
  '.premiereGenerationEnabled == false and .leagueGenerationEnabled == false'
```

Both emergency restart logs must contain no `Clip activation source:` line. If
the durable disable write fails, do not unset
`PROXYWAR_CLIPS_FORCE_DISABLED` or run the second restart; keep the manager deny
latched, retain `false/false`, and escalate the state-root fault.
