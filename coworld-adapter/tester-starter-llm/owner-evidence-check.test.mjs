import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  OWNER_EVIDENCE_MAX_EVENTS_BY_KIND,
  OWNER_EVIDENCE_SATURATION_KIND,
} from "./owner-capabilities.mjs";

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
      ...common("P_B", "req_recipient_spatial"),
      present: false,
    },
  ];
}

function splitPolicyEventSets(events) {
  const groups = new Map();
  for (const event of events) {
    const key = JSON.stringify([event.slot, event.ownPlayerID]);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function runCheckerFiles(
  eventSets,
  spatial = "absent",
  {
    aliasFirst = false,
    deals = "required",
    duplicateFirst = false,
    messages = "required",
    replay,
  } = {},
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
  let replayPath;
  if (replay) {
    replayPath = path.join(directory, "episode.replay");
    writeFileSync(replayPath, JSON.stringify(replay), "utf8");
  }
  const result = spawnSync(
    process.execPath,
    [
      CHECKER,
      `--deals=${deals}`,
      `--messages=${messages}`,
      `--spatial=${spatial}`,
      ...(replayPath ? [`--replay=${replayPath}`] : []),
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

function runChecker(events, spatial = "absent", options = {}) {
  return runCheckerFiles(splitPolicyEventSets(events), spatial, options);
}

function messageEventID(index) {
  return `msg_00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function repeatedJoinedMessageEvents(count) {
  const sender = [structuredClone(validEvents()[0]), validEvents()[2]];
  const recipient = [
    {
      ...structuredClone(validEvents()[2]),
      ...common("P_B", "req_recipient_spatial"),
    },
  ];
  for (let index = 0; index < count; index += 1) {
    sender.push({
      ...structuredClone(validEvents()[1]),
      requestID: `req_sender_${index}`,
    });
    recipient.push({
      ...structuredClone(validEvents()[3]),
      requestID: `req_recipient_${index}`,
      messageEventID: messageEventID(index + 1),
    });
  }
  return [sender, recipient];
}

function replayFixture(
  messages = [
    {
      senderID: "P_A",
      recipientID: "P_B",
      text: body,
      messageEventID: firstMessageEventID,
      turnNumber: 42,
    },
  ],
  roster = [
    { username: "Player A", playerID: "P_A", clientID: "client_A" },
    { username: "Player B", playerID: "P_B", clientID: "client_B" },
  ],
) {
  const clientByPlayer = new Map(
    roster.map((player) => [player.playerID, player.clientID]),
  );
  const turns = [];
  for (const message of messages) {
    let turn = turns.find(
      (candidate) => candidate.turnNumber === message.turnNumber,
    );
    if (!turn) {
      turn = { turnNumber: message.turnNumber, intents: [] };
      turns.push(turn);
    }
    turn.intents.push({
      type: "agent_message",
      recipient: message.recipientID,
      text: message.text,
      messageEventID: message.messageEventID,
      clientID: clientByPlayer.get(message.senderID),
    });
  }
  turns.sort((left, right) => left.turnNumber - right.turnNumber);
  const maximumTurn = turns.at(-1)?.turnNumber ?? 0;
  const finalTurn = maximumTurn + 100;
  const runID = "run_owner_evidence_fixture";
  return {
    runID,
    config: {
      max_decision_steps: 600,
      turns_per_decision_step: 100,
      player_count: roster.length,
    },
    finalState: {
      turnCount: finalTurn,
      players: roster.map(({ username, playerID }) => ({ username, playerID })),
    },
    results: { turn_count: finalTurn },
    inlineRunArtifacts: {
      "game-record.json": JSON.stringify({
        info: {
          num_turns: finalTurn,
          players: roster.map(({ username, clientID }) => ({
            username,
            clientID,
          })),
        },
        turns,
      }),
      "spectator-telemetry.json": JSON.stringify({
        runID,
        agents: roster.map(({ username, playerID }) => ({
          username,
          playerID,
        })),
      }),
    },
  };
}

function terminalHorizonFixture(perSender = 120) {
  const roster = Array.from({ length: 4 }, (_, slot) => ({
    username: `Player ${slot}`,
    playerID: `P_${slot}`,
    clientID: `client_${slot}`,
  }));
  const eventsBySlot = roster.map((player, slot) => [
    {
      kind: "spatial_observation",
      requestID: `req_spatial_${slot}`,
      slot,
      ownPlayerID: player.playerID,
      selectedLegalActionID: "hold",
      selectedLegalActionOffered: true,
      present: false,
    },
  ]);
  eventsBySlot[0].unshift({
    kind: "deal_selection",
    requestID: "req_deal",
    slot: 0,
    ownPlayerID: "P_0",
    selectedLegalActionID: "hold",
    selectedLegalActionOffered: true,
    offeredDealActionIDs: ["deal_accept:deal_fixture"],
    selectedDealActionID: "deal_accept:deal_fixture",
  });
  const messages = [];
  let eventIndex = 1;
  for (let senderSlot = 0; senderSlot < roster.length; senderSlot += 1) {
    const recipientSlot = (senderSlot + 1) % roster.length;
    for (let index = 0; index < perSender; index += 1) {
      const turnNumber = 400 + index * 100;
      const eventID = messageEventID(eventIndex);
      eventIndex += 1;
      eventsBySlot[senderSlot].push({
        kind: "message_selection",
        requestID: `req_sender_${senderSlot}_${index}`,
        slot: senderSlot,
        ownPlayerID: roster[senderSlot].playerID,
        selectedLegalActionID: "hold",
        selectedLegalActionOffered: true,
        offeredMessageActionIDs: [`message:${roster[recipientSlot].playerID}`],
        selectedMessageActionID: `message:${roster[recipientSlot].playerID}`,
        selectedMessageRecipientID: roster[recipientSlot].playerID,
        messageBodySHA256: digest,
        messageBodyUTF8Bytes: Buffer.byteLength(body, "utf8"),
        messageBodyUTF16CodeUnits: body.length,
      });
      messages.push({
        senderID: roster[senderSlot].playerID,
        recipientID: roster[recipientSlot].playerID,
        text: body,
        messageEventID: eventID,
        turnNumber,
      });
      if (index < perSender - 1) {
        eventsBySlot[recipientSlot].push({
          kind: "message_observation",
          requestID: `req_recipient_${senderSlot}_${index}`,
          slot: recipientSlot,
          ownPlayerID: roster[recipientSlot].playerID,
          selectedLegalActionID: "hold",
          selectedLegalActionOffered: true,
          messageEventID: eventID,
          senderID: roster[senderSlot].playerID,
          senderTurn: turnNumber,
          messageBodySHA256: digest,
          messageBodyUTF8Bytes: Buffer.byteLength(body, "utf8"),
          messageBodyUTF16CodeUnits: body.length,
        });
      }
    }
  }
  return { eventsBySlot, replay: replayFixture(messages, roster) };
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
      /malformed spatial|valid spatial|absent policy|bounded minimap|non-v3|provenance/u,
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
  const eventSets = splitPolicyEventSets(events);
  const missing = runCheckerFiles(
    [
      eventSets[0],
      eventSets[1].filter((event) => event.kind !== "spatial_observation"),
    ],
    "rich-v3-minimap",
  );
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
  const eventSets = splitPolicyEventSets(validEvents());
  const missing = runCheckerFiles([
    eventSets[0],
    eventSets[1].filter((event) => event.kind !== "spatial_observation"),
  ]);
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
    files: 2,
    events: 5,
    deals: 1,
    messageSelections: 1,
    messageObservations: 1,
    replayBound: false,
    terminalUnobservedMessageSelections: 0,
    terminalUnobservedMessageEventIDs: [],
    dealsMode: "required",
    messagesMode: "required",
    spatial: "absent",
  });
});

test("owner evidence checker requires one unique stable policy identity per log", () => {
  const mixed = runCheckerFiles([
    validEvents().filter(
      (event, index) => event.kind !== "spatial_observation" || index === 2,
    ),
  ]);
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /mixed multiple slot or player identities/u);

  for (const duplicateField of ["slot", "ownPlayerID"]) {
    const eventSets = splitPolicyEventSets(validEvents());
    const source = eventSets[0][0];
    for (const event of eventSets[1]) {
      event[duplicateField] = source[duplicateField];
    }
    const duplicate = runCheckerFiles(eventSets);
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /unique slot and player identity/u);
  }
});

test("owner evidence checker rejects a replay option outside required message verification", () => {
  const result = runCheckerFiles(
    splitPolicyEventSets(validEvents()),
    "absent",
    {
      deals: "optional",
      messages: "optional",
      replay: replayFixture(),
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /replay requires --messages=required/u);
  assert.equal(result.stdout, "");
});

test("owner evidence checker rejects oversized and invalid UTF-8 logs before evidence parsing", () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "proxywar-owner-evidence-boundary-"),
  );
  try {
    const run = (log) =>
      spawnSync(
        process.execPath,
        [
          CHECKER,
          "--deals=required",
          "--messages=required",
          "--spatial=absent",
          log,
        ],
        { encoding: "utf8" },
      );
    const oversized = path.join(directory, "oversized.log");
    const descriptor = openSync(oversized, "w");
    try {
      ftruncateSync(descriptor, 16 * 1024 * 1024 + 1);
    } finally {
      closeSync(descriptor);
    }
    const oversizedResult = run(oversized);
    assert.equal(oversizedResult.status, 1);
    assert.match(
      oversizedResult.stderr,
      /policy log exceeds its bounded size/u,
    );

    const invalidUtf8 = path.join(directory, "invalid-utf8.log");
    writeFileSync(invalidUtf8, Buffer.from([0xff]));
    const invalidResult = run(invalidUtf8);
    assert.equal(invalidResult.status, 1);
    assert.match(invalidResult.stderr, /policy log is not strict UTF-8/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owner evidence checker binds every joined observation to the authoritative replay ID", () => {
  const result = runChecker(validEvents(), "absent", {
    replay: replayFixture(),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    verdict: "PASS",
    files: 2,
    events: 5,
    deals: 1,
    messageSelections: 1,
    messageObservations: 1,
    replayBound: true,
    terminalUnobservedMessageSelections: 0,
    terminalUnobservedMessageEventIDs: [],
    dealsMode: "required",
    messagesMode: "required",
    spatial: "absent",
  });

  const tampered = validEvents();
  tampered[3].messageEventID = secondMessageEventID;
  const rejected = runChecker(tampered, "absent", {
    replay: replayFixture(),
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /authoritative replay messageEventID/u);
});

test("owner evidence checker reports a replay-proven final-frame admission without claiming an observation", () => {
  const terminalEvents = validEvents().filter(
    (event) => event.kind !== "message_observation",
  );
  const strictLogOnly = runChecker(terminalEvents);
  assert.equal(strictLogOnly.status, 1);
  assert.match(
    strictLogOnly.stderr,
    /selection and recipient-observation evidence are both required/u,
  );

  const replayBound = runChecker(terminalEvents, "absent", {
    replay: replayFixture(),
  });
  assert.equal(replayBound.status, 0, replayBound.stderr);
  assert.deepEqual(JSON.parse(replayBound.stdout), {
    verdict: "PASS",
    files: 2,
    events: 4,
    deals: 1,
    messageSelections: 1,
    messageObservations: 0,
    replayBound: true,
    terminalUnobservedMessageSelections: 1,
    terminalUnobservedMessageEventIDs: [firstMessageEventID],
    dealsMode: "required",
    messagesMode: "required",
    spatial: "absent",
  });
});

test("owner evidence checker never excuses a nonterminal missing observation", () => {
  const events = validEvents();
  const secondSelection = {
    ...structuredClone(events[1]),
    requestID: "req_sender_second",
  };
  events.splice(2, 0, secondSelection);
  const recipientObservation = events.find(
    (event) => event.kind === "message_observation",
  );
  recipientObservation.requestID = "req_recipient_second";
  recipientObservation.messageEventID = secondMessageEventID;
  recipientObservation.senderTurn = 142;
  const replay = replayFixture([
    {
      senderID: "P_A",
      recipientID: "P_B",
      text: body,
      messageEventID: firstMessageEventID,
      turnNumber: 42,
    },
    {
      senderID: "P_A",
      recipientID: "P_B",
      text: body,
      messageEventID: secondMessageEventID,
      turnNumber: 142,
    },
  ]);
  const result = runChecker(events, "absent", { replay });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nonterminal selected message/u);
});

test("owner evidence checker rejects replay message drift, extras, and duplicate IDs", () => {
  const cases = [
    (replay) => {
      const game = JSON.parse(replay.inlineRunArtifacts["game-record.json"]);
      game.turns[0].intents[0].recipient = "P_A";
      replay.inlineRunArtifacts["game-record.json"] = JSON.stringify(game);
    },
    (replay) => {
      const game = JSON.parse(replay.inlineRunArtifacts["game-record.json"]);
      game.turns[0].intents.push({
        ...structuredClone(game.turns[0].intents[0]),
        messageEventID: secondMessageEventID,
      });
      replay.inlineRunArtifacts["game-record.json"] = JSON.stringify(game);
    },
    (replay) => {
      const game = JSON.parse(replay.inlineRunArtifacts["game-record.json"]);
      game.turns[0].intents.push(structuredClone(game.turns[0].intents[0]));
      replay.inlineRunArtifacts["game-record.json"] = JSON.stringify(game);
    },
    (replay) => {
      replay.finalState.players[0].playerID = "P_FORGED";
    },
    (replay) => {
      const game = JSON.parse(replay.inlineRunArtifacts["game-record.json"]);
      game.info.players[1].username = game.info.players[0].username;
      replay.inlineRunArtifacts["game-record.json"] = JSON.stringify(game);
    },
  ];
  for (const mutate of cases) {
    const replay = replayFixture();
    mutate(replay);
    const result = runChecker(validEvents(), "absent", { replay });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /authoritative replay|replay message count|identities disagree|chronological message selection|game-record identity/u,
    );
  }

  const wrongSlot = validEvents();
  for (const event of wrongSlot.filter(
    (candidate) => candidate.ownPlayerID === "P_B",
  )) {
    event.slot = 2;
  }
  const wrongSlotResult = runChecker(wrongSlot, "absent", {
    replay: replayFixture(),
  });
  assert.equal(wrongSlotResult.status, 1);
  assert.match(wrongSlotResult.stderr, /slot and player do not match/u);
});

test("owner evidence checker rejects reordered replay admissions even when every ID is observed", () => {
  const secondBody = "Different exact terminal message.";
  const secondDigest = createHash("sha256")
    .update(secondBody, "utf8")
    .digest("hex");
  const events = validEvents();
  events.splice(2, 0, {
    ...structuredClone(events[1]),
    requestID: "req_sender_second",
    messageBodySHA256: secondDigest,
    messageBodyUTF8Bytes: Buffer.byteLength(secondBody, "utf8"),
    messageBodyUTF16CodeUnits: secondBody.length,
  });
  const firstObservation = events.find(
    (event) => event.kind === "message_observation",
  );
  Object.assign(firstObservation, {
    messageEventID: firstMessageEventID,
    senderTurn: 42,
    messageBodySHA256: secondDigest,
    messageBodyUTF8Bytes: Buffer.byteLength(secondBody, "utf8"),
    messageBodyUTF16CodeUnits: secondBody.length,
  });
  events.push({
    ...structuredClone(firstObservation),
    requestID: "req_recipient_second",
    messageEventID: secondMessageEventID,
    senderTurn: 142,
    messageBodySHA256: digest,
    messageBodyUTF8Bytes: Buffer.byteLength(body, "utf8"),
    messageBodyUTF16CodeUnits: body.length,
  });
  const replay = replayFixture([
    {
      senderID: "P_A",
      recipientID: "P_B",
      text: secondBody,
      messageEventID: firstMessageEventID,
      turnNumber: 42,
    },
    {
      senderID: "P_A",
      recipientID: "P_B",
      text: body,
      messageEventID: secondMessageEventID,
      turnNumber: 142,
    },
  ]);
  const result = runChecker(events, "absent", { replay });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /chronological message selection/u);
});

test("owner evidence checker accepts the v10 480-selection terminal horizon only with replay authority", () => {
  const { eventsBySlot, replay } = terminalHorizonFixture();
  const strictLogOnly = runCheckerFiles(eventsBySlot);
  assert.equal(strictLogOnly.status, 1);
  assert.match(strictLogOnly.stderr, /no recipient observation joined/u);

  const replayBound = runCheckerFiles(eventsBySlot, "absent", { replay });
  assert.equal(replayBound.status, 0, replayBound.stderr);
  const report = JSON.parse(replayBound.stdout);
  assert.equal(report.messageSelections, 480);
  assert.equal(report.messageObservations, 476);
  assert.equal(report.terminalUnobservedMessageSelections, 4);
  assert.equal(report.terminalUnobservedMessageEventIDs.length, 4);
  assert.equal(new Set(report.terminalUnobservedMessageEventIDs).size, 4);

  const nonterminalReplay = structuredClone(replay);
  const game = JSON.parse(
    nonterminalReplay.inlineRunArtifacts["game-record.json"],
  );
  const finalSenderIntent = game.turns
    .at(-1)
    .intents.find((intent) => intent.clientID === "client_0");
  game.turns.at(-2).intents.push(finalSenderIntent);
  game.turns.at(-1).intents = game.turns
    .at(-1)
    .intents.filter((intent) => intent !== finalSenderIntent);
  nonterminalReplay.inlineRunArtifacts["game-record.json"] =
    JSON.stringify(game);
  const rejected = runCheckerFiles(eventsBySlot, "absent", {
    replay: nonterminalReplay,
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /nonterminal selected message/u);
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

test("owner evidence checker accepts a v9-shaped join beyond the old sample cap", () => {
  const joinedCount = 80;
  const result = runCheckerFiles(repeatedJoinedMessageEvents(joinedCount));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    verdict: "PASS",
    files: 2,
    events: joinedCount * 2 + 3,
    deals: 1,
    messageSelections: joinedCount,
    messageObservations: joinedCount,
    replayBound: false,
    terminalUnobservedMessageSelections: 0,
    terminalUnobservedMessageEventIDs: [],
    dealsMode: "required",
    messagesMode: "required",
    spatial: "absent",
  });

  const missing = repeatedJoinedMessageEvents(joinedCount);
  missing[1].pop();
  const missingResult = runCheckerFiles(missing);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /no recipient observation joined/u);

  const duplicate = repeatedJoinedMessageEvents(joinedCount);
  duplicate[1].at(-1).messageEventID = duplicate[1][1].messageEventID;
  const duplicateResult = runCheckerFiles(duplicate);
  assert.equal(duplicateResult.status, 1);
  assert.match(duplicateResult.stderr, /duplicate.*messageEventID/u);

  const tampered = repeatedJoinedMessageEvents(joinedCount);
  tampered[1].at(-1).messageBodySHA256 = "f".repeat(64);
  const tamperedResult = runCheckerFiles(tampered);
  assert.equal(tamperedResult.status, 1);
  assert.match(tamperedResult.stderr, /no recipient observation joined/u);
});

test("owner evidence checker rejects explicit saturation evidence", () => {
  const events = validEvents();
  events.push({
    kind: OWNER_EVIDENCE_SATURATION_KIND,
    saturatedKind: "message_observation",
    maximum: OWNER_EVIDENCE_MAX_EVENTS_BY_KIND.message_observation,
  });
  const result = runChecker(events);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /owner evidence saturated message_observation.*complete supported-horizon/u,
  );
});

test("owner evidence checker enforces each complete-horizon event ceiling", () => {
  const tooManyDeals = Array.from(
    { length: OWNER_EVIDENCE_MAX_EVENTS_BY_KIND.deal_selection + 1 },
    (_, index) => ({
      ...structuredClone(validEvents()[0]),
      requestID: `req_deal_${index}`,
    }),
  );
  tooManyDeals.push(validEvents()[2]);
  const dealResult = runChecker(tooManyDeals);
  assert.equal(dealResult.status, 1);
  assert.match(dealResult.stderr, /too many deal_selection events/u);

  const tooManyObservations = Array.from(
    { length: OWNER_EVIDENCE_MAX_EVENTS_BY_KIND.message_observation + 1 },
    (_, index) => ({
      ...structuredClone(validEvents()[3]),
      requestID: `req_observation_${index}`,
      messageEventID: messageEventID(index + 1),
    }),
  );
  tooManyObservations.push({
    ...structuredClone(validEvents()[2]),
    ...common("P_B", "req_recipient_spatial"),
  });
  const observationResult = runChecker(tooManyObservations);
  assert.equal(observationResult.status, 1);
  assert.match(
    observationResult.stderr,
    /too many message_observation events/u,
  );

  const tooManySpatial = [
    ...validEvents(),
    {
      ...structuredClone(validEvents()[2]),
      requestID: "req_extra_spatial",
    },
  ];
  const spatialResult = runChecker(tooManySpatial);
  assert.equal(spatialResult.status, 1);
  assert.match(spatialResult.stderr, /too many spatial_observation events/u);
});
