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
const firstMessageEventID = "msg_00000000-0000-4000-8000-000000000001";
const secondMessageEventID = "msg_00000000-0000-4000-8000-000000000002";

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
      messageEventID: firstMessageEventID,
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
      baseSerializedUTF8Bytes: 8_192,
      minimapSerializedUTF8Bytes: 1_024,
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
        "baseSerializedUTF8Bytes",
        "minimapSerializedUTF8Bytes",
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
        baseSerializedUTF8Bytes: 8_192,
        minimapSerializedUTF8Bytes: 1_024,
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
      baseSerializedUTF8Bytes: 8_192,
      minimapSerializedUTF8Bytes: 1_024,
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

test("owner evidence checker requires absent evidence in every supplied file", () => {
  const missing = runCheckerFiles([validEvents(), []], "absent");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /record is missing/u);
});

test("owner evidence checker distinguishes the rich v3 base-only mode", () => {
  const events = validEvents();
  for (const event of events.filter(
    (candidate) => candidate.kind === "spatial_observation",
  )) {
    Object.assign(event, {
      present: true,
      schemaVersion: 3,
      visibilityModel: "global-lockstep-public-map-v1",
      minimapPresent: false,
      baseSerializedUTF8Bytes: 8_192,
    });
  }
  const accepted = runChecker(events, "rich-v3");
  assert.equal(accepted.status, 0, accepted.stderr);

  const withMinimap = structuredClone(events);
  for (const event of withMinimap.filter(
    (candidate) => candidate.kind === "spatial_observation",
  )) {
    event.minimapPresent = true;
    event.minimapSchemaVersion = 1;
    event.minimapSerializedUTF8Bytes = 1_024;
  }
  const rejected = runChecker(withMinimap, "rich-v3");
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /base-only.*minimap/u);
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
      baseSerializedUTF8Bytes: 14_328,
      minimapSerializedUTF8Bytes: 3_099,
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

test("owner evidence checker distinguishes the rich v5 base-only arm", () => {
  const events = validEvents();
  for (const event of events.filter(
    (candidate) => candidate.kind === "spatial_observation",
  )) {
    Object.assign(event, {
      present: true,
      schemaVersion: 5,
      visibilityModel: "global-lockstep-public-map-v1",
      minimapPresent: false,
      baseSerializedUTF8Bytes: 14_328,
    });
  }
  const accepted = runChecker(events, "rich-v5");
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).spatial, "rich-v5");

  const fullOn = structuredClone(events);
  for (const event of fullOn.filter(
    (candidate) => candidate.kind === "spatial_observation",
  )) {
    event.minimapPresent = true;
    event.minimapSchemaVersion = 2;
    event.minimapSerializedUTF8Bytes = 3_099;
  }
  const rejected = runChecker(fullOn, "rich-v5");
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /base-only.*minimap/u);
});

test("owner evidence checker rejects a minimap from the wrong parent schema", () => {
  for (const schemaVersion of [1, 3]) {
    const events = validEvents();
    for (const event of events.filter(
      (candidate) => candidate.kind === "spatial_observation",
    )) {
      Object.assign(event, {
        present: true,
        schemaVersion,
        visibilityModel: "global-lockstep-public-map-v1",
        minimapPresent: true,
        minimapSchemaVersion: 2,
        baseSerializedUTF8Bytes: 8_192,
        minimapSerializedUTF8Bytes: 1_024,
      });
    }
    const rejected = runChecker(events, "present");
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /provenance or byte bound/u);
  }
});

test("owner evidence checker enforces independent rich spatial byte ceilings", () => {
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
      baseSerializedUTF8Bytes: 14_328,
      minimapSerializedUTF8Bytes: 3_099,
    });
  }
  const independentlyBounded = runChecker(events, "rich-v5-minimap");
  assert.equal(independentlyBounded.status, 0, independentlyBounded.stderr);

  for (const [field, value] of [
    ["baseSerializedUTF8Bytes", 16 * 1024 + 1],
    ["minimapSerializedUTF8Bytes", 4 * 1024 + 1],
  ]) {
    const oversized = structuredClone(events);
    oversized.find((event) => event.kind === "spatial_observation")[field] =
      value;
    const rejected = runChecker(oversized, "rich-v5-minimap");
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /provenance or byte bound/u);
  }
});

test("owner evidence checker accepts joined evidence with an exact current message ID", () => {
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

test("owner evidence checker requires exact unique server message IDs", () => {
  const missing = validEvents();
  delete missing[3].messageEventID;
  const missingResult = runChecker(missing);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /missing.*messageEventID/u);

  for (const tamperedID of [
    "msg_tampered",
    "MSG_00000000-0000-4000-8000-000000000001",
    "msg_00000000-0000-3000-8000-000000000001",
  ]) {
    const tampered = validEvents();
    tampered[3].messageEventID = tamperedID;
    const tamperedResult = runChecker(tampered);
    assert.equal(tamperedResult.status, 1);
    assert.match(tamperedResult.stderr, /malformed message-observation/u);
  }

  const duplicate = validEvents();
  duplicate.splice(4, 0, {
    ...structuredClone(duplicate[3]),
    requestID: "req_recipient_duplicate",
    messageEventID: secondMessageEventID,
  });
  duplicate[4].messageEventID = firstMessageEventID;
  const duplicateResult = runChecker(duplicate);
  assert.equal(duplicateResult.status, 1);
  assert.match(duplicateResult.stderr, /duplicate.*messageEventID/u);
});

test("owner evidence checker rejects impossible UTF-8 and UTF-16 counts", () => {
  for (const [utf8Bytes, utf16CodeUnits] of [
    [1, 2],
    [4, 1],
    [841, 280],
  ]) {
    const events = validEvents();
    for (const event of events.filter((candidate) =>
      ["message_selection", "message_observation"].includes(candidate.kind),
    )) {
      event.messageBodyUTF8Bytes = utf8Bytes;
      event.messageBodyUTF16CodeUnits = utf16CodeUnits;
    }
    const result = runChecker(events);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid bounded outgoing message digest/u);
  }
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
