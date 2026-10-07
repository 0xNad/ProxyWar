import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const snapshotSchema = z.object({
  protocol: z.literal("append-v1"),
  namespace: z.string(),
  policies: z.record(
    digest,
    z.object({ summary: z.string(), notes: z.array(z.string()) }),
  ),
  seat_policy_hashes: z.array(digest.nullable()),
});
export const SCRATCHPAD_NOTE_BYTES = 16384;
export const SCRATCHPAD_PHASE_MS = 30000;
type Snapshot = z.infer<typeof snapshotSchema>;
type Send = (slot: number, message: Record<string, unknown>) => void;

/** Private state: never attach this object to results, replay, or game logs. */
export class CoworldScratchpads {
  private pending = new Map<
    number,
    { id: string; phase: "read" | "write"; finish: () => void }
  >();
  private notes = new Map<number, string>();

  constructor(
    private snapshot: Snapshot,
    private outputPath: string,
  ) {
    for (const hash of snapshot.seat_policy_hashes) {
      if (hash !== null && !Object.hasOwn(snapshot.policies, hash)) {
        throw new Error("Scratchpad seat mapping references an absent policy");
      }
    }
  }

  static async load(
    seatCount: number,
    env = process.env,
  ): Promise<CoworldScratchpads | null> {
    const input = env.COGAME_MEMORY_INPUT_URI;
    const output = env.COGAME_MEMORY_OUTPUT_URI;
    if (!input && !output) return null;
    if (!input || !output)
      throw new Error("Both scratchpad paths are required");
    // The platform stages private local files; never fetch a policy-supplied URL.
    const snapshot = snapshotSchema.parse(
      JSON.parse(await fs.readFile(fileURLToPath(input), "utf8")),
    );
    if (snapshot.seat_policy_hashes.length !== seatCount) {
      throw new Error("Scratchpad seat mapping does not match episode seats");
    }
    return new CoworldScratchpads(snapshot, fileURLToPath(output));
  }

  async runPhase(
    phase: "read" | "write",
    send: Send,
    result?: unknown,
    timeoutMs = SCRATCHPAD_PHASE_MS,
  ): Promise<void> {
    await Promise.all(
      this.snapshot.seat_policy_hashes.map((hash, slot) => {
        if (hash === null) return Promise.resolve();
        return new Promise<void>((resolve) => {
          const id = randomUUID();
          const finish = () => {
            clearTimeout(timer);
            this.pending.delete(slot);
            resolve();
          };
          const timer = setTimeout(finish, timeoutMs);
          this.pending.set(slot, { id, phase, finish });
          const copies = this.snapshot.seat_policy_hashes.filter(
            (value) => value === hash,
          ).length;
          send(slot, {
            type: "scratchpad_request",
            requestID: id,
            phase,
            deadline: new Date(Date.now() + timeoutMs).toISOString(),
            // Split a repeated policy's single platform allowance deterministically.
            maxNoteBytes: Math.floor(
              (SCRATCHPAD_NOTE_BYTES - copies + 1) / copies,
            ),
            ...(phase === "read"
              ? { scratchpad: this.snapshot.policies[hash] }
              : { result }),
          });
        });
      }),
    );
  }

  respond(slot: number, message: Record<string, unknown>): void {
    const pending = this.pending.get(slot);
    if (!pending || message.requestID !== pending.id) return;
    if (pending.phase === "write" && typeof message.note === "string") {
      const hash = this.snapshot.seat_policy_hashes[slot];
      const copies = this.snapshot.seat_policy_hashes.filter(
        (value) => value === hash,
      ).length;
      if (
        Buffer.byteLength(message.note, "utf8") >
        Math.floor((SCRATCHPAD_NOTE_BYTES - copies + 1) / copies)
      )
        return;
      this.notes.set(slot, message.note);
    }
    pending.finish();
  }

  async save(): Promise<void> {
    const notes: Record<string, string> = {};
    for (const [slot, note] of [...this.notes].sort(([a], [b]) => a - b)) {
      const hash = this.snapshot.seat_policy_hashes[slot]!;
      notes[hash] = Object.hasOwn(notes, hash)
        ? `${notes[hash]}\n${note}`
        : note;
    }
    await fs.writeFile(
      this.outputPath,
      JSON.stringify({ protocol: "append-v1", notes }),
      { mode: 0o600 },
    );
  }
}
