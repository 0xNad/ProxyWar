import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_DEGRADATION_CAUSES } from "../../src/server/agents/AgentWireProtocol.ts";

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
    runnable: { env: Record<string, string> };
    protocols: { player: { value: string } };
    docs: {
      readme: { value: string };
      pages: Array<{
        id: string;
        content: { value: string };
      }>;
    };
    config_schema: {
      properties: Record<string, Record<string, unknown>>;
    };
    results_schema: {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
  };
  player: Array<{
    id: string;
    image: string;
    run: string[];
    description: string;
  }>;
  certification: {
    players: Array<{ player_id: string }>;
  };
}

const COMMANDER_PUBLIC_BASE =
  "ghcr.io/0xnad/proxywar-commander-public-base@sha256:75d5738231a79d10d224e7468b02f4531028b28486c39c13148e310be38fd360";
const COMMANDER_PUBLIC_BASE_PLAYER = "proxywar-commander-public-base";
const COMMANDER_PUBLIC_BASE_RUN = [
  "node",
  "/app/proxywar/coworld-adapter/src/starter-player.mjs",
];

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

const CANONICAL_DEGRADED_CAUSE_KEYS = [
  ...AGENT_DEGRADATION_CAUSES,
  "unreported",
].sort();

const CANONICAL_DEGRADED_CAUSE_COUNT_SCHEMA = {
  type: "integer",
  minimum: 0,
} as const;

const CANONICAL_DEGRADED_CAUSES_SCHEMA = {
  type: "object",
  maxProperties: CANONICAL_DEGRADED_CAUSE_KEYS.length,
  additionalProperties: false,
  properties: Object.fromEntries(
    CANONICAL_DEGRADED_CAUSE_KEYS.map((cause) => [
      cause,
      CANONICAL_DEGRADED_CAUSE_COUNT_SCHEMA,
    ]),
  ),
};

interface FiniteCauseMapSchema {
  readonly maxProperties: number;
  readonly additionalProperties: boolean;
  readonly properties: Record<string, unknown>;
}

function structurallyAdmitsCauseMap(
  schema: FiniteCauseMapSchema,
  value: Record<string, number>,
): boolean {
  const keys = Object.keys(value);
  return (
    schema.additionalProperties === false &&
    keys.length <= schema.maxProperties &&
    keys.every((key) => Object.hasOwn(schema.properties, key))
  );
}

const adapterDirectory = existsSync(resolve(process.cwd(), "coworld"))
  ? process.cwd()
  : resolve(process.cwd(), "coworld-adapter");
const manifestDirectory = resolve(adapterDirectory, "coworld");

describe("Coworld manifest spawn-preference protocol", () => {
  it("publishes and certifies the exact Commander public base without invoking the private policy", () => {
    const manifest = JSON.parse(
      readFileSync(`${manifestDirectory}/coworld_manifest.json`, "utf8"),
    ) as ManifestProtocolText;
    const template = JSON.parse(
      readFileSync(
        `${manifestDirectory}/coworld_manifest_template.json`,
        "utf8",
      ),
    ) as ManifestProtocolText;
    const compose = readFileSync(
      resolve(adapterDirectory, "coworld_compose.yaml"),
      "utf8",
    );

    expect(
      manifest.player.find(({ id }) => id === COMMANDER_PUBLIC_BASE_PLAYER),
    ).toMatchObject({
      image: COMMANDER_PUBLIC_BASE,
      run: COMMANDER_PUBLIC_BASE_RUN,
    });
    expect(
      template.player.find(({ id }) => id === COMMANDER_PUBLIC_BASE_PLAYER),
    ).toMatchObject({
      image: "{{COMMANDER_PUBLIC_BASE_IMAGE}}",
      run: COMMANDER_PUBLIC_BASE_RUN,
    });
    expect(
      manifest.certification.players.map(({ player_id }) => player_id),
    ).toEqual(["proxywar-starter-websocket", COMMANDER_PUBLIC_BASE_PLAYER]);
    expect(
      template.certification.players.map(({ player_id }) => player_id),
    ).toEqual(["proxywar-starter-websocket", COMMANDER_PUBLIC_BASE_PLAYER]);
    expect(compose).toContain("commander-public-base:");
    expect(compose).toContain(`image: ${COMMANDER_PUBLIC_BASE}`);
  });

  it.each(["coworld_manifest.json", "coworld_manifest_template.json"])(
    "%s enables structured spatial observation without enabling the minimap",
    (manifestName) => {
      const manifest = JSON.parse(
        readFileSync(`${manifestDirectory}/${manifestName}`, "utf8"),
      ) as ManifestProtocolText;

      expect(manifest.game.runnable.env).toMatchObject({
        PROXYWAR_TUNE_SPATIAL_OBSERVATION: "1",
      });
      expect(manifest.game.runnable.env).not.toHaveProperty(
        "PROXYWAR_TUNE_SPATIAL_MINIMAP",
      );
      const spatialPage = manifest.game.docs.pages.find(
        (page) => page.id === "proxywar-structured-spatial-observation",
      );
      expect(spatialPage?.content.value).toContain(
        "PROXYWAR_TUNE_SPATIAL_OBSERVATION=1",
      );
      expect(spatialPage?.content.value).toContain(
        "PROXYWAR_TUNE_SPATIAL_MINIMAP absent",
      );
      expect(spatialPage?.content.value).toContain(
        "global-lockstep-public-map-v1",
      );
      expect(spatialPage?.content.value).toContain(
        "coordinates, glyphs, and player IDs are never executable actions",
      );
    },
  );

  it("covers every canonical, template, and FFA manifest", () => {
    const discovered = readdirSync(manifestDirectory)
      .filter((name) => /^coworld_manifest.*\.json$/.test(name))
      .sort();

    expect(discovered).toEqual([...MANIFEST_NAMES]);
  });

  it.each(MANIFEST_NAMES)(
    "%s does not promise a decisive winner or fabricated social dynamics",
    (manifestName) => {
      const source = readFileSync(
        `${manifestDirectory}/${manifestName}`,
        "utf8",
      );

      expect(source).not.toContain("a decisive winner normally arrives");
      expect(source).not.toContain("dynamics emerge");
    },
  );

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
      expect(machineProtocol).toContain("selectedMessageActionId?");
      expect(machineProtocol).toContain("messageText?");
      expect(machineProtocol).toContain("the two fields must be sent together");
      expect(machineProtocol).toContain(
        "selectedMessageActionId must exactly match one offered message id",
      );
      expect(machineProtocol).toContain(
        "messageText must be nonblank plain text of at most 280 characters",
      );
      expect(machineProtocol).toContain(
        "This optional comms slot is simulation-inert and independent of the gameplay, spawn, and structured-deal slots",
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

  it.each(MANIFEST_NAMES)(
    "%s rejects an adversarial unknown degraded cause key",
    (manifestName) => {
      const manifest = JSON.parse(
        readFileSync(`${manifestDirectory}/${manifestName}`, "utf8"),
      ) as ManifestProtocolText;
      const causeSchema = manifest.game.results_schema.properties
        .degraded_causes as FiniteCauseMapSchema;

      expect(
        structurallyAdmitsCauseMap(causeSchema, {
          "plan-rejected": 1,
          unreported: 2,
        }),
      ).toBe(true);
      expect(
        structurallyAdmitsCauseMap(causeSchema, {
          "plan-rejected-ish": 1,
        }),
      ).toBe(false);
    },
  );
});
