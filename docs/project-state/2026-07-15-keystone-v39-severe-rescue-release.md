# Keystone v39 severe-rescue release — 2026-07-15

Status: promoted to active Competition champion. This record supersedes the
earlier continuous 95%-for-seven-days optimization objective. The operator
retired that goal and authorized a conservative incremental release followed by
evidence-driven iteration.

## Decision

Keep the broad global-arbiter experiment out of the release. Ship frozen v16
behavior plus one severe-collapse rescue rule:

- below 35% active hostile incoming troops and below 25% accepted recent tile
  loss, return the exact v16 decision object unchanged;
- at or above either severe threshold, permit the reviewed survival proposer to
  select one exact offered retreat, nearby Defense Post, or bounded counter;
- preempt only hold, neutral expansion, economy, or politics; never displace an
  authoritative hostile attack or boat campaign;
- preserve friendly, allied, teammate, same-team, unique-offer, and singleton
  action safety;
- mark confirmed/preempted decisions with `keystone-survival-shield:v2` and
  fail closed to v16 if the treatment itself errors.

The earlier v1 moderate-pressure treatment is explicitly rejected. At 27.2%
incoming pressure it built a Defense Post but died earlier than its paired v16
control. v2 therefore delegates that entire moderate regime.

## Repository and local evidence

- `[repository truth]` Release source commit: `7821a30b9d2bebd067d609be89911f609bc961f8` on
  `codex/keystone-v17-severe-rescue`.
- `[local test truth]` Five focused suites passed 181/181 tests; root and adapter
  typechecks passed; lint completed with zero errors; `git diff --check` passed.
- `[independent review truth]` A separate reviewer found no blocking correctness
  or safety issue. It verified exact v16 identity outside the severe gate,
  accepted-only territory-loss history, singleton offered replacements, and
  hostile-campaign/friendly-team preservation.
- `[local artifact truth]` Native ARM64 image
  `proxywar-coworld-local:v17-7821a30b9-arm64` has image ID
  `sha256:2646a15ba13e508125ce956adb0cd4c56a0e1a8ea1d17d182ee9f98c36eff685`.
  The matched Pangaea smoke completed both v16 and treatment jobs using the
  same image, seat, roster, and seed. Both produced the exact same Auri score
  share (`0.29757813044821024`), action mix, zero fallbacks, and zero parse
  failures because no severe-collapse state occurred. This is the intended
  non-treatment identity result, not efficacy evidence.
- `[local causal test truth]` Reconstructed severe inputs exercise a 56.1%
  active hostile attack and an accepted recent tile collapse with 19.9%
  current pressure. Both select one exact offered rescue action and emit the v2
  treatment marker. Moderate 26.9%/27.2% inputs delegate exactly to v16.
- `[local build truth]` Hosted image
  `proxywar-coworld-local:v17-7821a30b9` is Linux/AMD64 with local image ID
  `sha256:fc2c7fbd80746b453c95e722175524bb815d6b5a204ea2a8e3a98109a34fccf0`.

## Hosted truth

- `[hosted truth, 2026-07-15T13:50Z]` Coworld assigned the next available
  lineage label `proxywar-keystone:v39`; versions 17–38 had already been
  consumed by private experiment uploads even though v16 remained the live
  champion.
- Policy version UUID:
  `f8a5554f-5cab-4fb5-a5d6-ed9b00b13326`.
- Submission UUID:
  `sub_1469a741-fa8e-440d-9f38-17b59f5e8d90`.
- Qualifier membership UUID:
  `lpm_2c8eec29-4f24-4e23-90f3-767de99e739b`.
- The submission uses the Bedrock Commander and enables only
  `PROXYWAR_KEYSTONE_COUNCIL_SURVIVAL_SHIELD=1` plus the existing full expert
  mask. Submission status is `placed`; auto-champion mode is `always`.
- `[hosted truth, 2026-07-15T13:55Z]` Both hosted crash/connect qualifier
  episodes completed with valid replay URLs, no episode error, and aggregate
  self-play score `0.5`. Qualifier round
  `round_4d61257a-e9bd-46ad-bef2-0051fe07c76e` completed successfully.
- `[hosted truth, same refresh]` v39 membership is `competing/champion` in
  Competition. v16 (`3ec3e986-08be-406a-b853-592bf50b7607`) was automatically
  changed to `competing/benched`; it was not retired or deleted and remains an
  immutable rollback point.

## Honest release claim and next loop

v39 is a narrowly justified candidate, not a proven higher-win-rate agent.
Promotion evidence begins with its qualifier and first completed Competition
rounds. Inspect severe-collapse marker exposure, fallback/degradation, survival
duration, score share, and top-score outcome. Keep the next change isolated to
one module and retain v16/v39 as immutable comparison points.
