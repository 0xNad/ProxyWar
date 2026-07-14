import type { KeystoneBidComponents } from "./types";

const BASIS_POINT_MAX = 10_000;

/**
 * Common council utility function. Positive weights total eight:
 * 4x expected value + 2x urgency + 2x confidence, less 2x risk and 1x
 * opportunity cost. The result remains integer basis points and may be
 * negative, which lets an expert abstain instead of forcing a bad action.
 */
export function computeKeystoneBidBP(
  components: KeystoneBidComponents,
  actionRiskFloorBP = 0,
): number {
  assertBasisPoints("expectedValueBP", components.expectedValueBP);
  assertBasisPoints("urgencyBP", components.urgencyBP);
  assertBasisPoints("confidenceBP", components.confidenceBP);
  assertBasisPoints("riskBP", components.riskBP);
  assertBasisPoints("opportunityCostBP", components.opportunityCostBP);
  assertBasisPoints("actionRiskFloorBP", actionRiskFloorBP);

  const effectiveRiskBP = Math.max(components.riskBP, actionRiskFloorBP);
  const numerator =
    4 * components.expectedValueBP +
    2 * components.urgencyBP +
    2 * components.confidenceBP -
    2 * effectiveRiskBP -
    components.opportunityCostBP;
  return Math.trunc(numerator / 8);
}

function assertBasisPoints(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > BASIS_POINT_MAX) {
    throw new RangeError(`${label} must be an integer from 0 to 10000`);
  }
}
