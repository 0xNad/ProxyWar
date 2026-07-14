# Coworld evaluation dataset schema v3

Date: 2026-07-14

Status: implemented and locally verified on `codex/coworld-score-contract`.

Source tags used below: `[repo/file verified]` and
`[uncertain / needs confirmation]`.

## Decision

The Coworld evaluation dataset exporter now emits `schemaVersion: 3`. The
version bump is intentional because schema v2 collapsed evidence from distinct
provenance into the same fields. `[repo/file verified]`

Schema-v3 migrations:

- Episode and row `completedAt` is replaced by `platformCompletedAt` and
  `runtimeCompletedAt`. Platform `completed_at` and the runtime match-summary
  `completedAt` may legitimately differ and must not be reconciled into one
  timestamp.
- `telemetry.episodeReported` is now
  `{ result: CoworldReportedTelemetry, summary: CoworldReportedTelemetry }`.
  Result counters, match-summary counters, and the separately aggregated
  per-decision counters are independent evidence and may disagree.
- The dataset has a top-level `ingestion` object with
  `skippedNonCompletedEntries` and `skippedByStatus`. Explicit `failed`,
  `running`, and `submitted` entries are counted and skipped; malformed or
  unknown statuses and completed entries without valid scores fail closed.
- Cross-artifact identity merging follows seat, then agent ID, then a player
  name only when that name identifies exactly one roster seat. Ambiguous
  seatless repeated-name or repeated-agent-ID evidence remains unattributed
  rather than being attached to arbitrary seats. A decision or snapshot whose
  explicit seat contradicts its roster-backed name or agent ID fails closed.
  Normalized evidence is revalidated whenever cross-fragment merging enriches
  the roster. Seats inferred only from a name or agent ID are tracked
  internally and demoted back to unattributed when the enriched roster makes
  that identity ambiguous; explicit seats and validated complete-order
  snapshot seats retain their authority.
- Anonymous snapshot rows use array position only when every row is anonymous
  and the snapshot contains a complete roster-sized player array. Partial or
  mixed-identity anonymous rows remain unattributed, and resolved snapshot
  seats must be unique.
- Explicit `results.players.slot` values must form a complete, unique,
  zero-based order; mixed ordered/slotted and duplicate-slot evidence fails
  closed. A non-null `winner_slot` must be inside the score order.
- The saved-score evaluator applies the same cardinality rule as the dataset
  exporter: an explicit `policy_version_ids` order must have exactly one entry
  for every score and never falls back to score-pair input order on mismatch.

There is no automatic schema-v2 compatibility alias. Any consumer of persisted
dataset JSON must check `schemaVersion` and migrate the field paths above before
accepting schema v3. `[repo/file verified]`

## Current consumer audit

A checked-in repository search found the dataset type/builder and exporter CLI
as the producer, the `league:dataset-export` package script as its entry point,
and `tests/server/CoworldEvaluationDataset.test.ts` as the only checked-in
consumer of the schema-v3-specific fields. No separate checked-in report,
dashboard, or strategy-analysis parser currently consumes the exported JSON.
`[repo/file verified]`

Ad hoc scripts, ignored local artifacts, and external consumers are outside
that checked-in search and must be treated as unknown until verified before
using new exports. `[uncertain / needs confirmation]`

## Verification contract

Keep the focused dataset and score-semantics suites, TypeScript check, focused
lint, and real replay/sidecar provenance reproductions green. In particular,
the real artifact that reports fallback count `94` in result evidence and `93`
in summary evidence must retain both values separately.
