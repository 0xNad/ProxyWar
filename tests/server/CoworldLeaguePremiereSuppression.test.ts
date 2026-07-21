import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  PREMIERE_SUPPRESSION_DEFAULT_QUARANTINE_MS,
  PREMIERE_SUPPRESSION_SCHEMA_VERSION,
  PREMIERE_SUPPRESSION_STALE_MS,
  buildPremiereSiteBlock,
  classifyEpisodeSuppression,
  createPremiereSuppressionContract,
  filterSuppressedEpisodeRows,
  isHeld,
  isQuarantined,
  loadPremiereSuppressionContract,
  parsePremiereSuppressionContract,
  premiereSuppressionContractPath,
  selectDisplayHold,
  writePremiereSuppressionContract,
  type PremiereSuppressionContract,
  type PremiereSuppressionHold,
  type PremiereSuppressionState,
} from "../../src/server/agents/CoworldLeaguePremiereSuppression";

const NOW = new Date("2026-07-21T12:00:00.000Z");

function hold(
  overrides: Partial<PremiereSuppressionHold> = {},
): PremiereSuppressionHold {
  return {
    episodeRequestId: "ereq_held0001",
    premiereId: "prem_held0001",
    roundId: "round_1",
    roundNumber: 512,
    scheduledAt: "2026-07-21T12:05:00.000Z",
    holdExpiresAt: "2026-07-21T12:30:00.000Z",
    premierePageLive: false,
    mapLabel: "Europe",
    ...overrides,
  };
}

function contract(
  overrides: Partial<PremiereSuppressionContract> = {},
): PremiereSuppressionContract {
  return {
    schemaVersion: PREMIERE_SUPPRESSION_SCHEMA_VERSION,
    generatedAt: NOW.toISOString(),
    quarantineMs: PREMIERE_SUPPRESSION_DEFAULT_QUARANTINE_MS,
    holds: [hold()],
    ...overrides,
  };
}

function activeState(
  overrides: Partial<PremiereSuppressionContract> = {},
): PremiereSuppressionState {
  const state = parsePremiereSuppressionContract(
    JSON.stringify(contract(overrides)),
    NOW,
  );
  if (state.status !== "active") {
    throw new Error(`expected active state, got ${state.reason}`);
  }
  return state;
}

let tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tmpDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tmpDirs = [];
  delete process.env.PROXYWAR_STORAGE_STATE_DIR;
});

describe("premiere-suppression contract path", () => {
  test("defaults to the ProxyWar storage state dir", () => {
    delete process.env.PROXYWAR_STORAGE_STATE_DIR;
    expect(premiereSuppressionContractPath()).toBe(
      "/Users/claude/Library/Application Support/ProxyWar/storage/premiere-suppression/contract-v1.json",
    );
  });

  test("honors PROXYWAR_STORAGE_STATE_DIR override", () => {
    process.env.PROXYWAR_STORAGE_STATE_DIR = "/var/state";
    expect(premiereSuppressionContractPath()).toBe(
      "/var/state/premiere-suppression/contract-v1.json",
    );
  });

  test("accepts an explicit state dir argument", () => {
    expect(premiereSuppressionContractPath("/custom")).toBe(
      "/custom/premiere-suppression/contract-v1.json",
    );
  });
});

describe("parsePremiereSuppressionContract fail-open reasons", () => {
  test("valid contract parses to active", () => {
    const state = parsePremiereSuppressionContract(
      JSON.stringify(contract()),
      NOW,
    );
    expect(state.status).toBe("active");
    if (state.status === "active") {
      expect(state.contract.holds).toHaveLength(1);
      expect(state.generatedAtMs).toBe(NOW.getTime());
    }
  });

  test("corrupt JSON is stale invalid_json", () => {
    const state = parsePremiereSuppressionContract("{not json", NOW);
    expect(state).toEqual({ status: "stale", reason: "invalid_json" });
  });

  test("a JSON array is stale not_an_object", () => {
    const state = parsePremiereSuppressionContract("[]", NOW);
    expect(state).toEqual({ status: "stale", reason: "not_an_object" });
  });

  test("unknown future schemaVersion is stale unknown_schema_version", () => {
    const state = parsePremiereSuppressionContract(
      JSON.stringify(contract({ schemaVersion: 2 as 1 })),
      NOW,
    );
    expect(state).toEqual({
      status: "stale",
      reason: "unknown_schema_version",
    });
  });

  test("missing schemaVersion is stale unknown_schema_version", () => {
    const raw = JSON.stringify({
      generatedAt: NOW.toISOString(),
      quarantineMs: 1000,
      holds: [],
    });
    expect(parsePremiereSuppressionContract(raw, NOW)).toEqual({
      status: "stale",
      reason: "unknown_schema_version",
    });
  });

  test("invalid generatedAt is stale invalid_generated_at", () => {
    const state = parsePremiereSuppressionContract(
      JSON.stringify(contract({ generatedAt: "not-a-date" })),
      NOW,
    );
    expect(state).toEqual({ status: "stale", reason: "invalid_generated_at" });
  });

  test("generatedAt at/after the 15-minute bound is stale_generated_at", () => {
    const generatedAt = new Date(
      NOW.getTime() - PREMIERE_SUPPRESSION_STALE_MS,
    ).toISOString();
    const state = parsePremiereSuppressionContract(
      JSON.stringify(contract({ generatedAt })),
      NOW,
    );
    expect(state).toEqual({ status: "stale", reason: "stale_generated_at" });
  });

  test("a generatedAt just inside 15 minutes stays active", () => {
    const generatedAt = new Date(
      NOW.getTime() - (PREMIERE_SUPPRESSION_STALE_MS - 1000),
    ).toISOString();
    const state = parsePremiereSuppressionContract(
      JSON.stringify(contract({ generatedAt })),
      NOW,
    );
    expect(state.status).toBe("active");
  });

  test("invalid quarantineMs is stale invalid_quarantine_ms", () => {
    const raw = JSON.stringify({
      ...contract(),
      quarantineMs: "soon",
    });
    expect(parsePremiereSuppressionContract(raw, NOW)).toEqual({
      status: "stale",
      reason: "invalid_quarantine_ms",
    });
  });

  test("negative quarantineMs is stale invalid_quarantine_ms", () => {
    const state = parsePremiereSuppressionContract(
      JSON.stringify(contract({ quarantineMs: -1 })),
      NOW,
    );
    expect(state).toEqual({ status: "stale", reason: "invalid_quarantine_ms" });
  });

  test("non-array holds is stale invalid_holds", () => {
    const raw = JSON.stringify({ ...contract(), holds: {} });
    expect(parsePremiereSuppressionContract(raw, NOW)).toEqual({
      status: "stale",
      reason: "invalid_holds",
    });
  });

  test("malformed hold entries are dropped tolerantly, valid ones kept", () => {
    const raw = JSON.stringify(
      contract({
        holds: [
          hold({ episodeRequestId: "ereq_ok" }),
          { episodeRequestId: "", premiereId: "x" },
          hold({ episodeRequestId: "ereq_ok2", holdExpiresAt: "nope" }),
          { totally: "wrong" },
        ] as PremiereSuppressionHold[],
      }),
    );
    const state = parsePremiereSuppressionContract(raw, NOW);
    expect(state.status).toBe("active");
    if (state.status === "active") {
      expect(
        state.contract.holds.map((entry) => entry.episodeRequestId),
      ).toEqual(["ereq_ok"]);
    }
  });
});

describe("loadPremiereSuppressionContract", () => {
  test("a missing file is stale missing_file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "premiere-suppress-"));
    tmpDirs.push(dir);
    const state = await loadPremiereSuppressionContract(
      path.join(dir, "does-not-exist.json"),
      NOW,
    );
    expect(state).toEqual({ status: "stale", reason: "missing_file" });
  });

  test("atomic write round-trips through the loader", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "premiere-suppress-"));
    tmpDirs.push(dir);
    const contractPath = premiereSuppressionContractPath(dir);
    const written = createPremiereSuppressionContract({
      generatedAt: NOW.toISOString(),
      holds: [hold({ episodeRequestId: "ereq_written" })],
    });
    await writePremiereSuppressionContract(contractPath, written);
    const state = await loadPremiereSuppressionContract(contractPath, NOW);
    expect(state.status).toBe("active");
    if (state.status === "active") {
      expect(state.contract.quarantineMs).toBe(
        PREMIERE_SUPPRESSION_DEFAULT_QUARANTINE_MS,
      );
      expect(state.contract.holds[0]?.episodeRequestId).toBe("ereq_written");
    }
  });
});

describe("isHeld — hold expiry is the hard availability bound", () => {
  test("held while an unexpired hold names the episode", () => {
    expect(isHeld(activeState(), "ereq_held0001", NOW)).toBe(true);
  });

  test("holdExpiresAt in the past means NOT held (publication resumes)", () => {
    const state = activeState({
      holds: [hold({ holdExpiresAt: "2026-07-21T11:59:59.000Z" })],
    });
    expect(isHeld(state, "ereq_held0001", NOW)).toBe(false);
  });

  test("exactly at holdExpiresAt is NOT held (strict now < expiry)", () => {
    const state = activeState({
      holds: [hold({ holdExpiresAt: NOW.toISOString() })],
    });
    expect(isHeld(state, "ereq_held0001", NOW)).toBe(false);
  });

  test("a stale state never holds", () => {
    const stale: PremiereSuppressionState = {
      status: "stale",
      reason: "missing_file",
    };
    expect(isHeld(stale, "ereq_held0001", NOW)).toBe(false);
  });

  test("an unrelated episode id is not held", () => {
    expect(isHeld(activeState(), "ereq_other", NOW)).toBe(false);
  });
});

describe("isQuarantined", () => {
  test("within the quarantine window is quarantined", () => {
    const state = activeState({ quarantineMs: 10 * 60 * 1000 });
    const completedAt = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    expect(isQuarantined(state, completedAt, NOW)).toBe(true);
  });

  test("outside the quarantine window is not quarantined", () => {
    const state = activeState({ quarantineMs: 10 * 60 * 1000 });
    const completedAt = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString();
    expect(isQuarantined(state, completedAt, NOW)).toBe(false);
  });

  test("null completedAt is never quarantined", () => {
    expect(isQuarantined(activeState(), null, NOW)).toBe(false);
  });

  test("a stale state never quarantines", () => {
    const stale: PremiereSuppressionState = {
      status: "stale",
      reason: "not_configured",
    };
    const completedAt = new Date(NOW.getTime() - 1000).toISOString();
    expect(isQuarantined(stale, completedAt, NOW)).toBe(false);
  });
});

describe("classifyEpisodeSuppression precedence", () => {
  const recent = new Date(NOW.getTime() - 60 * 1000).toISOString();

  test("held dominates quarantine", () => {
    const state = activeState({
      quarantineMs: 10 * 60 * 1000,
      holds: [hold({ episodeRequestId: "ereq_held0001" })],
    });
    expect(
      classifyEpisodeSuppression(
        state,
        { episodeRequestId: "ereq_held0001", completedAt: recent },
        NOW,
      ),
    ).toBe("held");
  });

  test("a recent unheld episode is quarantined", () => {
    const state = activeState({ quarantineMs: 10 * 60 * 1000, holds: [] });
    expect(
      classifyEpisodeSuppression(
        state,
        { episodeRequestId: "ereq_fresh", completedAt: recent },
        NOW,
      ),
    ).toBe("quarantined");
  });

  test("an old unheld episode publishes", () => {
    const state = activeState({ quarantineMs: 10 * 60 * 1000, holds: [] });
    const old = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
    expect(
      classifyEpisodeSuppression(
        state,
        { episodeRequestId: "ereq_old", completedAt: old },
        NOW,
      ),
    ).toBe("publish");
  });

  test("a stale state always publishes", () => {
    const stale: PremiereSuppressionState = {
      status: "stale",
      reason: "missing_file",
    };
    expect(
      classifyEpisodeSuppression(
        stale,
        { episodeRequestId: "ereq_held0001", completedAt: recent },
        NOW,
      ),
    ).toBe("publish");
  });
});

describe("filterSuppressedEpisodeRows", () => {
  const recent = new Date(NOW.getTime() - 60 * 1000).toISOString();
  const old = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();
  const rows = [
    { episodeRequestId: "ereq_held0001", completedAt: old },
    { episodeRequestId: "ereq_fresh", completedAt: recent },
    { episodeRequestId: "ereq_old", completedAt: old },
  ];

  test("drops held and quarantined, keeps publishable", () => {
    const state = activeState({
      quarantineMs: 10 * 60 * 1000,
      holds: [hold({ episodeRequestId: "ereq_held0001" })],
    });
    expect(
      filterSuppressedEpisodeRows(state, rows, NOW).map(
        (row) => row.episodeRequestId,
      ),
    ).toEqual(["ereq_old"]);
  });

  test("a stale state returns the list unchanged (availability)", () => {
    const stale: PremiereSuppressionState = {
      status: "stale",
      reason: "not_configured",
    };
    expect(filterSuppressedEpisodeRows(stale, rows, NOW)).toEqual(rows);
  });
});

describe("selectDisplayHold / buildPremiereSiteBlock", () => {
  test("a live premiere outranks a scheduled one", () => {
    const state = activeState({
      holds: [
        hold({ premiereId: "prem_scheduled", premierePageLive: false }),
        hold({ premiereId: "prem_live", premierePageLive: true }),
      ],
    });
    expect(selectDisplayHold(state, NOW)?.premiereId).toBe("prem_live");
  });

  test("expired holds are not displayed", () => {
    const state = activeState({
      holds: [hold({ holdExpiresAt: "2026-07-21T11:00:00.000Z" })],
    });
    expect(selectDisplayHold(state, NOW)).toBeNull();
    expect(buildPremiereSiteBlock(state, NOW)).toBeNull();
  });

  test("card carries only the five contract fields", () => {
    const state = activeState({
      holds: [
        hold({
          premiereId: "prem_card",
          roundNumber: 77,
          mapLabel: "Asia",
          scheduledAt: "2026-07-21T12:10:00.000Z",
          premierePageLive: true,
        }),
      ],
    });
    expect(buildPremiereSiteBlock(state, NOW)).toEqual({
      premiereId: "prem_card",
      roundNumber: 77,
      mapLabel: "Asia",
      scheduledAt: "2026-07-21T12:10:00.000Z",
      premierePageLive: true,
    });
  });

  test("a stale state yields no premiere block", () => {
    const stale: PremiereSuppressionState = {
      status: "stale",
      reason: "missing_file",
    };
    expect(buildPremiereSiteBlock(stale, NOW)).toBeNull();
  });
});
