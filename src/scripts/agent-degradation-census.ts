/**
 * Degradation census over mirrored league matches.
 *
 * WHY THIS EXISTS: the league's headline `degraded_count` conflates three
 * situations that demand different responses, so the raw percentage is
 * unactionable on its own. Measured on 2026-08-17's mirrored rounds, 28,128 of
 * 95,694 decisions (29.4%) were flagged `llmPlannerDegraded`, and that split
 * into:
 *
 *   - WARMUP      every degraded decision sits in one run starting at the seat's
 *                 first decision, and the seat never degrades again. The public
 *                 starter reports `llmPlannerDegraded: true` whenever
 *                 `plan === null`, which includes its own honest
 *                 "BOOTSTRAP RULE (first plan in flight)" state, so this SHAPE
 *                 is consistent with a seat waiting for its first plan.
 *                 SHAPE ONLY: telemetry carries no per-seat provider latency or
 *                 decision timing (and `emitPlannerUsage` deliberately omits
 *                 the prompt), and league seats run other builders' policies
 *                 and providers, so this classifier does NOT establish that a
 *                 warmup run was caused by plan latency. A seat that failed
 *                 from decision one and recovered later has the same shape.
 *   - INTERMITTENT a refresh failed mid-match. The flag then stays on for every
 *                 decision until the next successful refresh (deliberate — see
 *                 AgentPlannerExecutor's note about previously under-reporting
 *                 ~5:1), so ONE failure inflates the decision count by roughly
 *                 the plan cadence. This class dominates the raw number.
 *   - DEAD        degraded on every single decision: a seat that never had a
 *                 working brain for the whole match. This is the only class
 *                 that means "broken agent", and it concentrates in a handful
 *                 of builder policies.
 *
 * Read the classes, never the total. A rising total with a flat DEAD count is a
 * cadence/quota story; a rising DEAD count is a broken-policy story. In both
 * cases the classes are SEQUENCE SHAPES, not diagnosed causes: use them to
 * decide where to look, then read that seat's own logs (own-account episodes
 * only — league episodes are 403).
 *
 * Input: `spectator-telemetry.json` from mirrored league match directories
 * (`artifacts/ai-league-runs/league-coworld-*`), which carry the per-decision
 * `llmPlannerDegraded` flag. Per-decision `decisions.jsonl` is NOT available
 * for other builders' league episodes — `coworld episode-logs` returns 403 —
 * so telemetry is the only league-wide per-decision source this account has.
 *
 * Usage:
 *   node --import tsx/esm src/scripts/agent-degradation-census.ts [--since=YYYY-MM-DD]
 *     [--runs-dir=artifacts/ai-league-runs] [--min-decisions=10] [--json]
 */
import fs from "node:fs/promises";
import path from "node:path";

/** Seats with fewer decisions than this are excluded: a two-decision seat
 * cannot distinguish warmup from a dead brain. */
const DEFAULT_MIN_DECISIONS = 10;

interface TelemetryEvent {
  actorAgentID?: string;
  actorName?: string;
  actionKind?: string;
  sequence?: number;
  llmPlannerDegraded?: boolean;
}

type SeatClass = "healthy" | "warmup" | "intermittent" | "dead";

interface SeatCensus {
  match: string;
  agentID: string;
  name: string;
  decisions: number;
  degraded: number;
  /** Length of the contiguous degraded run starting at the seat's first decision. */
  openingPrefix: number;
  seatClass: SeatClass;
}

function classify(input: {
  decisions: number;
  degraded: number;
  openingPrefix: number;
}): SeatClass {
  if (input.degraded === 0) return "healthy";
  if (input.degraded === input.decisions) return "dead";
  // Every degraded decision sits in the opening run: the plan arrived and the
  // seat never degraded again.
  if (input.degraded === input.openingPrefix) return "warmup";
  return "intermittent";
}

function argValue(flag: string): string | undefined {
  return process.argv
    .find((arg) => arg.startsWith(`--${flag}=`))
    ?.slice(flag.length + 3);
}

export async function censusForDirectory(input: {
  runsDir: string;
  since?: string;
  minDecisions?: number;
}): Promise<SeatCensus[]> {
  const minDecisions = input.minDecisions ?? DEFAULT_MIN_DECISIONS;
  const entries = await fs.readdir(input.runsDir, { withFileTypes: true });
  const matchDirs = entries
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith("league-coworld-"),
    )
    .map((entry) => entry.name)
    // Directory names embed the mirror timestamp, so a lexical compare is a
    // date filter — no stat calls, and it survives copied artifacts.
    .filter((name) =>
      input.since === undefined
        ? true
        : name.slice("league-coworld-".length) >= input.since,
    )
    .sort();

  const seats: SeatCensus[] = [];
  for (const dir of matchDirs) {
    const file = path.join(input.runsDir, dir, "spectator-telemetry.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      // A match without telemetry is skipped, never counted as healthy.
      continue;
    }
    // Telemetry ships either as a bare array or wrapped in `{ events }`.
    // Narrow instead of asserting: this is parsed external JSON, so an
    // unchecked cast would trust a shape nothing verified.
    let events: TelemetryEvent[] = [];
    if (Array.isArray(parsed)) {
      events = parsed;
    } else if (
      parsed !== null &&
      typeof parsed === "object" &&
      "events" in parsed
    ) {
      const wrapped = parsed.events;
      if (Array.isArray(wrapped)) events = wrapped;
    }

    const bySeat = new Map<string, TelemetryEvent[]>();
    for (const event of events) {
      // Only real decisions carry an action kind; synthetic eliminations and
      // derived economy events would otherwise dilute the rate.
      if (
        event.actorAgentID === undefined ||
        event.actionKind === undefined ||
        event.actionKind === ""
      ) {
        continue;
      }
      const bucket = bySeat.get(event.actorAgentID) ?? [];
      bucket.push(event);
      bySeat.set(event.actorAgentID, bucket);
    }

    for (const [agentID, seatEvents] of bySeat) {
      seatEvents.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      const flags = seatEvents.map(
        (event) => event.llmPlannerDegraded === true,
      );
      if (flags.length < minDecisions) continue;
      let openingPrefix = 0;
      while (openingPrefix < flags.length && flags[openingPrefix]) {
        openingPrefix += 1;
      }
      const degraded = flags.filter(Boolean).length;
      seats.push({
        match: dir,
        agentID,
        name: seatEvents[0].actorName ?? agentID,
        decisions: flags.length,
        degraded,
        openingPrefix,
        seatClass: classify({
          decisions: flags.length,
          degraded,
          openingPrefix,
        }),
      });
    }
  }
  return seats;
}

export interface DegradationClassRow {
  seatClass: SeatClass;
  seats: number;
  decisions: number;
  degradedDecisions: number;
  /** Median length of the opening degraded run for seats in this class. */
  medianOpeningPrefix: number;
}

export interface DegradationSummary {
  matches: number;
  seats: number;
  decisions: number;
  degraded: number;
  degradedShare: number;
  byClass: DegradationClassRow[];
  /** Policies that played an entire match degraded, by match count. */
  deadByPolicy: Array<{ name: string; matches: number }>;
}

function summarize(seats: readonly SeatCensus[]): DegradationSummary {
  const classes: SeatClass[] = ["healthy", "warmup", "intermittent", "dead"];
  const decisions = seats.reduce((sum, seat) => sum + seat.decisions, 0);
  const degraded = seats.reduce((sum, seat) => sum + seat.degraded, 0);
  const byClass: DegradationClassRow[] = classes.map((seatClass) => {
    const rows = seats.filter((seat) => seat.seatClass === seatClass);
    const prefixes = rows
      .map((seat) => seat.openingPrefix)
      .sort((a, b) => a - b);
    return {
      seatClass,
      seats: rows.length,
      decisions: rows.reduce((sum, seat) => sum + seat.decisions, 0),
      degradedDecisions: rows.reduce((sum, seat) => sum + seat.degraded, 0),
      medianOpeningPrefix:
        prefixes.length === 0 ? 0 : prefixes[Math.floor(prefixes.length / 2)],
    };
  });
  const deadByPolicy = new Map<string, number>();
  for (const seat of seats) {
    if (seat.seatClass !== "dead") continue;
    deadByPolicy.set(seat.name, (deadByPolicy.get(seat.name) ?? 0) + 1);
  }
  return {
    matches: new Set(seats.map((seat) => seat.match)).size,
    seats: seats.length,
    decisions,
    degraded,
    degradedShare: decisions === 0 ? 0 : degraded / decisions,
    byClass,
    deadByPolicy: [...deadByPolicy.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, matches]) => ({ name, matches })),
  };
}

export function summarizeSeats(
  seats: readonly SeatCensus[],
): DegradationSummary {
  return summarize(seats);
}

async function main(): Promise<void> {
  const runsDir = path.resolve(
    process.cwd(),
    argValue("runs-dir") ?? "artifacts/ai-league-runs",
  );
  const minDecisionsRaw = argValue("min-decisions");
  const seats = await censusForDirectory({
    runsDir,
    since: argValue("since"),
    minDecisions:
      minDecisionsRaw === undefined
        ? undefined
        : Number.parseInt(minDecisionsRaw, 10),
  });
  const summary = summarize(seats);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ summary, seats }, null, 2));
    return;
  }

  console.log(
    `matches ${summary.matches} · seats ${summary.seats} · decisions ${summary.decisions.toLocaleString()} · degraded ${summary.degraded.toLocaleString()} (${(summary.degradedShare * 100).toFixed(1)}%)`,
  );
  console.log("");
  console.log(
    "class         seats  decisions  degraded  median opening prefix",
  );
  for (const row of summary.byClass) {
    console.log(
      `${row.seatClass.padEnd(13)}${String(row.seats).padStart(5)}  ${String(row.decisions).padStart(9)}  ${String(row.degradedDecisions).padStart(8)}  ${String(row.medianOpeningPrefix).padStart(20)}`,
    );
  }
  if (summary.deadByPolicy.length > 0) {
    console.log("");
    console.log("policies degraded for a WHOLE match (matches each):");
    for (const row of summary.deadByPolicy) {
      console.log(`  ${String(row.matches).padStart(3)}x  ${row.name}`);
    }
  }
}

if (
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("agent-degradation-census.ts")
) {
  await main();
}
