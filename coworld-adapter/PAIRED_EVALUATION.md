# Keystone N-arm local evaluation

The schema-version 3 paired-matrix planner creates inspectable Coworld 0.1.30
episode blocks without launching containers. Every block fixes the manifest,
resolved image IDs, map, seed, seat, roster, and opponents, then varies only the
candidate arm. Arm order rotates by block index, so each arm occupies every
execution position once per complete cycle.

Supported authored arms are:

- `{ "kind": "v16" }`
- `{ "kind": "a1" }`
- `{ "kind": "v16-shadow", "expertMask": 0..15 }`
- `{ "kind": "a1-shadow", "expertMask": 0..15 }`
- `{ "kind": "v16-politics-guard" }`
- `{ "kind": "v16-diplomacy-adjudicator" }`
- `{ "kind": "v16-survival-shield" }`

The planner derives all policy environment fields from the arm kind. Candidate
and opponent specs cannot supply those fields directly. Shadow observations are
not authoritative council decisions, so `council-authoritative` and
`expert-mask-authoritative` are reserved and rejected until a reviewed
authoritative runtime exists.

Build or load every referenced candidate, opponent, and game image locally,
then copy and edit `coworld/paired-matrix.example.json`. Materialize the dry run
into a new output path:

```sh
npm run league:paired-matrix -- \
  --spec coworld-adapter/coworld/paired-matrix.example.json \
  --game-image proxywar-coworld-reset:seed-v1
```

The planner validates the complete materialized manifest and every request in
memory with pinned Coworld 0.1.30. It records both each authored image reference
and its resolved local `sha256:` image ID, rechecks those identities before
publication, and never replaces an existing output. `plan.json` is published
last as the atomic planner-completion marker. Invalid images, seats, seeds,
names, run arguments, environment maps, opponent counts, Coworld schemas,
reserved runtime variables, and secret-looking environment keys fail closed.
Credentials never belong in the matrix spec.

The named authoritative arms record that treatment authority was assigned; that
assignment alone does not prove the runtime changed a decision. Promotion
evidence must also inspect decision telemetry for the arm's adjudication-specific
marker. For the survival shield, require at least one `survival_preempted`
decision, count `survival_confirmed` separately, and require zero
`infrastructure_error` decisions. A generic `keystone-survival-shield:v2`
marker count is insufficient because the fail-closed error path uses the same
namespace.

Inspect `plan.json`, `payload/manifest.json`, and each
`payload/jobs/*/episode_request.json` before execution. The plan records
`matrixID`, `blockID`, `pairID`, arm and expert-mask identity, roster order,
seed, map, seat, and every resolved image identity. `matrixID` is derived from
the stored canonical `matrixIdentity`; the executor recomputes it and binds the
recorded game image to the manifest image Coworld actually runs. The planner
remains dry-run safe: passing `--execute` to it fails loudly.

Run a reviewed materialized plan sequentially with:

```sh
npm run league:paired-execute -- --plan /absolute/path/to/plan.json
```

The executor validates the entire plan and every request before launching the
first episode. It requires the exact flattened balanced order, re-resolves all
image IDs at startup and before and after every job, runs pinned Coworld 0.1.30
with replay verification, validates `results.json`, and hashes both results and
replay artifacts. A job becomes resumable only after `completion.json` is
written with the full matrix/block/pair/arm/seed/map/seat/roster/image identity
and artifact hashes. Completion also records whether the pinned Coworld runner,
results-schema validator, and replay verifier were used. Injected test hooks are
explicitly marked and cannot resume as pinned production evidence. Existing
output without a valid completion, completion without output, mismatched
identity, changed hashes, empty replay, or image drift is rejected; the executor
never overwrites or infers provenance.

On macOS the executor gives Coworld a matrix-local `TMPDIR`; host
`/var/folders` staging paths are not mounted into Docker and break replay
verification. Neither command contains a hosted Coworld upload, submit,
publish, or Experience Request path.
