import {
  AbstractRenderer,
  GlShaderSystem,
  GlUboSystem,
  GlUniformGroupSystem,
  GpuUboSystem,
  ParticleBuffer,
  UboSystem,
} from "pixi.js";
import { describe, expect, test, vi } from "vitest";
import { shouldPreserveGhostAfterBuild } from "../../../../src/client/graphics/layers/StructureIconsLayer";
import type { EventBus } from "../../../../src/core/EventBus";
import { UnitType } from "../../../../src/core/game/Game";
import type { GameView } from "../../../../src/core/game/GameView";
import type { TransformHandler } from "../../../../src/client/graphics/TransformHandler";
import type { UIState } from "../../../../src/client/graphics/UIState";

type RuntimePrototype = Record<string, (...args: never[]) => unknown>;

function runtimePrototype(value: object): RuntimePrototype {
  return value as RuntimePrototype;
}

describe("StructureIconsLayer Pixi CSP support", () => {
  test("installs Pixi's static sync polyfills before renderer setup", () => {
    const abstractRenderer = runtimePrototype(AbstractRenderer.prototype);
    const ubo = runtimePrototype(UboSystem.prototype);
    const glUniformGroup = runtimePrototype(GlUniformGroupSystem.prototype);
    const glUbo = runtimePrototype(GlUboSystem.prototype);
    const gpuUbo = runtimePrototype(GpuUboSystem.prototype);
    const glShader = runtimePrototype(GlShaderSystem.prototype);
    const particleBuffer = runtimePrototype(ParticleBuffer.prototype);

    expect(abstractRenderer._unsafeEvalCheck.toString()).not.toContain(
      "unsafeEvalSupported",
    );
    expect(ubo._systemCheck.toString()).not.toContain("unsafeEvalSupported");
    expect(glUniformGroup._generateUniformsSync.name).toBe(
      "generateUniformsSyncPolyfill",
    );
    expect(glUbo._generateUboSync.name).toBe("generateUboSyncPolyfillSTD40");
    expect(gpuUbo._generateUboSync.name).toBe("generateUboSyncPolyfillWGSL");
    expect(glShader._generateShaderSync.name).toBe(
      "generateShaderSyncPolyfill",
    );
    expect(particleBuffer.generateParticleUpdate.name).toBe(
      "generateParticleUpdatePolyfill",
    );
  });
});

/**
 * Tests for StructureIconsLayer edge cases mentioned in comments:
 * - Locked nuke / AtomBomb / HydrogenBomb: when confirming placement (Enter or key),
 *   the ghost is preserved so the user can place multiple nukes or keep the nuke
 *   selected. Other structure types clear the ghost after placement.
 */
describe("StructureIconsLayer ghost preservation (locked nuke / Enter confirm)", () => {
  describe("shouldPreserveGhostAfterBuild", () => {
    test("returns true for AtomBomb so ghost is not cleared after placement", () => {
      expect(shouldPreserveGhostAfterBuild(UnitType.AtomBomb)).toBe(true);
    });

    test("returns true for HydrogenBomb so ghost is not cleared after placement", () => {
      expect(shouldPreserveGhostAfterBuild(UnitType.HydrogenBomb)).toBe(true);
    });

    test("returns false for City so ghost is cleared after placement", () => {
      expect(shouldPreserveGhostAfterBuild(UnitType.City)).toBe(false);
    });

    test("returns false for Factory so ghost is cleared after placement", () => {
      expect(shouldPreserveGhostAfterBuild(UnitType.Factory)).toBe(false);
    });

    test("returns false for other buildable types (Port, DefensePost, MissileSilo, SAMLauncher, Warship, MIRV)", () => {
      expect(shouldPreserveGhostAfterBuild(UnitType.Port)).toBe(false);
      expect(shouldPreserveGhostAfterBuild(UnitType.DefensePost)).toBe(false);
      expect(shouldPreserveGhostAfterBuild(UnitType.MissileSilo)).toBe(false);
      expect(shouldPreserveGhostAfterBuild(UnitType.SAMLauncher)).toBe(false);
      expect(shouldPreserveGhostAfterBuild(UnitType.Warship)).toBe(false);
      expect(shouldPreserveGhostAfterBuild(UnitType.MIRV)).toBe(false);
    });
  });
});

/**
 * P0 regression (2026-08-03): `tick()` used to touch `iconsStage`/
 * `levelsStage`/`dotsStage` (via handleActiveUnit -> addNewStructure ->
 * createIconSprite -> SpriteFactory.createUnitContainer's `stage.addChild`)
 * with no guard against those fields still being unassigned -- they're only
 * ever set inside the async `setupRenderer()`, awaited from `init()`, never
 * the constructor. A unit-creation update arriving before that promise
 * resolved (routine during a max-speed replay catch-up burst -- see
 * /tmp/proxywar-qa/matrix-2/CRITICAL-ROOT-CAUSE-crash-and-stall.md) threw
 * "Cannot read properties of undefined (reading 'addChild')" from inside
 * the WebWorker tick handler, silently and permanently killing the whole
 * game tick loop (no auto-recovery). This test constructs the layer and
 * calls tick() BEFORE init()/setupRenderer() ever runs -- exactly the
 * crash window -- and asserts it no longer throws.
 */
describe("StructureIconsLayer tick() pre-init guard (P0 crash fix)", () => {
  test("tick() called before setupRenderer() resolves does not throw (was: 'Cannot read properties of undefined (reading addChild)')", async () => {
    const { StructureIconsLayer } = await import(
      "../../../../src/client/graphics/layers/StructureIconsLayer"
    );

    // Minimal mock GameView: only what the constructor actually reads
    // (game.config().theme()) plus what tick() would read if the guard
    // failed to short-circuit (updatesSinceLastTick/unit/config) -- kept
    // present but never expected to be called, since tick() must return
    // before touching any of it.
    const updatesSinceLastTick = vi.fn();
    const mockGame = {
      config: () => ({ theme: () => ({}) }),
      updatesSinceLastTick,
      unit: vi.fn(),
      units: () => [],
    } as unknown as GameView;
    const mockEventBus = { on: vi.fn() } as unknown as EventBus;
    const mockUiState = {} as UIState;
    const mockTransformHandler = { scale: 1 } as unknown as TransformHandler;

    const layer = new StructureIconsLayer(
      mockGame,
      mockEventBus,
      mockUiState,
      mockTransformHandler,
    );

    // The exact crash window: init()/setupRenderer() never awaited, so
    // iconsStage/levelsStage/dotsStage are still unassigned here.
    expect(() => layer.tick()).not.toThrow();
    // The guard returns before touching the game at all -- proves this
    // was a genuine short-circuit, not an accidental no-op elsewhere.
    expect(updatesSinceLastTick).not.toHaveBeenCalled();
  });
});
