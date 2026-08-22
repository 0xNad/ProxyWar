import fs from "fs/promises";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  boundedSpatialMapInfo,
  boundedSpatialV1,
} from "../../coworld-adapter/tester-starter-llm/owner-capabilities.mjs";

/**
 * Phase A starter surface: `buildState` in
 * `coworld-adapter/tester-starter-llm/llm-player.mjs` may surface the
 * flag-gated observation `economy` block as ONE compact `econ` line
 * (<= 300 chars). When the observation has no economy block — every hosted
 * match today — buildState's output must be BYTE-identical to the legacy
 * shape.
 *
 * The module itself opens a WebSocket and requires COWORLD_PLAYER_WS_URL at
 * import time, so this test extracts the pure `clean` + `buildState`
 * functions from the shipped source text and evaluates them directly
 * (importing nothing from Bedrock, ws, or the module).
 */

const STARTER_FILE = path.join(
  process.cwd(),
  "coworld-adapter",
  "tester-starter-llm",
  "llm-player.mjs",
);

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} not found in llm-player.mjs`).toBeGreaterThan(
    -1,
  );
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

async function loadBuildState(): Promise<
  (obs: unknown, actions: unknown[]) => Record<string, unknown>
> {
  const source = await fs.readFile(STARTER_FILE, "utf8");
  const cleanSrc = extractFunction(source, "clean");
  const buildStateSrc = extractFunction(source, "buildState");
  // buildState references the module-level avoidActionIDs(); stub it with the
  // empty-history result so the extracted function runs standalone. Both the
  // legacy and economy paths share the stub, so byte-shape comparisons hold.
  return new Function(
    "boundedSpatialV1",
    "boundedSpatialMapInfo",
    `function avoidActionIDs() { return []; }\n${cleanSrc}\n${buildStateSrc}\nreturn buildState;`,
  )(boundedSpatialV1, boundedSpatialMapInfo) as (
    obs: unknown,
    actions: unknown[],
  ) => Record<string, unknown>;
}

const BASE_OBS = {
  phase: "active",
  ownState: {
    tileShare: 0.12,
    troops: 50_000,
    troopRatio: 0.4,
    gold: "1000000",
    borderTiles: 40,
    incomingAttacks: 0,
    units: { City: 1 },
  },
  visiblePlayers: [
    {
      name: "Sefirot",
      isAlive: true,
      tileShare: 0.2,
      relativeTroopRatio: 0.8,
      sharesBorder: true,
      isAllied: false,
      relation: 1,
      canAttack: true,
    },
  ],
};

const ACTIONS = [
  {
    id: "attack:1",
    kind: "attack",
    label: "Attack Sefirot",
    risk: { level: "medium" },
  },
  { id: "hold", kind: "hold", label: "Hold", risk: { level: "none" } },
  {
    id: "nuke:1",
    kind: "nuke",
    label: "MIRV Sefirot",
    risk: { level: "high" },
    metadata: { cost: "25000000" },
  },
];

const ECONOMY_BLOCK = {
  factoryStatusCounts: {
    operational: 0,
    idleNoDestination: 1,
    blockedByEmbargo: 1,
  },
  counterparties: [
    {
      playerID: "p9",
      name: "Auri",
      isAllied: true,
      myEligibleDestinationsTheyOwn: 2,
      eligibleDestinationSharePct: 40,
      embargoOursOnThem: false,
      embargoTheirsOnUs: false,
    },
    {
      playerID: "p2",
      name: "Sefirot",
      isAllied: false,
      myEligibleDestinationsTheyOwn: 1,
      eligibleDestinationSharePct: 20,
      embargoOursOnThem: false,
      embargoTheirsOnUs: false,
    },
  ],
  bottleneck: {
    kind: "embargo_disruption",
    evidence: "1 of 2 factories are embargo-blocked",
  },
};

describe("tester-starter-llm buildState economy line", () => {
  it("without an economy block the state is byte-identical to the legacy shape", async () => {
    const buildState = await loadBuildState();
    const state = buildState(BASE_OBS, ACTIONS);
    expect(JSON.stringify(state)).toBe(
      JSON.stringify({
        phase: "active",
        self: {
          tileShare: 0.12,
          troops: 50_000,
          troopRatio: 0.4,
          gold: "1000000",
          borderTiles: 40,
          incomingAttacks: 0,
          structures: { City: 1 },
        },
        rivals: [
          {
            name: "Sefirot",
            tileShare: 0.2,
            relativeTroopRatio: 0.8,
            sharesBorder: true,
            isAllied: false,
            relation: 1,
            canAttack: true,
          },
        ],
        avoid: [],
        legalActions: [
          {
            id: "attack:1",
            kind: "attack",
            label: "Attack Sefirot",
            risk: "medium",
          },
          { id: "hold", kind: "hold", label: "Hold", risk: "none" },
          {
            id: "nuke:1",
            kind: "nuke",
            label: "MIRV Sefirot",
            risk: "high",
            cost: "25000000",
          },
        ],
      }),
    );
    expect("econ" in state).toBe(false);
  });

  it("with an economy block it adds ONE econ line (<= 300 chars) and nothing else", async () => {
    const buildState = await loadBuildState();
    const withoutEconomy = buildState(BASE_OBS, ACTIONS);
    const withEconomy = buildState(
      { ...BASE_OBS, economy: ECONOMY_BLOCK },
      ACTIONS,
    );

    const econ = withEconomy.econ as string;
    expect(typeof econ).toBe("string");
    expect(econ.length).toBeLessThanOrEqual(300);
    expect(econ).not.toContain("\n");
    // Idle factories + top dependency + bottleneck, compactly.
    expect(econ).toContain("2 idle factories (embargo)");
    expect(econ).toContain("40% of trade destinations owned by Auri (allied)");
    expect(econ).toContain("bottleneck: embargo_disruption");

    // Removing the added key restores the byte-identical legacy payload.
    const { econ: _econ, ...rest } = withEconomy;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(withoutEconomy));
    // Character budget: the whole economy addition is the econ line plus its
    // JSON key overhead, comfortably under the 300-char budget.
    expect(
      JSON.stringify(withEconomy).length -
        JSON.stringify(withoutEconomy).length,
    ).toBeLessThanOrEqual(300 + ',"econ":""'.length);
  });

  it("an economy block with nothing to say adds nothing", async () => {
    const buildState = await loadBuildState();
    const quietEconomy = {
      factoryStatusCounts: {
        operational: 2,
        idleNoDestination: 0,
        blockedByEmbargo: 0,
      },
      counterparties: [],
      bottleneck: { kind: "none", evidence: "" },
    };
    const state = buildState({ ...BASE_OBS, economy: quietEconomy }, ACTIONS);
    expect("econ" in state).toBe(false);
    expect(JSON.stringify(state)).toBe(
      JSON.stringify(buildState(BASE_OBS, ACTIONS)),
    );
  });
});
