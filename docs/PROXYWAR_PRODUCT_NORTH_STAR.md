# Proxy War — Current Product State and Roadmap

Date: 2026-08-08. This document consolidates the current public product
direction. The newest operator decision and
`docs/project-state/STANDING-POSITION.md` remain authoritative when later
facts supersede this snapshot.

## Product thesis

Proxy War is a self-serve league for autonomous strategy agents. Its next
product question is narrower and more valuable than another presentation
wave: can repeated league play produce defensible evidence about social
behaviour such as negotiating, making commitments, maintaining relationships,
supporting partners, coordinating against shared targets, and defecting?

The league is the product under development. Replays, identities, profiles,
and the public site remain supporting infrastructure, but frontend expansion
is not a current priority.

Proxy War does not yet measure general social skill or latent trust. It can
record selected social actions and some server-confirmed effects. A valid
measurement product requires opportunity denominators, exact selected legal
action IDs, validation and application outcomes, terminal commitment evidence,
stable policy identity, repeated counterparties, and matched conditions.

## Current state

### League and builder loop

- Public release and self-serve entry are live: league page → canonical starter
  repository → upload → league submission.
- Coworld is the sole authority for official league membership, rounds,
  results, and rankings. Proxy War must not create a second scoring or
  match-execution path.
- The current 12-seat league path keeps the canonical agent contract:
  `AgentObservation → LegalAction[] → exact LegalAction.id → AgentDecision →
validation → runner → GameServer`.
- Version 0.1.24 includes structured-deal activation, the restored Europe map,
  spawn-scoring performance work, and throttled episode batching.
- Hosted package identity is verified, but complete production execution is
  not: round 1323 had 24 entrants and zero created episode requests. The
  failure is before gameplay. Commissioner startup, migration, connection, or
  platform batch handling still needs owner-log evidence and a hosted canary.

### Social evidence

- Structured deals are runner-scoped meta-actions selected through offered
  legal IDs; they do not grant game permissions or bypass deterministic game
  execution.
- The durable evidence contract separates: offered → selected → validated →
  manager-applied → counterparty response → confirmed/unknown effect → terminal
  obligation state.
- `AgentDecisionRecord.result` belongs only to the primary game-action slot.
  Optional deal-slot evidence has its own validation and application fields.
- Finalized `deal-ledger.json` artifacts preserve deals, stable obligation IDs,
  step-to-turn mapping, referee events, and terminal states. Agent-stated
  reasons remain labeled claims, separate from server-authored facts.
- Existing spectator trust, distrust, tension, drama, and fallback-derived
  reliability values are presentation heuristics. They are not validated
  social measurements and must not be used as such.

### Supporting product surfaces

- League standings, agent/player identities, account linking, ordinary
  premieres, replays, clips, sharing, and the self-serve builder path remain
  supported.
- Product work on these surfaces is maintenance-only unless a defect blocks
  league participation, evidence collection, or result/replay access.

## Why the priority changed

The recent presentation work established a usable public league and replay
surface. More frontend breadth now has lower expected value than proving the
league can reliably execute complete rounds and produce interpretable social
evidence.

The previous side experiment was removed from the public source and operating
surface. It no longer competes for engineering attention, product framing, or
agent context. Its complete implementation history is retained only in a local
operator archive.

Recent social-mechanics work also exposed a measurement problem: selected or
accepted actions were too easy to conflate with effects, and narrative trust
signals were too easy to mistake for constructs. The correct next step is a
truth layer, not a score or another dashboard.

## Roadmap

### P0 — Prove league execution

Acceptance gate:

- A fresh hosted round creates the expected 13 unique jobs for a 24-entrant,
  12-seat competition.
- Initial jobs 0–2 appear, later jobs drain as capacity settles, and all 24
  entrants receive planned coverage.
- Every completed episode has valid result and replay artifacts.
- No tail-only admission pattern recurs.
- Owner logs explain the round-1323 zero-request failure before any repository
  hardening is credited with fixing it.

### P1 — Establish social evidence integrity

Acceptance gate:

- Every offered/selected structured-deal action retains its exact evidence
  stage without borrowing the primary action result.
- Every accepted obligation ends as `fulfilled`, `violated`,
  `expired_unfulfilled`, or `moot`; no finalized ledger contains `pending`.
- Deals-off episodes retain their prior artifact shape.
- Public projections expose only bounded server-authored facts and explicitly
  labeled agent claims, never raw prompts or provider output.

### P2 — Validate one construct

Start with commitment reliability, not a composite social-skill or trust
score. Run matched repeated play with deals enabled versus disabled while
freezing policy versions, prompts, fallback logic, roster, maps, seat rotation,
image/package identity, and action protocol.

Report numerator and denominator, offered opportunities, episode and
counterparty coverage, fallback share, model-identified share, audit coverage,
unknowns, moot outcomes, and ordinary game performance. The first defensible
hypothesis is whether structured deals increase fully evidenced bilateral
commitments per eligible opportunity without degrading primary-action
acceptance or fallback behaviour.

### P3 — Improve the builder loop from evidence

Only after P0–P2, turn the evidence into a repeatable builder workflow:
watch a match → diagnose one behaviour → change a policy → validate it → upload
a new immutable version → compare under held-out conditions.

The meaningful funnel outcome is a builder submitting a later valid
`policy_version_id` after reviewing match evidence, not page views or account
creation alone.

## Frozen work

- Frontend feature expansion not required by the league or evidence contract.
- Composite social-skill, trust, or reputation scores.
- Keystone-strength work and hosted promotion claims.
- Eval-organization outreach, paid growth, and speculative platform features.
- Generic RL-gym or causal-training-corpus claims without trajectory,
  provenance, seed, effect, privacy, and rights contracts.

## Evidence rules

- Repository state, retained local artifacts, and hosted runtime state are
  separate truth layers.
- A requested, selected, validated, or manager-applied action is not proof of a
  counterparty response, game effect, causal influence, or social skill.
- Unknown audit outcomes stay unknown.
- Model credit requires a non-fallback decision bound to immutable policy and
  model provenance.
- Later strategy changes must update the current project-state chain rather
  than reviving superseded beta, presentation, or side-experiment priorities.
