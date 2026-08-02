# Director Cut

Product overhaul spec Stage 5. A deterministic, inspectable replay-editing
feature for long matches (today's league games run 10k-50k turns). Director
Cut is **not** a rendered video — it never produces a file — it is a
turn-range speed schedule that drives the existing live Full Replay player,
speeding through quiet stretches and slowing down for readable events so a
10k-50k-turn match plays back as a roughly 5-12 minute default viewing
product. It reuses the "cluster by density, pick what matters" thinking
behind clips V3 (`ReplayPremiereClips.ts`'s bucket/reaction selection) but
deliberately does not duplicate that pipeline's machinery, and it never
invents data: every segment traces back to a real `SpectatorEvent`
(`src/server/agents/DirectorCutPlan.ts:12-51`).

## Server: the plan generator

`src/server/agents/DirectorCutPlan.ts` exports `buildDirectorCutPlan`, a pure
function of a match's recorded decisions/roster/final-state
(`DirectorCutPlanInput`, `DirectorCutPlan.ts:112-120`) — the same input shape
`AgentDramaReport.ts`/`AgentMatchStory.ts` already consume. It is called once
per match in `writeAgentLeagueRunArtifacts`
(`src/server/agents/AgentDecisionLogWriter.ts:405-413`), reusing the
`SpectatorTelemetry` that call already built for `spectator-telemetry.json`
so the plan's segments stay consistent with the other artifacts derived from
the same event stream, and it writes the result to
`director-cut-plan.json` in the run directory
(`AgentDecisionLogWriter.ts:413`).

### Output shape

`DirectorCutPlan` (`DirectorCutPlan.ts:95-110`):

| Field | Meaning |
| --- | --- |
| `segments` | A sorted, gapless, non-overlapping partition of `[0, totalTurns]` — no turn is left uninterpreted. |
| `importantTurnCount` | Sum of every non-`quiet_interval` segment's span — the part of the match treated as narratively load-bearing. |
| `estimatedDurationSeconds` | Best-effort real-time estimate under the module's turns/second assumptions; a display number, not a contract a client must hit. |
| `degraded` | `true` when `finalState` was unavailable, so the final-conflict and any end-of-match elimination segment trace to fewer signals. Never means fabricated. |
| `notes` | Human-readable explanations of degradation or a flat/eventless match. |

Each `DirectorCutSegment` (`DirectorCutPlan.ts:84-93`) is an inclusive
`[startTurn, endTurn]` range with a coarse `speed` (`slow` / `normal` /
`fast`), an `eventReason` enum (`opening`, `expansion_milestone`, `alliance`,
`war_declaration`, `first_strike`, `major_attack`, `treaty_break`, `nuke`,
`elimination`, `final_conflict`, or `quiet_interval`), the peak
`SpectatorEvent.importance` (0-100, 0 for `quiet_interval`), and
`participatingAgents` (display names only — empty for `quiet_interval`).

### Tunable constants (`DirectorCutPlan.ts:127-157`)

| Constant | Value | Reasoning |
| --- | --- | --- |
| `IMPORTANCE_FLOOR` | 60 | Below this, an event never anchors a segment on its own. Matches `AgentSpectatorTelemetry.ts`'s own scoring: "hold" events sit at 8-36 and routine builds at 26-58, while every alliance/attack/nuke/elimination/betrayal scores >= 62 — so the floor cleanly excludes background noise. |
| `MAJOR_IMPORTANCE` | 85 | A segment plays at `slow` once its peak importance reaches this. Betrayals (100), nukes (95), eliminations (90), and formed alliances (92) all clear it; plain attacks (70) and early expansion (65) stay `normal`. |
| `IMPORTANT_SECONDS_BUDGET_FRACTION` | 0.7 | Fraction of the target runtime reserved for non-quiet segments before `selectWindowsWithinBudget` stops admitting candidates. Bounds worst-case duration; the rest of the budget comfortably covers pacing through quiet turns even on a 50k-turn match. |
| `OPENING_TURN_FRACTION` / `OPENING_TURN_CAP` | 0.03 / 250 | Opening segment length: 3% of the match, capped at 250 turns. |
| `FINAL_CONFLICT_TURN_FRACTION` / `FINAL_CONFLICT_TURN_CAP` | 0.05 / 400 | Final-conflict segment length: last 5% of the match, capped at 400 turns. |
| `SLOW_TURNS_PER_SECOND` / `NORMAL_TURNS_PER_SECOND` | 6 / 15 | Readable real-time pace assumptions for `estimatedDurationSeconds`, independent of match length — a viewer needs roughly the same wall-clock time to read one alliance whether it lands at turn 500 of a 10k-turn match or turn 40000 of a 50k-turn one. |
| `MAX_QUIET_TURNS_PER_SECOND` | 600 | Hard ceiling on the derived quiet-interval pace, protecting a near-eventless match from an absurd turns/second number; such a match simply finishes well under the target duration, which is honest, not a defect. |
| `TARGET_DURATION_ANCHORS` | `[10_000, 300]`, `[50_000, 720]` | Target total runtime interpolates linearly between these two turn-count -> seconds anchors and is left uncapped past 50k turns — a match past 50k turns keeps extrapolating past 12 minutes rather than being clamped to a physically-impossible compression target. |

One explicitly-not-attempted trigger: "lead change" (spec Stage 5 item 1)
has no per-turn territory-ownership series anywhere in this pipeline —
`SpectatorAgent` only carries `finalTilesOwned` (the match's last tile
count, not a curve) — and reconstructing one would require a full headless
re-simulation, out of proportion to a lightweight per-match artifact. Major
attacks are used as the closest honestly-derivable proxy instead of
inventing a curve the pipeline doesn't have (`DirectorCutPlan.ts:38-51`).

### Generator pipeline

`buildDirectorCutPlan` (`DirectorCutPlan.ts:163-288`) computes `openingEnd`
and `finalConflictStart` from the constants above, then runs:

1. **`buildCandidateWindows`** (`:330-356`) — buckets every event scoring
   `>= IMPORTANCE_FLOOR` into fixed-width turn windows (`bucketWidth =
   max(10, round(totalTurns / 300))`), keeping each window's peak
   (highest-importance) event and every event it covers.
2. **`anchorAlwaysIncludedEvents`** (`:358-380`) — guarantees
   elimination/nuke/betrayal (`alliance_break` with `tone: "betrayal"`)
   events always anchor a window even if bucket clustering missed one.
   Defensive: these kinds already clear `IMPORTANCE_FLOOR`, so this mainly
   protects against a future scoring change.
3. **`tagFirstStrikes`** (`:410-434`) — the first attack per ordered
   actor/target pair, in turn order, is tagged `first_strike`; every later
   attack between the same pair stays `major_attack`. Mirrors the same
   first-per-pair rule Stage 4's War Room curation already uses.
4. **`applyLeadIn`** (`:440-450`) — spec item 2, "slow lead-ins to important
   events": extends each window's effective start backward by
   `leadInTurns` (= `bucketWidth`), clamped to never precede the opening
   segment.
5. **`selectWindowsWithinBudget`** (`:502-563`) — ranks candidate windows by
   peak importance and keeps them greedily, highest first, until the
   `IMPORTANT_SECONDS_BUDGET_FRACTION` budget derived from
   `targetDurationSeconds` is spent. Runs on individual windows *before*
   merging, and deliberately exempts no importance tier: the doc comment
   cites a real 12-agent, 50,400-turn match with 302 nuke events where an
   unconditional "always keep nukes" carve-out alone reproduced a
   40,000+-turn merged blob, because turn-adjacency stops meaning "one
   continuous beat" once drama is near-continuous. Windows that don't fit
   the budget become `quiet_interval` later — an honest downgrade (the
   turns still play, fast-forwarded, never cut) not a silent omission.
6. **`mergeOverlapping`** (`:452-500`) — spec item 1, "merge overlapping
   windows": sorts the budgeted windows by lead-in start and folds any
   window whose lead-in start falls within `mergeGapTurns` (= `bucketWidth
   * 2`) of the previous window's end into one segment, taking the higher
   peak importance/reason and the union of participating agents.
7. **`buildFinalConflictSegment`** (`:576-608`) — builds a dedicated `slow`
   segment covering `[finalConflictStart, totalTurns]`, importance is the
   max real event importance in that window (floor 50), participants come
   from events in the window or, if none, the full roster.
8. **`fillQuietGaps`** (`:610-665`) — sorts the named segments (opening,
   merged/budgeted windows clamped to `[openingEnd, totalTurns]`, final
   conflict), merges any that now overlap after clamping absorbed part of a
   candidate window, then fills every remaining gap in `[0, totalTurns]`
   with an explicit `quiet_interval` segment (`speed: "fast"`, `importance:
   0`, no participants) so `segments` is a complete, gapless partition.

`estimateDurationSeconds` (`:686-711`) then sums `slow`/`normal` segment
spans at their fixed turns/second rate, derives a quiet-interval pace via
`deriveQuietTurnsPerSecond` (`:667-678`, capped at
`MAX_QUIET_TURNS_PER_SECOND`) from whatever time remains under
`targetDurationSeconds`, and returns the rounded total.

### Verified behavior (`tests/server/DirectorCutPlan.test.ts`)

- Deterministic: identical input produces an identical plan modulo
  `generatedAt` (`:134-152`).
- `segments` always partitions `[0, totalTurns]` with no gaps or overlaps,
  sorted by turn, starting at turn 0 (`:154-193`).
- A ~10,000-turn dramatic match's `estimatedDurationSeconds` lands between
  60 and 420 seconds; a ~50,000-turn dramatic match lands between 300 and
  900 seconds and always exceeds the 10k-turn estimate for the same fixture
  — duration scales with real turn counts, not a hardcoded match size
  (`:389-437`).
- Regression fixture for the exact real-world failure described in
  `selectWindowsWithinBudget`'s doc comment: a synthetic 12-agent,
  50,400-turn match with a nuke roughly every 170 turns (reproducing 302
  nuke events) previously collapsed into one ~41,000-turn segment (56+
  minutes, 82% of the match). The current pipeline keeps
  `estimatedDurationSeconds <= 900` for that fixture and caps any single
  non-`quiet_interval` segment at under 20% of `totalTurns`, while still
  preserving at least one genuine `quiet_interval` (`:439-533`).
- A `finalState`-less input degrades honestly: `degraded: true`, a note
  naming `finalState`, but still a non-empty, non-crashing plan
  (`:299-311`).
- A flat/eventless match produces only `opening` + `quiet_interval` +
  `final_conflict` segments and a note containing "flat" (`:313-340`).
- An empty match (`totalTurns: 0`) returns `segments: []`,
  `estimatedDurationSeconds: 0`, `degraded: true` without crashing
  (`:342-353`).

## Artifact: storage and public exposure

`writeAgentLeagueRunArtifacts` writes `director-cut-plan.json` into the run
directory (`AgentDecisionLogWriter.ts:413`). It is listed in
`proxyWarPublicRunArtifacts` in
`src/server/agents/ProxyWarPublicArtifacts.ts:60`, next to
`spectator-telemetry.json`, `match-summary.json`, etc. The allowlist's doc
comment explains why it is safe to serve publicly
(`ProxyWarPublicArtifacts.ts:37-44`): it is built purely from
`SpectatorEvent[]` data already public via `spectator-telemetry.json` — turn
ranges, a coarse speed tier, an `eventReason` enum, an importance number, and
display names already public elsewhere. It carries no decision reason
strings and no LLM prompt/output — no field `AgentDecisionRecord`/
`DecisionLogEntry` carries privately ever reaches `DirectorCutSegment`.

### League mirror summary (never the full plan)

`CoworldLeagueMirrorCore.ts`'s `buildEpisodeRow` accepts an optional
`directorCut` field — `{ durationEstimateSeconds, segmentCount }` only
(`CoworldLeagueMirrorCore.ts:749-752`) — and folds it into a league episode
row only when present (`:798-800`). The full plan (segments, notes,
participating agents) is never duplicated into `data.json`; it stays a
per-match artifact the client player fetches directly
(`CoworldLeagueMirrorCore.ts:1008-1018`).

`parseDirectorCutPlanSummary` (`CoworldLeagueMirrorCore.ts:1019-1042`) is the
pure parser behind that field: it `JSON.parse`s the raw file, checks
`reportKind === "director-cut-plan"`, and requires a non-negative
`estimatedDurationSeconds` and a non-empty `segments` array, returning
`{ durationEstimateSeconds, segmentCount: segments.length }` on success or
`null` on any malformed shape — never a garbage row. The caller,
`readDirectorCutSummaryFromRunDir` in `scripts/coworld-league-mirror.ts:520-531`,
owns the actual file read and treats a missing file (the common case: the
hosted platform doesn't inline this artifact today, so it's only present for
locally-produced matches) the same as every other optional-artifact path —
tolerant of absence, resolving to `null`.

The public read model exposes the same shape:
`ProxyWarPublicReadModel.ts:165-166` documents `PublicMatch.directorCut` as
`null` when no `director-cut-plan.json` exists for that match yet (e.g. an
older match generated before this feature shipped) — never fabricated.

## Client: playback

`src/client/DirectorCutController.ts` (~215 lines) re-declares the plan's
JSON shape locally (`DirectorCutSegment`/`DirectorCutPlan`,
`DirectorCutController.ts:13-34`) — client code never imports server
modules, the same pattern `AiLeagueReplayOverlay.ts`'s
`normalizeSpectatorTelemetry` already uses for `spectator-telemetry.json` —
and validates it defensively at runtime via `normalizeDirectorCutPlan`
(`:36-64`), which rejects anything missing `schemaVersion: 1`,
`reportKind: "director-cut-plan"`, a numeric `totalTurns`, a non-empty
`segments` array, or a segment with a non-numeric `startTurn`/`endTurn` or
an unrecognized `speed`.

`segmentForTurn` (`:72-94`) binary-searches the sorted, gapless partition to
find the segment covering a given turn in O(log n) — exact because the
server guarantees the partition invariant. `directorCutSpeedForSegment`
(`:117-121`) maps the plan's 3 semantic tiers onto the client's 4 concrete
`ReplaySpeedMultiplier` levels: `slow`/`normal` map directly (both sides
already name these tiers for the same "readable speed" meaning), while
`fast` maps to the client's `fastest` (zero added per-turn delay), not the
client's own `fast` (a 2x-speed, still-delayed tier) — because
`DirectorCutPlan.ts`'s duration estimate assumes quiet stretches can run up
to 600 turns/second, a rate only zero added delay can approach
(`DirectorCutController.ts:96-115`).

### `mountDirectorCutController` contract (`:153-215`)

Listens to the same per-frame `"ai-league-replay-frame"` DOM `CustomEvent`
every other AI League replay subsystem (lower-thirds, diplomacy strip,
social bubbles) already reacts to — dispatched by
`ClientGameRunner.dispatchAiLeagueReplayFrame` with `detail.tick` set to the
turn just rendered — so the controller needs no bespoke `GameView`/canvas
access of its own. On each frame, while enabled, it looks up
`segmentForTurn` and calls `onSpeedChange` (and optional
`onSegmentChange`) only when the turn crosses into a new segment index,
never on every frame.

The returned `DirectorCutControllerHandle` (`:123-143`) guarantees the "Full
Replay unaffected when Director Cut is off" contract:

- `setEnabled(false)` resets speed to `ReplaySpeedMultiplier.normal` (Full
  Replay's own baseline), clears the current segment via
  `onSegmentChange(null)`, and stops reacting to frames — once disabled, the
  controller never touches `ReplaySpeedChangeEvent` again.
- `setEnabled(true, currentTurn)` resyncs to the segment covering
  `currentTurn`, not the opening segment — re-enabling mid-match without
  this would apply turn 0's speed at whatever nonzero turn playback is
  actually at, correcting itself only at the next segment boundary (a real
  bug the test suite regresses against).
- Mounting itself accepts a `currentTurn` option (default 0) for the same
  reason: the plan JSON hydrates asynchronously and playback can already be
  past turn 0 by the time the controller mounts.
- `dispose()` removes the frame listener entirely.

Verified in `tests/client/DirectorCutController.test.ts`: applies the
opening segment's speed immediately on enabled mount (`:121-133`); emits a
speed change only on a segment-index crossing, never every frame
(`:135-169`); does nothing while disabled and never emits a speed change
(`:171-183`); resets to `normal` and clears the segment on disable
mid-playback (`:185-210`); resyncs to the *current* turn's segment (not
turn 0's) both on enabled mount and on re-enable mid-match — with a test
explicitly designed so the masking bug (turn 0 happens to share the same
"fastest" speed) can't hide a hardcoded-to-0 regression (`:212-264`); and
stops reacting to frames after `dispose()` (`:266-278`).

### Wiring into the replay UI

`AiLeagueReplayOverlay.ts` imports `mountDirectorCutController` and
`normalizeDirectorCutPlan` (`:29-33`). `directorCutPlan?: unknown` arrives on
the overlay's input as raw, unvalidated JSON fetched by
`AiLeagueReplayArtifacts.ts`, which requests `director-cut-plan.json`
concurrently with (and independently of) the core replay UI and
`spectator-telemetry.json` fetches — a missing or slow plan must never
suppress the already-bounded replay UI, since Director Cut is a strictly
additive enhancement (`AiLeagueReplayArtifacts.ts:79-88`).

`syncDirectorCutController` (`AiLeagueReplayOverlay.ts:267-286`) mounts one
controller per overlay the first time a valid plan arrives via `hydrate()`
and never re-mounts afterward — from then on the controller owns its own
enabled/disabled state; the toggle button only reads/writes it. It mounts
`enabledByDefault: true` (spec item 3: "Director Cut is the default for
archived matches") and only ever mounts for Full Replay (archived matches),
never for a live match's own real-time timeline, which never wires a
`director-cut-plan.json` into its input at all (`:261-278`).

**UI entry point**: a real toggle button, not just server-plan-presence
gating. `mountAiLeagueDirectorCutToggle` (`AiLeagueReplayOverlay.ts:710-747`)
creates a `<button data-ai-league-director-cut-toggle>` prepended into the
overlay's `.ai-league-header-actions` bar, labeled via
`ai_league_replay.director_cut_on` / `ai_league_replay.director_cut_off`
translation keys and reflecting state through `aria-pressed` and an
`is-on` CSS class. It is created only when a controller has actually
mounted (`directorCutHandle === null` short-circuits — `:715`) — absent
entirely for a match with no plan yet or a legacy bundle with none at all,
never a disabled button that does nothing. Clicking it calls
`directorCutHandle.setEnabled(next, getCurrentTurn())`, passing the current
playback turn so re-enabling resyncs correctly per the contract above. The
button's own visual state is read from `directorCutHandle.isEnabled()`, not
a DOM class, so a re-hydrate that calls the mount function again is a no-op
against the controller's real state.

## Premiere re-watch integration

**Correction (2026-07-31, this stage): the earlier "no integration exists"
claim in this section was wrong** — it was based on grepping
`ReplayPremiereArchiveView.ts`/`ReplayPremierePlayback.ts` alone, which
indeed have zero Director Cut references, but that grep missed the actual
mounting call chain. Traced directly and confirmed live:

- `Main.ts`'s `openArchivedReplayPremiere` (the handler for a revealed/
  archived `/premiere/:id`) calls `this.openAiLeagueReplay(payload.replayRunKey,
  { source: "ai-league-replay" })` — the EXACT SAME function every ordinary
  Full Replay page uses, with the same `artifactBasePath` derivation
  (`/ai-league-runs/${runID}`). That function mounts
  `mountAiLeagueReplayOverlay` and calls
  `loadAiLeagueReplayDetails(artifactBasePath, ...)`
  (`AiLeagueReplayArtifacts.ts:86-88`), which fetches `director-cut-plan.json`
  generically off `artifactBasePath` — nothing in this chain special-cases
  or excludes a premiere-originated call. `AiLeagueReplayOverlay.ts`'s
  `syncDirectorCutController`/`mountAiLeagueDirectorCutToggle` therefore
  mount exactly as they would for a normal archived match, verified live:
  a run with a real `director-cut-plan.json` shows the Director Cut toggle
  button when opened through this same `openAiLeagueReplay` path.
- **Pre-reveal premieres are correctly untouched — verified by tracing the
  other branch.** The live/sealed path (`openReplayPremiere`, used when no
  server-injected archive payload exists yet) uses
  `ReplayPremiereRuntimeController` entirely — it never calls
  `openAiLeagueReplay`, so Director Cut has no path into a still-sealed
  premiere's timeline. The routing between the two paths is a hard
  branch on `readReplayPremiereArchivePayload()`'s presence
  (`Main.ts:771-776`) — the server only ever injects that payload once a
  premiere is revealed/archived, so there is no state where a sealed
  premiere could accidentally take the Director Cut-bearing branch.
- **Real caveat, found while tracing this: only `rated_coworld`-sourced
  premieres get a `replayRunKey` at all.**
  `ReplayPremiereArchiveRouter.ts:816-820` sets `replayRunKey` from
  `publicRunKeyForSourceRunId(summary.sourceRunId)` ONLY when
  `summary.sourceKind === "rated_coworld"` — a `controlled_exhibition`
  -sourced premiere (the local/demo fallback used when the real-league
  queue is empty, and this repo's own Stage 8 premiere fixture) gets
  `replayRunKey: null`, so `openArchivedReplayPremiere` never calls
  `openAiLeagueReplay` at all for it — no underlying replay renders
  behind the archive summary, Director Cut included. This is consistent
  with the rest of the archive view (the whole point of `replayRunKey`
  being nullable is that an exhibition has no durable league-run replay
  to point at), not a Director Cut-specific gap.
- Net effect: Director Cut on premiere re-watch works today for any real,
  `rated_coworld`-sourced revealed premiere whose run directory has a
  `director-cut-plan.json` — which, per the very next bullet, is not
  guaranteed for hosted-mirror-only episodes.
- **The hosted Coworld mirror sync never produces `director-cut-plan.json`
  for remote-only episodes.** `CoworldLeagueSiteWriter.ts:93-97` notes the
  hosted mirror sync (`coworld-league-mirror.ts`) only ever receives
  `inlineRunArtifacts` containing `game-record.json`/`decisions.jsonl` from
  the real remote platform — `director-cut-plan.json` is written by
  `writeAgentLeagueRunArtifacts` for every LOCALLY-produced match, but a
  purely hosted-mirror episode has no local run directory to generate one
  in, so `readDirectorCutSummaryFromRunDir` legitimately resolves to `null`
  for those episodes. Combined with the bullet above, this is the actual
  remaining gap for premiere re-watch: the wiring is real, but a
  `rated_coworld` premiere whose source episode was only ever mirrored
  (never locally produced) still won't show a Director Cut toggle, because
  the plan file was never generated for it.
  ("Lead change" as a segment trigger is a deliberate design omission, not a
  gap — see the pipeline section above for why it's infeasible without a
  fabricated territory curve.)
