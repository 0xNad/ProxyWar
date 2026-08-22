import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildSpatialXpManifest,
  SPATIAL_XP_ENV,
  SPATIAL_XP_GAME_NAMES,
  SPATIAL_XP_IMAGE_AUTHORITY_PAGE_ID,
  SPATIAL_XP_IMAGE_AUTHORITY_STATUS,
  SPATIAL_XP_PROTOCOL_APPENDIX,
  SPATIAL_XP_UPLOAD_BLOCKED,
  SPATIAL_XP_VISIBILITY_MODEL,
} from "./build-spatial-xp-manifest.mjs";

const adapterRoot = process.cwd().endsWith("coworld-adapter")
  ? process.cwd()
  : resolve(process.cwd(), "coworld-adapter");
const SOURCE_SHA = "a69175a30577b3e516f09a2cb0960d4d129b3f33";
const rawTemplate = readFileSync(
  resolve(adapterRoot, "coworld/coworld_manifest_template.json"),
  "utf8",
);
const canonical = JSON.parse(
  rawTemplate
    .replaceAll("{{GAME_IMAGE}}", "proxywar-coworld:exact-source-test")
    .replaceAll(
      "{{RUNNABLES_IMAGE}}",
      "proxywar-coworld-runnables:exact-source-test",
    )
    .replaceAll(
      "{{COMMISSIONER_IMAGE}}",
      "proxywar-coworld-commissioner:exact-source-test",
    )
    .replaceAll("{{SOURCE_SHA}}", SOURCE_SHA),
);
canonical.game.docs.pages.find(
  (page: { id?: string }) => page.id === "proxywar-release-provenance",
).content.value =
  `source_sha=${SOURCE_SHA}\n` +
  `merge_sha=${SOURCE_SHA}\n` +
  "main_ci_run_id=32570402138";

describe("noncanonical spatial XP manifests", () => {
  it("builds source-identical off and on packages with only the on flags different", () => {
    const before = structuredClone(canonical);
    const control = buildSpatialXpManifest(canonical, "off", SOURCE_SHA);
    const treatment = buildSpatialXpManifest(canonical, "on", SOURCE_SHA);

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
    expect(SPATIAL_XP_IMAGE_AUTHORITY_STATUS).toBe("unverified");
    expect(SPATIAL_XP_UPLOAD_BLOCKED).toBe(true);
    expect(treatment.game.description).toContain("UPLOAD BLOCKED");
    expect(treatment.game.docs.readme.value).toContain(
      "Caller-authored inspection output is diagnostic only",
    );
    expect(treatment.game.docs.readme.value).toContain(
      "does not make the JSON technically impossible to upload",
    );
    expect(
      treatment.game.docs.pages.find(
        (page: { id?: string }) =>
          page.id === SPATIAL_XP_IMAGE_AUTHORITY_PAGE_ID,
      ),
    ).toEqual({
      id: SPATIAL_XP_IMAGE_AUTHORITY_PAGE_ID,
      title: "Spatial XP image authority gate",
      content: {
        type: "text",
        value:
          "status=unverified\n" +
          "upload_blocked=true\n" +
          "required_evidence=independently_fetched_immutable_coworld_authority_receipt",
      },
    });

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
    expect(() => buildSpatialXpManifest(armed, "on", SOURCE_SHA)).toThrow(
      "already defines PROXYWAR_TUNE_SPATIAL_OBSERVATION",
    );
  });

  it("requires an exact arm instead of guessing", () => {
    expect(() =>
      buildSpatialXpManifest(canonical, "treatment" as never, SOURCE_SHA),
    ).toThrow('arm must be exactly "off" or "on"');
  });

  it("rejects unresolved templates and stale source provenance", () => {
    expect(() =>
      buildSpatialXpManifest(JSON.parse(rawTemplate), "on", SOURCE_SHA),
    ).toThrow("unresolved placeholder");
    expect(() =>
      buildSpatialXpManifest(canonical, "on", "b".repeat(40)),
    ).toThrow("source provenance must exactly match");

    const ambiguous = structuredClone(canonical);
    ambiguous.game.docs.pages[0].content.value += `\nsource_sha=${SOURCE_SHA}`;
    expect(() => buildSpatialXpManifest(ambiguous, "on", SOURCE_SHA)).toThrow(
      "source provenance must exactly match",
    );
  });
});
