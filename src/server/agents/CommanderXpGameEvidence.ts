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
  /** Exact privacy-safe intent fields needed by StrategicOptionFidelity. */
  canonical: Record<string, string | number | boolean | null> | null;
}

export interface CommanderXpFidelityEvidence {
  commanderExecutionSha256: string | null;
  commanderSelectionSha256: string | null;
  planID: string | null;
  planObjective: string | null;
  commanderSelectedOptionID: string | null;
  commanderSelectedOptionFamily: string | null;
  commanderOptionSurfaceSha256: string | null;
  commanderPreviousPlanID: string | null;
  commanderReplanReason: string | null;
  commanderPlanAgeDecisions: number | null;
  commanderEmergencyCondition: string | null;
  commanderPromptVersion: string | null;
  commanderPromptSha256: string | null;
  commanderDeterministicPreferredOptionId: string | null;
  commanderDeterministicPreferredOptionAbsent: boolean | null;
  commanderFidelity: string | null;
  batchIndex: number | null;
  batchSize: number | null;
  batchActionIDs: string | null;
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
  chosen: {
    id: string;
    kind: LegalActionKind;
    metadata: Record<string, string | number | boolean | null>;
  };
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
  commander: CommanderXpFidelityEvidence;
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
    chosen: {
      id: record.chosenActionID,
      kind: record.chosenActionKind,
      metadata: projectFidelityActionMetadata(record.chosenActionMetadata),
    },
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
    commander: {
      commanderExecutionSha256: stringMetadata(
        metadata,
        "commanderExecutionSha256",
      ),
      commanderSelectionSha256: stringMetadata(
        metadata,
        "commanderSelectionSha256",
      ),
      planID: stringMetadata(metadata, "planID"),
      planObjective: stringMetadata(metadata, "planObjective"),
      commanderSelectedOptionID: stringMetadata(
        metadata,
        "commanderSelectedOptionID",
      ),
      commanderSelectedOptionFamily: stringMetadata(
        metadata,
        "commanderSelectedOptionFamily",
      ),
      commanderOptionSurfaceSha256: stringMetadata(
        metadata,
        "commanderOptionSurfaceSha256",
      ),
      commanderPreviousPlanID: stringMetadata(
        metadata,
        "commanderPreviousPlanID",
      ),
      commanderReplanReason: stringMetadata(metadata, "commanderReplanReason"),
      commanderPlanAgeDecisions: numberMetadata(
        metadata,
        "commanderPlanAgeDecisions",
      ),
      commanderEmergencyCondition: stringMetadata(
        metadata,
        "commanderEmergencyCondition",
      ),
      commanderPromptVersion: stringMetadata(
        metadata,
        "commanderPromptVersion",
      ),
      commanderPromptSha256: stringMetadata(metadata, "commanderPromptSha256"),
      commanderDeterministicPreferredOptionId: stringMetadata(
        metadata,
        "commanderDeterministicPreferredOptionId",
      ),
      commanderDeterministicPreferredOptionAbsent: booleanMetadata(
        metadata,
        "commanderDeterministicPreferredOptionAbsent",
      ),
      commanderFidelity: stringMetadata(metadata, "commanderFidelity"),
      batchIndex: numberMetadata(metadata, "batchIndex"),
      batchSize: numberMetadata(metadata, "batchSize"),
      batchActionIDs: stringMetadata(metadata, "batchActionIDs"),
    },
  };
}

function projectIntent(
  intent: AgentDecisionRecord["intent"],
): CommanderXpIntentEvidence | null {
  if (intent === null) return null;
  return {
    type: intent.type,
    sha256: sha256Canonical(intent),
    canonical: projectFidelityIntent(intent),
  };
}

function projectFidelityIntent(
  intent: NonNullable<AgentDecisionRecord["intent"]>,
): Record<string, string | number | boolean | null> | null {
  switch (intent.type) {
    case "attack":
      return {
        type: intent.type,
        targetID: intent.targetID,
        troops: intent.troops,
      };
    case "boat":
      return { type: intent.type, troops: intent.troops, dst: intent.dst };
    case "targetPlayer":
      return { type: intent.type, target: intent.target };
    case "embargo":
      return {
        type: intent.type,
        targetID: intent.targetID,
        action: intent.action,
      };
    case "build_unit":
      return {
        type: intent.type,
        unit: intent.unit,
        tile: intent.tile,
        ...(intent.rocketDirectionUp === undefined
          ? {}
          : { rocketDirectionUp: intent.rocketDirectionUp }),
      };
    case "upgrade_structure":
      return { type: intent.type, unit: intent.unit, unitId: intent.unitId };
    case "cancel_attack":
      return { type: intent.type, attackID: intent.attackID };
    default:
      return null;
  }
}

const fidelityActionMetadataKeys = [
  "expansion",
  "targetID",
  "navalInvasion",
  "targetTile",
  "unit",
  "role",
  "action",
  "attackID",
] as const;

function projectFidelityActionMetadata(
  metadata: AgentDecisionRecord["chosenActionMetadata"],
): Record<string, string | number | boolean | null> {
  if (metadata === undefined) return {};
  return Object.fromEntries(
    fidelityActionMetadataKeys.flatMap((key) =>
      Object.hasOwn(metadata, key) ? [[key, metadata[key]!] as const] : [],
    ),
  );
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

function numberMetadata(
  metadata: Record<string, string | number | boolean | null>,
  key: string,
): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
