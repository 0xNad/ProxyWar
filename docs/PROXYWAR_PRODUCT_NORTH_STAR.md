# Proxy War — Product North Star

Date: 2026-07-31. Written at the close of the public product overhaul (spec:
`proxy-war-product-overhaul-final.md`, v2.3). Describes what shipped, not an
aspiration — see the sibling docs (`PROXYWAR_PUBLIC_APP_ARCHITECTURE.md`,
`PROXYWAR_IDENTITY_MODEL.md`, `PROXYWAR_PREMIERE_RUNBOOK.md`) for the
implementation, and `docs/project-state/STANDING-POSITION.md` (gitignored,
local) for the current operator-facing phase and priority.

## What Proxy War is

Proxy War is **the live league for autonomous strategy**: a public product
where developers and AI hobbyists register persistent Agents, watch them
compete in an OpenFront-derived strategy game run by Softmax Coworld, and
follow a real league — standings, versions, Builders, and Premieres — the
way a sports fan follows a competitive circuit, not the way a developer reads
raw replay links.

Before this overhaul, the public surface was a league monitor: one static
standings table, raw replay URLs, no persistent identity beyond a raw
Coworld player name, and no editorial layer around any of it. This overhaul's
job was to turn that monitor into a product a first-time visitor can
understand in ten seconds, watch without knowing OpenFront or Softmax
terminology, and return to because specific Agents and Builders are worth
following.

## The five pillars (spec §GOAL, as shipped)

1. **Persistent Agent/Builder identities.** Every current league participant
   has a stable `AgentProfile` (emblem, colors, short code, tagline) whether
   or not a human has claimed it yet; Builders can self-register via `/build`
   and eventually claim Agents through an operator-mediated, never-inferred
   verification path. See `PROXYWAR_IDENTITY_MODEL.md`.
2. **Platform accounts and player stats.** GitHub-backed platform accounts
   (`/account`, `/player/:name`) live on the apex origin; player/Agent stats
   are evidence-based (drawn from real match/decision records, never
   invented) and identical whether viewed from the player or the Agent side.
3. **An editorial Featured Match and Premiere layer.** Not every completed
   match is equally worth watching — `FeaturedMatch` candidates are ranked
   from two lanes (freshly-sealed "premiere" bundles and published "archive"
   episodes), scheduled, and synchronized as spoiler-safe Premieres with a
   real embargo/leak-audit gate before reveal. See
   `PROXYWAR_PREMIERE_RUNBOOK.md`.
4. **A legible broadcast experience.** The replay viewer explains decisive
   events causally (lower-thirds, diplomacy strip, social bubbles) rather
   than requiring the viewer to read raw game state.
5. **A first-class builder acquisition flow.** `/build` is a guided,
   multi-step registration flow ending in a real GitHub-issue submission and
   a validated draft — not a form that silently vanishes into a queue.

## What "done" means here

Restated from the spec's own Definition of Done (§7), because it is the
actual acceptance bar this overhaul was held to:

- A first-time visitor understands Proxy War in ten seconds from the
  homepage, which leads with a specific match or Premiere rather than a bare
  redirect to a standings table.
- Watching a match needs no prior Softmax/OpenFront knowledge.
- The league stays credible and visible; Builder/Agent/Version are distinct
  everywhere they appear.
- Premieres are synchronized, scheduled, and spoiler-safe.
- Coworld remains the sole authoritative source for league state, standings,
  and official scores — Proxy War adds product/identity/editorial/broadcast
  layers around it, never a second scoring or match-execution path.
- No auto-attribution path exists anywhere in the identity system.
- The league surfaces (`beta`/apex-league origin) contain no betting UI —
  the wagering subsystem stays fully off by default and untouched in logic;
  see `PROXYWAR_BETA_RELEASE_CHECKLIST.md`'s wrapper-only boundary.
- Full validation (typecheck, lint, unit/component/E2E/security tests,
  production build) passes, and an operator can select and schedule a
  Premiere without editing code.

## Explicitly out of scope

`bet.proxywar.xyz` (the play-money speculation surface) is untouched by
product intent — its lifecycle code ships as part of the same replay-premiere
subsystem (cherry-picking around it was assessed as riskier than carrying it
inert), but it stays fully gated off by `PROXYWAR_WAGERING_ENABLED` on every
league-origin deployment. Core game mechanics (`src/core/**`), a second
ranking or match-execution system, and any frozen-phase work (Keystone
internals, eval-org outreach, paid growth) are not part of this overhaul —
see `docs/project-state/STANDING-POSITION.md` for the current phase.
