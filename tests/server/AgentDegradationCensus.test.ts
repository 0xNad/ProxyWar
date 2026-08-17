import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  censusForDirectory,
  summarizeSeats,
} from "../../src/scripts/agent-degradation-census";

/**
 * The census exists because the league's raw `degraded_count` conflates three
 * different situations, and only one of them means "broken agent":
 *
 *   warmup       one degraded run at the start, then never again
 *   intermittent degraded decisions after a healthy one (a refresh failed and
 *                the flag stays on until the next success)
 *   dead         degraded on every decision of the match
 *
 * These are SEQUENCE SHAPES, not diagnosed causes: the telemetry carries no
 * provider latency or decision timing, and league seats run other builders'
 * policies, so the classifier says WHERE to look, never why.
 *
 * Measured on 2026-08-17's mirrored rounds these were 6,397 / 18,279 / 3,452
 * degraded decisions respectively — so reading the 29.4% total as "a third of
 * agents are broken" is wrong by an order of magnitude. These tests pin the
 * SEPARATION, because a change that quietly merges two classes would restore
 * exactly the misreading the script was built to prevent.
 */

let scratch: string | undefined;

async function writeMatches(
  matches: Record<string, { name: string; flags: boolean[] }[]>,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "degradation-census-"));
  scratch = dir;
  for (const [matchName, seats] of Object.entries(matches)) {
    const matchDir = path.join(dir, matchName);
    await fs.mkdir(matchDir, { recursive: true });
    let sequence = 0;
    const events = seats.flatMap((seat, seatIndex) =>
      seat.flags.map((degraded) => ({
        actorAgentID: `agent-${seatIndex}`,
        actorName: seat.name,
        actionKind: "attack",
        sequence: sequence++,
        llmPlannerDegraded: degraded,
      })),
    );
    await fs.writeFile(
      path.join(matchDir, "spectator-telemetry.json"),
      JSON.stringify({ events }),
    );
  }
  return dir;
}

function flags(pattern: string): boolean[] {
  // "d" = degraded, "." = healthy — keeps the fixtures readable.
  return [...pattern].map((char) => char === "d");
}

describe("agent degradation census", () => {
  afterEach(async () => {
    if (scratch !== undefined) {
      await fs.rm(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  it("separates warmup, intermittent and dead seats", async () => {
    const runsDir = await writeMatches({
      "league-coworld-2026-08-17T01-00-00-000Z-aaaa": [
        { name: "Healthy Policy", flags: flags(".............") },
        // Degraded only while the first plan is in flight, then never again.
        { name: "Warmup Policy", flags: flags("ddd..........") },
        // Recovered, then a refresh failed mid-match.
        { name: "Flaky Policy", flags: flags("dd...ddd.....") },
        { name: "Dead Policy", flags: flags("ddddddddddddd") },
      ],
    });

    const seats = await censusForDirectory({ runsDir });
    const byName = new Map(seats.map((seat) => [seat.name, seat]));
    expect(byName.get("Healthy Policy")?.seatClass).toBe("healthy");
    expect(byName.get("Warmup Policy")?.seatClass).toBe("warmup");
    expect(byName.get("Flaky Policy")?.seatClass).toBe("intermittent");
    expect(byName.get("Dead Policy")?.seatClass).toBe("dead");

    // The opening prefix is what distinguishes warmup from intermittent, so it
    // must be measured, not inferred from the count.
    expect(byName.get("Warmup Policy")?.openingPrefix).toBe(3);
    expect(byName.get("Warmup Policy")?.degraded).toBe(3);
    expect(byName.get("Flaky Policy")?.openingPrefix).toBe(2);
    expect(byName.get("Flaky Policy")?.degraded).toBe(5);
  });

  it("reports each class separately in the summary and names dead policies", async () => {
    const runsDir = await writeMatches({
      "league-coworld-2026-08-17T01-00-00-000Z-aaaa": [
        { name: "Dead Policy", flags: flags("dddddddddddd") },
        { name: "Warmup Policy", flags: flags("dd..........") },
      ],
      "league-coworld-2026-08-17T02-00-00-000Z-bbbb": [
        { name: "Dead Policy", flags: flags("dddddddddddd") },
        { name: "Healthy Policy", flags: flags("............") },
      ],
    });

    const summary = summarizeSeats(await censusForDirectory({ runsDir }));
    expect(summary.matches).toBe(2);
    expect(summary.seats).toBe(4);

    const rows = new Map(summary.byClass.map((row) => [row.seatClass, row]));
    expect(rows.get("dead")?.seats).toBe(2);
    expect(rows.get("dead")?.degradedDecisions).toBe(24);
    expect(rows.get("warmup")?.seats).toBe(1);
    expect(rows.get("warmup")?.degradedDecisions).toBe(2);
    expect(rows.get("healthy")?.degradedDecisions).toBe(0);

    // A policy that is dead across several matches is the actionable signal.
    expect(summary.deadByPolicy[0]).toEqual({
      name: "Dead Policy",
      matches: 2,
    });
  });

  it("counts only real decisions and ignores short seats", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "degradation-census-"));
    scratch = dir;
    const matchDir = path.join(
      dir,
      "league-coworld-2026-08-17T03-00-00-000Z-cccc",
    );
    await fs.mkdir(matchDir, { recursive: true });
    await fs.writeFile(
      path.join(matchDir, "spectator-telemetry.json"),
      JSON.stringify({
        events: [
          // Synthetic events carry no actionKind; counting them would dilute
          // the rate with rows no agent ever decided.
          {
            actorAgentID: "agent-0",
            actorName: "Short Policy",
            sequence: 0,
            llmPlannerDegraded: true,
          },
          ...Array.from({ length: 5 }, (_, index) => ({
            actorAgentID: "agent-0",
            actorName: "Short Policy",
            actionKind: "attack",
            sequence: index + 1,
            llmPlannerDegraded: true,
          })),
        ],
      }),
    );

    // Five decisions is below the floor: too short to tell warmup from dead.
    expect(await censusForDirectory({ runsDir: dir })).toHaveLength(0);
    // With the floor lowered the seat appears, and the non-decision event is
    // still excluded — 5 decisions, not 6.
    const seats = await censusForDirectory({ runsDir: dir, minDecisions: 1 });
    expect(seats).toHaveLength(1);
    expect(seats[0].decisions).toBe(5);
  });

  it("accepts a bare telemetry array and skips matches without telemetry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "degradation-census-"));
    scratch = dir;
    const bare = path.join(dir, "league-coworld-2026-08-17T04-00-00-000Z-dddd");
    await fs.mkdir(bare, { recursive: true });
    await fs.writeFile(
      path.join(bare, "spectator-telemetry.json"),
      JSON.stringify(
        Array.from({ length: 12 }, (_, index) => ({
          actorAgentID: "agent-0",
          actorName: "Bare Array Policy",
          actionKind: "attack",
          sequence: index,
          llmPlannerDegraded: false,
        })),
      ),
    );
    // A mirrored match whose telemetry never landed must be skipped, never
    // counted as a healthy seat.
    await fs.mkdir(
      path.join(dir, "league-coworld-2026-08-17T05-00-00-000Z-eeee"),
      { recursive: true },
    );

    const seats = await censusForDirectory({ runsDir: dir });
    expect(seats).toHaveLength(1);
    expect(seats[0].name).toBe("Bare Array Policy");
    expect(seats[0].seatClass).toBe("healthy");
  });
});
