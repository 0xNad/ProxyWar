import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  asPlayerReportedDegradationCause,
  isSelfReportedDegradationCause,
  type AgentDegradationCause,
} from "../../src/server/agents/AgentWireProtocol";

/**
 * The starter is the ONLY place that can tell warmup from a dead planner.
 *
 * Four states have always been visible inside `llm-player.mjs` and nowhere else,
 * because the wire carried a single boolean: a seat playing rule logic while its
 * first plan is still in flight looked exactly like a seat whose planner had
 * failed. That collapse is most of why a third of league decisions cannot be
 * attributed to anything — and it is the ambiguity the operator question about
 * "should warmup count as degradation" has been stuck on.
 *
 * Extracted from source rather than imported, the convention this suite already
 * uses for the starter: the file ends in a live socket handler, so it cannot be
 * imported by a test.
 */
const STARTER_FILE = path.join(
  "coworld-adapter",
  "tester-starter-llm",
  "llm-player.mjs",
);

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} missing`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

type CauseFor = (
  plan: unknown,
  degraded: boolean,
  lastPlanError: string | null,
) => string | null;

async function loadCauseFor(): Promise<CauseFor> {
  const source = await fs.readFile(STARTER_FILE, "utf8");
  return new Function(
    `${extractFunction(source, "degradedCauseFor")}\nreturn degradedCauseFor;`,
  )() as CauseFor;
}

const PLAN = { focus: "expand", target: null, model: "m", reason: "r" };

describe("starter degraded-cause reporting", () => {
  it("separates benign warmup from a planner that actually failed", async () => {
    const causeFor = await loadCauseFor();
    // The distinction the whole field exists for. Both of these send
    // llmPlannerDegraded: true today, and today they are indistinguishable.
    expect(causeFor(null, false, null)).toBe("plan-warmup");
    expect(causeFor(null, true, "bedrock 500")).toBe("plan-unavailable");
  });

  it("reports acting on stale intent distinctly from having none", async () => {
    const causeFor = await loadCauseFor();
    expect(causeFor(PLAN, true, "bedrock 500")).toBe("plan-stale");
    expect(causeFor(null, true, "bedrock 500")).toBe("plan-unavailable");
  });

  it("reports a provider timeout from its own timeout marker, not by parsing text", async () => {
    const causeFor = await loadCauseFor();
    // `withTimeout` rejects with exactly `new Error("timeout")`, so this needs no
    // text sniffing. Timeout wins over the has-a-plan split: both are real
    // breakage, and the provider behaviour is the actionable half.
    expect(causeFor(null, true, "timeout")).toBe("plan-timeout");
    expect(causeFor(PLAN, true, "timeout")).toBe("plan-timeout");
    // A message that merely CONTAINS the word must not be read as a timeout.
    expect(causeFor(PLAN, true, "request timeout budget exceeded")).toBe(
      "plan-stale",
    );
  });

  it("says nothing on a healthy decision", async () => {
    const causeFor = await loadCauseFor();
    expect(causeFor(PLAN, false, null)).toBeNull();
  });

  it("only ever emits causes the wire will accept from a player", async () => {
    const causeFor = await loadCauseFor();
    const emitted = [
      causeFor(null, false, null),
      causeFor(null, true, "err"),
      causeFor(PLAN, true, "err"),
      causeFor(PLAN, true, "timeout"),
      causeFor(null, true, "timeout"),
    ].filter((cause): cause is string => cause !== null);
    expect(emitted.length).toBe(5);
    for (const cause of emitted) {
      // Round-trips through the real ingest parser: a starter cause that the
      // canonical vocabulary rejects would be silently dropped in production.
      expect(
        asPlayerReportedDegradationCause(cause),
        `starter emits ${cause}, which the wire rejects`,
      ).toBe(cause);
      expect(
        isSelfReportedDegradationCause(cause as AgentDegradationCause),
      ).toBe(true);
    }
  });

  it("names the cause in EVERY frame that reports degradation", async () => {
    // Guards the defect this feature already hit once in keystone: a cause that is
    // computed and then never named in the outgoing frame ships nothing at all.
    //
    // Asserted as an invariant over every `decision_response` the starter sends,
    // not against one hardcoded frame, so a future response path cannot quietly
    // report a degradation with no cause. The starter has two frames today and only
    // one of them degrades: the sealed spawn ballot carries no flags, by design —
    // it is a pre-game allocation, not a gameplay decision.
    const source = await fs.readFile(STARTER_FILE, "utf8");
    const frames = [...source.matchAll(/type: "decision_response"/g)].map(
      (match) => source.slice(match.index ?? 0, (match.index ?? 0) + 2_000),
    );
    expect(frames.length).toBeGreaterThan(0);
    const degradingFrames = frames.filter((frame) =>
      frame.includes("llmPlannerDegraded"),
    );
    expect(
      degradingFrames.length,
      "no starter frame reports degradation — the flag moved and this test is stale",
    ).toBeGreaterThan(0);
    for (const frame of degradingFrames) {
      expect(frame).toContain("degradedCause");
    }
  });
});
