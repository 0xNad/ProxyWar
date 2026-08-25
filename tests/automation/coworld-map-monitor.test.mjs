import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildMapMonitoringReport,
  MAP_MONITOR_LIMITS,
  readBoundedJsonFile,
} from "../../.github/scripts/coworld-map-monitor.mjs";

const contract = JSON.parse(
  readFileSync(
    "coworld-adapter/commissioner/commissioners/ruleset_strategy_commissioner/configs/proxywar-map-rotation.json",
    "utf8",
  ),
);
const SOURCE_SHA = "a".repeat(40);
const COWORLD_ID = "cow_11111111-1111-1111-1111-111111111111";
const COMMISSIONER = `sha256:${"b".repeat(64)}`;
const SIXTEEN_VARIANTS = contract.competitionRungs.find(
  (rung) => rung.seats === 16,
).variants;

function episode(index, overrides = {}) {
  const suffix = String(index).padStart(12, "0");
  return {
    episodeRequestId: `ereq_11111111-1111-1111-1111-${suffix}`,
    status: "completed",
    participantCount: 16,
    scoreCount: 16,
    spawnEvidencePresent: true,
    spawnValid: true,
    telemetryEvidencePresent: true,
    decisionCount: 100,
    fallbackCount: index,
    degradedCount: 0,
    replayPresent: true,
    replayIntegrityVerified: true,
    artifactIntegrityVerified: true,
    startedAt: "2026-08-25T10:00:00Z",
    completedAt: "2026-08-25T10:10:00Z",
    ...overrides,
  };
}

function round(variant, index, overrides = {}) {
  const suffix = String(index).padStart(12, "0");
  return {
    roundId: `round_22222222-2222-2222-2222-${suffix}`,
    roundNumber: 2000 + index,
    variantId: variant.id,
    map: variant.map,
    status: "completed",
    episodes: [episode(index)],
    ...overrides,
  };
}

function fullRotation() {
  return SIXTEEN_VARIANTS.map((variant, index) => round(variant, index));
}

function evidence(rounds = fullRotation()) {
  return {
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    coworldId: COWORLD_ID,
    commissionerMigrationVersion: COMMISSIONER,
    rounds,
  };
}

test("map monitor reports complete aggregate-only coverage for one full rotation", () => {
  const report = buildMapMonitoringReport(contract, evidence());

  assert.equal(report.status, "healthy");
  assert.deepEqual(
    report.maps.map((row) => row.map),
    ["Pangaea", "Asia", "BlackSea", "EastAsia", "Oceania"],
  );
  assert.ok(report.maps.every((row) => row.status === "healthy"));
  assert.ok(
    report.maps.every(
      (row) =>
        row.coverage.completionRate === 1 &&
        row.coverage.scoreBearingCoverage === 1 &&
        row.coverage.spawnValidityCoverage === 1 &&
        row.coverage.telemetryCoverage === 1 &&
        row.coverage.replayIntegrityCoverage === 1 &&
        row.coverage.artifactIntegrityCoverage === 1,
    ),
  );
  assert.equal(report.maps[4].decisions.fallback, 4);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /ereq_|round_|policy|participant/i);
});

test("every map rejects nonterminal episodes hidden inside a terminal round", () => {
  for (let index = 0; index < SIXTEEN_VARIANTS.length; index += 1) {
    for (const status of ["pending", "running"]) {
      const rounds = fullRotation();
      rounds[index] = round(SIXTEEN_VARIANTS[index], index, {
        episodes: [episode(index, { status, completedAt: null })],
      });
      assert.throws(
        () => buildMapMonitoringReport(contract, evidence(rounds)),
        /terminal round contains nonterminal episode/,
        `${SIXTEEN_VARIANTS[index].map} accepted ${status} episode evidence`,
      );
    }
  }
});

test("map monitor exposes absent comparison maps as insufficient evidence", () => {
  const report = buildMapMonitoringReport(
    contract,
    evidence([round(SIXTEEN_VARIANTS[0], 0)]),
  );

  assert.equal(report.status, "insufficient_evidence");
  assert.equal(report.maps.length, 5);
  assert.equal(report.maps[0].status, "healthy");
  assert.ok(
    report.maps.slice(1).every((row) => row.status === "insufficient_evidence"),
  );
});

test("map monitor degrades score, spawn, telemetry, replay, and artifact gaps", () => {
  const rounds = fullRotation();
  rounds[2] = round(SIXTEEN_VARIANTS[2], 2, {
    episodes: [
      episode(2, {
        scoreCount: 0,
        spawnEvidencePresent: false,
        spawnValid: false,
        telemetryEvidencePresent: false,
        decisionCount: 0,
        fallbackCount: 0,
        replayPresent: false,
        replayIntegrityVerified: false,
        artifactIntegrityVerified: false,
      }),
    ],
  });

  const report = buildMapMonitoringReport(contract, evidence(rounds));
  const blackSea = report.maps.find((row) => row.map === "BlackSea");

  assert.equal(report.status, "degraded");
  assert.equal(blackSea.status, "degraded");
  assert.equal(blackSea.coverage.scoreBearingCoverage, 0);
  assert.equal(blackSea.coverage.spawnValidityCoverage, 0);
  assert.equal(blackSea.coverage.telemetryCoverage, 0);
  assert.equal(blackSea.coverage.replayIntegrityCoverage, 0);
  assert.equal(blackSea.coverage.artifactIntegrityCoverage, 0);
});

test("map monitor reports failures and per-map timeout pressure", () => {
  const rounds = fullRotation();
  rounds[1] = round(SIXTEEN_VARIANTS[1], 1, {
    status: "failed",
    episodes: [
      episode(1, {
        status: "failed",
        scoreCount: 0,
        spawnEvidencePresent: false,
        spawnValid: false,
        telemetryEvidencePresent: false,
        decisionCount: 0,
        fallbackCount: 0,
        replayPresent: false,
        replayIntegrityVerified: false,
        artifactIntegrityVerified: false,
      }),
    ],
  });
  rounds[3] = round(SIXTEEN_VARIANTS[3], 3, {
    episodes: [
      episode(3, {
        completedAt: "2026-08-25T11:06:40Z",
      }),
    ],
  });

  const report = buildMapMonitoringReport(contract, evidence(rounds));
  const asia = report.maps.find((row) => row.map === "Asia");
  const eastAsia = report.maps.find((row) => row.map === "EastAsia");

  assert.equal(asia.rounds.failed, 1);
  assert.equal(asia.episodes.failed, 1);
  assert.equal(asia.coverage.completionRate, 0);
  assert.equal(asia.status, "degraded");
  assert.equal(eastAsia.performanceSeconds.p95, 4000);
  assert.equal(eastAsia.status, "warning");
});

test("map monitor fails closed on unsupported or mislabeled variants", () => {
  const unsupported = round(SIXTEEN_VARIANTS[0], 0, {
    variantId: "tournament-16p-fourislands",
    map: "FourIslands",
  });
  assert.throws(
    () => buildMapMonitoringReport(contract, evidence([unsupported])),
    /unsupported map variant/,
  );

  const mislabeled = round(SIXTEEN_VARIANTS[0], 0, { map: "Asia" });
  assert.throws(
    () => buildMapMonitoringReport(contract, evidence([mislabeled])),
    /map identity mismatch/,
  );
});

test("bounded JSON reader rejects links, non-files, oversized bytes, and invalid UTF-8", () => {
  const directory = mkdtempSync(join(tmpdir(), "proxywar-map-monitor-"));
  try {
    const validPath = join(directory, "valid.json");
    writeFileSync(validPath, '{"schemaVersion":1}');
    assert.deepEqual(readBoundedJsonFile(validPath, 64, "fixture"), {
      schemaVersion: 1,
    });

    const linkPath = join(directory, "linked.json");
    symlinkSync(validPath, linkPath);
    assert.throws(() => readBoundedJsonFile(linkPath, 64, "fixture"));
    assert.throws(
      () => readBoundedJsonFile(directory, 64, "fixture"),
      /must be a regular file/,
    );

    const oversizedPath = join(directory, "oversized.json");
    writeFileSync(oversizedPath, Buffer.alloc(65, 0x20));
    assert.throws(
      () => readBoundedJsonFile(oversizedPath, 64, "fixture"),
      /exceeds the 64-byte limit/,
    );

    const invalidUtf8Path = join(directory, "invalid-utf8.json");
    writeFileSync(invalidUtf8Path, Buffer.from([0x7b, 0xc3, 0x28, 0x7d]));
    assert.throws(
      () => readBoundedJsonFile(invalidUtf8Path, 64, "fixture"),
      /encoded data|encoding/i,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("monitor rejects oversized round, episode, total, and member structures", () => {
  const excessiveRounds = Array.from(
    { length: MAP_MONITOR_LIMITS.rounds + 1 },
    (_, index) => round(SIXTEEN_VARIANTS[0], index),
  );
  assert.throws(
    () => buildMapMonitoringReport(contract, evidence(excessiveRounds)),
    /evidence rounds length/,
  );

  const excessiveEpisodes = Array.from(
    { length: MAP_MONITOR_LIMITS.episodesPerRound + 1 },
    (_, index) => episode(index),
  );
  assert.throws(
    () =>
      buildMapMonitoringReport(
        contract,
        evidence([
          round(SIXTEEN_VARIANTS[0], 0, { episodes: excessiveEpisodes }),
        ]),
      ),
    /round episodes length/,
  );

  let remaining = MAP_MONITOR_LIMITS.totalEpisodes + 1;
  let episodeIndex = 0;
  const excessiveTotal = [];
  while (remaining > 0) {
    const count = Math.min(remaining, MAP_MONITOR_LIMITS.episodesPerRound);
    excessiveTotal.push(
      round(SIXTEEN_VARIANTS[0], excessiveTotal.length, {
        episodes: Array.from({ length: count }, () =>
          episode(episodeIndex++, { fallbackCount: 0 }),
        ),
      }),
    );
    remaining -= count;
  }
  assert.throws(
    () => buildMapMonitoringReport(contract, evidence(excessiveTotal)),
    /total episode limit/,
  );

  const excessiveMembers = evidence([]);
  for (let index = 0; index <= MAP_MONITOR_LIMITS.objectMembers; index += 1) {
    excessiveMembers[`unexpected${index}`] = index;
  }
  assert.throws(
    () => buildMapMonitoringReport(contract, excessiveMembers),
    /object member limit/,
  );
});
