import {
  AbstractRenderer,
  GlShaderSystem,
  GlUboSystem,
  GlUniformGroupSystem,
  GpuUboSystem,
  ParticleBuffer,
  UboSystem,
} from "pixi.js";
import { describe, expect, test } from "vitest";
import { shouldPreserveGhostAfterBuild } from "../../../../src/client/graphics/layers/StructureIconsLayer";
import { UnitType } from "../../../../src/core/game/Game";

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
