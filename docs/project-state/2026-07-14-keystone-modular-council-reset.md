# Keystone modular Council reset — 2026-07-14

Status: experimental, default off, not uploaded. Keystone v16 remains the live
champion until a challenger clears the paired evaluation gates below.

## Evidence that caused the reset

- `[live hosted truth, replay verified]` In Coworld replay
  `league-coworld-2026-07-14T16-58-11-547Z-a67f0574`, Auri made 326 decisions
  after turn 7,800; 306 were politics or holds. The game recorded 220 stale
  political selections as holds, 46 alliance requests, 39 alliance breaks, and
  only 20 productive decisions. Every one of those late decisions offered at
  least two productive alternatives.
- `[live hosted truth, replay verified]` None of Auri's 39 accepted breaks was
  followed by an attack or boat action against that recipient within 600 turns.
  Ten of 50 accepted alliance requests targeted a player with an already-pending
  outgoing request in the audited snapshot.
- `[local artifact truth]` Across 82 downloaded public OpenFront winner replays,
  171 of 173 alliance breaks were eventually converted into an attack on the
  same recipient; 165 converted within 600 turns, with a median delay of seven
  turns. Winner attacks also showed strong target persistence: 83.1% belonged
  to same-target runs of at least two attacks.
- `[repository truth]` The existing Council already separates survival,
  expansion, economy, conquest, and politics proposals, but its first broad
  politics guard suppressed every break. That treatment cannot distinguish
  destructive churn from a useful betrayal and is not a promotion candidate.
- `[live hosted truth]` The hosted Coworld game image predates the reviewed
  offered-action retry. Policy-only upload cannot fix the stale-offer race; a
  new game package and league binding are required after certification.

## Runtime architecture

The deployed agent remains one in-clock decision path. The modules are not
independent hosted LLM calls: Coworld offers one action slot, so parallel brains
would add latency and create conflicting state. Instead, all modules consume one
immutable world model and return at most one canonical offered action proposal.

1. Commander supplies a short-lived strategic plan and explicit binding, when
   healthy.
2. The shared world model normalizes observation, offer, relationship, safety,
   and Commander facts once.
3. Protected tiers resolve spawn and survival before discretionary strategy.
4. Expansion, economy, conquest, and politics experts propose independently.
5. A central arbiter validates exact offered IDs, resolves precedence and bid
   conflicts, and retains bounded commitments.
6. A transaction ledger advances only from accepted `RecentAgentDecision`
   records. Merely selecting an action, including a retry against a withdrawn
   offer, cannot create relationship or campaign state.
7. Replay and evaluation telemetry records which module proposed, won, was
   suppressed, or failed.

## Specialist ownership model

Codex Control owns integration, gates, and live decisions. Bounded subagents may
work in parallel on one independently testable domain, but do not publish or
merge their own result.

| Domain | Responsibility | Primary evaluation signal |
| --- | --- | --- |
| Expansion | Land/boat opening, frontier continuation, duplicate suppression | first expansion/boat turn, territory gain, cadence debt |
| Economy | City/port/factory cadence, defense, SAM/silo deterrence | first build turn, build:attack cadence, structure coverage |
| Conquest | Target scoring, safe commitment, finish conversion | same-target run, target share loss, own share gain |
| Politics | Request lifecycle, reactions, alliance preservation/break | political action share, repeat rate, break conversion |
| Arbiter/survival | hard safety, precedence, commitment switching | rejected proposals, survival preemption, action validity |
| Evaluation/review | paired controls, degradation, treatment exposure | joined pairs, win/score delta, fallback and marker rates |

## First isolated treatment: diplomacy transaction adjudicator

The first challenger remains v16 for all ordinary decisions and intervenes only
at the politics/conquest boundary:

- allow a reactive request or the first confirmed request to a target;
- replace an already-pending, repeated, or post-break re-alliance request with a
  non-political Council action;
- admit a break only when Commander or the reviewed backstab affordance binds a
  reachable, favorable target and the safety gates pass;
- register that break as pending, then arm the campaign only after the exact
  accepted break appears in recent decision history;
- for the next 600 turns, keep survival first and otherwise prefer a safe attack
  or player boat against that exact target;
- keep the ordinary productive v16/Council path when no safe target action is
  currently offered; never invent an intent or broaden to another target.

The paired arm is named `v16-diplomacy-adjudicator` and is controlled only by
`PROXYWAR_KEYSTONE_COUNCIL_DIPLOMACY_ADJUDICATOR=1`. It is mutually exclusive
with the old broad politics guard and the separate single-action treatment.

## Promotion gates

1. Focused module, player-wire, reset/retry, matrix-plan, and dataset tests pass;
   root and adapter typechecks pass; lint has no errors.
2. The frozen v16/shadow diagnostic matrix completes without changing the v16
   action outcome and exposes enough module decisions to audit the world model.
3. Run paired `v16` versus `v16-diplomacy-adjudicator` matches on the current
   opponent class, every supported map and candidate seat, with identical seeds
   and roster order.
4. Separate the old hosted contract from the corrected game-runner contract;
   no result may mix the two strata.
5. Require zero unexplained timeouts, fallbacks, unknown actions, parse failures,
   and missing jobs. Require actual treatment markers in the candidate rows.
6. Inspect every discordant pair and require improvement in both episode win
   rate and score share over a meaningful sample before upload.
7. Upload and submit only a gate-clearing immutable image/package. Live v16 is
   unchanged until then.

This treatment is deliberately narrower than making the full Council
authoritative. Expansion, economy, and broader conquest treatments will be
evaluated as separate candidate families so a win or regression has an
identifiable cause.
