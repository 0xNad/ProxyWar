import type { RecentAgentDecision } from "../../src/server/agents/AgentTypes";

export const KEYSTONE_DIPLOMACY_MACRO_TURNS = 600;

export type KeystoneDiplomacyMacroState =
  | "idle"
  | "pending"
  | "armed"
  | "cooldown"
  | "expired";

export type KeystoneAllianceRequestClassification =
  | "reactive_request"
  | "first_request"
  | "outgoing_request_pending"
  | "repeat_request"
  | "realliance_after_break"
  | "ambiguous_request_state";

export interface KeystoneDiplomacyMacro {
  readonly state: KeystoneDiplomacyMacroState;
  readonly targetPlayerID: string | null;
  readonly breakActionID: string | null;
  readonly pendingTurn: number | null;
  readonly armedTurn: number | null;
  readonly expiresAfterTurn: number | null;
  readonly cooldownUntilTurn: number | null;
}

/**
 * Accepted-decision truth for diplomacy. Selection is deliberately absent:
 * retries and withdrawn offers must not create relationship or macro state.
 */
export interface KeystoneDiplomacyLedger {
  readonly gameID: string | null;
  readonly lastTurn: number | null;
  readonly lastObservedDecisionSequence: number;
  readonly requestedTargetIDs: readonly string[];
  readonly brokenTargetIDs: readonly string[];
  readonly macro: KeystoneDiplomacyMacro;
}

export type KeystoneDiplomacyTransitionReason =
  | "none"
  | "game_reset"
  | "accepted_request"
  | "accepted_break_armed"
  | "accepted_break_unbound"
  | "pending_break_registered"
  | "pending_break_rejected"
  | "macro_completed"
  | "macro_expired"
  | "cooldown_completed";

export interface KeystoneDiplomacyLedgerResult {
  readonly ledger: KeystoneDiplomacyLedger;
  readonly changed: boolean;
  readonly reason: KeystoneDiplomacyTransitionReason;
}

export interface ReconcileKeystoneDiplomacyLedgerInput {
  readonly gameID: string;
  readonly turnNumber: number;
  readonly recentDecisions: readonly RecentAgentDecision[];
}

export interface RegisterKeystonePendingBreakInput {
  readonly gameID: string;
  readonly turnNumber: number;
  readonly actionID: string;
  readonly targetPlayerID: string;
}

export function initialKeystoneDiplomacyLedger(): KeystoneDiplomacyLedger {
  return freezeLedger({
    gameID: null,
    lastTurn: null,
    lastObservedDecisionSequence: 0,
    requestedTargetIDs: [],
    brokenTargetIDs: [],
    macro: idleMacro(),
  });
}

/**
 * Reconciles only monotonically new accepted records. The last eight decisions
 * are enough because this ledger advances on every observation and remembers
 * the highest sequence it has already inspected.
 */
export function reconcileKeystoneDiplomacyLedger(
  current: KeystoneDiplomacyLedger,
  input: ReconcileKeystoneDiplomacyLedgerInput,
): KeystoneDiplomacyLedgerResult {
  const boundary =
    current.gameID === null ||
    current.gameID !== input.gameID ||
    (current.lastTurn !== null && input.turnNumber < current.lastTurn);
  let ledger = boundary
    ? freezeLedger({
        gameID: input.gameID,
        lastTurn: input.turnNumber,
        lastObservedDecisionSequence: 0,
        requestedTargetIDs: [],
        brokenTargetIDs: [],
        macro: idleMacro(),
      })
    : freezeLedger({ ...current, lastTurn: input.turnNumber });
  let reason: KeystoneDiplomacyTransitionReason = boundary
    ? "game_reset"
    : "none";
  let changed = boundary || current.lastTurn !== input.turnNumber;

  const aged = ageMacro(ledger, input.turnNumber);
  if (aged.changed) {
    ledger = aged.ledger;
    reason = aged.reason;
    changed = true;
  }

  const decisions = [...input.recentDecisions].sort(
    (a, b) => a.sequence - b.sequence,
  );
  let highestSequence = ledger.lastObservedDecisionSequence;
  const requested = new Set(ledger.requestedTargetIDs);
  const broken = new Set(ledger.brokenTargetIDs);
  let macro = ledger.macro;

  for (const decision of decisions) {
    if (
      !Number.isInteger(decision.sequence) ||
      decision.sequence <= highestSequence
    ) {
      continue;
    }
    highestSequence = decision.sequence;
    if (decision.accepted !== true) {
      continue;
    }
    const targetPlayerID = validID(decision.targetID)
      ? decision.targetID
      : null;
    if (decision.actionKind === "alliance_request" && targetPlayerID !== null) {
      const before = requested.size;
      requested.add(targetPlayerID);
      if (requested.size !== before) {
        changed = true;
        reason = "accepted_request";
      }
      continue;
    }
    if (decision.actionKind !== "break_alliance" || targetPlayerID === null) {
      continue;
    }
    const before = broken.size;
    broken.add(targetPlayerID);
    changed = changed || broken.size !== before;
    if (
      macro.state === "pending" &&
      macro.targetPlayerID === targetPlayerID &&
      macro.breakActionID === decision.actionID
    ) {
      macro = freezeMacro({
        state: "armed",
        targetPlayerID,
        breakActionID: decision.actionID,
        pendingTurn: macro.pendingTurn,
        armedTurn: input.turnNumber,
        expiresAfterTurn: input.turnNumber + KEYSTONE_DIPLOMACY_MACRO_TURNS,
        cooldownUntilTurn: null,
      });
      changed = true;
      reason = "accepted_break_armed";
    } else {
      reason = "accepted_break_unbound";
    }
  }

  if (
    highestSequence !== ledger.lastObservedDecisionSequence ||
    !sameIDs(requested, ledger.requestedTargetIDs) ||
    !sameIDs(broken, ledger.brokenTargetIDs) ||
    macro !== ledger.macro
  ) {
    ledger = freezeLedger({
      ...ledger,
      lastObservedDecisionSequence: highestSequence,
      requestedTargetIDs: sortedIDs(requested),
      brokenTargetIDs: sortedIDs(broken),
      macro,
    });
  }
  return freezeResult({ ledger, changed, reason });
}

export function registerKeystonePendingBreak(
  current: KeystoneDiplomacyLedger,
  input: RegisterKeystonePendingBreakInput,
): KeystoneDiplomacyLedgerResult {
  if (
    current.gameID !== input.gameID ||
    !validID(input.actionID) ||
    !validID(input.targetPlayerID) ||
    current.macro.state === "armed" ||
    current.macro.state === "cooldown"
  ) {
    return freezeResult({
      ledger: current,
      changed: false,
      reason: "pending_break_rejected",
    });
  }
  if (
    current.macro.state === "pending" &&
    current.macro.breakActionID === input.actionID &&
    current.macro.targetPlayerID === input.targetPlayerID
  ) {
    return freezeResult({ ledger: current, changed: false, reason: "none" });
  }
  const ledger = freezeLedger({
    ...current,
    lastTurn: input.turnNumber,
    macro: freezeMacro({
      state: "pending",
      targetPlayerID: input.targetPlayerID,
      breakActionID: input.actionID,
      pendingTurn: input.turnNumber,
      armedTurn: null,
      expiresAfterTurn: null,
      cooldownUntilTurn: null,
    }),
  });
  return freezeResult({
    ledger,
    changed: true,
    reason: "pending_break_registered",
  });
}

export function completeKeystoneDiplomacyMacro(
  current: KeystoneDiplomacyLedger,
  turnNumber: number,
  targetPlayerID: string,
): KeystoneDiplomacyLedgerResult {
  if (
    current.macro.state !== "armed" ||
    current.macro.targetPlayerID !== targetPlayerID
  ) {
    return freezeResult({ ledger: current, changed: false, reason: "none" });
  }
  return freezeResult({
    ledger: freezeLedger({
      ...current,
      lastTurn: turnNumber,
      macro: freezeMacro({
        ...current.macro,
        state: "cooldown",
        expiresAfterTurn: null,
        cooldownUntilTurn: turnNumber + KEYSTONE_DIPLOMACY_MACRO_TURNS,
      }),
    }),
    changed: true,
    reason: "macro_completed",
  });
}

export function classifyKeystoneAllianceRequest(args: {
  readonly ledger: KeystoneDiplomacyLedger;
  readonly targetPlayerID: string | null;
  readonly hasIncomingAllianceRequest: boolean | undefined;
  readonly hasOutgoingAllianceRequest: boolean | undefined;
}): KeystoneAllianceRequestClassification {
  if (
    !validID(args.targetPlayerID) ||
    args.hasIncomingAllianceRequest === undefined ||
    args.hasOutgoingAllianceRequest === undefined
  ) {
    return "ambiguous_request_state";
  }
  if (args.ledger.brokenTargetIDs.includes(args.targetPlayerID)) {
    return "realliance_after_break";
  }
  if (args.hasIncomingAllianceRequest) {
    return "reactive_request";
  }
  if (args.hasOutgoingAllianceRequest) {
    return "outgoing_request_pending";
  }
  if (args.ledger.requestedTargetIDs.includes(args.targetPlayerID)) {
    return "repeat_request";
  }
  return "first_request";
}

export function activeKeystoneDiplomacyMacroTarget(
  ledger: KeystoneDiplomacyLedger,
): string | null {
  return ledger.macro.state === "armed" ? ledger.macro.targetPlayerID : null;
}

function ageMacro(
  current: KeystoneDiplomacyLedger,
  turnNumber: number,
): KeystoneDiplomacyLedgerResult {
  const { macro } = current;
  if (
    macro.state === "pending" &&
    macro.pendingTurn !== null &&
    turnNumber > macro.pendingTurn + KEYSTONE_DIPLOMACY_MACRO_TURNS
  ) {
    return freezeResult({
      ledger: freezeLedger({
        ...current,
        macro: freezeMacro({ ...macro, state: "expired" }),
      }),
      changed: true,
      reason: "macro_expired",
    });
  }
  if (
    macro.state === "armed" &&
    macro.expiresAfterTurn !== null &&
    turnNumber > macro.expiresAfterTurn
  ) {
    return freezeResult({
      ledger: freezeLedger({
        ...current,
        macro: freezeMacro({ ...macro, state: "expired" }),
      }),
      changed: true,
      reason: "macro_expired",
    });
  }
  if (
    macro.state === "cooldown" &&
    macro.cooldownUntilTurn !== null &&
    turnNumber > macro.cooldownUntilTurn
  ) {
    return freezeResult({
      ledger: freezeLedger({ ...current, macro: idleMacro() }),
      changed: true,
      reason: "cooldown_completed",
    });
  }
  return freezeResult({ ledger: current, changed: false, reason: "none" });
}

function idleMacro(): KeystoneDiplomacyMacro {
  return freezeMacro({
    state: "idle",
    targetPlayerID: null,
    breakActionID: null,
    pendingTurn: null,
    armedTurn: null,
    expiresAfterTurn: null,
    cooldownUntilTurn: null,
  });
}

function freezeLedger(
  ledger: KeystoneDiplomacyLedger,
): KeystoneDiplomacyLedger {
  return Object.freeze({
    ...ledger,
    requestedTargetIDs: Object.freeze([...ledger.requestedTargetIDs]),
    brokenTargetIDs: Object.freeze([...ledger.brokenTargetIDs]),
    macro: freezeMacro(ledger.macro),
  });
}

function freezeMacro(macro: KeystoneDiplomacyMacro): KeystoneDiplomacyMacro {
  return Object.freeze({ ...macro });
}

function freezeResult(
  result: KeystoneDiplomacyLedgerResult,
): KeystoneDiplomacyLedgerResult {
  return Object.freeze(result);
}

function validID(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sortedIDs(values: ReadonlySet<string>): readonly string[] {
  return Object.freeze([...values].sort(compareText));
}

function sameIDs(
  values: ReadonlySet<string>,
  previous: readonly string[],
): boolean {
  if (values.size !== previous.length) {
    return false;
  }
  return previous.every((value) => values.has(value));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
