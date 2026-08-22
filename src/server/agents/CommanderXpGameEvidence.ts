import { createHash } from "node:crypto";

import type { AgentDecisionRecord, LegalActionKind } from "./AgentTypes";

export const COMMANDER_XP_GAME_EVIDENCE_PREFIX = "COMMANDER_XP_GAME_EVIDENCE ";
export const COMMANDER_XP_GAME_EVIDENCE_SCHEMA_VERSION = 2;

export function commanderXpEvalEvidenceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PROXYWAR_COMMANDER_XP_GAME_EVIDENCE === "1";
}

export interface CommanderXpIntentEvidence {
  type: string;
  sha256: string;
}

export interface CommanderXpSpawnEvidence {
  algorithmVersion: string;
  offeredActionIDs: string[];
  ballotSource: string;
  submittedBallotActionIDs: Array<string | null>;
  submittedBallotCount: number;
  submittedBallotTruncated: boolean;
  normalizedBallotActionIDs: string[];
  ballotValid: boolean;
  ballotInvalidReason: string | null;
  defaultReason: string | null;
  priorityRank: number;
  assignedActionID: string;
  assignedPreferenceRank: number;
  assignedSubmittedPreferenceRank: number | null;
  stageFallbackUsed: boolean;
  stageDegraded: boolean;
}

export interface CommanderXpDealEvidence {
  requestedActionID: string;
  validation: {
    accepted: boolean;
    actionID: string | null;
    actionKind: string | null;
  };
  application: {
    attempted: boolean;
    accepted: boolean | null;
  };
}

/**
 * Game-owned, privacy-safe execution proof for the hosted Commander XP study.
 *
 * This is deliberately a projection of the canonical AgentDecisionRecord, not
 * a second action path. In particular it omits observation prose, provider
 * material, rationale, externalRawOutput and commsSlotText. The remaining
 * fields are sufficient to prove offered -> selected -> submitted -> audited
 * execution and to join that proof 1:1 to the policy-side trace by Coworld
 * request id.
 */
export interface CommanderXpGameEvidence {
  schemaVersion: 2;
  runKey: string;
  requestID: string;
  sequence: number;
  gameID: string;
  coworldSlot: number;
  agentID: string;
  turnNumber: number;
  legalActions: Array<{ id: string; kind: LegalActionKind }>;
  offeredLegalActionSetSha256: string;
  chosen: { id: string; kind: LegalActionKind };
  generatedIntent: CommanderXpIntentEvidence | null;
  result: {
    accepted: boolean;
    submittedIntent: CommanderXpIntentEvidence | null;
  };
  audit: {
    status: AgentDecisionRecord["audit"] extends infer T
      ? T extends { auditStatus: infer S }
        ? S
        : null
      : null;
    reasonSha256: string | null;
  };
  spawn: CommanderXpSpawnEvidence | null;
  deal: CommanderXpDealEvidence | null;
  comms: {
    requestedID: string | null;
    actionID: string | null;
    recipientID: string | null;
    accepted: boolean | null;
    rejected: boolean | null;
  };
}

export function projectCommanderXpGameEvidence(
  record: AgentDecisionRecord,
  runKey: string,
): CommanderXpGameEvidence | null {
  const metadata = record.decisionMetadata ?? {};
  const requestID = metadata.coworldRequestID;
  const coworldSlot = metadata.coworldSlot;
  if (
    typeof requestID !== "string" ||
    requestID.length === 0 ||
    typeof coworldSlot !== "number" ||
    !Number.isInteger(coworldSlot) ||
    coworldSlot < 0 ||
    !/^commander-xp-v2\/[A-Za-z0-9._-]+\/(?:provider-preflight|canary|confirmatory)\/r\d{2}\/(?:A|B|C)$/.test(
      runKey,
    )
  ) {
    return null;
  }
  const kindByID = new Map<string, LegalActionKind>();
  for (const [kind, ids] of Object.entries(record.legalActionIDsByKind)) {
    for (const id of ids ?? []) {
      kindByID.set(id, kind as LegalActionKind);
    }
  }
  const legalActions = record.legalActionIDs.map((id) => {
    const kind = kindByID.get(id);
    if (kind === undefined) {
      throw new Error("Commander XP evidence found an unclassified action id");
    }
    return { id, kind };
  });
  return {
    schemaVersion: COMMANDER_XP_GAME_EVIDENCE_SCHEMA_VERSION,
    runKey,
    requestID,
    sequence: record.sequence,
    gameID: record.gameID,
    coworldSlot,
    agentID: record.agentID,
    turnNumber: record.turnNumber,
    legalActions,
    offeredLegalActionSetSha256: sha256Canonical(legalActions),
    chosen: { id: record.chosenActionID, kind: record.chosenActionKind },
    generatedIntent: projectIntent(record.intent),
    result: {
      accepted: record.result.accepted,
      submittedIntent: projectIntent(record.result.submittedIntent),
    },
    audit: {
      status: record.audit?.auditStatus ?? null,
      reasonSha256:
        record.audit?.auditReason === undefined
          ? null
          : sha256Canonical(record.audit.auditReason),
    },
    spawn: projectSpawn(record.spawnSelectionEvidence),
    deal: projectDeal(record.dealSlotEvidence),
    comms: {
      requestedID: stringMetadata(metadata, "commsSlotRequestedID"),
      actionID: stringMetadata(metadata, "commsSlotActionID"),
      recipientID: stringMetadata(metadata, "commsSlotRecipientID"),
      accepted: booleanMetadata(metadata, "commsSlotAccepted"),
      rejected:
        stringMetadata(metadata, "commsSlotRejected") === null ? null : true,
    },
  };
}

function projectIntent(
  intent: AgentDecisionRecord["intent"],
): CommanderXpIntentEvidence | null {
  if (intent === null) return null;
  return { type: intent.type, sha256: sha256Canonical(intent) };
}

function projectSpawn(
  spawn: AgentDecisionRecord["spawnSelectionEvidence"],
): CommanderXpSpawnEvidence | null {
  if (spawn === undefined) return null;
  return {
    algorithmVersion: spawn.algorithmVersion,
    offeredActionIDs: [...spawn.offeredActionIDs],
    ballotSource: spawn.ballotSource,
    submittedBallotActionIDs: [...spawn.submittedBallotActionIDs],
    submittedBallotCount: spawn.submittedBallotCount,
    submittedBallotTruncated: spawn.submittedBallotTruncated,
    normalizedBallotActionIDs: [...spawn.normalizedBallotActionIDs],
    ballotValid: spawn.ballotValid,
    ballotInvalidReason: spawn.ballotInvalidReason,
    defaultReason: spawn.defaultReason,
    priorityRank: spawn.priorityRank,
    assignedActionID: spawn.assignedActionID,
    assignedPreferenceRank: spawn.assignedPreferenceRank,
    assignedSubmittedPreferenceRank: spawn.assignedSubmittedPreferenceRank,
    stageFallbackUsed: spawn.stageFallbackUsed,
    stageDegraded: spawn.stageDegradationReason !== null,
  };
}

function projectDeal(
  deal: AgentDecisionRecord["dealSlotEvidence"],
): CommanderXpDealEvidence | null {
  if (deal === undefined) return null;
  return {
    requestedActionID: deal.requestedActionID,
    validation: deal.validation.accepted
      ? {
          accepted: true,
          actionID: deal.validation.actionID,
          actionKind: deal.validation.actionKind,
        }
      : { accepted: false, actionID: null, actionKind: null },
    application: deal.application.attempted
      ? {
          attempted: true,
          accepted: deal.application.accepted,
        }
      : { attempted: false, accepted: null },
  };
}

export function commanderXpGameEvidenceLine(
  evidence: CommanderXpGameEvidence,
): string {
  return `${COMMANDER_XP_GAME_EVIDENCE_PREFIX}${JSON.stringify(evidence)}`;
}

function stringMetadata(
  metadata: Record<string, string | number | boolean | null>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

function booleanMetadata(
  metadata: Record<string, string | number | boolean | null>,
  key: string,
): boolean | null {
  const value = metadata[key];
  return typeof value === "boolean" ? value : null;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}
