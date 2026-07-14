# Keystone paired local evaluation

The paired-matrix planner creates inspectable Coworld 0.1.27 episode requests
without launching containers. It keeps the candidate image, game config, seed,
seat, and opponents identical inside each pair. The only candidate-policy
difference is `PROXYWAR_KEYSTONE_SINGLE_ACTION=0` (control) versus `1`
(treatment). Pair execution order alternates A/B then B/A across the matrix.

Start with an immutable candidate image and an immutable game image. Copy and
edit `coworld/paired-matrix.example.json`, then materialize the dry run:

```sh
npm run league:paired-matrix -- \
  --spec coworld-adapter/coworld/paired-matrix.example.json \
  --game-image proxywar-coworld-reset:seed-v1
```

Inspect the generated `plan.json`, materialized `manifest.json`, and each
`jobs/*/episode_request.json`. The embedded manifest is byte-for-byte sourced
from the same materialized object passed to every request. Mutable `:latest`
images, invalid seats/seeds, opponent-count mismatches, and a pre-set treatment
flag fail closed.

This first checkpoint is intentionally dry-run only. `--execute` fails loudly;
execution, digest resolution, resume, and artifact validation must be added and
independently reviewed before it can launch the rejection screen. This script
contains no hosted Coworld upload, submit, publish, or Experience Request path.
