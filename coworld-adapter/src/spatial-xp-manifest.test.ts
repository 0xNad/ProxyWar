import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSpatialXpManifest,
  SPATIAL_XP_ENV,
  SPATIAL_XP_GAME_NAMES,
  SPATIAL_XP_PROTOCOL_APPENDIX,
  SPATIAL_XP_VISIBILITY_MODEL,
} from "./build-spatial-xp-manifest.mjs";

const adapterRoot = process.cwd().endsWith("coworld-adapter")
  ? process.cwd()
  : resolve(process.cwd(), "coworld-adapter");
const canonical = JSON.parse(
  readFileSync(
    resolve(adapterRoot, "coworld/coworld_manifest_template.json"),
    "utf8",
  ),
);

describe("noncanonical spatial XP manifests", () => {
  it("builds source-identical off and on packages with only the on flags different", () => {
    const before = structuredClone(canonical);
    const control = buildSpatialXpManifest(canonical, "off");
    const treatment = buildSpatialXpManifest(canonical, "on");

    expect(canonical).toEqual(before);
    expect(control.game.name).toBe(SPATIAL_XP_GAME_NAMES.off);
    expect(treatment.game.name).toBe(SPATIAL_XP_GAME_NAMES.on);
    expect(control.game.runnable.env).toEqual(canonical.game.runnable.env);
    expect(treatment.game.runnable.env).toEqual({
      ...canonical.game.runnable.env,
      ...SPATIAL_XP_ENV,
    });
    expect(control.game.description).toContain("NONCANONICAL XP OFF");
    expect(treatment.game.description).toContain("NONCANONICAL XP");
    expect(treatment.game.description).toContain("never league-bind");
    expect(treatment.game.protocols.player.value).toBe(
      canonical.game.protocols.player.value + SPATIAL_XP_PROTOCOL_APPENDIX,
    );
    expect(treatment.game.docs.readme.value).toContain(
      SPATIAL_XP_VISIBILITY_MODEL,
    );
    expect(treatment.game.docs.readme.value).toContain("must never replace");

    expect(treatment.game.runnable.image).toBe(canonical.game.runnable.image);
    expect(treatment.game.runnable.run).toEqual(canonical.game.runnable.run);
    expect(treatment.game.config_schema).toEqual(canonical.game.config_schema);
    expect(treatment.game.results_schema).toEqual(
      canonical.game.results_schema,
    );
    expect(treatment.game.replay_viewer).toEqual(canonical.game.replay_viewer);
    expect(treatment.variants).toEqual(canonical.variants);
    expect(treatment.certification).toEqual(canonical.certification);
    expect(treatment.runnables).toEqual(canonical.runnables);
    expect(treatment.commissioners).toEqual(canonical.commissioners);

    const normalizedControl = structuredClone(control);
    const normalizedTreatment = structuredClone(treatment);
    normalizedControl.game.name = normalizedTreatment.game.name;
    normalizedControl.game.description = normalizedTreatment.game.description;
    normalizedControl.game.runnable.env = normalizedTreatment.game.runnable.env;
    normalizedControl.game.docs.readme = normalizedTreatment.game.docs.readme;
    expect(normalizedControl).toEqual(normalizedTreatment);
  });

  it("fails closed instead of deriving from an already-armed package", () => {
    const armed = structuredClone(canonical);
    armed.game.runnable.env.PROXYWAR_TUNE_SPATIAL_OBSERVATION = "1";
    expect(() => buildSpatialXpManifest(armed, "on")).toThrow(
      "already defines PROXYWAR_TUNE_SPATIAL_OBSERVATION",
    );
  });

  it("requires an exact arm instead of guessing", () => {
    expect(() =>
      buildSpatialXpManifest(canonical, "treatment" as never),
    ).toThrow('arm must be exactly "off" or "on"');
  });
});
