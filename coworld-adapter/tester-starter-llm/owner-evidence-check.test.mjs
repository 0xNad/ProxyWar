import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, "owner-evidence-check.mjs");
const PREFIX = "PROXYWAR_OWNER_CAPABILITY_EVIDENCE ";
const body = "Hold the shared border exactly.";
const digest = createHash("sha256").update(body, "utf8").digest("hex");

function common(ownPlayerID, requestID) {
  return {
    requestID,
    slot: ownPlayerID === "P_A" ? 0 : 1,
    ownPlayerID,
    selectedLegalActionID: "hold",
    selectedLegalActionOffered: true,
  };
}

function validEvents() {
  return [
    {
      kind: "deal_selection",
      ...common("P_A", "req_sender"),
      offeredDealActionIDs: ["deal_accept:deal:P_A:P_B:nap:4"],
      selectedDealActionID: "deal_accept:deal:P_A:P_B:nap:4",
    },
    {
      kind: "message_selection",
      ...common("P_A", "req_sender"),
      offeredMessageActionIDs: ["message:P_B"],
      selectedMessageActionID: "message:P_B",
      selectedMessageRecipientID: "P_B",
      messageBodySHA256: digest,
      messageBodyUTF8Bytes: Buffer.byteLength(body, "utf8"),
      messageBodyUTF16CodeUnits: body.length,
    },
    {
      kind: "spatial_observation",
      ...common("P_A", "req_sender"),
      present: false,
    },
    {
      kind: "message_observation",
      ...common("P_B", "req_recipient"),
      senderID: "P_A",
      senderTurn: 42,
      messageBodySHA256: digest,
      messageBodyUTF8Bytes: Buffer.byteLength(body, "utf8"),
      messageBodyUTF16CodeUnits: body.length,
    },
    {
      kind: "spatial_observation",
      ...common("P_B", "req_recipient"),
      present: false,
    },
  ];
}

function runCheckerFiles(
  eventSets,
  spatial = "absent",
  { aliasFirst = false, duplicateFirst = false } = {},
) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "proxywar-owner-evidence-"),
  );
  const logs = eventSets.map((events, index) => {
    const log = path.join(directory, `policy-${index}.log`);
    writeFileSync(
      log,
      `${events.map((event) => `${PREFIX}${JSON.stringify(event)}`).join("\n")}\n`,
      "utf8",
    );
    return log;
  });
  const result = spawnSync(
    process.execPath,
    [
      CHECKER,
      "--deals=required",
      "--messages=required",
      `--spatial=${spatial}`,
      ...logs,
      ...(duplicateFirst ? [logs[0]] : []),
      ...(aliasFirst ? [`${directory}/./policy-0.log`] : []),
    ],
    {
      encoding: "utf8",
    },
  );
  rmSync(directory, { recursive: true, force: true });
  return result;
}

function runChecker(events, spatial = "absent") {
  return runCheckerFiles([events], spatial);
}

test("owner evidence checker accepts bounded rich spatial provenance", () => {
  const events = validEvents();
  for (const event of events.filter(
    (candidate) => candidate.kind === "spatial_observation",
  )) {
    Object.assign(event, {
      present: true,
      schemaVersion: 3,
      visibilityModel: "global-lockstep-public-map-v1",
      minimapPresent: true,
      minimapSchemaVersion: 1,
      serializedUTF8Bytes: 8_192,
    });
  }
  const result = runChecker(events, "rich-v3-minimap");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).spatial, "rich-v3-minimap");
});

test("owner evidence checker rejects incomplete or downgraded rich spatial evidence", () => {
  for (const mutation of [
    (event) => {
      for (const key of [
        "schemaVersion",
        "visibilityModel",
        "minimapPresent",
        "minimapSchemaVersion",
        "serializedUTF8Bytes",
      ]) {
        delete event[key];
      }
      event.present = false;
    },
    (event) => delete event.minimapPresent,
    (event) => {
      event.minimapPresent = "yes";
    },
    (event) => {
      event.minimapPresent = false;
    },
    (event) => {
      event.schemaVersion = 1;
    },
  ]) {
    const events = validEvents();
    for (const event of events.filter(
      (candidate) => candidate.kind === "spatial_observation",
    )) {
      Object.assign(event, {
        present: true,
        schemaVersion: 3,
        visibilityModel: "global-lockstep-public-map-v1",
        minimapPresent: true,
        minimapSchemaVersion: 1,
        serializedUTF8Bytes: 8_192,
      });
    }
    mutation(events[2]);
    const result = runChecker(events, "rich-v3-minimap");
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /malformed spatial|absent policy|bounded minimap|non-v3|provenance/u,
    );
  }
});

test("owner evidence checker requires rich spatial evidence in every supplied file", () => {
  const events = validEvents();
  for (const event of events.filter(
    (candidate) => candidate.kind === "spatial_observation",
  )) {
    Object.assign(event, {
      present: true,
      schemaVersion: 3,
      visibilityModel: "global-lockstep-public-map-v1",
      minimapPresent: true,
      minimapSchemaVersion: 1,
      serializedUTF8Bytes: 8_192,
    });
  }
  const missing = runCheckerFiles([events, []], "rich-v3-minimap");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /record is missing/u);

  const forged = structuredClone(events);
  forged.find(
    (event) => event.kind === "spatial_observation",
  ).selectedLegalActionOffered = false;
  const notOffered = runChecker(forged, "rich-v3-minimap");
  assert.equal(notOffered.status, 1);
  assert.match(
    notOffered.stderr,
    /primary action was not recorded as offered/u,
  );

  const duplicate = runCheckerFiles([events], "rich-v3-minimap", {
    duplicateFirst: true,
  });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /resolve to a unique file/u);

  const alias = runCheckerFiles([events], "rich-v3-minimap", {
    aliasFirst: true,
  });
  assert.equal(alias.status, 1);
  assert.match(alias.stderr, /resolve to a unique file/u);
});

test("owner evidence checker distinguishes complete rich v5 minimap evidence", () => {
  const events = validEvents();
  for (const event of events.filter(
    (candidate) => candidate.kind === "spatial_observation",
  )) {
    Object.assign(event, {
      present: true,
      schemaVersion: 5,
      visibilityModel: "global-lockstep-public-map-v1",
      minimapPresent: true,
      minimapSchemaVersion: 2,
      serializedUTF8Bytes: 12_000,
    });
  }
  const accepted = runChecker(events, "rich-v5-minimap");
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).spatial, "rich-v5-minimap");

  for (const mutation of [
    (event) => {
      event.schemaVersion = 3;
    },
    (event) => {
      event.minimapSchemaVersion = 1;
    },
    (event) => {
      event.minimapPresent = false;
      delete event.minimapSchemaVersion;
    },
  ]) {
    const malformed = structuredClone(events);
    mutation(malformed.find((event) => event.kind === "spatial_observation"));
    const rejected = runChecker(malformed, "rich-v5-minimap");
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /non-v5|bounded v2 minimap/u);
  }
});

test("owner evidence checker accepts exact bounded joined evidence", () => {
  const result = runChecker(validEvents());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    verdict: "PASS",
    files: 1,
    events: 5,
    deals: 1,
    messageSelections: 1,
    messageObservations: 1,
    dealsMode: "required",
    messagesMode: "required",
    spatial: "absent",
  });
});

test("owner evidence checker rejects a missing or tampered recipient join", () => {
  const events = validEvents();
  events[3].messageBodySHA256 = "0".repeat(64);
  const result = runChecker(events);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no recipient observation joined/u);
});

test("owner evidence checker rejects extra fields and private material", () => {
  for (const extra of [
    { unexpected: true },
    { prompt: "do not retain this" },
  ]) {
    const events = validEvents();
    Object.assign(events[1], extra);
    const result = runChecker(events);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /unknown owner evidence field|forbidden raw\/private/u,
    );
  }
});
