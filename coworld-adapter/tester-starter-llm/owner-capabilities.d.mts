export const OWNER_MESSAGE_MAX_CHARS: 280;
export const OWNER_SPATIAL_SERIALIZED_MAX_BYTES: number;
export const OWNER_MINIMAP_SERIALIZED_MAX_BYTES: number;
export const OWNER_EVIDENCE_SUPPORTED_MAX_DECISION_STEPS: 600;
export const OWNER_EVIDENCE_MAX_INBOUND_MESSAGES_PER_STEP: 8;
export type OwnerEvidenceKind =
  | "deal_selection"
  | "message_selection"
  | "message_observation"
  | "spatial_observation";
export const OWNER_EVIDENCE_MAX_EVENTS_BY_KIND: Readonly<
  Record<OwnerEvidenceKind, number>
>;
export const OWNER_EVIDENCE_SATURATION_KIND: "evidence_saturation";
export const SPATIAL_VISIBILITY_MODEL: "global-lockstep-public-map-v1";

export interface OwnerLegalAction {
  id: string;
  kind: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OwnerCapabilityEvidenceInput {
  requestID?: unknown;
  slot?: unknown;
  actions?: unknown;
  observation?: unknown;
  response?: unknown;
  spawn?: boolean;
}

export function advertisedMessageLimit(protocol: unknown): number | null;
export function isSafeAgentMessageText(
  text: unknown,
  maxChars: unknown,
): boolean;
export function boundedDealsObservation(
  deals: unknown,
  ownPlayerID: unknown,
): Record<string, unknown> | null;
export function boundedInboundMessages(
  observation: unknown,
): Array<Record<string, unknown>> | null;
export function ownerCapabilityObservation(
  input: unknown,
): Record<string, unknown>;
export function createOwnerCapabilityEvidenceLogger(options?: {
  emit?: (line: string) => void;
  maxEventsByKind?: Readonly<Record<OwnerEvidenceKind, number>>;
}): (input: OwnerCapabilityEvidenceInput) => void;
export function exactOfferedAction(
  actions: unknown,
  id: unknown,
  allowedKinds?: Set<string>,
): OwnerLegalAction | null;
export function dealResponseFields(input: {
  actions: unknown;
  observation: unknown;
  dealMove: unknown;
}): { selectedDealActionId?: string };
export function messageResponseFields(input: {
  actions: unknown;
  protocol: unknown;
  messageMove: unknown;
}): { selectedMessageActionId?: string; messageText?: string };
export function isWithinOwnerSpatialSerializationCeiling(
  value: unknown,
): boolean;
export function boundedSpatialMapInfo(
  mapInfo: unknown,
): Record<string, unknown> | null;
export function boundedSpatialV1(
  observation: unknown,
): Record<string, unknown> | null;
export function boundedSpatialV3(
  observation: unknown,
): Record<string, unknown> | null;
export function boundedSpatialV5(
  observation: unknown,
): Record<string, unknown> | null;
export function boundedSpatialObservation(
  observation: unknown,
): Record<string, unknown> | null;
export function rankOfferedActionsWithSpatial<T>(
  actions: T[],
  observation: unknown,
): T[];
