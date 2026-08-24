import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SPATIAL_XP_GAME_NAMES = Object.freeze({
  off: "proxywar-spatial-xp-off",
  structured: "proxywar-spatial-xp-structured",
  on: "proxywar-spatial-xp-on",
});
export const SPATIAL_XP_VISIBILITY_MODEL = "global-lockstep-public-map-v1";
export const SPATIAL_XP_STRUCTURED_ENV = Object.freeze({
  PROXYWAR_TUNE_SPATIAL_OBSERVATION: "1",
});
export const SPATIAL_XP_ENV = Object.freeze({
  ...SPATIAL_XP_STRUCTURED_ENV,
  PROXYWAR_TUNE_SPATIAL_MINIMAP: "1",
});
export const SPATIAL_XP_IMAGE_AUTHORITY_PAGE_ID =
  "proxywar-spatial-xp-image-authority";
export const SPATIAL_XP_IMAGE_AUTHORITY_STATUS = "unverified";
export const SPATIAL_XP_UPLOAD_BLOCKED = true;
const SPATIAL_XP_IMAGE_AUTHORITY_PAGE = Object.freeze({
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

export const SPATIAL_XP_PROTOCOL_APPENDIX =
  " Spatial XP observation contract: the off arm omits observation.spatial; " +
  "the structured arm enables schema-5 map and spatial context without its " +
  "minimap child; the on arm enables the same schema-5 context plus minimap " +
  "schema 2. Whenever observation.spatial is present, " +
  `visibilityModel is exactly ${SPATIAL_XP_VISIBILITY_MODEL}; facts are derived ` +
  "only from the global-lockstep, no-fog map state visible to every human " +
  "client. Schema 5 adds weighted rival/naval exposure. Its child minimap is " +
  "a deterministic 24x12 or adaptive 32x16 ownership/terrain summary with " +
  "bounded public structure and warship markers. Legend entries preserve " +
  "exact glyph, playerID, and isYou fields; redundant " +
  "display names remain available through username/visiblePlayers and are " +
  "omitted from the minimap rather than truncated. Spatial facts never add an " +
  "action or bypass LegalAction.id validation.";

function record(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

/**
 * Derive one noncanonical matched-XP arm from an already-rendered, exact-source
 * canonical manifest. The canonical package may be spatial-unarmed or may
 * already enable the structured observation alone; the builder removes the
 * two spatial keys before deriving the three exact arms. All three arms keep
 * the same image, variant, schema,
 * result, certification, and legal-action protocol. Separate packages are
 * required because Experience Requests cannot override a runnable environment.
 */
export function buildSpatialXpManifest(
  canonicalManifest,
  arm,
  expectedSourceSha,
) {
  if (!Object.hasOwn(SPATIAL_XP_GAME_NAMES, arm)) {
    throw new Error(
      'spatial XP arm must be exactly "off", "structured", or "on"',
    );
  }
  if (!/^[0-9a-f]{40}$/.test(expectedSourceSha)) {
    throw new Error("spatial XP expected source SHA must be 40 lowercase hex");
  }
  const canonical = record(canonicalManifest, "manifest");
  const unresolvedPlaceholder =
    JSON.stringify(canonical).match(/\{\{[^}]+\}\}/);
  if (unresolvedPlaceholder !== null) {
    throw new Error(
      `spatial XP input contains unresolved placeholder ${unresolvedPlaceholder[0]}`,
    );
  }
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
  const spatialObservation = env.PROXYWAR_TUNE_SPATIAL_OBSERVATION;
  const spatialMinimap = env.PROXYWAR_TUNE_SPATIAL_MINIMAP;
  const isUnarmed =
    spatialObservation === undefined && spatialMinimap === undefined;
  const isStructuredOnly =
    spatialObservation === "1" && spatialMinimap === undefined;
  if (!isUnarmed && !isStructuredOnly) {
    throw new Error(
      "spatial XP canonical input must be spatial-unarmed or structured-only",
    );
  }
  const baselineEnv = { ...env };
  delete baselineEnv.PROXYWAR_TUNE_SPATIAL_OBSERVATION;
  delete baselineEnv.PROXYWAR_TUNE_SPATIAL_MINIMAP;
  const protocols = record(canonicalGame.protocols, "manifest.game.protocols");
  const playerProtocol = record(
    protocols.player,
    "manifest.game.protocols.player",
  );
  const docs = record(canonicalGame.docs, "manifest.game.docs");
  const readme = record(docs.readme, "manifest.game.docs.readme");
  if (!Array.isArray(docs.pages)) {
    throw new Error("spatial XP input is missing release provenance pages");
  }
  if (
    docs.pages.some(
      (page) =>
        page !== null &&
        typeof page === "object" &&
        page.id === SPATIAL_XP_IMAGE_AUTHORITY_PAGE_ID,
    )
  ) {
    throw new Error(
      "spatial XP input already contains an image authority gate",
    );
  }
  const provenancePage = docs.pages.find(
    (page) =>
      page !== null &&
      typeof page === "object" &&
      page.id === "proxywar-release-provenance",
  );
  const provenanceContent = record(
    provenancePage?.content,
    "manifest.game.docs release provenance content",
  );
  const provenanceSourceShas =
    provenanceContent.type === "text" &&
    typeof provenanceContent.value === "string"
      ? [
          ...provenanceContent.value.matchAll(
            /(?:^|\n)source_sha=([0-9a-f]{40})(?=\n|$)/g,
          ),
        ].map((match) => match[1])
      : [];
  if (
    provenanceSourceShas.length !== 1 ||
    provenanceSourceShas[0] !== expectedSourceSha
  ) {
    throw new Error(
      `spatial XP source provenance must exactly match ${expectedSourceSha}`,
    );
  }
  if (
    typeof canonicalGame.description !== "string" ||
    typeof playerProtocol.value !== "string" ||
    typeof readme.value !== "string"
  ) {
    throw new Error("spatial XP input is missing canonical description text");
  }

  const candidate = structuredClone(canonical);
  const armEnv =
    arm === "off"
      ? baselineEnv
      : arm === "structured"
        ? { ...baselineEnv, ...SPATIAL_XP_STRUCTURED_ENV }
        : { ...baselineEnv, ...SPATIAL_XP_ENV };
  const armDescription =
    arm === "off"
      ? "spatial summary and minimap disabled"
      : arm === "structured"
        ? "structured spatial summary enabled; minimap disabled"
        : "structured spatial summary and minimap enabled";
  candidate.game.name = SPATIAL_XP_GAME_NAMES[arm];
  candidate.game.description =
    `${canonicalGame.description} ` +
    `[NONCANONICAL XP ${arm.toUpperCase()}: ${armDescription}; UPLOAD BLOCKED while image authority is unverified; never league-bind.]`;
  candidate.game.runnable.env = { ...armEnv };
  candidate.game.protocols.player.value =
    playerProtocol.value + SPATIAL_XP_PROTOCOL_APPENDIX;
  candidate.game.docs.readme.value =
    readme.value +
    "\n\n## Noncanonical Spatial XP\n\n" +
    SPATIAL_XP_PROTOCOL_APPENDIX.trim() +
    ` This package is the ${arm} arm and must never replace or bind the canonical Proxy War league package.\n\n` +
    "## Image Authority Gate\n\n" +
    "This generated manifest records image authority as unverified and must be treated as upload-blocked by the release procedure. A separate, independently fetched immutable Coworld authority receipt must bind the exact image digest and source SHA before Control may produce an upload candidate. Caller-authored inspection output is diagnostic only and cannot satisfy this gate. The marker is evidence for the hard stop; it does not make the JSON technically impossible to upload outside the controlled workflow.\n";
  candidate.game.docs.pages.push(
    structuredClone(SPATIAL_XP_IMAGE_AUTHORITY_PAGE),
  );
  return candidate;
}

function parseArgs(args) {
  const parsed = {};
  for (const arg of args) {
    const match = /^--(input|output|arm|source-sha)=(.+)$/.exec(arg);
    if (match === null || Object.hasOwn(parsed, match[1])) {
      throw new Error(
        "usage: node src/build-spatial-xp-manifest.mjs --arm=<off|structured|on> --source-sha=<40 lowercase hex> --input=<rendered canonical manifest> --output=<noncanonical manifest>",
      );
    }
    parsed[match[1]] = match[2];
  }
  if (
    !Object.hasOwn(SPATIAL_XP_GAME_NAMES, parsed.arm) ||
    parsed["source-sha"] === undefined ||
    parsed.input === undefined ||
    parsed.output === undefined
  ) {
    throw new Error(
      "usage: node src/build-spatial-xp-manifest.mjs --arm=<off|structured|on> --source-sha=<40 lowercase hex> --input=<rendered canonical manifest> --output=<noncanonical manifest>",
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
  const candidate = buildSpatialXpManifest(
    manifest,
    options.arm,
    options["source-sha"],
  );
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(candidate, null, 2)}\n`, {
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({ input, output, arm: options.arm, sourceSha: options["source-sha"], gameName: SPATIAL_XP_GAME_NAMES[options.arm], imageAuthorityStatus: SPATIAL_XP_IMAGE_AUTHORITY_STATUS, uploadBlocked: SPATIAL_XP_UPLOAD_BLOCKED })}\n`,
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
