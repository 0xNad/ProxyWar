# Spatial Observation Matched XP Contract

This experiment is a separate release train from StrategicCommander. Do not
merge, upload, bind, or deploy it until Control confirms the Commander A/B/C
baseline artifacts are sealed.

## Arms and source identity

Build both arms from one checked-out source commit and one rendered canonical
Coworld manifest/image. The Experience Request schema selects a `coworld_id`
but cannot override runnable environment variables, so the arms must be two
fresh, uniquely named, noncanonical Coworld packages:

- `proxywar-spatial-xp-off`: the spatial flags are absent (the production
  default).
- `proxywar-spatial-xp-on`: both
  `PROXYWAR_TUNE_SPATIAL_OBSERVATION=1` and
  `PROXYWAR_TUNE_SPATIAL_MINIMAP=1` are set.

Generate each local-only, upload-blocked candidate manifest without editing the
canonical template:

```sh
npm --prefix coworld-adapter run build:spatial-xp-manifest -- \
  --arm=off --source-sha="$EXACT_SOURCE_SHA" \
  --input=/absolute/path/canonical-rendered.json \
  --output=/absolute/path/proxywar-spatial-xp-off.json
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
is a sealed or authentic Coworld statement. Do not upload either generated arm
until an independent authority-side fetch returns an immutable Coworld receipt
that binds the exact image digest to the candidate source SHA.

The release packet must record the authority receipt ID or immutable URL, fetch
time, exact image digest, bound source SHA, and SHA-256 of the fetched receipt.
The verifier must fetch it independently rather than consume a path supplied by
the manifest author. If Coworld exposes no such receipt or authority route, the
image remains unverified and package upload is blocked; report that external
blocker instead of relabeling local inspection output.

Record the candidate source commit, image digest, both manifest hashes, both
Coworld IDs, certification jobs, hosted smoke episode IDs, policy version IDs,
and Experience Request IDs. Neither package may replace the canonical
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
- the same public ownership/terrain grid reduced deterministically to a 24 by
  12 minimap.

The minimap legend contains exact `glyph`, `playerID`, and `isYou` fields only.
It deliberately omits redundant display names: the observing name remains in
`username`, and every rival name remains in `visiblePlayers` under the same
exact player ID. IDs and glyphs are never truncated or rewritten. This keeps a
25-seat boundary fixture with eight-character IDs below the 2 KiB minimap cap
without losing identity linkage.

This candidate is a rich **structured map** plus the existing ownership
minimap. It does not implement the separately designed terrain/structure-marker
minimap L5. An unqualified rich-minimap claim remains blocked until that child
schema has its own serialization cap, 25-seat boundary, prompt/memory gate, and
hosted matched-use proof.

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
| Serialized minimap               |        2 KiB |
| Spatial prompt increment         |       24 KiB |
| Estimated prompt-token increment | 8,192 tokens |
| 16-seat all-on prompt growth     |          10% |

The off arm must remain byte-identical to pre-spatial observation and starter
telemetry. The on arm must be deterministic for the same state, bounded under
the table above, and accepted by the public-source-of-truth starter only when
schema `3` and the exact visibility model are present. The starter also retains
strict schema-`1` backward compatibility, but only schema `3` carries the rich
map frame, terrain fronts, and positioned assets.

## Hosted matched proof gate

Use identical map, seed, player roster, frozen policy versions, episode index,
and balanced seats in both arms. Before claiming a useful behavioral effect,
retain evidence that:

1. the off arm reports no spatial state, while the on arm reports schema `3`,
   the exact visibility model, coordinate frame, terrain/coverage, completed
   public positioned assets, and the ownership minimap;
2. both arms receive the same offered legal-action IDs at each matched state;
3. any changed choice is still an exact offered ID and is accepted through the
   canonical validator/runner path;
4. replay/game effects correspond to that validated choice; and
5. prompt/decision artifacts stay within their configured privacy and size
   bounds.

Local serialization, inertness, and starter tests are necessary but are not a
substitute for fresh certification, hosted smoke, or a real-model matched
gameplay result. A null or harmful result must be retained and reported.
