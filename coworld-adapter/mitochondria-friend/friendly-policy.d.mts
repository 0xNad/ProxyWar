export interface MitoLlmPreparation {
  mode: "spawn" | "llm";
  selectedLegalActionId?: string;
  spawnPreferenceLegalActionIds?: string[];
  allowedLegalActionIds?: string[];
  primaryOverrideActionId?: string;
  selectedDealActionId?: string;
  messageIntent?: {
    actionID: string;
    recipientID: string;
    purpose:
      | "reply"
      | "border_opener"
      | "diplomatic_opener"
      | "deal_proposal"
      | "relationship_follow_up";
    maxChars: number;
    inboundMessageEventID?: string;
    commit?: () => void;
  };
  reason: string;
}

export function createMitochondriaFriendLlmPolicy(): (
  input?: Record<string, unknown>,
) => MitoLlmPreparation;

export function createMitochondriaFriendPolicy(): (
  input?: Record<string, unknown>,
) => Record<string, unknown>;

export const MITOCHONDRIA_FRIEND_MESSAGES: Readonly<Record<string, string>>;
