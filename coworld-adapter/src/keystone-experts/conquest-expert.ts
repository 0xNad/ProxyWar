import { computeKeystoneBidBP } from "./bid";
import type {
  KeystoneActionFacts,
  KeystoneBidComponents,
  KeystoneExpertProposal,
  KeystonePlayerFacts,
  KeystoneWorldModel,
} from "./types";

type ConquestActionKind =
  | "attack"
  | "boat"
  | "nuke"
  | "warship"
  | "move_warship";
type ConventionalKind = "attack" | "boat";
type NavalKind = "warship" | "move_warship";
type ConquestEvidence =
  | "strength"
  | "finish"
  | "leader-pressure"
  | "hostile-contact"
  | "leader-strike";

export type KeystoneConquestProposal = KeystoneExpertProposal & {
  readonly source: "conquest";
};

type ConquestAction = KeystoneActionFacts & {
  readonly kind: ConquestActionKind;
};

interface ConquestTiming {
  readonly hostileContact: boolean;
  readonly turnWindowBP: number;
}

interface TargetContext {
  readonly target: KeystonePlayerFacts;
  readonly relativeTroopRatioBP: number;
  readonly targetTileShareBP: number | null;
}

interface ScoredConquestAction {
  readonly action: ConquestAction;
  readonly proposal: KeystoneConquestProposal;
  readonly bidBP: number;
  readonly targetPlayerID: string | null;
}

const MIN_OWN_READINESS_BP = 3_500;
const MIN_STRENGTH_RATIO_BP = 11_500;
const FINISH_TILE_SHARE_BP = 200;
const MIN_LOW_SHARE_FINISH_RATIO_BP = 8_000;
const MIN_LOW_SHARE_FINISH_OWN_BP = 6_000;
const MAX_LOW_SHARE_FINISH_RISK_BP = 5_000;
const LEADER_TILE_SHARE_BP = 3_500;
const REMOTE_NUKE_LEADER_SHARE_BP = 4_500;
const MIN_LEADER_PRESSURE_RATIO_BP = 8_000;
const MIN_LEADER_PRESSURE_OWN_BP = 6_000;
const MAX_LEADER_PRESSURE_RISK_BP = 5_000;
const MAX_CANONICAL_NUKE_RISK_BP = 7_500;
const MAX_TURN_WINDOW_BP = 1_500;

const kindPreference: Readonly<Record<ConquestActionKind, number>> =
  Object.freeze({
    attack: 0,
    boat: 1,
    warship: 2,
    move_warship: 3,
    nuke: 4,
  });

/**
 * Proposes one evidence-backed conquest action from canonical offered ids.
 * Time can adjust a justified bid, but never creates conquest evidence.
 */
export function proposeKeystoneConquest(
  world: KeystoneWorldModel,
): KeystoneConquestProposal | null {
  const ownReadinessBP = ownReadinessBasisPoints(world);
  if (
    world.phase !== "active" ||
    world.own === null ||
    ownReadinessBP === null ||
    ownReadinessBP < MIN_OWN_READINESS_BP
  ) {
    return null;
  }

  const playerByID = uniquePlayerMap(world.players);
  const incomingAggressorIDs = new Set(world.incomingAggressorIDs);
  const ambiguousIDs = new Set(world.ambiguousOfferedActionIDs);
  const timing = conquestTiming(world);
  const eligible = world.actions.filter((action): action is ConquestAction =>
    isEligibleConquestAction(action, ambiguousIDs),
  );

  const conventional: ScoredConquestAction[] = [];
  for (const action of eligible) {
    if (!isConventionalAction(action)) {
      continue;
    }
    const candidate = scoreConventionalAction(
      world,
      action,
      playerByID,
      incomingAggressorIDs,
      ownReadinessBP,
      timing,
    );
    if (candidate !== null) {
      conventional.push(candidate);
    }
  }

  const scored = [...conventional];
  for (const action of eligible) {
    if (isNavalAction(action)) {
      const candidate = scoreNavalAction(world, action, timing);
      if (candidate !== null) {
        scored.push(candidate);
      }
    } else if (isNukeAction(action)) {
      const candidate = scoreNukeAction(
        world,
        action,
        playerByID,
        incomingAggressorIDs,
        ownReadinessBP,
        timing,
        conventional.length > 0,
      );
      if (candidate !== null) {
        scored.push(candidate);
      }
    }
  }

  scored.sort(compareScoredConquestActions);
  return scored[0]?.proposal ?? null;
}

function scoreConventionalAction(
  world: KeystoneWorldModel,
  action: ConquestAction & { readonly kind: ConventionalKind },
  playerByID: ReadonlyMap<string, KeystonePlayerFacts>,
  incomingAggressorIDs: ReadonlySet<string>,
  ownReadinessBP: number,
  timing: ConquestTiming,
): ScoredConquestAction | null {
  const target = targetContext(world, action, playerByID, incomingAggressorIDs);
  if (target === null) {
    return null;
  }
  const evidence = conventionalEvidence(action, target, ownReadinessBP);
  if (evidence === null) {
    return null;
  }

  const commitmentQualityBP = commitmentQualityBasisPoints(
    action.troopCommitmentBP ?? null,
    evidence,
  );
  const components = conventionalComponents(
    world,
    action,
    target,
    evidence,
    timing,
    commitmentQualityBP,
  );
  return scoredAction(action, target, evidence, timing, components);
}

function conventionalEvidence(
  action: ConquestAction & { readonly kind: ConventionalKind },
  target: TargetContext,
  ownReadinessBP: number,
): Exclude<ConquestEvidence, "hostile-contact" | "leader-strike"> | null {
  if (
    target.target.troops === 0 ||
    isBoundedLowShareFinish(action, target, ownReadinessBP)
  ) {
    return "finish";
  }
  if (target.relativeTroopRatioBP >= MIN_STRENGTH_RATIO_BP) {
    return "strength";
  }
  if (
    target.targetTileShareBP !== null &&
    target.targetTileShareBP >= LEADER_TILE_SHARE_BP &&
    target.relativeTroopRatioBP >= MIN_LEADER_PRESSURE_RATIO_BP &&
    ownReadinessBP >= MIN_LEADER_PRESSURE_OWN_BP &&
    action.actionRiskBP <= MAX_LEADER_PRESSURE_RISK_BP &&
    (target.target.sharesBorder || action.kind === "boat")
  ) {
    return "leader-pressure";
  }
  return null;
}

function conventionalComponents(
  world: KeystoneWorldModel,
  action: ConquestAction & { readonly kind: ConventionalKind },
  target: TargetContext,
  evidence: Exclude<ConquestEvidence, "hostile-contact" | "leader-strike">,
  timing: ConquestTiming,
  commitmentQualityBP: number,
): KeystoneBidComponents {
  const advantageBP = clampRange(
    Math.trunc(((target.relativeTroopRatioBP - 7_500) * 2) / 5),
    0,
    5_000,
  );
  const disadvantageBP = clampRange(
    Math.trunc((10_000 - target.relativeTroopRatioBP) / 2),
    0,
    2_500,
  );
  const tilePayoffBP = clampRange(
    Math.trunc(((target.targetTileShareBP ?? 0) * 3) / 4),
    0,
    2_000,
  );
  const finishUrgencyBP = evidence === "finish" ? 2_000 : 0;
  const leaderUrgencyBP = evidence === "leader-pressure" ? 800 : 0;
  const contactUrgencyBP = timing.hostileContact ? 400 : 0;
  const neutralOpportunityCostBP = world.canExpandIntoNeutral ? 1_200 : 0;
  const commitmentValueBP = Math.trunc(commitmentQualityBP / 4);
  const commitmentConfidenceBP = Math.trunc(commitmentQualityBP / 5);
  const commitmentOpportunityCostBP = Math.trunc(
    (10_000 - commitmentQualityBP) / 4,
  );

  if (action.kind === "attack") {
    return freezeComponents({
      expectedValueBP: clampBP(
        2_600 +
          advantageBP +
          tilePayoffBP +
          (target.target.sharesBorder ? 1_200 : 0) +
          commitmentValueBP,
      ),
      urgencyBP: clampBP(
        1_200 +
          timing.turnWindowBP +
          (target.target.sharesBorder ? 1_800 : 0) +
          contactUrgencyBP +
          finishUrgencyBP +
          leaderUrgencyBP,
      ),
      confidenceBP: clampBP(
        3_200 +
          Math.trunc((advantageBP * 3) / 4) +
          (target.target.sharesBorder ? 1_200 : 0) +
          commitmentConfidenceBP -
          disadvantageBP,
      ),
      riskBP: action.actionRiskBP,
      opportunityCostBP: clampBP(
        2_200 +
          disadvantageBP +
          neutralOpportunityCostBP +
          commitmentOpportunityCostBP,
      ),
    });
  }
  return freezeComponents({
    expectedValueBP: clampBP(
      2_100 +
        advantageBP +
        tilePayoffBP +
        (target.target.sharesBorder ? 100 : 600) +
        commitmentValueBP,
    ),
    urgencyBP: clampBP(
      1_000 +
        timing.turnWindowBP +
        contactUrgencyBP +
        finishUrgencyBP +
        leaderUrgencyBP,
    ),
    confidenceBP: clampBP(
      3_000 +
        Math.trunc((advantageBP * 2) / 3) +
        (target.target.sharesBorder ? 0 : 800) +
        commitmentConfidenceBP -
        disadvantageBP,
    ),
    riskBP: action.actionRiskBP,
    opportunityCostBP: clampBP(
      3_000 +
        disadvantageBP +
        neutralOpportunityCostBP +
        commitmentOpportunityCostBP,
    ),
  });
}

function scoreNavalAction(
  world: KeystoneWorldModel,
  action: ConquestAction & { readonly kind: NavalKind },
  timing: ConquestTiming,
): ScoredConquestAction | null {
  if (!timing.hostileContact || action.targetPlayerID !== null) {
    return null;
  }
  const neutralOpportunityCostBP = world.canExpandIntoNeutral ? 1_000 : 0;
  const components =
    action.kind === "warship"
      ? freezeComponents({
          expectedValueBP: 4_200 + timing.turnWindowBP,
          urgencyBP: 2_800 + Math.trunc(timing.turnWindowBP / 2),
          confidenceBP: 5_800,
          riskBP: action.actionRiskBP,
          opportunityCostBP: 4_500 + neutralOpportunityCostBP,
        })
      : freezeComponents({
          expectedValueBP: 3_800 + timing.turnWindowBP,
          urgencyBP: 3_000 + Math.trunc(timing.turnWindowBP / 2),
          confidenceBP: 5_500,
          riskBP: action.actionRiskBP,
          opportunityCostBP: 3_200 + neutralOpportunityCostBP,
        });
  return scoredAction(action, null, "hostile-contact", timing, components);
}

function scoreNukeAction(
  world: KeystoneWorldModel,
  action: ConquestAction & { readonly kind: "nuke" },
  playerByID: ReadonlyMap<string, KeystonePlayerFacts>,
  incomingAggressorIDs: ReadonlySet<string>,
  ownReadinessBP: number,
  timing: ConquestTiming,
  conventionalAvailable: boolean,
): ScoredConquestAction | null {
  const target = targetContext(world, action, playerByID, incomingAggressorIDs);
  if (
    target === null ||
    conventionalAvailable ||
    world.canExpandIntoNeutral ||
    ownReadinessBP < MIN_LEADER_PRESSURE_OWN_BP ||
    action.actionRiskBP > MAX_CANONICAL_NUKE_RISK_BP ||
    target.target.troops === 0 ||
    target.targetTileShareBP === null ||
    target.targetTileShareBP < LEADER_TILE_SHARE_BP ||
    target.relativeTroopRatioBP < MIN_LEADER_PRESSURE_RATIO_BP ||
    (!target.target.sharesBorder &&
      !timing.hostileContact &&
      target.targetTileShareBP < REMOTE_NUKE_LEADER_SHARE_BP)
  ) {
    return null;
  }

  const tileValueBP = clampRange(target.targetTileShareBP, 0, 3_500);
  const ratioConfidenceBP = clampRange(
    Math.trunc((target.relativeTroopRatioBP - 8_000) / 2),
    0,
    2_000,
  );
  return scoredAction(
    action,
    target,
    "leader-strike",
    timing,
    freezeComponents({
      expectedValueBP: 2_600 + tileValueBP + timing.turnWindowBP,
      urgencyBP:
        1_600 + timing.turnWindowBP + (timing.hostileContact ? 800 : 0),
      confidenceBP: 4_000 + ratioConfidenceBP,
      riskBP: action.actionRiskBP,
      opportunityCostBP: 5_200,
    }),
  );
}

function targetContext(
  world: KeystoneWorldModel,
  action: ConquestAction,
  playerByID: ReadonlyMap<string, KeystonePlayerFacts>,
  incomingAggressorIDs: ReadonlySet<string>,
): TargetContext | null {
  if (action.targetPlayerID === null) {
    return null;
  }
  const target = playerByID.get(action.targetPlayerID) ?? null;
  if (
    target === null ||
    !target.isAlive ||
    target.friendlyOrTeam ||
    target.incomingAttack ||
    incomingAggressorIDs.has(target.playerID)
  ) {
    return null;
  }
  return Object.freeze({
    target,
    relativeTroopRatioBP: targetRelativeTroopRatioBP(world, target),
    targetTileShareBP:
      target.tileShareBP === null ? null : clampBP(target.tileShareBP),
  });
}

function isBoundedLowShareFinish(
  action: ConquestAction & { readonly kind: ConventionalKind },
  target: TargetContext,
  ownReadinessBP: number,
): boolean {
  return (
    target.targetTileShareBP !== null &&
    target.targetTileShareBP <= FINISH_TILE_SHARE_BP &&
    target.relativeTroopRatioBP >= MIN_LOW_SHARE_FINISH_RATIO_BP &&
    ownReadinessBP >= MIN_LOW_SHARE_FINISH_OWN_BP &&
    action.actionRiskBP <= MAX_LOW_SHARE_FINISH_RISK_BP
  );
}

function scoredAction(
  action: ConquestAction,
  target: TargetContext | null,
  evidence: ConquestEvidence,
  timing: ConquestTiming,
  components: KeystoneBidComponents,
): ScoredConquestAction | null {
  const proposal = proposalFor(action, target, evidence, timing, components);
  const bidBP = computeKeystoneBidBP(proposal, action.actionRiskBP);
  if (bidBP <= 0) {
    return null;
  }
  return Object.freeze({
    action,
    proposal,
    bidBP,
    targetPlayerID: target?.target.playerID ?? null,
  });
}

function proposalFor(
  action: ConquestAction,
  target: TargetContext | null,
  evidence: ConquestEvidence,
  timing: ConquestTiming,
  components: KeystoneBidComponents,
): KeystoneConquestProposal {
  const mode = action.kind === "move_warship" ? "move-warship" : action.kind;
  const commitment = action.troopCommitmentBP ?? "unknown";
  const targetRationale =
    target === null
      ? `contact=1 turnWindowBP=${timing.turnWindowBP}`
      : `target=${target.target.playerID} border=${target.target.sharesBorder ? 1 : 0} relativeBP=${target.relativeTroopRatioBP} shareBP=${target.targetTileShareBP ?? "unknown"}`;
  return Object.freeze({
    proposalID: `conquest:${mode}:${action.id}`,
    actionID: action.id,
    source: "conquest",
    rationale: `conquest ${mode}; evidence=${evidence} ${targetRationale} commitmentBP=${commitment} riskBP=${components.riskBP}`,
    ...components,
    commitmentKey:
      target === null
        ? "conquest:naval-control"
        : `conquest:target:${target.target.playerID}`,
    horizonDecisions:
      action.kind === "attack"
        ? 3
        : action.kind === "boat" || action.kind === "warship"
          ? 2
          : 1,
  });
}

function commitmentQualityBasisPoints(
  commitmentBP: number | null,
  evidence: Exclude<ConquestEvidence, "hostile-contact" | "leader-strike">,
): number {
  if (commitmentBP === null) {
    return evidence === "finish" ? 5_000 : 2_500;
  }
  const preferredBP = evidence === "finish" ? 1_000 : 3_500;
  return clampBP(9_000 - 2 * Math.abs(commitmentBP - preferredBP));
}

function targetRelativeTroopRatioBP(
  world: KeystoneWorldModel,
  target: KeystonePlayerFacts,
): number {
  if (target.troops === 0) {
    return 30_000;
  }
  if (target.relativeTroopRatioBP !== null) {
    return clampRange(target.relativeTroopRatioBP, 0, 30_000);
  }
  if (world.own !== null) {
    return clampRange(
      Math.trunc((world.own.troops * 10_000) / target.troops),
      0,
      30_000,
    );
  }
  return 0;
}

function ownReadinessBasisPoints(world: KeystoneWorldModel): number | null {
  if (world.own === null || world.own.troops <= 0) {
    return 0;
  }
  if (world.own.troopRatioBP !== null) {
    return clampBP(world.own.troopRatioBP);
  }
  if (world.own.maxTroops !== null && world.own.maxTroops > 0) {
    return clampBP(
      Math.trunc((world.own.troops * 10_000) / world.own.maxTroops),
    );
  }
  return null;
}

function conquestTiming(world: KeystoneWorldModel): ConquestTiming {
  const hostileContact =
    world.incomingAggressorIDs.length > 0 ||
    world.players.some(
      (player) =>
        player.isAlive && player.sharesBorder && !player.friendlyOrTeam,
    );
  return Object.freeze({
    hostileContact,
    turnWindowBP: clampRange(world.turnNumber - 800, 0, MAX_TURN_WINDOW_BP),
  });
}

function uniquePlayerMap(
  players: readonly KeystonePlayerFacts[],
): ReadonlyMap<string, KeystonePlayerFacts> {
  const byID = new Map<string, KeystonePlayerFacts>();
  const ambiguous = new Set<string>();
  for (const player of players) {
    if (byID.has(player.playerID)) {
      byID.delete(player.playerID);
      ambiguous.add(player.playerID);
    } else if (!ambiguous.has(player.playerID)) {
      byID.set(player.playerID, player);
    }
  }
  return byID;
}

function isEligibleConquestAction(
  action: KeystoneActionFacts,
  ambiguousIDs: ReadonlySet<string>,
): action is ConquestAction {
  return (
    isConquestActionKind(action.kind) &&
    action.actionOwner === "conquest" &&
    !action.forbidden &&
    !action.safetyBlocked &&
    !action.targetsSelf &&
    !action.targetsFriendlyOrTeam &&
    !action.isNeutralExpansion &&
    !action.isSpawn &&
    !action.isHold &&
    !ambiguousIDs.has(action.id)
  );
}

function compareScoredConquestActions(
  a: ScoredConquestAction,
  b: ScoredConquestAction,
): number {
  return (
    b.bidBP - a.bidBP ||
    kindPreference[a.action.kind] - kindPreference[b.action.kind] ||
    compareText(a.targetPlayerID ?? "", b.targetPlayerID ?? "") ||
    compareText(a.action.id, b.action.id)
  );
}

function isConquestActionKind(
  kind: KeystoneActionFacts["kind"],
): kind is ConquestActionKind {
  return (
    kind === "attack" ||
    kind === "boat" ||
    kind === "nuke" ||
    kind === "warship" ||
    kind === "move_warship"
  );
}

function isConventionalAction(
  action: ConquestAction,
): action is ConquestAction & { readonly kind: ConventionalKind } {
  return action.kind === "attack" || action.kind === "boat";
}

function isNavalAction(
  action: ConquestAction,
): action is ConquestAction & { readonly kind: NavalKind } {
  return action.kind === "warship" || action.kind === "move_warship";
}

function isNukeAction(
  action: ConquestAction,
): action is ConquestAction & { readonly kind: "nuke" } {
  return action.kind === "nuke";
}

function freezeComponents(
  components: KeystoneBidComponents,
): KeystoneBidComponents {
  return Object.freeze({
    expectedValueBP: clampBP(components.expectedValueBP),
    urgencyBP: clampBP(components.urgencyBP),
    confidenceBP: clampBP(components.confidenceBP),
    riskBP: clampBP(components.riskBP),
    opportunityCostBP: clampBP(components.opportunityCostBP),
  });
}

function clampBP(value: number): number {
  return clampRange(value, 0, 10_000);
}

function clampRange(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return maximum;
  }
  return Math.round(Math.min(maximum, Math.max(minimum, value)));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
