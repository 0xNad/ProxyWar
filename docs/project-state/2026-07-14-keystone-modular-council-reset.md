# Keystone modular Council reset — 2026-07-14

Status: experimental and default off. The exact candidate image has been
certified and uploaded as two private evaluation-only policy versions, but has
not been submitted to the league. The corrected image is also available as the
evaluation-only Coworld 0.1.8 package; the live league remains bound to 0.1.7.
Keystone v16 remains the live champion until a challenger clears the paired
evaluation gates below.

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
- `[live hosted truth, 2026-07-14T20:27Z refresh]` Keystone v16 won 1/12,
  4/24, and 10/48 of its newest valid completed Competition episodes. Its mean
  raw score shares over those windows were 0.041917, 0.124909, and 0.189540.
  The live league is running four eight-player episodes per round despite older
  nominal metadata, so four-player-only evaluation is not representative.

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

## Current candidate and evaluation state

- `[repository truth]` The reviewed implementation is commit `bfc5cd427`; commit
  `238fe3877` pins the Coworld manifest to immutable image
  `sha256:2c09c7a2bfec06401b98040ae2c7404cb15c410c2f3199293b309b04c58fb81c`
  (`proxywar-coworld-local:dta-bfc5cd427`).
- `[local artifact truth]` Ten focused suites pass 218/218 tests. Root and
  adapter typechecks pass, lint reports zero errors, and Coworld 0.1.30
  certification passes all ten stages in `coworld-adapter/tmp/coworld-cert-o821omx4`.
- `[hosted truth]` Private policy `proxywar-keystone-dta-eval:v1`
  (`b2a4f83f-3aab-444d-834d-9b54d9829be9`) is the control and `:v2`
  (`249f82f3-fdf0-4f1a-89d8-05aefb90ea5c`) is the challenger. They use the
  same image and v16 configuration; only the adjudicator flag differs. Neither
  version is a league submission.
- `[hosted truth]` Coworld `proxywar:0.1.8`
  (`cow_15c39dab-eac1-4284-bf3e-bd723d4c2755`, manifest
  `sha256:1c8a8d3420eb78c736930dcfe5d12a6386b20a0c2be5e7e0369ce3b01395e71c`)
  passed its five hosted smoke episodes and is available for corrected-contract
  evaluation. It intentionally pins the reviewed DTA image above; it does not
  contain the later survival-shield experiment and is not the live league
  binding.
- `[local artifact truth]` The first corrected-runner structural pair completed
  with the same slot-zero win in both arms, 302/302 accepted decisions, and zero
  fallback or degradation. Candidate boot isolation is confirmed. The aggregate
  decision artifact contains all four seats despite a misleading hard-coded
  `opportunistic` profile label, but neither arm selected an alliance request or
  break and the challenger emitted no adjudicator marker. The pair therefore
  had zero treatment activation and cannot establish efficacy.
- `[local artifact truth]` The obsolete shadow stratum stopped after seven
  complete pairs. Its outcomes were byte-identical and Council telemetry was
  healthy, but it lacked the corrected retry telemetry, Europe coverage, fresh
  seeds, and the required zero-fallback result. It is preserved as diagnostic
  evidence and is closed rather than mixed into the candidate stratum.
- `[hosted truth]` A four-player hosted boot smoke on Coworld 0.1.7 confirmed
  the challenger model, v16 tunables, and adjudicator flag, but Auri was
  eliminated by turn 2,200 and qd1n won. Reconstructed spectator decisions show
  Auri itself had zero fallback, zero political selections, and zero adjudicator
  activation; the result's 59 aggregate fallbacks belonged primarily to qd1n.
  Two opponents attacked Auri from turn 1,600 onward while Auri continued
  neutral expansion and economy builds. This is not a DTA result; it is direct
  evidence for a separately gated always-on survival preemption treatment.

## Second isolated treatment: survival shield

The hosted smoke exposed a failure outside diplomacy. The threat model switched
to `build_defense/high` at turn 1,700 and exact Defense Post actions remained
offered, but the ordinary scheduler kept neutral expansion/economy authority as
two opponents removed Auri. The default-off `v16-survival-shield` treatment puts
the already-reviewed survival proposer above that scheduler:

- require detailed, non-retreating pressure from a live non-friendly attacker;
  ignore a single un-escalated probe below 10% of own troops;
- under verified moderate pressure, preempt only a stale neutral expansion,
  economy, hold, or social decision with an exact nearby Defense Post;
- apply a three-decision cooldown after an accepted Defense Post and delegate
  during that cooldown unless pressure is severe;
- admit retreats or bounded counters only at severe pressure (35% incoming,
  or 25% recent territory loss), while
  preserving any authoritative hostile attack or boat campaign;
- exclude SAM and generic border-only placements from this land-pressure arm;
- keep friendly/team safety, unique-target, readiness, commitment, placement,
  and risk checks in the shared world model and survival proposer;
- emit `keystone-survival-shield:v1` only when survival is confirmed,
  preempted, or the treatment itself fails;
- fail closed to the unchanged v16 decision on malformed treatment state.

This arm is mutually exclusive with DTA, the broad politics guard, and the
single-action experiment so its effect remains attributable. It requires a new
immutable image and a separate corrected-contract evaluation before upload as a
policy or Coworld package.

## Promotion gates

1. Focused module, player-wire, reset/retry, matrix-plan, and dataset tests pass;
   root and adapter typechecks pass; lint has no errors.
2. Treat the frozen v16/shadow diagnostic matrix as audited but
   promotion-ineligible; do not finish or mix its old-runner jobs with corrected
   results.
3. Require a corrected-runner structural pair with exact image identity, arm
   isolation, valid result/replay hashes, and no fallback or degradation. This
   gate is complete, but does not substitute for treatment-exposure evidence.
4. Run matched hosted `v16` versus each isolated challenger against the current
   eight-player champion roster on Pangaea, Asia, and World, with
   candidate seat rotation and the same roster order per matched block.
5. Separate old hosted, corrected local, and hosted candidate strata; no result
   may mix contracts. Require zero unexplained timeouts, fallbacks, unknown
   actions, parse failures, and missing jobs, plus auditable treatment markers
   in candidate artifacts.
6. Inspect every discordant pair and require improvement in both episode win
   rate and score share over a meaningful sample before league submission.
7. Upload the corrected Coworld package and submit/rebind only a gate-clearing
   immutable challenger. Live v16 remains unchanged until then.

This treatment is deliberately narrower than making the full Council
authoritative. Expansion, economy, and broader conquest treatments will be
evaluated as separate candidate families so a win or regression has an
identifiable cause.
