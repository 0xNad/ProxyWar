import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DECISIVE_MOMENTS_SCHEMA_VERSION } from "../../src/server/agents/AgentDecisiveMoments";
import type { AgentMatchRecap } from "../../src/server/agents/AgentMatchRecap";
import { generateMatchNarrativeArtifactsForRunDir } from "../../src/server/agents/CoworldLeagueMatchNarrativeBackfill";
import { generateMatchStateSeriesForRunDir } from "../../src/server/agents/CoworldLeagueMatchStateSeriesBackfill";

/**
 * End-to-end mirror-side integration: `match-state-series.json` generated
 * first (`CoworldLeagueMatchStateSeriesBackfill.ts`, matching the ordering
 * dependency documented there), then `match-recap.json` regenerated
 * (`CoworldLeagueMatchNarrativeBackfill.ts`) picks it up and produces real
 * `lead_change`/`reversal` beats — the actual Season Zero Phase 2 gap
 * closure this session exists to deliver, verified against a REAL retained
 * hosted-league run (`league-coworld-2026-08-01T13-58-25-067Z-962f5eac`,
 * 12 agents): its real series independently computes to exactly 1
 * confirmed lead change and 10 major reversals (see
 * `AgentMatchStateDerivations.test.ts`'s sibling coverage for the pure
 * derivation math; this test only asserts the beats REACH the recap
 * artifact through the full backfill pipeline).
 */

const realReplayFixtureRaw = readFileSync(
  path.join(
    __dirname,
    "fixtures",
    "coworld-mirror-match-state-series-replay.sample.json",
  ),
  "utf8",
);
const realTelemetryFixtureRaw = readFileSync(
  path.join(
    __dirname,
    "fixtures",
    "coworld-mirror-match-state-series-telemetry.sample.json",
  ),
  "utf8",
);

let root: string;
let runDir: string;

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(
      path.join(os.tmpdir(), "pw-narrative-series-integration-"),
    ),
  );
  runDir = path.join(root, "league-coworld-integration-1");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, "spectator-replay.json"),
    realReplayFixtureRaw,
  );
  await fs.writeFile(
    path.join(runDir, "spectator-telemetry.json"),
    realTelemetryFixtureRaw,
  );
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("a recap generated after the series backfill has run carries real lead_change/reversal beats", async () => {
  const seriesResult = await generateMatchStateSeriesForRunDir(
    runDir,
    "league-coworld-integration-1",
  );
  expect(seriesResult.outcome.status).toBe("generated");

  const narrativeResult = await generateMatchNarrativeArtifactsForRunDir(
    runDir,
    "league-coworld-integration-1",
  );
  expect(narrativeResult.outcome.status).toBe("generated-recap-only");

  const recap = JSON.parse(
    await fs.readFile(path.join(runDir, "match-recap.json"), "utf8"),
  ) as AgentMatchRecap;
  const kinds = new Set(recap.beats.map((beat) => beat.kind));
  expect(kinds.has("lead_change") || kinds.has("reversal")).toBe(true);
});

test("without the series backfill having run first, the recap is generated with zero lead_change/reversal beats (honest degradation, not a failure)", async () => {
  const narrativeResult = await generateMatchNarrativeArtifactsForRunDir(
    runDir,
    "league-coworld-integration-1",
  );
  expect(narrativeResult.outcome.status).toBe("generated-recap-only");
  const recap = JSON.parse(
    await fs.readFile(path.join(runDir, "match-recap.json"), "utf8"),
  ) as AgentMatchRecap;
  const kinds = new Set(recap.beats.map((beat) => beat.kind));
  expect(kinds.has("lead_change")).toBe(false);
  expect(kinds.has("reversal")).toBe(false);
});

test("P0 regression: a pre-existing decisive-moments.json on the OLD schema (carrying a raw upstream error as statedReason) is regenerated and sanitized on the next backfill pass", async () => {
  const seriesResult = await generateMatchStateSeriesForRunDir(
    runDir,
    "league-coworld-integration-1",
  );
  expect(seriesResult.outcome.status).toBe("generated");

  // A real decisions.jsonl fixture (records are parsed independently of
  // the telemetry roster — see `resolveMirroredMatchEvidence`) so the
  // first pass writes `drama-report.json` too, putting the SECOND pass on
  // the gated `recapNeedsRegeneration`/`decisiveMomentsNeedGeneration`
  // branch this test exists to exercise, rather than the from-scratch
  // path every call takes while `drama-report.json` is still absent.
  await fs.writeFile(
    path.join(runDir, "decisions.jsonl"),
    readFileSync(
      path.join(
        __dirname,
        "fixtures",
        "coworld-mirror-director-cut-decisions.sample.jsonl",
      ),
      "utf8",
    ),
  );

  // First pass: normal generation produces a current-schema recap AND
  // decisive-moments.json (plus drama-report.json/match-story.json, now
  // that decisions.jsonl is present).
  const first = await generateMatchNarrativeArtifactsForRunDir(
    runDir,
    "league-coworld-integration-1",
  );
  expect(first.outcome.status).toBe("generated");

  // Simulate a pre-fix artifact left over from before the sanitizer
  // shipped: schemaVersion 1, a moment whose statedReason is the exact
  // raw LLM-provider error string the real incident shipped publicly
  // (see `AgentDecisiveMoments.ts`'s schema-bump doc and
  // `sanitizeStatedReason`'s own doc). The recap itself is untouched —
  // only the moments artifact regresses to the old, unsanitized shape.
  await fs.writeFile(
    path.join(runDir, "decisive-moments.json"),
    JSON.stringify({
      schemaVersion: 1,
      runID: "league-coworld-integration-1",
      generatedAt: new Date(0).toISOString(),
      moments: [
        {
          turn: 1,
          type: "lead_change",
          headline: "placeholder",
          involvedAgents: [],
          before: null,
          after: null,
          jumpToReplayTurn: 1,
          statedReason:
            'LLM decision rejected (LLM provider failed: HTTP 403 "Invalid API Key format"); fallback: expand toward the nearest neutral territory',
        },
      ],
    }),
  );

  // Second pass: the recap is already current, so ONLY the stale-schema
  // moments artifact drives regeneration — exercising the
  // `decisiveMomentsNeedGeneration` schema-staleness branch specifically.
  const narrativeResult = await generateMatchNarrativeArtifactsForRunDir(
    runDir,
    "league-coworld-integration-1",
  );
  expect(narrativeResult.attempted).toBe(true);
  expect(narrativeResult.outcome.status).toBe("recap-upgraded");

  const moments = JSON.parse(
    await fs.readFile(path.join(runDir, "decisive-moments.json"), "utf8"),
  ) as { schemaVersion: number; moments: { statedReason: string | null }[] };
  expect(moments.schemaVersion).toBe(DECISIVE_MOMENTS_SCHEMA_VERSION);
  for (const moment of moments.moments) {
    // The contaminated moment's statedReason had NO involved agents in the
    // series/telemetry, so it degrades to null (the honest-absence
    // convention) — never the raw junk re-surfacing under a new schema
    // version. Any surviving statedReason (from a genuinely different,
    // real moment this run's series/telemetry actually supports) must
    // still never carry the leaked error vocabulary.
    if (moment.statedReason !== null) {
      expect(moment.statedReason).not.toContain("LLM provider failed");
      expect(moment.statedReason).not.toContain("HTTP 403");
    }
  }

  // A THIRD call, now on the current schema, converges to a free
  // already-exists — proving the regeneration is one-shot, not a
  // repeat-every-cycle cost (same convergence shape
  // `recapNeedsRegeneration` already guarantees for match-recap.json).
  const converged = await generateMatchNarrativeArtifactsForRunDir(
    runDir,
    "league-coworld-integration-1",
  );
  expect(converged.attempted).toBe(false);
  expect(converged.outcome).toEqual({ status: "already-exists" });
});
