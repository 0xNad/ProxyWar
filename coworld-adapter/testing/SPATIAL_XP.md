# Spatial Observation Matched XP Contract

This experiment is a separate release train from StrategicCommander. Do not
merge, upload, bind, or deploy it until Control confirms the Commander A/B/C
baseline artifacts are sealed.

## Arms and source identity

Build all three arms from one checked-out source commit and one rendered canonical
Coworld manifest/image. The Experience Request schema selects a `coworld_id`
but cannot override runnable environment variables, so the arms must be three
fresh, uniquely named, noncanonical Coworld packages:

- `proxywar-spatial-xp-off`: the spatial flags are absent (the production
  default).
- `proxywar-spatial-xp-structured`:
  `PROXYWAR_TUNE_SPATIAL_OBSERVATION=1` is set and
  `PROXYWAR_TUNE_SPATIAL_MINIMAP` is absent. This isolates the structured
  schema-5 parent from the minimap child.
- `proxywar-spatial-xp-on`: both
  `PROXYWAR_TUNE_SPATIAL_OBSERVATION=1` and
  `PROXYWAR_TUNE_SPATIAL_MINIMAP=1` are set.

Release-contract amendment: the 2026-08-16 design draft proposed unflagged L1
`mapInfo`, but this train's newer default-OFF/Commander-isolation requirement
controls. L1 remains behind the parent spatial flag so the OFF arm stays
byte-identical. In both enabled arms every game-backed request, including spawn/no-land,
must carry `mapInfo`; L2-L5 geometry begins only after land exists.

Generate each local-only, upload-blocked candidate manifest without editing the
canonical template:

```sh
npm --prefix coworld-adapter run build:spatial-xp-manifest -- \
  --arm=off --source-sha="$EXACT_SOURCE_SHA" \
  --input=/absolute/path/canonical-rendered.json \
  --output=/absolute/path/proxywar-spatial-xp-off.json
npm --prefix coworld-adapter run build:spatial-xp-manifest -- \
  --arm=structured --source-sha="$EXACT_SOURCE_SHA" \
  --input=/absolute/path/canonical-rendered.json \
  --output=/absolute/path/proxywar-spatial-xp-structured.json
npm --prefix coworld-adapter run build:spatial-xp-manifest -- \
  --arm=on --source-sha="$EXACT_SOURCE_SHA" \
  --input=/absolute/path/canonical-rendered.json \
  --output=/absolute/path/proxywar-spatial-xp-on.json
```

The generator rejects unresolved manifest placeholders and requires the
supplied 40-lowercase-hex source SHA to match the rendered release-provenance
page exactly. Its output deliberately records `status=unverified` and
`upload_blocked=true` for image authority. This is an operational release-policy
hard stop, not a claim that the JSON is technically impossible to upload with an
uncontrolled client.

### Image authority blocker

The rendered manifest's image strings and any locally written Docker inspection
document are caller-controlled diagnostics. Neither is a sealed or authentic
Coworld statement. Before package upload, register the exact game, runnables,
and commissioner OCI images in eval-only, never-seated attestation policies.
Then fetch all three image records independently from the Coworld authority.
Each fetched record must have the exact role name and be `ready`. Coworld's
`client_hash` must equal the local Docker image ID for the exact manifest tag.
Coworld's `image_digest` is a separate immutable server-side digest: record it,
but never mislabel it as or require it to equal the local Docker ID. Raw
Coworld responses do not attest platform or source revision. Those facts come
from the exact raw `docker image inspect` bytes joined through
`Docker Id == Coworld client_hash`. A failed or pending image reservation is
never admissible and must not be referenced.

The checked-in finalizer first requires its own tracked checkout to be clean and
its Git `HEAD` to equal `--source-sha`; it records the exact Git tree. It reads
the canonical manifest template directly from that checkout, requires its exact
bytes to match the `HEAD` Git blob, decodes them as strict UTF-8, and
deterministically renders the three source-tagged image names, source revision,
and eval package version. It never accepts a canonical-manifest path or hash
from the caller. It then fetches the raw Coworld responses by exact image ID,
runs Docker inspection against those exact rendered tags, deterministically
builds all three arms in one process, generates the fetch time, and hashes every
exact byte stream. It also records the resolved Coworld client package version
and command vectors. For every verified Docker ID, it derives
`repository@sha256:<digest>`, independently inspects that exact immutable
reference, and records the result. It accepts no
caller-authored response path, response hash, inspection path, inspection hash,
or fetch timestamp. The generated
`proxywar-spatial-verified-image-receipt-v1` receipt records the authority split,
exact source SHA/tree, all three roles, local tag, linux/amd64 platform, OCI
revision, Coworld image ID/name/version/status/client hash/server digest, local
Docker ID, raw-artifact hashes, and explicit nonmutation of the canonical
package/league. It also binds the canonical template Git blob and SHA-256, the
rendered canonical byte hash, and the exact blocked-manifest byte hash for every
arm. The verified manifests replace every game, player, optimizer, and
commissioner source tag with its verified `repository@sha256:<digest>`
reference; no mutable tag survives into an upload candidate.
Compute the SHA-256 of the exact receipt bytes; a semantically equivalent
rewrite is a different receipt.

Only the checked-in fail-closed finalizer may derive upload-blocked and verified
upload candidates from the exact checked-in canonical template:

```sh
npm --prefix coworld-adapter run finalize:spatial-xp-manifest -- \
  --source-sha="$EXACT_SOURCE_SHA" \
  --output-dir=/absolute/path/fresh-spatial-xp-output \
  --evidence-dir=/absolute/path/fresh-spatial-xp-authority-raw \
  --coworld-game-id="$EXACT_GAME_IMAGE_ID" \
  --coworld-runnables-id="$EXACT_RUNNABLES_IMAGE_ID" \
  --coworld-commissioner-id="$EXACT_COMMISSIONER_IMAGE_ID"
```

One invocation writes all three upload-blocked manifests, all three verified
manifests, their one shared receipt, and the exact rendered canonical manifest.
The finalizer reruns parity after immutable-reference substitution and enforces
the causal arms exactly: OFF has neither spatial flag, STRUCTURED has
`PROXYWAR_TUNE_SPATIAL_OBSERVATION=1` and no minimap flag, and ON has both
spatial flags set to `1`. A machine parity gate removes only the exact arm name,
arm-description suffix, two spatial flags, and exact readme arm marker, then
requires the remaining manifests to be byte-identical. It rejects stale source,
wrong role names or requested image IDs, cross-arm environment/variant/protocol/
result/certification/image drift, non-linux/amd64 images,
missing/duplicate roles or Coworld image IDs, non-ready status, a local Docker
ID that differs from Coworld `client_hash`, or an internally generated arm whose
hard-stop marker is not exact.
Its output records `status=verified`, `upload_blocked=false`, receipt
SHA-256/fetch time, and all three Coworld image identities/hashes/digests.
Manual JSON editing is not an upload path.

Before upload, a second independent actor must rerun the exact one-shot
finalizer command from its own clean exact-SHA checkout into fresh, previously
nonexistent output/evidence paths. It must regenerate the canonical rendering
from its own checked-in template; it must not accept the first actor's rendered
file, template path, or hash.
Compare the two receipts after removing only `fetchedAt`: `sourceSha`,
`sourceTree`, the entire `manifestAuthority` object, the entire `generatedFrom`
object (including Coworld client version and raw version hash),
`canonicalPackageOrLeagueMutation`, and every image field—including both raw
artifact hashes—must be byte-identical. The second actor must also recompute the
SHA-256 of every raw artifact (including each immutable-reference inspection),
rendered canonical manifest, blocked manifest, and receipt from disk and match
the recorded values. Use the independently generated manifest set and receipt
for upload. Merely accepting paths or hashes supplied by the first actor is not
independent acceptance. If the fresh fetch differs or Coworld exposes no
independently fetchable record, report the external blocker instead of
relabeling local evidence.

Upload each arm only through the checked-in transition wrapper, one arm at a
time. The evidence directory must be a fresh path under the canonical
checkout's `coworld-adapter/tmp` directory so local Docker certification uses
the supported host mount. The wrapper revalidates the clean exact source,
receipt, canonical template Git blob, all three verified arms, and all
immutable Docker references. It independently rerenders the canonical bytes
from the checked-in template and rebuilds every blocked arm, requiring exact
byte equality rather than trusting the receipt's own hashes.
Each arm receives the same deterministic PEP 440 post-release version derived
from all 160 bits of the exact source SHA. This prevents a quarantined partial
upload from one source revision from occupying the corrected successor's
name/version while preserving exact cross-arm version parity.
It then builds the exact-source replay viewer into a private staging directory
and runs Coworld certification against the selected digest-reference manifest
from the canonical checkout's adapter working directory before making any
hosted mutation. This working-directory pin is required on the current host:
Coworld selects its Docker bind-mount root from process cwd rather than
`TMPDIR`. The wrapper persists certification stdout and stderr even on failure:

```sh
npm --prefix coworld-adapter run upload:spatial-xp-manifest -- \
  --arm=off --source-sha="$EXACT_SOURCE_SHA" \
  --input-dir=/absolute/path/independently-regenerated-spatial-output \
  --evidence-dir=/Users/claude/Documents/proxywar_main/coworld-adapter/tmp/spatial-off-upload-transition
```

Repeat only after the prior arm's transition, hosted certification, and hosted
smoke are accepted. The wrapper pins the exact Coworld client version from the
receipt. Immediately before upload it re-fetches and requires the exact
canonical `proxywar` package `cow_f58621db-4a09-47de-bb13-24d61050a837` at
version `0.1.54` and the paused production league
`league_cb60d526-ecfd-4836-ab3a-81fc6cf7dc42`, whose `coworld_id` and
`canonical_coworld_id` must both remain that package. It repeats and
byte-compares both authority records after the eval package and image checks.
Thus `canonicalPackageOrLeagueMutation=false` is a verified transition result,
not a caller assertion.

Immediately after each upload, fetch the stored Coworld package with the same
pinned Coworld client version. Every stored game/player/optimizer/commissioner
image field must equal the receipt's exact role-specific `img_...` ID, and fresh
`coworld images <id> --json` records must match the receipt's name, version,
ready status, client hash, and Coworld image digest. Persist the exact response
bytes and hashes. Stored-manifest equality admits only Coworld's observed exact
normalizations: digest references become the receipted image IDs, the replay
bundle path becomes its immutable SHA-256, and commissioner entries acquire
empty `env` and `run` defaults. Any non-empty or additional mutation fails.
A mismatch leaves that noncanonical package quarantined and
blocks certification, hosted smoke, policy creation, and XP; it is never
accepted because upload returned success alone.

Record the candidate source commit, all three image client hashes/config
digests/immutable digests, receipt hash, all three blocked and verified manifest
hashes, all three Coworld package IDs, certification jobs, hosted smoke episode
IDs, policy version IDs, and Experience Request IDs. No package may replace the
canonical `proxywar` package or be bound to the league.

## Legitimate player-visible state

The only admitted visibility model is
`global-lockstep-public-map-v1`. Current ProxyWar/OpenFront play has no
player-private fog layer: every human client receives the same ownership,
terrain, structure, and combat state used by the renderer. The extension may
summarize only that common state:

- the observing player's regions, borders, coastline, centroid, compactness,
  and active completed defense posts;
- public player identities, ownership borders, relative bearing and distance,
  public alliances, and observer-relative live attack state already present in
  the observation;
- the public map name/dimensions and exact top-left row-major coordinate frame;
- plains/highland/mountain counts plus overlapping shore count on each shared
  front, and exact covered/uncovered front counts from completed own defense
  posts;
- active, completed, nondeleted Defense Posts, Cities, Ports, and Warships for
  the owner plus players already in `visiblePlayers`, capped at eight per
  player and 48 per asset class with explicit totals/truncation;
- exact rival-rival border weights, the observer's largest-neighbor border
  share, rival transport-reachable observer shore count, and nearest completed
  rival-port bearing/distance;
- the same public ownership/terrain grid reduced deterministically to 24x12 or
  adaptive 32x16, plus at most 24 completed-public structure/warship markers.

The minimap legend contains exact `glyph`, `playerID`, and `isYou` fields only.
It deliberately omits redundant display names: the observing name remains in
`username`, and every rival name remains in `visiblePlayers` under the same
exact player ID. IDs and glyphs are never truncated or rewritten. Schema `5`
uses minimap schema `2`: separate ownership and terrain rows plus exact-roster
bound `D`, `C`, `P`, and `W` markers. The normalized child has a 4 KiB ceiling;
the 25-seat fixture retains every exact eight-character player ID and glyph
without display-name duplication.

It must not expose seeds, command queues, private agent memory or prompts,
future intents, hidden server state, or any field from a future fog/private
visibility implementation. Introducing player-relative visibility requires a
new contract and adapter; reusing this visibility-model identifier must fail
closed.

The extension adds context only. It cannot add or rewrite a `LegalAction`,
become an action ID, emit raw OpenFront intents, or bypass the canonical
`AgentDecisionValidator -> AgentRunner -> GameServer` path.

## Hard local gates

The checked-in benchmark and prompt matrix enforce these exact ceilings:

| Measure                          |      Ceiling |
| -------------------------------- | -----------: |
| Snapshot p95                     |        25 ms |
| Snapshot transient heap          |       32 MiB |
| Snapshot retained heap           |        1 MiB |
| Minimap-ON retained heap         |        1 MiB |
| Serialized stage-one observation |       16 KiB |
| Serialized minimap               |        4 KiB |
| Spatial prompt increment         |       24 KiB |
| Estimated prompt-token increment | 8,192 tokens |
| 16-seat all-on prompt growth     |          10% |

The off arm must remain byte-identical to pre-spatial observation and starter
telemetry. The structured arm must emit the same deterministic schema-5 parent
as full ON while omitting its minimap child. The on arm must add only the
bounded deterministic schema-2 minimap. Both enabled arms must stay within the
table above and be accepted by the public-source-of-truth starter only when
schema `5` and the exact visibility model are present. The starter also retains
strict schemas `1`/`3` backward compatibility, but only schema `5` carries
weighted/naval L4 and terrain/marker minimap L5.

## Hosted matched proof gate

Use identical map, seed, player roster, frozen policy versions, episode index,
and balanced seats in all three arms. Before claiming a useful behavioral effect,
retain evidence that:

1. the off arm reports no spatial state; the structured arm reports schema `5`
   with no minimap; and the on arm reports schema `5`,
   the exact visibility model, coordinate frame, terrain/coverage, completed
   public positioned assets, weighted rival/naval exposure, and the adaptive
   ownership/terrain/marker minimap;
2. all three arms receive the same offered legal-action IDs at each matched state;
3. any changed choice is still an exact offered ID and is accepted through the
   canonical validator/runner path;
4. replay/game effects correspond to that validated choice; and
5. prompt/decision artifacts stay within their configured privacy and size
   bounds.

Local serialization, inertness, and starter tests are necessary but are not a
substitute for fresh certification, hosted smoke, or a real-model matched
gameplay result. A null or harmful result must be retained and reported.

Each hosted arm must use its exact bounded self-report mode; generic `present`
can also admit backward-compatible schema `1` and is not sufficient:

```sh
node owner-evidence-check.mjs --deals=optional --messages=optional \
  --spatial=absent owner-evidence/spatial-off.log
node owner-evidence-check.mjs --deals=optional --messages=optional \
  --spatial=rich-v5 owner-evidence/spatial-structured.log
node owner-evidence-check.mjs --deals=optional --messages=optional \
  --spatial=rich-v5-minimap owner-evidence/spatial-on.log
```

Each supplied policy log must contain a spatial record. OFF records must all be
absent. Structured records must all be present schema `5`, remain within the
16 KiB base ceiling, and report no minimap. ON records must additionally report
minimap schema `2` within 4 KiB. Every enabled record must carry the exact
visibility model and record that its primary selected legal action was offered.
One good record cannot mask an absent, missing, or downgraded record from
another supplied policy log. This is policy-authored evidence, not an external
Coworld seal; retain the independently joined request, episode, game, replay,
package, image, source, and policy identities separately.
