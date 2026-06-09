import { PlayerType } from "../../core/game/Game";
import {
  AgentBrain,
  AgentBrainInput,
  AgentDecision,
  AgentStrategyProfile,
  LegalAction,
} from "./AgentTypes";
import { spawnScoreForProfile } from "./LegalActionBuilder";

/**
 * Clean strategy policy implementing the known-winning human plan DIRECTLY, bypassing the
 * FrontierPolicyExecutor (which is over-tuned and never allies):
 *   1. Ally every visible nation EXCEPT the weakest (buy safety from the strong).
 *   2. Build economy under that alliance cover (cities/factories/ports -> troops).
 *   3. Pile on the weakest rival when it is already under attack or clearly weaker.
 *   4. Otherwise expand into neutral land; fall back to favorable attacks / hold.
 * Picks exactly one LegalAction.id per decision. Deterministic.
 */
export class StrategyAgentBrain implements AgentBrain {
  readonly brainType = "rule";

  constructor(private readonly profile: AgentStrategyProfile) {}

  decide(input: AgentBrainInput): AgentDecision {
    const action = this.pick(input);
    return { actionID: action.id, reason: `strategy-policy: ${action.label}` };
  }

  private pick(input: AgentBrainInput): LegalAction {
    const { legalActions, observation } = input;
    const find = (pred: (x: LegalAction) => boolean): LegalAction | undefined =>
      legalActions.find(pred);
    const hold = find((x) => x.kind === "hold") ?? legalActions[0];
    const meta = (a: LegalAction, k: string): string | undefined => {
      const v = a.metadata?.[k];
      return v === null || v === undefined ? undefined : String(v);
    };

    // 1. SPAWN: best spawn for the profile.
    if (
      observation.phase === "spawn" ||
      observation.strategic.priority === "spawn"
    ) {
      const spawns = legalActions.filter((x) => x.kind === "spawn");
      if (spawns.length > 0) {
        return spawns.reduce((best, s) =>
          spawnScoreForProfile(this.profile, s) >
          spawnScoreForProfile(this.profile, best)
            ? s
            : best,
        );
      }
    }

    // Targets = everyone alive except bots and our own teammates (team modes). Crucially
    // this INCLUDES our allies: we must be able to break alliances and conquer them to
    // win — excluding friendlies made the agent ally everyone and then hold forever.
    const rivals = observation.visiblePlayers.filter(
      (p) => p.isAlive && p.type !== PlayerType.Bot && !p.isTeammate,
    );
    const weakest =
      rivals.length > 0
        ? rivals.reduce((m, p) => (p.troops < m.troops ? p : m))
        : null;
    const allianceTarget = (a: LegalAction): string | undefined =>
      meta(a, "recipientID") ?? meta(a, "targetID") ?? meta(a, "playerID");
    const ownTiles = observation.ownState?.tilesOwned ?? 0;
    const attackOn = (id: string | undefined): LegalAction | undefined =>
      id === undefined
        ? undefined
        : find(
            (x) =>
              x.kind === "attack" &&
              x.metadata?.expansion !== true &&
              meta(x, "targetID") === id &&
              x.risk.level !== "high",
          );

    // STRENGTH-gated targets via ABSOLUTE troop counts (relativeTroopRatio is unreliable
    // for allies, which made a 5M-troop army never recognize its dominance and hold
    // forever). Beat a rival when we clearly out-troop it, or it's already pinned by
    // another attacker and we're at least even. Eliminate weakest-first. This phases the
    // agent automatically: weak -> nothing beatable -> ally+build; dominant -> conquer.
    const ownTroops = observation.ownState?.troops ?? 0;
    const ownTileShare =
      observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
    // When we clearly lead on TERRITORY we win wars of attrition even at troop parity
    // (more land -> more production), so press attacks harder. Otherwise stay conservative
    // (attacking when only marginally ahead got us eliminated early). This breaks the
    // stalemate-of-giants where everyone hoards a huge army and nobody is 1.3x ahead.
    const dominant = ownTileShare >= 0.35;
    const troopFactor = dominant ? 0.85 : 1.3;
    const beatable = rivals
      .filter((p) => {
        const theirs = p.troops ?? 0;
        return (
          ownTroops > theirs * troopFactor ||
          (p.incomingAttack && ownTroops > theirs)
        );
      })
      .sort((a, b) => a.troops - b.troops);

    // 2. ALLY THE STRONG: alliance_request to a rival that is NOT the weakest and that we
    //    can't simply beat yet (cover from genuine threats; the beatable ones we attack).
    const ally = find(
      (x) =>
        x.kind === "alliance_request" &&
        (weakest === null || allianceTarget(x) !== weakest.playerID) &&
        !beatable.some((p) => p.playerID === allianceTarget(x)),
    );
    if (ally) return ally;
    const extend = find((x) => x.kind === "alliance_extend");
    if (extend) return extend;

    // 3. BUILD ECONOMY first (the dominant strength factor: v1 built ~54 structures and
    //    reached ~50% share; v4 skipped it for fighting and a nation outgrew us at 17%).
    if (ownTiles >= 800) {
      const econ = find(
        (x) =>
          x.kind === "build" &&
          (meta(x, "role") === "economic" ||
            ["City", "Factory", "Port"].includes(meta(x, "unit") ?? "")),
      );
      if (econ) return econ;
    }

    // 4. ATTACK the weakest BEATABLE rival (strength-gated), breaking only THAT rival's
    //    alliance. Keeps cover with rivals we can't beat. Ally early, betray when strong.
    for (const target of beatable) {
      const hit = attackOn(target.playerID);
      if (hit) return hit;
      if (target.isAllied) {
        const brk = find(
          (x) =>
            (x.kind === "break_alliance" || x.kind === "alliance_reject") &&
            allianceTarget(x) === target.playerID,
        );
        if (brk) return brk;
      }
    }

    // 5. EXPAND into neutral land to grow the base.
    const expand =
      find(
        (x) =>
          x.kind === "attack" &&
          x.metadata?.expansion === true &&
          x.risk.level !== "high",
      ) ?? find((x) => x.kind === "boat" && x.metadata?.targetID == null);
    if (expand) return expand;

    // 6. Fallbacks: a clearly favorable (low-risk, we're stronger) attack, build, hold.
    const favorable = find(
      (x) =>
        x.kind === "attack" &&
        x.metadata?.expansion !== true &&
        (Number(x.metadata?.relativeTroopRatio) || 0) >= 1.3 &&
        x.risk.level !== "high",
    );
    if (favorable) return favorable;
    const anyBuild = find(
      (x) => x.kind === "build" && meta(x, "unit") !== "DefensePost",
    );
    if (anyBuild) return anyBuild;
    const anyExpand = find(
      (x) => x.kind === "attack" && x.metadata?.expansion === true,
    );
    if (anyExpand) return anyExpand;
    return hold;
  }
}
