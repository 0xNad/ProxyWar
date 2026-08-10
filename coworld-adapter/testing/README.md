# Deterministic social controls

These policies are measurement controls, not candidate league agents. They all
select exact offered `LegalAction.id` values and use the optional deal slot only
in the `active` arm. Their ordinary action posture deliberately avoids core
alliance/chat/emoji selection so a second social channel does not swamp the
structured-promise treatment; offered combat precedes `hold`.

Profiles:

- `keeper`: accepts offered promises, uses confirmed-effect actions to keep
  support and attack pledges, and selects audited `hold` actions through an
  active negative covenant so absence-of-violation has complete coverage.
- `defector`: pairs with the keeper through a trade-security promise, then
  deliberately selects an offered voluntary embargo against that partner.
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

## Hosted support acceptance control

`Dockerfile.hosted-support-control` is a narrower eval-only counterparty for
proving that a candidate starter can accept and fulfill a feasible support
request in the hosted runtime. It requests a core alliance through an exact
offered action, continues ordinary expansion, accepts incoming negative
covenants, and selects each currently offered `support_request` to a friendly
player. A rejection is allowed to reach the server-governed retry window so an
LLM starter receives a post-plan opportunity instead of only a startup-step
offer.

Build it from the repository root:

```sh
docker build -f coworld-adapter/testing/Dockerfile.hosted-support-control \
  --platform linux/amd64 \
  -t proxywar-hosted-support-control:local .
```

This policy is a reproducible evaluation fixture, not a league candidate. Never
submit or promote it. A passing acceptance requires the replay's finalized
`deal-ledger.json` to contain a support obligation fulfilled by an immutable
`confirmedDonation` receipt; a proposal, selected action, or metadata amount is
not execution evidence.

## Meaningful-gameplay counterparties

`Dockerfile.hosted-social-counterparty` builds four immutable eval-only
counterparties for the next behavioral gate:

- `pact-keeper` accepts negative covenants and filters exact hostile actions
  against the partner until the referee closes the obligation;
- `pact-breaker` accepts the same covenants and selects the first exact hostile
  action against that partner once the judged window is active;
- `mutual-aid` requests support only when materially behind or under attack,
  caps itself at two attempts, and accepts/fulfills a reciprocal support request
  only after that partner has a positive terminal same-match reliability record;
- `deal-blind` uses the same ordinary-action ordering but never selects the
  diplomacy slot.

Build one immutable image per profile with
`--build-arg HOSTED_SOCIAL_COUNTERPARTY_PROFILE=<profile>`. These controls make
opportunity, kept promise, attributable defection, earned reciprocity, and
deal-blind behavior comparable without inventing raw intents. They are tagged
and documented as `eval_only_never_submit`; uploading for an authorized
Experience Request never authorizes league submission.

Generate a bounded four-profile local request with an explicitly chosen
manifest, explicit steps, and an explicit seed:

```sh
node coworld-adapter/testing/make-meaningful-social-episode-request.mjs \
  coworld-adapter/coworld/coworld_manifest.json \
  /safe/output/meaningful-social-request.json 80 173205
```

Run it through `coworld run-episode --verify-replay` and require the finalized
deal ledger to distinguish fulfilled keeper obligations, attributable breaker
violations, bounded mutual-aid proposals, and zero deal selections by the blind
profile. The deterministic matrix validates the instrument; only later matched
episodes with an autonomous subject can support a social-gameplay conclusion.
The checked-in manifest is local-source truth, not proof of the currently
canonical hosted Coworld. Hosted claims must name and query the exact `cow_*`
ID and inspect its terminal replay artifacts separately.

## Matched matrix execution

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

For the repeated internal evidence gate, run the host-side matched matrix. It
uses the same production episode runner and websocket protocol without Docker,
crosses three explicit seeds, two maps, all four fairness spawn rotations, and
the OFF / enabled-but-ignored / active arms, and checkpoints every cell so an
interrupted run can resume from the same output directory:

```sh
node coworld-adapter/testing/run-social-matrix.mjs
```

The default is 72 episodes. `matrix-report.json` preserves per-run artifact
paths and SHA-256 hashes; `matrix-report.md` reports opportunity denominators,
selected deal actions, finalized obligation outcomes, fallback counts, and the
matched OFF-versus-ignored non-interference check. `moot` and `unverified`
obligations never enter the commitment reliability denominator, and a policy
that never accepts a commitment receives no reliability estimate rather than a
perfect score. For a bounded smoke, override comma-separated axes with
`PROXYWAR_SOCIAL_MATRIX_SEEDS`, `PROXYWAR_SOCIAL_MATRIX_MAPS`,
`PROXYWAR_SOCIAL_MATRIX_EPISODES`, and `PROXYWAR_SOCIAL_MATRIX_ARMS`.
