---
name: FrontierAgent
description: Practical OpenFront nation-agent strategy for selecting offered LegalAction.id values from observations and LegalAction[] menus.
---

# FrontierAgent

Use this skill when deciding how an autonomous Open Frontier / OpenFront nation
should act. The goal is not to invent a perfect grand strategy; it is to make
legal, explainable, resilient choices from the action menu the runner offers.

OpenFront's official nation behavior is the baseline: spawn promptly, expand
into Terra Nullius, reserve troops before attacks, punish weak or dangerous
neighbors, build economy and defenses, use alliances when they reduce risk, use
embargoes to pressure hostile players, protect sea lanes with ports and
warships, and escalate to SAMs, silos, nukes, and MIRVs only when the game state
justifies the cost.

## Decision Contract

There are two valid operating modes:

- Direct LLM brain mode: return exactly one offered `LegalAction.id`.
- Planner/executor mode: the slow planner chooses objective, enabled modules, and
  tactical settings; the deterministic executor may schedule a short ordered
  batch of compatible offered `LegalAction.id` values.

- Read the current `AgentObservation` first, especially phase, own troops, gold,
  territory, visible players, bordered players, alliances, incoming attacks,
  available builds, support options, embargo options, strategic state, and
  short-term memory.
- Then inspect every offered `LegalAction`.
- Choose offered `LegalAction.id` values exactly as written. Do not compose raw
  OpenFront intents, coordinates, player ids, JSON action payloads, or new ids.
- If the best strategic move is unavailable, pick the closest legal substitute.
- If every non-hold action is illegal, unavailable, suicidal, or obviously
  harmful, choose the offered `hold` action.
- Keep the reason short and tied to observed facts: pressure, reserve, ally,
  border, income, incoming attack, leader denial, or survival.

Valid output shape for an LLM brain:

```json
{
  "selectedLegalActionId": "the-exact-offered-id",
  "reason": "Short factual reason.",
  "confidence": 0.7
}
```

In direct LLM brain mode, never output more than one chosen action. In
planner/executor mode, never invent ids: choose modules and settings, then let
the executor select legal ids from the offered menu.

Valid output shape for the slow planner:

```json
{
  "objective": "expand_territory",
  "turnIntent": "growth",
  "rationale": "Short factual plan.",
  "maxDecisionCycles": 3,
  "preferredActionKinds": ["attack"],
  "enabledModules": ["expansion", "economy", "defense"],
  "targetPlayerId": null,
  "tacticalSettings": {
    "reserveRatio": 0.35,
    "triggerRatio": 0.55,
    "expansionRatio": 0.15,
    "maxConcurrentWars": 1,
    "retreatThreshold": 0.35,
    "maxActionsPerDecision": 4
  }
}
```

The slow planner should decide what kind of turn this is: growth, build,
fortify, pressure, survive, diplomacy, naval, or spawn. It should not select
the action id in planner/executor mode. The executor will translate the plan
into one existing legal action id or a short compatible ordered batch.

When a `PLANNER_DECISION_BRIEF` is present, read it before the long observation.
It is the tactical control surface for the LLM planner: action mix, pressure
readiness, target policy, module policy, and warnings from recent benchmark
artifacts. Use the full observation to verify details, but do not ignore the
brief's target and module policy.

If `plannerGuidance.recommendedControls.strength` is `must_follow`, copy that
objective, turn intent, target policy, preferred action kinds, and modules
unless the full observation directly contradicts it. This is how the benchmark
loop teaches the live planner narrow lessons without letting it generate raw
actions.

The planner brief is computed from the current `LegalAction[]`. Treat it as the
fresh read on whether a tactic is executable this turn. If a longer observation
field appears to disagree with the brief, prefer the brief unless the legal
actions themselves prove the tactic cannot execute.

## Module Scheduler Contract

The planner/executor path mirrors official nation automation by running
compatible behavior modules in one decision pass:

1. `emergency_survival`: retreats, boat retreats, urgent defense.
2. `spawn_opening`: spawn and early city timing.
3. `expansion`: neutral land attacks and neutral transports.
4. `defense`: defensive builds, upgrades, warship protection.
5. `economy`: cities, factories, ports, useful upgrades.
6. `diplomacy`: alliance requests/extensions, support, embargo stops.
7. `combat`: target marks, embargo pressure, break/reject, attacks.
8. `naval`: ports, transports, warships, warship movement.
9. `nuclear_endgame`: SAM coverage, silos, nukes, MIRV pressure.
10. `utility_social`: delete only when useful, quick chat/emoji sparingly, hold.

Choose enabled modules that match the current strategic objective. Let survival
override all other modules. Prefer a small batch of compatible actions over a
single perfect action when the game state offers independent useful moves, such
as expand plus build plus alliance, or embargo plus attack plus warship.
When `build` or `upgrade_structure` is useful, keep both economy and defense
available; official nations do not stop placing defense posts just because their
main objective is pressure.

## Core Priorities

Default priority order:

1. Survive immediate threats.
2. Expand efficiently while there is safe land.
3. Convert territory into income and max troops.
4. Secure borders through diplomacy or pressure.
5. Punish weak, exposed, traitorous, disconnected, or overextended enemies.
6. Protect trade, ports, and transports.
7. Stop a runaway leader.
8. Spend late-game gold on upgrades, SAM coverage, silos, nukes, or MIRVs.

Prefer active legal moves over `hold`, but do not spend troops or gold just
because an action exists. OpenFront rewards timing: a bad attack can destroy
reserves, while a delayed attack can miss the weak-target window.

## Planner Controls For Hard Nations

Use this section when acting as the slow planner against Hard built-in nations.
The job is to keep the deterministic executor pointed at the right phase of the
game, not to micromanage raw intents.

Planner levers:

- `objective`: choose the strategic job, such as expansion, economy, fortify,
  pressure, diplomacy, or survival.
- `turnIntent`: choose the immediate tempo for the next few decisions.
- `targetPlayerId`: set this only when pressure should focus a specific visible
  player. Leave it null for growth, economy, general defense, or when the leader
  is not currently reachable.
- `preferredActionKinds`: name the legal action categories the executor should
  favor if they are safe.
- `enabledModules`: keep economy and defense available during pressure unless
  survival requires a very narrow emergency plan.
- `tacticalSettings`: adjust reserve and attack posture. Raise reserves and
  lower action count under danger; lower reserves only when a target is clearly
  weak and the executor has a decisive ready action.
- `maxDecisionCycles`: keep volatile plans short. Use 1-2 cycles when reacting
  to attacks, stale action loops, or leader pressure; use 3-5 for stable growth
  or economy.

Benchmark lessons so far:

- Early tempo matters. If safe neutral expansion is legal and reserves are not
  thin, keep growth active instead of waiting for a perfect build.
- Human replay corpus baseline: strong public FFA players usually attack
  neutral land before the first minute and often launch a first boat around the
  first minute. During the first 5 minutes, treat a safe neutral transport as
  normal expansion tempo after a couple of land grabs, not as a rare escape
  move.
- Expanded replay corpus baseline: across 21 recent public FFA games, top
  candidates had median first attack around 0.53 minutes, first boat around
  1.07 minutes, and 34 opening attacks. Open fast, but taper troop commitment:
  large first grabs are acceptable, repeated low-reserve expansion should step
  down toward 20% or 10%.
- Human opening correction: neutral territory is the first real priority. If
  safe Terra Nullius expansion remains in the opening and home danger is not
  high, stale pressure, symbolic target marks, social actions, and static builds
  must not interrupt the land grab. Human games often clear nearby neutral land
  extremely quickly; treat leftover neutral land after repeated opening grabs as
  an urgent tempo leak.
- If the objective is economy but no City, Factory, Port, or useful upgrade is
  offered, use `turnIntent: "growth"` and keep expansion/naval modules available
  rather than stalling on a build plan that cannot execute.
- If the decision brief recommends `secure_economy` with `turnIntent: "build"`
  because build actions are legal after sustained low-share expansion, follow
  it. Hard-nation runs need occasional City, Factory, or Port timing instead of
  endless attack loops. Treat Defense Post as a fortify/survival build unless
  the brief says the border is actually dangerous.
- During opening growth against Hard nations, include diplomacy only when a
  specific alliance protects a flank or balances a stronger neighbor. Do not add
  diplomacy to every growth plan, because over-allying future conquest targets
  can make later pressure harder.
- Do not confuse pressure intent with permission to attack. If reserves are
  low, an outgoing attack is already active, home danger is high, or the target
  is stronger, choose build, fortify, diplomacy, embargo, target mark, or hold
  rather than forcing a weak probe.
- Leader containment is only useful when there is a real reachable leader
  action. If the runaway leader cannot be attacked and only symbolic pressure is
  legal, grow faster through reachable side land, economy, or defensive builds.
- If the decision brief says frontier conversion or finish pressure is
  executor-ready, switch to `pressure_rival`, use the named `targetPlayerId`,
  include combat/defense/economy modules, and set `maxDecisionCycles` to 1.
  Do not stay on growth just because neutral expansion still exists.
- Side conquest is good only when it grows the agent faster than waiting on the
  leader. Prefer weak reachable rivals, bots, disconnected players, or targets
  already losing troops.
- After repeated medium attacks, retreats, or attack-safety holds, refresh the
  plan toward survival, frontier defense, and economy before resuming pressure.
- Repeated embargo, target mark, tiny probe, or hold decisions are warning
  signs. Shorten the plan and change turnIntent unless the repetition is
  clearly buying survival.
- If a growth plan has `targetPlayerId: null`, keep it targetless. Set a target
  only when the next few decisions should focus that player with pressure,
  defense, diplomacy, or a planned break in relations.
- Near troop cap, useful safe transports can bank troops above the effective
  population limit, but do not spam boats. Wait for active transports to land
  and stop if home danger rises.
- Treat near-cap transport banking as a normal human tactic, not a gimmick:
  the replay corpus shows transport banking in 62 top-candidate rows. If a safe
  launch raises effective future troop ratio to roughly 1.25x or better and the
  front is blocked, prefer the offered boat action over waiting.
- Human replay corpus baseline: pressure needs trade. Even during pressure
  plans, keep economy and naval modules eligible so ports, trade, cities, and
  factories continue funding late-game attacks.
- In the final duel, direct pressure beats passive neutral cleanup. If the
  executor offers a safe 25% or 40% attack against the last rival, keep pressure
  active long enough to finish.

## Opening Spawn

During spawn, choose a real offered `spawn` action quickly.

Good spawn qualities:

- Open land nearby for early Terra Nullius expansion.
- Enough distance from many players to avoid instant multi-front pressure.
- Coastline is useful if ports, trade ships, warships, or transports are likely
  to matter.
- Interior land is useful when a defensive-builder profile wants safer cities
  and factories.
- Avoid cramped positions with no expansion path unless all spawns are cramped.
- Avoid mountain-heavy starts when an alternative has comparable space, because
  official nations sometimes skip mountain spawn tiles.
- In team games, prefer spawn positions compatible with the team area and near
  allies without blocking their growth.

If several offered spawns look similar, pick the one with the most neutral land
and the least immediate border exposure.

## Expansion

OpenFront nation behavior attacks Terra Nullius immediately after behavior
initialization and keeps prioritizing non-fallout neutral land when available.
Mirror that bias.

Expansion rules:

- Prefer legal neutral expansion while it is adjacent and not obviously
  trapping the nation in a thin border.
- Use modest troop commitments for normal expansion. Do not drain below a
  defensive reserve just to claim marginal land.
- Expand through land borders before using transports for distant land.
- Expand into nuked neutral territory only when it is strategically necessary
  or when the offered action is specifically the best way out of a boxed-in
  position.
- Avoid snaking into long, fragile borders if a build, alliance, or reserve is
  more valuable.
- If repeated expansion appears in memory and a strong build or diplomatic move
  is now legal, diversify.

When in doubt in the first active turns, safe neutral expansion beats early
player war.

## Reserves And Troop Discipline

Official nations use randomized thresholds: they generally wait until troops
are roughly 30-40% of max troops before spending and prefer attacking near
50-60% of max troops unless a force condition applies. Use those as practical
mental thresholds.

Reserve policy:

- Below about one third of max troops: prefer builds, diplomacy, support,
  embargo, or hold over voluntary attacks.
- Around half of max troops: attacks become reasonable if the target is weak,
  neutral, hostile, or strategically necessary.
- Near troop cap: spend troops on safe expansion or a favorable attack rather
  than wasting regeneration.
- Under incoming attack: preserve enough troops to avoid collapse; retaliate
  only if the attacker is the largest threat and the action is legal.
- Never launch multiple risky wars just because multiple attack ids exist.
- In a one-on-one duel after you own roughly half the map, stop treating neutral
  expansion as the main plan when a bordered rival can be pressured. Convert the
  map lead into rival land.

For attack action menus offering troop percentages, prefer:

- 10% for probing, neutral expansion, low-risk pressure, or when reserves are
  thin.
- 25% for standard expansion or a favorable enemy attack.
- 40% only for decisive conquest, retaliation, finishing a very weak enemy, or
  stopping a runaway threat when reserves remain acceptable.

## Combat Timing

Official nation targeting is ordered by difficulty, but the stable strategic
themes are consistent:

- Retaliate against the largest non-friendly incoming attacker.
- Clear neighboring bots, especially bots that own structures.
- Help allies attack when relations are friendly and the target is not friendly.
- Punish traitors if they are not much stronger.
- Attack disconnected or AFK bordered enemies when they are not overwhelmingly
  stronger.
- Finish very weak enemies, especially after nukes or large incoming attacks.
- Prefer victims already taking heavy incoming damage.
- Attack the weakest bordered enemy when no higher-priority target exists.
- Use island or transport attacks only when there is no useful land border or
  the target is clearly reachable and weaker.
- Once there is only one opponent and you have a material tile lead, direct
  pressure beats stale neutral grabs unless the neutral action is clearly faster
  and uncontested.

Target selection:

- Do not attack allies, teammates, or friendly players.
- In FFA, avoid attacking players with more troops unless the game is otherwise
  lost or the action is forced by survival.
- Prefer targets with a broad shared border because conquest proceeds faster.
- Prefer targets with low troops relative to max troops, low current troops,
  active incoming attacks, or exposed structures.
- Prefer a hated/hostile target over a neutral one if risks are similar.
- Avoid strong targets with large reserves, many allies, or defensive terrain
  unless coordinated pressure exists.

Attack timing:

- Attack when the target is weak now, not after it recovers.
- Treat `tacticalAffordances` as executor-readiness signals, not generic
  encouragement to fight. Stay on growth, economy, or defense when a pressure
  affordance is not explicitly ready.
- Switch from growth to pressure for frontier conversion only when
  `frontierConversionTiming.recommended` is true, `executorReady` is true,
  `bestExecutorReadyTargetID` is present, and home danger is not high.
- When that conversion condition is true in `PLANNER_DECISION_BRIEF`, do not
  say that no executor-ready pressure window exists. Use `pressure_rival`,
  `turnIntent: "pressure"`, the named target id, combat/defense/economy
  modules, and a one-cycle plan so the next decision can judge whether to
  escalate, continue, or return to growth.
- After several successful neutral expansions, a low-danger conversion window
  with a large troop edge is no longer just a probe. The planner should still
  avoid raw action ids, but a clear `pressure_rival` plan lets the executor pick
  a stronger legal attack commitment when that is safer than waiting.
- Finish pressure only when `frontierFinishPressure.recommended` is true and a
  decisive executor-ready attack exists. Avoid repeated 10% probes when there is
  no decisive attack to take.
- Retaliate quickly enough to cancel pressure but not with so many troops that
  the reserve collapses.
- If an attack would open multiple new hostile borders, discount it heavily.
- If an alliance request or embargo can secure a flank before combat, consider
  it first.
- Planner pressure is not enough by itself. If the concrete player-attack option
  is low quality because reserves are thin, an old attack is still active, or the
  target is stronger, wait with embargo, target mark, build, or defense instead
  of launching a token attack.
- In a one-on-one finish with about two thirds or more of the map, keep pressure
  on the last opponent. Prefer 25% or 40% attacks that close the game over
  small probes, social actions, or repeated retreats; the max-war rule no
  longer means much when the only war is the final opponent.

## Retreating

Retreats preserve troops at a cost. Land retreats against player targets lose a
retreat malus, while neutral retreats are less punishing. Transport retreats can
also lose troops when returning.

Retreat or cancel pressure when:

- The attack target becomes friendly after the attack starts.
- The attack has stalled and no useful tiles remain.
- A stronger counterattack threatens the homeland.
- The target's reinforcements make the exchange unfavorable.
- A transport destination is destroyed, unsafe, or no longer useful.
- The offered retreat action saves a large committed force from a losing war.

Do not retreat just because an attack is slow. Retreat when preserving troops is
worth more than the remaining conquest.

When only one opponent remains and you already own a decisive tile lead, do not
cancel pressure unless the retreat saves a large committed force or an incoming
attack threatens your core. Dominant positions are converted by sustained
attacks, not by repeatedly starting and canceling wars. If in doubt, continue
with a 25% or 40% attack instead of retreating a small or moderate commitment.

## Diplomacy

Official nations use alliances pragmatically: they accept useful shields,
threat-balancing alliances, friendly relationships, early-game partners, and
similarly strong partners. They reject traitors, bad relations, alliance
collectors on high difficulty, and many team-game offers.

Alliance request rules:

- Ask a bordered or nearby player for alliance if it secures a flank, buys time,
  counters a stronger neighbor, or enables coordinated pressure.
- Prefer alliances with similarly strong players or players stronger enough to
  deter an enemy without becoming the obvious next threat.
- Do not request alliances from hostile, traitorous, or likely runaway players
  unless survival requires it.
- Do not ally the whole map. Too many alliances can leave no valid pressure
  targets and can make leader denial harder.
- In team games, same-team cooperation matters more than ad hoc alliances.
- Treat alliance-extension actions as new decisions: renew only if the partner
  still protects a flank, supports a shared fight, or is not about to win.

When responding to a request, accept if it improves survival or balances the
leader; reject if it protects a future winner, traitor, or bad-relation player.

## Donations And Ally Support

Official nations assist allies when an ally has active targets, relations are
friendly, and the target is valid. Legal donation actions should be used with
the same restraint.

Donate troops when:

- The ally is holding a crucial front against a shared enemy.
- The ally is about to survive because of the donation.
- Your reserves remain healthy after donating.
- The ally's target is not you, not friendly, and not a likely future disaster.

Donate gold when:

- The ally can convert it into survival, ports, defenses, SAMs, or a decisive
  attack.
- Your own next critical build or nuke is not delayed too much.
- The alliance is strategically valuable and not merely sentimental.

Avoid donations when:

- The ally is leading or close to winning.
- You are under direct attack.
- You are below reserve.
- The donation only prolongs a doomed ally with no strategic payoff.

## Embargoes

Official nation behavior applies relation penalties when embargoed and starts
embargoes against hostile players. On higher difficulties in team games, nations
may embargo everyone outside the team.

Use an offered embargo when:

- The target is non-friendly and hostile or becoming hostile.
- You want to pressure a rival but a direct attack is not legal or not wise.
- The target is a trade-dependent coastal economy.
- A team-game enemy should not benefit from your trade network.
- You need to mark strategic hostility before later combat.

Avoid embargoes when:

- The player is an ally, teammate, or useful future ally.
- You depend on mutual trade more than they do.
- The embargo would isolate you economically while not hurting the target.

Hard and Impossible style: keep embargoes longer and be less eager to normalize
relations. Easier style: lift pressure when relations improve.

## Ports, Trade, And Economy

Official structure behavior prioritizes cities first in normal games, then
ports and factories relative to city count. Ports and factories are both income
tools; ports are preferred when coastal trade is viable, factories more when
landlocked or ports are disabled.

Build economy when:

- Troop reserves are too low for a good attack.
- There is no safe expansion but gold can convert into future strength.
- You have enough territory to place protected structures.
- You are not under severe incoming attack.

Ports:

- Build ports on coastal holdings when there is shared water with valid trade
  partners and no mutual embargo problem.
- Space ports apart when options exist; official port valuation prefers
  distance from existing ports.
- Ports unlock trade ships and warship value, so prioritize them on island or
  coastal maps.
- Avoid spending on ports if all likely trade partners are enemies under
  embargo, if the coastline is exposed, or if warships are dominating the sea
  and you cannot defend trade.

Factories and cities:

- Prefer cities for max troops and core growth when safe.
- Prefer factories when inland, trade routes are unsafe, or coastal ports are
  unavailable.
- Do not cluster valuable structures where one nuke can erase the economy.

## Transports

Official nations use transports opportunistically: occasionally to reach
unowned or bot-owned land, sometimes to reach weaker non-friendly players, and
to find nearby island enemies when no land border exists.

Use transport actions when:

- You have shore access and the target is reachable.
- There is no good land attack and a nearby island target is weaker.
- The destination is unowned, bot-owned, or a non-friendly player with fewer
  troops in FFA.
- The target does not already border you; land attacks are cleaner when a border
  exists.
- You are below the boat limit and can spare about 20% of troops without
  sacrificing defense.

Avoid transports when:

- The target is stronger and this is FFA.
- The destination is too close to enemy warships or likely to be intercepted.
- You already have enough active transports.
- The action would bypass a better land expansion.

If a transport retreat action is offered and the landing is no longer valuable,
retreat before losing the whole force.

## Warships

Official nations use warships defensively and economically. They spawn a first
warship from ports when affordable, retaliate when trade or transport ships are
captured, intercept incoming transports before they land, and on Hard or
Impossible counter enemy warship infestations if rich enough.

Build or move warships when:

- You own ports and have no warship yet.
- Incoming transports are targeting your shore and are not too close to stop.
- An enemy captured or destroyed your trade or transport ships.
- A rival is using many warships to dominate the ocean and block trade.
- You are rich enough that naval control will not delay survival builds.

Avoid warship spending when:

- You have no ports or useful water access.
- You are poor and under land attack.
- You already have many warships and moving an existing one is enough.
- The sea is irrelevant to current win conditions.

Warship actions are usually support actions, not a replacement for land
survival.

## Upgrades

Official nations prefer upgrading when structure density gets high and the unit
type is upgradable. They prefer protected structures, especially those under SAM
coverage.

Choose upgrade actions when:

- Territory is cramped and new structures are hard to place safely.
- The structure is protected by a SAM or sits in a valuable interior location.
- Upgrading improves a core income, defense, SAM, port, or silo role.
- Building another structure would create a nuke-vulnerable cluster.

Avoid upgrades when:

- A first copy of an essential structure is still missing.
- The upgrade delays urgent defense or a decisive attack.
- The structure is exposed and likely to be conquered soon.

## SAMs

Official nations scale SAMs with city count, build more SAMs on higher
difficulty, and in high-starting-gold Hard or Impossible games may build a SAM
first so later structures are protected and less clustered under one nuke
target. Human replay mining shows the same broad pattern: winning public FFA
players usually have a silo, SAM coverage, and nuclear launches in games that
reach the late economy phase. The local 77-game corpus had winner median first
silo/SAM/nuke timing of about 9.27/11.22/13.69 minutes, with winners averaging
3.16 silos and 5.43 SAMs.

Build SAMs when:

- Nukes or MIRVs are enabled and missile silos exist or will exist.
- You have valuable cities, ports, factories, or silos to protect.
- You are entering late game or high-gold game states.
- Enemy nuke capability is visible or likely.
- A SAM placement protects multiple important structures.
- You have built a first missile silo and have no SAM protecting the economy.

Avoid SAMs when:

- All nuclear units are disabled.
- Missile silos are disabled and SAM value is low in the current rules.
- You need immediate troops, a defense post, or a basic economy structure first.

SAM coverage should shape later builds: protected structures are better upgrade
targets and safer economic centers.

## Nukes

Official nation nuking is selective. Nations need missile silos and enough gold,
avoid bots and teammates, respect attack logic, and prefer meaningful targets:
incoming attackers, runaway crowns, dense structure clusters, ally targets, or
endgame opponents. Hard and Impossible nations try to avoid trajectories
interceptable by SAMs. Human replay mining reinforces the timing: top players
do not wait for total map dominance before entering nuclear deterrence; they
often build the first silo after the basic economy exists, add SAMs around
valuable infrastructure, then launch atom/hydrogen/MIRV actions once targets are
large enough to matter.

Latest human replay nuclear baseline: 77 mined public FFA replays produced
11,969 silo/SAM/nuke events. Median first action timing across the corpus was
8.76 minutes for Missile Silo, 8.99 for SAM Launcher, 10.54 for Atom Bomb,
14.25 for Hydrogen Bomb, and 20.4 for MIRV. Use these as phase signals, not
hard timers.

Use atom or hydrogen bomb actions when:

- The target is a non-friendly player and not a bot or teammate.
- The target is attacking you with significant force.
- The target is the crown or controls a dangerous share of non-fallout land.
- The target has dense valuable structures.
- The strike can hit structures or important territory without wasting the bomb.
- You can afford the nuke without ruining essential defense.

Target priority:

- Missile Silo: highest priority because it removes counterstrike.
- SAM Launcher: high priority because it opens later strikes through air
  defense.
- City, Factory, Port: high priority when the target is a leader, incoming
  attacker, or dense economy.
- Defense Post: useful only when it breaks a front or sits inside a dense
  cluster.
- Empty land: avoid unless the target is a runaway crown and no better legal
  tile exists.

Prefer hydrogen bombs when affordable and high impact. Use atom bombs for
cheaper retaliation, defense, or when hydrogen is unavailable.

Avoid nukes when:

- The target is friendly, allied, same-team, or a needed buffer.
- The target tile is likely protected by SAM interception and no better route is
  offered.
- The blast mainly creates unusable fallout while not changing the balance.
- The action duplicates a teammate's or recent allied strike on the same spot.
- You need the gold for SAMs, silos, or survival.

Use nuclear threats in chat only when they are credible: you have silo/nuke
capability or are near it, the rival is larger, and the message supports a real
deterrence plan. Bluffing every turn makes the agent look noisy and weak.

On Impossible-style play, if no high-value target exists, wait rather than
throwing a nuke for spectacle.

## MIRV

Official MIRV behavior is late-game leader denial and counter-escalation. It
requires a missile silo, enough gold, MIRV enabled, and no recent pile-on for
the same target.

Use MIRV actions when:

- A non-friendly player launched or is launching a MIRV at you.
- A player or team is nearing the land-share threshold for victory.
- A leader has a large city-count gap and is steamrolling.
- The target is valid, not a bot, not same-team, and not recently MIRVed.
- The game is late enough that stopping the leader matters more than normal
  economy.

Avoid MIRVs when:

- The target is not the leader or immediate existential threat.
- A cheaper nuke, attack, embargo, or alliance would solve the problem.
- The target was just MIRVed and another strike is redundant.
- You lack enough defensive economy after paying.

MIRV is a strategic emergency tool, not routine harassment.

## Defense Posts

Official nations build defense posts outside normal structure pacing when under
meaningful land attack. Easy nations do not do this; Medium sometimes builds
one; Hard and Impossible can build more as incoming troop ratio rises.

Choose defense build actions when:

- Incoming land attacks are at least roughly one third of your current troops.
- The build tile protects an active front.
- You already have at least a basic economy and are not spending your very first
  structure on a defense post.
- The post buys time for reserves, allies, or counterattacks.

Avoid defense posts when:

- There is no active land front.
- A retreat, counterattack, or alliance is clearly better.
- You cannot afford the structure without losing a critical economy timing.

## Endgame

As the map fills, priorities change:

- Neutral expansion becomes less important than target quality.
- Structure upgrades beat unsafe new structure placement.
- SAM coverage and silo positioning matter more.
- Embargoes and warships can deny trade to rivals.
- Alliances should be re-evaluated; a former shield may become the crown.
- Attack weak links, disconnected players, overextended enemies, and players
  already under heavy incoming attacks.
- Use nukes and MIRVs to stop runaway land share, city dominance, or decisive
  attacks.
- Preserve enough troops to survive the post-nuke and post-conquest chaos.

If only two serious players remain, pressure the opponent directly unless doing
so throws away reserves. Hard and Impossible official behavior becomes more
willing to target the last opponent with nuclear force.

## Profile Adjustments

Aggressive:

- Prefer weak bordered targets and retaliation sooner.
- Use 25% or 40% attacks more often when reserves are healthy.
- Still avoid stronger FFA targets unless survival demands it.

Defensive:

- Prefer reserves, defense posts, SAMs, interior cities, and alliances.
- Attack mainly for retaliation, safe expansion, or finishing weak targets.
- Use embargoes to pressure while avoiding overcommitment.

Diplomatic:

- Prefer alliance requests, renewals, and useful donations.
- Support allies only when it improves shared survival or pressure.
- Break or refuse diplomacy with traitors, leaders, and alliance collectors.

Opportunistic:

- Prefer cheap neutral expansion, very weak enemies, victims under attack,
  disconnected players, and valuable exposed structures.
- Avoid fair fights.
- Switch from expansion to economy or pressure when memory shows repetition.

## Anti-Patterns

Avoid these common bad agent behaviors:

- Selecting an action id that is not in the offered `LegalAction[]`.
- Returning raw OpenFront intent JSON instead of a `LegalAction.id`.
- Choosing `hold` while safe expansion, urgent defense, or decisive pressure is
  available.
- Draining below reserve for a marginal attack.
- Attacking allies, teammates, friendly players, or useful buffers.
- Starting a new war while already losing an existing one.
- Donating to the leader or to an ally who cannot convert the support.
- Embargoing valuable friends or trade partners for no strategic gain.
- Building ports with no useful water trade or no way to defend sea lanes.
- Sending transports into stronger FFA players or defended waters.
- Buying warships while losing on land and poor.
- Clustering cities, ports, factories, SAMs, and silos into one nuke target.
- Building SAMs when nukes are disabled and another structure is clearly needed.
- Launching nukes at low-value tiles, bots, teammates, or recently struck
  targets.
- MIRVing out of spite instead of stopping a win condition.
- Renewing alliances automatically without checking whether the ally is now a
  threat.
- Repeating the same action type because memory shows it worked once.
- Retreating every other decision in a winning one-on-one endgame instead of
  committing enough troops to finish the last opponent.

## Fast Selection Checklist

Before answering, run this checklist:

1. Is this spawn phase? Pick the best offered `spawn`.
2. Am I under a serious incoming land attack? Prefer retreat, defense post,
   retaliation, alliance support, or hold reserves.
3. Is safe neutral expansion offered and reserves are acceptable? Expand.
4. Is a bordered enemy very weak, disconnected, traitorous, hostile, or already
   under heavy attack? Attack with the smallest decisive commitment.
5. Is a useful alliance or renewal available? Take it if it secures a flank or
   balances a stronger player.
6. Can I build economy safely? Prefer city, port, or factory according to map
   and trade conditions.
7. Is a useful donation available? Support only strategically valuable allies.
8. Is embargo pressure useful against a non-friendly rival? Use it if direct
   combat is worse.
9. Are ports, transports, or warships the best map-specific play? Use them only
   when water matters.
10. Are upgrades, SAMs, silos, nukes, or MIRVs needed for late-game survival or
    leader denial? Escalate only with a valid target.
11. If no non-hold action passes the above checks, choose the offered `hold`.

The direct LLM final answer is one offered `LegalAction.id`, plus a concise
reason. The planner/executor final answer is an objective, enabled module list,
and tactical settings that let the executor pick a legal ordered batch.
