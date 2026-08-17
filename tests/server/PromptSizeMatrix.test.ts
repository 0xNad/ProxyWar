import { afterEach, describe, expect, it } from "vitest";
import {
  ARMS,
  buildBoard,
  loadStarterBuildState,
  measureArm,
} from "../../src/scripts/agent-prompt-size-matrix";

/**
 * Guards the offline prompt-size matrix (charter item L) against SILENT
 * collapse. The harness's whole value is that its arms differ: twice during
 * development every arm reported identical bytes — first because the seats
 * never ran a real `SpawnExecution` (so `messageActions` filtered them all out
 * on `hasSpawned`), then because the starter's `cleanMessage` helper was not
 * extracted. Both produced a plausible-looking table that silently
 * under-reported a feature's cost as zero.
 *
 * These tests therefore assert DIFFERENCES between arms, not absolute sizes:
 * byte counts move whenever the playbook or observation shape changes, and
 * pinning them would just be a change-detector.
 */

const TUNABLES = [
  "PROXYWAR_TUNE_SPATIAL_OBSERVATION",
  "PROXYWAR_TUNE_SPATIAL_MINIMAP",
  "PROXYWAR_TUNE_FREETEXT_MESSAGES",
  "PROXYWAR_TUNE_STRUCTURED_DEALS",
];

function arm(name: string) {
  const found = ARMS.find((candidate) => candidate.name === name);
  expect(found, `arm ${name} missing from ARMS`).toBeDefined();
  return found!;
}

describe("prompt size matrix arms", () => {
  afterEach(() => {
    for (const key of TUNABLES) delete process.env[key];
  });

  it("separates every feature arm on a real 8-seat mid-game board", async () => {
    const starterBuildState = await loadStarterBuildState();
    const board = await buildBoard("world", 8, "mid");

    const base = measureArm(board, arm("warships"), starterBuildState);
    const spatial = measureArm(board, arm("spatial"), starterBuildState);
    const minimap = measureArm(
      board,
      arm("spatial_minimap"),
      starterBuildState,
    );
    const freetextEmpty = measureArm(
      board,
      arm("freetext_0"),
      starterBuildState,
    );
    const freetextFull = measureArm(
      board,
      arm("freetext_8"),
      starterBuildState,
    );

    // Baseline carries no flag-gated block at all.
    expect(base.spatialChars).toBe(0);
    expect(base.minimapChars).toBe(0);
    expect(base.inboxChars).toBe(0);
    expect(base.actionKinds.message ?? 0).toBe(0);

    // Spatial adds an observation block; the minimap is a strictly larger child.
    expect(spatial.spatialChars).toBeGreaterThan(0);
    expect(spatial.minimapChars).toBe(0);
    expect(minimap.minimapChars).toBeGreaterThan(0);
    expect(minimap.spatialChars).toBeGreaterThan(spatial.spatialChars);
    expect(minimap.promptChars).toBeGreaterThan(spatial.promptChars);
    expect(spatial.promptChars).toBeGreaterThan(base.promptChars);

    // The comms lane costs menu bytes even with an EMPTY inbox: the message
    // actions themselves are the floor. This is the assertion that failed
    // silently before seats really spawned.
    expect(freetextEmpty.actionKinds.message ?? 0).toBeGreaterThan(0);
    expect(freetextEmpty.legalActionsBlockChars).toBeGreaterThan(
      base.legalActionsBlockChars,
    );
    expect(freetextEmpty.inboxChars).toBe(0);

    // A full inbox is charged on top of that floor, in the observation block.
    expect(freetextFull.inboundMessages).toBeGreaterThan(0);
    expect(freetextFull.inboxChars).toBeGreaterThan(0);
    expect(freetextFull.observationBlockChars).toBeGreaterThan(
      freetextEmpty.observationBlockChars,
    );

    // The public starter's state tracks the same growth — it is the surface
    // league builders actually pay for.
    expect(freetextFull.starterStateChars).toBeGreaterThan(
      base.starterStateChars,
    );
    expect(minimap.starterStateChars).toBeGreaterThan(base.starterStateChars);
  }, 120_000);

  it("charges warship affordances to the menu, and leaves no tunable env behind", async () => {
    const starterBuildState = await loadStarterBuildState();
    const board = await buildBoard("world", 8, "late");

    const preWarship = measureArm(
      board,
      arm("base_no_warships"),
      starterBuildState,
    );
    const shipped = measureArm(board, arm("warships"), starterBuildState);

    // 0.1.48 restored warships with no env flag, so the pre-warship arm is an
    // emulation: strip the affordances and the menu must actually shrink.
    expect(preWarship.actionKinds.move_warship ?? 0).toBe(0);
    expect(shipped.actionKinds.move_warship ?? 0).toBeGreaterThan(0);
    expect(shipped.legalActionsBlockChars).toBeGreaterThan(
      preWarship.legalActionsBlockChars,
    );
    expect(shipped.promptChars).toBeGreaterThan(preWarship.promptChars);

    // Arms mutate process.env; a leak would silently contaminate later arms
    // (and any test that runs after this file in the same worker).
    expect(process.env.PROXYWAR_TUNE_SPATIAL_OBSERVATION).toBeUndefined();
    expect(process.env.PROXYWAR_TUNE_FREETEXT_MESSAGES).toBeUndefined();
  }, 120_000);
});
