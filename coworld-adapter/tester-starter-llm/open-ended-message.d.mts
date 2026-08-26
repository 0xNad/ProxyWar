export interface OpenEndedMessageIntent {
  actionID: string;
  recipientID: string;
  purpose: "reply" | "deal_proposal" | "border_opener";
  maxChars: number;
  commit?: () => void;
}

export function chooseOpenEndedMessageIntent(
  actions: unknown[],
  observation: Record<string, unknown>,
  answered: Set<string>,
  dealMove: unknown,
  maxChars?: number,
): OpenEndedMessageIntent | null;

export function buildOpenEndedMessagePrompt(input: {
  intent: OpenEndedMessageIntent;
  observation: Record<string, unknown>;
  gameplayKind?: string | null;
  dealKind?: string | null;
}): string;

export function parseOpenEndedMessageResponse(
  raw: string,
  maxChars: number,
): string;
