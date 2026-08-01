import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { generateMatchNarrativeArtifactsForRunDir } from "../../src/server/agents/CoworldLeagueMatchNarrativeBackfill";
import { generateMatchStateSeriesForRunDir } from "../../src/server/agents/CoworldLeagueMatchStateSeriesBackfill";
import type { AgentMatchRecap } from "../../src/server/agents/AgentMatchRecap";

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
  path.join(__dirname, "fixtures", "coworld-mirror-match-state-series-replay.sample.json"),
  "utf8",
);
const realTelemetryFixtureRaw = readFileSync(
  path.join(__dirname, "fixtures", "coworld-mirror-match-state-series-telemetry.sample.json"),
  "utf8",
);

let root: string;
let runDir: string;

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "pw-narrative-series-integration-")),
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
