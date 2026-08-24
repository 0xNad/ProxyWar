export const COMMANDER_XP_FINALIZATION_TIMEOUT_MS = 120_000;

export type CommanderXpFinalizationAck = {
  type: "finalization_ack";
  status: "succeeded";
};

export function commanderXpFinalizationAck(): CommanderXpFinalizationAck {
  return { type: "finalization_ack", status: "succeeded" };
}

export function isCommanderXpFinalizationAck(
  value: unknown,
): value is CommanderXpFinalizationAck {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "status,type" &&
    record.type === "finalization_ack" &&
    record.status === "succeeded"
  );
}

/**
 * Server-owned barrier for the Commander XP terminal handshake. An episode is
 * not allowed to finish merely because the game result exists: every policy
 * pod must first acknowledge that its queued provider work and artifact upload
 * have settled. A disconnect before acknowledgement is fatal.
 */
export class CommanderXpFinalizationBarrier {
  private readonly pending: Set<number>;
  private readonly promise: Promise<void>;
  private readonly timeout: NodeJS.Timeout;
  private resolve!: () => void;
  private reject!: (error: Error) => void;
  private settled = false;

  constructor(
    slots: readonly number[],
    timeoutMs = COMMANDER_XP_FINALIZATION_TIMEOUT_MS,
  ) {
    if (
      slots.length === 0 ||
      slots.some((slot) => !Number.isInteger(slot) || slot < 0) ||
      new Set(slots).size !== slots.length ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1
    ) {
      throw new Error("Commander XP finalization barrier input is invalid");
    }
    this.pending = new Set(slots);
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.timeout = setTimeout(() => {
      this.fail(
        new Error(
          `Commander XP finalization timed out; pending slots=${[
            ...this.pending,
          ].join(",")}`,
        ),
      );
    }, timeoutMs);
  }

  wait(): Promise<void> {
    return this.promise;
  }

  acknowledge(slot: number, message: unknown): void {
    if (!isCommanderXpFinalizationAck(message) || !this.pending.has(slot)) {
      this.fail(
        new Error("Commander XP finalization acknowledgement is invalid"),
      );
      return;
    }
    this.pending.delete(slot);
    if (this.pending.size === 0) {
      this.settled = true;
      clearTimeout(this.timeout);
      this.resolve();
    }
  }

  disconnected(slot: number): void {
    if (this.pending.has(slot)) {
      this.fail(
        new Error(
          `Commander XP player slot ${slot} disconnected before finalization`,
        ),
      );
    }
  }

  fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timeout);
    this.reject(error);
  }
}

/**
 * Player-side ordering primitive. The acknowledgement is emitted only after
 * every queued decision/provider operation and the artifact upload complete.
 */
export async function finalizeCommanderXpPlayer(input: {
  drain: () => Promise<void>;
  upload: () => Promise<void>;
  acknowledge: (message: CommanderXpFinalizationAck) => void;
}): Promise<void> {
  await input.drain();
  await input.upload();
  input.acknowledge(commanderXpFinalizationAck());
}
