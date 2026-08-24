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

The rendered manifest's image string and any locally written
`coworld-image-inspect-v1` document are caller-controlled diagnostics. Neither
is a sealed or authentic Coworld statement. Do not upload any generated arm
until an independent authority-side fetch returns an immutable Coworld receipt
that binds the exact image digest to the candidate source SHA.

The release packet must record the authority receipt ID or immutable URL, fetch
time, exact image digest, bound source SHA, and SHA-256 of the fetched receipt.
The verifier must fetch it independently rather than consume a path supplied by
the manifest author. If Coworld exposes no such receipt or authority route, the
image remains unverified and package upload is blocked; report that external
blocker instead of relabeling local inspection output.

Record the candidate source commit, image digest, all three manifest hashes,
all three Coworld IDs, certification jobs, hosted smoke episode IDs, policy
version IDs, and Experience Request IDs. No package may replace the canonical
`proxywar` package or be bound to the league.

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
