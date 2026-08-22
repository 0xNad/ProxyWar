import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCommanderXpOpenApiContract,
  COMMANDER_XP_CREATE_SCHEMA_NAME,
  COMMANDER_XP_OPENAPI_SHA256,
  COMMANDER_XP_ROSTER_SCHEMA_NAMES,
} from "./commander-xp-openapi-contract.mjs";

const fixture = {
  openapi: "3.1.0",
  paths: {
    "/v2/experience-requests": {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                $ref: `#/components/schemas/${COMMANDER_XP_CREATE_SCHEMA_NAME}`,
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      V2CreateExperienceRequestRequest: {
        type: "object",
        properties: { roster: { type: "array" } },
      },
      V2RosterParticipant: {
        type: "object",
        properties: { slot: { type: "integer", minimum: -1.0 } },
      },
      V2RosterPlayer: {
        type: "object",
        properties: { policy_ref: { type: "string" } },
      },
    },
  },
};

test("OpenAPI receipt binds one raw object and the exact ordered jq schema encodings", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "commander-xp-openapi-"),
  );
  const openApiPath = path.join(directory, "openapi.json");
  const raw = Buffer.from(JSON.stringify(fixture));
  fs.writeFileSync(openApiPath, raw);
  const schemaBytes = (name) =>
    execFileSync("jq", ["-cS", `.components.schemas["${name}"]`, openApiPath]);
  const receipt = buildCommanderXpOpenApiContract({
    openApiPath,
    fetchedAt: "2026-08-22T20:00:00.000Z",
    expected: {
      rawSha256: sha(raw),
      byteLength: raw.byteLength,
      createRequestSchemaSha256: sha(
        schemaBytes(COMMANDER_XP_CREATE_SCHEMA_NAME),
      ),
      rosterSchemasSha256: sha(
        Buffer.concat(COMMANDER_XP_ROSTER_SCHEMA_NAMES.map(schemaBytes)),
      ),
    },
  });
  assert.equal(receipt.rawSha256, sha(raw));
  assert.deepEqual(
    receipt.rosterSchemas.names,
    COMMANDER_XP_ROSTER_SCHEMA_NAMES,
  );
  assert.equal(receipt.coworldClientVersion, "0.1.42");
  assert.match(receipt.receiptSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(COMMANDER_XP_OPENAPI_SHA256, sha(raw));
});

test("OpenAPI receipt rejects the same schemas under different raw bytes", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "commander-xp-openapi-"),
  );
  const openApiPath = path.join(directory, "openapi.json");
  fs.writeFileSync(openApiPath, JSON.stringify(fixture, null, 2));
  assert.throws(
    () =>
      buildCommanderXpOpenApiContract({
        openApiPath,
        fetchedAt: "2026-08-22T20:00:00.000Z",
      }),
    /raw-byte identity mismatch/,
  );
});

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
