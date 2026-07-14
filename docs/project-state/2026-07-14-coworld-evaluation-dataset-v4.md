# Coworld evaluation dataset schema v4

Date: 2026-07-14

Status: implemented and locally verified on
`codex/coworld-council-dataset`.

Source tags used below: `[repo/file verified]` and
`[uncertain / needs confirmation]`.

## Decision

The Coworld evaluation dataset exporter now emits `schemaVersion: 4` and has a
strict evidence path for the observational expert Council. The schema bump is
required because both the compact shadow diagnostic and the paired-matrix
assignment/audit objects are new persisted fields. `[repo/file verified]`

The final `decision_response.shadowCouncil` value is accepted only as a compact
JSON string of at most 300 bytes with the exact v1 key set and bounded values.
It records counterfactual proposals, errors, rejections, agreement, health,
fingerprints, margin, mask, and elapsed time. It does not establish which
action controlled the game. `[repo/file verified]`

## Council plan and completion evidence

Council evaluation is opt-in through a repeatable explicit
`--council-plan PLAN` argument. A plan can supply its own completed episode
artifacts without a separate generic artifact path. Generic discovery never
interprets an unrelated `plan.json` as Council evidence. `[repo/file verified]`

The loader accepts only the frozen Coworld `0.1.30` paired-matrix plan
`schemaVersion: 3` and completion `schemaVersion: 1` contracts. It:

- requires exact object keys and bounded values;
- recomputes `matrixID` from the canonical `matrixIdentity`;
- verifies materialized-manifest identity, resolved image IDs, canonical arm
  order, matrix axes, roster order, stable block/pair IDs, rotated job order,
  and exact job paths;
- accepts completion evidence only when the episode runner, results validator,
  and replay validator all identify the pinned production toolchain;
- audits injected or injected-unverified completions as invalid
  non-production evidence;
- reproduces the producer's file-or-directory artifact hashing, rejects
  symlinks and empty artifacts, and requires canonical artifact containment in
  the exact job output directory; and
- stages each job independently, so a malformed job cannot leak partial rows
  into the dataset. `[repo/file verified]`

## Dataset semantics

Every joined candidate row preserves `matrixID`, `blockID`, `pairID`, `jobID`,
arm and expert mask, variant, seed, map, candidate seat, roster-order ID, and
candidate/game/opponent image IDs. Plan v3 additionally admits one reviewed,
default-off `v16-politics-guard` arm; it is not generic Council authority.
`intentionToTreat` is true for locked shadow arms and for that named guard arm.
`actualTreatmentExposure` is true only for the guard arm, whose runtime may
replace a proactive alliance request or any active `break_alliance`; shadow
arms remain observational. `[repo/file verified]`

The all-break policy is deliberately broad: it can suppress v16 backstab,
hard-nation endgame, and front-opening conversions. It is isolated to the
named arm so paired outcomes can decide whether to retain it, narrow it to
request/break churn, or replace it with a request-only guard. `[repo/file verified]`

The top-level Council audit separates missing, invalid, and unjoined jobs and
blocks. A block is complete only when it contains the exact planned job IDs
and every job joins to exactly one episode. Tie audits retain top-score
multiplicity, sole-top and outright wins, positive top scores, and all-zero
ties. Paired base-versus-shadow differences are labeled
`descriptive-shadow-overhead`; they are diagnostics, not causal treatment
effects. `[repo/file verified]`

This contract does not show that any expert proposal improved play and does
not authorize generic Council action selection. The named politics guard is a
bounded exception that still requires separately powered paired evaluation
before any hosted rollout. `[repo/file verified]`

## Verification contract

Keep the focused Coworld evaluation dataset suite, full TypeScript check, and
repository lint green. The focused suite covers canonical matrix identity,
materialized-manifest tampering, exact job ordering, pinned versus injected
completion provenance, producer-compatible replay-directory hashes, canonical
containment, missing/invalid/incomplete audits, all-zero ties, and descriptive
paired shadow overhead. `[repo/file verified]`
