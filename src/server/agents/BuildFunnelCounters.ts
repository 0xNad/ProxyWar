import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * Silent step-progression counters for `/build` — spec Stage 7 item 4 ("keep
 * the funnel instrumentation silent, per STANDING-POSITION: collect, don't
 * gate"). Aggregate-only: a per-day count of how many times each of the
 * seven steps was reached, no session id, no IP, no user agent, no request
 * body beyond the step number itself. Nothing here ever blocks, delays, or
 * changes what a visitor sees — every call site fires-and-forgets this and
 * ignores the result. Not exposed on any public read route; a future
 * operator dashboard can read the file directly.
 */

const StepSchema = z.number().int().min(1).max(7);

const CountersFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** `{ "2026-07-31": { "1": 12, "2": 9, ... } }` — UTC calendar day. */
    byDay: z.record(z.string(), z.record(z.string(), z.number().int().min(0))),
  })
  .strict();
type CountersFile = z.infer<typeof CountersFileSchema>;

function emptyFile(): CountersFile {
  return { schemaVersion: 1, byDay: {} };
}

function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class BuildFunnelCounters {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(artifactsRootDir: string) {
    this.filePath = path.join(artifactsRootDir, "build-funnel-counts.json");
  }

  /** Fire-and-forget from every call site — never throws, never awaited for correctness. */
  recordStepReached(step: number, now: Date = new Date()): Promise<void> {
    const parsedStep = StepSchema.safeParse(step);
    if (!parsedStep.success) {
      return Promise.resolve();
    }
    this.writeQueue = this.writeQueue
      .then(() => this.increment(parsedStep.data, now))
      .catch(() => undefined);
    return this.writeQueue;
  }

  private async increment(step: number, now: Date): Promise<void> {
    const file = await this.read();
    const dayKey = utcDayKey(now);
    const day = { ...(file.byDay[dayKey] ?? {}) };
    const stepKey = String(step);
    day[stepKey] = (day[stepKey] ?? 0) + 1;
    file.byDay[dayKey] = day;
    await this.write(file);
  }

  private async read(): Promise<CountersFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = CountersFileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : emptyFile();
    } catch {
      return emptyFile();
    }
  }

  private async write(file: CountersFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, JSON.stringify(file, null, 2));
    await fs.rename(tmpPath, this.filePath);
  }
}
