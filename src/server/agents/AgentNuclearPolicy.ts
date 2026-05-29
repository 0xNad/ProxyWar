import { UnitType } from "../../core/game/Game";

export function nuclearTargetStructurePriority(
  unit: string | null | undefined,
): number {
  switch (unit) {
    case UnitType.MissileSilo:
    case "MissileSilo":
    case "Missile Silo":
      return 120;
    case UnitType.SAMLauncher:
    case "SAMLauncher":
    case "SAM Launcher":
      return 112;
    case UnitType.City:
    case "City":
      return 94;
    case UnitType.Factory:
    case "Factory":
      return 82;
    case UnitType.Port:
    case "Port":
      return 68;
    case UnitType.DefensePost:
    case "DefensePost":
    case "Defense Post":
      return 38;
    case UnitType.Warship:
    case "Warship":
      return 24;
    default:
      return 0;
  }
}

export function nuclearWeaponPriority(unit: string | null | undefined): number {
  switch (unit) {
    case UnitType.MIRV:
    case "MIRV":
      return 66;
    case UnitType.HydrogenBomb:
    case "HydrogenBomb":
    case "Hydrogen Bomb":
      return 54;
    case UnitType.AtomBomb:
    case "AtomBomb":
    case "Atom Bomb":
      return 38;
    default:
      return 24;
  }
}

export interface NuclearStrikePriorityInput {
  weaponUnit: string | null | undefined;
  targetID?: string | null;
  targetIsLeader?: boolean;
  incomingAttacker?: boolean;
  turnNumber: number;
  ownTileShare?: number | null;
  targetTileShare?: number | null;
  targetStructureUnit?: string | null;
  targetStructurePriority?: number | null;
  targetSamCoverage?: number | null;
  nuclearTargetPriority?: number | null;
  leaderTileShareGap?: number | null;
}

export function nuclearStrikePriorityScore(
  input: NuclearStrikePriorityInput,
): number {
  const ownTileShare = input.ownTileShare ?? 0;
  const targetTileShare = input.targetTileShare ?? 0;
  const structurePriority =
    input.targetStructurePriority ??
    nuclearTargetStructurePriority(input.targetStructureUnit);
  const targetPriority = input.nuclearTargetPriority ?? 0;
  const leaderGap = input.leaderTileShareGap ?? 0;
  let priority =
    nuclearWeaponPriority(input.weaponUnit) +
    Math.round(structurePriority * 0.48) +
    Math.round(targetPriority * 0.25);
  if (input.targetIsLeader === true) priority += 54;
  if (input.incomingAttacker === true) priority += 54;
  if (targetTileShare >= ownTileShare + 0.04) priority += 34;
  if (leaderGap >= 0.08 && input.targetIsLeader === true) priority += 26;
  if (input.targetStructureUnit === UnitType.MissileSilo) priority += 46;
  if (input.targetStructureUnit === UnitType.SAMLauncher) priority += 42;
  if (input.targetStructureUnit === UnitType.City) priority += 24;
  if (input.targetStructureUnit === UnitType.Factory) priority += 18;
  if (
    targetTileShare > 0 &&
    targetTileShare <= 0.08 &&
    input.incomingAttacker !== true
  ) {
    priority -= 46;
  }
  if (
    (input.targetSamCoverage ?? 0) > 0 &&
    input.targetStructureUnit !== UnitType.SAMLauncher
  ) {
    priority -= Math.min(28, (input.targetSamCoverage ?? 0) * 6);
  }
  if (input.turnNumber < 1_550) {
    priority -= 90;
  }
  if (!isNuclearWeaponUnit(input.weaponUnit)) {
    priority -= 20;
  }
  return priority;
}

export function isNuclearWeaponUnit(unit: string | null | undefined): boolean {
  return (
    unit === UnitType.AtomBomb ||
    unit === UnitType.HydrogenBomb ||
    unit === UnitType.MIRV ||
    unit === "AtomBomb" ||
    unit === "HydrogenBomb" ||
    unit === "Atom Bomb" ||
    unit === "Hydrogen Bomb" ||
    unit === "MIRV"
  );
}
