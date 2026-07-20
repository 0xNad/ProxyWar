# Replay Premiere operator admission command

Status: local operator workflow only. This command does not publish, schedule,
activate, deploy, or expose an HTTP/admin route.

## Command

```sh
npm run premiere:admit -- \
  --premiere-id=prem_0123456789abcdef \
  --source-file=/absolute/private/controlled-run.source.json \
  --expected-source-sha256=<64-lowercase-hex> \
  --private-state-root=/absolute/private/premiere-state \
  --served-root=/absolute/served/root \
  --eligibility-file=/absolute/private/operator-eligibility.json \
  --definition-file=/absolute/private/spoiler-neutral-definition.json \
  --deployment-origin=https://beta.proxywar.xyz \
  --nonce-file=/absolute/private/commitment-nonce.bin
```

`--served-root` may be repeated. Every other argument is required exactly once;
unknown, duplicate, empty, relative-path, and malformed values fail closed.
`--deployment-origin` must exactly equal the origin derived from the same
`PROXYWAR_PUBLIC_URL` configuration consumed by the production server; an
arbitrary probe host is rejected before staging or network access. Startup
independently rechecks the stored target origins against its configured origin.

The eligibility input contains only operator-originated fields:

```json
{
  "schemaVersion": 1,
  "eligibilityCheckVersion": "phase0/v1",
  "externalEmbargoEvidence": [
    {
      "source": "controlled runner",
      "scope": "source and outcome",
      "observedAt": "<current canonical timestamp>",
      "verifier": "<operator identity>",
      "embargoConfirmed": true
    }
  ],
  "externalOutcomeMayBePublic": false,
  "publicLabel": "premiere"
}
```

The source kind, run ID, source hash, seat and policy identities, result
reference, private-layout claim, leak manifest, and leak observations are never
accepted from this file. The command derives source facts from the hash-bound
staged controlled bundle, builds the required leak manifest, executes the real
read-only collector, and uses only the collector receipt as leak evidence.

The definition input contains `schemaVersion`, `title`,
`spoilerNeutralDescription`, `map`, `matchFormat`, `scheduledAt`,
`playbackRate`, and exactly two `checkpoints`. It cannot contain provenance;
provenance and its eligibility hash are derived after the authentic assessment.

The nonce file is raw private material between 16 and 64 bytes. It must be an
absolute, canonical, same-UID, single-link regular file with mode `0400` or
`0600`, outside every served root.

On success stdout is one JSON line containing only the premiere/source IDs and
source, deployment-origin, eligibility, publication, draft-manifest, and
admission-record hashes.
No winner, result bytes, nonce, paths, probe bodies, or policy decisions are
printed. Failure uses one fixed path-free operator code on stderr.

## Failure residue and activation

Argument, input, layout, existing-ID, and catalog-lock failures occur before
source staging. Once the exact source hash has been verified and staged, a
later import, probe, eligibility, gate, or catalog failure deliberately retains
one read-only content-addressed copy under
`sources/sha256/<prefix>/<source-hash>.replay`. This is private integrity
evidence and is reused by a retry; the command does not create a catalog entry
or retain a separate leak receipt on failure. It never deletes this evidence.
Removal requires explicit operator approval and a bounded lifecycle/recovery
path.

The startup assembler releases its catalog writer lock after reconstructing its
startup set. A successful command can therefore add a verified catalog entry
while the server is running, but it does not hot-register or activate the new
premiere. Activation requires a controlled server restart and normal startup
reconstruction.
