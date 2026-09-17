import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const COMMANDER_XP_OPENAPI_URL =
  "https://softmax.com/api/observatory/openapi.json";
export const COMMANDER_XP_OPENAPI_SHA256 =
  "07ef3f028f90a5f4eaf225a390461c7da0e2b68f00427a24c54eb211ac135c08";
export const COMMANDER_XP_OPENAPI_BYTES = 418_852;
export const COMMANDER_XP_CREATE_SCHEMA_NAME =
  "V2CreateExperienceRequestRequest";
export const COMMANDER_XP_CREATE_SCHEMA_SHA256 =
  "3d1b9e7969455eb92f2ee97164ce153517a1d6909bcbb1031b6141bb5050b25a";
export const COMMANDER_XP_ROSTER_SCHEMA_NAMES = [
  "V2RosterParticipant",
  "V2RosterPlayer",
];
export const COMMANDER_XP_ROSTER_SCHEMAS_SHA256 =
  "edfa02dc9fcd7513ce91d4f5bbc6517f1a56d086da32ca37590ab2c29cf255c1";
export const COMMANDER_XP_SCHEMA_ENCODING =
  "jq-cS-utf8-compact-sorted-json-with-terminal-lf";
export const COMMANDER_XP_ROSTER_ENCODING =
  "ordered-concatenation-of-two-jq-cS-utf8-records-with-terminal-lf";

export function buildCommanderXpOpenApiContract({
  openApiPath,
  fetchedAt,
  expected = {},
}) {
  const bytes = fs.readFileSync(openApiPath);
  const rawSha256 = sha256(bytes);
  const byteLength = bytes.byteLength;
  const expectedRawSha256 = expected.rawSha256 ?? COMMANDER_XP_OPENAPI_SHA256;
  const expectedByteLength = expected.byteLength ?? COMMANDER_XP_OPENAPI_BYTES;
  if (
    rawSha256 !== expectedRawSha256 ||
    byteLength !== expectedByteLength ||
    !Number.isFinite(Date.parse(fetchedAt))
  ) {
    throw new Error("Commander XP OpenAPI raw-byte identity mismatch");
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (
    parsed.openapi !== "3.1.0" ||
    parsed.paths?.["/v2/experience-requests"]?.post?.requestBody?.content?.[
      "application/json"
    ]?.schema?.$ref !==
      `#/components/schemas/${COMMANDER_XP_CREATE_SCHEMA_NAME}`
  ) {
    throw new Error("Commander XP OpenAPI endpoint schema mismatch");
  }
  const createSchemaBytes = jqSchema(
    openApiPath,
    COMMANDER_XP_CREATE_SCHEMA_NAME,
  );
  const rosterSchemaBytes = Buffer.concat(
    COMMANDER_XP_ROSTER_SCHEMA_NAMES.map((name) => jqSchema(openApiPath, name)),
  );
  const createRequestSchemaSha256 = sha256(createSchemaBytes);
  const rosterSchemasSha256 = sha256(rosterSchemaBytes);
  if (
    createRequestSchemaSha256 !==
      (expected.createRequestSchemaSha256 ??
        COMMANDER_XP_CREATE_SCHEMA_SHA256) ||
    rosterSchemasSha256 !==
      (expected.rosterSchemasSha256 ?? COMMANDER_XP_ROSTER_SCHEMAS_SHA256)
  ) {
    throw new Error("Commander XP OpenAPI required schema mismatch");
  }
  const body = {
    schemaVersion: 2,
    authority: "softmax-public-openapi-exact-bytes-v1",
    url: COMMANDER_XP_OPENAPI_URL,
    fetchedAt,
    byteLength,
    rawSha256,
    coworldClientVersion: "0.1.42",
    createRequestSchema: {
      name: COMMANDER_XP_CREATE_SCHEMA_NAME,
      encoding: COMMANDER_XP_SCHEMA_ENCODING,
      sha256: createRequestSchemaSha256,
    },
    rosterSchemas: {
      names: COMMANDER_XP_ROSTER_SCHEMA_NAMES,
      encoding: COMMANDER_XP_ROSTER_ENCODING,
      sha256: rosterSchemasSha256,
    },
  };
  return {
    ...body,
    receiptSha256: sha256(Buffer.from(canonicalJson(body))),
  };
}

function jqSchema(openApiPath, name) {
  return execFileSync(
    "jq",
    ["-cS", `.components.schemas["${name}"]`, openApiPath],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}

function canonicalJson(value) {
  const sort = (entry) => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, sort(entry[key])]),
      );
    }
    return entry;
  };
  return JSON.stringify(sort(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function main() {
  const [openApiPath, outputPath, fetchedAt] = process.argv.slice(2);
  if (!openApiPath || !outputPath || !fetchedAt) {
    throw new Error(
      "usage: commander-xp-openapi-contract.mjs <openapi.json> <receipt.json> <fetched-at>",
    );
  }
  const receipt = buildCommanderXpOpenApiContract({
    openApiPath: path.resolve(openApiPath),
    fetchedAt,
  });
  fs.writeFileSync(
    path.resolve(outputPath),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: "wx" },
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
