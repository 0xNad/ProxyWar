import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMMANDER_XP_BASE_MANIFEST_SHA256 =
  "560648b1e995f981d3c9e6f146065bfcd88f592ba57efae10cfff9f6c22e2095";
export const COMMANDER_XP_EVAL_COWORLD_NAME = "proxywar-commander-xp-eval";

export function commanderXpEvalManifest(base, { image, version }) {
  if (base?.game?.name !== "proxywar") {
    throw new Error("Commander XP eval manifest base is not canonical proxywar");
  }
  if (!/^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error("Commander XP eval game image must use an immutable digest");
  }
  if (!/^0\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
    throw new Error("Commander XP eval version is invalid");
  }
  const sourceVariant = base.variants.find(
    (entry) => entry.id === "tournament-4p-pangaea",
  );
  if (sourceVariant === undefined) {
    throw new Error("Commander XP eval variant is missing");
  }
  const configSchema = structuredClone(base.game.config_schema);
  configSchema.required = [
    ...new Set([
      ...configSchema.required,
      "commander_xp_phase",
      "commander_xp_run_key",
    ]),
  ];
  configSchema.properties.commander_xp_phase = {
    type: "string",
    enum: ["provider-preflight", "canary", "confirmatory"],
  };
  configSchema.properties.commander_xp_run_key = {
    type: "string",
    pattern:
      "^commander-xp-v2/[A-Za-z0-9._-]+/(provider-preflight|canary|confirmatory)/r[0-9]{2}/(A|B|C)$",
  };
  const game = {
    name: COMMANDER_XP_EVAL_COWORLD_NAME,
    version,
    description:
      "Eval-only StrategicCommander matched experiment package. Never bind to a product league.",
    owner: base.game.owner,
    config_schema: configSchema,
    results_schema: structuredClone(base.game.results_schema),
    protocols: structuredClone(base.game.protocols),
    runnable: {
      ...structuredClone(base.game.runnable),
      image,
      env: {
        PROXYWAR_COMMANDER_XP_GAME_EVIDENCE: "1",
        PROXYWAR_TUNE_STRUCTURED_DEALS: "1",
        PROXYWAR_TUNE_FREETEXT_MESSAGES: "1",
        PROXYWAR_TUNE_SPATIAL_OBSERVATION: "0",
        PROXYWAR_TUNE_SPATIAL_MINIMAP: "0",
      },
    },
  };
  const variant = structuredClone(sourceVariant);
  variant.game_config.max_decision_steps = 360;
  variant.game_config.turns_per_decision_step = 100;
  variant.game_config.max_decision_ms = 15_000;
  variant.game_config.episode_timeout_seconds = 6_000;
  variant.game_config.commander_xp_phase = "canary";
  variant.game_config.commander_xp_run_key =
    "commander-xp-v2/manifest-default/canary/r00/A";
  variant.description =
    "Eval-only 4-seat Pangaea configuration. Gameplay uses 360 x 100 cadence and requires a terminal winner; the excluded provider preflight overrides its phase and cadence.";
  const certification = structuredClone(base.certification);
  certification.game_config.commander_xp_phase = "provider-preflight";
  certification.game_config.commander_xp_run_key =
    "commander-xp-v2/manifest-cert/provider-preflight/r00/C";
  const manifest = {
    $schema: base.$schema,
    tags: ["evaluation"],
    game,
    variants: [variant],
    certification,
    episode_timeout_minutes: 100,
    commissioner: [],
    player: [],
    reporter: [],
    grader: [],
    diagnoser: [],
    optimizer: [],
  };
  return manifest;
}

async function main() {
  const args = new Map(
    process.argv.slice(2).map((entry) => {
      const index = entry.indexOf("=");
      if (index < 0) throw new Error("manifest args must use --key=value");
      return [entry.slice(0, index), entry.slice(index + 1)];
    }),
  );
  const basePath = path.resolve(
    args.get("--base") ?? "coworld/coworld_manifest.json",
  );
  const outputPath = path.resolve(
    args.get("--output") ?? "tmp/commander-xp-eval/coworld_manifest.json",
  );
  const baseBytes = await fs.readFile(basePath);
  if (sha256(baseBytes) !== COMMANDER_XP_BASE_MANIFEST_SHA256) {
    throw new Error("Commander XP base manifest hash mismatch");
  }
  const manifest = commanderXpEvalManifest(JSON.parse(baseBytes.toString()), {
    image: args.get("--image") ?? "",
    version: args.get("--version") ?? "",
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  await fs.writeFile(outputPath, output, { flag: "wx" });
  console.log(
    JSON.stringify({
      outputPath,
      manifestSha256: sha256(new TextEncoder().encode(output)),
      gameName: manifest.game.name,
      gameVersion: manifest.game.version,
      gameImage: manifest.game.runnable.image,
    }),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "manifest failed");
    process.exit(1);
  });
}
