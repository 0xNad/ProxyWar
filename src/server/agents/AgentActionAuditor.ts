import { Game, Player, UnitType } from "../../core/game/Game";
import { Intent } from "../../core/Schemas";
import {
  AgentActionAudit,
  AgentActionAuditSnapshot,
  AgentDecisionRecord,
} from "./AgentTypes";

const auditedUnitTypes = [
  UnitType.City,
  UnitType.Factory,
  UnitType.DefensePost,
  UnitType.Port,
  UnitType.MissileSilo,
  UnitType.SAMLauncher,
  UnitType.Warship,
  UnitType.TransportShip,
  UnitType.AtomBomb,
  UnitType.HydrogenBomb,
  UnitType.MIRV,
] as const;

export function auditDecisionEffects(input: {
  records: AgentDecisionRecord[];
  beforeGame: Game | null;
  afterGame: Game | null;
}): void {
  for (const record of input.records) {
    record.audit = auditDecisionEffect(record, input.beforeGame, input.afterGame);
  }
}

export function auditDecisionEffect(
  record: AgentDecisionRecord,
  beforeGame: Game | null,
  afterGame: Game | null,
): AgentActionAudit {
  const before = snapshotForRecord(beforeGame, record);
  const after = snapshotForRecord(afterGame, record);
  const targetBefore = snapshotForTarget(beforeGame, record.intent);
  const targetAfter = snapshotForTarget(afterGame, record.intent);

  if (!record.result.accepted) {
    return {
      auditStatus: "not_applicable",
      auditReason: "intent was rejected, so no accepted effect was expected",
      before,
      after,
      targetBefore,
      targetAfter,
    };
  }

  if (record.intent === null || record.chosenActionKind === "hold") {
    return {
      auditStatus: "not_applicable",
      auditReason: "hold selected; no game intent was submitted",
      before,
      after,
      targetBefore,
      targetAfter,
    };
  }

  if (afterGame === null || after === null) {
    return {
      auditStatus: "unknown",
      auditReason:
        "after-state mirror snapshot was unavailable, so the accepted effect cannot be checked",
      before,
      after,
      targetBefore,
      targetAfter,
    };
  }

  switch (record.intent.type) {
    case "spawn":
      return auditSpawn(before, after);
    case "build_unit":
      return auditBuild(record, afterGame, before, after, record.intent);
    case "embargo":
      return auditEmbargo(before, after, record.intent.targetID, record.intent.action);
    case "allianceRequest":
      return auditAllianceRequest(before, after, record.intent.recipient);
    case "attack":
      return auditAttack(before, after, targetBefore, targetAfter, record.intent);
    case "donate_gold":
      return auditDonateGold(before, after, targetBefore, targetAfter);
    case "donate_troops":
      return auditDonateTroops(before, after, targetBefore, targetAfter);
    case "cancel_attack":
      return auditCancelAttack(before, after, record.intent.attackID);
    case "cancel_boat":
      return auditCancelBoat(before, after, record.intent.unitID);
    case "boat":
      return auditBoat(before, after);
    case "embargo_all":
      return auditEmbargoAll(before, after, record.intent.action);
    case "upgrade_structure":
      return auditUpgradeStructure(before, after, record.intent);
    case "delete_unit":
      return auditDeleteUnit(before, after, record.intent.unitId);
    case "move_warship":
      return auditMoveWarship(after, record.intent);
    case "targetPlayer":
      return auditTargetPlayer(after, record.intent.target);
    case "allianceReject":
    case "allianceExtension":
    case "breakAlliance":
    case "quick_chat":
    case "emoji":
      return {
        auditStatus: "unknown",
        auditReason: `${record.intent.type} was accepted; this audit records legality and acceptance but does not have a stable state delta to verify every diplomacy/social side effect`,
        before,
        after,
        targetBefore,
        targetAfter,
      };
    default:
      return {
        auditStatus: "unknown",
        auditReason: `no effect audit is implemented for intent type ${record.intent.type}`,
        before,
        after,
        targetBefore,
        targetAfter,
      };
  }
}

function auditSpawn(
  before: AgentActionAuditSnapshot | null,
  after: AgentActionAuditSnapshot,
): AgentActionAudit {
  const confirmed =
    after.hasSpawned === true &&
    after.isAlive === true &&
    (after.tilesOwned ?? 0) > 0;
  return {
    auditStatus: confirmed ? "confirmed" : "failed",
    auditReason: confirmed
      ? "spawn accepted and after-state shows the player spawned, alive, and owning territory"
      : "spawn accepted but after-state did not show a live spawned player with territory",
    before,
    after,
  };
}

function auditCancelAttack(
  before: AgentActionAuditSnapshot | null,
  after: AgentActionAuditSnapshot,
  attackID: string,
): AgentActionAudit {
  const beforeHadAttack = before?.outgoingAttackIDs?.includes(attackID) ?? false;
  const afterHasAttack = after.outgoingAttackIDs?.includes(attackID) ?? false;
  return {
    auditStatus: beforeHadAttack && !afterHasAttack ? "confirmed" : "unknown",
    auditReason:
      beforeHadAttack && !afterHasAttack
        ? `cancel_attack accepted and attack ${attackID} is no longer outgoing`
        : "cancel_attack was accepted, but attack id disappearance could not be confirmed from snapshots",
    before,
    after,
  };
}

function auditCancelBoat(
  before: AgentActionAuditSnapshot | null,
  after: AgentActionAuditSnapshot,
  unitID: number,
): AgentActionAudit {
  const beforeHadBoat = before?.unitTiles?.[`TransportShip:${unitID}`] !== undefined;
  const afterHasBoat = after.unitTiles?.[`TransportShip:${unitID}`] !== undefined;
  const afterRetreating =
    after.transportRetreatingUnitIDs?.includes(unitID) ?? false;
  return {
    auditStatus:
      (beforeHadBoat && !afterHasBoat) || afterRetreating ? "confirmed" : "unknown",
    auditReason:
      (beforeHadBoat && !afterHasBoat) || afterRetreating
        ? `cancel_boat accepted and transport ${unitID} is gone or retreating`
        : "cancel_boat was accepted, but transport retreat was not visible yet",
    before,
    after,
  };
}

function auditBoat(
  before: AgentActionAuditSnapshot | null,
  after: AgentActionAuditSnapshot,
): AgentActionAudit {
  const beforeCount = before?.unitCounts[UnitType.TransportShip] ?? 0;
  const afterCount = after.unitCounts[UnitType.TransportShip] ?? 0;
  const troopDecrease =
    before?.troops !== null &&
    before?.troops !== undefined &&
    after.troops !== null &&
    after.troops < before.troops;
  return {
    auditStatus: afterCount > beforeCount || troopDecrease ? "confirmed" : "unknown",
    auditReason:
      afterCount > beforeCount || troopDecrease
        ? "boat accepted and after-state shows a new transport or troop commitment"
        : "boat was accepted, but transport launch was not visible yet",
    before,
    after,
  };
}

function auditEmbargoAll(
  before: AgentActionAuditSnapshot | null,
  after: AgentActionAuditSnapshot,
  action: "start" | "stop",
): AgentActionAudit {
  const beforeCount = before?.outgoingEmbargoTargetIDs.length ?? 0;
  const afterCount = after.outgoingEmbargoTargetIDs.length;
  const confirmed =
    action === "start" ? afterCount > beforeCount : afterCount < beforeCount;
  return {
    auditStatus: confirmed ? "confirmed" : "unknown",
    auditReason: confirmed
      ? `embargo_all ${action} accepted and outgoing embargo count changed from ${beforeCount} to ${afterCount}`
      : `embargo_all ${action} was accepted, but embargo count did not visibly change`,
    before,
    after,
  };
}

function auditUpgradeStructure(
  before: AgentActionAuditSnapshot | null,
  after: AgentActionAuditSnapshot,
  intent: Extract<Intent, { type: "upgrade_structure" }>,
): AgentActionAudit {
  const key = `${intent.unit}:${intent.unitId}`;
  const beforeLevel = before?.unitLevels?.[key];
  const afterLevel = after.unitLevels?.[key];
  return {
    auditStatus:
      beforeLevel !== undefined &&
      afterLevel !== undefined &&
      afterLevel > beforeLevel
        ? "confirmed"
        : "unknown",
    auditReason:
      beforeLevel !== undefined &&
      afterLevel !== undefined &&
      afterLevel > beforeLevel
        ? `upgrade_structure accepted and ${key} level increased from ${beforeLevel} to ${afterLevel}`
        : "upgrade_structure was accepted, but a level increase was not visible yet",
    before,
    after,
  };
}

function auditDeleteUnit(
  before: AgentActionAuditSnapshot | null,
  after: AgentActionAuditSnapshot,
  unitID: number,
): AgentActionAudit {
  const beforeKeys = Object.keys(before?.unitTiles ?? {}).filter((key) =>
    key.endsWith(`:${unitID}`),
  );
  const afterKeys = Object.keys(after.unitTiles ?? {}).filter((key) =>
    key.endsWith(`:${unitID}`),
  );
  return {
    auditStatus: beforeKeys.length > 0 && afterKeys.length === 0 ? "confirmed" : "unknown",
    auditReason:
      beforeKeys.length > 0 && afterKeys.length === 0
        ? `delete_unit accepted and unit ${unitID} disappeared from snapshot`
        : "delete_unit was accepted, but deletion was not visible yet",
    before,
    after,
  };
}

function auditMoveWarship(
  after: AgentActionAuditSnapshot,
  intent: Extract<Intent, { type: "move_warship" }>,
): AgentActionAudit {
  const anyTracked = intent.unitIds.some(
    (unitID) => after.unitTiles?.[`Warship:${unitID}`] !== undefined,
  );
  return {
    auditStatus: anyTracked ? "confirmed" : "unknown",
    auditReason: anyTracked
      ? "move_warship accepted and at least one ordered warship remains tracked after the move"
      : "move_warship was accepted, but ordered warships were not visible in the snapshot",
    after,
  };
}

function auditTargetPlayer(
  after: AgentActionAuditSnapshot,
  targetID: string,
): AgentActionAudit {
  return {
    auditStatus:
      after.targetPlayerIDs?.includes(targetID) === true ? "confirmed" : "unknown",
    auditReason:
      after.targetPlayerIDs?.includes(targetID) === true
        ? `targetPlayer accepted and after-state lists ${targetID} as a target`
        : "targetPlayer was accepted, but target list did not visibly update",
    after,
  };
}

function auditBuild(
  record: AgentDecisionRecord,
  afterGame: Game,
  before: AgentActionAuditSnapshot | null,
  after: AgentActionAuditSnapshot,
  intent: Extract<Intent, { type: "build_unit" }>,
): AgentActionAudit {
  const buildTile = numericMetadata(record.chosenActionMetadata, "buildTile");
  const builder = playerByClientID(afterGame, record.clientID);
  const builtExactTile =
    buildTile !== null &&
    builder?.units(intent.unit).some((unit) => unit.tile() === buildTile) ===
      true;
  const beforeCount = before?.unitCounts[intent.unit] ?? 0;
  const afterCount = after.unitCounts[intent.unit] ?? 0;
  const countIncreased = afterCount > beforeCount;

  if (builtExactTile || countIncreased) {
    return {
      auditStatus: "confirmed",
      auditReason: builtExactTile
        ? `build_unit accepted and after-state contains ${intent.unit} at tile ${buildTile}`
        : `build_unit accepted and ${intent.unit} count increased from ${beforeCount} to ${afterCount}`,
      before,
      after,
    };
  }

  return {
    auditStatus: "unknown",
    auditReason:
      "build_unit was accepted, but the mirror snapshot did not yet expose a new matching structure; construction may require more turns or the exact build tile may be unavailable",
    before,
    after,
  };
}

function auditEmbargo(
  before: AgentActionAuditSnapshot | null,
  after: AgentActionAuditSnapshot,
  targetID: string,
  action: "start" | "stop",
): AgentActionAudit {
  const confirmed =
    action === "start"
      ? after.outgoingEmbargoTargetIDs.includes(targetID)
      : !after.outgoingEmbargoTargetIDs.includes(targetID);
  if (confirmed) {
    return {
      auditStatus: "confirmed",
      auditReason:
        action === "start"
          ? `embargo accepted and after-state shows an outgoing embargo against ${targetID}`
          : `embargo stop accepted and after-state no longer shows an outgoing embargo against ${targetID}`,
      before,
      after,
    };
  }
  return {
    auditStatus: "unknown",
    auditReason:
      "embargo was accepted, but the after-state did not expose the expected embargo change; it may have been superseded or the snapshot missed the diplomacy update",
    before,
    after,
  };
}

function auditAllianceRequest(
  before: AgentActionAuditSnapshot | null,
  after: AgentActionAuditSnapshot,
  recipientID: string,
): AgentActionAudit {
  if (after.outgoingAllianceRequestRecipientIDs.includes(recipientID)) {
    return {
      auditStatus: "confirmed",
      auditReason: `allianceRequest accepted and after-state shows an outgoing request to ${recipientID}`,
      before,
      after,
    };
  }
  return {
    auditStatus: "unknown",
    auditReason:
      "allianceRequest was accepted, but the after-state did not expose the request; it may have expired, been resolved, or been filtered by the mirror snapshot",
    before,
    after,
  };
}

function auditAttack(
  before: AgentActionAuditSnapshot | null,
  after: AgentActionAuditSnapshot,
  targetBefore: AgentActionAuditSnapshot | null,
  targetAfter: AgentActionAuditSnapshot | null,
  intent: Extract<Intent, { type: "attack" }>,
): AgentActionAudit {
  if (intent.targetID === null) {
    if (
      before !== null &&
      after.tilesOwned !== null &&
      before.tilesOwned !== null &&
      after.tilesOwned > before.tilesOwned
    ) {
      return {
        auditStatus: "confirmed",
        auditReason: `neutral expansion accepted and owned territory increased from ${before.tilesOwned} to ${after.tilesOwned} tiles`,
        before,
        after,
        targetBefore,
        targetAfter,
      };
    }
    if (before !== null && after.troops !== null && before.troops !== null) {
      if (after.troops < before.troops) {
        return {
          auditStatus: "confirmed",
          auditReason: `neutral expansion accepted and attacker troops decreased from ${before.troops} to ${after.troops}`,
          before,
          after,
          targetBefore,
          targetAfter,
        };
      }
    }
    return {
      auditStatus: "unknown",
      auditReason:
        "neutral expansion was accepted, but the mirror snapshot did not yet expose troop or territory movement",
      before,
      after,
      targetBefore,
      targetAfter,
    };
  }
  if (after.outgoingAttackTargetIDs.includes(intent.targetID)) {
    return {
      auditStatus: "confirmed",
      auditReason: `attack accepted and after-state shows an outgoing attack against ${intent.targetID}`,
      before,
      after,
      targetBefore,
      targetAfter,
    };
  }
  if (before !== null && after.troops !== null && before.troops !== null) {
    if (after.troops < before.troops) {
      return {
        auditStatus: "confirmed",
        auditReason: `attack accepted and attacker troops decreased from ${before.troops} to ${after.troops}`,
        before,
        after,
        targetBefore,
        targetAfter,
      };
    }
  }
  if (
    targetBefore !== null &&
    targetAfter !== null &&
    (targetBefore.troops !== targetAfter.troops ||
      targetBefore.tilesOwned !== targetAfter.tilesOwned)
  ) {
    return {
      auditStatus: "confirmed",
      auditReason:
        "attack accepted and target state changed in troops or territory",
      before,
      after,
      targetBefore,
      targetAfter,
    };
  }

  return {
    auditStatus: "unknown",
    auditReason:
      "attack was accepted, but the after-state did not retain a detectable outgoing attack or combat delta",
    before,
    after,
    targetBefore,
    targetAfter,
  };
}

function auditDonateGold(
  before: AgentActionAuditSnapshot | null,
  after: AgentActionAuditSnapshot,
  targetBefore: AgentActionAuditSnapshot | null,
  targetAfter: AgentActionAuditSnapshot | null,
): AgentActionAudit {
  const actorDecrease = compareGold(after.gold, before?.gold) < 0;
  const targetIncrease = compareGold(targetAfter?.gold, targetBefore?.gold) > 0;
  if (actorDecrease || targetIncrease) {
    return {
      auditStatus: "confirmed",
      auditReason:
        "donate_gold accepted and after-state shows actor gold decreased or recipient gold increased",
      before,
      after,
      targetBefore,
      targetAfter,
    };
  }
  return {
    auditStatus: "unknown",
    auditReason:
      "donate_gold was accepted, but before/after gold snapshots did not prove a transfer",
    before,
    after,
    targetBefore,
    targetAfter,
  };
}

function auditDonateTroops(
  before: AgentActionAuditSnapshot | null,
  after: AgentActionAuditSnapshot,
  targetBefore: AgentActionAuditSnapshot | null,
  targetAfter: AgentActionAuditSnapshot | null,
): AgentActionAudit {
  const actorDecrease =
    before?.troops !== null &&
    before?.troops !== undefined &&
    after.troops !== null &&
    after.troops < before.troops;
  const targetIncrease =
    targetBefore?.troops !== null &&
    targetBefore?.troops !== undefined &&
    targetAfter?.troops !== null &&
    targetAfter?.troops !== undefined &&
    targetAfter.troops > targetBefore.troops;
  if (actorDecrease || targetIncrease) {
    return {
      auditStatus: "confirmed",
      auditReason:
        "donate_troops accepted and after-state shows actor troops decreased or recipient troops increased",
      before,
      after,
      targetBefore,
      targetAfter,
    };
  }
  return {
    auditStatus: "unknown",
    auditReason:
      "donate_troops was accepted, but before/after troop snapshots did not prove a transfer",
    before,
    after,
    targetBefore,
    targetAfter,
  };
}

function snapshotForRecord(
  game: Game | null,
  record: AgentDecisionRecord,
): AgentActionAuditSnapshot | null {
  return snapshotPlayer(game, playerByClientID(game, record.clientID));
}

function snapshotForTarget(
  game: Game | null,
  intent: Intent | null,
): AgentActionAuditSnapshot | null {
  if (game === null || intent === null) {
    return null;
  }
  const targetID = targetPlayerID(intent);
  if (targetID === null) {
    return null;
  }
  return snapshotPlayer(
    game,
    game.players().find((player) => player.id() === targetID) ?? null,
  );
}

function snapshotPlayer(
  game: Game | null,
  player: Player | null,
): AgentActionAuditSnapshot | null {
  if (game === null || player === null) {
    return null;
  }
  return {
    tick: game.ticks(),
    playerID: player.id(),
    isAlive: player.isAlive(),
    hasSpawned: player.hasSpawned(),
    tilesOwned: player.numTilesOwned(),
    troops: player.troops(),
    gold: player.gold().toString(),
    unitCounts: Object.fromEntries(
      auditedUnitTypes.map((type) => [type, player.units(type).length]),
    ),
    unitLevels: Object.fromEntries(
      auditedUnitTypes.flatMap((type) =>
        player
          .units(type)
          .flatMap((unit) => {
            const id = safeUnitID(unit);
            const level = safeUnitLevel(unit);
            return id === null || level === null
              ? []
              : [[`${type}:${id}`, level] as const];
          }),
      ),
    ),
    unitTiles: Object.fromEntries(
      auditedUnitTypes.flatMap((type) =>
        player
          .units(type)
          .flatMap((unit) => {
            const id = safeUnitID(unit);
            const tile = safeUnitTile(unit);
            return id === null || tile === null
              ? []
              : [[`${type}:${id}`, tile] as const];
          }),
      ),
    ),
    outgoingAttackTargetIDs: player
      .outgoingAttacks()
      .map((attack) => attack.target().id())
      .filter((id): id is string => id !== null),
    outgoingAttackIDs: player.outgoingAttacks().map((attack) => attack.id()),
    outgoingAllianceRequestRecipientIDs: player
      .outgoingAllianceRequests()
      .map((request) => request.recipient().id()),
    outgoingEmbargoTargetIDs: player
      .getEmbargoes()
      .map((embargo) => embargo.target.id()),
    targetPlayerIDs: playerTargets(player),
    transportRetreatingUnitIDs: player
      .units(UnitType.TransportShip)
      .filter((unit) => unit.transportShipState?.().isRetreating === true)
      .flatMap((unit) => {
        const id = safeUnitID(unit);
        return id === null ? [] : [id];
      }),
  };
}

function safeUnitID(unit: { id?: () => number }): number | null {
  return typeof unit.id === "function" ? unit.id() : null;
}

function safeUnitLevel(unit: { level?: () => number }): number | null {
  return typeof unit.level === "function" ? unit.level() : null;
}

function safeUnitTile(unit: { tile?: () => number }): number | null {
  return typeof unit.tile === "function" ? unit.tile() : null;
}

function playerTargets(player: Player): string[] {
  const maybeTargets = (player as Player & { targets?: () => Player[] }).targets;
  return typeof maybeTargets === "function"
    ? maybeTargets.call(player).map((target) => target.id())
    : [];
}

function playerByClientID(
  game: Game | null,
  clientID: string | null,
): Player | null {
  if (game === null || clientID === null) {
    return null;
  }
  return game.playerByClientID(clientID);
}

function targetPlayerID(intent: Intent): string | null {
  switch (intent.type) {
    case "attack":
      return intent.targetID;
    case "allianceRequest":
      return intent.recipient;
    case "donate_gold":
    case "donate_troops":
      return intent.recipient;
    case "embargo":
      return intent.targetID;
    case "targetPlayer":
      return intent.target;
    case "allianceReject":
      return intent.requestor;
    case "allianceExtension":
    case "breakAlliance":
    case "quick_chat":
    case "emoji":
      return intent.recipient;
    default:
      return null;
  }
}

function numericMetadata(
  metadata: Record<string, string | number | boolean | null> | undefined,
  key: string,
): number | null {
  const value = metadata?.[key];
  return typeof value === "number" ? value : null;
}

function compareGold(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  if (left === null || left === undefined || right === null || right === undefined) {
    return 0;
  }
  try {
    const diff = BigInt(left) - BigInt(right);
    return diff === 0n ? 0 : diff > 0n ? 1 : -1;
  } catch {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) {
      return 0;
    }
    return Math.sign(leftNumber - rightNumber);
  }
}
