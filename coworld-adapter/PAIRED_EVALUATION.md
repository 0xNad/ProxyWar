# Keystone paired local evaluation

The paired-matrix planner creates inspectable Coworld 0.1.30 episode requests
without launching containers. It keeps the candidate image reference and
resolved local Docker image ID, game config, seed, seat, and opponents identical
inside each pair. The only candidate-policy difference is
`PROXYWAR_KEYSTONE_SINGLE_ACTION=0` (control) versus `1` (treatment). The arm tag
is metadata only. Pair execution order alternates A/B then B/A across the matrix.

Build or load every referenced candidate, opponent, and game image locally, then
copy and edit `coworld/paired-matrix.example.json`. Materialize the dry run into
a new output path:

```sh
npm run league:paired-matrix -- \
  --spec coworld-adapter/coworld/paired-matrix.example.json \
  --game-image proxywar-coworld-reset:seed-v1
```

Image tags are not immutable. Before writing output, the planner resolves every
tag or digest through local Docker and records both the authored reference and
the `sha256:` image ID in `plan.json` and every job. A future executor must
re-resolve every reference and refuse to launch if any ID has changed.

The planner validates the complete materialized manifest and every request in
memory with pinned Coworld 0.1.30. It then writes a complete sibling staging
directory and atomically renames it into place. The requested output path must
not already exist or overlap the matrix spec or source manifest. Invalid image
references, seats, seeds, names, environment maps, opponent counts, schema
violations, reserved runtime variables, and secret-looking environment keys all
fail before output is published. Public environment variables are written to
the requests, so credentials never belong in the matrix spec.

Inspect the generated `plan.json`, materialized `manifest.json`, and each
`jobs/*/episode_request.json`. The embedded manifest is sourced from the exact
same materialized object passed to every request. Pair and job IDs use at least
128 bits of a matrix identity that includes the manifest and all resolved image
identities; duplicate IDs or paths fail closed.

This checkpoint is intentionally dry-run only. `--execute` fails loudly. Local
execution, image-ID drift checks, resume, and result/replay artifact validation
must be implemented and independently reviewed before the rejection screen can
launch. On macOS, that future executor must give Coworld a workspace-local
`TMPDIR` such as `$PWD/coworld-adapter/tmp`; host `/var/folders` staging paths are
not mounted into Docker and break replay verification. The planner contains no
hosted Coworld upload, submit, publish, or Experience Request path.
