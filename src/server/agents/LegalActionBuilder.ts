import { getSpawnTiles } from "../../core/execution/Util";
import { UnitType } from "../../core/game/Game";
import { GameMap, TileRef } from "../../core/game/GameMap";
import {
  AgentObservation,
  AgentStrategyProfile,
  LegalAction,
} from "./AgentTypes";

export interface SpawnCandidate {
  tile: TileRef;
  x?: number;
  y?: number;
  pressureScore: number;
  safetyScore: number;
  diplomacyScore: number;
  opportunityScore: number;
  localLandScore?: number;
}

export interface SpawnCandidateBuilderOptions {
  maxCandidates?: number;
  stride?: number;
}

export interface BuildLegalActionsInput {
  observation: AgentObservation;
  spawnCandidates?: SpawnCandidate[];
  maxSpawnActions?: number;
  maxPostSpawnActions?: number;
}

export class LegalActionBuilder {
  build(input: BuildLegalActionsInput): LegalAction[] {
    const actions: LegalAction[] = [];
    const maxSpawnActions = input.maxSpawnActions ?? 64;

    if (input.observation.phase === "spawn") {
      for (const candidate of spawnActionCandidates(
        input.spawnCandidates ?? [],
        maxSpawnActions,
      )) {
        actions.push(this.spawnAction(candidate));
      }
    }

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

  private spawnAction(candidate: SpawnCandidate): LegalAction {
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
        localLandScore: candidate.localLandScore ?? null,
      },
    };
  }

  private postSpawnActions(input: BuildLegalActionsInput): LegalAction[] {
    if (input.observation.ownState?.isAlive === false) {
      return [];
    }

    const ownTroops = input.observation.ownState?.troops ?? 0;
    const maxActions = input.maxPostSpawnActions ?? 96;
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

    for (const boat of input.observation.nonCombat.boatRetreatOptions ?? []) {
      if (actions.length >= maxActions) {
        break;
      }
      actions.push({
        id: `boat_retreat:${boat.unitID}`,
        kind: "boat_retreat",
        label: `Retreat transport ${boat.unitID}`,
        intent: {
          type: "cancel_boat",
          unitID: boat.unitID,
        },
        risk: { level: "low", score: 0.15 },
        metadata: {
          unitID: boat.unitID,
          tile: boat.tile,
          targetTile: boat.targetTile,
          troops: boat.troops,
          legalReason: boat.legalReason,
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

    return actions;
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

function spawnActionCandidates(
  candidates: SpawnCandidate[],
  maxActions: number,
): SpawnCandidate[] {
  if (maxActions <= 0) {
    return [];
  }
  if (candidates.length <= maxActions) {
    return candidates;
  }

  const selected: SpawnCandidate[] = [];
  const selectedTiles = new Set<TileRef>();
  const addCandidate = (candidate: SpawnCandidate): void => {
    if (selected.length >= maxActions || selectedTiles.has(candidate.tile)) {
      return;
    }
    selected.push(candidate);
    selectedTiles.add(candidate.tile);
  };
  const qualitySorted = [...candidates].sort(compareSpawnCandidateQuality);
  const coreTarget = Math.min(
    maxActions,
    Math.max(4, Math.floor(maxActions * 0.35)),
  );

  for (const candidate of qualitySorted) {
    if (selected.length >= coreTarget) {
      break;
    }
    addCandidate(candidate);
  }
  for (const candidate of spatialSpawnScouts(candidates, 12, 8)) {
    addCandidate(candidate);
  }
  for (const candidate of qualitySorted) {
    addCandidate(candidate);
  }

  return selected;
}

function compareSpawnCandidateQuality(
  a: SpawnCandidate,
  b: SpawnCandidate,
): number {
  return (
    spawnCandidateQuality(b) - spawnCandidateQuality(a) ||
    b.opportunityScore - a.opportunityScore ||
    (b.localLandScore ?? 0) - (a.localLandScore ?? 0) ||
    a.tile - b.tile
  );
}

function spawnCandidateQuality(candidate: SpawnCandidate): number {
  const safetyScore = candidate.safetyScore;
  const middleSafetyBand = Math.max(0, 1 - Math.abs(safetyScore - 0.32) / 0.24);
  const lowSafetyPenalty =
    safetyScore < 0.18
      ? (0.18 - safetyScore) * 2.4 + 0.16
      : safetyScore < 0.23
        ? (0.23 - safetyScore) * 1.1
        : 0;
  return (
    candidate.opportunityScore * 0.32 +
    candidate.pressureScore * 0.18 +
    middleSafetyBand * 0.03 +
    (candidate.localLandScore ?? 0) * 0.5 +
    safetyScore * 0.25 +
    candidate.diplomacyScore * 0.28 -
    lowSafetyPenalty
  );
}

function spatialSpawnScouts(
  candidates: readonly SpawnCandidate[],
  columns: number,
  rows: number,
): SpawnCandidate[] {
  const bounds = spawnCandidateCoordinateBounds(candidates);
  if (bounds === null || columns <= 0 || rows <= 0) {
    return [];
  }

  const bestByCell = new Map<string, SpawnCandidate>();
  for (const candidate of candidates) {
    if (typeof candidate.x !== "number" || typeof candidate.y !== "number") {
      continue;
    }
    const cellX = Math.max(
      0,
      Math.min(
        columns - 1,
        Math.floor(((candidate.x - bounds.minX) / bounds.width) * columns),
      ),
    );
    const cellY = Math.max(
      0,
      Math.min(
        rows - 1,
        Math.floor(((candidate.y - bounds.minY) / bounds.height) * rows),
      ),
    );
    const key = `${cellX}:${cellY}`;
    const current = bestByCell.get(key);
    if (
      current === undefined ||
      compareSpawnCandidateQuality(candidate, current) < 0
    ) {
      bestByCell.set(key, candidate);
    }
  }

  return [...bestByCell.values()].sort(compareSpawnCandidateQuality);
}

function spawnCandidateCoordinateBounds(
  candidates: readonly SpawnCandidate[],
): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
} | null {
  const coordinates = candidates.filter(
    (candidate) =>
      typeof candidate.x === "number" && typeof candidate.y === "number",
  );
  if (coordinates.length === 0) {
    return null;
  }
  const xs = coordinates.map((candidate) => candidate.x!);
  const ys = coordinates.map((candidate) => candidate.y!);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: Math.max(1, maxX - minX + 1),
    height: Math.max(1, maxY - minY + 1),
  };
}

function hostileAttackTroopPercentages(): number[] {
  return [0.1, 0.25, 0.4];
}

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
  const candidates: SpawnCandidate[] = [];

  gameMap.forEachTile((tile) => {
    if (tile % stride !== 0) {
      return;
    }
    if (!gameMap.isLand(tile) || gameMap.isBorder(tile)) {
      return;
    }
    if (getSpawnTiles(gameMap, tile, true) === null) {
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
    const localLandScore = localLandRatio(
      gameMap,
      tile,
      Math.max(
        16,
        Math.round(Math.min(gameMap.width(), gameMap.height()) * 0.096),
      ),
    );
    const opportunityScore =
      edgeDistance / maxEdgeDistance + deterministicFraction(tile);

    candidates.push({
      tile,
      x,
      y,
      pressureScore,
      safetyScore,
      diplomacyScore,
      opportunityScore,
      localLandScore,
    });
  });

  return selectSpawnCandidatePool(candidates, maxCandidates);
}

function selectSpawnCandidatePool(
  candidates: SpawnCandidate[],
  maxCandidates: number,
): SpawnCandidate[] {
  if (maxCandidates <= 0) {
    return [];
  }
  if (candidates.length <= maxCandidates) {
    return candidates.sort(compareSpawnCandidateQuality);
  }

  const selected: SpawnCandidate[] = [];
  const selectedTiles = new Set<TileRef>();
  const addCandidate = (candidate: SpawnCandidate): void => {
    if (selected.length >= maxCandidates || selectedTiles.has(candidate.tile)) {
      return;
    }
    selected.push(candidate);
    selectedTiles.add(candidate.tile);
  };
  const qualitySorted = [...candidates].sort(compareSpawnCandidateQuality);
  const coreTarget = Math.min(
    maxCandidates,
    Math.max(200, Math.floor(maxCandidates * 0.72)),
  );

  for (const candidate of qualitySorted) {
    if (selected.length >= coreTarget) {
      break;
    }
    addCandidate(candidate);
  }
  for (const candidate of spatialSpawnScouts(candidates, 24, 16)) {
    addCandidate(candidate);
  }
  for (const candidate of qualitySorted) {
    addCandidate(candidate);
  }

  return selected;
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

export function spawnScoreForProfile(
  profile: AgentStrategyProfile,
  action: LegalAction,
): number {
  if (action.kind !== "spawn") {
    return Number.NEGATIVE_INFINITY;
  }
  const metadata = action.metadata ?? {};
  switch (profile) {
    case "aggressive":
      return (
        Number(metadata.pressureScore ?? 0) * 0.45 +
        Number(metadata.opportunityScore ?? 0) * 0.35 +
        Number(metadata.safetyScore ?? 0) * 0.2
      );
    case "defensive":
      return Number(metadata.safetyScore ?? 0);
    case "diplomatic":
      return Number(metadata.diplomacyScore ?? 0);
    case "opportunistic":
      return Number(metadata.opportunityScore ?? 0);
  }
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
