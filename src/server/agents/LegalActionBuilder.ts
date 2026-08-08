import { isValidSpawnSite } from "../../core/execution/Util";
import {
  diplomacyReservedSlots,
  diplomacySlotsEnabled,
  structuredDealsEnabled,
} from "./AgentTunables";
import { UnitType } from "../../core/game/Game";
import { GameMap, TileRef } from "../../core/game/GameMap";
import { DEAL_TEMPLATE_LABELS } from "./AgentDealCompliance";
import {
  AgentDealTermsView,
  AgentObservation,
  LegalAction,
} from "./AgentTypes";

export interface SpawnCandidate {
  tile: TileRef;
  x?: number;
  y?: number;
  /** Distance-from-map-center scores (buildSpawnCandidates) - informational
   * metadata for live post-spawn/downstream consumers (e.g.
   * shouldOfferNationOpeningForceExpansion's neutral-expansion gate,
   * AgentLeagueMatch.recentDecisionsFor's memory summary). NEVER used to
   * rank/choose a spawn tile - fairness slot selection is maximin spacing
   * over `localLandScore` alone (AgentSpawnAssignment.ts); no agent brain
   * ever ranks or picks a spawn candidate by these scores anymore. */
  pressureScore: number;
  safetyScore: number;
  diplomacyScore: number;
  opportunityScore: number;
  /** Land ratio in a disk around the tile - the quality-floor signal
   * AgentSpawnAssignment.selectSpawnSlots filters and seeds on. */
  localLandScore: number;
}

export interface SpawnCandidateBuilderOptions {
  maxCandidates?: number;
  stride?: number;
}

export interface BuildLegalActionsInput {
  observation: AgentObservation;
  maxPostSpawnActions?: number;
}

/**
 * The single canonical constructor for a spawn `LegalAction`: the truthful,
 * internal record of a fairness-assigned slot
 * (`AgentLeagueMatchRunner.runSpawnPhase` / `AgentSpawnAssignment.ts`).
 * There is no agent-facing spawn menu anymore - spawn placement is never a
 * brain choice - so this is the ONLY place a spawn `LegalAction` is built.
 * Metadata carries the FULL candidate score set (not just localLandScore):
 * live, non-agent-choice downstream readers (shouldOfferNationOpeningForce
 * Expansion's neutral-expansion gate, AgentLeagueMatch.recentDecisionsFor's
 * spawn-memory summary) need pressure/safety/diplomacy/opportunity on the
 * ACCEPTED record - nothing here ranks or chooses BETWEEN candidates.
 */
export function buildSpawnLegalAction(candidate: SpawnCandidate): LegalAction {
  return {
    id: `spawn:${candidate.tile}`,
    kind: "spawn",
    label: `Spawn at tile ${candidate.tile}`,
    intent: {
      type: "spawn",
      tile: candidate.tile,
    },
    risk: {
      level: "medium",
      score: 1 - candidate.safetyScore,
    },
    metadata: {
      tile: candidate.tile,
      x: candidate.x ?? null,
      y: candidate.y ?? null,
      pressureScore: candidate.pressureScore,
      safetyScore: candidate.safetyScore,
      diplomacyScore: candidate.diplomacyScore,
      opportunityScore: candidate.opportunityScore,
      localLandScore: candidate.localLandScore,
    },
  };
}

export class LegalActionBuilder {
  build(input: BuildLegalActionsInput): LegalAction[] {
    const actions: LegalAction[] = [];

    if (input.observation.phase === "active") {
      actions.push(...this.postSpawnActions(input));
    }

    actions.push({
      id: "hold",
      kind: "hold",
      label: "Hold this turn",
      intent: null,
      risk: { level: "none", score: 0 },
      metadata: {
        reason: "no game no-op intent exists",
      },
    });

    return actions;
  }

  private postSpawnActions(input: BuildLegalActionsInput): LegalAction[] {
    if (input.observation.ownState?.isAlive === false) {
      return [];
    }

    const ownTroops = input.observation.ownState?.troops ?? 0;
    const capActions = input.maxPostSpawnActions ?? 96;
    // With reserved diplomacy slots ON, assemble with headroom so the
    // late-emitted diplomacy categories actually get built, then apply the
    // reserved-quota truncation at the end (total stays <= capActions).
    // Flag OFF => maxActions === capActions and the truncation is a no-op:
    // byte-identical menus to the pre-flag behavior.
    // structuredDealsEnabled() also forces this on: deal_propose/accept/
    // reject/withdraw are DIPLOMACY_KINDS members, so without it a crowded
    // menu drops every deal action before an agent sees it. Both flags
    // still default off.
    const diplomacySlots = diplomacySlotsEnabled() || structuredDealsEnabled();
    const maxActions = diplomacySlots ? capActions + 32 : capActions;
    const actions: LegalAction[] = [];

    for (const attack of input.observation.combat.outgoingAttacks ?? []) {
      if (actions.length >= maxActions) {
        break;
      }
      if (attack.retreating) {
        continue;
      }
      actions.push({
        id: `retreat:${attack.attackID}`,
        kind: "retreat",
        label: `Retreat from ${attack.targetName}`,
        intent: {
          type: "cancel_attack",
          attackID: attack.attackID,
        },
        risk: { level: "low", score: 0.2 },
        metadata: {
          attackID: attack.attackID,
          targetID: attack.targetID,
          targetName: attack.targetName,
          troops: attack.troops,
          sourceTile: attack.sourceTile,
          borderSize: attack.borderSize,
          legalReason: "owned outgoing attack is active and not retreating",
        },
      });
    }

    for (const other of input.observation.visiblePlayers) {
      if (actions.length >= maxActions) {
        break;
      }
      if (
        other.canAttack &&
        other.isAlive &&
        !other.isAllied &&
        !other.isFriendly &&
        ownTroops >= 10
      ) {
        for (const troopPercentage of hostileAttackTroopPercentages()) {
          if (actions.length >= maxActions) {
            break;
          }
          const troops = Math.max(1, Math.floor(ownTroops * troopPercentage));
          actions.push({
            id: `attack:${other.playerID}:${Math.round(troopPercentage * 100)}`,
            kind: "attack",
            label: `Attack ${other.name} with ${Math.round(troopPercentage * 100)}% troops`,
            intent: {
              type: "attack",
              targetID: other.playerID,
              troops,
            },
            risk: attackRisk({
              ownTroops,
              targetTroops: other.troops,
              troopPercentage,
            }),
            metadata: {
              targetID: other.playerID,
              targetName: other.name,
              targetTroops: other.troops,
              targetTileShare: other.tileShare ?? null,
              ownTroops,
              troops,
              troopPercentage,
              troopPercent: Math.round(troopPercentage * 100),
              relativeTroopRatio: other.relativeTroopRatio ?? null,
              sharesBorder: other.sharesBorder,
              incomingAttack: other.incomingAttack,
              outgoingAttack: other.outgoingAttack,
              relation: other.relation,
              legalReason:
                other.attackLegalReason ??
                "observation marked target canAttack=true",
            },
          });
        }
      }
    }

    if (
      actions.length < maxActions &&
      input.observation.combat.canExpandIntoNeutral &&
      ownTroops >= 10
    ) {
      const neutralTroopPercentages = shouldOfferNationOpeningForceExpansion(
        input.observation,
      )
        ? [0.1, 0.2, 0.35, 0.5]
        : [0.1, 0.2, 0.35];
      for (const troopPercentage of neutralTroopPercentages) {
        if (actions.length >= maxActions) {
          break;
        }
        const troops = Math.max(1, Math.floor(ownTroops * troopPercentage));
        actions.push({
          id: `expand:terra-nullius:${Math.round(troopPercentage * 100)}`,
          kind: "attack",
          label: `Expand into neutral land with ${Math.round(troopPercentage * 100)}% troops`,
          intent: {
            type: "attack",
            targetID: null,
            troops,
          },
          risk: {
            level: "low",
            score: troopPercentage,
            notes: ["neutral expansion has no player defender"],
          },
          metadata: {
            targetID: null,
            targetName: "Terra Nullius",
            ownTroops,
            troops,
            troopPercentage,
            troopPercent: Math.round(troopPercentage * 100),
            expansion: true,
            legalReason:
              input.observation.combat.neutralExpansionLegalReason ??
              "observation marked neutral expansion available",
          },
        });
      }
    }

    for (const boat of input.observation.nonCombat.boatOptions ?? []) {
      if (actions.length >= maxActions) {
        break;
      }
      const target =
        boat.targetID === null
          ? null
          : (input.observation.visiblePlayers.find(
              (player) => player.playerID === boat.targetID,
            ) ?? null);
      for (const troopFraction of boatTroopFractions(
        input.observation,
        boat.targetID,
      )) {
        if (actions.length >= maxActions) {
          break;
        }
        const troops = Math.max(1, Math.floor(ownTroops * troopFraction));
        const troopPercent = Math.round(troopFraction * 100);
        actions.push({
          id: `boat:${boat.targetTile}:${troopPercent}`,
          kind: "boat",
          label: `Send ${troopPercent}% transport to ${boat.targetName}`,
          intent: {
            type: "boat",
            troops,
            dst: boat.targetTile,
          },
          risk: {
            level: troopFraction >= 0.25 ? "medium" : "low",
            score: troopFraction,
          },
          metadata: {
            targetTile: boat.targetTile,
            sourceTile: boat.sourceTile,
            targetID: boat.targetID,
            targetName: boat.targetName,
            targetTroops: target?.troops ?? null,
            targetTileShare: target?.tileShare ?? null,
            relativeTroopRatio: target?.relativeTroopRatio ?? null,
            navalInvasion: boat.targetID !== null,
            expansion: boat.targetID === null,
            troops,
            troopPercentage: troopFraction,
            troopPercent,
            legalReason: boat.legalReason,
          },
        });
      }
    }

    for (const build of input.observation.nonCombat.buildOptions) {
      if (actions.length >= maxActions) {
        break;
      }
      if (
        !canAffordCost(input.observation.ownState?.gold ?? null, build.cost)
      ) {
        continue;
      }
      const kind = actionKindForBuild(build.unit);
      actions.push({
        id: `build:${build.unit}:${build.buildTile}`,
        kind,
        label: `Build ${build.unit} at tile ${build.buildTile}`,
        intent: {
          type: "build_unit",
          unit: build.unit,
          tile: buildIntentTile(build.unit, build.targetTile, build.buildTile),
        },
        risk: {
          level:
            kind === "nuke"
              ? "high"
              : build.role === "defensive"
                ? "low"
                : "medium",
          score:
            kind === "nuke" ? 0.75 : build.role === "defensive" ? 0.15 : 0.35,
        },
        metadata: {
          unit: build.unit,
          role: build.role,
          ...(kind === "nuke"
            ? {
                targetID: build.nukeTargetID ?? null,
                targetName: build.nukeTargetName ?? null,
                targetTiles: build.nukeTargetTiles ?? null,
                targetTileShare: build.nukeTargetTileShare ?? null,
                targetStructureUnit: build.nukeTargetStructureUnit ?? null,
                targetStructureLevel: build.nukeTargetStructureLevel ?? null,
                targetStructurePriority:
                  build.nukeTargetStructurePriority ?? null,
                targetStructureDensity: build.nukeTargetStructureDensity ?? null,
                targetSamCoverage: build.nukeTargetSamCoverage ?? null,
                nuclearTargetPriority: build.nukeTargetPriority ?? null,
              }
            : {}),
          targetTile: build.targetTile,
          buildTile: build.buildTile,
          cost: build.cost,
          legalReason: build.legalReason,
          isBorderBuild: build.isBorderBuild ?? null,
          borderDistance: build.borderDistance ?? null,
          hostileBorderDistance: build.hostileBorderDistance ?? null,
          nearbyEnemyCount: build.nearbyEnemyCount ?? null,
          nearbyAllyCount: build.nearbyAllyCount ?? null,
          nearbyIncomingAttack: build.nearbyIncomingAttack ?? null,
          ownedNeighborCount: build.ownedNeighborCount ?? null,
          frontierValue: build.frontierValue ?? null,
          economicValue: build.economicValue ?? null,
          defensiveValue: build.defensiveValue ?? null,
          buildPlacementReason: build.buildPlacementReason ?? null,
        },
      });
    }

    for (const upgrade of input.observation.nonCombat.upgradeOptions ?? []) {
      if (actions.length >= maxActions) {
        break;
      }
      if (
        !canAffordCost(input.observation.ownState?.gold ?? null, upgrade.cost)
      ) {
        continue;
      }
      actions.push({
        id: `upgrade:${upgrade.unit}:${upgrade.unitID}`,
        kind: "upgrade_structure",
        label: `Upgrade ${upgrade.unit} #${upgrade.unitID}`,
        intent: {
          type: "upgrade_structure",
          unit: upgrade.unit,
          unitId: upgrade.unitID,
        },
        risk: { level: "low", score: 0.2 },
        metadata: {
          unitID: upgrade.unitID,
          unit: upgrade.unit,
          tile: upgrade.tile,
          level: upgrade.level,
          cost: upgrade.cost,
          legalReason: upgrade.legalReason,
        },
      });
    }

    for (const move of input.observation.nonCombat.warshipMoveOptions ?? []) {
      if (actions.length >= maxActions) {
        break;
      }
      actions.push({
        id: `move_warship:${move.unitIDs.join("-")}:${move.targetTile}`,
        kind: "move_warship",
        label: `Move warship patrol to tile ${move.targetTile}`,
        intent: {
          type: "move_warship",
          unitIds: move.unitIDs,
          tile: move.targetTile,
        },
        risk: { level: "low", score: 0.25 },
        metadata: {
          unitCount: move.unitIDs.length,
          targetTile: move.targetTile,
          legalReason: move.legalReason,
        },
      });
    }

    for (const support of input.observation.nonCombat.supportOptions) {
      if (actions.length >= maxActions) {
        break;
      }
      if (support.canDonateTroops && support.suggestedTroops !== null) {
        actions.push({
          id: `donate_troops:${support.recipientID}`,
          kind: "donate_troops",
          label: `Donate troops to ${support.recipientName}`,
          intent: {
            type: "donate_troops",
            recipient: support.recipientID,
            troops: support.suggestedTroops,
          },
          risk: { level: "medium", score: 0.4 },
          metadata: {
            recipientID: support.recipientID,
            recipientName: support.recipientName,
            troops: support.suggestedTroops,
            legalReason: "core canDonateTroops returned true",
          },
        });
      }
      if (
        actions.length < maxActions &&
        support.canDonateGold &&
        support.suggestedGold !== null
      ) {
        actions.push({
          id: `donate_gold:${support.recipientID}`,
          kind: "donate_gold",
          label: `Donate gold to ${support.recipientName}`,
          intent: {
            type: "donate_gold",
            recipient: support.recipientID,
            gold: support.suggestedGold,
          },
          risk: { level: "low", score: 0.25 },
          metadata: {
            recipientID: support.recipientID,
            recipientName: support.recipientName,
            gold: support.suggestedGold,
            legalReason: "core canDonateGold returned true",
          },
        });
      }
    }

    for (const alliance of input.observation.nonCombat.allianceOptions ?? []) {
      if (actions.length >= maxActions) {
        break;
      }
      const kind: LegalAction["kind"] =
        alliance.action === "reject"
          ? "alliance_reject"
          : alliance.action === "extend"
            ? "alliance_extend"
            : "break_alliance";
      actions.push({
        id: `${kind}:${alliance.playerID}`,
        kind,
        label: `${alliance.action} alliance with ${alliance.playerName}`,
        intent:
          alliance.action === "reject"
            ? { type: "allianceReject", requestor: alliance.playerID }
            : alliance.action === "extend"
              ? { type: "allianceExtension", recipient: alliance.playerID }
              : { type: "breakAlliance", recipient: alliance.playerID },
        risk: {
          level: alliance.action === "break" ? "high" : "low",
          score: alliance.action === "break" ? 0.7 : 0.2,
        },
        metadata: {
          targetID: alliance.playerID,
          targetName: alliance.playerName,
          action: alliance.action,
          legalReason: alliance.legalReason,
        },
      });
    }

    for (const embargo of input.observation.nonCombat.embargoOptions) {
      if (actions.length >= maxActions) {
        break;
      }
      actions.push({
        id: `embargo:${embargo.targetID}:${embargo.action}`,
        kind: embargo.action === "stop" ? "embargo_stop" : "embargo",
        label:
          embargo.action === "stop"
            ? `Stop embargo on ${embargo.targetName}`
            : `Embargo ${embargo.targetName}`,
        intent: {
          type: "embargo",
          targetID: embargo.targetID,
          action: embargo.action,
        },
        risk: { level: "medium", score: 0.5 },
        metadata: {
          targetID: embargo.targetID,
          targetName: embargo.targetName,
          action: embargo.action,
          legalReason: embargo.legalReason,
        },
      });
    }

    if (
      actions.length < maxActions &&
      input.observation.nonCombat.canEmbargoAll
    ) {
      actions.push({
        id: "embargo_all:start",
        kind: "embargo_all",
        label: "Embargo all eligible rivals",
        intent: {
          type: "embargo_all",
          action: "start",
        },
        risk: { level: "medium", score: 0.55 },
        metadata: {
          action: "start",
          legalReason: "core canEmbargoAll returned true",
        },
      });
    }

    for (const other of input.observation.visiblePlayers) {
      if (actions.length >= maxActions) {
        break;
      }
      if (other.canRequestAlliance) {
        actions.push({
          id: `alliance:${other.playerID}`,
          kind: "alliance_request",
          label: `Request alliance with ${other.name}`,
          intent: {
            type: "allianceRequest",
            recipient: other.playerID,
          },
          risk: {
            level: "low",
            score: 0.2,
          },
          metadata: {
            recipientID: other.playerID,
            recipientName: other.name,
            relation: other.relation,
          },
        });
      }
    }

    for (const action of dealMetaActions(
      input.observation,
      maxActions - actions.length,
    )) {
      actions.push(action);
    }

    for (const target of input.observation.nonCombat.targetOptions ?? []) {
      if (actions.length >= maxActions) {
        break;
      }
      actions.push({
        id: `target:${target.targetID}`,
        kind: "target_player",
        label: `Mark ${target.targetName} as target`,
        intent: {
          type: "targetPlayer",
          target: target.targetID,
        },
        risk: { level: "medium", score: 0.45 },
        metadata: {
          targetID: target.targetID,
          targetName: target.targetName,
          legalReason: target.legalReason,
        },
      });
    }

    for (const chat of input.observation.nonCombat.quickChatOptions ?? []) {
      if (actions.length >= maxActions) {
        break;
      }
      actions.push({
        id: `quick_chat:${chat.recipientID}:${chat.quickChatKey}`,
        kind: "quick_chat",
        label: `Public chat: ${chat.message ?? chat.quickChatKey}`,
        intent: {
          type: "quick_chat",
          recipient: chat.recipientID,
          quickChatKey: chat.quickChatKey as never,
          ...(chat.targetID ? { target: chat.targetID } : {}),
        },
        risk: { level: "none", score: 0 },
        metadata: {
          recipientID: chat.recipientID,
          recipientName: chat.recipientName,
          targetID: chat.targetID ?? null,
          targetName: chat.targetName ?? null,
          quickChatKey: chat.quickChatKey,
          message: chat.message ?? null,
          nuclearThreat: chat.nuclearThreat ?? null,
          publicChat: true,
          legalReason: chat.legalReason,
        },
      });
    }

    for (const emoji of input.observation.nonCombat.emojiOptions ?? []) {
      if (actions.length >= maxActions) {
        break;
      }
      actions.push({
        id: `emoji:${emoji.recipientID}:${emoji.emoji}`,
        kind: "emoji",
        label: `Send emoji to ${emoji.recipientName}`,
        intent: {
          type: "emoji",
          recipient: emoji.recipientID,
          emoji: emoji.emoji,
        },
        risk: { level: "none", score: 0 },
        metadata: {
          recipientID: emoji.recipientID,
          recipientName: emoji.recipientName,
          emoji: emoji.emoji,
          emojiText: emoji.emojiText ?? null,
          emojiContext: emoji.emojiContext ?? null,
          legalReason: emoji.legalReason,
        },
      });
    }

    for (const unit of input.observation.nonCombat.deleteUnitOptions ?? []) {
      if (actions.length >= maxActions) {
        break;
      }
      actions.push({
        id: `delete_unit:${unit.unitID}`,
        kind: "delete_unit",
        label: `Delete ${unit.unit} #${unit.unitID}`,
        intent: {
          type: "delete_unit",
          unitId: unit.unitID,
        },
        risk: { level: "high", score: 0.85 },
        metadata: {
          unitID: unit.unitID,
          unit: unit.unit,
          tile: unit.tile,
          level: unit.level,
          legalReason: unit.legalReason,
        },
      });
    }

    if (diplomacySlots && actions.length > capActions) {
      return reservedQuotaTruncate(actions, capActions, diplomacyReservedSlots());
    }
    return actions.slice(0, capActions);
  }
}

function shouldOfferNationOpeningForceExpansion(
  observation: AgentObservation,
): boolean {
  if (
    observation.memory.recentExpansionCount !== 0 ||
    (observation.ownState?.tilesOwned ?? 0) >= 1_000
  ) {
    return false;
  }
  const spawn = observation.memory.recentActions
    .slice()
    .reverse()
    .find((decision) => decision.actionKind === "spawn");
  return (
    (spawn?.spawnPressureScore ?? 0) >= 0.8 &&
    (spawn?.spawnLocalLandScore ?? 1) <= 0.85
  );
}

function attackRisk(input: {
  ownTroops: number;
  targetTroops: number;
  troopPercentage: number;
}) {
  const relativeStrength =
    input.targetTroops > 0
      ? input.ownTroops / input.targetTroops
      : Number.POSITIVE_INFINITY;

  if (relativeStrength >= 2 && input.troopPercentage <= 0.25) {
    return {
      level: "low" as const,
      score: Math.min(1, input.troopPercentage / Math.max(relativeStrength, 1)),
      notes: ["attacker has at least double target troops"],
    };
  }

  if (relativeStrength >= 1) {
    return {
      level: "medium" as const,
      score: input.troopPercentage,
      notes: ["attacker has equal or greater troop estimate"],
    };
  }

  return {
    level: "high" as const,
    score: Math.min(1, input.troopPercentage / Math.max(relativeStrength, 0.1)),
    notes: ["target has greater troop estimate"],
  };
}

function actionKindForBuild(unit: UnitType): LegalAction["kind"] {
  if (unit === UnitType.Warship) {
    return "warship";
  }
  if (
    unit === UnitType.AtomBomb ||
    unit === UnitType.HydrogenBomb ||
    unit === UnitType.MIRV
  ) {
    return "nuke";
  }
  return "build";
}

function buildIntentTile(
  unit: UnitType,
  targetTile: TileRef,
  buildTile: TileRef,
): TileRef {
  switch (unit) {
    case UnitType.DefensePost:
    case UnitType.City:
    case UnitType.Factory:
    case UnitType.SAMLauncher:
    case UnitType.MissileSilo:
      return buildTile;
    default:
      return targetTile;
  }
}

/**
 * Index-form spatial scouts: one best (by `compareIndexQuality`) candidate
 * per grid cell, so remote map regions keep representation after
 * `buildSpawnCandidates`'s land-quality top-up fill. Operates on the
 * columnar candidate arrays by index; the returned indices are sorted by
 * the shared quality comparator.
 */
function spatialSpawnScoutIndices(
  candidateCount: number,
  xOf: (i: number) => number,
  yOf: (i: number) => number,
  compareIndexQuality: (a: number, b: number) => number,
  columns: number,
  rows: number,
): number[] {
  if (candidateCount === 0 || columns <= 0 || rows <= 0) {
    return [];
  }
  // Single-loop min/max, never Math.min(...xs): spreading a large coordinate
  // array overflows the engine argument limit on big spawn pools.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < candidateCount; i++) {
    const x = xOf(i);
    const y = yOf(i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const boundsWidth = Math.max(1, maxX - minX + 1);
  const boundsHeight = Math.max(1, maxY - minY + 1);

  const bestByCell = new Map<number, number>();
  for (let i = 0; i < candidateCount; i++) {
    const cellX = Math.max(
      0,
      Math.min(
        columns - 1,
        Math.floor(((xOf(i) - minX) / boundsWidth) * columns),
      ),
    );
    const cellY = Math.max(
      0,
      Math.min(rows - 1, Math.floor(((yOf(i) - minY) / boundsHeight) * rows)),
    );
    const cell = cellY * columns + cellX;
    const current = bestByCell.get(cell);
    if (current === undefined || compareIndexQuality(i, current) < 0) {
      bestByCell.set(cell, i);
    }
  }

  return [...bestByCell.values()].sort(compareIndexQuality);
}

function spawnQualityFromScores(
  opportunityScore: number,
  pressureScore: number,
  safetyScore: number,
  diplomacyScore: number,
  localLandScore: number,
): number {
  const middleSafetyBand = Math.max(0, 1 - Math.abs(safetyScore - 0.32) / 0.24);
  const lowSafetyPenalty =
    safetyScore < 0.18
      ? (0.18 - safetyScore) * 2.4 + 0.16
      : safetyScore < 0.23
        ? (0.23 - safetyScore) * 1.1
        : 0;
  return (
    opportunityScore * 0.32 +
    pressureScore * 0.18 +
    middleSafetyBand * 0.03 +
    localLandScore * 0.5 +
    safetyScore * 0.25 +
    diplomacyScore * 0.28 -
    lowSafetyPenalty
  );
}

function hostileAttackTroopPercentages(): number[] {
  return [0.1, 0.25, 0.4];
}

/**
 * The authoritative valid-land spawn candidate pool `AgentSpawnAssignment`'s
 * maximin selection draws from: every tile passing the SAME core predicates
 * SpawnExecution/AgentSpawnAssignment re-check (`isLand`, `!isBorder`,
 * `isValidSpawnSite`). Computes the full score set (pressure/safety/
 * diplomacy/opportunity/localLandScore) per candidate - these are
 * INFORMATIONAL metadata for live, non-agent-choice downstream consumers
 * (shouldOfferNationOpeningForceExpansion, AgentLeagueMatch.
 * recentDecisionsFor) carried through unchanged onto whichever candidate
 * AgentSpawnAssignment's maximin selection later picks - NOTHING in this
 * function, and no agent brain anywhere, ranks or chooses a spawn tile by
 * them; maximin selects by `localLandScore` (quality floor) and geometric
 * spacing alone (AgentSpawnAssignment.ts). The composite `spawnQualityFromScores`
 * ranking below governs only which tiles make it INTO the returned pool
 * (spatial coverage first, then quality top-up) when the full scan exceeds
 * `maxCandidates` - a pool-curation/performance concern, not agent choice.
 */
export function buildSpawnCandidates(
  gameMap: GameMap,
  options: SpawnCandidateBuilderOptions = {},
): SpawnCandidate[] {
  const maxCandidates = options.maxCandidates ?? 2_000;
  const stride = options.stride ?? 1;
  const centerX = (gameMap.width() - 1) / 2;
  const centerY = (gameMap.height() - 1) / 2;
  const maxCenterDistance = Math.max(
    1,
    Math.hypot(centerX, centerY),
    Math.hypot(gameMap.width() - 1 - centerX, gameMap.height() - 1 - centerY),
  );
  const maxEdgeDistance = Math.max(
    1,
    Math.min(gameMap.width(), gameMap.height()) / 2,
  );
  // Columnar accumulation: the full-map scan can pass hundreds of thousands
  // of tiles on large maps, and building a SpawnCandidate object (plus the
  // BFS set behind getSpawnTiles) for every one of them just to keep the top
  // ~1-2k was the dominant episode start-up allocation (~160 MB of committed
  // heap on World 12P). Scores land in parallel number arrays; SpawnCandidate
  // objects materialize only for the selected pool.
  const tiles: number[] = [];
  const pressureScores: number[] = [];
  const safetyScores: number[] = [];
  const diplomacyScores: number[] = [];
  const opportunityScores: number[] = [];
  const localLandScores: number[] = [];
  const localLandRadius = Math.max(
    16,
    Math.round(Math.min(gameMap.width(), gameMap.height()) * 0.096),
  );

  gameMap.forEachTile((tile) => {
    if (tile % stride !== 0) {
      return;
    }
    if (!gameMap.isLand(tile) || gameMap.isBorder(tile)) {
      return;
    }
    if (!isValidSpawnSite(gameMap, tile)) {
      return;
    }

    const x = gameMap.x(tile);
    const y = gameMap.y(tile);
    const centerDistance = Math.hypot(x - centerX, y - centerY);
    const edgeDistance = Math.min(
      x,
      y,
      gameMap.width() - 1 - x,
      gameMap.height() - 1 - y,
    );
    const pressureScore = 1 - centerDistance / maxCenterDistance;
    const safetyScore = centerDistance / maxCenterDistance;
    const diplomacyScore =
      1 -
      Math.abs(y - centerY) /
        Math.max(centerY, gameMap.height() - 1 - centerY, 1);
    const localLandScore = localLandRatio(gameMap, tile, localLandRadius);
    const opportunityScore =
      edgeDistance / maxEdgeDistance + deterministicFraction(tile);

    tiles.push(tile);
    pressureScores.push(pressureScore);
    safetyScores.push(safetyScore);
    diplomacyScores.push(diplomacyScore);
    opportunityScores.push(opportunityScore);
    localLandScores.push(localLandScore);
  });

  if (maxCandidates <= 0) {
    return [];
  }

  const count = tiles.length;
  const quality = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    quality[i] = spawnQualityFromScores(
      opportunityScores[i],
      pressureScores[i],
      safetyScores[i],
      diplomacyScores[i],
      localLandScores[i],
    );
  }
  const compareIndexQuality = (a: number, b: number): number =>
    quality[b] - quality[a] ||
    opportunityScores[b] - opportunityScores[a] ||
    localLandScores[b] - localLandScores[a] ||
    tiles[a] - tiles[b];
  const materialize = (i: number): SpawnCandidate => ({
    tile: tiles[i],
    x: gameMap.x(tiles[i]),
    y: gameMap.y(tiles[i]),
    pressureScore: pressureScores[i],
    safetyScore: safetyScores[i],
    diplomacyScore: diplomacyScores[i],
    opportunityScore: opportunityScores[i],
    localLandScore: localLandScores[i],
  });

  const qualitySorted: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    qualitySorted[i] = i;
  }
  qualitySorted.sort(compareIndexQuality);

  if (count <= maxCandidates) {
    return qualitySorted.map(materialize);
  }

  const selected: number[] = [];
  const selectedTiles = new Set<TileRef>();
  const addCandidate = (i: number): void => {
    if (selected.length >= maxCandidates || selectedTiles.has(tiles[i])) {
      return;
    }
    selected.push(i);
    selectedTiles.add(tiles[i]);
  };
  const coreTarget = Math.min(
    maxCandidates,
    Math.max(200, Math.floor(maxCandidates * 0.72)),
  );

  for (const i of qualitySorted) {
    if (selected.length >= coreTarget) {
      break;
    }
    addCandidate(i);
  }
  const scoutIndices = spatialSpawnScoutIndices(
    count,
    (i) => gameMap.x(tiles[i]),
    (i) => gameMap.y(tiles[i]),
    compareIndexQuality,
    24,
    16,
  );
  for (const i of scoutIndices) {
    addCandidate(i);
  }
  for (const i of qualitySorted) {
    addCandidate(i);
  }

  return selected.map(materialize);
}

function localLandRatio(
  gameMap: GameMap,
  tile: TileRef,
  radius: number,
): number {
  const centerX = gameMap.x(tile);
  const centerY = gameMap.y(tile);
  const radiusSquared = radius * radius;
  let land = 0;
  let total = 0;
  for (
    let y = Math.max(0, centerY - radius);
    y <= Math.min(gameMap.height() - 1, centerY + radius);
    y += 1
  ) {
    for (
      let x = Math.max(0, centerX - radius);
      x <= Math.min(gameMap.width() - 1, centerX + radius);
      x += 1
    ) {
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy > radiusSquared) {
        continue;
      }
      total += 1;
      if (gameMap.isLand(gameMap.ref(x, y))) {
        land += 1;
      }
    }
  }
  return total === 0 ? 0 : land / total;
}

function boatTroopFractions(
  observation: AgentObservation,
  targetID: string | null,
): number[] {
  if (targetID === null) {
    const troopRatio =
      observation.combat.troopRatio ?? observation.ownState?.troopRatio ?? 0;
    if (troopRatio >= 0.35) {
      return [0.08, 0.16, 0.25];
    }
    return [0.08, 0.16];
  }
  const ownTileShare =
    observation.ownState?.tileShare ?? observation.endgame?.ownTileShare ?? 0;
  const visibleTarget = observation.visiblePlayers.find(
    (player) => player.playerID === targetID,
  );
  const targetLooksFavorable =
    (visibleTarget?.relativeTroopRatio ?? 0) >= 1.2 ||
    (visibleTarget?.tileShare ?? 1) <= ownTileShare * 0.75;
  if (ownTileShare >= 0.55 || targetLooksFavorable) {
    return [0.08, 0.16, 0.25];
  }
  return [0.08, 0.16];
}

function canAffordCost(gold: string | null, cost: string): boolean {
  const goldValue = parseIntegerString(gold);
  const costValue = parseIntegerString(cost);
  if (goldValue === null || costValue === null) {
    return true;
  }
  return goldValue >= costValue;
}

function parseIntegerString(value: string | null): bigint | null {
  if (value === null || !/^\d+$/.test(value)) {
    return null;
  }
  return BigInt(value);
}

function deterministicFraction(value: number): number {
  const x = Math.sin(value * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Diplomacy kinds protected by the reserved-slot truncation. */
const DIPLOMACY_KINDS = new Set([
  "alliance_request",
  "alliance_reject",
  "alliance_extend",
  "break_alliance",
  "target_player",
  "embargo_all",
  "donate_gold",
  "donate_troops",
  // Structured-deal meta-actions (PROXYWAR_TUNE_STRUCTURED_DEALS): reserved
  // alongside the other diplomacy kinds so crowded menus cannot silently
  // drop every deal response.
  "deal_propose",
  "deal_accept",
  "deal_reject",
  "deal_withdraw",
]);

/**
 * Structured-deal meta-actions (PROXYWAR_TUNE_STRUCTURED_DEALS, default OFF).
 * Emitted only when the flag is on AND the league runner injected the
 * bilateral `deals` block — every offer listed there already passed the
 * AgentDealManager's capacity and template-precondition gates. All
 * `intent: null` (the `hold` precedent) with fully deterministic IDs:
 * `deal_propose:<recipientSeat>:<template>`, `deal_accept:<dealID>`,
 * `deal_reject:<dealID>`, `deal_withdraw:<dealID>`. Flag OFF (or no deals
 * block) emits nothing, keeping menus byte-identical to shipped behavior.
 */
function dealMetaActions(
  observation: AgentObservation,
  budget: number,
): LegalAction[] {
  if (!structuredDealsEnabled() || observation.deals === undefined) {
    return [];
  }
  const deals = observation.deals;
  const actions: LegalAction[] = [];
  const push = (action: LegalAction): boolean => {
    if (actions.length >= budget) {
      return false;
    }
    actions.push(action);
    return true;
  };
  const termsMetadata = (terms: AgentDealTermsView) => ({
    template: terms.template,
    durationSteps: terms.durationSteps,
    ...(terms.targetPlayerID !== undefined
      ? {
          targetID: terms.targetPlayerID,
          targetName: terms.targetName ?? terms.targetPlayerID,
        }
      : {}),
    ...(terms.goldAmount !== undefined
      ? {
          goldAmount: terms.goldAmount,
          troopAmount: terms.troopAmount ?? 0,
        }
      : {}),
  });

  for (const proposal of deals.incomingProposals) {
    // Emit the accept/reject pair atomically: under budget pressure a menu
    // that can accept but not reject (or vice versa) would bias the answer,
    // so a proposal gets both entries or neither.
    if (actions.length + 2 > budget) {
      return actions;
    }
    const label = DEAL_TEMPLATE_LABELS[proposal.terms.template];
    const shared = {
      dealID: proposal.dealID,
      recipientID: proposal.proposerPlayerID,
      recipientName: proposal.proposerName,
      ...termsMetadata(proposal.terms),
      legalReason: "open proposal addressed to this agent",
    };
    push({
      id: `deal_accept:${proposal.dealID}`,
      kind: "deal_accept",
      label: `Accept ${proposal.proposerName}'s ${label}`,
      intent: null,
      risk: { level: "medium", score: 0.35 },
      metadata: shared,
    });
    push({
      id: `deal_reject:${proposal.dealID}`,
      kind: "deal_reject",
      label: `Reject ${proposal.proposerName}'s ${label}`,
      intent: null,
      risk: { level: "none", score: 0 },
      metadata: shared,
    });
  }
  for (const proposal of deals.outgoingProposals) {
    const kept = push({
      id: `deal_withdraw:${proposal.dealID}`,
      kind: "deal_withdraw",
      label: `Withdraw ${DEAL_TEMPLATE_LABELS[proposal.terms.template]} offer to ${proposal.recipientName}`,
      intent: null,
      risk: { level: "none", score: 0 },
      metadata: {
        dealID: proposal.dealID,
        recipientID: proposal.recipientPlayerID,
        recipientName: proposal.recipientName,
        ...termsMetadata(proposal.terms),
        legalReason: "own open proposal may be withdrawn",
      },
    });
    if (!kept) {
      return actions;
    }
  }
  for (const option of deals.proposalOptions) {
    const label = DEAL_TEMPLATE_LABELS[option.terms.template];
    const suffix =
      option.terms.template === "joint_attack"
        ? ` against ${option.terms.targetName ?? option.terms.targetPlayerID}`
        : "";
    const kept = push({
      id: `deal_propose:${option.recipientPlayerID}:${option.terms.template}`,
      kind: "deal_propose",
      label: `Propose ${label} to ${option.recipientName}${suffix}`,
      intent: null,
      risk: { level: "low", score: 0.15 },
      metadata: {
        recipientID: option.recipientPlayerID,
        recipientName: option.recipientName,
        ...termsMetadata(option.terms),
        legalReason: "deal manager has capacity for this pair and template",
      },
    });
    if (!kept) {
      return actions;
    }
  }
  return actions;
}

/**
 * Truncate to `cap` total entries while guaranteeing diplomacy actions up to
 * `reserve` slots. Relative order within each group is preserved, and the
 * final list keeps the original assembly order (non-diplomacy first where it
 * appeared first). If there are fewer diplomacy actions than the reserve, the
 * unused reserve goes back to the other kinds.
 */
export function reservedQuotaTruncate(
  actions: readonly LegalAction[],
  cap: number,
  reserve: number,
): LegalAction[] {
  const diplomacy = actions.filter((action) => DIPLOMACY_KINDS.has(action.kind));
  const othersCount = actions.length - diplomacy.length;
  // Diplomacy gets its reserve PLUS any budget the other kinds cannot use, so
  // the menu always fills to cap when enough actions exist (reviewer finding:
  // without the top-up, 85 others + 20 diplomacy at cap 96/reserve 8 wasted
  // 3 slots while dropping diplomacy).
  let keepDiplomacy = Math.min(
    diplomacy.length,
    Math.max(reserve, cap - othersCount),
    cap,
  );
  // Never split a deal_accept from its deal_reject: dealMetaActions always
  // emits them as an adjacent pair for the same proposal. If the cutoff
  // lands right between them, drop the accept too; the freed slot returns
  // to the non-diplomacy budget below.
  const lastKept = diplomacy[keepDiplomacy - 1];
  const firstCut = diplomacy[keepDiplomacy];
  if (
    keepDiplomacy > 0 &&
    keepDiplomacy < diplomacy.length &&
    lastKept.kind === "deal_accept" &&
    firstCut.kind === "deal_reject" &&
    lastKept.id.slice("deal_accept:".length) ===
      firstCut.id.slice("deal_reject:".length)
  ) {
    keepDiplomacy -= 1;
  }
  const keepOthers = Math.min(othersCount, cap - keepDiplomacy);
  const keptDiplomacyIds = new Set(
    diplomacy.slice(0, keepDiplomacy).map((action) => action.id),
  );
  const result: LegalAction[] = [];
  let othersKept = 0;
  for (const action of actions) {
    if (keptDiplomacyIds.has(action.id)) {
      result.push(action);
    } else if (
      !DIPLOMACY_KINDS.has(action.kind) &&
      othersKept < keepOthers
    ) {
      result.push(action);
      othersKept++;
    }
    if (result.length >= cap) {
      break;
    }
  }
  return result;
}
