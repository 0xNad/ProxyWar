# StrategicCommanderV0 — implementation plan for this repository

Audited at commit `e615dd72a` (branch `claude/strategic-commander-v0-audit-f5bca4`,
clean tree). All symbol names and line numbers below were read from this tree,
not assumed from the proposal. Line numbers drift; symbol names are the durable
reference. This document is a plan only — nothing here is implemented.

A blunt summary up front: the proposal's premise ("the LLM currently chooses
strategy") is already false on current main in at least eleven distinct ways.
The Keystone planner's "must_follow" controls override the LLM's objective
outright in four regimes; the executor cascade re-decides targets, wars, and
betrayals below the plan every decision; `allowPlannerForbidden` call sites
execute action kinds the LLM explicitly forbade; and the replan triggers kill
LLM plans whenever deterministic scorers disagree with them. StrategicCommanderV0
is not "give the LLM strategy for the first time" — it is the first architecture
in this repo where the deterministic layer would be *prohibited* from taking
strategy back. The plan below is written around that fact: most of the work is
not building the new lane, it is proving the old machinery cannot leak into it.

---

## 1. Current architecture map

### 1.1 The one canonical action path (all lanes)

Every autonomous decision, in every lane, flows through:

```
AgentObservationBuilder.build            src/server/agents/AgentObservationBuilder.ts:210
  → LegalActionBuilder.build             src/server/agents/LegalActionBuilder.ts:91
  → AgentBrain.decide                    src/server/agents/AgentTypes.ts:1412
  → validateAgentDecision / …Batch       src/server/agents/AgentDecisionValidator.ts:208 / 242
  → AgentRunner.submitLegalAction        src/server/agents/AgentRunner.ts:196
  → GameServer (case "intent")           src/server/GameServer.ts:405 → addIntent:850
```

Key facts about this spine, verified directly:

- `LegalAction` (AgentTypes.ts:1327) carries a fully pre-built core `Intent`
  (`intent: Intent | null`). Brains only ever return offered `LegalAction.id`
  strings (`AgentDecision`, AgentTypes.ts:1336). The external wire strips
  `intent` before a policy sees the menu (`ExternalAgentRequest`,
  ExternalHttpAgentBrain.ts:39), so no lane can construct raw intents.
- `validateAgentDecision` is an exact-id membership check; its only fallback is
  the offered `hold` action. The deal slot (`validateAgentDealDecision`, :33)
  and comms slot (`validateAgentMessageDecision`, :88) drop-never-substitute.
- `AgentRunner` contains zero decision logic; it is an in-process WebSocket shim
  (`InProcessAgentSocket`) that Zod-parses `ClientIntentMessageSchema` and emits
  into the same GameServer handler human clients use. "Accepted" means "no
  immediate synchronous server error" (AgentRunner.ts:291) — later engine
  rejection is invisible to the decision record.
- Meta-kinds with `intent: null` (`hold`, `message`, the four `deal_*` kinds)
  never reach the game; deals route to `AgentDealManager.applyDealAction`
  (AgentLeagueMatch.ts:683), messages to `AgentRunner.submitAgentMessage`.

### 1.2 Direct-LLM lane ("action selector")

`LlmAgentBrain` (LlmAgentBrain.ts:30, `--brain=action-claude-cli|openrouter|real-llm|codex-cli`):
`LlmPromptBuilder.build` (LlmPromptBuilder.ts:22) assembles one prompt containing
the full observation, the full `LEGAL_ACTIONS_JSON` menu, `OPPONENT_MODEL_JSON`,
playbook doctrine (`AgentPlaybook.ts`), `profileGuidance` preference orderings,
and — critically — `RANKED_CANDIDATES_JSON`: the deterministic executor's own
top-12 scoring via `rankLegalActionsForPrompt` (AgentPlannerExecutor.ts:1314),
with the prompt instruction "Treat it as a strong prior" (LlmPromptBuilder.ts:74).
Providers implement `LlmProvider.complete(prompt): Promise<string>`
(LlmProvider.ts:16; Claude CLI / Codex CLI / OpenAI / OpenRouter / Mock).
`LlmDecisionParser` (LlmDecisionParser.ts:153) never repairs the primary id — an
off-menu `selectedLegalActionId` is a hard failure that hands the whole decision
to `LlmAgentBrain.fallback` (:201) → `RuleAgentBrain`, stamped
`fallbackUsed: true`, `reason: null`.

### 1.3 Planner/executor lane (Keystone, the current champion architecture)

`PlannerExecutorAgentBrain` (AgentPlannerExecutor.ts:567) composes:

- `AgentPlanner.plan(input, previousPlan) → Promise<AgentPlanDecision>` (:258).
  Implementations: `RuleAgentPlanner` (:982), `MockLlmPlanner` (:1849),
  `LlmAgentPlanner` (:1882), plus `DeferredAgentPlanner`
  (coworld-adapter/src/keystone-player.ts:926) for the hosted seat.
- `StrategicPlan` (:191): `objective: AgentObjectiveKind`, `turnIntent?`,
  `targetPlayerId`, `maxDecisionCycles` (clamp 1–8, default 3),
  `preferredActionKinds` / `forbiddenActionKinds`, `enabledModules?`,
  `tacticalSettings?`, at most one binding directive (`commitment` /
  `allianceDirective` / `buildDirective`, precedence enforced by
  `singleBindingDirective` :22981), `plannerSource`, `degradedOrigin?`.
- `AgentExecutor.decide(input, plan) → AgentExecutionDecision` (:289).
  Implementations: `RuleAgentExecutor` (:1009) and the default
  `FrontierPolicyExecutor` (:1347), whose `selectFrontierActionBatch` (:2945)
  is a ~80-leaf forced-candidate cascade over `rankFrontierActions` (:1162)
  scoring (`scoreFrontierAction` :17023 + `StrategicSkillEvaluator` at weight
  0.28), followed by post-batch primary rewrites (economy-bootstrap strip,
  openingTempo/openingCommit swaps, `promoteArgmaxPrimary` :2911).
- Replan cadence: `plannerRefreshReason` (:841) — counter triggers
  (`no_active_plan`, `plan_max_decision_cycles`, `brain_plan_interval` at
  `planEveryDecisionSteps` default 3) plus ~10 deterministic
  strategy-divergence triggers (see §3).
- The LLM planner prompt embeds `plannerDecisionBrief` (:21917) whose
  `plannerRecommendedControls` (:22125) is a deterministic strategy directive
  with strengths `must_follow` / `strong_hint` / `weak_hint`;
  `mustFollowControlViolation` (:22386) rejects a parsed LLM plan that
  disagrees with a `must_follow` control, `plannerRepairPrompt` (:22429) forces
  a corrected JSON, and persistent disagreement falls back to
  `RuleAgentPlanner` with `plannerSource` still labeled `'real-llm'`/`'codex-cli'`
  (LlmAgentPlanner.fallback :2110, keeps the label at :2151; truth lives in
  `degradedOrigin`/`llmPlannerDegraded`).

### 1.4 Deterministic lanes

`RuleAgentBrain` (RuleAgentBrain.ts:10; obeys `observation.objective` first via
`preferredObjectiveAction` :198, then `observation.strategic.priority` :106),
`StrategyAgentBrain` (StrategyAgentBrain.ts:19; hand-written winning plan),
`StarterBotAgentBrain` (StarterBotAgentBrain.ts:27; naive first-match port of the
public Coworld starter). All report `brainType: "rule"`.

### 1.5 External / hosted Coworld lane

`ExternalHttpAgentBrain` (ExternalHttpAgentBrain.ts:112) POSTs
`ExternalAgentRequest` (full observation, intent-stripped menu, plus
`decisionSupport` — deterministic recommendations built by
`buildExternalAgentDecisionSupport` :408) and parses the reply with the strict
`LlmDecisionParser`. `ExternalRelayAgentBrain` is the managed-relay variant. The
hosted Keystone seat runs `coworld-adapter/src/keystone-player.ts`:
`requestToBrainInput` (:590) → menu pre-filter `withoutKeystoneTreatyBreaches`
(:454) → the same `PlannerExecutorAgentBrain` in-process →
`decisionToResponse` (:635). Wire constants (`MAX_WIRE_ACTIONS_PER_DECISION=5`,
`AGENT_DEGRADATION_CAUSES`, AgentWireProtocol.ts:24/51) are mirrored as pinned
literals in `coworld-adapter/src/coworld-decision-wire.ts`.

### 1.6 Local league / experiment harness

`AgentLeagueMatchRunner` (AgentLeagueMatch.ts:218) owns the per-decision loop:
observation batch (`withObservationBatch`, AgentObservationBuilder.ts:182) +
`AgentObjectiveManager.objectiveFor` stamped onto the observation
(AgentLeagueMatch.ts:436) + menu build + `dispatchBrainDecision` (:1992) under
`decideWithSafetyFallback` (:2090; timeout/throw → substituted `RuleAgentBrain`
decision) + per-id validation (`validateParticipantBatch` :524) + round-robin
submission (`interleaveLayers`). Drivers: `runAgentStepLockedLeague`
(AgentStepLockedLeague.ts:82; turn advancement only via
`game.advanceTurnsForTesting`, `realtimeClock:false` at AgentLeagueMatch.ts:272)
behind `src/scripts/ai-agent-league-smoke.ts` (`--brain=`/`--opponent-brain=`
modes, brain construction `createBrainForMode` :1574) and
`src/scripts/ai-agent-frontier-benchmark.ts` (one subject seat vs nations/bots,
deterministic `gameID = FRNT<index>`; the core PRNG is seeded from the gameID —
`GameRunner.ts:56 new PseudoRandom(simpleHash(gameStart.gameID))`). Matched A/B
already exists as `ai-agent-learning-ab-gate.ts` (two benchmark invocations with
identical seeds/ids, one flag flipped) + `writeAgentLearningComparison`
(AgentLearningComparison.ts:348).

### 1.7 Artifacts

`writeAgentLeagueRunArtifacts` (AgentDecisionLogWriter.ts:405) writes
`decisions.jsonl` — one `DecisionLogEntry` (:173, non-exported) per decision,
populated by the hand-maintained metadata **allowlist** `decisionLogEntry`
(:615). Anything not hoisted there is silently lost league-wide (two documented
prior losses: `dealStatedReason`, `brainErrorReason`). Spectator telemetry
(`buildAgentSpectatorTelemetry`, AgentSpectatorTelemetry.ts:226) stamps
provenance (`decisionEventProvenance` :807: `evidenceLevel`, `fallbackUsed`,
`llmPlannerDegraded`, `degradedCause`). Effect audits
(`auditDecisionEffects`, AgentActionAuditor.ts:47) mutate `record.audit` with
`confirmed|unknown|failed|not_applicable`. The viewer already renders
**plan-change beat cards with zero viewer work**: `planChangeWarRoomEvents`
(src/client/BroadcastBeats.ts:542) curates tier-2 cards from
`decisionMetadata.planObjective` transitions in decisions.jsonl.

---

## 2. Recommended integration point

**Recommendation: a new parallel `AgentBrain` implementation
(`StrategicCommanderBrain`, new file), selected per seat via the existing
`brainFactory` / `--brain=` mechanisms. Not a new `AgentPlanner` plugged into
`PlannerExecutorAgentBrain`, and not a modification of any existing brain.**

Why not a new `AgentPlanner` + `AgentExecutor` inside `PlannerExecutorAgentBrain`
(the superficially obvious reuse):

1. **The brain itself owns replan authority, and its triggers are strategic.**
   `plannerRefreshReason` (AgentPlannerExecutor.ts:841) fires
   `expansion_plan_diverged_to_pressure`, `alliance_plan_stale`,
   `tactical_pressure_handoff_ready`, `urgent_defense`, etc. — deterministic
   code killing a standing plan because scorers and affordance `recommended`
   bits disagree with it. The V0 spec requires replans **only** on an explicit
   bounded enum. Those triggers cannot be disabled without editing the shared
   brain, and editing the shared brain contaminates Arm A (which must run
   "the current planner/executor architecture unchanged").
2. **`StrategicPlan` is the wrong contract for the Commander.** It carries
   `preferredActionKinds`, `forbiddenActionKinds`, `enabledModules`, and
   `tacticalSettings` — LLM-authored mechanics knobs the V0 authority boundary
   assigns to deterministic code. Reusing the type invites every consumer of
   those fields (~30 `forbiddenActionKinds` sites, `applyTacticalSettings`
   :2234, `enabledModulesForPlan` :16929) back into the loop.
3. **B/C symmetry is structurally provable only at a selector seam.** The
   experiment's causal claim is "B and C share every component except the
   selector." Under the planner-swap design, B and C differ at the
   `AgentPlanner` level, where parse/repair/fallback/merge code paths
   (`parsePlannerOutput`, `mustFollowControlViolation`,
   `mergePlayerConstraintsIntoPlan`) differ between deterministic and LLM
   planners. Under the new-brain design, both arms are the *same class* with a
   single injected `StrategicOptionSelector`; symmetry is enforced by the
   constructor signature, not by review.
4. **Operator precedent.** keystone-player.ts records a standing operator rule
   (2026-06-10): never run a deterministic executor as a hosted seat. Arm B is
   therefore a local, labeled evaluation arm; a brain that exists only behind
   new local `--brain=` modes cannot be accidentally promoted by manifest
   labeling (manifest `brainType` is mostly a label — only `external-*`
   overrides seat brains, `manifestHasBrainOverride`,
   ai-agent-league-smoke.ts:1532).

What IS reused (deliberately, all read-only from the new lane's perspective):
the canonical spine (§1.1) untouched; `AgentObservation`/`LegalAction` types;
`AgentBrain`/`AgentBrainInput`/`AgentDecision` contracts;
`withDeferredDecisionTimeout`; the `AGENT_DEGRADATION_CAUSES` vocabulary; the
`decisionMetadata` keys that already flow to artifacts (`planObjective`,
`planRationale`, `planID`, `planFollowed`, `plannerFallbackUsed`,
`llmRawOutput`, `llmParseOk`, `degradedCause`) so plan beat cards and
degradation accounting work with zero viewer changes; the harness
(`brainFactory`, step-locked league, benchmark seeds); and low-level mechanics
helpers inside the executor **after** the option filter (§8).

Rejected alternatives, for the record: (a) "selector inside `LlmAgentBrain`
via a custom `promptBuilder`/`parser`" — the option lifecycle has no home there
and fallback semantics are wrong; (b) "external policy behind
`ExternalHttpAgentBrain`" — right for hosted later, wrong for V0 because the
experiment needs in-process determinism and shared-component proof;
(c) "generalize `thinPlanExecutionCandidate` (:6557)" — it is the closest
existing *executor* prototype (named intent executed literally) and its tests
(tests/server/ThinExecutor.test.ts:119–263) are the template to clone, but it
lives below the directive leaves and stands down whenever
`warModeInvaderIDs(observation).size > 0` (:6571), i.e. inside exactly the
cascade V0 must escape.

---

## 3. Authority-leak audit

Exact current files/symbols that could reclaim strategic authority from a
Commander. Classification: **[P]** prompt/observation-side steering (leaks into
what the LLM reads), **[X]** executor-side substitution (changes what runs),
**[R]** replan/lifecycle authority, **[F]** fallback authorship, **[M]** menu
shaping before the brain.

Planner/prompt layer:

- **[P/X]** `plannerRecommendedControls` (AgentPlannerExecutor.ts:22125) +
  `mustFollowControlViolation` (:22386) + `plannerRepairPrompt` (:22429) —
  deterministic code authors the objective/turnIntent/target and *rejects and
  repairs* a valid LLM plan that disagrees, in four `must_follow` regimes
  (spawn; homeDanger high → survive; tile share < `PROXYWAR_TUNE_BASE_TILESHARE_FLOOR`
  (0.1) → expand; economy window). The in-code 2026-06-19 comment (:22275-22283)
  records that `pressure-ready` was demoted from must_follow because it
  "overrode every doctrine" — this codebase has already litigated who owns
  strategy once. This is the single clearest violation of the V0 boundary, and
  it is pinned by tests (tests/server/AgentPlannerExecutor.test.ts:196).
- **[P]** `rankLegalActionsForPrompt` (:1314) → `RANKED_CANDIDATES_JSON`
  (LlmPromptBuilder.ts:38-54, instruction at :74) — the executor's own scorer
  hands the LLM a ranked top-12 with `totalScore`/`policyScore`/`skillScore`/
  `module`/`topSkill`/`penalties`; plan-less callers get a rule plan
  synthesized to frame the scoring (`synthesizeRulePlanSync` :1280).
- **[P]** `AgentStrategicStateBuilder` (AgentStrategicStateBuilder.ts:23) —
  `observation.strategic` = a complete parallel strategist: `priority`
  (:146), `recommendedActionKinds` (:217), `targetPlayerIDs` (:245), `scores`.
  Serialized into every prompt.
- **[P]** `buildAgentTacticalAffordances` (AgentTacticalAffordances.ts:147) —
  eleven analyzers, each with `recommended: boolean` and pre-picked winners
  (`bestStrikeActionID`, `bestBuildID`, `bestNavalActionID`,
  `bestSocialActionID`, `bestAllyTargetID`, `backstabTargetID`,
  `bestAttackID`/`bestTargetID`), two with imperative prose ("Ally <name> …
  NOW" :54-74; "BACKSTAB <name>" :108-125). Injected verbatim into prompts
  (LlmPromptBuilder.ts:224) *and* consumed as score bonuses
  (AgentStrategicSkills.ts:194/208/317: +52/+34/+36 when `action.id` equals
  the affordance's best id). Note: `FrontierPolicyExecutor` does **not** read
  `observation.tacticalAffordances` — it recomputes them at ~15 call sites
  (:4235–7270), so stripping them from the Commander state does not disarm
  the old executor; only not using that executor does.
- **[P]** `AgentObjectiveManager.objectiveFor` (AgentObjectiveManager.ts:27,
  stamped at AgentLeagueMatch.ts:436) — a deterministic objective (same
  vocabulary as the V0 options) chosen by profile cascade, visible in the
  observation and used for alignment grading.
- **[P]** `observation.memory.avoidActionIDs` (AgentMemoryBuilder;
  AgentTypes.ts:1009) — a deterministic do-not-pick list.
- **[P]** `combatState.weakestAttackableTargetID` / `strongestAttackableTargetID`
  (AgentObservationBuilder.ts:599/641-642) — pre-selected attack targets.
- **[P]** playbook doctrine: `openFrontAgentPlaybook`,
  `economyDeterrencePlaybook`, `profilePlaybook`, `frontierAgentSkill`
  (AgentPlaybook.ts:6/25/31/44) and `profileGuidance`
  (LlmPromptBuilder.ts:237) — strategy authored as prompt text.
- **[P]** `buildExternalAgentDecisionSupport` (ExternalHttpAgentBrain.ts:408) —
  `recommendedActionKinds`, `usefulNonHoldActionIDs`, `avoidActionIDs`,
  `safeFallbackActionID` handed to external policies.

Executor layer:

- **[X]** `selectFrontierActionBatch` (:2945) — the cascade's ~15 strategy
  leaves fire *above* the plan-driven scheduler and mostly ignore
  `plan.objective`/`targetPlayerId`: `dominantEliminationLockCandidate`
  (:3080), `backstabAllyBreakCandidate` (:3095 — in-code comment: "the LLM
  Commander won't break a protective alliance off the JSON signal, so the
  executor makes it deterministic"), `warModeCounterstrikeCandidate` (:3106),
  `coalitionAllianceAcceptCandidate` (:3120), `navalWarCandidate` (:3130),
  `behindAndFallingStrikeCandidate` (:3141), `goldPressureSpendCandidate`
  (:3066), `economyBootstrapStructureCandidate` (:3155), plus ~45 `hardNation*`
  and `demoQuality*`/`political*` leaves. Leaves match on exact
  policy-contribution *reason strings* (`hasPolicyContribution`) — load-bearing
  string coupling.
- **[X]** `directSelectionCandidate` `{allowPlannerForbidden: true}` (:15031;
  call sites e.g. :3170/:3183/:3205/:3233) and
  `hasPlannerForbiddenDirectOverride` (:15139) — explicit bypass of the plan's
  `forbiddenActionKinds`. Two more bypasses verified first-hand: the
  `politicalNukeOverride` (≈:4853, a forbidden `nuke` allowed in agent-only
  political matches) and the expansion-attack exemption
  (≈:4166, `metadata.expansion === true` escapes a forbidden `attack`).
- **[X]** `enforceConversionOverNeutralRanking` (:1245,
  `PROXYWAR_TUNE_ENFORCE_CONVERSION` default **ON**) — post-rank clamp forcing
  conversion attacks above all neutral growth; reaches both the executor and
  the LLM shortlist through the shared ranker.
- **[X]** post-batch primary rewrites: openingTempo (:1437-1461),
  openingCommit phase-lock/escalation/no-op suppression (:1486-1633),
  `promoteArgmaxPrimary` (:2911, `PROXYWAR_TUNE_PRIMARY_ARGMAX`).
- **[X]** `resolvedPlanTurnIntent` (:21011) — silently rewrites the LLM's
  declared `turnIntent` when no matching legal action exists this decision.
- **[X]** `targetForPlan` (:21362) — when the LLM omits a target, a
  deterministic priority chain picks the rival.
- **[X]** `scoreProfileRepairRerankAction` (AgentProfileRepairPolicy.ts:23,
  gated by `settings.profileRepairReRankEnabled` default **true** at
  AgentPlannerExecutor.ts:322) — penalizes `hold` by 46 inside "repair
  windows"; directly fights a `survive`-style plan.
- **[X]** `StrategicSkillEvaluator` caps and bonuses
  (AgentStrategicSkills.ts:435 caps; affordance-best bonuses above) — reshape
  every ranking both arms see.
- **[X]** `mergePlayerConstraintsIntoPlan` (PlayerStrategySpec.ts:189, bound at
  AgentPlannerExecutor.ts:1914) — drops LLM commitments and seeds directives
  the Commander never authored; `singleBindingDirective` (:22981) silently
  drops surplus directives; `validatedCommitment` (:22846) silently degrades
  invalid directives to undefined.

Replan authority:

- **[R]** `plannerRefreshReason` (:841) — the divergence triggers listed in §2.
- **[R]** `AgentObjectiveManager.shouldKeepObjective` (:231) — communication
  signals and expansion-streak rules churn the objective.

Fallback authorship (three stacked layers on every seat):

- **[F]** brain-internal: `LlmAgentBrain.fallback` (:201),
  `LlmAgentPlanner.fallback` (:2110), `ExternalHttpAgentBrain.fallback`
  (:309), `ExternalRelayAgentBrain` (:211), `RuleAgentExecutor`'s
  no-aligned-action fallback (AgentPlannerExecutor.ts:1043, `planFollowed:false`
  but a *different strategy* executes) — all substitute `RuleAgentBrain`
  output.
- **[F]** league-level: `decideWithSafetyFallback` (AgentLeagueMatch.ts:2090)
  substitutes a full `RuleAgentBrain` decision on timeout/throw.
- **[F]** validator-level: hold fallback (AgentDecisionValidator.ts:215-216),
  stamped `validationFallbackUsed` (AgentLeagueMatch.ts:566-582).
- **[F]** endgame autopilot: `runAgentStepLockedLeague` +
  `onAutopilotEngage` (AgentStepLockedLeague.ts:121;
  ai-agent-league-smoke.ts ≈:500) — labeled wholesale takeover
  (`runtimeMode: "autopilot-executor"`, `autopilotEngagedAtStep` in artifacts).

Menu shaping before any brain:

- **[M]** `withoutKeystoneTreatyBreaches` (coworld-adapter/src/keystone-player.ts:454,
  applied ≈:1373) — deletes pact-breaking actions from the menu pre-decide.
  NOTE: the proposal's implied assumption that the treaty guard lives in
  `AgentDealManager`/`AgentDealCompliance` is wrong — the referee in src/server
  narrates and never vetoes; the veto lives in the Coworld package. Hosted-only;
  V0 local arms never see it, but it must be inventoried for any future hosted
  Commander.
- **[M]** `reservedQuotaTruncate` (LegalActionBuilder.ts:1544) — under menu
  pressure, assembly order decides which kinds survive (early kinds
  retreat/attack/boat structurally evict late kinds target_player/quick_chat).
- **[M]** `hostileAttackTroopPercentages` [0.1, 0.25, 0.4]
  (LegalActionBuilder.ts:886), `boatTroopFractions` favorability gating
  (:1173), `shouldOfferNationOpeningForceExpansion` (:720),
  `supportAcceptanceFeasible` (:1341), `messageActions` relevance ranking
  (:1230), donation amounts fixed to `suggestedGold`/`suggestedTroops` — the
  menu itself encodes sizing and curation policy. V0 accepts these as
  deterministic-owned mechanics (attack intensity is explicitly
  executor-owned), but they must never be *presented to the LLM as rankings*.
- **[M]** `filterDisabledActionKinds` / same-turn diplomacy/build filters
  (AgentLeagueMatch.ts:1770/527) — harness-level availability gating.

V0 consequences drawn from this audit (binding on the design in §4–§8):

1. The Commander lane must not construct its prompt from `observation.strategic`,
   `observation.tacticalAffordances`, `observation.objective`,
   `observation.memory.avoidActionIDs`, `combat.weakest/strongestAttackableTargetID`,
   `LegalAction.risk`, ranked candidates, playbooks, or `profileGuidance`.
2. The Commander lane must not call `selectFrontierActionBatch`,
   `promoteArgmaxPrimary`, `resolvedPlanTurnIntent`, `targetForPlan`,
   `mergePlayerConstraintsIntoPlan`, or any `plannerRecommendedControls`
   machinery. Scoring reuse is limited to *inside* the option filter (§8).
3. Fallback layers cannot all be removed (the league harness owns two of
   them); they must instead be attributed and excluded (§10).
4. `profileRepairReRankEnabled` must be forced off in the option executor's
   settings if any frontier scoring is reused (§8), because it penalizes
   `hold`-shaped survive play by design.

---

## 4. StrategicOption design

New types (new file `src/server/agents/StrategicCommanderTypes.ts`). Two-tier
split so the executor binding can carry action ids while the LLM-visible tier
cannot:

```ts
export const strategicOptionFamilies = [
  "expand",
  "develop_economy",
  "pressure_rival",
  "survive",
] as const;
export type StrategicOptionFamily = (typeof strategicOptionFamilies)[number];

/** Stable id: family, or `pressure_rival:<playerID>`. */
export type StrategicOptionId = string;

/** Internal candidate — never serialized into any prompt. */
export interface StrategicOptionCandidate {
  id: StrategicOptionId;
  family: StrategicOptionFamily;
  targetPlayerID: string | null;          // pressure_rival only
  /** Executor binding: exact offered LegalAction.ids proving executability,
   *  partitioned by fidelity class. Rebuilt every decision from the live menu —
   *  action ids are NOT stable across decisions; only option ids are. */
  binding: {
    alignedPrimaryActionIDs: string[];    // sorted by id (localeCompare)
    alignedSupportActionIDs: string[];    // sorted by id
  };
  /** LLM-visible factual evidence (see per-family tables, §5). */
  evidence: StrategicOptionEvidence;
}

/** LLM-visible projection. NO action ids, NO scores, NO risk, NO ranks. */
export interface ExposedStrategicOption {
  id: StrategicOptionId;
  family: StrategicOptionFamily;
  targetPlayerID: string | null;
  targetName: string | null;              // sanitized (PromptSanitizer)
  evidence: StrategicOptionEvidence;      // facts + counts only
}

export type StrategicOptionOmissionReason =
  | "family_cap"            // duplicate-family candidate beyond coverage
  | "pressure_target_cap"   // beyond the 2-target cap
  | "exposure_cap";         // beyond the 8-option cap

export interface StrategicOptionSetRecord {
  eligibleOptionIds: StrategicOptionId[];     // all candidates, sorted
  exposedOptionIds: StrategicOptionId[];      // ≤ 8, exposure order
  omitted: { id: StrategicOptionId; reason: StrategicOptionOmissionReason }[];
  fingerprint: string;                        // see §6.5
}
```

### 4.1 Builder (`StrategicOptionBuilder.ts`)

`buildStrategicOptions(input: AgentBrainInput): { candidates, exposed, record }`.

Eligibility = "at least one aligned-primary action for this option exists in
the offered menu right now" (exact predicates in §5). The builder:

1. Normalizes inputs first: sorts its own working copies of `legalActions` (by
   `id` localeCompare) and `visiblePlayers` (by `playerID` localeCompare)
   before any iteration, so the candidate set, exposure, and omission record
   are invariant to input ordering. This is required, not decorative:
   `visiblePlayers` arrives in core player order (AgentObservationBuilder.ts:456,
   unsorted), and menu order is assembly-order dependent.
2. Produces every eligible candidate. `expand`, `develop_economy`, `survive`
   have at most one candidate each. `pressure_rival:<id>` produces one
   candidate per eligible rival.
3. Caps pressure targets at 2 with a **stable, non-scoring, coverage-first
   rule**: partition eligible targets into (a) land-border reachable
   (`sharesBorder === true` on the rival row) and (b) boat-only reachable.
   If both classes are non-empty, expose the lexicographically-smallest
   `playerID` from each class (one per reach class = representational
   coverage of qualitatively different pressure options). Otherwise expose the
   two lexicographically-smallest `playerID`s of the one class. No troop
   ratios, no tile shares, no scores enter this rule. Every omitted target is
   recorded with reason `pressure_target_cap`.
4. Applies the exposure rule: with 4 families and ≤2 pressure targets the
   maximum exposure is 5 options, comfortably under the 8 cap, so
   `family_cap`/`exposure_cap` are structurally unreachable in V0 — they exist
   in the enum (and in tests) so that adding option families later cannot
   silently drop coverage. Exposure order is fixed and non-preferential:
   family declaration order (`expand`, `develop_economy`, `pressure_rival`
   targets in the cap rule's order, `survive`).
5. Emits the `StrategicOptionSetRecord` (stamped into `decisionMetadata` —
   §9.3 — so eligible/exposed/omitted ids are in decisions.jsonl for every
   Commander decision).

### 4.2 Banned-content enforcement

`ExposedStrategicOption` and `CommanderState` (§6) are the only objects
serialized into the Commander prompt. Two enforcement layers, both tested:

- **Type allowlist**: the exposed types contain no field capable of carrying a
  score/rank (no numbers except factual quantities enumerated in §5's
  LLM-visible columns; no `risk`, no `recommended`, no `best*`, no
  `priority`, no position-implying arrays of actions).
- **Serialization audit test**: serialize the exposed set + state for
  adversarial fixtures and assert the absence of banned keys and of any
  `LegalAction.id` substring (ids are recognizable: `attack:`, `expand:`,
  `build:`, `boat:`, `alliance:`, `embargo:`, `donate_`, `upgrade:`,
  `target:`, `spawn:`, `hold`). See §13 for the vacuous-pass caveat.

---

## 5. V0 family mapping

Ground truth about the menu that the mapping must respect (verified in
LegalActionBuilder.ts):

- Neutral expansion is kind `attack` with id prefix `expand:terra-nullius:` and
  `metadata.expansion === true`, `intent.targetID === null`. Any mapping keyed
  on kind alone lumps it with pressure attacks — discriminate on metadata.
- Id prefixes lie three times: `alliance:<pid>` → kind `alliance_request`,
  `target:<id>` → `target_player`, `upgrade:<unit>:<unitID>` →
  `upgrade_structure`. Never parse strategy from id prefixes; key on
  `kind` + `metadata`.
- `boat_retreat` is a declared kind with **no producer anywhere in src/**
  (grep-verified by the audit) — treat as dead; do not map it.
- `boat:<targetTile>:<pct>` omits the source tile from the id — a real
  (if rare) collision risk the executor must tolerate (first match after the
  builder's id sort wins; both collide onto the same intent shape anyway).
- Attack ids are stable while `intent.troops` changes with own troops each
  tick — id equality across decisions does not mean payload equality. Bindings
  are rebuilt every decision (§4).

Existing alignment predicates were checked and are **three-way divergent**
(`actionAlignsWithObjective` AgentObjectiveManager.ts:38 vs `objectiveAligned`
AgentStrategicSkills.ts:617 vs `recentDecisionAlignsWithObjective` :111 — e.g.
MissileSilo counts as economy in one and not another). V0 defines its own
canonical table below (a deliberate fourth copy, scoped to the Commander lane,
exact and tested; unifying the legacy three is out of scope).

For each family: executability proof (eligibility predicate over observation +
menu), LLM-visible evidence (facts only), and the executor-only binding.

### 5.1 `expand`

- **Eligible iff** menu contains kind `attack` with
  `metadata.expansion === true` (equivalently
  `observation.combat.canExpandIntoNeutral` plus troops ≥ 10 — but the menu
  presence is the proof; never re-derive), OR kind `boat` with
  `metadata.targetID === null` (neutral transport).
- **LLM-visible evidence**: `{ neutralLandReachable: boolean,
  neutralBoatReachable: boolean, ownTroops: number, ownTiles: number }`.
- **Aligned primary (executor-only)**: `attack` with
  `metadata.expansion === true`; `boat` with `metadata.targetID === null`.
- **Aligned support**: none in V0.

### 5.2 `develop_economy`

- **Eligible iff** menu contains kind `build` with
  `metadata.role === "economic"` or `metadata.unit ∈ {City, Factory, Port}`,
  OR kind `upgrade_structure` with `metadata.unit ∈ {City, Factory, Port}`.
  MissileSilo/SAMLauncher are **excluded** (deterrence, not economy — siding
  with the skills-evaluator variant against the ObjectiveManager variant;
  nuclear strategy is out of V0 scope).
- **LLM-visible evidence**: `{ economicBuildAvailable: boolean,
  economicUpgradeAvailable: boolean, gold: string, ownTiles: number }`
  (gold is already a bigint string in `AgentOwnState.gold`).
- **Aligned primary**: the qualifying `build` / `upgrade_structure` actions.
- **Aligned support**: none in V0. (Embargoes are trade *pressure*, not
  development; they belong to pressure_rival support.)

### 5.3 `pressure_rival:<playerID>`

- **Eligible per rival R iff** R is in `visiblePlayers` with `isAlive` and the
  menu contains kind `attack` with `metadata.expansion !== true` and
  `metadata.targetID === R.playerID`, OR kind `boat` with
  `metadata.navalInvasion === true` and `metadata.targetID === R.playerID`.
- **LLM-visible evidence**: `{ targetName (sanitized), sharesBorder: boolean,
  targetTroops: number, targetTiles: number, ownTroops: number,
  targetIsAllied: boolean, targetAttackedMeRecently: boolean }` (last field
  from `combat.incomingAttackPlayerIDs` membership — a fact, not a
  recommendation). Deliberately absent: `relativeTroopRatio` as a named
  comparison field is defensible as a fact but reads as a precomputed verdict;
  the Commander can divide two numbers.
- **Aligned primary**: non-expansion `attack` on R; `navalInvasion` `boat`
  on R.
- **Aligned support (narrow, per spec)**: `embargo:<R>:start` (kind `embargo`,
  `metadata.targetID === R`) and `target:<R>` (kind `target_player`). Support
  may only be batched alongside a primary in the same decision, never taken
  alone (taking support alone while primaries exist would let the executor
  soften the Commander's aggression — a substitution).
- **Excluded from V0 entirely**: `nuke`, `move_warship`/`warship`,
  `break_alliance` (nuclear/naval/betrayal are out-of-scope strategy, not
  subordinate mechanics), `deal_*`, `message`, `quick_chat`, `emoji`.

### 5.4 `survive`

- **Eligible iff** menu contains kind `retreat`, OR kind `build` /
  `upgrade_structure` with `metadata.role === "defensive"`, OR (always) the
  `hold` action — i.e. `survive` is eligible whenever the seat is alive. This
  is deliberate: the option set must never be empty post-spawn.
- **LLM-visible evidence**: `{ incomingAttackCount: number,
  strongerBorderRivalCount: number, ownTroops: number, borderTiles: number }`
  (stronger-border count computed from raw troops comparison of bordering
  non-friendly rivals — a count of facts; the 1.15 threshold used by
  `strategicScores` is a tunable heuristic, so V0 uses plain `>`).
- **Aligned primary**: `retreat`; defensive-role `build`/`upgrade_structure`;
  `hold`.
- **Aligned support**: none in V0. Alliance actions (`alliance_request`,
  `alliance_extend`, `alliance_reject`), donations, `embargo_stop`, and deal
  acceptance are **excluded** — alliance strategy is an excluded option family,
  and admitting its actions as "survival support" is precisely the generic
  escape hatch the spec forbids. Cost acknowledged: V0 Commander seats cannot
  ally, which handicaps Arms B *and* C equally vs Arm A (whose planner allies);
  this is a known interpretation constraint on A-vs-C (§10.5, §14).

### 5.5 Out-of-family kinds

Everything else (`spawn`, `alliance_*`, `break_alliance`, `donate_*`,
`emoji`, `quick_chat`, `message`, `deal_*`, `nuke`, `warship`,
`move_warship`, `embargo_all`, `embargo_stop`, `delete_unit`, `boat_retreat`)
is outside every V0 binding: the executor can never select it, and the
fidelity classifier (§8.4) would classify it as a violation if it ever
appeared. Spawn phase is handled outside the option system entirely: the
Commander brain delegates spawn-round ballots to the existing deterministic
spawn ranking used by `RuleAgentBrain.decide` (spawn is a sealed one-shot
ballot with a server-side allocator — `AgentSpawnSelectionEvidence`,
AgentTypes.ts:1454 — not a strategic option; all three arms share this
identical spawn path, so it cancels in every comparison).

---

## 6. Commander state and prompt

### 6.1 `CommanderState` (built by new `CommanderStateBuilder.ts`)

Every field, its source, bound, and sanitizer. Nothing else may appear; the
builder constructs this object field-by-field (no spreads from
`AgentObservation` — spreads are how banned fields leak).

```
field                          source (exact)                                  bound / sanitizer
self.name                      observation.username                            sanitizeUntrustedDisplayString (48)
self.profile                   observation.profile                             enum passthrough
self.phase                     observation.phase                               enum
self.turnNumber                observation.turnNumber                          number
self.troops / maxTroops        observation.ownState.troops / maxTroops         numbers
self.gold                      observation.ownState.gold                       bigint string, verbatim
self.tilesOwned / tileShare    observation.ownState.tilesOwned / tileShare     numbers
self.borderTiles               observation.ownState.borderTiles                number
self.incomingAttacks           observation.ownState.incomingAttacks            number
self.outgoingAttacks           observation.ownState.outgoingAttacks            number
self.alivePlayerCount          observation.alivePlayerCount                    number
rivals[] (≤ 6)                 observation.visiblePlayers (see selection)      per-rival record below
plan (current or null)         CommanderPlanLifecycle state                    §7 snapshot shape
recentEvents[] (≤ 8)           derived (see 6.2)                               bounded strings, sanitized 120
options[]                      ExposedStrategicOption[] (§4)                   ≤ 8
```

Per-rival record (facts only): `{ playerID, name (sanitized), isAlive,
troops, tilesOwned, tileShare, sharesBorder, isAllied,
attackedMeRecently (from combat.incomingAttackPlayerIDs),
iAmAttackingThem (from combat.outgoingAttackPlayerIDs) }`.

Rival **selection** rule for the ≤6 cap (stable, fact-based): include, in
order, (1) all rivals currently attacking me, (2) all rivals I am attacking,
(3) all border rivals, (4) remaining rivals by `tilesOwned` descending — each
group internally sorted by `playerID` localeCompare, dedupe across groups,
truncate at 6. Size ordering in group 4 is a factual ordering used for
*inclusion*, not a strategy label; it is the same "relevance" any observer
would use and is disclosed here as the one judgment call in the state builder.

**Must-not-contain (enforced by the state builder's field-by-field
construction and by the §13 serialization audit):** raw `LegalAction` ids or
menu, `observation.strategic` (priority/scores/recommendedActionKinds/
targetPlayerIDs), `observation.tacticalAffordances`, `observation.objective`,
`observation.memory` (including `avoidActionIDs`), `opponentModel` (its
`trust`/`predictedNextAction` are deterministic verdicts),
`recentDecisions` raw rows, `risk` anything, playbooks, `FrontierAgent/SKILL.md`,
minimap/spatial, `notes`, deterministic baseline choice, and every
`deals`/`economy` block (their flags are OFF in the experiment anyway).

### 6.2 `recentEvents`

Bounded factual deltas derived by the lifecycle module (not by re-reading
`recentDecisions` prose): territory delta since plan start, troop delta since
plan start, new incoming-attacker playerIDs since previous decision, rival
deaths since previous decision, own elimination risk events (lost tiles >
threshold-free statement: report the raw delta, no label). Format: fixed
templates ("tiles 412→508 since plan start", "P7 began attacking you"),
never free prose, never "good/bad/successful".

### 6.3 Prompt (`CommanderPromptBuilder.ts`)

Small, fixed skeleton (target: < 4 KB + state JSON, roughly an order of
magnitude smaller than the current ~30-95 KB prompts; compact
`JSON.stringify` like the existing builders — pretty-printing tripled bytes
per LlmPromptBuilder.ts:108-109):

1. Role line: strategic commander of one nation in a territory game.
2. `UNTRUSTED_DISPLAY_RULE` (PromptSanitizer.ts:20), unchanged — rival names
   in the state are data, not instructions.
3. Task rules, verbatim requirements from the spec: choose exactly one offered
   StrategicOption by `id`; you choose strategy, not mechanics; do not invent
   options; deterministic code executes exact legal game actions inside your
   choice; maximize probability of winning.
4. Reply schema (below), "JSON only".
5. `COMMANDER_STATE_JSON:` … `END_COMMANDER_STATE_JSON` (the whole §6.1
   object, options included).

No ranked candidates, no playbooks, no profile guidance, no affordances, no
opponent-model beliefs, no example answer that names a specific option (an
example naming `expand` would be a baseline-preference leak; the schema
example uses the placeholder `"<one offered option id>"`).

### 6.4 Response schema and parser (`CommanderResponseParser.ts`)

```json
{
  "selectedStrategicOptionId": "<one offered option id>",
  "horizonDecisions": 4,
  "intent": "short free-text strategic intent",
  "replanTriggers": ["target_dead", "home_attacked"],
  "confidence": 0.7
}
```

- `selectedStrategicOptionId`: required; must exactly match an id in the
  **locked** option set of the request (§6.5). Off-set id = parse failure.
  **Never coerced, never nearest-matched** — same contract as the existing
  parser's primary id (LlmDecisionParser.ts robust mode never repairs the
  primary; V0 keeps that exact property).
- `horizonDecisions`: integer clamped 2–6 (clamping a number into its
  documented bound is structural repair; absent → default 3, mirroring
  `maxDecisionCycles`' precedent).
- `intent`: required, trimmed, sliced to 160 chars (precedent:
  `MAX_DEAL_STATED_REASON_LENGTH = 160`), sanitized for control characters;
  stamped as `planRationale` (viewer-visible via beat cards — viewer-only,
  never re-enters any observation, same containment as
  `SpectatorEvent.statedReason`).
- `replanTriggers`: optional array over the closed enum
  `{"horizon_expiry","option_not_executable","target_dead","home_attacked","option_appeared"}`;
  unknown entries are a parse failure (not silently dropped — dropping would
  be semantic repair). `horizon_expiry` and `option_not_executable` are always
  active regardless (safety floor, §7.3); the field lets the Commander *add*
  the optional two.
- `confidence`: optional, finite, 0–1, else dropped (existing parser
  precedent: invalid confidence is dropped in robust mode, rejected in
  strict; V0 uses drop — it is metadata, not authority).
- **Syntax-only repair**: strip code fences, `extractFirstJsonObject`-style
  balanced-brace extraction (reimplemented in the commander parser; the
  existing `extractFirstJsonObject` at LlmDecisionParser.ts:601 is
  module-private — do not export it, copy the 20 lines; exporting would
  couple the legacy parser's test surface to the new lane). No key aliasing,
  no field synthesis beyond documented defaults.
- **The invariant the spec names**: repair must never turn one valid option
  into another because a deterministic policy prefers it. Structurally
  guaranteed: the parser has no access to any policy, scorer, or state — its
  inputs are (raw text, locked option-id set) only. Pinned by a test (§13).

### 6.5 Fingerprint

`fingerprint = sha256(canonicalJson({ gameID, agentID, turnNumber,
decisionSequence, exposedOptionIds (sorted), selfMaterial:
{troops, tilesOwned, incomingAttacks}, rivalMaterial: sorted
[{playerID, isAlive, tilesOwned, sharesBorder}] })).slice(0, 16)`.

Computed at request build time by the state builder; stored on the pending
plan request; recomputed at response arrival. There is **no fingerprint
anywhere in the existing plan path** (verified — `planID` is
`${agentID}:${objective}:${turnNumber}`, AgentPlannerExecutor.ts:20971, which
collides for same-objective same-turn replans), so this is new machinery, and
the plan-id scheme must not copy the existing collision:
`commanderPlanID = ${agentID}:${turnNumber}:${decisionSequence}:${fingerprint}`.

---

## 7. Plan lifecycle (`CommanderPlanLifecycle.ts`)

### 7.1 Plan type

```ts
export interface CommanderPlan {
  planID: string;                      // §6.5 scheme
  optionId: StrategicOptionId;         // durable authority
  family: StrategicOptionFamily;
  targetPlayerID: string | null;
  horizonDecisions: number;            // 2..6
  intent: string;                      // bounded, viewer-only
  extraReplanTriggers: CommanderReplanTrigger[];  // from the response
  confidence: number | null;
  selectorSource: "llm" | "deterministic" | "fallback-deterministic" | "random";
  createdTurn: number;
  createdDecisionSequence: number;
  decisionsExecuted: number;
  requestFingerprint: string;
  baseline: { tilesOwned: number; troops: number };   // for progress deltas
}
```

`selectorSource` is the load-bearing attribution field. Existing metadata
semantics are reused so downstream accounting works unchanged
(agent8's finding, adopted): a fallback-authored plan stamps
`plannerFallbackUsed: true` and `degradedCause` from the existing
`AGENT_DEGRADATION_CAUSES` vocabulary (`plan-timeout` for provider timeout,
`plan-parse` for parse failure, `plan-stale` for a stale-rejected response;
the known missing `plan-rejected` member — AgentPlannerExecutor.ts:2020-2027
comment — is NOT added in V0: adding it is a wire-contract change mirrored in
`coworld-adapter/src/coworld-decision-wire.ts`, out of scope; stale rejection
maps onto `plan-stale`, which is semantically honest).

### 7.2 Synchronous vs asynchronous

**Synchronous selection at replan points, with the provider under
`withDeferredDecisionTimeout` (budget: 12 000 ms default, well inside the
harness's `--max-decision-ms` 120 000).** The hosted lane's
`DeferredAgentPlanner` background-refresh pattern is the right shape for a
future hosted Commander but is out of V0 scope; V0 is a local experiment and
synchronous keeps B/C code paths identical. Staleness handling still exists
even in the synchronous design: the request is locked to
(`requestFingerprint`, exposed option-id set), and a response is applied only
if (a) the option id is in the locked set and (b) the fingerprint still equals
the freshly recomputed fingerprint at application time. In the synchronous
path (b) is trivially true — but the check runs anyway so the code path is
identical to any future async variant and so the property is test-pinned, not
assumed.

### 7.3 Replan conditions (the complete, closed list)

Evaluated at the top of each Commander decision, in this order; the first hit
replans, and its name is stamped as `commanderReplanReason`:

1. `no_active_plan` — bootstrap.
2. `horizon_expiry` — `decisionsExecuted >= horizonDecisions`.
3. `option_not_executable` — the plan's option id is no longer in the current
   *eligible* candidate set (rebuilt every decision).
4. `target_dead` — plan is `pressure_rival:<R>` and R is not alive / not
   visible (subsumes disconnect: `isDisconnected || !isAlive`). Only if the
   Commander opted into it — otherwise case 3 catches it one step later when
   the binding empties; the distinction is deliberate so trigger opt-in is
   observable in the data.
5. `home_attacked` — material home-danger change, defined exactly as:
   `incomingAttackPlayerIDs` contains a playerID not present at plan creation.
   Commander opt-in.
6. `option_appeared` — a family that had no eligible option at plan creation
   is now eligible. Commander opt-in.
7. `hold_streak_blocked` — the previous decision recorded
   `hold_plan_blocked` (§8.5): mandatory immediate replan ("hold at most once,
   then replan").

Triggers 1, 2, 3, 7 are always armed (safety floor). Nothing else may cause a
replan: no repeated-action memory, no strategic-priority divergence, no
affordance readiness, no incoming-attack heuristics beyond the exact
definition in 5. Every replan record carries the reason; **silent plan
abandonment is structurally impossible** because the plan object can only be
replaced inside the lifecycle's `replan()` which requires a reason argument —
and a test asserts plan-transition count == replan-reason count (§13).

### 7.4 Request lock and stale responses

A `PlanRequest { fingerprint, exposedOptionIds, createdAt }` is created per
selection. `applyResponse(request, response)` rejects (→ fallback path with
`degradedCause: "plan-stale"`) when the response names an id outside
`request.exposedOptionIds` or when the recomputed live fingerprint differs
from `request.fingerprint`. Rejected-stale responses are never reinterpreted
against newer state.

### 7.5 Fallback

On provider timeout, parse failure, or stale rejection: the
**DeterministicOptionSelector** (Arm B's selector, §10.2) is invoked on the
same locked `CommanderState` + exposed options, and the resulting plan is
marked `selectorSource: "fallback-deterministic"`, `plannerFallbackUsed: true`,
with `degradedCause` as in §7.1. All decisions executed under such a plan
inherit the marking for their whole plan lifetime (the `degradedOrigin`
lesson from StrategicPlan — AgentPlannerExecutor.ts:210-232 — applied from
day one: cadence-amplified decisions were 66.3% of degraded counts there).
These plans are excluded from every LLM-contribution claim (§10.6).

### 7.6 Progress snapshots

Each decision under a plan appends factual deltas to the state's `plan`
snapshot: `{ decisionsExecuted, horizonDecisions, tilesDelta, troopsDelta,
newIncomingAttackers }` — numbers and ids only. No "good/bad/on-track"
labels. The only permitted terminal label is `option_not_executable` /
`horizon_expiry` etc. as replan reasons, which are objective conditions.

---

## 8. StrategicOption executor (`StrategicOptionExecutor.ts`)

### 8.1 Contract

```ts
executeOption(input: AgentBrainInput, plan: CommanderPlan,
              binding: StrategicOptionCandidate["binding"]):
  { actionID: string; actionIDs?: string[];
    fidelity: "aligned_primary" | "aligned_support" | "hold_plan_blocked";
    reason: string }
```

The executor receives the **binding**, not the full menu, as its selection
universe — the option filter is a single chokepoint *before* any scoring, not
a per-module check. This is the direct lesson of the audit: the current
executor's `forbiddenActionKinds` filtering is scattered across ~30 sites
with at least three bypass mechanisms (§3), which is unreviewable. A
chokepoint filter cannot be bypassed because off-binding actions are simply
absent from the candidate set.

### 8.2 Selection inside the filter

Per the spec, low-level deterministic scoring is allowed after filtering. Two
implementation options were considered:

- (a) Call `rankFrontierActions` on the filtered subset with a minimal
  synthetic plan. Rejected for V0: it drags in `StrategicSkillEvaluator`
  (whose affordance-best bonuses and repetition caps encode strategy),
  `enforceConversionOverNeutralRanking` (inert only by accident of
  family-partitioning), profile module weights, and the reason-string coupling
  documented in §3 — an unauditable dependency surface for a first vertical
  slice.
- (b) **Chosen: small per-family deterministic pickers** built on the same
  primitive facts the menu already carries, in the style of
  `thinPlanExecutionCandidate` / `StrategyAgentBrain.pick`:

  - `expand`: prefer land expansion over neutral boat; among
    `expand:terra-nullius:<pct>` variants pick the middle commitment (0.2) when
    own troops ≥ 3× the intent's troop cost, else the smallest (0.1); tie-break
    `id.localeCompare`. (Exact attack intensity is executor-owned; the ladder
    logic mirrors `ladderDesiredTroopRatio`'s escalate-on-repeat shape without
    importing war-mode gates: escalate one rung when the previous decision
    under this plan already executed an expansion on the same board.)
  - `develop_economy`: builds before upgrades; among builds prefer
    `metadata.role === "economic"`, choose placement by the menu's own
    `metadata.economicValue` (executor-only data — allowed post-filter), tie
    `id.localeCompare`.
  - `pressure_rival:<R>`: among non-expansion attacks on R pick the variant
    whose `committedTroopRatio` (metadata `troopPercentage`) is the smallest
    ≥ 0.25 when own troops > target troops, else 0.1 (probe); escalate a rung
    if the previous decision under this plan attacked R (mirrors the
    10/25/40 ladder in `hardNationDesiredAttackCommitment` without its
    leader/war context). Boat invasion only when no land attack on R exists.
    Support batching: at most one of (`embargo:<R>:start`, `target:<R>`)
    appended, and only on the **first** decision of a plan (narrow by
    construction: one support action per plan, not per decision — support
    cannot become a drumbeat that outweighs primaries).
  - `survive`: priority `retreat` (cancel the largest outgoing attack by
    metadata `troops`) → defensive `build`/`upgrade_structure` (placement by
    `metadata.defensiveValue`) → `hold`.

  All pickers sort candidates by `id.localeCompare` before applying rules —
  determinism and menu-order invariance by construction. All of them read only
  the filtered candidates' `metadata`/`intent` plus the plan; none read
  `observation.strategic`, affordances, skills, or any global score.

### 8.3 Forbidden substitutions (per family, explicit)

- Never select any action outside the binding (structural).
- `expand` must not become a rival attack because expansion stalls
  (the `no_legal_action_matches_plan` shape) — it becomes
  `option_not_executable` → replan.
- `pressure_rival:R` must not retarget to a different rival (the current
  executor's `reusablePlanTarget`/`targetForPlan`/`leaderPressureSideConquest*`
  behaviors are exactly what is banned) and must not soften into
  support-only decisions while a primary exists.
- `survive` must not be "repaired" into productive aggression (the
  `profileRepairRerank` hold-penalty pattern): if the executor reuses any
  frontier scoring in a later version, `profileRepairReRankEnabled: false` is
  mandatory in its settings; in V0's picker design the question does not
  arise.
- No batching of actions across families (the current
  `selectFrontierActionBatch` scheduler fills batches from other modules;
  V0 batches are primary + at most one same-family support).

### 8.4 Emergency overrides

**The V0 enumerated emergency set is empty.** `hard_emergency_override`
exists in the fidelity enum and in the record schema, with an invariant test
that its count is zero in V0 runs. Rationale: `survive` is itself an option
and `home_attacked` is a replan trigger, so the legitimate emergency
responses route through the Commander; every candidate "emergency" in current
code (war mode, survival panic probes, critical home collapse recovery,
behind-and-falling) is a heuristic regime, and the spec explicitly says
heuristic preference is not an emergency. Adding a real emergency later
requires: an entry in a closed `CommanderEmergency` enum, an executor branch,
a fidelity stamp, and a test — the enum being closed is what keeps the
category from becoming an escape hatch.

### 8.5 Blocked plans

If the binding's primary set is empty at execution time (menu shifted since
the eligibility check earlier in the same decision — possible because
same-turn league filters can drop actions between build and submit):

- do **not** select any unrelated action;
- select `hold` (always offered — LegalActionBuilder appends it
  unconditionally at :98), stamp `fidelity: "hold_plan_blocked"`;
- the next decision replans via trigger 7 (`hold_streak_blocked`), so a plan
  holds at most once.

### 8.6 Fidelity accounting (`StrategicOptionFidelity.ts`)

A pure classifier sibling to `AgentActionAuditor` (its host pattern: mutating
pass over records before `writeAgentLeagueRunArtifacts`; agent8's analysis
adopted — the auditor itself lacks plan context, so this is a new module, not
an edit to `auditDecisionEffect`). Every executed Commander decision gets
exactly one of the four classes; per-match aggregates (counts per class,
per-plan silent-abandonment check, fidelity rate excluding
`hard_emergency_override`) go into the three-arm report (§10.7). The
interpretability gate — fidelity ≥ 95% excluding hard emergencies — is
computed there, not asserted in unit tests (a unit test asserting ≥95% on
fixtures would be vacuous; §13).

---

## 9. Canonical-path preservation

### 9.1 What the Commander brain emits

`StrategicCommanderBrain.decide(input: AgentBrainInput): Promise<AgentDecision>`
returns `{ actionID, actionIDs?, reason, metadata }` where every id is an
offered `LegalAction.id` taken from the binding, which was itself built from
`input.legalActions` by exact-object reference. No new action schema, no raw
intents, no second validator, no second runner. The decision then flows
through the untouched spine: league `validateParticipantBatch` →
`validateAgentDecision` (exact-id) → `AgentRunner.submitLegalAction` →
`GameServer`. `src/core` is untouched (no imports from the new files into
core, no LLM/network code anywhere near core — the new lane lives entirely in
`src/server/agents/` + `src/scripts/`).

### 9.2 Proof obligations (tests, §13)

- A game-level test (via `tests/util/Setup.ts` `setup()` + real
  `GameServer`, cloning the `AgentRunner.test.ts:71` pattern) drives
  `StrategicCommanderBrain` end-to-end and asserts the submitted
  `StampedIntent` is accepted by core execution.
- A property test asserts every `actionID` the brain ever returns (across a
  fixture corpus) is present in the offered menu of the same decision.
- The brain never constructs a `LegalAction` object; it only holds references
  from `input.legalActions` (structural, but pinned by the above).

### 9.3 Decision-record integration

All Commander stamps ride `decision.metadata` — **no new `AgentDecision`
fields.** This is deliberate: the field-contract meta-test
(tests/coworld/DecisionSlotParity.test.ts:389, "classifies every declared
AgentDecision field (fails when a new slot appears)") fails on any new
`AgentDecision` field until its external-wire forwarding is decided; metadata
keys avoid the collision entirely (and the external wire question does not
arise in V0).

Reused keys (already hoisted by `decisionLogEntry`, AgentDecisionLogWriter.ts:615,
and already consumed by the viewer): `planID`, `planObjective` (= the selected
option id — this is what makes `planChangeWarRoomEvents`,
src/client/BroadcastBeats.ts:542, render plan-change beat cards with zero
viewer work), `planRationale` (= bounded intent), `planFollowed`
(= fidelity ∈ {aligned_primary, aligned_support}), `plannerRan`,
`plannerFallbackUsed`, `plannerLatencyMs`, `plannerRawOutput`,
`plannerParseOk`, `plannerParseFailureReason`, `degradedCause`,
`llmPlannerDegraded`, `fallbackUsed` (league/validator layers keep their
existing meanings untouched).

New keys, which **must** be hoisted into both `DecisionLogEntry` (:173) and
`decisionLogEntry` (:615) or they are silently lost league-wide (two prior
losses are documented in that file): `commanderSelectorSource`,
`commanderFingerprint`, `commanderExposedOptionIds` (comma-joined),
`commanderOmittedOptions` (compact `id:reason` list), `commanderFidelity`,
`commanderReplanReason`, `commanderHorizonDecisions`,
`commanderPlanAgeDecisions`.

---

## 10. Three-arm experiment

### 10.1 Arms, exactly

- **Arm A — current architecture, unchanged.**
  `--brain=planner-claude-cli` (or the champion-equivalent provider):
  `PlannerExecutorAgentBrain` + `LlmAgentPlanner` + `FrontierPolicyExecutor`,
  default tunables, `planEveryDecisionSteps` 3. Not one line of
  `AgentPlannerExecutor.ts` changes in this project — that is what
  "unchanged" means, and it is why §2 rejects integrating inside that file.
- **Arm B — deterministic selector.** `--brain=commander-v0-det`:
  `StrategicCommanderBrain` with `selector: new DeterministicOptionSelector()`.
- **Arm C — LLM selector.** `--brain=commander-v0-llm`:
  `StrategicCommanderBrain` with
  `selector: new LlmOptionSelector({provider})`, same provider family as
  Arm A's planner (Claude CLI locally) so A-vs-C is not confounded by model.
- **Diagnostic arm R (recommended, cheap) — seeded uniform-random selector.**
  `--brain=commander-v0-random`: same brain,
  `RandomOptionSelector(seed = hash(gameID + agentID + decisionSequence))`
  (repo rule: seeded hash, no `Math.random` — `stableFraction`
  AgentPlannerExecutor.ts:9866 is the precedent). Not required by the spec,
  but it is the only way to falsify "the curation + executor are doing all
  the work" (§14.1); it shares every component with B and C.

### 10.2 The selector seam

```ts
export interface StrategicOptionSelector {
  readonly selectorSource: "llm" | "deterministic" | "random";
  select(state: CommanderState, options: ExposedStrategicOption[]):
    Promise<SelectorResult>;   // { optionId, horizonDecisions, intent,
                               //   extraReplanTriggers, confidence,
                               //   raw?: string, parseOk?: boolean, ... }
}
```

The constraint "the deterministic selector may use only Commander-visible
state and exposed options; not hidden low-level scores unavailable to Arm C"
is enforced **by the type signature**: `select` receives `CommanderState` and
`ExposedStrategicOption[]` and nothing else — no `AgentBrainInput`, no menu,
no observation. `DeterministicOptionSelector`'s rule (fixed, dumb by design —
it is a control, not a contender): survive if `incomingAttackCount > 0` and
`strongerBorderRivalCount > 0`; else pressure the exposed border target whose
`targetTroops < ownTroops` (first in exposure order) if any; else
develop_economy if `economicBuildAvailable`; else expand if eligible; else
survive. Horizon 3, no optional triggers, intent = fixed template. Import
hygiene is additionally pinned by a test that the selector module imports
nothing from `AgentPlannerExecutor`, `AgentStrategicSkills`,
`AgentTacticalAffordances`, or `AgentStrategicStateBuilder` (a
read-the-import-list test, same spirit as the repo's cleanliness tests).

### 10.3 Shared-component proof (B ≡ C except selector)

Three mechanisms, all cheap:

1. **Construction**: `createCommanderBrain(mode)` in the smoke script builds
   the identical `StrategicCommanderBrain` options object and swaps only the
   `selector` instance. One code path, reviewed once.
2. **Mock-equivalence test (the strong one)**: run a step-locked match twice —
   Arm B, and Arm C with a `MockLlmProvider`-style scripted provider whose
   reply is computed by *running the deterministic selector on the same
   locked request* and serializing its result as JSON. Assert the two
   decision streams are **identical records** (same actionIDs, same plans,
   same fingerprints; only `selectorSource`/`plannerRawOutput`-class metadata
   may differ). Also assert zero fallbacks occurred in either run (a
   both-arms-fell-back run would pass vacuously). This proves the selector is
   the only degree of freedom.
3. **Config stamp**: both arms stamp the same `commanderFingerprint` inputs
   and the run config records one shared brain version string.

### 10.4 Matched games

Reuse the existing matched-arm scaffold (`ai-agent-learning-ab-gate.ts`
pattern) extended to N arms: identical `--runs`, `--start-index`, map,
seat count, `--run-id` per arm ⇒ identical `FRNT<index>` gameIDs ⇒ identical
core PRNG streams (`GameRunner.ts:56`) until first decision divergence.
Opponents: fixed deterministic seats (`--opponent-brain=starter-bot` — the
held-out opponent class; note the current smoke only accepts `starter-bot`
via `--opponent-brain`, not `--brain`, ai-agent-league-smoke.ts:1240 has no
branch for it). Flags for all arms: `PROXYWAR_TUNE_STRUCTURED_DEALS` and
`PROXYWAR_TUNE_FREETEXT_MESSAGES` unset (OFF), no war-mode/coalition/etc.
arming, so the excluded families genuinely cannot appear. Known residual
nondeterminism to control (from the harness audit): pass `--run-id`
explicitly (default embeds a timestamp+UUID); avoid manifest specs (fresh
`randomUUID` persistentID per load); `decisionLatencyMs` is wall-clock but
metrics-only. `--max-steps` must be raised well above its default of 1
(the documented trap); the `agent:quality:demo` shape (18 × 100) is the
starting point.

### 10.5 Comparisons

- **B vs C (primary, causal)**: same everything, selector differs. Metrics:
  win rate, survival rate, average tile share, turns survived, plus
  Commander-specific: option distribution, replan-reason distribution,
  fidelity rate, fallback rate (must be low or C is measuring provider
  reliability, not intelligence).
- **A vs B**: effect of the abstraction + executor change (both non-LLM-
  selected in the sense that B's selector is deterministic; but note A's
  planner is an LLM — A vs B conflates architecture change *and* removing
  the LLM planner; this is inherent to the requested design and must be
  reported as such, not spun).
- **A vs C**: product-level bottom line. Interpretation caveat that must ship
  inside the report: V0 Commander arms cannot ally or deal (§5.4), Arm A
  can; an A>C result on win rate does not by itself refute the hypothesis —
  the pre-registered A-vs-C claim is directional only after B-vs-C is read.

### 10.6 Attribution discipline

Per agent8's audit of the writer: exclusion of fallback-authored plans keys on
`plannerFallbackUsed` **and** `commanderSelectorSource`, never on
`fallbackUsed` alone (which has a different meaning — league/brain layer
action substitution — and defaults to false when metadata is absent, so
absence is not evidence of LLM authorship). Decisions at or after
`autopilotEngagedAtStep` (artifact `runnerConfig`) are excluded from all
arms' metrics. Every excluded-decision count is itself reported.

### 10.7 Report

New writer `writeCommanderArmReport` (own file) consuming per-arm
`decisions.jsonl` + summaries, emitting
`artifacts/ai-learning-comparisons/<id>/commander-three-arm.{json,md}`:
per-arm metrics above; the fidelity gate (report is stamped
`interpretable: false` when any Commander arm's fidelity, excluding
hard emergencies, is < 95%); fallback and exclusion tallies; option-set
divergence between B and C (fingerprint overlap — should be 100% at
decision 1 and diverge only as game states diverge). Reuse
`AgentLearningComparison`'s verdict shape but do not force three arms into
its two-side type — pairwise sections instead.

---

## 11. Exact file plan

### New files (all under `src/server/agents/` unless noted)

| File | Contents |
| --- | --- |
| `StrategicCommanderTypes.ts` | §4 types, `CommanderState`, `CommanderPlan`, replan/fidelity/omission enums, selector interfaces. Pure types + tiny pure helpers. |
| `StrategicOptionBuilder.ts` | eligibility predicates, candidate build, caps, omission record, input normalization. |
| `CommanderStateBuilder.ts` | field-by-field state construction, rival selection, recentEvents derivation, fingerprint. |
| `CommanderPromptBuilder.ts` | §6.3 prompt. |
| `CommanderResponseParser.ts` | §6.4 parser (syntax-only repair, locked-set validation). |
| `StrategicOptionSelectors.ts` | `StrategicOptionSelector` interface impls: `DeterministicOptionSelector`, `RandomOptionSelector`. |
| `LlmOptionSelector.ts` | provider-backed selector (uses `LlmProvider`, `withDeferredDecisionTimeout`). |
| `CommanderPlanLifecycle.ts` | §7: plan store, replan evaluation, request lock, fallback, progress snapshots. |
| `StrategicOptionExecutor.ts` | §8 pickers + blocked-plan behavior. |
| `StrategicOptionFidelity.ts` | §8.6 classifier + per-match aggregation. |
| `StrategicCommanderBrain.ts` | the `AgentBrain`: wires builder → state → lifecycle → selector → executor → `AgentDecision` with full metadata stamps; spawn-phase delegation. |
| `src/scripts/ai-agent-commander-arm-gate.ts` | N-arm matched runner (benchmark invocations per arm, shared seeds/ids). |
| `src/server/agents/CommanderArmReport.ts` | `writeCommanderArmReport` (§10.7). |
| Tests: `tests/server/StrategicOptionBuilder.test.ts`, `CommanderStateBuilder.test.ts`, `CommanderResponseParser.test.ts`, `CommanderPlanLifecycle.test.ts`, `StrategicOptionExecutor.test.ts`, `StrategicCommanderBrain.test.ts`, `CommanderArmEquivalence.test.ts`, `CommanderArtifactStamps.test.ts` | §13 matrix. |

### Modified files (each small, each reviewed against its trap)

| File | Change | Trap |
| --- | --- | --- |
| `AgentTypes.ts` | add `"strategic-commander"` to `AgentBrainType` (:14); add `"commander-v0-selector"` to `AgentRuntimeMode` (:24). No `AgentDecision` changes. | `LLM_DEGRADABLE_BRAIN_TYPES` (AgentLeagueMatch.ts:1912) membership decides degradation attribution — add `"strategic-commander"` there too so league-level fallbacks on Arm C count as LLM degradation. |
| `AgentDecisionLogWriter.ts` | hoist the 8 new `commander*` keys into `DecisionLogEntry` (:173) and `decisionLogEntry` (:615). | The allowlist is the only path to artifacts; unhoisted keys vanish silently. |
| `src/scripts/ai-agent-league-smoke.ts` | add `commander-v0-det` / `commander-v0-llm` / `commander-v0-random` to `SmokeBrainMode` (:1808), `brainModeFromArgs` (:1240), `createBrainForMode` (:1574), `artifactBrainMode` (:1834). | Four hand-written dispatch chains; there is no registry — all four must change together (also fix nothing else: `starter-bot`'s missing `--brain=` branch is a pre-existing quirk, out of scope). |
| `src/scripts/ai-agent-frontier-benchmark.ts` | accept the three new `--brain` modes in its brain construction (:605-703 region). | keep `FrontierBenchmarkConfig` shape additive. |
| `tests/server/PromptSizeMatrix.test.ts` | register the Commander prompt arm's byte cost; follow the env-hygiene delete pattern (:101). | test unsets every env it sets or the suite fails. |

### High-risk files (touched or depended on)

- `AgentDecisionLogWriter.ts` — allowlist edits are the known silent-loss
  surface; the artifact-stamps test (§13) exists to bite here.
- `ai-agent-league-smoke.ts` — 2 100 lines of hand dispatch; a missed branch
  yields a silently-rule-brained seat labeled as a commander arm (the roster
  would show `brainType: "rule"` via the `buildAttachedAgentRunRoster`
  default — that default is itself the tripwire; assert roster brainType in
  the harness test).
- `AgentTypes.ts` — one-line union edits, but every artifact consumer reads
  these strings.

### Explicitly out of scope (not modified, asserted by review + the inertness tests)

`src/core/**` (all of it); `AgentPlannerExecutor.ts`; `LlmPromptBuilder.ts`;
`LlmDecisionParser.ts`; `LlmAgentBrain.ts`; `LegalActionBuilder.ts`;
`AgentObservationBuilder.ts`; `AgentStrategicStateBuilder.ts`;
`AgentObjectiveManager.ts`; `AgentTacticalAffordances.ts`;
`AgentStrategicSkills.ts`; `AgentDecisionValidator.ts`; `AgentRunner.ts`;
`GameServer.ts`; `AgentLeagueMatch.ts` (brain injection already exists);
`AgentStepLockedLeague.ts`; `AgentWireProtocol.ts` (no new degradation cause
in V0); all of `coworld-adapter/` (V0 is not hosted); the starter mirrors
(`tester-starter-llm/`, tests/coworld/StarterLlmPlanner*); all viewer code
(beat cards work via existing `planObjective` keys); all deal/message/economy/
spatial subsystems (flags stay OFF in the experiment).

---

## 12. Five implementation stages

### Stage 1 — option generation and coverage

- **Files**: `StrategicCommanderTypes.ts`, `StrategicOptionBuilder.ts`;
  `tests/server/StrategicOptionBuilder.test.ts`.
- **Tests**: eligibility per family over hand-built observations/menus
  (reuse the `activeObservation`/`buildLegalActions` fixture style,
  AgentPlannerExecutor.test.ts:16349/16385, and `stubObservation`,
  DealTestHarness.ts:82); expansion-vs-pressure discrimination on
  `metadata.expansion`; pressure cap = 2 with the reach-class coverage rule;
  ordering invariance (shuffle `legalActions` and `visiblePlayers`, assert
  byte-identical candidate set + exposure + omission record — the suite-wide
  gap identified in the test audit, closed here for the new lane); omission
  record completeness (eligible = exposed ∪ omitted, each omitted has a
  reason); banned-content serialization audit; boat-id-collision fixture.
- **Acceptance**: all above green; builder is pure (no imports from scorer/
  affordance/strategic-state modules — import-list test).
- **Non-goals**: no brain, no prompt, no selector, no state builder.

### Stage 2 — Commander state, prompt, parser, fingerprints

- **Files**: `CommanderStateBuilder.ts`, `CommanderPromptBuilder.ts`,
  `CommanderResponseParser.ts`; tests for each.
- **Tests**: state field allowlist (exact key-set equality per level — not
  just regex); rival selection determinism + cap; fingerprint stability
  (same state ⇒ same hash; any material field change ⇒ different hash;
  rival-order shuffle ⇒ same hash); prompt contains no banned sections
  (assert absence of `RANKED_CANDIDATES_JSON`, `OPENFRONT_PLAYBOOK`,
  `FRONTIER_AGENT_SKILL`, affordance/`recommended`/`best` strings, action-id
  substrings) and contains the untrusted-display rule; parser: fence/prose
  extraction, off-set id fails, unknown replan trigger fails, horizon clamp,
  intent bound, confidence drop; **repair-cannot-retarget property**: for a
  corpus of valid responses, mutate only formatting/noise — parsed
  `selectedStrategicOptionId` must equal the original in every case.
- **Acceptance**: prompt byte size measured and registered in
  `PromptSizeMatrix.test.ts`; env hygiene clean.
- **Non-goals**: no lifecycle, no LLM provider wiring.

### Stage 3 — plan lifecycle, freshness, fallback, progress

- **Files**: `CommanderPlanLifecycle.ts`, `StrategicOptionSelectors.ts`;
  `tests/server/CommanderPlanLifecycle.test.ts`.
- **Tests**: each replan trigger fires exactly on its definition and nothing
  else fires (adversarial fixtures for the current brain's heuristic triggers
  — repeated actions, strategic-priority flips, affordance readiness — must
  NOT cause replans); opt-in triggers inert unless opted in; request lock
  rejects off-set ids and stale fingerprints (simulate by mutating state
  between request and apply); fallback plans marked
  (`selectorSource: "fallback-deterministic"`, `plannerFallbackUsed`,
  `degradedCause`) and inherited for the plan lifetime; plan-transition
  count == replan-reason count (zero silent abandonment); progress snapshots
  are numeric deltas with no evaluative labels (assert against a banned-word
  list on the snapshot serialization); deterministic selector purity
  (signature + import test).
- **Acceptance**: lifecycle usable headless (no brain yet) from tests.
- **Non-goals**: no executor, no real LLM calls.

### Stage 4 — executor, fidelity, emergency handling, canonical integration

- **Files**: `StrategicOptionExecutor.ts`, `StrategicOptionFidelity.ts`,
  `StrategicCommanderBrain.ts`, `LlmOptionSelector.ts`; `AgentTypes.ts` +
  `AgentDecisionLogWriter.ts` + `AgentLeagueMatch.ts:1912` membership edits;
  `tests/server/StrategicOptionExecutor.test.ts`,
  `StrategicCommanderBrain.test.ts`, `CommanderArtifactStamps.test.ts`.
- **Tests**: clone the ThinExecutor suite shape (ThinExecutor.test.ts:119-263):
  executor picks only bound actions; pressure stays on the named target when
  a "better" off-target attack is offered (the anti-`targetForPlan` test);
  survive never becomes aggression; empty primary set ⇒ `hold` +
  `hold_plan_blocked` (once) ⇒ mandatory replan next decision;
  ladder escalation deterministic; support-once-per-plan; fidelity classifier
  totals; `hard_emergency_override` count == 0. Brain-level: game-level
  spine test (§9.2, `setup()` + `GameServer` + `validateAgentDecision` +
  `AgentRunner`, per AgentRunner.test.ts:71); spawn-phase delegation;
  timeout ⇒ fallback plan (deterministic selector) with correct stamps;
  metadata keys all present; artifact-stamps test drives
  `writeAgentLeagueRunArtifacts` on records with commander metadata and
  asserts every new key survives into decisions.jsonl lines (bites on the
  allowlist trap). Inertness: run an existing-lane fixture suite with the new
  modules merely present — zero behavior change (trivial, but the
  SpatialDecisionInertness pattern makes it explicit).
- **Acceptance**: full Commander decision loop green end-to-end locally with
  the deterministic selector; `npm exec -- tsc --noEmit`, lint, and the full
  existing suite untouched-green (watch for the worktree/env failure modes
  documented in project memory: build `static/`, check disk, install deps).
- **Non-goals**: no three-arm tooling, no random arm, no report.

### Stage 5 — three-arm harness and reports

- **Files**: smoke + benchmark mode wiring, `RandomOptionSelector`,
  `ai-agent-commander-arm-gate.ts`, `CommanderArmReport.ts`;
  `tests/server/CommanderArmEquivalence.test.ts`.
- **Tests**: the mock-equivalence test (§10.3.2, with its zero-fallback
  guard); arm-gate config parity (all arms share gameIDs/seeds/opponents —
  assert from the emitted run configs); report math on fabricated
  decisions.jsonl corpora (fidelity gate flips at exactly 95%, exclusion
  tallies correct, `plannerFallbackUsed`-keyed exclusion not
  `fallbackUsed`-keyed); roster brainType assertions per arm (tripwire for
  the dispatch-chain trap).
- **Acceptance**: one command runs a small matched A/B/C(/R) set on the
  step-locked league with `--opponent-brain=starter-bot`, emits the
  three-arm report, and the report's interpretability gate works.
- **Non-goals**: hosted/Coworld deployment; rating claims; any tuning of the
  deterministic selector to "win" (it is a control).

---

## 13. Test matrix

Invariant → biting test (→ vacuous-pass risk and its counter):

| Invariant | Test | Vacuous-pass risk → counter |
| --- | --- | --- |
| Exposure ≤ 8, one per executable family | builder test, adversarial 12-rival fixture | fixture too small exposes < cap → assert fixture eligibility count > 8 pre-cap |
| Pressure cap 2, coverage by reach class | builder test with border + boat-only targets | all targets same class → two fixtures, one per partition shape |
| Order invariance (menu + players) | shuffled-input equality test (new; no current test covers this anywhere — the closest, SpatialDecisionInertness.test.ts:163, covers ranking stability only) | shuffle is identity on 1-element lists → fixtures with ≥ 4 rivals, ≥ 10 actions |
| Omission completeness | eligible = exposed ∪ omitted with reasons | trivially true when nothing omitted → fixture forcing `pressure_target_cap` |
| No answer key in LLM-visible data | (a) exact key-set allowlist per type; (b) serialized banned-substring scan (`score`, `recommended`, `best`, `priority`, `rank`, action-id prefixes) | (b) is dodgeable by renaming → (a) is the primary; (b) is defense-in-depth |
| Parser repairs syntax only | mutation-property test (§12 stage 2) | mutation corpus too tame → include fence+prose+trailing-junk+duplicate-key cases |
| Off-set / stale response rejected | lifecycle lock tests | sync path makes stale unreachable → test drives `applyResponse` directly with a stale fingerprint |
| Replans only on the closed list | adversarial non-trigger fixtures (repeat-action, priority-flip, affordance-ready) | forgetting a heuristic → fixture list mirrors §3's [R] inventory item-by-item |
| Zero silent abandonment | plan-transition count == replan-reason count over a long scripted run | short run → ≥ 20 transitions in fixture |
| Executor alignment only | ThinExecutor-style: off-option high-value action offered, never chosen | binding accidentally includes it → assert binding contents first |
| Target fidelity (no retarget) | pressure_rival:R with juicier rival S present | S not attackable in fixture → make S strictly dominant |
| hold_plan_blocked once + replan | two-decision scripted sequence | menu refills between decisions → fixture keeps it empty |
| Emergency count zero (V0) | aggregate assert over harness runs + unit assert in executor | vacuous by construction (set is empty) — that is the point; documented |
| Fidelity ≥ 95% gate | report-level computation test at 94.9/95.1 fixtures | unit-fixture fidelity is always 100% → gate tested in the report, not the executor |
| Every id offered / spine intact | game-level `setup()`+GameServer test (§9.2) | mock-only tests → this one uses the real core |
| B ≡ C except selector | mock-equivalence with zero-fallback guard (§10.3) | both arms fall back → the guard |
| Fallback marking + exclusion keys | lifecycle stamps + report exclusion test keyed on `plannerFallbackUsed` (`fallbackUsed` is the wrong key and defaults false-when-absent) | report test on synthetic rows including absent-metadata rows |
| Artifact survival of new keys | `CommanderArtifactStamps.test.ts` through the real writer | asserting on the record instead of the written line → parse the emitted decisions.jsonl |
| Existing lanes untouched | full existing suite + PromptSizeMatrix env hygiene + no-diff on out-of-scope files in review | — |

Existing tests that will collide and how: none should — the new lane adds
files and additive union members. The three watchpoints: (1)
`DecisionSlotParity.test.ts:389` fails only if an `AgentDecision` field is
added (design avoids this); (2) `PromptSizeMatrix.test.ts:101` fails if any
new test leaks env vars (follow its delete pattern); (3) prompt-content
pinning suites (LlmAgentBrain.test.ts:167, AgentPlannerExecutor.test.ts:92,
FrontierAgentActions.test.ts:411/422, tests/coworld/StarterLlmPlanner*) are
untouched because their builders are untouched.

---

## 14. Falsification conditions

State up front what result patterns would kill which claim. All read from the
three-arm report on matched games, fallback-excluded, autopilot-excluded,
fidelity-gated.

1. **Option curation is doing the strategy (not the LLM).** If Arm R
   (random selector) ≈ Arm B ≈ Arm C on win/survival/tile-share within noise,
   selection among the exposed options carries no signal — the builder's
   eligibility gating plus the executor are the whole policy. The
   architecture might still be *useful*, but the causal claim "the LLM's
   choice matters" is falsified. (Without Arm R, B ≈ C alone cannot
   distinguish "curation did it" from "the deterministic selector is as good
   as the LLM" — which is why R is recommended.)
2. **The executor is reclaiming strategy.** Any of: fidelity < 95% excluding
   (empty) emergencies; `hold_plan_blocked` > ~5% of Commander decisions
   (options are being offered that are not really executable — eligibility
   and binding disagree); support actions outnumbering primaries under
   pressure plans; replan-reason distribution dominated by
   `option_not_executable` (the builder is offering mirages and the executor
   is effectively vetoing by attrition); or any nonzero
   `hard_emergency_override`. Each of these is computed per arm and printed.
3. **Arms B and C are not comparable.** Any of: the mock-equivalence test
   fails; B and C fingerprint streams diverge at decision 1 of any matched
   game (they saw different option sets from identical states); C's fallback
   rate > ~10% (C is then measuring provider reliability — rerun, don't
   reinterpret); differing exclusion tallies that change sign of any delta
   when toggled.
4. **The LLM adds no strategic value.** C − B ≤ 0 within confidence bounds on
   the primary metrics across the matched set, with C's fallback rate low and
   fidelity gate passed. Honesty requirement: local sample sizes are small
   (benchmark runs are 5–10 games by default); the report must print raw
   counts, not just rates, and the project's own measurement culture (the
   "underpowered, re-measure at ~50 rounds" discipline in the league records)
   applies — a small-N C>B is a signal to scale the run, not a conclusion.
5. **The abstraction itself is a regression.** A ≫ B and A ≫ C with B ≈ C:
   the bounded-option abstraction (or the V0 amputations: no alliances, no
   deals, no nukes, no batch scheduling) costs more than LLM selection can
   recover. That outcome would justify V1 scope work on the option families
   before any further selector work — not a bigger prompt.

---

## 15. Conflicts with current main

Requirements that collide with current source, and the smallest interpretation
that preserves the experiment:

1. **"Run the current architecture unchanged" (Arm A) vs any shared-file
   edit.** The design touches no file Arm A executes except three additive
   spots (`AgentBrainType` union member, `LLM_DEGRADABLE_BRAIN_TYPES` set
   member, DecisionLogWriter allowlist keys). All are additive and
   flag-neutral; Arm A's behavior is byte-identical. Interpretation: additive
   plumbing in shared files is compatible with "unchanged"; behavioral edits
   are not, which is why `AgentPlannerExecutor.ts` is out of scope entirely.
2. **"Deterministic code must not silently replace the strategic objective"
   vs the league's own fallback layers.** `decideWithSafetyFallback`
   (AgentLeagueMatch.ts:2090) and the validator hold-fallback are harness
   property, not brain property, and fire for every brain. Removing them
   would change Arm A. Smallest interpretation: they stay; they are loud
   (stamped); the experiment excludes/attributes them (§10.6). The Commander
   brain's own internal fallback obeys the spec directly (marked, same
   exposed options, deterministic selector).
3. **Bounded replan triggers vs the existing brain's heuristic triggers.**
   Unresolvable inside `PlannerExecutorAgentBrain` — resolved by not using it
   (§2). The four `must_follow` regimes (`plannerRecommendedControls`) simply
   do not exist in the Commander lane; note that this means V0 Commander
   seats will sometimes do "known-stupid" things the old lane force-corrects
   (e.g. not expanding at < 10% base tile share). That is the experiment
   working as designed, not a bug — the 2026-06-19 in-code demotion comment
   is the precedent for authority being handed back deliberately.
4. **"At most eight options" vs V0 families.** With four families and the
   2-target cap the ceiling is five; the 8-cap machinery is built and tested
   but unreachable. Smallest interpretation: keep the cap code (coverage rule
   + omission reasons) so V1 families don't rediscover it.
5. **"Commander must not see the raw LegalAction menu" vs "options must prove
   executability".** Resolved by the two-tier candidate/exposed split (§4):
   bindings hold ids, evidence holds facts. The one purist wrinkle: evidence
   counts (e.g. `economicBuildAvailable`) are *derived from* the menu; that
   is unavoidable — executability proof is the point — and is not an
   answer-key leak because no ordering or scoring survives the projection.
6. **Free-text `intent` vs "no unbounded notes".** `intent` is bounded
   (160 chars), viewer-only, and never re-enters any observation or prompt —
   the same containment the deal `statedReason` and spectator
   `statedReason` fields already enforce. It exists because the beat-card
   surface (`planRationale`) is already wired and is the cheapest legible
   win from the whole project.
7. **Spawn.** The spec's option families don't cover the sealed spawn ballot,
   and the server-side allocator already owns spawn authority
   (`AgentSpawnSelectionEvidence` + report-independent defaults). Smallest
   interpretation: spawn is out of Commander scope; all arms share the
   existing deterministic ballot path; documented in §5.5.
8. **`pressure_rival` target capping "invariant to input ordering" vs the
   observation's unsorted `visiblePlayers`.** Resolved in the builder by
   sorting working copies first (§4.1). Do not "fix" the observation builder
   itself — its ordering is consumed by many existing surfaces.
9. **Prompt-change governance.** The 2026-08-07 ruling (recorded in
   LlmPromptBuilder.ts:96-100's comment block and project memory) requires a
   hosted A/B before in-house prompt changes ship. The Commander prompt is a
   new lane behind new brain modes, not a change to any shipped prompt; the
   existing prompts are byte-identical. The ruling's spirit still binds the
   *hosted* future of this work: no hosted Commander seat without its own
   hosted A/B, and no deterministic hosted seat ever (operator rule
   2026-06-10, recorded in keystone-player.ts).
10. **The proposal's background claim about the failed prompt-slimming
    experiment.** Verified: no code remnants remain (the slim variant was
    reverted); the only in-force reductions are compact JSON and the top-12
    shortlist. The V0 prompt does not re-run that experiment — it replaces
    the *decision surface* (options instead of actions), it does not compress
    the action menu. This distinction is worth keeping sharp in any writeup,
    because "we made the prompt small again" is exactly the reading the
    2026-08-07 ruling would reject.
11. **Reader-report erratum recorded for honesty.** One audit sub-report
    placed the `AgentDecision` field-contract meta-test in
    `AgentExternalBrainCleanliness.test.ts:389`; it actually lives at
    `tests/coworld/DecisionSlotParity.test.ts:389-390` (verified). Plan text
    above uses the corrected location.
