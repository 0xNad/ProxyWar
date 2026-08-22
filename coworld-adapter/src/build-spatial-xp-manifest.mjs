import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SPATIAL_XP_GAME_NAMES = Object.freeze({
  off: "proxywar-spatial-xp-off",
  on: "proxywar-spatial-xp-on",
});
export const SPATIAL_XP_VISIBILITY_MODEL = "global-lockstep-public-map-v1";
export const SPATIAL_XP_ENV = Object.freeze({
  PROXYWAR_TUNE_SPATIAL_OBSERVATION: "1",
  PROXYWAR_TUNE_SPATIAL_MINIMAP: "1",
});

export const SPATIAL_XP_PROTOCOL_APPENDIX =
  " Spatial XP observation contract: the off arm omits observation.spatial; " +
  "when observation.spatial is present in the on arm, " +
  `visibilityModel is exactly ${SPATIAL_XP_VISIBILITY_MODEL}; facts are derived ` +
  "only from the global-lockstep, no-fog map state visible to every human " +
  "client. The optional minimap is a deterministic 24x12 summary. Spatial " +
  "facts never add an action or bypass LegalAction.id validation.";

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

/**
 * Derive one noncanonical matched-XP arm from an already-rendered, exact-source
 * canonical manifest. Both arms keep the same image, variant, schema, result,
 * certification, and legal-action protocol. Only the on arm adds spatial env
 * flags; separate packages are required because Experience Requests cannot
 * override a Coworld runnable's environment.
 */
export function buildSpatialXpManifest(canonicalManifest, arm) {
  if (arm !== "off" && arm !== "on") {
    throw new Error('spatial XP arm must be exactly "off" or "on"');
  }
  const canonical = record(canonicalManifest, "manifest");
  const canonicalGame = record(canonical.game, "manifest.game");
  if (canonicalGame.name !== "proxywar") {
    throw new Error(
      `spatial XP input must be canonical proxywar, received ${JSON.stringify(canonicalGame.name)}`,
    );
  }
  const runnable = record(canonicalGame.runnable, "manifest.game.runnable");
  if (runnable.type !== "game" || typeof runnable.image !== "string") {
    throw new Error(
      "spatial XP input must contain the canonical game runnable",
    );
  }
  const env = record(runnable.env ?? {}, "manifest.game.runnable.env");
  for (const key of Object.keys(SPATIAL_XP_ENV)) {
    if (Object.hasOwn(env, key)) {
      throw new Error(
        `spatial XP refuses an input that already defines ${key}`,
      );
    }
  }
  const protocols = record(canonicalGame.protocols, "manifest.game.protocols");
  const playerProtocol = record(
    protocols.player,
    "manifest.game.protocols.player",
  );
  const docs = record(canonicalGame.docs, "manifest.game.docs");
  const readme = record(docs.readme, "manifest.game.docs.readme");
  if (
    typeof canonicalGame.description !== "string" ||
    typeof playerProtocol.value !== "string" ||
    typeof readme.value !== "string"
  ) {
    throw new Error("spatial XP input is missing canonical description text");
  }

  const candidate = structuredClone(canonical);
  candidate.game.name = SPATIAL_XP_GAME_NAMES[arm];
  candidate.game.description =
    `${canonicalGame.description} ` +
    `[NONCANONICAL XP ${arm.toUpperCase()}: spatial summary and minimap ${arm === "on" ? "enabled" : "disabled"}; never league-bind.]`;
  candidate.game.runnable.env =
    arm === "on" ? { ...env, ...SPATIAL_XP_ENV } : { ...env };
  candidate.game.protocols.player.value =
    playerProtocol.value + SPATIAL_XP_PROTOCOL_APPENDIX;
  candidate.game.docs.readme.value =
    readme.value +
    "\n\n## Noncanonical Spatial XP\n\n" +
    SPATIAL_XP_PROTOCOL_APPENDIX.trim() +
    ` This package is the ${arm} arm and must never replace or bind the canonical Proxy War league package.\n`;
  return candidate;
}

function parseArgs(args) {
  const parsed = {};
  for (const arg of args) {
    const match = /^--(input|output|arm)=(.+)$/.exec(arg);
    if (match === null || Object.hasOwn(parsed, match[1])) {
      throw new Error(
        "usage: node src/build-spatial-xp-manifest.mjs --arm=<off|on> --input=<rendered canonical manifest> --output=<noncanonical manifest>",
      );
    }
    parsed[match[1]] = match[2];
  }
  if (
    (parsed.arm !== "off" && parsed.arm !== "on") ||
    parsed.input === undefined ||
    parsed.output === undefined
  ) {
    throw new Error(
      "usage: node src/build-spatial-xp-manifest.mjs --arm=<off|on> --input=<rendered canonical manifest> --output=<noncanonical manifest>",
    );
  }
  return parsed;
}

async function main(args) {
  const options = parseArgs(args);
  const input = path.resolve(options.input);
  const output = path.resolve(options.output);
  if (input === output)
    throw new Error("spatial XP output must not replace input");
  const manifest = JSON.parse(await fs.readFile(input, "utf8"));
  const candidate = buildSpatialXpManifest(manifest, options.arm);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(candidate, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({ input, output, arm: options.arm, gameName: SPATIAL_XP_GAME_NAMES[options.arm] })}\n`,
  );
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
