export interface MitoLlmPreparation {
  mode: "spawn" | "llm";
  selectedLegalActionId?: string;
  spawnPreferenceLegalActionIds?: string[];
  allowedLegalActionIds?: string[];
  primaryOverrideActionId?: string;
  selectedDealActionId?: string;
  selectedMessageActionId?: string;
  messageText?: string;
  reason: string;
}

export function createMitochondriaFriendLlmPolicy(): (
  input?: Record<string, unknown>,
) => MitoLlmPreparation;

export function createMitochondriaFriendPolicy(): (
  input?: Record<string, unknown>,
) => Record<string, unknown>;

export const MITOCHONDRIA_FRIEND_MESSAGES: Readonly<Record<string, string>>;
