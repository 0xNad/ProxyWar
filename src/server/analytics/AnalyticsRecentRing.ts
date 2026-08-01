import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AnalyticsEvent } from "./AnalyticsEventSchema";
import { normalizeAnalyticsRoute } from "./AnalyticsEventSchema";

/**
 * A small, fixed-capacity tail of recent events — purely a live "what's
 * happening right now" feed for the operator report, distinct from
 * `AnalyticsAggregateStore.ts`'s durable counts (which remain the source of
 * truth for every reported metric). Capped at `RING_CAPACITY` entries,
 * oldest dropped first; never grows.
 *
 * Contains strictly less than a single analytics event: no `visitorId`, no
 * raw context beyond a normalized route and (for `*_failed` events) the
 * bounded `reason` code — nothing here is more identifying than "someone,
 * somewhere, hit a failure on this route template."
 */

const RING_CAPACITY = 200;

const RingEntrySchema = z
  .object({
    occurredAt: z.string(),
    name: z.string(),
    route: z.string(),
    reason: z.string().optional(),
  })
  .strict();
export type AnalyticsRingEntry = z.infer<typeof RingEntrySchema>;

const RingFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(RingEntrySchema).max(RING_CAPACITY),
  })
  .strict();
type RingFile = z.infer<typeof RingFileSchema>;

function emptyFile(): RingFile {
  return { schemaVersion: 1, entries: [] };
}

export class AnalyticsRecentRing {
  private readonly filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(artifactsRootDir: string) {
    this.filePath = path.join(artifactsRootDir, "analytics-recent-ring.json");
  }

  /** Fire-and-forget from the ingest route — never throws. */
  pushEvents(events: readonly AnalyticsEvent[], receivedAt: Date = new Date()): Promise<void> {
    if (events.length === 0) {
      return Promise.resolve();
    }
    this.writeQueue = this.writeQueue
      .then(() => this.append(events, receivedAt))
      .catch(() => undefined);
    return this.writeQueue;
  }

  async readAll(): Promise<AnalyticsRingEntry[]> {
    return (await this.read()).entries;
  }

  private async append(events: readonly AnalyticsEvent[], receivedAt: Date): Promise<void> {
    const file = await this.read();
    const newEntries = events.map((event) => toRingEntry(event, receivedAt));
    const combined = [...file.entries, ...newEntries];
    file.entries = combined.slice(Math.max(0, combined.length - RING_CAPACITY));
    await this.write(file);
  }

  private async read(): Promise<RingFile> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = RingFileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : emptyFile();
    } catch {
      return emptyFile();
    }
  }

  private async write(file: RingFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, JSON.stringify(file, null, 2));
    await fs.rename(tmpPath, this.filePath);
  }
}

function toRingEntry(event: AnalyticsEvent, receivedAt: Date): AnalyticsRingEntry {
  const entry: AnalyticsRingEntry = {
    occurredAt: receivedAt.toISOString(),
    name: event.name,
    route: normalizeAnalyticsRoute(event.route),
  };
  if (event.context?.reason !== undefined) {
    entry.reason = event.context.reason;
  }
  return entry;
}
