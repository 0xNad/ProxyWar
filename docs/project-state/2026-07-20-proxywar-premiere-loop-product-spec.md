# Proxy War Replay Premiere — Product Specification

Date: 2026-07-20

Status: **proposed implementation target; not yet a live-product or Softmax
capability claim**

Product loop: **Watch → Predict → Mark → Share**

Product thesis:

> Turn completed agent matches into shared, interactive premieres without
> changing the agents, the match, or the authoritative result.

## 1. Executive decision

Proxy War should build a replay-premiere product, not true live games and not a
web agent builder.

The first release takes a completed match and presents it on a shared,
authoritative clock. Viewers can:

1. watch without seeing future turns or the result through Proxy War;
2. predict the winner at two checkpoints during the replay;
3. mark structured moments such as a turning point, mistake, or betrayal; and
4. share a timestamped, spoiler-safe card.

The product question is:

> Do qualified viewers predict, mark, share, and return for another Proxy War
> premiere?

This is a bounded Coworld watchability and league-adoption experiment. It does
not reactivate generic onboarding, an agent studio, or a broad social network.

## 2. Why this is aligned with Softmax

- Policies remain the players.
- Humans remain spectators, analysts, and policy authors outside the match.
- Predictions and reactions never enter the game runtime.
- The rated match, policy inputs, policy outputs, result, and reward remain
  immutable.
- Softmax remains the hosted execution and evaluation substrate; hosted
  inference is used only when selected for a policy.
- Proxy War owns the game-specific identity, explanation, replay presentation,
  and community experience around that evaluation.

Increasing enjoyment is not a rejection of the research thesis. It is useful
when it causes more people to inspect matches, follow agents, discuss evidence,
share moments, or return for another evaluation. Spectacle must never be
presented as evidence that one policy is stronger.

## 3. Evidence and hypotheses

### Known

- Proxy War already mirrors completed Coworld replays, renders them in the real
  game client, exposes decision evidence, and has a dedicated public league
  wrapper. `[repo/file verified]`
- One user specifically asked for a match they could leave open on half of their
  screen while doing something else. `[operator report]`
- The current viewer downloads the full replay and final diagnostics. Merely
  hiding the winner in the UI would not create an honest premiere.
  `[repo/file verified]`
- The replay client emits canonical frame events with turn, ownership,
  alliances, targets, and embargoes. `[repo/file verified]`
- The replay overlay already supports turn navigation, strategic direction,
  events, and a collapsible layout. `[repo/file verified]`

### Hypotheses

1. A scheduled shared viewing time can generate meaningful interaction and
   repeat attendance.
2. Two broad winner predictions help people follow the strategic arc without
   turning the experience into trivia about individual actions.
3. Structured moment markers make the match easier to discuss and package.
4. Timestamped cards bring new qualified viewers into the replay.
5. An ambient half-screen mode increases completion and repeat attendance.

## 4. Product boundaries

### In scope

- Completed replay premieres.
- Authoritative progressive release.
- Two during-replay winner predictions.
- Structured timestamped reactions.
- Ambient viewing mode.
- Timestamp links and spoiler-neutral social cards.
- Fixed-length clips only after the premiere and card loop prove useful.

### Not in scope

- A web agent, no-code agent studio, prompt editor, or policy configurator.
- Automatic policy building, uploading, or Softmax deployment.
- True livestreaming in the first release.
- Human intervention in rated matches.
- Per-action shadow decisions or `LegalAction.id` guessing.
- Open chat or free-text annotation moderation.
- Prediction markets, play money, crypto, prizes, or wagering.
- A prediction-skill leaderboard.
- Claims that the product teaches transferable agent-building skills.
- Replacing or redesigning Softmax Observatory.

## 5. Premiere source and eligibility

Hiding a replay bundle is not enough. Proxy War and Softmax may expose results
through league data, battle cards, replay routes, standings changes, social
metadata, or direct episode pages.

Every premiere requires a machine-readable `PremiereEligibility` record before
it may be scheduled.

### `PremiereEligibility`

- `sourceKind`: `controlled_exhibition` or `rated_coworld`.
- `sourceRunId` and, when applicable, Coworld episode, league, division, and
  round ids.
- Full source replay SHA-256.
- `sourceBundleOutsideServedRoots`: boolean.
- `proxyWarLeakChecks[]`: per-surface evidence records.
- `externalEmbargoEvidence[]`: evidence records or an explicit empty set.
- `externalOutcomeMayBePublic`: boolean.
- Exact seat and namespaced policy identities.
- Authoritative result source and hash.
- Chosen public label: `premiere` or `spoiler_resistant_premiere`.
- Eligibility check version and creation time.

### Source policy

- **Phase 0 uses a controlled, non-public exhibition replay.** This proves the
  premiere mechanics without pretending a public league result can be hidden.
- A rated Coworld replay may be used only after the Proxy War leak audit passes.
  If Softmax or Observatory can expose the result, the event is labelled
  **spoiler-resistant**, not sealed.
- Public copy uses **Replay Premiere** by default. “Sealed replay” is permitted
  only when the source and outcome are embargoed outside Proxy War as well.

Eligibility invariants:

- `externalOutcomeMayBePublic = true` requires the
  `spoiler_resistant_premiere` label.
- The ordinary `premiere` label requires every Proxy War leak check to pass and
  positive external-embargo evidence.
- A missing, stale, or contradictory check makes the source ineligible.

Each leak-check record contains the route/surface kind, tested URL or artifact
key, expected outcome, observed HTTP status and/or content hash, `checkedAt`,
and checker version. External-embargo evidence names its source, scope,
observation time, and verifier.

### Proxy War leak audit

Before scheduling, the check must prove that the premiere source or result is
not exposed through:

- `/league` and its `data.json`;
- battle-card winner or final-standing fields;
- public replay and artifact allowlists;
- `game-record.json`, match summary, result, decision-tail, or diagnostics
  routes;
- server-rendered OpenGraph/X metadata;
- direct source-run watch routes;
- browser or CDN caches from a previous publication; or
- any alternate Proxy War URL derived from the source run id.

External Softmax/Observatory leakage is recorded honestly in eligibility; it
cannot be “fixed” by Proxy War UI copy.

### `PolicyIdentity`

Every seat uses one namespaced identity:

- `softmax_policy_version`: Softmax policy-version UUID, policy name, and
  server-assigned version; or
- `local_manifest`: manifest name, declared version, and manifest/content
  SHA-256.

Eligibility, predictions, markers, cards, clips, and provenance use this union.
A controlled exhibition is never given a synthetic Softmax identity.

## 6. User experience

### 6.1 Before the premiere

The public page shows:

- premiere title;
- start time and countdown;
- participating agents and exact policy versions;
- map and match format;
- whether the event is a controlled premiere or spoiler-resistant rated replay;
- a spoiler-neutral description; and
- an “Add reminder” or copy-link action.

No checkpoint options, active-seat information from future frames, final
standings, winner, score, rating movement, decision tail, or outcome-bearing
metadata is exposed.

### 6.2 Shared playback

- The server owns the authoritative premiere clock and released replay
  sequence.
- A viewer who joins late enters at the shared position.
- A reconnecting viewer catches up to the current released sequence.
- Seeking beyond the released sequence is rejected server-side.
- After reveal, the replay becomes an ordinary seekable replay.
- A viewer may hide nonessential panels and enter ambient mode at any time.
- Before reveal, viewers have no playback-speed control. The fixed premiere
  rate is chosen before publication from the validated `1×`, `2×`, or `4×`
  allowlist; V1 defaults to `2×`.

### 6.2.1 Authoritative timing

- Import assigns every replay sequence a deterministic `presentationOffsetMs`
  from the recorded replay timing and fixed premiere rate.
- During ordinary playback, a sequence is releasable when
  `authoritativeElapsedMs >= presentationOffsetMs`.
- A checkpoint freezes `authoritativeElapsedMs` for its 15-second intermission;
  all subsequent release offsets shift by that pause.
- If the service is unavailable before start, `actualStartAt` becomes the time
  the service is ready; it never skips forward to compensate.
- A mid-premiere outage of at most 60 seconds shifts the remaining schedule by
  the measured outage duration. A longer outage moves the premiere to `failed`
  rather than skipping unseen content.
- Reveal occurs automatically only when the final sequence is released, the
  authoritative presentation offset has elapsed, and the stored result passes
  its integrity check. It does not depend on a viewer reaching the end.

### 6.3 Prediction checkpoints

V1 contains exactly two checkpoints, defaulting to roughly 35% and 65% of the
meaningful replay sequence. They are fixed when the premiere is published.

At each checkpoint:

1. playback enters a 15-second global intermission;
2. the server derives the eligible seats from the state released at that
   checkpoint;
3. the UI asks **“Who will win from here?”**;
4. one prediction per guest participant is accepted and locked server-side;
5. crowd distribution stays hidden until the participant votes or the window
   closes; and
6. playback resumes for every viewer from the same next sequence.

Prediction resolution uses the authoritative winner seat from the replay
result—not a guessed interpretation of scalar scores.

- One unambiguous winner seat: resolve normally.
- No winner because the match reached a cutoff or returned no winner: void.
- Multiple/ambiguous winner identities or an invalid result contract: void.
- A tied score alone does not create a tie outcome unless the game result
  contract explicitly says it does.

V1 records crowd accuracy for the event but does not award points, money, rank,
or prizes.

### 6.4 Structured moment markers

At any released sequence, a participant may mark:

- `turning_point`
- `smart`
- `mistake`
- `betrayal`
- `clip_this`

The interface does not solicit free text. A marker may carry an optional visible
seat/policy context and a derived public event context.

Rules:

- the same participant cannot submit the same marker kind at the same sequence
  twice;
- maximum 30 markers per participant per premiere;
- maximum five marker writes per minute;
- marker writes after archive are rejected; and
- a marker never changes replay playback or policy execution.

Derived `eventContext` may use released replay data only. It must never inspect
or summarize an unreleased sequence.

### 6.5 Ambient mode

Ambient mode is designed for a 640×360 viewport and for a replay occupying
approximately half of a 1280×720 desktop:

- the map remains dominant;
- current leaders, the active checkpoint, and one headline event remain
  visible;
- diagnostics and long transcripts collapse;
- all controls remain keyboard reachable;
- no autoplay audio is required; and
- the layout remains legible in a resizable browser window without relying on
  system picture-in-picture.

### 6.6 Sharing

V1 share output:

- canonical premiere URL;
- optional released sequence/turn anchor;
- permanently spoiler-neutral OpenGraph/X card;
- participating agent names and immutable policy versions;
- match provenance; and
- one-click copy for link plus an editable suggested caption.

The canonical card remains spoiler-neutral even after reveal because social
crawlers cache images and metadata. A later result card must use a new,
versioned post-reveal URL.

Before reveal, a timestamp link joins the current shared position and only
highlights the referenced marker; it cannot seek backward or forward. After
reveal, it opens at the selected sequence.

All cards and later clips must:

- use only Proxy War identity, not inherited OpenFront marks;
- carry required CC BY-SA attribution and a no-endorsement line;
- identify the exact replay and policy versions; and
- use silent or separately owned/licensed audio.

### 6.7 Optional counter challenge export

After reveal, a viewer may copy a plain-text challenge brief containing the
opponent identity, replay URL, selected moment, map, seat count, and match
conditions.

This is an export into the existing code-based agent workflow. It is not a web
agent, and the MVP does not claim that a copied brief produced a completed
policy or Softmax submission.

## 7. Premiere state machine

Allowed transitions:

```text
draft -> scheduled | cancelled
scheduled -> playing | cancelled
playing -> checkpoint | revealed | failed
checkpoint -> playing | failed
revealed -> archived
failed -> archived
cancelled -> archived
```

Rules:

- Only `draft` and `scheduled` premieres can be cancelled.
- An invalid source never leaves `draft`.
- A mid-premiere runtime or integrity failure moves to `failed`, freezes the
  last safe released sequence, rejects new predictions, and never reveals
  future content automatically.
- Public cancellation/failure copy is a fixed sanitized reason code. Raw paths,
  stack traces, platform errors, and validation details remain operator-only.
- Publish, start, reveal, fail, cancel, and archive transitions are append-only
  audit events.

## 8. Progressive replay contract

`turn` alone is not a safe release boundary: several replay records may share a
turn or straddle a renderable state boundary. The server releases immutable,
ordered chunks by sequence.

### `PremiereChunk`

- `premiereId`
- `index`
- `startSequence`
- `endSequence`
- `startTurn`
- `endTurn`
- `presentationOffsetMs`
- `previousChunkHash`
- `payloadHash`
- `byteLength`
- `releasedAt`

### Contract

- Chunks are content-addressed, append-only, and hash-chained.
- A chunk is immutable after publication.
- Repeated reads are idempotent.
- The client applies records strictly by `(chunk.index, sequence)` and ignores
  already-applied records.
- The manifest exposes only released chunk metadata.
- The full source bundle is never under a served root before reveal.
- Before reveal, chunk and manifest responses use `Cache-Control: no-store`.
- Range requests for the private source and unreleased chunks are rejected.
- Symlink, traversal, encoded-path, alternate-extension, and stale-cache escape
  tests must pass.
- The real client must initialize and advance without receiving the final
  record, winner, or future chunks.

No change under `src/core/**` is permitted for progressive playback.

### Fallback

If the real game client cannot consume append-only replay chunks without
exposing the complete record or changing deterministic core, V1 falls back to a
silent, pre-rendered, time-gated video premiere. Video segments follow the same
authoritative clock, hash, cache, checkpoint, and no-future-segment rules. The
interactive real-client replay becomes available only after reveal.

## 9. Data contracts

### `Premiere`

- `id`
- `eligibilityRecordHash`
- `title`
- `scheduledAt`
- `actualStartAt`
- `playbackRate`
- `accumulatedPauseMs`
- `state`
- `finalSequence`
- `releasedSequence`
- `lastReleasedChunkIndex`
- `checkpointIds[]`
- `revealedAt`
- `createdAt`

### `PremiereCheckpoint`

- `id`
- `premiereId`
- `sequence`
- `opensAt`
- `closesAt`
- `questionKind = winner_from_here`
- `optionSeatIds[]`, populated only when the checkpoint opens
- `state`

### `GuestParticipant`

- opaque participant id;
- creation time; and
- abuse/rate-limit metadata kept outside public responses.

The signed guest cookie identifies a browser participant, not a verified human.
No person-level claim may be made from it.

### `Prediction`

- `premiereId`
- `checkpointId`
- `participantId`
- `selectedSeatId`
- `submittedAt`
- `lockedAt`

The unique key is `(checkpointId, participantId)`. An identical retry returns
the existing accepted record; a conflicting second selection returns `409`; a
late write returns `410`.

### `Reaction`

- `id`
- `premiereId`
- `participantId`
- `sequence`
- `turn`
- `kind`
- `policyIdentity | null`
- `eventContext | null`
- `createdAt`

The dedupe key is `(premiereId, participantId, sequence, kind)`.

### `ShareMoment`

- `id`
- `premiereId`
- `sourceReactionId | null`
- `sequence`
- `turn`
- `createdByParticipantId`
- `cardVersion`
- `createdAt`

### `ViewerSession`

- `id`
- `premiereId`
- `participantId`
- connected and visible duration;
- first/last released sequence observed;
- prediction/reaction/share events; and
- optional signed incoming share-attribution token.

## 10. Measurement

### Qualified viewer session

A session is qualified when it is not an operator/admin/bot and either:

- remains connected with the page visible for at least five cumulative minutes;
  or
- submits a valid prediction, reaction, or share action.

One guest participant counts at most once per premiere. This is a browser-level
measure, not a unique-person measure.

### Primary metrics

- percentage of qualified sessions that submit a prediction or marker;
- percentage of pre-start qualified sessions that reach final reveal;
- marker-to-share conversion;
- number of qualified sessions attributed to a shared moment; and
- guest participants who qualify in at least two separate premieres within 30
  days.

### Attribution

- Every share link may contain a signed, non-secret attribution id.
- The receiving first-party viewer session records that source.
- Attribution lasts seven days and uses last non-direct share touch for the
  share-to-view metric.
- Copies into GitHub, local code, or Softmax are not observable completions and
  are reported only as outbound challenge-brief clicks/copies.

### Pilot decision rule

Run three curated premieres.

- The mechanics gate requires zero Proxy War spoiler leaks, no accepted late or
  conflicting votes, and complete provenance.
- If the pilot reaches at least ten qualified guest participants, proceed to a
  clip experiment only if at least four make a prediction/marker and at least
  two return for another premiere **or** a shared moment produces at least one
  new qualified session.
- If ten qualified participants produce zero interactions, zero attributed
  viewers, and zero repeat attendance, stop and diagnose the value proposition.

Passing this gate earns the next experiment. It does not validate broad market
demand.

## 11. Technical approach

### Existing seams

- `src/scripts/coworld-league-mirror.ts` acquires completed Coworld replays.
- `src/client/AiLeagueReplayMode.ts` and `src/client/Main.ts` own replay route
  bootstrap.
- `src/client/LocalServer.ts` owns replay pacing and must consume released
  chunks or be bypassed by the video fallback.
- `src/client/ClientGameRunner.ts` emits canonical replay-frame events.
- `src/client/AiLeagueReplayOverlay.ts` renders events, diagnostics, and turn
  navigation.
- `src/server/GamePreviewBuilder.ts` and `src/server/GamePreviewRoute.ts` own
  server-rendered social metadata.
- `src/server/agents/ProxyWarPublicArtifacts.ts`,
  `CoworldLeagueMirrorCore.ts`, and `CoworldLeagueSiteWriter.ts` are known
  outcome-leak surfaces that Phase 0 must audit.

### New components

- eligibility generator and leak audit;
- private source-bundle staging outside every served root;
- premiere publisher with admin-only transitions;
- chunk builder and authoritative clock;
- prediction/reaction API;
- signed guest participant and rate limiting;
- premiere client controller and overlay;
- viewer/share instrumentation; and
- spoiler-neutral card route.

### Pilot persistence

The single-host pilot uses a storage interface backed by append-only JSONL
events plus atomic session snapshots in a configured private Proxy War state
directory. Requirements:

- one premiere service is the write owner;
- schema/version checks and startup recovery;
- per-session and total byte ceilings;
- no secrets, prompts, or private policy output;
- exact replay/policy provenance; and
- a migration seam to SQLite/Postgres if concurrent scale warrants it.

### Security

- Publisher actions require operator/admin authentication.
- Cookie-authenticated writes require CSRF protection and strict Origin checks.
- Guest cookies are `Secure`, `HttpOnly`, and `SameSite=Lax` in production.
- All ids and paths are allowlisted and containment-checked.
- Source bundles remain outside all static and artifact-serving roots.
- User-controlled strings render as text, never unsafe HTML.
- Predictions and premiere transitions validate current state server-side.
- Existing `LegalAction.id`, validator, runner, and deterministic-core
  boundaries remain unchanged.
- All new user-visible text uses `translateText()` plus English entries in
  `resources/lang/en.json`.

### Storage lifecycle

- Premiere staging and rendering obey the repository’s fixed 25/15/10 GiB
  admission and reserve policy.
- No premiere write may consume the immutable 10 GiB replay reserve.
- Source bundles, chunks, cards, and clips have explicit byte ceilings.
- Cleanup never deletes retained replay/evaluation evidence implicitly.
- Hash references should avoid duplicating an existing private source bundle
  when a contained content-addressed reference is sufficient.

## 12. Acceptance criteria

### Integrity

- No public Proxy War request exposes a future sequence, final result, decision
  tail, or outcome-bearing metadata before reveal.
- Private source traversal, symlink, range, alternate-route, and stale-cache
  tests pass.
- Every public artifact includes source replay hash, run id, seat ids, exact
  namespaced policy identities, and eligibility-record hash; Coworld episode,
  league, division, and round ids are required when applicable.
- Predictions, reactions, and shares never reach game or policy execution.

### Clock and recovery

- Two browsers remain within 1.5 seconds of the authoritative position under a
  normal local/network test.
- A client more than two seconds out of sync resynchronizes automatically.
- A reconnect catches up within five seconds after the page regains network.
- A service restart reconstructs append-only state without duplicate events and
  resumes or fails safely within ten seconds.
- Checkpoint intermissions last 15 seconds ±500 ms from the authoritative
  server clock.
- Pause/checkpoint boundaries never release one extra sequence.

### Writes

- Identical prediction retries are idempotent.
- Conflicting and late predictions return the specified errors and never alter
  the accepted vote.
- Reaction dedupe and rate ceilings are enforced under concurrent clicks.
- Publish, reveal, cancel, fail, and archive transitions reject unauthorized or
  invalid state changes.

### UX

- Countdown, playback, both checkpoints, final reveal, marker, timestamp share,
  late join, reconnect, failure, and archive flows are browser-tested.
- Ambient mode remains legible and operable at 640×360 and at 50% of a
  1280×720 viewport.
- Desktop and narrow/mobile layouts have no inaccessible critical control.
- Public failure states expose no path, stack, token, internal id, or raw
  upstream error.

### Verification

- Focused unit/integration tests cover eligibility, chunk ordering/hashes,
  state transitions, prediction semantics, dedupe, rate limits, persistence,
  and attribution.
- Browser tests cover two synchronized clients and restart/reconnect.
- `npm exec -- tsc --noEmit`, focused tests, lint, and the production build pass.
- The diff contains no change under `src/core/**` and no alternate agent action
  path.

## 13. Delivery phases

### Phase 0 — integrity and playback spike

- Generate one controlled non-public exhibition replay.
- Build its eligibility record and pass the complete Proxy War leak audit.
- Prove append-only real-client playback without shipping the full record.
- Join within five seconds near the end of a representative long replay. If
  replaying all prior records cannot meet that bound, add a supported bootstrap
  snapshot outside `src/core` or select the time-gated video fallback.
- If that fails the integrity gate, prove the time-gated silent-video fallback.
- Prove pause does not leak an additional sequence.

Exit gate: an independent browser/network inspection cannot obtain future
content or the winner through Proxy War.

### Phase 1 — premiere MVP

- Publisher and state machine.
- Shared playback and restart/reconnect behavior.
- Two winner checkpoints.
- Structured markers.
- Final reveal.
- Ambient mode.
- Viewer instrumentation.

Exit gate: all Phase 1 acceptance criteria pass across two browsers.

### Phase 2 — sharing

- Timestamp permalinks.
- Permanently spoiler-neutral OpenGraph/X card.
- Suggested-caption copy.
- Share attribution.
- Optional plain-text counter challenge export.

Exit gate: a pre-reveal share cannot disclose a future sequence or result and a
share-sourced qualified session is attributable first-party.

### Phase 3 — fixed clip experiment

- Fixed 10–15 second clip centered on selected `clip_this` markers.
- Bounded asynchronous queue, quotas, attribution, and retention.
- No general editor.

Exit gate: clip generation respects the storage reserve, contains no inherited
marks/private artifacts, and uses silent or separately owned audio.

### Later — true live viewing

Only pursue ongoing-match streaming if completed-replay premieres demonstrate
repeat demand. This requires a reliable append-only hosted live snapshot/turn
feed and coordination with Softmax.

## 14. Softmax dependencies

Proxy War can independently ship:

- a controlled completed-replay premiere;
- progressive or time-gated playback on Proxy War;
- predictions and structured markers;
- ambient viewing;
- timestamp links and cards; and
- fixed clip generation.

Softmax support is required or needs confirmation for:

- a premiere while a Coworld episode is still running;
- an append-only hosted live snapshot/turn feed;
- result withholding across Observatory and league standings;
- Softmax-native participant identity;
- a platform-owned replay embargo/permalink contract; and
- any Softmax-native prediction or social integration.

## 15. Education and interpretation

This product helps people inspect observable behavior and form evidence-linked
hypotheses. A replay does not establish the causal reason a black-box policy won
or lost, and predictions do not measure agent-building skill.

If Softmax uses “education” to include human builders, that remains a separate
product-definition question:

> What specific human capability should improve, and what evidence would count
> as progress beyond better performance inside Proxy War?

No education or cross-domain transfer claim is part of this release.

## 16. Relationship to existing documents

`docs/betting-feature-task.md` describes a separate, local built-in-nation
play-money prediction product. It is not the implementation brief for this
specification and remains outside the active scope.

This specification does not replace Softmax Observatory. It defines a
Proxy War-owned, game-specific premiere and sharing layer around completed
Coworld evaluation artifacts.
