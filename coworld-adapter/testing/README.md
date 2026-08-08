# Deterministic social controls

These policies are measurement controls, not candidate league agents. They all
select exact offered `LegalAction.id` values and use the optional deal slot only
in the `active` arm. Their ordinary action posture deliberately avoids core
alliance/chat/emoji selection so a second social channel does not swamp the
structured-promise treatment; offered combat precedes `hold`.

Profiles:

- `keeper`: accepts offered promises and uses confirmed-effect actions to keep
  support and attack pledges; it filters accidental pact violations.
- `defector`: accepts or proposes non-aggression promises, then deliberately
  selects an offered hostile action against an active partner.
- `skeptic`: rejects every incoming promise and never proposes one.
- `deal-blind`: never selects a deal action.

Arms:

- `off`: policy-side no-deal behavior for a game manifest with structured deals
  disabled.
- `ignored`: the game offers deals, but every policy omits the optional slot.
- `active`: the profile-specific social behavior above is enabled.

`off` and `ignored` have byte-equivalent decision behavior. A true OFF fixture
also removes `PROXYWAR_TUNE_STRUCTURED_DEALS` from the game runnable; the arm
label alone cannot disable a server feature.

Build one image per frozen profile and arm from the repository root:

```sh
docker build -f coworld-adapter/testing/Dockerfile.social-control \
  --platform linux/amd64 \
  --build-arg SOCIAL_CONTROL_POLICY=keeper \
  --build-arg SOCIAL_CONTROL_ARM=active \
  -t proxywar-social-keeper-active:local .
```

Repeat for `defector`, `skeptic`, and `deal-blind`. A heterogeneous local active
fixture accepts one image per seat:

```sh
uvx --from coworld coworld run-episode \
  coworld-adapter/coworld/coworld_manifest.json \
  proxywar-social-keeper-active:local \
  proxywar-social-defector-active:local \
  proxywar-social-skeptic-active:local \
  proxywar-social-deal-blind-active:local \
  --run node --run /app/social-control-player.mjs \
  --variant tournament-4p-pangaea --verify-replay
```

For the ON-but-ignored arm, build the same four profiles with
`SOCIAL_CONTROL_ARM=ignored` and use the unchanged deal-enabled manifest. For a
true OFF arm, build them with `SOCIAL_CONTROL_ARM=off` and run a temporary
manifest copy with
`.game.runnable.env.PROXYWAR_TUNE_STRUCTURED_DEALS` removed. Never change the
canonical manifest just to run the control.

The Docker build validates and writes the profile/arm to
`/app/social-control-build.json`; the player gives that build stamp precedence
over argv and environment. A hosted runtime environment override therefore
cannot silently turn a keeper into a defector or move a policy between arms.

Use the same four image digests, maps, episode counts, and rotated seat orders
within an arm. The adapter encodes each explicit `game_config.seed` as the
authoritative eight-character `GameServer.id`; `results.json` records both the
exact integer seed and derived game identity. A request that omits `seed`
retains legacy `COWRLD01` and reports `seed: null`. Hosted upload/league
submission is an outward action and must remain a separately authorized
experiment; these files only make the policies reproducible and uploadable.

For a bounded, exactly matched local smoke, generate one full Coworld episode
request per arm. The request freezes the Pangaea variant, roster/seat order,
seed-derived runtime game identity, decision-step cap, policy images, and player
command. The final numeric argument is the actual simulation seed:

```sh
node coworld-adapter/testing/make-social-episode-request.mjs \
  coworld-adapter/coworld/coworld_manifest.json active \
  /safe/output/social-active-request.json 30 424242
uvx --from coworld coworld run-episode \
  coworld-adapter/coworld/coworld_manifest.json \
  /safe/output/social-active-request.json --verify-replay \
  --output-dir /safe/output/social-active
```

Generate `ignored` with the same final two numeric arguments. For `off`, pass
one more explicit output path; the generator writes the matching manifest with
`PROXYWAR_TUNE_STRUCTURED_DEALS` removed, and that generated manifest must be
the manifest argument to `coworld run-episode`. Do not label a deal-enabled
game as a true OFF arm.
