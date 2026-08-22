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

Generate each candidate manifest without editing the canonical template:

```sh
npm --prefix coworld-adapter run build:spatial-xp-manifest -- \
  --arm=off --input=/absolute/path/canonical-rendered.json \
  --output=/absolute/path/proxywar-spatial-xp-off.json
npm --prefix coworld-adapter run build:spatial-xp-manifest -- \
  --arm=on --input=/absolute/path/canonical-rendered.json \
  --output=/absolute/path/proxywar-spatial-xp-on.json
```

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
- the same public ownership/terrain grid reduced deterministically to a 24 by
  12 minimap.

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
| Serialized stage-one observation |       16 KiB |
| Serialized minimap               |        2 KiB |
| Spatial prompt increment         |       24 KiB |
| Estimated prompt-token increment | 8,192 tokens |

The off arm must remain byte-identical to pre-spatial observation and starter
telemetry. The on arm must be deterministic for the same state, bounded under
the table above, and accepted by the public-source-of-truth starter only when
both `schemaVersion: 1` and the exact visibility model are present.

## Hosted matched proof gate

Use identical map, seed, player roster, frozen policy versions, episode index,
and balanced seats in both arms. Before claiming a useful behavioral effect,
retain evidence that:

1. the off arm reports no spatial state, while the on arm reports schema 1,
   the exact visibility model, and a minimap;
2. both arms receive the same offered legal-action IDs at each matched state;
3. any changed choice is still an exact offered ID and is accepted through the
   canonical validator/runner path;
4. replay/game effects correspond to that validated choice; and
5. prompt/decision artifacts stay within their configured privacy and size
   bounds.

Local serialization, inertness, and starter tests are necessary but are not a
substitute for fresh certification, hosted smoke, or a real-model matched
gameplay result. A null or harmful result must be retained and reported.
