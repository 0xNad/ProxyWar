import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const MANIFEST_NAMES = [
  "coworld_manifest.json",
  "coworld_manifest_ffa10p.json",
  "coworld_manifest_ffa12p.json",
  "coworld_manifest_ffa12p_ab_off.json",
  "coworld_manifest_ffa12p_ab_on.json",
  "coworld_manifest_ffa16p.json",
  "coworld_manifest_ffa4p.json",
  "coworld_manifest_ffa8p.json",
  "coworld_manifest_pr6.json",
  "coworld_manifest_template.json",
] as const;

interface ManifestProtocolText {
  game: {
    protocols: { player: { value: string } };
    docs: { readme: { value: string } };
    config_schema: {
      properties: Record<string, Record<string, unknown>>;
    };
    results_schema: {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
  };
}

const CANONICAL_RESULT_REQUIRED = [
  "seed",
  "game_id",
  "scores",
  "winner_slot",
  "turn_count",
  "tick",
  "decision_count",
  "accepted_decision_count",
  "fallback_count",
  "players",
] as const;

const CANONICAL_RESULT_PROPERTIES = [
  "accepted_decision_count",
  "decision_count",
  "degraded_causes",
  "degraded_count",
  "fallback_count",
  "game_id",
  "players",
  "scores",
  "seed",
  "tick",
  "turn_count",
  "winner_slot",
] as const;

const CANONICAL_SEED_SCHEMA = {
  type: ["integer", "null"],
  minimum: 0,
  maximum: 11881375,
} as const;

const CANONICAL_GAME_ID_SCHEMA = {
  type: "string",
  pattern: "^[A-Za-z0-9]{8}$",
} as const;

const CANONICAL_DEGRADED_CAUSES_SCHEMA = {
  type: "object",
  additionalProperties: {
    type: "integer",
    minimum: 0,
  },
} as const;

const adapterDirectory = existsSync(resolve(process.cwd(), "coworld"))
  ? process.cwd()
  : resolve(process.cwd(), "coworld-adapter");
const manifestDirectory = resolve(adapterDirectory, "coworld");

describe("Coworld manifest spawn-preference protocol", () => {
  it("covers every canonical, template, and FFA manifest", () => {
    const discovered = readdirSync(manifestDirectory)
      .filter((name) => /^coworld_manifest.*\.json$/.test(name))
      .sort();

    expect(discovered).toEqual([...MANIFEST_NAMES]);
  });

  it.each(MANIFEST_NAMES)(
    "%s keeps spawn ranking independent from gameplay-action batching",
    (manifestName) => {
      const manifest = JSON.parse(
        readFileSync(`${manifestDirectory}/${manifestName}`, "utf8"),
      ) as ManifestProtocolText;
      const machineProtocol = manifest.game.protocols.player.value;
      const readme = manifest.game.docs.readme.value;
      const episodeIndexSchema =
        manifest.game.config_schema.properties.episodeIndex;

      expect(episodeIndexSchema).toMatchObject({
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      });

      expect(machineProtocol).toContain(
        "protocol:{maxActionsPerDecision,maxSpawnPreferences:16}",
      );
      expect(machineProtocol).toContain(
        "protocol.maxSpawnPreferences is independent of protocol.maxActionsPerDecision",
      );
      expect(machineProtocol).toContain("spawnPreferenceLegalActionIds?");
      expect(machineProtocol).toContain(
        "exact offered spawn LegalAction.id values with selectedLegalActionId first",
      );
      expect(machineProtocol).toContain(
        "independent of selectedLegalActionIds action batching",
      );

      expect(readme).toContain(
        "independently advertises protocol.maxActionsPerDecision",
      );
      expect(readme).toContain("protocol.maxSpawnPreferences=16");
      expect(readme).toContain("optional spawnPreferenceLegalActionIds");
      expect(readme).toContain(
        "exact offered spawn LegalAction.id values with selectedLegalActionId first",
      );
      expect(readme).toContain(
        "independent of selectedLegalActionIds gameplay-action batching",
      );
      expect(readme).toContain(
        "never put the spawn ranking in selectedLegalActionIds",
      );
    },
  );

  it.each(MANIFEST_NAMES)(
    "%s accepts the exact runtime provenance fields under its closed result schema",
    (manifestName) => {
      const manifest = JSON.parse(
        readFileSync(`${manifestDirectory}/${manifestName}`, "utf8"),
      ) as ManifestProtocolText;
      const resultSchema = manifest.game.results_schema;

      expect(resultSchema.additionalProperties).toBe(false);
      expect(resultSchema.required).toEqual(CANONICAL_RESULT_REQUIRED);
      expect(Object.keys(resultSchema.properties).sort()).toEqual(
        CANONICAL_RESULT_PROPERTIES,
      );
      expect(resultSchema.properties.seed).toEqual(CANONICAL_SEED_SCHEMA);
      expect(resultSchema.properties.game_id).toEqual(CANONICAL_GAME_ID_SCHEMA);
      expect(resultSchema.properties.degraded_causes).toEqual(
        CANONICAL_DEGRADED_CAUSES_SCHEMA,
      );
      expect(resultSchema.required).not.toContain("degraded_causes");
    },
  );
});
